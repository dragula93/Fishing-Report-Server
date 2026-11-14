const test=require('node:test'),assert=require('node:assert/strict');
const e=require('../src/code-nodes/evidence'),base=require('../config/config.example.json');
const ctx={run_id:'fixture',location_id:'port_canaveral_fl',location:base.locations[0],source:base.sources[0]};
const now='2026-10-02T14:00:00Z';
function doc(text,published='2026-10-01T12:00:00Z'){return {text,title:'Port Canaveral offshore report',url:'https://spacefish.com/report/',published_at:published,updated_at:'2026-10-02T12:00:00Z',retrieved_at:now};}
test('mixed articles retain ocean passages only',()=>{
 const rows=e.extractEvidence(doc('We caught kingfish trolling offshore yesterday. We caught redfish in the lagoon yesterday.'),ctx,now);assert.equal(rows.length,1);assert.equal(rows[0].fishing_date,'2026-09-30');assert.equal(rows[0].current_qualifying,true);
});
test('updated old publication never becomes current',()=>{
 const rows=e.extractEvidence(doc('We caught kingfish trolling offshore yesterday.','2024-10-01T12:00:00Z'),ctx,now);assert.equal(rows[0].age_label,'dated_background');assert.equal(rows[0].current_qualifying,false);
});
test('unknown trip and unknown publication dates remain unknown',()=>{
 const rows=e.extractEvidence(doc('Kingfish are offshore trolling options.'),ctx,now);assert.equal(rows[0].age_label,'published_context_trip_date_unknown');
 const unknown=e.extractEvidence(doc('We caught kingfish trolling offshore yesterday.',null),ctx,now);assert.equal(unknown[0].fishing_date,null);assert.equal(unknown[0].current_qualifying,false);
});
test('outside range, inshore-only and irrelevant location are excluded',()=>{
 assert.equal(e.extractEvidence(doc('We caught kingfish trolling offshore 60 nm out yesterday.'),ctx,now).length,0);
 assert.equal(e.extractEvidence(doc('We caught snapper in the river yesterday.'),ctx,now).length,0);
 assert.equal(e.extractEvidence({...doc('We caught kingfish trolling offshore yesterday.'),title:'Miami trip'}, {...ctx,source:base.sources[1]},now).length,0);
});
test('copies count once; exact route remains unverified',()=>{
 const rows=e.extractEvidence(doc('We caught kingfish trolling offshore 20 nm out yesterday.'),ctx,now);const copy={...rows[0],url:'https://canaveralkings.com/copy'};
 const result=e.deduplicateEvidence([...rows,copy]);assert.equal(result.length,1);assert.equal(result[0].independent_observation_count,1);assert.equal(result[0].route_distance_verified,false);
});
test('candidate links cannot escape allowed domain or enter query URLs',()=>{
 assert.equal(e.sourceUrlAllowed('http://192.168.1.1/report',ctx.source),false);
 assert.equal(e.sourceUrlAllowed('https://spacefish.com@127.0.0.1/report',ctx.source),false);
 assert.equal(e.sourceUrlAllowed('https://spacefish.com/report?redirect=private',ctx.source),false);
 assert.equal(e.articleCandidates({links:[{url:'https://spacefish.com/report/',title:'Canaveral offshore fishing report'},{url:'https://evil.example/report',title:'Offshore report'}]},ctx.source).length,1);
});
test('same-day trip remains current and one author/trip counts as one observation',()=>{
 const rows=e.extractEvidence(doc('We caught kingfish trolling offshore on 2026-10-02. We landed mahi trolling offshore on 2026-10-02.'),ctx,'2026-10-02T04:30:00Z');assert.equal(rows.length,2);assert(rows.every(r=>r.current_qualifying));assert.equal(rows[0].observation_id,rows[1].observation_id);
});
test('Canaveral listing provenance permits dated local cards without unrelated sidebar geography',()=>{const card={...doc('We had a slow pick of kingfish and cobia yesterday. 8A and Pelican produced fish.'),title:'Back Out there',published_at:'2026-09-28T12:00:00-04:00',scoped_location_id:'port_canaveral_fl'};const rows=e.extractEvidence(card,ctx,now);assert.equal(rows[0].fishing_date,'2026-09-27');assert(rows[0].current_qualifying);assert(rows[0].general_spots.includes('8A Reef'));assert.equal(e.extractEvidence({...card,scoped_location_id:null},ctx,now).length,0);});
test('archived current labels expire and history cannot mix locations or disabled sources',()=>{const fresh=e.extractEvidence(doc('We caught kingfish trolling offshore yesterday.'),ctx,now)[0];const full={...ctx,config:base};const rows=e.refreshEvidenceHistory([fresh,{...fresh,location_id:'elsewhere'}],full,'2026-11-01T12:00:00Z');assert.equal(rows.length,1);assert(!rows[0].current_qualifying);assert.notEqual(rows[0].evidence_id,fresh.evidence_id);});

test('RSS duplicates retain Canaveral listing scope and original publication date',()=>{const url='https://spacefish.com/byte/back-out-there/';const links=[{url,title:'Back Out there'},{url,title:'Back Out there',scoped_location_id:'port_canaveral_fl',published_at:'2026-09-28T12:00:00-04:00'}];const rows=e.articleCandidates({links},ctx.source,10,now);assert.equal(rows.length,1);assert.equal(rows[0].scoped_location_id,'port_canaveral_fl');assert.equal(rows[0].published_at,'2026-09-28T12:00:00-04:00');});

test('a broad paragraph listing kingfish and bottom patterns does not establish bottom kingfish',()=>{const rows=e.extractEvidence(doc('Early fall kingfish movement, nearshore bait activity, and reef or wreck bottom fishing can all be part of the picture.'),ctx,now);assert.equal(rows[0].method,'unspecified');});
