const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path'),{spawnSync}=require('node:child_process');
const core=require('../src/code-nodes/core');
test('Sydney calendar and unknown warnings remain local and cannot become GO',()=>{
 const config=structuredClone(require('../config/config.global.example.json'));
 core.validateConfig(config);
 const c=core.locationContext(core.normalizeRun({scheduled_for:'2026-11-18T19:00:00+11:00'},config,'2026-11-18T08:00:00Z'),config.locations[0]);
 c.collectors=core.syntheticCollectors(c);c.collectors.find(e=>e.source_id==='nws_alerts').status='failed';
 const r=core.factualReport(c);assert.equal(r.window.period_start,'2026-11-19');assert.equal(r.location_id,'sydney_au');assert(r.forecast_table.every(row=>row.day.preference.includes('alert status unavailable')));
});
test('a private build cannot overwrite public exports and compiles the configured timezone',()=>{
 const before=fs.readFileSync('workflows/20-location-report.json');
 const out=path.resolve('artifacts/private/portable-test');
 const result=spawnSync(process.execPath,['scripts/build-workflows.js'],{env:{...process.env,FISHING_CONFIG:'config/config.global.example.json',FISHING_OUTPUT_DIR:out},encoding:'utf8'});
 assert.equal(result.status,0,result.stderr);assert.deepEqual(fs.readFileSync('workflows/20-location-report.json'),before);
 for(const name of fs.readdirSync(path.join(out,'workflows'))){const w=JSON.parse(fs.readFileSync(path.join(out,'workflows',name)));assert.equal(w.settings.timezone,'Australia/Sydney');assert.equal(w.active,false);for(const n of w.nodes)if(n.type.endsWith('.code'))new vm.Script('(async function(){'+n.parameters.jsCode+'})');}
});
