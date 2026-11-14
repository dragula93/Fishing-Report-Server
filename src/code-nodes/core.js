'use strict';
const SCHEMA_VERSION = '1.0';
const MODES = ['dry_run','render_only','send_test','production','retry_failed_deliveries'];
function invariant(condition, message) { if (!condition) throw new Error(message); }
function parts(instant, zone) {
  return Object.fromEntries(new Intl.DateTimeFormat('en-CA', {timeZone:zone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'}).formatToParts(new Date(instant)).filter(p=>p.type!=='literal').map(p=>[p.type,p.value]));
}
function localDate(instant,zone) { const p=parts(instant,zone);return `${p.year}-${p.month}-${p.day}`; }
function addDays(date,days) { const d=new Date(date+'T12:00:00Z');d.setUTCDate(d.getUTCDate()+days);return d.toISOString().slice(0,10); }
function localInstant(date,zone,hour=0,minute=0) {
  const target=Date.parse(`${date}T${String(hour).padStart(2,'0')}:${String(minute).padStart(2,'0')}:00Z`);
  let value=target;
  for(let i=0;i<4;i++) { const p=parts(value,zone);const wall=Date.UTC(+p.year,+p.month-1,+p.day,+p.hour,+p.minute,+p.second);value+=target-wall; }
  return new Date(value).toISOString();
}
function reportWindow(scheduledFor,zone) {
  invariant(Number.isFinite(Date.parse(scheduledFor)),'scheduled_for must be an explicit ISO timestamp');
  const wednesday=localDate(scheduledFor,zone);
  invariant(new Date(wednesday+'T12:00:00Z').getUTCDay()===3,'Original scheduled date must be Wednesday in the location timezone');
  const start=addDays(wednesday,1),end=addDays(start,6),dates=Array.from({length:6},(_,i)=>addDays(start,i));
  return {period_start:start,period_end:dates[5],start_utc:localInstant(start,zone),end_utc:localInstant(end,zone),dates,weekend:[dates[2],dates[3]],comparison_dates:[dates[2],dates[3],dates[4]],timezone:zone};
}
function latestScheduled(now,schedule) {
  const today=localDate(now,schedule.timezone);const day=new Date(today+'T12:00:00Z').getUTCDay();
  let date=addDays(today,-((day-3+7)%7));let candidate=localInstant(date,schedule.timezone,schedule.hour,schedule.minute);
  if(Date.parse(candidate)>Date.parse(now)) candidate=localInstant(addDays(date,-7),schedule.timezone,schedule.hour,schedule.minute);
  return candidate;
}
function validateConfig(config) {
  invariant(config.schedule_activation_at==null||Number.isFinite(Date.parse(config.schedule_activation_at)),'Invalid schedule activation timestamp');
  invariant(config.schema_version===SCHEMA_VERSION,'Unsupported configuration schema');
  invariant(MODES.includes(config.execution.mode),'Invalid execution mode');
  invariant(config.schedule.timezone && config.schedule.hour>=0 && config.schedule.hour<=23,'Invalid schedule');
  const update=config.update_schedule||{hour:7,minute:0,timezone:'America/New_York'};
  invariant((update.weekday===undefined||update.weekday==='Friday')&&update.timezone===config.schedule.timezone&&Number.isInteger(update.hour)&&update.hour>=0&&update.hour<12&&Number.isInteger(update.minute)&&update.minute>=0&&update.minute<60,'Invalid Friday schedule (must precede noon)');
  const ids=new Set();
  for(const loc of config.locations) {
    invariant(!ids.has(loc.id),'Duplicate location');ids.add(loc.id);
    new Intl.DateTimeFormat('en',{timeZone:loc.timezone});
    invariant(loc.habitats.every(h=>['nearshore','offshore'].includes(h)),'Only nearshore/offshore habitats supported');
    invariant(loc.max_one_way_distance.value>0 && ['nautical_mile','statute_mile'].includes(loc.max_one_way_distance.unit),'Invalid range');
    invariant(/^[a-z0-9_-]{1,80}$/.test(loc.id),'Invalid location ID');
    invariant(['noaa','open_meteo'].includes(loc.marine_provider||'noaa'),'Invalid marine provider');
    invariant(loc.forecast_points.length===2&&new Set(loc.forecast_points.map(p=>p.id)).size===2&&loc.forecast_points.every(p=>['nearshore','offshore'].includes(p.id)),'Configure nearshore and offshore forecast points');
    for(const p of [...loc.forecast_points,loc.astronomy_point])invariant(p&&Number.isFinite(p.latitude)&&p.latitude>=-90&&p.latitude<=90&&Number.isFinite(p.longitude)&&p.longitude>=-180&&p.longitude<=180,'Invalid location coordinates');
  }
  for(const s of config.sources) {const match=/^https:\/\/([^/?#]+)(?:\/|$)/.exec(s.url);invariant(match && match[1]===s.domain && !/[\s@]/.test(match[1]),'Invalid source URL');}
  if(config.execution.mode==='production') {
    invariant(config.configuration_ready,'Production configuration has not been approved');
    invariant(config.email.sender && config.email.operator,'Production sender/operator missing');
  }
  return config;
}
function normalizeRun(input,config,now=new Date().toISOString()) {
  validateConfig(config);
  const mode=input.mode||config.execution.mode;
  invariant(MODES.includes(mode),'Unknown mode');
  invariant(mode!=='production' || config.configuration_ready,'Production is gated by setup validation');
  let scheduledFor=input.report_anchor_scheduled_for||input.scheduled_for;
  if(!scheduledFor && ['scheduled','reconcile'].includes(input.trigger)) scheduledFor=latestScheduled(now,config.schedule);
  if(!scheduledFor && input.trigger==='update_scheduled')scheduledFor=latestScheduled(now,config.schedule);
  invariant(scheduledFor,'Manual replay requires the original Wednesday scheduled_for');
  const age=(Date.parse(now)-Date.parse(scheduledFor))/3600000;
  const zone=config.schedule.timezone,update=config.update_schedule||{hour:7,minute:0,timezone:zone};
  const friday=addDays(localDate(scheduledFor,zone),2),due=localInstant(friday,zone,update.hour,update.minute),cutoff=localInstant(friday,zone,12);
  const isUpdate=input.update_kind==='friday_decisions'||input.trigger==='update_scheduled'||(input.trigger==='reconcile'&&localDate(now,zone)===friday);
  if(input.compiled_update_schedule)invariant(input.compiled_update_schedule.hour===update.hour&&input.compiled_update_schedule.minute===update.minute,'Friday schedule changed: rebuild and republish scheduler');
  const updateAllowed=localDate(now,zone)===friday&&Date.parse(now)>=Date.parse(due)&&Date.parse(now)<Date.parse(cutoff);
  const activationAllowed=(input.trigger||'manual')==='manual'||config.schedule_activation_at==null||Date.parse(isUpdate?due:scheduledFor)>=Date.parse(config.schedule_activation_at);
  return {schema_version:SCHEMA_VERSION,run_id:input.run_id||`run_${Date.now()}_${Math.random().toString(36).slice(2,10)}`,
    scheduled_for:scheduledFor,report_anchor_scheduled_for:scheduledFor,trigger_scheduled_for:isUpdate?due:scheduledFor,collected_at:now,update_kind:isUpdate?'friday_decisions':null,mode,namespace:['production','retry_failed_deliveries'].includes(mode)?'production':'test',
    edition:input.edition??1,use_fixtures:input.use_fixtures===true,config,
    activation_allowed:activationAllowed,
    catch_up_allowed:activationAllowed&&(isUpdate?updateAllowed:input.trigger!=='reconcile'||(age>=0 && age<=config.schedule.catch_up_hours)),
    notice_due:activationAllowed&&(isUpdate?localDate(now,zone)===friday&&Date.parse(now)>=Date.parse(cutoff):age>config.schedule.catch_up_hours),
    delayed:!isUpdate&&age>1,delay_hours:Math.max(0,age),trigger:input.trigger||'manual'};
}
function locationContext(input,loc) {
  invariant(input.schema_version===SCHEMA_VERSION && input.run_id && input.scheduled_for,'Missing sub-workflow contract');
  return {...input,location_id:loc.id,location:loc,window:reportWindow(input.scheduled_for,loc.timezone),collectors:[],warnings:[],evidence:[]};
}
function envelope(context,id,response,kind='json',url=null,now=new Date().toISOString()) {
  const statusCode=response.statusCode??(response.error?0:200);
  const body=response.body??(kind==='text'?response.data:undefined)??response;
  let failure=response.error || (statusCode<200 || statusCode>=300?`HTTP ${statusCode}`:null);
  if(kind==='json' && body && (body.error || body.status==='failed')) failure=body.error||'API returned failure';
  return {source_id:id,location_id:context.location_id,status:failure?'failed':'ok',retrieved_at:now,issued_at:null,
    records:[],warnings:[],error:failure?String(typeof failure==='object'?JSON.stringify(failure):failure).slice(0,250):null,url,raw:failure?null:body};
}
function durationHours(duration) {
  const m=/^P(?:(\d+(?:\.\d+)?)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)?$/.exec(duration);
  invariant(m,'Unsupported ISO duration');return (+m[1]||0)*24+(+m[2]||0)+(+m[3]||0)/60+(+m[4]||0)/3600;
}
function gridIntervals(field,targetUnit) {
  if(!field) return [];
  return (field.values||[]).map(row=>{
    const [start,duration]=row.validTime.split('/');
    const end=new Date(Date.parse(start)+durationHours(duration)*3600000).toISOString();
    let value=row.value;
    if(value!==null && typeof value==='number') {
      if(targetUnit==='knots') {
        if(field.uom==='wmoUnit:km_h-1') value/=1.852;
        else if(field.uom==='wmoUnit:m_s-1') value*=1.943844;
        else if(!['wmoUnit:kt','wmoUnit:kn'].includes(field.uom)) value=null;
      } else if(targetUnit==='feet') {
        if(field.uom==='wmoUnit:m') value/=0.3048;
        else if(field.uom!=='wmoUnit:ft') value=null;
      } else if(targetUnit==='seconds' && !['nwsUnit:s','wmoUnit:s'].includes(field.uom)) value=null;
    }
    return {start,end,value:value===null?null:(typeof value==='number'&&targetUnit!=='feet'?Math.round(value*100)/100:value),unit:targetUnit||field.uom};
  });
}
function normalizeGrid(collector,context,now=new Date().toISOString()) {
  if(collector.status==='failed') return collector;
  const data=collector.raw.properties;
  if(!data) return {...collector,status:'failed',error:'Missing grid properties'};
  const fields={wind_knots:gridIntervals(data.windSpeed,'knots'),gust_knots:gridIntervals(data.windGust,'knots'),wind_direction:gridIntervals(data.windDirection),seas_ft:gridIntervals(data.waveHeight,'feet'),period_seconds:gridIntervals(data.wavePeriod,'seconds'),period2_seconds:gridIntervals(data.wavePeriod2,'seconds'),weather:gridIntervals(data.weather),hazards:gridIntervals(data.hazards)};
  const issued=data.updateTime||data.generatedAt||null;
  const stale=!issued || (Date.parse(now)-Date.parse(issued))>context.config.quality.forecast_max_age_hours*3600000;
  return {...collector,status:stale?'stale':'ok',issued_at:issued,records:[{point_id:collector.point_id,zone:collector.zone,fields}],warnings:stale?['Forecast issuance is missing or stale']:[],coverage:Object.fromEntries(Object.entries(fields).map(([k,v])=>[k,v.filter(r=>r.value!==null).at(-1)?.end||null]))};
}
function normalizeBuoy(collector,context,now=new Date().toISOString()) {
  if(collector.status==='failed') return collector;
  const lines=String(collector.raw).trim().split(/\r?\n/);
  if(lines.length<3 || !lines[0].startsWith('#YY')) return {...collector,status:'failed',error:'Unrecognized NDBC format'};
  const cols=lines[0].replace(/^#/,'').trim().split(/\s+/),rows=lines.slice(2).filter(l=>l.trim() && !l.startsWith('#'));
  const row=Object.fromEntries(rows[0].trim().split(/\s+/).map((v,i)=>[cols[i],v]));
  const value=(key,factor=1)=>{const v=row[key];return !v || v==='MM'?null:Number.isFinite(+v)?Math.round(+v*factor*100)/100:null;};
  const observed=new Date(Date.UTC(+row.YY,+row.MM-1,+row.DD,+row.hh,+row.mm)).toISOString();
  const age=(Date.parse(now)-Date.parse(observed))/3600000;
  const record={station:collector.station,observed_at:observed,age_hours:Math.round(age*100)/100,wind_knots:value('WSPD',1.943844),gust_knots:value('GST',1.943844),wind_direction_degrees:value('WDIR'),seas_ft:value('WVHT',3.28084),dominant_period_seconds:value('DPD'),average_period_seconds:value('APD'),water_temperature_f:value('WTMP',1.8)};
  if(record.water_temperature_f!==null) record.water_temperature_f+=32;
  return {...collector,status:age>context.config.quality.observation_max_age_hours?'stale':'ok',issued_at:observed,records:[record],warnings:record.seas_ft===null?['Buoy wave height unavailable']:[]};
}
function normalizeTides(collector,context) {
  if(collector.status==='failed')return collector;
  if(!Array.isArray(collector.raw.predictions))return {...collector,status:'failed',error:'Missing predictions'};
  const records=collector.raw.predictions.map(r=>({time_utc:r.t.replace(' ','T')+':00Z',height_ft:Number(r.v),type:r.type,datum:'MLLW'})).filter(r=>Date.parse(r.time_utc)>=Date.parse(context.window.start_utc)&&Date.parse(r.time_utc)<Date.parse(context.window.end_utc));
  const missing=context.window.dates.filter(d=>!records.some(r=>localDate(r.time_utc,context.location.timezone)===d));
  return {...collector,status:records.length?(missing.length?'stale':'ok'):'empty',records,warnings:missing.length?[`Tides unavailable for ${missing.join(', ')}`]:[]};
}
function normalizeAlerts(collector) {
  if(collector.status==='failed')return collector;
  if(!Array.isArray(collector.raw.features))return {...collector,status:'failed',error:'Missing alert feature list'};
  return {...collector,status:collector.raw.features.length?'ok':'empty',records:collector.raw.features.map(f=>({id:f.id,event:f.properties.event,severity:f.properties.severity,effective:f.properties.effective,onset:f.properties.onset,ends:f.properties.ends,expires:f.properties.expires,description:f.properties.description,instruction:f.properties.instruction,url:f.id}))};
}
function normalizeCoastalProduct(collector,now=new Date().toISOString()) {
  if(collector.status==='failed')return collector;
  const text=String(collector.raw),m=/^FZ[A-Z0-9]+\s+[A-Z]{4}\s+(\d{2})(\d{2})(\d{2})/m.exec(text);
  let issued=null;
  if(m) {
    const instant=new Date(now);
    const candidates=[-1,0,1].map(offset=>new Date(Date.UTC(instant.getUTCFullYear(),instant.getUTCMonth()+offset,+m[1],+m[2],+m[3])).toISOString());
    issued=candidates.sort((a,b)=>Math.abs(Date.parse(a)-Date.parse(now))-Math.abs(Date.parse(b)-Date.parse(now)))[0];
  }
  const stale=!issued || Date.parse(now)-Date.parse(issued)>12*3600000;
  return {...collector,status:stale?'stale':'ok',issued_at:issued,records:[{text}],warnings:['Synopsis/product wording is retained; numerical table uses offshore grid data.']};
}
function numericSummary(intervals,start,end) {
  const rows=intervals.filter(r=>Date.parse(r.start)<Date.parse(end)&&Date.parse(r.end)>Date.parse(start)&&typeof r.value==='number');
  if(!rows.length) return {min:null,max:null,coverage:'not yet available'};
  let covered=Date.parse(start);
  for(const r of rows.slice().sort((a,b)=>Date.parse(a.start)-Date.parse(b.start))) {if(Date.parse(r.start)>covered)break;covered=Math.max(covered,Date.parse(r.end));}
  return {min:Math.min(...rows.map(r=>r.value)),max:Math.max(...rows.map(r=>r.value)),coverage:covered>=Date.parse(end)?'complete':'partial'};
}
function conditionPreference(summary,vessel,hazards=[]) {
  if(hazards.length)return 'official hazard applies; review alert';
  if(summary.seas_ft.max!==null && summary.seas_ft.max>vessel.max_seas_ft)return 'exceeds wave-height preference';
  if(vessel.max_wind_knots!==null && summary.wind_knots.max!==null && summary.wind_knots.max>=vessel.max_wind_knots)return 'outside sustained-wind preference';
  if(!vessel.preferences_ready)return 'vessel preference rating pending configuration';
  if(['seas_ft','period_seconds','wind_knots','gust_knots'].some(k=>!summary[k]||summary[k].min===null || summary[k].coverage!=='complete'))return 'insufficient forecast information';
  const rule=vessel.wave_period_rules.find(r=>r.max_exclusive?summary.seas_ft.max<r.max_seas_ft:summary.seas_ft.max<=r.max_seas_ft);
  if(!rule || (rule.period_exclusive?summary.period_seconds.min<=rule.min_period_seconds:summary.period_seconds.min<rule.min_period_seconds))return 'outside wave-period preference';
  const gustLimit=summary.wind_knots.max<15?vessel.max_gust_below_15_knots:vessel.max_gust_at_or_above_15_knots;
  if(!Number.isFinite(gustLimit))return 'gust preference pending configuration';
  if(summary.gust_knots.max>gustLimit)return 'outside combined wind/gust preference';
  return 'within configured preferences; recheck before departure';
}
function forecastTable(context) {
  const grids=context.collectors.filter(c=>c.source_id.startsWith('grid_'));
  const alerts=context.collectors.find(c=>c.source_id==='nws_alerts');
  return context.window.dates.flatMap(date=>context.location.forecast_points.map(point=>{
    const grid=grids.find(c=>c.point_id===point.id),fields=grid?.records[0]?.fields||{};
    const segments=[['day',6,18],['morning',6,12],['afternoon',12,18]].map(([name,a,b])=>{
      const start=localInstant(date,context.location.timezone,a),end=localInstant(date,context.location.timezone,b);
      const values=Object.fromEntries(['wind_knots','gust_knots','seas_ft','period_seconds','period2_seconds'].map(k=>[k,numericSummary(fields[k]||[],start,end)]));
      values.seas_ft.forecast_intervals=(fields.seas_ft||[]).filter(r=>r.unit==='feet'&&Number.isFinite(r.value)&&Date.parse(r.start)<Date.parse(end)&&Date.parse(r.end)>Date.parse(start)).map(r=>({start:new Date(Math.max(Date.parse(start),Date.parse(r.start))).toISOString(),end:new Date(Math.min(Date.parse(end),Date.parse(r.end))).toISOString(),value_ft:r.value}));
      const hazards=(alerts?.records||[]).filter(r=>Date.parse(r.onset||r.effective)<Date.parse(end)&&Date.parse(r.ends||r.expires)>Date.parse(start));
      const gridHazards=(fields.hazards||[]).filter(r=>Date.parse(r.start)<Date.parse(end)&&Date.parse(r.end)>Date.parse(start)&&Array.isArray(r.value)&&r.value.length);
      const weather=(fields.weather||[]).filter(r=>Date.parse(r.start)<Date.parse(end)&&Date.parse(r.end)>Date.parse(start)).flatMap(r=>r.value||[]).filter(w=>/thunder/i.test(w.weather||''));
      const preference=!alerts||alerts.status==='failed'?'insufficient information: alert status unavailable':grid?.status==='stale'?'insufficient information: stale forecast':conditionPreference(values,context.location.vessel,[...hazards,...gridHazards,...weather]);
      return {name,start,end,...values,preference,hazards:hazards.map(h=>h.event),thunderstorm_forecast:weather.length>0,grid_hazards:gridHazards.flatMap(r=>r.value)};
    });
    const [day,morning,afternoon]=segments;
    let trend='trend unavailable';
    if(morning.seas_ft.max!==null && afternoon.seas_ft.max!==null && morning.wind_knots.max!==null && afternoon.wind_knots.max!==null) {
      const sea=afternoon.seas_ft.max-morning.seas_ft.max,wind=afternoon.wind_knots.max-morning.wind_knots.max;
      trend=sea>0 && wind>0?'wind and seas increase':sea<0 && wind<0?'wind and seas decrease':'mixed or little change; review morning/afternoon values';
    }
    return {date,point_id:point.id,zone:point.zone,forecast_status:grid?.status||'failed',issued_at:grid?.issued_at||null,day,morning,afternoon,trend,alert_status:alerts?.status==='failed'?'unavailable':alerts?'checked':'unavailable'};
  }));
}
function escapeHtml(value) {return String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
function range(value,unit) {return value.min===null?'not yet available':`${value.min.toFixed(1)}${value.min===value.max?'':`–${value.max.toFixed(1)}`} ${unit}${value.coverage==='partial'?' (partial coverage)':''}`;}
function clock(instant,zone) {return instant?new Intl.DateTimeFormat('en-US',{timeZone:zone,hour:'numeric',minute:'2-digit',timeZoneName:'short'}).format(new Date(instant)):'unavailable';}
function selectedTemperature(report){return (report.observations||[]).filter(o=>o.status==='ok'&&Number.isFinite(o.water_temperature_f)&&Number.isFinite(Date.parse(o.observed_at))).sort((a,b)=>Date.parse(b.observed_at)-Date.parse(a.observed_at))[0]||null;}
function factualReport(context) {
  if(typeof relevantEvidence==='function')context.evidence=relevantEvidence(context.evidence,context.window,context.collected_at||new Date().toISOString());
  const table=forecastTable(context),tides=context.collectors.find(c=>c.source_id==='noaa_tides'),astro=context.collectors.find(c=>c.source_id==='skyfield_de421');
  const grids=context.collectors.filter(c=>c.source_id.startsWith('grid_'));
  const adequate=grids.some(c=>c.status==='ok'&&c.records.length);
  const outlookMode=!adequate?'data_unavailable':context.evidence.length?'limited_evidence':'factual_fallback';
  const warnings=context.collectors.flatMap(c=>c.status==='failed'?[`${c.source_id}: unavailable (${c.error})`]:c.status==='stale'?[`${c.source_id}: stale`]:c.warnings||[]);
  const report={schema_version:SCHEMA_VERSION,location_id:context.location_id,run_id:context.run_id,scheduled_for:context.scheduled_for,namespace:context.namespace,edition:context.edition,
    window:context.window,mode:context.mode,outlook_mode:outlookMode,fixture:context.use_fixtures,delayed:context.delayed,
    report_anchor_scheduled_for:context.report_anchor_scheduled_for||context.scheduled_for,trigger_scheduled_for:context.trigger_scheduled_for||context.scheduled_for,collected_at:context.collected_at,update_kind:context.update_kind||null,
    title:`${context.location.name} Offshore Outlook | ${context.window.period_start}–${context.window.period_end}`,
    overview:!adequate?'Current marine forecast information is unavailable. Trip recommendations are suppressed.':
      'Review the Saturday/Sunday forecast and morning-to-afternoon changes below. This is a factual briefing; fishing recommendations require validated recent evidence and verified target rules.',
    forecast_table:table,observations:context.collectors.filter(c=>c.source_id.startsWith('buoy_')).flatMap(c=>c.records.map(r=>({...r,status:c.status}))),
    tides:tides?.records||[],astronomy:astro?.records||[],evidence:context.evidence,recommendations:[],warnings,community_research:context.community_research||null,
    sources:context.collectors.map(c=>({source_id:c.source_id,url:c.url,status:c.status,issued_at:c.issued_at,retrieved_at:c.retrieved_at,coverage:c.coverage||null})),
    ocean_features:context.ocean_features||{schema_version:'1.0',location_id:context.location_id,status:context.location.ocean_features?.enabled?'unavailable':'disabled',acquisition_status:'unavailable',analysis_status:'not_run',features:[],sources:[],warnings:[]},
    limits:{departure_name:context.location.departure_point.name,max_range_nm:context.location.max_one_way_distance.unit==='nautical_mile'?context.location.max_one_way_distance.value:context.location.max_one_way_distance.value/1.15077945,vessel:context.location.vessel},
    writer:{backend:context.config.llm.backend,status:'not_called'},validation:{valid:true,version:'1.0'}};
  report.daily_outlook=typeof dailyOutlook==='function'?dailyOutlook(report,context.config):[];
  return report;
}
function renderOceanSection(ocean,zone='America/New_York') {
 const o=ocean||{status:'unavailable',features:[],sources:[],warnings:[]};
 const labels={disabled:'Ocean feature view disabled.',unavailable:'Ocean feature data unavailable.',stale:'Stale ocean snapshot.',partial:'Partial ocean coverage or waypoint references.',analysis_only:'Analysis-only SST; fronts and eddies are unconfirmed.',ok:'Dated ocean feature snapshot.'};
 const header='Offshore water and temperature breaks';
 const lines=['## '+header];let html=`<section style="border-top:1px solid #dce5e8;padding:12px 0"><h2 style="font-size:16px">${escapeHtml(header)}</h2>`;
 const stamp=(o.sources||[]).find(s=>s.analysis_time)?.analysis_time;
 const time=stamp?new Intl.DateTimeFormat('en-US',{timeZone:zone,month:'short',day:'numeric',year:'numeric',hour:'numeric',minute:'2-digit',timeZoneName:'short'}).format(new Date(stamp)):'time unavailable';
 const coverage=Number.isFinite(o.coverage?.observed_fraction)?`${Math.round(o.coverage.observed_fraction*100)}% observed`:Number.isFinite(o.coverage?.analysis_fraction)?`${Math.round(o.coverage.analysis_fraction*100)}% analyzed`:'coverage unknown';
 const downloaded=o.retrieved_at?new Intl.DateTimeFormat('en-US',{timeZone:zone,month:'short',day:'numeric',hour:'numeric',minute:'2-digit',timeZoneName:'short'}).format(new Date(o.retrieved_at)):'unavailable';
 const summary=`${o.acquisition_status==='failed'?'Latest refresh failed; cached data · ':''}${(labels[o.status]||'Ocean feature status: '+o.status).replace(/[.]$/,'')} · ${coverage} · SST analysis ${time} · Downloaded ${downloaded}.`;
 lines.push(summary);html+=`<p style="font-size:12px;color:#536775">${escapeHtml(summary)}</p>`;
 const features=Array.isArray(o.features)?o.features.slice(0,3):[];
 const mapBase64=o.map?.artifact_base64;
 const inlineMap=o.map?.mime_type==='image/png'&&typeof mapBase64==='string'&&mapBase64.length>0&&mapBase64.length<=2000000&&/^[A-Za-z0-9+/]+={0,2}$/.test(mapBase64);
 const formatLat=n=>Number.isFinite(n)?`${Math.abs(n).toFixed(4)}°${n>=0?'N':'S'}`:'—';
 const formatLon=n=>Number.isFinite(n)?`${Math.abs(n).toFixed(4)}°${n>=0?'E':'W'}`:'—';
 if(features.length){
  if(inlineMap){const alt='Ranked SST temperature-break candidates with GPX waypoint range and true-bearing references.';html+=`<img src="cid:ocean_map" alt="${escapeHtml(alt)}" style="display:block;width:100%;max-width:700px;height:auto;border:1px solid #dce5e8;border-radius:4px;margin:10px auto">`;lines.push('Inline SST map: numbered temperature-break candidates and GPX waypoint range/bearing references.');}
  else {const unavailable='Map unavailable.';html+=`<p style="font-size:12px;color:#755422">${escapeHtml(unavailable)}</p>`;lines.push(unavailable);}
  lines.push('| Rank | Locator (lat, lon) | GPX point | Range | Bearing |','|---:|---|---|---:|---:|');
  html+='<table aria-label="Ranked SST feature references" style="width:100%;border-collapse:collapse;font-size:12px"><thead><tr><th style="padding:5px 7px;text-align:left;border-bottom:1px solid #dce5e8">Rank</th><th style="padding:5px 7px;text-align:left;border-bottom:1px solid #dce5e8">Locator (lat, lon)</th><th style="padding:5px 7px;text-align:left;border-bottom:1px solid #dce5e8">GPX point</th><th style="padding:5px 7px;text-align:left;border-bottom:1px solid #dce5e8">Range</th><th style="padding:5px 7px;text-align:left;border-bottom:1px solid #dce5e8">Bearing</th></tr></thead><tbody>';
  for(let i=0;i<features.length;i++){
   const f=features[i],loc=f.locator||{},coord=`${formatLat(loc.latitude)}, ${formatLon(loc.longitude)}`,refs=(f.waypoint_references||[]).slice(0,2),rows=refs.length?refs:[null];
   for(const r of rows){
    const near=!r||r.wording==='near'||r.initial_bearing_true_deg===null,point=r?.name||'No waypoint reference';
    const range=near?(r?'Near':'—'):Number.isFinite(r.displayed_distance_nmi)?`${r.displayed_distance_nmi} nmi`:Number.isFinite(r.distance_nmi)?`${r.distance_nmi.toFixed(1)} nmi`:'—';
    const bearing=near?'—':`${String(r.displayed_bearing_true_deg??Math.round(r.initial_bearing_true_deg/5)*5).padStart(3,'0')}°T`;
    lines.push(`| ${i+1} | ${coord} | ${point} | ${range} | ${bearing} |`);
    html+=`<tr><td style="padding:4px 7px;border-bottom:1px solid #edf1f2">${i+1}</td><td style="padding:4px 7px;border-bottom:1px solid #edf1f2;white-space:nowrap">${escapeHtml(coord)}</td><td style="padding:4px 7px;border-bottom:1px solid #edf1f2">${escapeHtml(point)}</td><td style="padding:4px 7px;border-bottom:1px solid #edf1f2;white-space:nowrap">${escapeHtml(range)}</td><td style="padding:4px 7px;border-bottom:1px solid #edf1f2;white-space:nowrap">${escapeHtml(bearing)}</td></tr>`;
   }
  }
  html+='</tbody></table>';
 } else {
  let noFeature=o.status==='analysis_only'&&o.analysis_status==='no_feature'&&Number.isFinite(o.coverage?.analysis_fraction)&&o.coverage.analysis_fraction>=0.2?'No temperature breaks qualified in this analyzed SST.':o.analysis_status==='ok'&&Number.isFinite(o.coverage?.observed_fraction)&&o.coverage.observed_fraction>=0.2?'No feature qualified under the available coverage.':'Insufficient coverage for a current feature assessment.';
  if(o.status==='disabled')noFeature=labels.disabled;
  lines.push(noFeature);html+=`<p>${escapeHtml(noFeature)}</p>`;
 }
 const note='Ranges and bearings are straight-line references, not navigable routes.';
 if(features.length){html+=`<p style="font-size:11px;color:#536775">${escapeHtml(note)}</p>`;lines.push(note);}
 for(const s of (o.sources||[]).slice(0,8)){const detail=`${s.provider||'Source'} ${s.product||''} (${s.class||'class unknown'}); analysis ${s.analysis_time||'unknown'}; retrieved ${s.retrieved_at||'unknown'}; units ${s.units||'unknown'}; age/pixel age ${s.observation_age||'unknown'}.`;lines.push(detail);}
 if(o.status!=='analysis_only')for(const w of (o.warnings||[]).slice(0,2)){lines.push('Ocean feature note: '+w);html+=`<p style="font-size:11px;color:#755422">${escapeHtml(w)}</p>`;}
 html+='</section>';return {html,lines};
}
function renderDetailed(report) {
  const zone=report.window.timezone;
  const banner=[report.fixture?'SYNTHETIC FIXTURE — NOT CURRENT CONDITIONS':null,report.delayed?'Delayed report':null,report.outlook_mode.replaceAll('_',' ')].filter(Boolean).join(' | ');
  const lines=[`# ${report.title}`,banner,'',report.overview,'',`Operating range: ${report.limits.max_range_nm.toFixed(1)} nautical miles from ${report.limits.departure_name||'the configured departure point'}. Route distances require verification.`,
    '', '## Current offshore observations'];
  const v=report.limits.vessel;
  if(v.preferences_ready)lines.push('Configured preferences: waves below 2 ft need at least 4 s; 2–3 ft need at least 6 s; above 3–4 ft need more than 8 s. Sustained wind must be below 20 kt; gusts may reach 25 kt when sustained wind is below 15 kt, otherwise 20 kt. Ratings compare the interval maximum wind, gusts and wave height with its minimum period; this is a conservative comparison.');
  for(const o of report.observations)lines.push(`- Buoy ${o.station}, ${o.observed_at} (${o.status}): wind ${o.wind_knots??'unavailable'} kt, seas ${o.seas_ft??'unavailable'} ft, dominant period ${o.dominant_period_seconds??'unavailable'} s.`);
  if(!report.observations.length)lines.push('Observations unavailable.');
  lines.push('','## Report daytime conditions','Local daytime comparison: morning 06:00–12:00; afternoon 12:00–18:00. These are display intervals, not suggested departure times.','');
  lines.push('| Date / area | Wind / gusts | Seas | Period | Preference / hazards | Trend |','|---|---|---|---|---|---|');
  for(const row of report.forecast_table)lines.push(`| ${row.date} / ${row.zone} | ${range(row.day.wind_knots,'kt')} / gusts ${range(row.day.gust_knots,'kt')} | ${range(row.day.seas_ft,'ft')} | ${range(row.day.period_seconds,'s')} | ${row.day.preference}; ${row.alert_status==='unavailable'?'alert status unavailable':row.day.hazards.join(', ')||'no active alert in this interval'}${row.day.thunderstorm_forecast?'; thunderstorms forecast':''} | ${row.trend} |`);
  lines.push('','## Saturday/Sunday morning and afternoon');
  for(const row of report.forecast_table.filter(r=>report.window.weekend.includes(r.date)))for(const segment of [row.morning,row.afternoon])lines.push(`- ${row.date} ${row.zone} ${segment.name}: ${range(segment.wind_knots,'kt')} wind; gusts ${range(segment.gust_knots,'kt')}; ${range(segment.seas_ft,'ft')} seas; ${range(segment.period_seconds,'s')} period. ${segment.preference}.`);
  const ocean=renderOceanSection(report.ocean_features,zone);lines.push('',...ocean.lines,'');
  lines.push('','## Recent fishing evidence');
  const current=report.evidence.filter(e=>e.current_qualifying);
  for(const e of current.slice(0,8))lines.push(`- ${e.title} (${e.fishing_date}; ${e.age_label}): ${e.species.join(', ')}; ${e.method.replaceAll('_',' ')}; range ${e.range_status.replaceAll('_',' ')}. [Source](${e.url})`);
  if(!current.length)lines.push('No qualifying recent nearshore/offshore trip evidence. Missing reports do not establish an absence of fish.');
  const background=new Map();for(const e of report.evidence.filter(e=>!e.current_qualifying)){if(!background.has(e.url))background.set(e.url,{...e,species:new Set(e.species),methods:new Set([e.method])});else{for(const s of e.species)background.get(e.url).species.add(s);background.get(e.url).methods.add(e.method);}}
  if(background.size){lines.push('','## Seasonal and older context');for(const e of [...background.values()].slice(0,6))lines.push(`- ${e.regional_context_only?'Regional context only — Ponce/Volusia: ':''}${e.title}: published ${e.published_at||'unknown'}; trip ${e.fishing_date||'date unknown'}; ${e.age_label.replaceAll('_',' ')}; ${[...e.species].join(', ')}. [Source](${e.url})`);}
  lines.push('','## Targets and methods');
  if(report.recommendations.length)for(const rec of report.recommendations)lines.push(`- ${rec.species}: ${rec.summary} (evidence ${rec.evidence_ids.join(', ')}). ${rec.eligibility_note}`);
  else lines.push('No supported target recommendation. Current targeting/retention eligibility must be verified against FWC and NOAA before recommendations are enabled.');
  lines.push('','## Tides, daylight and moon');
  for(const date of report.window.dates) {
    const tide=report.tides.filter(t=>localDate(t.time_utc,zone)===date).map(t=>`${t.type==='H'?'high':'low'} ${clock(t.time_utc,zone)}, ${t.height_ft.toFixed(2)} ft ${t.datum||'datum unknown'}`).join('; ')||'tides unavailable';
    const a=report.astronomy.find(a=>a.date===date);
    lines.push(`- ${date}: ${tide}. Sunrise ${clock(a?.sunrise,zone)}; sunset ${clock(a?.sunset,zone)}. ${a?`${a.moon_phase}, ${a.illumination_percent}% illuminated (local noon)`:'astronomy unavailable'}.`);
  }
  lines.push('Port high/low tides do not establish offshore current or slack-current times. Lunar data describes astronomy, not bite probability.','','## Sources and gaps');
  for(const s of report.sources)lines.push(`- ${s.source_id}: ${s.status}; issued ${s.issued_at||'not applicable/unknown'}; retrieved ${s.retrieved_at}. ${s.url?'[Source page]('+s.url+')':'Computed locally with Skyfield / JPL DE421'}`);
  if(report.overview_claims?.length){
    lines.push('','Summary support:');
    for(const id of [...new Set(report.overview_claims.flatMap(c=>c.evidence_ids))]){
      const e=report.evidence.find(e=>e.evidence_id===id),row=report.forecast_table.find(r=>`forecast_${r.date}_${r.point_id}`===id);
      if(e)lines.push(`- [${e.title.replace(/[\[\]()]/g,'')}](${e.url}) — ${e.age_label.replaceAll('_',' ')}`);
      if(row){const source=report.sources.find(s=>s.source_id==='grid_'+row.point_id);if(source?.url)lines.push(`- [${row.date} ${row.zone} forecast](${source.url})`);}
    }
  }
  for(const w of report.warnings)lines.push(`- ${w}`);
  lines.push('Recheck official marine forecasts, alerts and fishing regulations before departure. Configured preferences are not a vessel safety assessment.');
  const markdown=lines.join('\n'),text=markdown.replace(/^#+ /gm,'').replace(/\[([^\]]+)\]\(([^)]+)\)/g,'$1: $2');
  const linkTargets=new Set([...report.sources.map(s=>s.url),...report.evidence.map(e=>e.url)].filter(Boolean).map(escapeHtml));
  const inline=value=>escapeHtml(value).replace(/\[([^\]]+)\]\((https:\/\/[^)\s]+)\)/g,(all,label,url)=>linkTargets.has(url)?`<a href="${url}" style="color:#126278">${label}</a>`:all);
  // Tables and every source-supplied string are escaped; external HTML is never copied into email.
  let html=`<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><meta charset="utf-8"></head><body style="margin:0;background:#f2f5f7;color:#152c3b;font-family:Arial,sans-serif"><main style="max-width:800px;margin:auto;padding:20px;background:white"><h1 style="font-size:23px">${escapeHtml(report.title)}</h1><p style="font-weight:bold">${escapeHtml(banner)}</p><p>${escapeHtml(report.overview)}</p>`;
  let inTable=false;
  for(const line of lines.slice(4)) {
    if(line.startsWith('|---'))continue;
    if(line.startsWith('|')) {
      if(!inTable){html+='<div style="overflow:auto"><table style="border-collapse:collapse;font-size:13px;width:100%">';inTable=true;}
      html+='<tr>'+line.slice(1,-1).split('|').map(cell=>`<td style="border:1px solid #cdd8de;padding:7px">${escapeHtml(cell.trim())}</td>`).join('')+'</tr>';
    } else {
      if(inTable){html+='</table></div>';inTable=false;}
      if(line.startsWith('## '))html+=`<h2 style="font-size:19px;margin-top:25px">${escapeHtml(line.slice(3))}</h2>`;
      else if(line)html+=`<p style="line-height:1.5;overflow-wrap:anywhere">${inline(line.replace(/^- /,''))}</p>`;
    }
  }
  if(inTable)html+='</table></div>';
  html+='</main></body></html>';
  return {html,text,markdown,subject:`${report.fixture?'[FIXTURE] ':''}${report.delayed?'[DELAYED] ':''}${report.title}`};
}
function render(report) {
 if(!report.daily_outlook?.length)return renderDetailed(report);
 const zone=report.window.timezone,lines=[report.title,report.fixture?'SYNTHETIC FIXTURE — NOT CURRENT CONDITIONS':report.delayed?'Delayed Wednesday replay':'',report.overview,''];
 const colors={go:'#17623a',go_conditions_only:'#17623a',dont_go:'#a02c2c',hold:'#936015'};
 const labels={go:'GO',go_conditions_only:'GO — conditions only',dont_go:"DON’T GO",hold:'DON’T GO yet — forecast incomplete'};
 const methodLabel={trolling:'Trolling',bottom_fishing:'Bottom fishing',nearshore_bait:'Nearshore fishing'};
 const sourceLinks=new Map();
 const safeLink=(url,label)=>/^https:\/\//.test(url||'')?`<a href="${escapeHtml(url)}" style="color:#176579">${escapeHtml(label)}</a>`:escapeHtml(label);
 let html=`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body style="margin:0;background:#f1f5f6;color:#18323f;font-family:Arial,sans-serif"><main style="max-width:720px;margin:auto;background:white;padding:24px"><h1 style="font-size:23px;margin:0 0 8px">${escapeHtml(report.title)}</h1>`;
 if(lines[1])html+=`<p style="font-size:12px;color:#755422">${escapeHtml(lines[1])}</p>`;
 html+=`<p style="line-height:1.5">${escapeHtml(report.overview)}</p>`;
 if(typeof updateSummary==='function')for(const summary of updateSummary(report)){lines.splice(3,0,summary);html+=`<p style="font-weight:bold;line-height:1.5">${escapeHtml(summary)}</p>`;}
 const water=selectedTemperature(report);
 const waterNote=water?`Latest ${water.station==='41113'?'nearshore':'offshore'} surface water: ${water.water_temperature_f.toFixed(1)}°F · buoy ${water.station} · ${new Intl.DateTimeFormat('en-US',{timeZone:zone,month:'short',day:'numeric',hour:'numeric',minute:'2-digit',timeZoneName:'short'}).format(new Date(water.observed_at))}.`:'Surface water temperature: no fresh reading available.';
 html+=`<p style="font-size:12px;color:#536775">${escapeHtml(waterNote)}</p>`;lines.push(waterNote,'');
 for(const day of report.daily_outlook){
  const weekday=new Intl.DateTimeFormat('en-US',{timeZone:'UTC',weekday:'short',month:'short',day:'numeric'}).format(new Date(day.date+'T12:00:00Z'));
  const label=(labels[day.verdict]||labels.hold)+(day.historical?' · Previously issued; not refreshed':''),option=day.option;
  const row=report.forecast_table.find(r=>r.date===day.date&&r.point_id===(day.point_id||'nearshore'));
  const segment=row?.[day.window||'morning'];
  const location=option?(option.spots.filter(s=>!/nearshore reefs/.test(s)).slice(0,2).join(' / ')||({beach:'local beach',nearshore:'nearshore reefs / structure',offshore:'offshore water within your range'}[option.area])):'';
  const plan=option?`${methodLabel[option.method]||option.method} — ${location}; ${option.species}.`:'No fishing trip plan recommended.';
  const selectedScope=day.rough_seas_scopes?.length&&day.point_id&&day.window?`${day.point_id==='nearshore'?'Nearshore':'Offshore'} ${day.window}: `:'';
  const condition=segment?`${selectedScope}${range(segment.wind_knots,'kt')} wind; ${range(segment.seas_ft,'ft')} seas / ${range(segment.period_seconds,'s')}.`:'';
  const timing=day.tide_moon||{};
  const moon=[timing.moon_phase||'Unavailable',Number.isFinite(timing.illumination_percent)?`${timing.illumination_percent.toFixed(0)}% illuminated`:null,timing.preceding_night?`Moon up ${timing.preceding_night.moon_above_horizon_hours.toFixed(1)} h overnight`:null].filter(Boolean);
  const tideCells=['H','L'].map(type=>(timing.tides||[]).filter(t=>t.type===type).map(t=>`${clock(t.time_utc,zone)} (${t.height_ft.toFixed(1)} ft)`));
  const zoneLabel=new Intl.DateTimeFormat('en-US',{timeZone:zone,timeZoneName:'short'}).formatToParts(new Date(day.date+'T12:00:00Z')).find(p=>p.type==='timeZoneName').value;
  const lunar=`Moon: ${moon.join('; ')} | High tides: ${tideCells[0].join('; ')||'Unavailable'} | Low tides: ${tideCells[1].join('; ')||'Unavailable'} (${zoneLabel}, ${(timing.tides||[])[0]?.datum||'datum unknown'}).`;
  const cell='padding:6px 8px;border:1px solid #dce5e8;vertical-align:top;text-align:left';
  const timingTable=`<table aria-label="Moon and tides ${escapeHtml(day.date)}" style="width:100%;border-collapse:collapse;font-size:11px;line-height:1.5;margin:8px 0"><thead><tr style="background:#f1f5f6"><th style="${cell}">Moon</th><th style="${cell}">High tides · ${zoneLabel}</th><th style="${cell}">Low tides · ${zoneLabel}</th></tr></thead><tbody><tr><td style="${cell}">${moon.map(escapeHtml).join('<br>')}</td>${tideCells.map(list=>`<td style="${cell}">${list.map(escapeHtml).join('<br>')||'Unavailable'}</td>`).join('')}</tr></tbody></table>`;
  const insight=`${Number.isFinite(timing.tide_range_ft)?`Port tide swing ${timing.tide_range_ft.toFixed(1)} ft (${(timing.tides||[])[0]?.datum||'datum unknown'}). `:''}${day.tide_moon_note}`;
  const basis=option?`${option.basis}; ${option.bite_assessment==='slow'?'latest reported bite slow':option.basis.startsWith('current')?'reported activity':'historical lead'}.`:'';
  const line=`${weekday}: ${label}${day.window?' ('+day.window+')':''}. ${plan} ${day.reason}`;
  lines.push(line,condition,basis,lunar,insight,'');
  html+=`<section style="border-top:1px solid #dce5e8;padding:14px 0"><h2 style="font-size:17px;margin:0 0 7px">${escapeHtml(weekday)} · <span style="color:${colors[day.verdict]||colors.hold}">${escapeHtml(label)}</span>${day.window?' · '+escapeHtml(day.window):''}</h2><p style="margin:4px 0;line-height:1.45"><strong>${escapeHtml(plan)}</strong> ${escapeHtml(day.reason)}</p><p style="font-size:12px;line-height:1.5;color:#536775;margin:5px 0">${escapeHtml(condition+' '+basis)}</p>${timingTable}<p style="font-size:12px;line-height:1.5;color:#536775;margin:5px 0"><strong>${day.research_expectation?'Fishing insight (qualitative): ':'Fishing suggestion: '}</strong>${escapeHtml(insight)}</p>`;
  const rough=typeof roughSeasDisplay==='function'?roughSeasDisplay(day,zone):null;
  if(rough){lines.splice(lines.length-1,0,rough.facts,rough.quip);html+=`<p class="rough-seas-facts" style="font-size:12px;line-height:1.5;color:#755422">${escapeHtml(rough.facts)}</p><p class="rough-seas-quip" style="font-size:13px;line-height:1.5;font-weight:bold;color:#a02c2c">${escapeHtml(rough.quip)}</p>`;}
  html+='</section>';
  for(const id of day.evidence_ids||[]){const e=report.evidence.find(e=>e.evidence_id===id)||(day.historical?(report.historical_evidence||[]).find(e=>e.evidence_id===id):null);if(e)sourceLinks.set(e.url,{title:e.title,date:(e.fishing_date||e.published_at||'date unknown').slice(0,10)});}
 }
 const ocean=renderOceanSection(report.ocean_features,zone);html+=ocean.html;lines.push(...ocean.lines,'');
 const alternatives=typeof fishingOptions==='function'?fishingOptions(report):[],leads=[];
 const seasonal=(report.evidence||[]).filter(e=>Number.isInteger(e.seasonal_rating)&&e.seasonal_month===Number(report.window.period_start.slice(5,7))).sort((a,b)=>b.seasonal_rating-a.seasonal_rating);
 if(seasonal.length){const month=new Date(report.window.period_start+'T12:00:00Z').toLocaleString('en-US',{month:'long',timeZone:'UTC'});html+=`<h2 style="font-size:16px">${escapeHtml(month)} seasonal species outlook</h2>`;lines.push(month+' seasonal species outlook');
  const groups=new Map();for(const e of seasonal){const rating=e.seasonal_rating===0?'Publisher marks closed':e.seasonal_rating+'/5';if(!groups.has(rating))groups.set(rating,[]);groups.get(rating).push(e.species.join(', '));sourceLinks.set(e.url,{title:e.title,date:'Annual guide; retrieved '+e.retrieved_at.slice(0,10)});}
  for(const [rating,species] of groups){const text=rating+': '+species.join(', ')+'.';html+=`<p style="font-size:13px">${escapeHtml(text)}</p>`;lines.push(text);}
  const note='Publisher seasonal opportunity ratings compare months for each species, not catch probabilities or current bite reports. Check current rules; guide closure labels are not regulatory verification.';html+=`<p style="font-size:11px;color:#536775">${note}</p>`;lines.push(note);
 }
 const surf=(report.evidence||[]).filter(e=>e.regional_context_only===true&&e.kind!=='marketing').sort((a,b)=>Number(!!b.first_hand)-Number(!!a.first_hand)||Date.parse(b.published_at)-Date.parse(a.published_at));
 if(surf.length){html+='<h2 style="font-size:16px">Regional surf reports</h2>';lines.push('Regional surf reports');const seen=new Set();for(const e of surf){if(seen.has(e.url))continue;seen.add(e.url);if(seen.size>2)break;const text=`${e.title} — published ${(e.published_at||'unknown').slice(0,10)}; trip ${e.fishing_date||'date uncertain'}. ${e.excerpt}`;html+=`<p style="font-size:13px">${escapeHtml(text)} ${safeLink(e.url,'Source')}</p>`;lines.push(text+' '+e.url);sourceLinks.set(e.url,{title:e.title,date:(e.published_at||'unknown').slice(0,10)});}html+='<p style="font-size:11px">Regional shore-fishing context; assess beach conditions separately from the boat forecast.</p>';lines.push('Regional shore-fishing context; assess beach conditions separately from the boat forecast.');}
 for(const option of alternatives)if(!leads.some(o=>o.method===option.method)){leads.push(option);if(leads.length===3)break;}
 if(leads.length){html+='<h2 style="font-size:16px">Spots and alternatives from past reports</h2>';lines.push('Spots and alternatives from past reports');
  for(const option of leads){const e=report.evidence.find(e=>e.evidence_id===option.evidence_ids[0]);const line=`${option.spots.slice(0,2).join(' / ')||option.area+' water'}: ${methodLabel[option.method]} for ${option.species} (${option.basis}).`;
   html+=`<p style="font-size:13px;margin:7px 0">${escapeHtml(line)}${e?' '+safeLink(e.url,'Report '+(e.fishing_date||e.published_at||'date unknown').slice(0,10)):''}</p>`;lines.push(line+(e?' '+e.url:''));}
 }
 html+='<p style="font-size:12px;color:#536775">Named spots are general report leads; check your chart and route against the 40 nm limit. GO means the selected forecast window fits your weather preferences. Fishing prospects remain conditional; verify current targeting and harvest rules.</p>';
 lines.push('Named spots are report leads; verify route within 40 nm and current targeting/harvest rules. GO means the forecast window fits your weather preferences.');
 const news=typeof renderFishingNews==='function'?renderFishingNews(report):null;
 if(news){html+=news.html;lines.push(...news.lines);}
 html+='<h2 style="font-size:16px">Report sources</h2>';
 if(typeof communityDisplayLines==='function')for(const line of communityDisplayLines(report)){
  html+=`<p style="font-size:11px;color:#536775">${escapeHtml(line)}</p>`;lines.push(line);
 }
 const requested=(report.sources||[]).filter(s=>s.url&&s.source_id!=='nws_alerts').map(s=>[s.url,s.source_id]);
 for(const [url,title] of requested){html+=`<p style="font-size:12px;margin:5px 0">${safeLink(url,title)}</p>`;lines.push(title+': '+url);}
 for(const e of (report.evidence||[]).filter(e=>e.regional_context_only).slice(0,2))sourceLinks.set(e.url,{title:'Regional context — '+e.title,date:e.fishing_date||'trip date unknown'});
 for(const [url,s] of [...sourceLinks].slice(0,24)){html+=`<p style="font-size:12px;margin:5px 0">${safeLink(url,s.title)} · ${escapeHtml(s.date)}</p>`;lines.push(s.title+' ('+s.date+'): '+url);}
 if(report.bite_research?.status==='live_researched'){
  const used=new Set(report.daily_outlook.flatMap(d=>d.evidence_ids||[]));
  const links=report.bite_research.sources.filter(s=>used.has(s.evidence_id));
  html+=`<p style="font-size:10px;color:#536775">Fishing insight references: ${links.map(s=>safeLink(s.url,s.title)).join(' · ')}</p>`;
  lines.push('Fishing insight references: '+links.map(s=>s.title+': '+s.url).join('; '));
 }
 const official=report.sources.filter(s=>s.url&&['nws_alerts','grid_nearshore','grid_offshore'].includes(s.source_id));
 const gaps=report.sources.filter(s=>['failed','stale'].includes(s.status));
 if(gaps.length){const note='Source gaps: '+gaps.map(s=>`${({spacefish_canaveral:'Spacefish',sealeveler_canaveral:'Sea Leveler',nws_alerts:'marine alerts',grid_nearshore:'nearshore forecast',grid_offshore:'offshore forecast',noaa_tides:'port tides',skyfield_de421:'astronomy'})[s.source_id]||'supplemental source'} ${s.status==='failed'?'unavailable':'stale'}`).join('; ')+'.';html+=`<p style="font-size:11px;color:#755422">${escapeHtml(note)}</p>`;lines.push(note);}
 for(const s of official){html+=`<p style="font-size:11px;margin:5px 0">${safeLink(s.url,s.source_id==='nws_alerts'?'Official marine alerts':s.source_id.replace('grid_','')+' forecast')} · issued ${escapeHtml(s.issued_at||'unknown')} · retrieved ${escapeHtml(s.retrieved_at)}</p>`;}
 const observation=report.observations[0];if(observation){const note=`Buoy ${observation.station}, ${observation.observed_at}: ${observation.wind_knots??'unavailable'} kt wind, ${observation.seas_ft??'unavailable'} ft seas (${observation.status}).`;html+=`<p style="font-size:11px;color:#536775">${escapeHtml(note)}</p>`;lines.push(note);}
 for(const note of [...new Set(report.warnings||[])]){html+=`<p style="font-size:10px;color:#657783">${escapeHtml(note)}</p>`;lines.push(note);}
 const v=report.limits?.vessel||{};
 const preferences='Your weather limits: maximum waves '+(v.max_seas_ft??'unset')+' ft; sustained wind below '+(v.max_wind_knots??'unset')+' kt; gust limits '+(v.max_gust_below_15_knots??'unset')+'/'+(v.max_gust_at_or_above_15_knots??'unset')+' kt below/at-or-above fifteen knots sustained. Wave/period rules: '+(v.wave_period_rules||[]).map(r=>(r.max_exclusive?'<':'≤')+r.max_seas_ft+' ft needs '+(r.period_exclusive?'>':'≥')+r.min_period_seconds+' s').join('; ')+'. Recheck conditions before departure.';
 html+=`<footer style="border-top:1px solid #dce5e8;margin-top:20px;padding-top:12px;font-size:10px;line-height:1.5;color:#657783">${escapeHtml(preferences)}</footer></main></body></html>`;lines.push('',preferences);
 return {html,text:lines.join('\n'),markdown:lines.join('\n'),subject:`${report.fixture?'[FIXTURE] ':''}${report.delayed?'[DELAYED] ':''}${report.title}`};
}
function syntheticCollectors(context) {
  const issued=context.scheduled_for,start=context.window.start_utc,end=context.window.end_utc;
  const value=(uom,v,coverageEnd=end)=>({uom,values:[{validTime:`${start}/PT${(Date.parse(coverageEnd)-Date.parse(start))/3600000}H`,value:v}]});
  const grids=context.location.forecast_points.map(point=>normalizeGrid({source_id:`grid_${point.id}`,point_id:point.id,zone:point.zone,location_id:context.location_id,status:'ok',retrieved_at:issued,url:'https://api.weather.gov/ (synthetic fixture)',raw:{properties:{updateTime:issued,windSpeed:value('wmoUnit:km_h-1',18.52),windGust:value('wmoUnit:km_h-1',22.224),waveHeight:value('wmoUnit:m',0.6),wavePeriod:value('nwsUnit:s',9),weather:value(null,[]),hazards:value(null,[])}}},context,issued));
  return [...grids,{source_id:'nws_alerts',location_id:context.location_id,status:'empty',retrieved_at:issued,issued_at:null,url:'https://api.weather.gov/alerts (synthetic)',records:[],warnings:[],error:null},
    {source_id:'noaa_tides',location_id:context.location_id,status:'ok',retrieved_at:issued,issued_at:null,url:'https://api.tidesandcurrents.noaa.gov/ (synthetic)',records:context.window.dates.flatMap(date=>[{time_utc:localInstant(date,context.location.timezone,8),height_ft:3.2,type:'H',datum:'MLLW'},{time_utc:localInstant(date,context.location.timezone,14),height_ft:0.4,type:'L',datum:'MLLW'}]),warnings:[],error:null}];
}
if(typeof module!=='undefined')module.exports={SCHEMA_VERSION,parts,localDate,addDays,localInstant,reportWindow,latestScheduled,validateConfig,normalizeRun,locationContext,envelope,durationHours,gridIntervals,normalizeGrid,normalizeBuoy,normalizeTides,normalizeAlerts,normalizeCoastalProduct,numericSummary,conditionPreference,forecastTable,factualReport,render,renderOceanSection,escapeHtml,syntheticCollectors};
