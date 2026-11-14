// Historical/synthetic fixtures and injected writer output; no HTTP/SMTP/LLM calls.
const fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const root=path.resolve(__dirname,'..');
function loadLibrary(){const s={Intl,Date,console};vm.createContext(s);for(const f of ['core','evidence','community','rough-seas','outlook','news','research','updates','writer','delivery'])vm.runInContext(fs.readFileSync(path.join(root,'src/code-nodes/'+f+'.js'),'utf8'),s);return s;}
function createExampleContext(s,now='2026-10-21T23:00:00Z',updateKind=null){
 const config=JSON.parse(fs.readFileSync(path.join(root,'config/config.example.json'),'utf8'));
 const c=s.locationContext(s.normalizeRun({scheduled_for:'2026-10-21T23:00:00Z',use_fixtures:true,update_kind:updateKind,mode:'dry_run'},config,now),config.locations[0]);
 c.collectors=s.syntheticCollectors(c);
 const historical=JSON.parse(fs.readFileSync(path.join(root,'tests/fixtures/historical-october-2026.json'),'utf8')).records.find(r=>r.period_start==='2026-10-22');
 for(const grid of c.collectors.filter(g=>g.source_id.startsWith('grid_'))){
  grid.issued_at=grid.retrieved_at=now;
  grid.records[0].fields.seas_ft=c.window.dates.flatMap((date,index)=>['morning','afternoon'].map(window=>{
   const recorded=historical.forecast_table.find(r=>r.date===date&&r.point_id===grid.point_id);
   const value=index===2?recorded[window].seas_ft.max:index===3&&grid.point_id==='offshore'&&window==='afternoon'?recorded.afternoon.seas_ft.max:2;
   return {start:s.localInstant(date,c.location.timezone,window==='morning'?6:12),end:s.localInstant(date,c.location.timezone,window==='morning'?12:18),value,unit:'feet'};
  }));
 }
 c.evidence=[{evidence_id:'synthetic_seasonal_lead',location_id:c.location_id,title:'Synthetic seasonal fishing lead',url:'https://spacefish.com/history/',species:['king mackerel'],method:'trolling',habitat:'nearshore',general_spots:['8A Reef'],age_days:365,age_label:'dated_background',published_at:'2025-10-21',kind:'seasonal_advice',route_distance_verified:false}];
 c.report=s.factualReport(c);c.report.title='HISTORICAL / SYNTHETIC EXAMPLE · October 22–27, 2026';
 c.report.overview='Historical October wave-height replay with hypothetical nearshore and calm-day alternatives. Not current conditions; writer text is injected for validation.';
 return c;
}
function injectedWriterResponse(s,c,alternate=false){
 c.writer_packet=s.writerPacket(c);
 const texts=alternate?["NO GO—leave the fish alone and keep the funeral director bored.","NO GO—stay dockside; an obituary is a lousy fishing report."]:["NO GO—unless a Coast Guard cameo is on your bucket list.","NO GO—the fish can keep their appointment; your obituary can wait."];
 let index=0;
 return {overview:[{sentence:'Review the separate marine forecast windows and dated fishing leads.',evidence_ids:[Object.keys(c.writer_packet.evidence)[0]]}],daily:c.writer_packet.daily_plans.map(p=>{
  const old=c.report.daily_outlook.find(d=>d.date===p.date),scope=p.rough_seas_scopes[0];
  return {date:p.date,verdict:p.verdict,candidate_id:p.candidate_id,window:p.window,point_id:p.point_id,reason:old.reason,tide_moon_note:'Adjust presentation to observed drift, bait and water clarity.',rough_seas_quip:scope?texts[index++%texts.length]:null,rough_seas_scope_id:scope?.scope_id||null,evidence_ids:[...new Set([...old.evidence_ids,...(scope?[scope.forecast_evidence_id]:[])])]};
 }),recommendations:[],limitations:[]};
}
function renderExamples(){
 const s=loadLibrary(),c=createExampleContext(s),result=injectedWriterResponse(s,c);
 s.applyWriter(c,{status:'ok',result});if(!c.writer_validation.valid)throw new Error(JSON.stringify(c.writer_validation));
 c.report.writer.backend='injected_test_writer';
 c.report.overview='Historical/synthetic example: a rough Saturday, a nearshore Sunday GO with an offshore afternoon stop, and a calm Monday. Not current conditions.';
 c.report.effective_subject=s.composeSubject(c.report,c.config);c.rendered=s.render(c.report);c.rendered.subject=c.report.effective_subject;
 const dir=path.join(root,'artifacts/private/step02-examples');fs.mkdirSync(dir,{recursive:true});
 fs.writeFileSync(path.join(dir,'full-six-day-report.html'),c.rendered.html);fs.writeFileSync(path.join(dir,'full-six-day-report.txt'),c.rendered.text);
 fs.writeFileSync(path.join(dir,'full-six-day-report.md'),c.rendered.markdown);fs.writeFileSync(path.join(dir,'context.json'),JSON.stringify(c,null,2));
 const excerptDates=c.window.dates.slice(2,5),copy=JSON.parse(JSON.stringify(c.report));copy.daily_outlook=copy.daily_outlook.filter(d=>excerptDates.includes(d.date));copy.title='Rough-seas examples · three-day excerpt';
 copy.overview='Three of six displayed dates from a historical/synthetic fixture. Not current conditions. No external writer or email call.';
 const excerpt=s.render(copy);fs.writeFileSync(path.join(dir,'rough-seas-examples.html'),excerpt.html);fs.writeFileSync(path.join(dir,'rough-seas-examples.txt'),excerpt.text);fs.writeFileSync(path.join(dir,'rough-seas-examples.md'),excerpt.markdown);
 const fallback=createExampleContext(s);fallback.writer_packet=s.writerPacket(fallback);s.applyWriter(fallback,{status:'failed',error:'Injected writer unavailable'});fs.writeFileSync(path.join(dir,'writer-unavailable-fallback.txt'),s.render(fallback.report).text);
 const friday=createExampleContext(s,'2026-10-23T11:00:00Z','friday_decisions');friday.baseline_report={report:c.report};s.applyWriter(friday,{status:'ok',result:injectedWriterResponse(s,friday,true)});if(!friday.writer_validation.valid)throw new Error(JSON.stringify(friday.writer_validation));
 friday.report.writer.backend='injected_test_writer';
 const comparison=s.compareDecisions(c.report,friday.report,friday.window);if(comparison.changed_dates.length)throw new Error('Joke-only change affected binary comparison');
 friday.report.effective_subject=s.composeSubject(friday.report,friday.config);friday.rendered=s.render(friday.report);friday.rendered.subject=friday.report.effective_subject;
 fs.writeFileSync(path.join(dir,'friday-context.json'),JSON.stringify(friday,null,2));fs.writeFileSync(path.join(dir,'joke-only-no-change.json'),JSON.stringify({warning:'ISOLATED SYNTHETIC COMPARISON; NOT CURRENT CONDITIONS',status:'no_change',...comparison,subscriber_sends:0},null,2));
 console.log('Wrote historical/synthetic step-02 examples; no network, writer or email call.');
}
if(require.main===module)renderExamples();
module.exports={loadLibrary,createExampleContext,injectedWriterResponse,renderExamples};
