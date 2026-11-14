'use strict';
const UPDATE_POLICY='sat-mon-binary-v1';
const BASELINE_POLICY='highest-edition-archived-nonfixture-accepted-same-period-v1';
function comparisonDates(window) {
 return [2,3,4].map(n=>{const d=new Date(window.period_start+'T12:00:00Z');d.setUTCDate(d.getUTCDate()+n);return d.toISOString().slice(0,10);});
}
function sameUpdateValue(a,b){const sort=x=>Array.isArray(x)?x.map(sort):x&&typeof x==='object'?Object.fromEntries(Object.keys(x).sort().map(k=>[k,sort(x[k])])):x;return JSON.stringify(sort(a))===JSON.stringify(sort(b));}
function copyIssuedJson(value){return JSON.parse(JSON.stringify(value));}
function decisionSnapshot(report,dates) {
 if(!Array.isArray(report?.daily_outlook))throw new Error('Missing daily decisions');
 return dates.map(date=>{
  const matches=report.daily_outlook.filter(d=>d?.date===date);
  if(matches.length!==1)throw new Error('Missing or duplicate decision: '+date);
  const d=matches[0],mapping={go:'GO',go_conditions_only:'GO',dont_go:'NO_GO',hold:'NO_GO'};
  const binary=typeof d.verdict==='string'&&Object.hasOwn(mapping,d.verdict)?mapping[d.verdict]:null;
  if(!binary||typeof d.reason!=='string'||!d.reason.trim())throw new Error('Invalid decision: '+date);
  return {date,raw_verdict:d.verdict,binary,reason:d.reason};
 });
}
function compareDecisions(baseline,candidate,window) {
 const dates=comparisonDates(window),before=decisionSnapshot(baseline,dates),after=decisionSnapshot(candidate,dates);
 return {policy_version:UPDATE_POLICY,before,after,changed_dates:dates.filter((d,i)=>before[i].binary!==after[i].binary)};
}
// Thursday is historical on Friday. Preserve the issued decision, facts and prose
// at every writer/final-alert boundary; never infer a new past-day HOLD.
function carryHistoricalThursday(context) {
 if(context.update_kind!=='friday_decisions')return context;
 const r=context.report,b=context.baseline_report?.report,date=context.window.period_start;
 const days=b?.daily_outlook?.filter(d=>d.date===date)||[];
 if(days.length!==1)throw new Error('Issued Thursday content missing or duplicated');
 r.daily_outlook=r.daily_outlook.map(d=>d.date===date?{...copyIssuedJson(days[0]),historical:true,refresh_note:'Previously issued; not refreshed'}:d);
 for(const key of ['forecast_table','astronomy'])r[key]=[...(r[key]||[]).filter(d=>d.date!==date),...(b[key]||[]).filter(d=>d.date===date).map(d=>({...copyIssuedJson(d),historical:true}))].sort((a,b)=>a.date.localeCompare(b.date));
 r.tides=[...(r.tides||[]).filter(t=>localDate(t.time_utc,r.window.timezone)!==date),...(b.tides||[]).filter(t=>localDate(t.time_utc,r.window.timezone)===date)];
 // Keep historical citations outside the fresh evidence/qualification packet.
 // Reusing their old current_qualifying label would undo Friday's re-aging.
 const ids=new Set(days[0].evidence_ids||[]);
 r.historical_evidence=(b.evidence||[]).filter(e=>ids.has(e.evidence_id)).map(copyIssuedJson);
 return context;
}
function updateSummary(report) {
 const u=report.update;
 if(u?.eligibility!=='changed')return [];
 const labels={go:'GO (go)',go_conditions_only:'GO — conditions only (go_conditions_only)',dont_go:"DON’T GO (dont_go)",hold:'Forecast incomplete (hold)'};
 return u.changed_dates.map(date=>{
  const a=u.before.find(d=>d.date===date),b=u.after.find(d=>d.date===date);
  return `${date}: ${labels[a.raw_verdict]} → ${labels[b.raw_verdict]}. ${b.reason}`;
 });
}
function composeSubject(report,config) {
 const base=config.email.report_subject;
 if(typeof base!=='string'||!base.trim()||base.length>200||/[\r\n]/.test(base))throw new Error('Invalid configured report subject');
 const start=report.window.period_start;
 const instant=Date.parse(start+'T12:00:00Z');
 if(!/^\d{4}-\d{2}-\d{2}$/.test(start||'')||!Number.isFinite(instant)||new Date(instant).toISOString().slice(0,10)!==start)throw new Error('Invalid report start date for subject');
 const [y,m,d]=start.split('-');
 const updated=report.update?.eligibility==='changed';
 return `${report.namespace==='test'?'[TEST] ':''}${report.fixture?'[FIXTURE] ':''}${updated?'UPDATED ':''}${base} ${m}-${d}-${y}`;
}
function validUpdateDelivery(loaded) {
 const {archive:a,evaluation:e}=loaded,u=a.report?.update;
 if(!u)return a.evidence_packet?.update_kind!=='friday_decisions';
 if(!e||!['ready','issued','delivery_failed','deferred'].includes(e.status)||u.eligibility!=='changed'||u.policy_version!==UPDATE_POLICY||u.baseline_policy!==BASELINE_POLICY)return false;
 if(e.evaluation_id!==u.evaluation_id||e.candidate_report_id!==a.report_id||u.candidate_report_id!==a.report_id||e.baseline_report_id!==u.baseline_report_id||e.namespace!==a.namespace||e.location_id!==a.location_id||e.period_start!==a.period_start||e.edition!==a.edition)return false;
 const c=e.comparison;
 if(!c||!sameUpdateValue(c,u))return false;
 try {
  const after=decisionSnapshot(a.report,comparisonDates(a.report.window));
  if(!sameUpdateValue(after,u.after))return false;
  const dates=comparisonDates(a.report.window),changed=dates.filter((d,i)=>u.before[i]?.date===d&&u.before[i].binary!==after[i].binary);
  return changed.length>0&&JSON.stringify(changed)===JSON.stringify(u.changed_dates);
 }catch{return false;}
}
if(typeof module!=='undefined')module.exports={UPDATE_POLICY,BASELINE_POLICY,comparisonDates,decisionSnapshot,compareDecisions,carryHistoricalThursday,updateSummary,composeSubject,validUpdateDelivery};
