const test=require('node:test'),assert=require('node:assert/strict'),fs=require('fs'),vm=require('vm');
const s={Date,Intl,console};vm.createContext(s);for(const name of ['core','evidence','community','rough-seas','outlook','news','research','updates','writer'])vm.runInContext(fs.readFileSync('src/code-nodes/'+name+'.js','utf8').replace(/if\(typeof module!==.*$/m,''),s);
const now='2026-11-12T02:00:00Z',window={period_start:'2026-11-12',period_end:'2026-11-17',dates:['2026-11-12','2026-11-17'],timezone:'America/New_York'};
test('four-week cutoff rejects stale current-year catches even when fetched or edited today',()=>{
 const e={published_at:'2026-10-13T12:00:00Z',fishing_date:'2026-10-13',retrieved_at:now,updated_at:now,kind:'first_hand_report',current_qualifying:true};
 assert.equal(s.evidenceRelevance(e,window,now),null);
 assert.equal(s.evidenceRelevance({...e,fishing_date:'2026-10-14'},window,now),'current trip');
 assert.equal(s.evidenceRelevance({...e,fishing_date:null,published_at:null},window,now),null);
 assert.equal(s.evidenceRelevance({...e,fishing_date:'2026-11-13'},window,now),null);
});
test('seasonal cutoff is 56 calendar days with year wrap, not broad month matching',()=>{
 const anchor={period_start:'2026-11-12',dates:['2026-11-12']};
 assert.equal(s.evidenceRelevance({fishing_date:'2025-09-17'},anchor,now),'seasonal history');
 assert.equal(s.evidenceRelevance({fishing_date:'2025-09-16'},anchor,now),null);
 assert.equal(s.evidenceRelevance({fishing_date:'2025-08-25'},anchor,now),null);
 assert.equal(s.evidenceRelevance({fishing_date:'2024-12-20'},{period_start:'2026-01-08'},'2026-01-07T22:00:00Z'),'seasonal history');
});
test('arbitrary publisher species and seasonal rating flow through without extending a species list',()=>{
 const base=require('../config/config.example.json'),c={run_id:'dynamic',location_id:'port_canaveral_fl',location:base.locations[0],source:base.sources.find(x=>x.id==='sealeveler_monthly')};
 const rows=s.extractEvidence({url:c.source.url,title:'Canaveral seasonal guide',text:'Bottom fishing offshore can offer silver examplefish.',scoped_location_id:c.location_id,species_catalog:['Silver examplefish'],seasonal_month:11,retrieved_at:now,seasonal_ratings:[{species:'Silver examplefish',month:11,rating:4,areas:['offshore'],scale:'publisher 0-5'}]},c,now);
 assert(rows.some(e=>e.species.includes('silver examplefish')));
 assert(rows.some(e=>e.species.includes('Silver examplefish')&&e.seasonal_rating===4));
 const report={window,collected_at:now,evidence:rows,location_id:c.location_id};
 assert(s.fishingOptions(report).some(o=>o.species==='silver examplefish'));
 assert(rows.every(e=>!e.current_qualifying));
});
test('stale history cannot supply options or be revived by an unspecified fresh catch',()=>{
 const old={evidence_id:'old',published_at:'2026-08-20T12:00:00Z',species:['king mackerel'],method:'trolling',habitat:'offshore',first_hand:true,kind:'first_hand_report',general_spots:[]};
 const fresh={...old,evidence_id:'fresh',fishing_date:'2026-11-10',published_at:now,method:'unspecified',current_qualifying:true};
 assert.equal(s.fishingOptions({window,collected_at:now,evidence:[old,fresh]}).length,0);
});
test('unknown trip date cannot hide a known old trip or become a fresh catch',()=>{
 const e={fishing_date:'2026-08-10',published_at:'2026-11-10T12:00:00Z',kind:'first_hand_report'};
 assert.equal(s.evidenceRelevance(e,window,now),null);
 assert.equal(s.evidenceRelevance({...e,fishing_date:null},window,now),'recent report; trip date uncertain');
});
test('monthly ratings expire by acquisition age and regional surf cannot become a boat option',()=>{
 assert.equal(s.evidenceRelevance({seasonal_month:11,kind:'seasonal_advice',retrieved_at:'2026-09-01T12:00:00Z'},window,now),null);
 assert.equal(s.fishingOptions({window,collected_at:now,evidence:[{fishing_date:'2026-11-10',kind:'first_hand_report',species:['a reported fish'],method:'nearshore_bait',habitat:'beach',regional_context_only:true}]}).length,0);
});
test('legacy source role cannot turn an expired current-year catch into seasonal guidance',()=>{
 const e={published_at:'2026-10-13T12:00:00Z',kind:'seasonal_advice',title:'Back out there',retrieved_at:now};
 assert.equal(s.evidenceRelevance(e,window,now),null);
 assert.equal(s.evidenceRelevance({...e,title:'November Fishing in Port Canaveral'},window,now),'seasonal history');
 assert.equal(s.evidenceRelevance({...e,title:'August Fishing in Port Canaveral'},window,now),null);
});
