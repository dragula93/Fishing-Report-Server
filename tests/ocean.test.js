const test=require('node:test');
const assert=require('node:assert/strict');
const core=require('../src/code-nodes/core');
const config=require('../config/config.example.json');

test('SST analysis time is distinct from download time',()=>{
 const r=core.renderOceanSection({status:'analysis_only',retrieved_at:'2026-11-12T02:00:00Z',sources:[{analysis_time:'2026-11-10T09:00:00Z'}],features:[],warnings:[]},'UTC');
 assert.match(r.html,/SST analysis Nov 10, 2026/);assert.match(r.html,/Downloaded Nov 12/);
});

test('feature remains off by default and old reports render safely',()=>{
 assert.equal(config.locations[0].ocean_features.enabled,false);
 const old={status:'disabled',features:null,sources:null,warnings:null};
 const out=core.renderOceanSection(old);
 assert.match(out.html,/Offshore water and temperature breaks/);
 assert.match(out.lines.join('\n'),/Ocean feature view disabled/);
});

test('available ocean summary embeds the ranked map and a compact waypoint table',()=>{
 const ocean={status:'ok',analysis_status:'ok',generated_at:'2026-11-06T12:00:00Z',retrieved_at:'2026-11-06T12:00:00Z',coverage:{observed_fraction:.55},sources:[],warnings:[],map:{relative_path:'artifacts/ocean/examples/synthetic-clear.png',sha256:'abc',mime_type:'image/png',artifact_base64:'c3ludGhldGlj'},features:[{feature_id:'synthetic-f1',kind:'temperature_break',locator:{latitude:28.4,longitude:-79.9},contrast_c:1.2,transect_width_km:4,confidence:{label:'moderate'},route_eligibility:{status:'oceanographic_context_only'},selection_reason:'Highest robust contrast in fixture.',waypoint_references:[{name:'KgGndS',wording:'about',initial_bearing_true_deg:91,displayed_bearing_true_deg:90,displayed_distance_nmi:5,compass_label:'E',role:'nearest'},{name:'BV-88',wording:'about',initial_bearing_true_deg:180,displayed_bearing_true_deg:180,displayed_distance_nmi:2,compass_label:'S',role:'secondary'}]}]};
 const rendered=core.renderOceanSection(ocean,'America/New_York');
 assert.match(rendered.html,/src="cid:ocean_map"/);assert.match(rendered.html,/Rank/);assert.match(rendered.html,/Locator \(lat, lon\)/);
 assert.match(rendered.html,/28\.4000°N, 79\.9000°W/);assert.match(rendered.html,/KgGndS/);assert.match(rendered.html,/5 nmi/);assert.match(rendered.html,/090°T/);assert.match(rendered.html,/BV-88/);assert.match(rendered.html,/2 nmi/);assert.match(rendered.html,/180°T/);
 assert.doesNotMatch(rendered.html,/Measured evidence|Supplied GPX references|Selection<\/th>/);
 assert.match(rendered.lines.join('\n'),/Inline SST map: numbered temperature-break candidates and GPX waypoint range\/bearing references/);
 assert.match(rendered.html,/Ranges and bearings are straight-line references/);assert.doesNotMatch(rendered.html,/c3ludGhldGlj/);
});

test('ranked table stays available without an embeddable map',()=>{
 const rendered=core.renderOceanSection({status:'analysis_only',analysis_status:'ok',features:[{kind:'temperature_break',locator:{latitude:1,longitude:2}}],map:{relative_path:'map.png',mime_type:'image/png',artifact_base64:'bad base64!'},coverage:{analysis_fraction:.8},sources:[],warnings:[]});
 assert.doesNotMatch(rendered.html,/cid:ocean_map/);assert.match(rendered.html,/Map unavailable/);assert.match(rendered.html,/<th[^>]*>Rank<\/th>/);assert.match(rendered.html,/1\.0000°N, 2\.0000°E/);
});

test('cloudy and analysis-only snapshots do not claim observed fronts or invent waypoint ranges',()=>{
 const cloudy=core.renderOceanSection({status:'partial',analysis_status:'partial',coverage:{observed_fraction:.08},features:[],warnings:['Cloud gaps prevent a domain-wide observed assessment.']});
 assert.match(cloudy.html,/Insufficient coverage/);assert.match(cloudy.html,/Cloud gaps/);assert.doesNotMatch(cloudy.html,/nmi of/);
 const analyzed=core.renderOceanSection({status:'analysis_only',analysis_status:'no_feature',coverage:{analysis_fraction:.82},features:[],sources:[],warnings:[]});
 assert.match(analyzed.html,/Analysis-only SST/);assert.match(analyzed.html,/No temperature breaks qualified in this analyzed SST/);assert.doesNotMatch(analyzed.html,/nmi of/);
});

test('renderer caps selected features at three and escapes GPX display labels',()=>{
 const features=Array.from({length:5},(_,i)=>({kind:'warm_tongue',locator:{latitude:28,longitude:-80},confidence:{label:'moderate'},selection_reason:'Fixture',waypoint_references:[{name:'<bad>',wording:'near',initial_bearing_true_deg:null}]}));
 const out=core.renderOceanSection({status:'ok',features,coverage:{observed_fraction:.4},sources:[],warnings:[]});
 assert.equal((out.lines.join('\n').match(/^\| \d \|/gm)||[]).length,3);assert.match(out.html,/&lt;bad&gt;/);
});
