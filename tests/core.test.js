const test=require('node:test');
const assert=require('node:assert/strict');
const core=require('../src/code-nodes/core');
const base=require('../config/config.example.json');
test('activation boundary prevents old automatic catch-up and missed notices but allows manual tests',()=>{
 const config={...structuredClone(base),schedule_activation_at:'2026-10-23T12:00:00Z'};
 for(const trigger of ['update_scheduled','reconcile']){const c=core.normalizeRun({trigger},config,'2026-10-23T13:00:00Z');assert.equal(c.catch_up_allowed,false);assert.equal(c.notice_due,false);}
 const manual=core.normalizeRun({trigger:'manual',scheduled_for:'2026-10-21T23:00:00Z'},config,'2026-10-23T13:00:00Z');assert(manual.catch_up_allowed);
 assert(core.normalizeRun({trigger:'scheduled'},config,'2026-10-28T23:00:00Z').catch_up_allowed);
});
test('activation compares Friday occurrence rather than Wednesday anchor and rejects malformed bounds',()=>{
 const config={...structuredClone(base),schedule_activation_at:'2026-10-22T12:00:00Z'};
 assert(core.normalizeRun({trigger:'update_scheduled'},config,'2026-10-23T11:00:00Z').catch_up_allowed);
 assert.throws(()=>core.normalizeRun({trigger:'scheduled'},{...config,schedule_activation_at:'invalid'},'2026-10-28T23:00:00Z'),/activation/);
});
function context(date='2026-09-30T23:00:00Z') {
 const config=structuredClone(base);
 return core.locationContext(core.normalizeRun({scheduled_for:date,use_fixtures:true},config,date),config.locations[0]);
}
test('Thursday–Tuesday dates and weekend',()=>{
 const w=core.reportWindow('2026-09-30T23:00:00Z','America/New_York');
 assert.equal(w.period_start,'2026-10-01');assert.equal(w.period_end,'2026-10-06');assert.deepEqual(w.weekend,['2026-10-03','2026-10-04']);
});
test('spring and fall DST windows use calendar days',()=>{
 const spring=core.reportWindow('2026-03-04T19:00:00-05:00','America/New_York');
 const fall=core.reportWindow('2026-10-28T19:00:00-04:00','America/New_York');
 assert.equal((Date.parse(spring.end_utc)-Date.parse(spring.start_utc))/3600000,143);
 assert.equal((Date.parse(fall.end_utc)-Date.parse(fall.start_utc))/3600000,145);
});
test('year boundary and delayed runs preserve original Wednesday',()=>{
 const c=context('2025-12-31T19:00:00-05:00');assert.equal(c.window.period_end,'2026-01-06');
 const r=core.normalizeRun({scheduled_for:'2026-09-30T23:00:00Z'},base,'2026-10-01T09:00:00Z');assert.equal(r.scheduled_for,'2026-09-30T23:00:00Z');assert.equal(r.delayed,true);
});
test('manual timestamp required and production gated',()=>{
 assert.throws(()=>core.normalizeRun({},base),/Manual replay/);
 assert.throws(()=>core.normalizeRun({mode:'production',scheduled_for:'2026-09-30T23:00:00Z'},base),/gated/);
});
test('forecast horizon never repeats final values',()=>{
 const c=context();c.collectors=core.syntheticCollectors(c);
 for(const grid of c.collectors.filter(x=>x.source_id.startsWith('grid_')))grid.records[0].fields.seas_ft[0].end=core.localInstant('2026-10-04',c.location.timezone);
 const rows=core.forecastTable(c);assert.equal(rows.length,12);
 assert.equal(rows.find(r=>r.date==='2026-10-06').day.seas_ft.min,null);
});
test('alert HTTP failure cannot become no advisories',()=>{
 const c=context();const alerts=core.normalizeAlerts(core.envelope(c,'nws_alerts',{statusCode:503,body:{}}));assert.equal(alerts.status,'failed');
 c.collectors=[alerts,...core.syntheticCollectors(c).filter(x=>x.source_id!=='nws_alerts')];
 assert.equal(core.forecastTable(c)[0].alert_status,'unavailable');
});
test('buoy missing values, UTC timestamp and unit conversion',()=>{
 const c=context();const b=core.normalizeBuoy({source_id:'buoy_41009',station:'41009',status:'ok',raw:'#YY MM DD hh mm WDIR WSPD GST WVHT DPD APD MWD PRES ATMP WTMP\n#units\n2026 09 30 23 00 90 5.0 6.0 MM 8.0 6.0 90 1010 25 26'},c,c.scheduled_for);
 assert.equal(b.records[0].seas_ft,null);assert.equal(b.records[0].wind_knots,9.72);assert.equal(b.records[0].observed_at,'2026-09-30T23:00:00.000Z');
});
test('n8n full text responses use the configured output property',()=>{
 const c=context();const e=core.envelope(c,'text_source',{statusCode:200,data:'sample text'},'text');assert.equal(e.raw,'sample text');
 const product=core.normalizeCoastalProduct({...e,raw:'FZUS52 KMLB 021335\nCWFMLB'},'2026-10-02T14:18:00Z');assert.equal(product.issued_at,'2026-10-02T13:35:00.000Z');
});
test('CO-OPS error and missing dates are explicit',()=>{
 const c=context();assert.equal(core.envelope(c,'noaa_tides',{error:{message:'Invalid station'}}).status,'failed');
 const t=core.normalizeTides({status:'ok',raw:{predictions:[]}},c);assert.equal(t.status,'empty');assert.equal(t.warnings.length,1);
});
test('stale forecast, failed astronomy and no marine data produce fallback',()=>{
 const c=context();c.collectors=[];const report=core.factualReport(c);assert.equal(report.outlook_mode,'data_unavailable');assert.equal(report.recommendations.length,0);
 const output=core.render(report);assert.match(output.text,/astronomy unavailable/);assert.match(output.text,/not yet available/);
});
test('HTML source strings are escaped',()=>{
 const c=context();c.collectors=core.syntheticCollectors(c);const report=core.factualReport(c);report.overview='<script>alert(1)</script>';const html=core.render(report).html;
 assert.ok(!html.includes('<script>'));assert.ok(html.includes('&lt;script&gt;'));
});
test('morning and afternoon wind/seas trends use forecast intervals',()=>{
 const c=context();c.collectors=core.syntheticCollectors(c);const fields=c.collectors[0].records[0].fields;
 const mid=core.localInstant(c.window.dates[0],c.location.timezone,12),end=core.localInstant(c.window.dates[0],c.location.timezone,18);
 for(const name of ['wind_knots','seas_ft'])fields[name]=[{start:c.window.start_utc,end:mid,value:1},{start:mid,end,value:3}];
 assert.equal(core.forecastTable(c)[0].trend,'wind and seas increase');
});
test('cross-location context uses isolated IDs and date windows',()=>{
 const a=context();const loc={...a.location,id:'synthetic_hawaii',timezone:'Pacific/Honolulu'};
 const b=core.locationContext(a,loc);assert.equal(b.location_id,'synthetic_hawaii');assert.notEqual(a.window.start_utc,b.window.start_utc);
});
