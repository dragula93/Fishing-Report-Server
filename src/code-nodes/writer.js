'use strict';
function eligibleTargets(context,now=new Date().toISOString()) {
 const rules=context.config.target_rules||[],out=[];
 const windows=context.report.forecast_table.filter(r=>context.window.weekend.includes(r.date)).flatMap(r=>[r.morning,r.afternoon].filter(s=>s.preference.startsWith('within configured preferences')).map(s=>({date:r.date,zone:r.zone,segment:s.name})));
 if(!windows.length)return [];
 for(const e of context.evidence) {
  if(e.provenance_type==='verified_public_community'&&(!e.applicable_location_ids?.includes(context.location_id)||e.regional_context_only))continue;
  if(!e.current_qualifying||!e.route_distance_verified||!Number.isFinite(e.route_distance_nm)||e.route_distance_nm>context.location.max_one_way_distance.value)continue;
  for(const species of e.species) {
   const jurisdictions=e.jurisdictions||[];
   if(!jurisdictions.length)continue;
   const matched=jurisdictions.map(j=>rules.find(r=>r.species===species&&r.jurisdiction===j&&r.effective_start<=context.window.period_start&&r.effective_end>=context.window.period_end&&r.targeting_status==='allowed'&&Date.parse(now)-Date.parse(r.verified_at)<=7*86400000&&Date.parse(r.verified_at)<=Date.parse(now)&&/^https:\/\/(?:myfwc\.com|www\.fisheries\.noaa\.gov|www\.ecfr\.gov)\//.test(r.official_url)));
   if(matched.some(r=>!r))continue;
   const key=species+'_'+e.method;let target=out.find(t=>t.key===key);
   if(!target){target={key,species,method:e.method,evidence_ids:[],observation_ids:[],allowed_windows:windows,rule_urls:matched.map(r=>r.official_url),retention_status:matched.every(r=>r.retention_status==='allowed')?'allowed_with_rule_conditions':'unverified_or_restricted',confidence:'single independent recent report'};out.push(target);}
   target.evidence_ids.push(e.evidence_id);
   if(!target.observation_ids.includes(e.observation_id||e.url))target.observation_ids.push(e.observation_id||e.url);
   if(target.observation_ids.length>1)target.confidence='multiple independent recent reports';
  }
 }
 return out;
}
function writerPacket(context) {
 context.evidence=relevantEvidence(context.evidence,context.window,context.collected_at||new Date().toISOString());
 const evidence={};
 for(const row of context.report.forecast_table) {
  const id=`forecast_${row.date}_${row.point_id}`;
  evidence[id]={kind:'forecast',date:row.date,zone:row.zone,issued_at:row.issued_at,status:row.forecast_status,day:row.day,morning:row.morning,afternoon:row.afternoon,trend:row.trend,alert_status:row.alert_status};
 }
 const included=typeof diversifiedEvidence==='function'?diversifiedEvidence(context.evidence,24):context.evidence.slice(0,24);
 const options=fishingOptions({...context.report,evidence:included},context.config);
 // The daily deterministic choices must use the identical bounded evidence set.
 context.report.evidence=context.evidence;
 for(const e of included)evidence[e.evidence_id]={kind:'fishing_evidence',species:e.species,method:e.method,fishing_date:e.fishing_date,published_at:e.published_at,retrieved_at:e.retrieved_at,age_label:e.age_label,seasonal_month:e.seasonal_month||null,seasonal_rating:e.seasonal_rating??null,relevance:evidenceRelevance(e,context.window,context.collected_at||new Date().toISOString()),current_qualifying:e.current_qualifying,first_hand:e.first_hand,range_status:e.range_status,route_distance_verified:e.route_distance_verified,general_spots:e.general_spots||[],bite_assessment:e.bite_assessment||'context',timing_associations:e.timing_associations||{},bait:e.bait,depth_wording:e.depth_wording,excerpt:String(e.excerpt||'').slice(0,400),url:e.url,source_id:e.source_id,provenance_type:e.provenance_type||'publisher',geography:e.geography||'canaveral_brevard',regional_context_only:e.regional_context_only===true};
 context.report.daily_outlook=dailyOutlook({...context.report,evidence:included},context.config);
 if(typeof carryHistoricalThursday==='function')carryHistoricalThursday(context);
 for(const date of context.window.dates){const timing=tideMoonContext(context.report,date);evidence['tides_'+date]={kind:'tides',date,tides:timing.tides,changes:timing.changes,tide_range_ft:timing.tide_range_ft};evidence['moon_'+date]={kind:'astronomy',date,moon_phase:timing.moon_phase,illumination_percent:timing.illumination_percent,preceding_night:timing.preceding_night};}
 const research=typeof biteResearch==='function'?biteResearch(context.report):{sources:[],temperature_observations:[]};
 for(const source of research.sources)evidence[source.evidence_id]=source;
 for(const observation of research.temperature_observations)evidence['temperature_'+observation.station]=observation;
 context.report.bite_research={sources:research.sources,status:'pending',expectation_type:'researched qualitative expectation'};
 const daily=context.report.daily_outlook.filter(p=>!p.historical).map(p=>({date:p.date,verdict:p.verdict,candidate_id:p.candidate_id,window:p.window,point_id:p.point_id,reason:p.reason,prospect:p.prospect,allowed_choices:p.allowed_choices,rough_seas_scopes:p.rough_seas_scopes||[],rough_seas_scope_id:p.rough_seas_scope_id||null}));
 return {schema_version:'1.0',location_id:context.location_id,window:context.window,freshness_policy:{max_report_age_days:28,max_seasonal_offset_days:56,as_of:context.collected_at},seasonal_outlook:context.evidence.filter(e=>Number.isInteger(e.seasonal_rating)).map(e=>({species:e.species,month:e.seasonal_month,rating:e.seasonal_rating,scale:e.rating_scale,url:e.url,retrieved_at:e.retrieved_at})),refresh_dates:daily.map(p=>p.date),historical_dates:context.report.daily_outlook.filter(p=>p.historical).map(p=>p.date),model:context.config.llm.model||null,evidence,research,allowed_targets:eligibleTargets({...context,evidence:included}),fishing_options:options,daily_plans:daily,limitations:context.report.warnings,community_research:context.report.community_research||null,marine_data_available:context.report.outlook_mode!=='data_unavailable'};
}
function validateWriter(result,packet) {
 const errors=[],roughWarnings=[];const fail=x=>errors.push(x);
 if(!result||typeof result!=='object'||Array.isArray(result))return {valid:false,errors:['Response must be an object']};
 if(Object.keys(result).sort().join(',')!=='daily,limitations,overview,recommendations')fail('Unexpected response fields');
 if(!Array.isArray(result.overview)||result.overview.length<1||result.overview.length>6)fail('Overview must contain one to six sentences');
 if(!Array.isArray(result.recommendations)||result.recommendations.length>6)fail('Invalid recommendations');
 if(!Array.isArray(result.limitations)||result.limitations.length>10||result.limitations.some(x=>typeof x!=='string'))fail('Invalid limitations');
 const checkText=(text,refs)=>{
  if(typeof text!=='string'||!text.trim()||text.length>1200){fail('Invalid claim text');return;}
  if(/https?:|www\.|\b(?:safe|guaranteed|certain|probability|percent|feeding\s+period|major\s+feeding|inshore|lagoon)\b|\d|[%<>]/i.test(text))fail('Unsupported numeric, URL, scope or certainty claim');
  if(!Array.isArray(refs)||!refs.length||refs.some(id=>typeof id!=='string'||!packet.evidence[id])){fail('Unknown or missing evidence reference');return;}
  const supported=refs.map(id=>packet.evidence[id]);
  const phases=['new moon','full moon','first quarter','last quarter','waxing crescent','waning crescent','waxing gibbous','waning gibbous'];
  for(const phase of phases)if(text.toLowerCase().includes(phase)&&!supported.some(e=>e.kind==='astronomy'&&e.moon_phase?.toLowerCase()===phase))fail('Moon phase differs from cited astronomy');
  // Link an effect word to bite/catch/feeding, rather than treating a separate
  // "reduced moon exposure" clause as a claim of reduced feeding.
  const biteEffect=/\b(?:boost\w*|improv\w*|increas\w*|decreas\w*|reduc\w*)\s+(?:\w+[\s-]+){0,3}(?:bite|catch|feeding)\b|\b(?:better|stronger|weaker|slower)\s+(?:bite|catch|feeding)\b|\b(?:bite|catch|feeding)\s+(?:\w+\s+){0,3}(?:boost\w*|improv\w*|increas\w*|decreas\w*|better|stronger|weaker|slower)\b/i.test(text);
  const negativeEffect=/\b(?:no assumed|no clear|no reliable|not a|cannot establish|does not|unconfirmed|unproven)\b/i.test(text);
  const science=supported.filter(e=>e.kind==='research');
  if(biteEffect&&/\b(?:moon|lunar|tide|tidal|temperature|warm|cool)\b/i.test(text)){
   const matched=supported.some(e=>e.kind==='fishing_evidence'&&(e.timing_associations?.moon||e.timing_associations?.tide||e.timing_associations?.temperature));
   if(!matched&&!science.length)fail('Catch effect lacks research or matched fishing evidence');
   if(!matched&&!negativeEffect&&!/\b(?:may|might|could|potential|possible)\b/i.test(text))fail('Researched bite effect must be qualitative');
   for(const [pattern,topic] of [[/\bmoon|lunar\b/i,'moon'],[/\btide|tidal\b/i,'tide'],[/\btemperature|warm|cool\b/i,'temperature']])if(pattern.test(text)&&!matched&&!science.some(e=>e.topics.includes(topic)))fail('Research does not cover the claimed environmental effect');
  }
  if(/\b(?:temperature|warm(?:er)?\s+(?:surface\s+)?water|cool(?:er)?\s+(?:surface\s+)?water|cold\s+water|warming|cooling)\b/i.test(text)&&!supported.some(e=>e.kind==='water_temperature'&&e.status==='ok'))fail('Temperature interpretation needs a fresh observation');
  const speciesCatalog=[...new Set([...SPECIES,...Object.values(packet.evidence).flatMap(e=>e.species||[])])];
  for(const species of speciesCatalog){const pattern=SPECIES_PATTERNS[species]||new RegExp('\\b'+species.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'\\b','i');if(pattern.test(text)&&!supported.some(e=>(e.kind==='fishing_evidence'||e.kind==='research')&&e.species?.some(s=>s.toLowerCase()===species.toLowerCase())))fail('Species claim lacks matching evidence');}
  // A conditional reassessment instruction is not an assertion that the
  // current forecast improves. Only assess actual weather trend wording.
  const weatherText=text.replace(/\bif\s+(?:(?:the|marine)\s+)?(?:conditions|weather|forecasts?|warnings)\s+(?:improv\w*|clear\w*|ease|change)\b/gi,'');
  const weatherTrend=/\b(?:wind|gusts?|seas|waves|weather|conditions|forecasts?)\b/i.test(weatherText);
  if(weatherTrend&&/\b(?:improv|deteriorat|increas|decreas)\w*/i.test(weatherText)&&!supported.some(e=>e.kind==='forecast'&&e.trend!=='trend unavailable'))fail('Trend has no forecast support');
  const forecasts=supported.filter(e=>e.kind==='forecast');
  const deltas=[];
  for(const e of forecasts)for(const field of ['wind_knots','gust_knots','seas_ft'])for(const bound of ['min','max']){const a=e.morning?.[field]?.[bound],b=e.afternoon?.[field]?.[bound];if(Number.isFinite(a)&&Number.isFinite(b))deltas.push(b-a);}
  // Direction may change in one component while another stays steady. The display's
  // aggregate "mixed" label must not erase the underlying component comparison.
  if(weatherTrend&&/\b(?:improv|decreas)\w*/i.test(weatherText)&&!deltas.some(d=>d<0))fail('Improvement is not supported by cited forecast');
  if(weatherTrend&&/\b(?:deteriorat|increas)\w*/i.test(weatherText)&&!deltas.some(d=>d>0))fail('Deterioration is not supported by cited forecast');
  if(/\bthunderstorms?\b/i.test(text)&&!supported.some(e=>e.kind==='forecast'&&(e.day.thunderstorm_forecast||e.morning.thunderstorm_forecast||e.afternoon.thunderstorm_forecast)))fail('Storm claim is not supported by cited forecast');
 };
 if(!Array.isArray(result.daily)||result.daily.length!==(packet.refresh_dates||packet.window.dates).length)fail('Expected one daily recommendation per refreshed report date');
 const seenDates=new Set();
 for(const item of result.daily||[]){
  const plan=packet.daily_plans.find(p=>p.date===item.date);
  if(!plan||seenDates.has(item.date)){fail('Missing, duplicated or unknown daily date');continue;}seenDates.add(item.date);
  if(Object.keys(item).filter(k=>!['rough_seas_quip','rough_seas_scope_id'].includes(k)).sort().join(',')!=='candidate_id,date,evidence_ids,point_id,reason,tide_moon_note,verdict,window')fail('Invalid daily fields');
  if(typeof validateRoughSeasQuip==='function'){const q=validateRoughSeasQuip(item,plan,packet);if(!q.valid)roughWarnings.push({date:item.date,reason:q.error});}
  if(item.verdict!==plan.verdict)fail('Writer cannot override weather verdict');
  if(plan.verdict==='go'){
   const choice=plan.allowed_choices.find(c=>c.candidate_id===item.candidate_id&&c.point_id===item.point_id&&c.segment===item.window);
   if(!choice)fail('Daily method/location/window fails weather or evidence gate');
   const option=packet.fishing_options.find(o=>o.candidate_id===item.candidate_id);
   if(option&&(!item.evidence_ids?.some(id=>option.evidence_ids.includes(id))||!item.evidence_ids?.includes(choice?.forecast_id)))fail('Daily choice needs forecast and fishing support');
  }else if(item.candidate_id!==null||item.window!==null||item.point_id!==null)fail('No trip plan may be invented for a stopped or uncertain day');
  checkText(item.reason,item.evidence_ids);checkText(item.tide_moon_note,item.evidence_ids);
  if(item.reason?.trim().split(/\s+/).length>20||item.tide_moon_note?.trim().split(/\s+/).length>24)fail('Daily prose exceeds compact word limit');
  if(/no assumed bite|supplies no feeding|lunar assumptions|cannot select productive|not a lunar bite|no feeding prediction|no .*bite improvement/i.test(item.tide_moon_note||''))fail('Replace timing disclaimer with a practical researched suggestion');
  if(/\bmoon|lunar\b/i.test(item.tide_moon_note)&&!item.evidence_ids?.includes('moon_'+item.date))fail('Moon context needs that date astronomy');
  if(/\btide|tidal\b/i.test(item.tide_moon_note)&&!item.evidence_ids?.includes('tides_'+item.date))fail('Tide context needs that date predictions');
 }
 for(const item of result.overview||[]) {
  if(!item||Object.keys(item).sort().join(',')!=='evidence_ids,sentence'){fail('Invalid overview fields');continue;}
  checkText(item.sentence,item.evidence_ids);
 }
 for(const item of result.recommendations||[]) {
  if(!item||Object.keys(item).sort().join(',')!=='eligibility_note,evidence_ids,method,species,summary'){fail('Invalid recommendation fields');continue;}
  const target=packet.allowed_targets.find(t=>t.species===item.species&&t.method===item.method);
  if(!target||item.evidence_ids?.some(id=>!target.evidence_ids.includes(id)))fail('Target, method or range not eligible');
  checkText(item.summary,item.evidence_ids);checkText(item.eligibility_note,item.evidence_ids);
 }
 for(const item of result.limitations||[])if(typeof item==='string'&&(/\d|https?:|[%<>]/.test(item)||item.length>1000))fail('Invalid limitation text');
 return {valid:errors.length===0,errors:[...new Set(errors)],rough_seas_warnings:roughWarnings};
}
function applyWriter(context,response) {
 const body=response?.body??response;
 const validation=body?.status==='ok'?validateWriter(body.result,context.writer_packet):{valid:false,errors:[body?.error||'Writer unavailable']};
 context.writer_validation=validation;
 if(validation.valid&&!context.use_fixtures&&context.writer_packet.research?.sources?.length&&!(body?.research?.web_search_calls>0)){validation.valid=false;validation.errors.push('Writer did not perform the required live research');}
 context.report.writer={backend:'codex_chatgpt',status:validation.valid?'validated':'factual_fallback',usage:body?.usage||null,validation_errors:validation.errors};
 if(context.report.bite_research)context.report.bite_research={...context.report.bite_research,status:validation.valid&&body?.research?.web_search_calls>0?'live_researched':'unavailable',web_search_calls:body?.research?.web_search_calls||0,checked_at:body?.research?.checked_at||null};
 if(validation.valid){context.report.overview_claims=body.result.overview;context.report.overview=body.result.overview.map(x=>x.sentence).join(' ');context.report.recommendations=body.result.recommendations;context.report.warnings.push(...body.result.limitations);context.report.daily_outlook=context.report.daily_outlook.map(plan=>{if(plan.historical)return plan;const item=body.result.daily.find(d=>d.date===plan.date);const option=context.writer_packet.fishing_options.find(o=>o.candidate_id===item.candidate_id)||null;return {...plan,...item,option,research_expectation:item.evidence_ids.some(id=>context.writer_packet.evidence[id]?.kind==='research')};});context.report.outlook_mode=context.report.daily_outlook.some(d=>d.verdict==='go')?'conditional_outlook':'limited_evidence';}
 if(validation.valid&&typeof applyRoughSeasWriter==='function')applyRoughSeasWriter(context,body.result.daily);
 return context;
}
if(typeof module!=='undefined')module.exports={eligibleTargets,writerPacket,validateWriter,applyWriter};
