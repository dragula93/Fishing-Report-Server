const test=require('node:test'),assert=require('node:assert/strict');
const acquisition=require('../workflows/55-ocean-acquisition.json'),location=require('../workflows/20-location-report.json');
const validate=new Function('$input','$',acquisition.nodes.find(n=>n.name==='Validate Ocean Refresh Outcome').parameters.jsCode);
const context=()=>({item:{json:{location_id:'port_canaveral_fl'}}});
test('a preserved old snapshot cannot masquerade as a successful refresh',()=>{
 assert.throws(()=>validate({first:()=>({json:{body:{location_id:'port_canaveral_fl',status:'analysis_only',acquisition_status:'failed',retrieved_at:'2026-11-08T15:22:27Z'}}})},context),/Invalid ocean refresh response/);
});
test('each newly collected report refreshes before reading the snapshot',()=>{
 assert.equal(location.connections['Attach Reaged Community Cache'].main[0][0].node,'Refresh Ocean Cache Before Report');
 assert.equal(location.connections['Refresh Ocean Cache Before Report'].main[0][0].node,'Read Cached Ocean Features');
 assert.equal(acquisition.settings.saveDataSuccessExecution,'all');
});
