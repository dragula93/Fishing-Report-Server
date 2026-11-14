'use strict';
function fishingOptions(report,config={}) {
 const groups=new Map();
 const usable=relevantEvidence(report.evidence||[],report.window,report.collected_at||new Date().toISOString());
 // General fishing leads are separate from verified targeting/retention advice.
 // Do not promote sensitive closed/permit-dependent targets from an old report.
 const omitted=new Set(['red snapper','gag grouper','red grouper','amberjack','sailfish']);
 const balanced=typeof diversifiedEvidence==='function'?diversifiedEvidence(usable,24):usable;
 for(const e of balanced) {
  if(e.provenance_type==='verified_public_community'&&(!e.applicable_location_ids?.includes(report.location_id)||e.regional_context_only||!e.fishing_date||e.research_label==='out_of_season_history'))continue;
  if(e.regional_context_only||e.kind==='marketing'||e.range_status==='outside_limit'||e.seasonal_rating===0)continue;
  const basis=evidenceRelevance(e,report.window,report.collected_at||new Date().toISOString());
  const recent=basis!=='seasonal history';
  const method=e.method;
  if(!['trolling','bottom_fishing','nearshore_bait'].includes(method))continue;
  const area=e.habitat==='beach'?'beach':e.habitat==='nearshore'||method==='nearshore_bait'?'nearshore':e.general_spots?.some(s=>/reef|pelican|8a|wreck|shallow/i.test(s))?'nearshore':'offshore';
  for(const species of e.species||[]) {
   if(omitted.has(species))continue;
   // Broad mixed-pattern paragraphs do not establish that a pelagic species
   // belongs to a separately mentioned reef/bottom technique.
   if(method==='bottom_fishing'&&!e.source_species?.includes(species)&&!['mangrove snapper','lane snapper','mutton snapper','triggerfish','sheepshead'].includes(species))continue;
   if((config.target_rules||[]).some(r=>r.species===species&&r.targeting_status==='prohibited'&&r.effective_start<=report.window.period_end&&r.effective_end>=report.window.period_start))continue;
   const key=species+'_'+method+'_'+area;
   const rating=usable.find(r=>Number.isInteger(r.seasonal_rating)&&r.species?.some(s=>s.toLowerCase()===species.toLowerCase())&&r.seasonal_month===Number(report.window.period_start.slice(5,7)))?.seasonal_rating;
   if(rating===0)continue;
   const age=Number.isFinite(e.age_days)?e.age_days:28;
   const score=(e.current_qualifying?60:recent?45:25)+(recent?Math.max(0,28-age)/4:0)+(e.seasonal_month?5:0)+(rating??0)+(e.first_hand?5:0)+(e.bite_assessment==='positive'?3:e.bite_assessment==='slow'?-5:0);
   const current=groups.get(key)||{candidate_id:'option_'+groups.size,species,method,area,evidence_ids:[],spots:[],score:0,basis,observation_ids:[],bite_assessment:e.bite_assessment||'context',route_verified:false,planning_only:true};
   current.evidence_ids.push(e.evidence_id);current.spots=[...new Set([...current.spots,...(e.general_spots||[])])];
   current.observation_ids=[...new Set([...current.observation_ids,e.observation_id||e.url])];
   if(score>current.score){current.score=score;current.basis=basis;current.bite_assessment=e.bite_assessment||'context';}
   current.route_verified=current.route_verified||e.route_distance_verified===true;groups.set(key,current);
  }
 }
 // A fresh catch with no stated method can corroborate an older documented
 // technique for the same species/area; it does not invent the fresh method.
 for(const candidate of groups.values())for(const e of usable) {
  if(e.regional_context_only)continue;
  if(e.method!=='unspecified'||!e.species.includes(candidate.species)||!e.current_qualifying||e.kind==='marketing')continue;
  if(e.general_spots?.length&&!e.general_spots.some(s=>candidate.spots.includes(s)))continue;
  candidate.evidence_ids=[...new Set([...candidate.evidence_ids,e.evidence_id])];candidate.score=Math.max(candidate.score,55);candidate.basis='current catch; method from history';candidate.bite_assessment=e.bite_assessment||'context';
 }
 const ranked=[...groups.values()].sort((a,b)=>b.score-a.score),reserved=[];
 // Keep the best supported lead for each method/area before bounding the
 // writer packet; numerous trolling species must not hide bottom/beach leads.
 for(const option of ranked)if(!reserved.some(o=>o.method===option.method&&o.area===option.area))reserved.push(option);
 const selected=[...reserved,...ranked.filter(o=>!reserved.includes(o))].slice(0,18);
 return selected.sort((a,b)=>b.score-a.score);
}
function tideMoonContext(report,date) {
 const tides=report.tides.filter(t=>localDate(t.time_utc,report.window.timezone)===date).sort((a,b)=>Date.parse(a.time_utc)-Date.parse(b.time_utc));
 const moon=report.astronomy.find(a=>a.date===date)||null;
 const range=tides.length>1?Math.max(...tides.map(t=>t.height_ft))-Math.min(...tides.map(t=>t.height_ft)):null;
 const changes=[];
 for(let i=1;i<tides.length;i++){const a=tides[i-1],b=tides[i];if(a.type!==b.type)changes.push({start:a.time_utc,end:b.time_utc,water_level:b.type==='H'?'rising':'falling'});}
 return {moon_phase:moon?.moon_phase||null,illumination_percent:moon?.illumination_percent??null,preceding_night:moon?.preceding_night||null,tide_range_ft:range===null?null:Math.round(range*100)/100,tides,changes,
  interpretation:'Local water-level timing; offshore current and a stronger bite are not established.',catch_adjustment:'neutral_without_matched_catch_evidence'};
}
function dailyOutlook(report,config={}) {
 const options=fishingOptions(report,config),usedQuips=new Set();
 return report.window.dates.map(date=>{
  const rows=report.forecast_table.filter(r=>r.date===date),choices=[];
  for(const row of rows)for(const name of ['morning','afternoon']) {
   const segment=row[name];if(!segment.preference.startsWith('within configured preferences'))continue;
   const area=row.point_id==='nearshore'?'nearshore':'offshore';
   const available=options.filter(o=>area==='offshore'||o.area!=='offshore');
   for(const option of available)choices.push({candidate_id:option.candidate_id,point_id:row.point_id,zone:row.zone,segment:name,
    score:option.score-segment.seas_ft.max*2-segment.wind_knots.max*0.2-segment.gust_knots.max*0.1+segment.period_seconds.min*0.05,forecast_id:`forecast_${date}_${row.point_id}`});
  }
  choices.sort((a,b)=>b.score-a.score);const selected=choices[0]||null;
  const anyWithin=rows.some(r=>[r.morning,r.afternoon].some(s=>s.preference.startsWith('within configured preferences')));
  const explicitStop=rows.length&&rows.every(r=>[r.morning,r.afternoon].every(s=>/outside|exceeds|official hazard/.test(s.preference)));
  const verdict=selected?'go':anyWithin?'go_conditions_only':explicitStop?'dont_go':'hold';
  const option=selected?options.find(o=>o.candidate_id===selected.candidate_id):null;
  const selectedRow=selected?rows.find(r=>r.point_id===selected.point_id):rows.find(r=>r.point_id==='nearshore')||rows[0];
  const trend=selectedRow?.trend||'trend unavailable';
  const laterOutside=selected?.segment==='morning'&&!selectedRow.afternoon.preference.startsWith('within configured preferences');
  const day={date,verdict,candidate_id:option?.candidate_id||null,option,allowed_choices:choices,window:selected?.segment||null,point_id:selected?.point_id||null,
   reason:selected?(laterOutside?'Morning only; afternoon falls outside your limits.':trend==='wind and seas increase'?'Prefer the earlier window; wind and seas build.':trend==='wind and seas decrease'?'Conditions ease later; review the afternoon option.':'Weather fits this window; catch prospects follow the dated evidence.'):
    verdict==='dont_go'?(selectedRow?.morning.thunderstorm_forecast?'Thunderstorms are forecast in the available windows.':selectedRow?.morning.hazards?.length?'Marine alert: '+selectedRow.morning.hazards.join(', '):selectedRow?.morning.preference||'Conditions exceed your limits'):
    verdict==='go_conditions_only'?'Weather fits; no supported fishing method/species lead.':'Forecast or alert coverage is insufficient; reassess closer to the day.',
   prospect:!option?'unrated':option.bite_assessment==='slow'?'fair; latest reported bite was slow':option.basis.startsWith('current')?'promising reported activity':'fair; historical lead',
   tide_moon:tideMoonContext(report,date),tide_moon_note:option?.method==='bottom_fishing'?'Adjust sinker weight to the observed drift; keep bait near structure.':'Scout bait and water clarity before committing to a fishing spot.',
   evidence_ids:[selected?.forecast_id,...(option?.evidence_ids||[]),`tides_${date}`,`moon_${date}`].filter(Boolean)};
  return typeof withRoughSeas==='function'?withRoughSeas(report,day,config,null,usedQuips):day;
 });
}
function refreshDailyAfterAlerts(context,changed){
 const prior=context.report.daily_outlook||[],current=dailyOutlook(context.report,context.config),usedQuips=new Set();let replaced=false;
 context.report.daily_outlook=current.map(day=>{
  const old=prior.find(d=>d.date===day.date);
  const compatible=old&&old.verdict===day.verdict&&(day.verdict!=='go'||day.allowed_choices.some(c=>c.candidate_id===old.candidate_id&&c.point_id===old.point_id&&c.segment===old.window));
  const rows=context.report.forecast_table.filter(r=>r.date===day.date);
  const events=rows.flatMap(r=>[...r.morning.hazards,...r.afternoon.hazards]).join(' ').toLowerCase();
  const obsoleteAlert=['marine weather statement','small craft advisory','gale warning','hurricane warning'].some(event=>old?.reason?.toLowerCase().includes(event)&&!events.includes(event));
  if(!compatible||obsoleteAlert){replaced=true;return typeof withRoughSeas==='function'?withRoughSeas(context.report,day,context.config,old,usedQuips):day;}
  const option=day.verdict==='go'?fishingOptions(context.report,context.config).find(o=>o.candidate_id===old.candidate_id):null;
  const merged={...day,...old,option,tide_moon:day.tide_moon,allowed_choices:day.allowed_choices};
  return typeof withRoughSeas==='function'?withRoughSeas(context.report,merged,context.config,old,usedQuips):merged;
 });
 if(changed)context.report.recommendations=[];
 if(replaced&&changed)context.report.overview='Final marine alerts were rechecked. Use the updated daily decisions below; current catches take priority over clearly labeled historical alternatives.';
 context.report.outlook_mode=context.report.daily_outlook.some(d=>d.verdict==='go')?'conditional_outlook':context.report.outlook_mode;
 context.report.writer.final_alert_rechecked=true;
 return context;
}
if(typeof module!=='undefined')module.exports={fishingOptions,tideMoonContext,dailyOutlook,refreshDailyAfterAlerts};
