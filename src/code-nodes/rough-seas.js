'use strict';
const ROUGH_SEAS_POLICY='fresh-forecast-over-eight-v1';
function roughSeasScopes(report,date,config={}) {
 if(!report.window?.dates?.includes(date)||report.daily_outlook?.some(d=>d.date===date&&d.historical)||report.historical_forecast===true||(report.update_kind==='friday_decisions'&&date===report.window.period_start))return [];
 const checked=report.decision_checked_at||report.collected_at,now=Date.parse(checked),limit=config.quality?.forecast_max_age_hours??12;
 if(!Number.isFinite(now)||!Number.isFinite(limit)||limit<=0)return [];
 const scopes=[];
 for(const row of report.forecast_table||[]){
  const issued=Date.parse(row.issued_at),age=(now-issued)/3600000;
  if(row.date!==date||row.historical||row.forecast_status!=='ok'||!row.point_id||!Number.isFinite(issued)||age<0||age>limit)continue;
  for(const window of ['morning','afternoon']){
   const segment=row[window],wave=segment?.seas_ft;
   if(!Number.isFinite(wave?.max)||wave.max<=8||!['complete','partial'].includes(wave.coverage))continue;
   const start=Date.parse(segment.start),end=Date.parse(segment.end);
   if(!Number.isFinite(start)||!Number.isFinite(end)||end<=start)continue;
   const intervals=(Array.isArray(wave.forecast_intervals)?wave.forecast_intervals:[]).filter(i=>i&&Number.isFinite(i.value_ft)&&Number.isFinite(Date.parse(i.start))&&Number.isFinite(Date.parse(i.end))&&Date.parse(i.start)>=start&&Date.parse(i.end)<=end&&Date.parse(i.end)>Date.parse(i.start));
   // Summaries without normalized interval provenance (including old archives)
   // cannot become a new humor trigger merely by being copied into a report.
   if(!intervals.length||Math.max(...intervals.map(i=>i.value_ft))!==wave.max)continue;
   const qualifying=intervals.filter(i=>i.value_ft>8);
   if(!qualifying.length)continue;
   scopes.push({policy_version:ROUGH_SEAS_POLICY,scope_id:`rough_${date}_${row.point_id}_${window}`,date,point_id:row.point_id,zone:row.zone,window,
    interval_start:segment.start,interval_end:segment.end,max_seas_ft:wave.max,unit:'feet',coverage:wave.coverage,
    coverage_scope:wave.coverage==='partial'?'observed_forecast_intervals_only':'complete_display_interval',
    observed_forecast_intervals:intervals,qualifying_intervals:qualifying,issued_at:row.issued_at,forecast_status:row.forecast_status,
    checked_at:checked,age_hours:age,forecast_evidence_id:`forecast_${date}_${row.point_id}`});
  }
 }
 return scopes.sort((a,b)=>b.max_seas_ft-a.max_seas_ft||a.point_id.localeCompare(b.point_id)||a.window.localeCompare(b.window));
}
function roughScopeSignature(scope){
 if(!scope)return null;
 const {checked_at,age_hours,...identity}=scope;
 const canonical=value=>Array.isArray(value)?value.map(canonical):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(k=>[k,canonical(value[k])])):value;
 return JSON.stringify(canonical(identity));
}
function roughQuipTextError(text){
 if(typeof text!=='string'||!text.trim())return 'missing_quip';
 if(text.length>220||(text.match(/[\p{L}]+(?:['’][\p{L}]+)*/gu)||[]).length>24)return 'quip_too_long';
 if(/[\r\n\u0000-\u001f\p{N}%<>\[\]`]/u.test(text)||/https?:|www\./i.test(text))return 'quip_contains_numeric_markup_or_url';
 if(!/^NO GO(?:\b|[—:;!,.-])/i.test(text))return 'quip_needs_explicit_no_go';
 // The renderer owns area/time scope. Prose cannot broaden an offshore stop
 // into a nearshore or whole-day verdict, or invent an official event/outcome.
 if(/\b(?:nearshore|offshore|morning|afternoon|today|tomorrow|yesterday|already|entire|everywhere|storm|hurricane|gale|advisory|warning|alert|official|noaa|nws|casualt(?:y|ies)|injur(?:ed|ies)|drown(?:ed|ing)?|dead|killed|fatal|died|sank|sunk|capsized|rescued|rescues|rescuing|saved|saving|victims?|guarantee(?:d)?|certain(?:ly)?|will|would|must|always|definitely|safe|zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|twenty|thirty|hundred|feet|foot|ft|meters?|metres?|knots?|seconds?)\b/i.test(text))return 'quip_invents_scope_event_or_certainty';
 if(!/coast guard|rescue|headline|obituar|funeral|life jacket|training video|bucket list|\bdie\b|\bdeath\b|widow/i.test(text))return 'quip_missing_requested_dark_humor';
 return null;
}
function validateRoughSeasQuip(item,plan,packet){
 const scope=plan.rough_seas_scopes?.[0];
 if(!scope){const valid=item.rough_seas_quip===null&&item.rough_seas_scope_id===null;return {valid,error:valid?null:'untriggered_or_missing_null_quip'};}
 const error=roughQuipTextError(item.rough_seas_quip);
 if(error)return {valid:false,error};
 if(item.rough_seas_scope_id!==scope.scope_id)return {valid:false,error:'quip_scope_mismatch'};
 const fact=packet.evidence?.[scope.forecast_evidence_id];
 if(!Array.isArray(item.evidence_ids)||!item.evidence_ids.includes(scope.forecast_evidence_id)||fact?.kind!=='forecast'||fact.date!==scope.date||fact.status!=='ok'||fact.issued_at!==scope.issued_at||fact[scope.window]?.seas_ft?.max!==scope.max_seas_ft)return {valid:false,error:'quip_forecast_evidence_mismatch'};
 return {valid:true,error:null};
}
const ROUGH_SEAS_FALLBACKS=[
 'NO GO—unless a rescue headline is the souvenir you wanted.',
 'NO GO—the fish can keep their appointment; your obituary can wait.',
 'NO GO—unless auditioning for a Coast Guard training video sounds like a fishing trip.',
 'NO GO—your life jacket did not volunteer to proofread your obituary.',
 'NO GO—unless a Coast Guard cameo is on your bucket list.',
 'NO GO—stay dockside; an obituary is a lousy fishing report.',
 'NO GO—unless your bucket list ends with a rescue headline.',
 'NO GO—leave the fish alone and keep the funeral director bored.'
];
function roughFallback(scope,used=new Set()){
 const ordinal=Math.floor(Date.parse(scope.date+'T12:00:00Z')/86400000);
 const salt=(scope.point_id+'_'+scope.window).split('').reduce((n,c)=>n+c.charCodeAt(0),0);
 for(let i=0;i<ROUGH_SEAS_FALLBACKS.length;i++){
  const text=ROUGH_SEAS_FALLBACKS[(ordinal+salt+i)%ROUGH_SEAS_FALLBACKS.length];
  if(!used.has(text.toLowerCase()))return text;
 }
 return ROUGH_SEAS_FALLBACKS[(ordinal+salt)%ROUGH_SEAS_FALLBACKS.length];
}
function withRoughSeas(report,day,config={},prior=null,used=new Set()){
 if(day.historical){if(day.rough_seas_quip)used.add(day.rough_seas_quip.toLowerCase());return day;}
 const scopes=roughSeasScopes(report,day.date,config),scope=scopes[0];
 let text=null,source=null;
 if(scope){
  const oldScope=prior?.rough_seas_scopes?.find(s=>s.scope_id===prior.rough_seas_scope_id);
  if(oldScope&&prior.rough_seas_scope_id===scope.scope_id&&roughScopeSignature(oldScope)===roughScopeSignature(scope)&&!roughQuipTextError(prior.rough_seas_quip)&&!used.has(prior.rough_seas_quip.toLowerCase())){text=prior.rough_seas_quip;source=prior.rough_seas_quip_source;}
  else {text=roughFallback(scope,used);source='deterministic_fallback';}
  used.add(text.toLowerCase());
 }
 return {...day,rough_seas_scopes:scopes,rough_seas_scope_id:scope?.scope_id||null,rough_seas_quip:text,rough_seas_quip_source:source};
}
function applyRoughSeasWriter(context,items){
 const used=new Set(),diagnostics=[];
 context.report.daily_outlook=context.report.daily_outlook.map(day=>{
  if(day.historical){if(day.rough_seas_quip)used.add(day.rough_seas_quip.toLowerCase());return day;}
  const item=items.find(i=>i.date===day.date)||{},validation=validateRoughSeasQuip(item,day,context.writer_packet),scope=day.rough_seas_scopes?.[0];
  if(scope&&validation.valid&&!used.has(item.rough_seas_quip.toLowerCase())){
   used.add(item.rough_seas_quip.toLowerCase());return {...day,rough_seas_quip:item.rough_seas_quip.trim(),rough_seas_scope_id:scope.scope_id,rough_seas_quip_source:'writer'};
  }
  if(!validation.valid||scope)diagnostics.push({date:day.date,reason:validation.valid?'duplicate_quip':validation.error});
  const text=scope?roughFallback(scope,used):null;if(text)used.add(text.toLowerCase());
  return {...day,rough_seas_quip:text,rough_seas_scope_id:scope?.scope_id||null,rough_seas_quip_source:scope?'deterministic_fallback':null};
 });
 context.report.writer.rough_seas_diagnostics=diagnostics;
 return context;
}
function roughSeasDisplay(day,zone){
 const scope=day.rough_seas_scopes?.find(s=>s.scope_id===day.rough_seas_scope_id);
 if(!scope||!day.rough_seas_quip)return null;
 const area=scope.point_id==='nearshore'?'Nearshore':scope.point_id==='offshore'?'Offshore':scope.zone||scope.point_id;
 const height=Number(scope.max_seas_ft.toFixed(2))<=8&&scope.max_seas_ft>8?'>8.00':scope.max_seas_ft.toFixed(2);
 const intervals=scope.qualifying_intervals.map(i=>`${clock(i.start,zone)}–${clock(i.end,zone)}`).join('; ');
 const facts=`${area} ${scope.window}: forecast seas up to ${height} ft. ${scope.coverage==='partial'?`Partial coverage; warning applies only to covered forecast hours (${intervals}); missing hours remain unknown.`:`Affected forecast hours: ${intervals}.`}`;
 return {facts,quip:`${area} ${scope.window}: ${day.rough_seas_quip}`};
}
if(typeof module!=='undefined')module.exports={ROUGH_SEAS_POLICY,roughSeasScopes,roughScopeSignature,roughQuipTextError,validateRoughSeasQuip,roughFallback,withRoughSeas,applyRoughSeasWriter,roughSeasDisplay};
