const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const root=path.resolve(__dirname,'..');
const configPath=path.resolve(root,process.env.FISHING_CONFIG||'config/config.example.json');
const outputRoot=process.env.FISHING_OUTPUT_DIR?path.resolve(root,process.env.FISHING_OUTPUT_DIR):root;
if(configPath!==path.join(root,'config/config.example.json')&&!outputRoot.startsWith(path.join(root,'artifacts','private')+path.sep))throw Error('Custom build output must be under artifacts/private/');
if(configPath!==path.join(root,'config/config.example.json')&&!process.env.FISHING_OUTPUT_DIR)throw Error('Custom config requires FISHING_OUTPUT_DIR=artifacts/private/build');
fs.mkdirSync(path.join(outputRoot,'workflows'),{recursive:true});
let stableId=0;const uuid=()=>{const h=crypto.createHash('sha256').update('fishing-report-'+(++stableId)).digest('hex');return h.slice(0,8)+'-'+h.slice(8,12)+'-'+h.slice(12,16)+'-'+h.slice(16,20)+'-'+h.slice(20,32);};
const config=JSON.parse(fs.readFileSync(configPath,'utf8'));
 const core=['core','evidence','community','rough-seas','outlook','news','research','updates','writer','delivery'].map(name=>fs.readFileSync(path.join(root,'src/code-nodes/'+name+'.js'),'utf8').replace(/if\(typeof module!==.*$/m,'')).join('\n');
require(path.join(root,'src/code-nodes/core.js')).validateConfig(config);
const versions={manualTrigger:1,scheduleTrigger:1.4,code:2,postgres:2.7,httpRequest:4.5,if:2.3,executeWorkflow:1.4,executeWorkflowTrigger:1.2,stickyNote:1,errorTrigger:1,emailSend:2.1,splitInBatches:3,wait:1.1,rssFeedRead:1.2};
class Workflow {
 constructor(name,id){this.data={id,name,active:false,nodes:[],connections:{},settings:{executionOrder:'v1',timezone:config.schedule.timezone,saveDataSuccessExecution:'none',saveDataErrorExecution:'all'},pinData:{}};}
 node(name,type,parameters={},extra={}){const n={id:uuid(),name,type:'n8n-nodes-base.'+type,typeVersion:versions[type],parameters,position:[this.data.nodes.length*260,300],...extra};this.data.nodes.push(n);return name;}
 code(name,body){return this.node(name,'code',{mode:'runOnceForAllItems',jsCode:core+'\n'+body});}
 pg(name,query,params='={{ [JSON.stringify($json)] }}'){return this.node(name,'postgres',{operation:'executeQuery',query,options:{queryReplacement:params,queryBatching:'independently'}});}
 http(name,url,format='json',method='GET',body=null){const p={url,method,sendHeaders:true,headerParameters:{parameters:[{name:'User-Agent',value:'FishingReport/1.0'},{name:'Accept',value:format==='json'?'application/json':'text/plain'}]},options:{timeout:25000,redirect:{redirect:{followRedirects:false}},response:{response:{fullResponse:true,neverError:true,responseFormat:format}}}};
  if(body!==null)Object.assign(p,{sendBody:true,specifyBody:'json',jsonBody:body});
  return this.node(name,'httpRequest',p,{onError:'continueRegularOutput',retryOnFail:true,maxTries:2,waitBetweenTries:2000});}
 iff(name,expression){return this.node(name,'if',{conditions:{options:{caseSensitive:true,leftValue:'',typeValidation:'strict',version:2},conditions:[{id:uuid(),leftValue:expression,rightValue:true,operator:{type:'boolean',operation:'true',singleValue:true}}],combinator:'and'},options:{}});}
 child(name,id){return this.node(name,'executeWorkflow',{source:'database',workflowId:{__rl:true,value:id,mode:'list'},mode:'once',options:{waitForSubWorkflow:true}});}
 link(from,to,index=0){const c=this.data.connections[from]??={main:[]};while(c.main.length<=index)c.main.push([]);c.main[index].push({node:to,type:'main',index:0});}
 chain(...nodes){for(let i=1;i<nodes.length;i++)this.link(nodes[i-1],nodes[i]);}
 note(content){this.node('Setup and phase notes','stickyNote',{content,height:220,width:620},{position:[0,-20]});}
 save(filename){this.filename=filename;return this.data;}
}
const setup=new Workflow('Fishing Report — Setup','fishing_setup_v1');
setup.node('Manual Setup','manualTrigger');
setup.code('Validate Example Configuration',`const config=${JSON.stringify(config)};validateConfig(config);return [{json:{config}}];`);
setup.pg('Verify Migration and Seed Configuration',`SELECT version FROM schema_migrations WHERE version=1;
INSERT INTO configuration(key,value) VALUES('main',$1::jsonb) ON CONFLICT DO NOTHING;
-- Subscriber settings are applied separately by scripts/configure.py. Exports do not seed real recipients.
SELECT value AS config FROM configuration WHERE key='main';`,'={{ [JSON.stringify($json.config)] }}');
setup.code('Setup Checklist',`const c=$input.all().map(x=>x.json).find(x=>x.config)?.config;invariant(c,'Migration/configuration not found');validateConfig(c);return [{json:{status:'setup_validated',mode:c.execution.mode,configuration_ready:c.configuration_ready,checklist:['Bind application database credentials','Keep scheduler inactive','Set explicit Wednesday replay timestamp','Run fixtures then live dry-run','Configure ChatGPT writer and private Gmail credentials before production']}}];`);
setup.chain('Manual Setup','Validate Example Configuration','Verify Migration and Seed Configuration','Setup Checklist');
setup.note('PHASE 1 — actual deterministic briefing. Bind Fishing Report - Database to the Postgres node. Migrations must already exist. Rerunning setup does not replace owner configuration. No SMTP or LLM calls occur.');setup.save('00-setup.json');

const loc=new Workflow('Fishing Report — Location Report','fishing_location_v1');
loc.node('Location Input','executeWorkflowTrigger',{inputSource:'passthrough'});
loc.code('Validate Location and Window',`const c=$input.first().json;validateConfig(c.config);const context=locationContext(c,c.location);context.execution_id=$execution.id;invariant(context.edition>0,'Edition must be positive');return [{json:context}];`);
loc.pg('Atomically Claim Location Period','SELECT claim_run($1::jsonb) AS context;');
loc.code('Unwrap Run Claim','return [{json:$input.first().json.context}];');
loc.iff('Run Claim Acquired?','={{ $json.claimed }}');
loc.code('Duplicate Run Outcome','const c=$input.first().json;return [{json:{schema_version:c.schema_version,run_id:c.run_id,location_id:c.location_id,scheduled_for:c.scheduled_for,mode:c.mode,outcome:"duplicate_skipped"}}];');
loc.iff('Synthetic Fixture?','={{ $json.use_fixtures }}');
loc.code('Load Synthetic Marine Fixtures','const c=$input.first().json;c.collectors=syntheticCollectors(c);return [{json:c}];');
let previous='Synthetic Fixture?';
function collect(name,url,id,normalize,kind='json',extras=''){
 const before=previous;
 const contextRef=before==='Synthetic Fixture?'?'Unwrap Run Claim':before;
 const request=loc.http(name,url,kind);
 const normalizeName='Normalize '+name;
 const actualUrl=id==='nws_alerts'?`'https://api.weather.gov/alerts/active?zone='+c.location.marine_zones.join(',')`:id==='buoy_41009'?`'https://www.ndbc.noaa.gov/data/realtime2/'+c.location.buoy_stations[0]+'.txt'`:id==='noaa_tides'?`'https://api.tidesandcurrents.noaa.gov/api/prod/datagetter?product=predictions&station='+c.location.tide_station+'&datum=MLLW&interval=hilo&units=english&time_zone=gmt&format=json&begin_date='+c.window.start_utc.slice(0,10).replaceAll('-','')+'&end_date='+c.window.end_utc.slice(0,10).replaceAll('-','')+'&application=FishingReport'`:JSON.stringify(url);
 loc.code(normalizeName,`const c=$('${contextRef}').first().json;let e=envelope(c,'${id}',$input.first().json,'${kind}',${actualUrl});${extras}e=${normalize};c.collectors.push(e);return [{json:c}];`);
 loc.link(before,request,before==='Synthetic Fixture?'?1:0);loc.link(request,normalizeName);previous=normalizeName;
}
collect('Marine Alerts','={{ "https://api.weather.gov/alerts/active?zone="+$json.location.marine_zones.join(",") }}','nws_alerts','normalizeAlerts(e)');
collect('Coastal Waters Product','={{ $json.location.marine_product_url }}','nws_cwf','normalizeCoastalProduct(e)','text');
// Point discovery is repeated at runtime instead of treating grid coordinates as permanent.
for(let i=0;i<Math.max(2,...config.locations.filter(l=>l.marine_provider!=='open_meteo').map(l=>l.forecast_points.length));i++){
 const before=previous,pointName=`Discover Marine Point ${i+1}`,pointCtx=`Keep Marine Point ${i+1}`;
 loc.http(pointName,`={{ "https://api.weather.gov/points/"+$json.location.forecast_points[${i}].latitude+","+$json.location.forecast_points[${i}].longitude }}`);
 loc.code(pointCtx,`const c=$('${before}').first().json;const response=$input.first().json;const body=response.body??response;const p=c.location.forecast_points[${i}];const url=body.properties?.forecastGridData;c.grid_point={...p,grid_url:typeof url==='string'&&url.startsWith('https://api.weather.gov/gridpoints/')?url:'https://api.weather.gov/invalid-marine-point'};if(!url)c.warnings.push('Marine point discovery failed: '+p.id);return [{json:c}];`);
 loc.chain(before,pointName,pointCtx);previous=pointCtx;
 collect(`Grid Forecast ${i+1}`,'={{ $json.grid_point.grid_url }}',`grid_${i===0?'nearshore':'offshore'}`,'normalizeGrid(e,c)','json','e.point_id=c.grid_point.id;e.zone=c.grid_point.zone;e.url=c.grid_point.grid_url;');
}
collect('Offshore Buoy','={{ "https://www.ndbc.noaa.gov/data/realtime2/"+$json.location.buoy_stations[0]+".txt" }}','buoy_41009','normalizeBuoy(e,c)','text','e.station=c.location.buoy_stations[0];');
collect('Water Temperature Buoy','={{ "https://www.ndbc.noaa.gov/data/realtime2/"+($json.location.temperature_buoy_station||$json.location.buoy_stations[0])+".txt" }}','buoy_temperature','normalizeBuoy(e,c)','text','e.station=c.location.temperature_buoy_station||c.location.buoy_stations[0];e.url="https://www.ndbc.noaa.gov/data/realtime2/"+e.station+".txt";');
collect('NOAA Tide Predictions','={{ "https://api.tidesandcurrents.noaa.gov/api/prod/datagetter?product=predictions&station="+$json.location.tide_station+"&datum=MLLW&interval=hilo&units=english&time_zone=gmt&format=json&begin_date="+addDaysPlaceholder }}','noaa_tides','normalizeTides(e,c)');
// Expressions cannot call embedded functions. Construct a padded GMT query in a Code node.
const tideRequest=loc.data.nodes.find(n=>n.name==='NOAA Tide Predictions');
tideRequest.parameters.url='={{ "https://api.tidesandcurrents.noaa.gov/api/prod/datagetter?product=predictions&station="+$json.location.tide_station+"&datum=MLLW&interval=hilo&units=english&time_zone=gmt&format=json&begin_date="+$json.window.start_utc.slice(0,10).replaceAll("-","")+"&end_date="+$json.window.end_utc.slice(0,10).replaceAll("-","")+"&application=FishingReport" }}';
const lastMarine=previous;
loc.http('Compute Astronomy','http://helper:8080/astronomy','json','POST','={{ JSON.stringify({latitude:$json.location.astronomy_point.latitude,longitude:$json.location.astronomy_point.longitude,timezone:$json.location.timezone,dates:$json.window.dates}) }}');
loc.code('Normalize Astronomy',`const c=$('${lastMarine}').first().json;const response=$input.first().json;let e=envelope(c,'skyfield_de421',response);const body=response.body??response;if(e.status!=='failed'){e={...e,...body,location_id:c.location_id};if(!Array.isArray(e.records))e={...e,status:'failed',records:[],error:'Invalid astronomy contract'};}c.collectors.push(e);return [{json:c}];`);
loc.chain(lastMarine,'Compute Astronomy','Normalize Astronomy');
loc.link('Load Synthetic Marine Fixtures','Compute Astronomy');
// Both paths carry one location context. No positional array merge is used.
const astroCode=loc.data.nodes.find(n=>n.name==='Normalize Astronomy');
astroCode.parameters.jsCode=core+`\nconst c=$('Unwrap Run Claim').first().json.use_fixtures?$('Load Synthetic Marine Fixtures').first().json:$('${lastMarine}').first().json;const response=$input.first().json;let e=envelope(c,'skyfield_de421',response);const body=response.body??response;if(e.status!=='failed'){e={...e,...body,location_id:c.location_id};if(!Array.isArray(e.records))e={...e,status:'failed',records:[],error:'Invalid astronomy contract'};}c.collectors.push(e);return [{json:c}];`;
loc.code('Validate and Render Factual Briefing',`const c=$input.first().json;c.report=factualReport(c);c.report.warnings.push(...c.warnings);c.rendered=render(c.report);invariant(c.report.window.dates.length===6,'Expected six dates');invariant(c.report.location_id===c.location_id,'Mixed location report');return [{json:c}];`);
loc.pg('Archive Immutable Report','SELECT archive_report($1::jsonb) AS context;');
loc.code('Unwrap Archived Report','return [{json:$input.first().json.context}];');
loc.pg('Finish Factual Run',`UPDATE runs SET status='complete',finished_at=now(),lease_owner=NULL,lease_until=NULL WHERE run_id=$1 AND lease_owner=$2;
SELECT $3::jsonb AS result;`,'={{ [$json.db_run_id,$json.run_id,JSON.stringify({schema_version:$json.schema_version,run_id:$json.run_id,location_id:$json.location_id,scheduled_for:$json.scheduled_for,mode:$json.mode,report_id:$json.report_id,outcome:"complete",outlook_mode:$json.report.outlook_mode,fixture:$json.use_fixtures})] }}');
loc.code('Compact Location Outcome','const result=$input.all().map(x=>x.json).find(x=>x.result)?.result;invariant(result,"Missing run result");return [{json:result}];');
loc.chain('Location Input','Validate Location and Window','Atomically Claim Location Period','Unwrap Run Claim','Run Claim Acquired?');loc.link('Run Claim Acquired?','Synthetic Fixture?',0);loc.link('Run Claim Acquired?','Duplicate Run Outcome',1);loc.link('Synthetic Fixture?','Load Synthetic Marine Fixtures',0);
loc.http('Read Cached Ocean Features','={{ "http://helper:8080/ocean-features/"+$json.location_id }}');
const oceanRead=loc.data.nodes.find(n=>n.name==='Read Cached Ocean Features');oceanRead.parameters.options.timeout=5000;oceanRead.retryOnFail=false;
loc.code('Normalize Optional Ocean Features',`const c=$('Attach Reaged Community Cache').first().json,r=$input.first().json,b=r.body??r;const allowed=['disabled','ok','partial','analysis_only','stale','unavailable'];let ocean=(!r.error&&allowed.includes(b.status)&&b.location_id===c.location_id)?b:null;if(!ocean)ocean={schema_version:'1.0',location_id:c.location_id,status:c.location.ocean_features?.enabled?'unavailable':'disabled',acquisition_status:'unavailable',analysis_status:'not_run',features:[],sources:[],warnings:['Ocean feature cache unavailable; report continued.']};if($('Refresh Ocean Cache Before Report').first().json.error){ocean.acquisition_status='failed';ocean.warnings=[...(ocean.warnings||[]),'Latest SST refresh failed; prior snapshot retained.'];}c.ocean_features=ocean;return [{json:c}];`);
loc.chain('Validate and Render Factual Briefing','Archive Immutable Report','Unwrap Archived Report','Finish Factual Run','Compact Location Outcome');
loc.note('PHASE 1 — complete factual collector/archive. Bind each Postgres node to Fishing Report - Database. Marine point discovery is runtime. Failures become envelopes. Fixtures are visibly synthetic. No delivery or writer path exists yet; this baseline only archives reports.');loc.save('20-location-report.json');

const scheduler=new Workflow('Fishing Report — Weekly Scheduler','fishing_scheduler_v1');
scheduler.node('Manual Replay','manualTrigger');
scheduler.code('Manual Replay Settings',`return [{json:{trigger:'manual',mode:'dry_run',scheduled_for:'2026-09-30T23:00:00Z',edition:1,use_fixtures:true}}];`);
scheduler.node('Wednesday 19:00','scheduleTrigger',{rule:{interval:[{field:'weeks',weeksInterval:1,triggerAtDay:[3],triggerAtHour:config.schedule.hour,triggerAtMinute:config.schedule.minute}]}});
scheduler.code('Weekly Trigger Settings',`return [{json:{trigger:'scheduled',use_fixtures:false}}];`);
scheduler.node('Hourly Catch-up','scheduleTrigger',{rule:{interval:[{field:'cronExpression',expression:'15 * * * *'}]}});
scheduler.code('Catch-up Trigger Settings',`return [{json:{trigger:'reconcile',use_fixtures:false}}];`);
scheduler.pg('Load Owner Configuration',"SELECT value AS config,$1::jsonb AS input FROM configuration WHERE key='main';");
scheduler.code('Normalize Scheduled Run',`const {config,input}=$input.first().json;const c=normalizeRun(input,config);return [{json:c}];`);
scheduler.iff('Within Catch-up Window?','={{ $json.catch_up_allowed }}');
scheduler.code('Catch-up Outside Window',`const c=$input.first().json;return [{json:{run_id:c.run_id,scheduled_for:c.scheduled_for,mode:c.mode,status:'outside_catch_up_window',delay_hours:c.delay_hours}}];`);
scheduler.code('Enabled Location Items',`const c=$input.first().json;const locs=c.config.locations.filter(l=>l.enabled);if(!locs.length)return [{json:{...c,location:null,no_locations:true}}];return locs.map(l=>({json:{...c,location:l,location_id:l.id,no_locations:false}}));`);
scheduler.node('Loop Locations','splitInBatches',{batchSize:1,options:{}});
scheduler.iff('Location Available?','={{ !$json.no_locations }}');
scheduler.child('Run Location Report','fishing_location_v1');
scheduler.data.nodes.find(n=>n.name==='Run Location Report').onError='continueRegularOutput';
scheduler.code('Record Location Outcome',`const item=$input.first().json;if(item.error){const original=$('Loop Locations').first(1).json;return [{json:{schema_version:original.schema_version,run_id:original.run_id,location_id:original.location_id,scheduled_for:original.scheduled_for,mode:original.mode,outcome:'failed',error:item.error.message||String(item.error)}}];}return [{json:item}];`);
scheduler.code('No Enabled Locations',`return [{json:{...$input.first().json,outcome:'no_enabled_locations'}}];`);
scheduler.code('Summarize Scheduler Run',`const outcomes=$input.all().map(i=>i.json);const c=$('Normalize Scheduled Run').first().json;return [{json:{run_id:c.run_id,scheduled_for:c.scheduled_for,mode:c.mode,status:outcomes.some(o=>['failed','partial'].includes(o.outcome))?'partial':'complete',outcomes}}];`);
scheduler.pg('Persist Scheduler Summary',`INSERT INTO scheduler_runs(run_id,scheduled_for,mode,status,summary) VALUES($1,$2,$3,$4,$5::jsonb) ON CONFLICT DO NOTHING; SELECT $5::jsonb AS summary;`,'={{ [$json.run_id,$json.scheduled_for,$json.mode,$json.status,JSON.stringify($json)] }}');
scheduler.chain('Manual Replay','Manual Replay Settings','Load Owner Configuration','Normalize Scheduled Run','Within Catch-up Window?');scheduler.chain('Wednesday 19:00','Weekly Trigger Settings','Load Owner Configuration');scheduler.chain('Hourly Catch-up','Catch-up Trigger Settings','Load Owner Configuration');scheduler.link('Within Catch-up Window?','Enabled Location Items',0);scheduler.link('Within Catch-up Window?','Catch-up Outside Window',1);
scheduler.chain('Enabled Location Items','Loop Locations');scheduler.link('Loop Locations','Summarize Scheduler Run',0);scheduler.link('Loop Locations','Location Available?',1);scheduler.link('Location Available?','Run Location Report',0);scheduler.link('Location Available?','No Enabled Locations',1);scheduler.chain('Run Location Report','Record Location Outcome','Loop Locations');scheduler.link('No Enabled Locations','Loop Locations');scheduler.chain('Summarize Scheduler Run','Persist Scheduler Summary');
scheduler.note('Keep INACTIVE. Manual Replay Settings uses an explicit Wednesday and visibly marked synthetic fixtures. Change use_fixtures=false and timestamp for a live dry-run. Bind Postgres nodes and select Location Report on Run Location Report. Catch-up uses the same atomic run claim. Production is blocked until configuration_ready=true.');scheduler.save('10-weekly-scheduler.json');

const manifest={bundle_version:'0.1.0-phase1',schema_version:'1.0',n8n_version:'2.41.6',postgres_version:'17.11',node_versions:versions,
 astronomy:{library:'skyfield',version:'1.55',ephemeris:'de421',sha256:'a20a7139da04cbc462454634918e9a9ca69127044e2cc9d4f9c16e238d2deedc'},
 workflows:{'00-setup.json':setup.data.name,'20-location-report.json':loc.data.name,'10-weekly-scheduler.json':scheduler.data.name},
    phase:'1',implemented:['setup','weekly/catch-up schedule graph','marine collectors','tides','astronomy','immutable archive','atomic run claims','factual rendering'],pending:['fishing evidence qualification','writer','target rules','email delivery','failure handler','fresh-instance final bundle reimport']};
fs.writeFileSync(path.join(outputRoot,'manifest.json'),JSON.stringify(manifest,null,2)+'\n');
console.log('Built 3 inactive Phase 1 workflows with real embedded functions.');

// Phase 2 collector is a real reusable sub-workflow; the helper only parses and calculates.
const sourceW=new Workflow('Fishing Report — Fishing Source Evidence','fishing_source_v1');
sourceW.node('Source Input','executeWorkflowTrigger',{inputSource:'passthrough'});
sourceW.code('Validate Approved Source',`const c=$input.first().json;invariant(c.schema_version==='1.0'&&c.run_id&&c.location_id&&c.source,'Invalid source contract');invariant(sourceUrlAllowed(c.source.url,c.source),'Unapproved source URL');return [{json:c}];`);
sourceW.http('Fetch Robots Policy','={{ "https://"+$json.source.domain+"/robots.txt" }}','text');
sourceW.code('Keep Robots Response',`const c=$('Validate Approved Source').first().json;const r=$input.first().json;return [{json:{...c,robots_text:r.body??r.data??'',robots_status:r.statusCode??0}}];`);
sourceW.http('Evaluate Publisher Policy','http://helper:8080/robots','json','POST','={{ JSON.stringify({url:$json.source.url,text:$json.robots_text,http_status:$json.robots_status}) }}');
sourceW.code('Publisher Access Decision',`const c=$('Keep Robots Response').first().json;const r=$input.first().json;const body=r.body??r;return [{json:{...c,policy:{allowed:body.allowed===true,delay_seconds:body.delay_seconds??3,warning:body.warning??r.error??null}}}];`);
sourceW.iff('Publisher Allows Fetch?','={{ $json.policy.allowed }}');
sourceW.code('Disabled Source Envelope',`const c=$input.first().json;return [{json:{schema_version:c.schema_version,run_id:c.run_id,location_id:c.location_id,scheduled_for:c.scheduled_for,mode:c.mode,source_id:c.source.id,status:'failed',retrieved_at:new Date().toISOString(),issued_at:null,records:[],warnings:['Publisher access unavailable or disallowed'],error:c.policy.warning||'Robots disallows collection',url:c.source.url}}];`);
sourceW.node('Listing Crawl Delay','wait',{resume:'timeInterval',amount:'={{ $json.policy.delay_seconds }}',unit:'seconds'});
sourceW.http('Fetch Source Listing','={{ $json.source.url }}','text');
sourceW.code('Keep Listing HTML',`const c=$('Publisher Access Decision').first().json;const r=$input.first().json;const e=envelope(c,c.source.id,r,'text',c.source.url);return [{json:{...c,listing_envelope:e,listing_html:typeof e.raw==='string'?e.raw:''}}];`);
sourceW.http('Discover Article Links','http://helper:8080/extract','json','POST','={{ JSON.stringify({url:$json.source.url,html:$json.listing_html,robots:$json.robots_text}) }}');
sourceW.code('Prepare Bounded Article Items',`const c=$('Keep Listing HTML').first().json;const r=$input.first().json;const body=r.body??r;const discoveryFailed=!!r.error||body.status==='failed'||r.statusCode>=400;const links=discoveryFailed||body.seasonal_month||c.source.id==='spacefish_surf'?[]:articleCandidates(body,c.source,Number(c.window.period_start.slice(5,7)));const common={...c,discovery_failed:discoveryFailed,discovered_feeds:body.feeds||[]};if(!links.length)return [{json:{...common,document:{url:c.source.url,skip:true,reason:c.listing_envelope.status==='failed'?'Listing fetch failed':discoveryFailed?'Discovery extraction failed':'No permitted article links discovered'}}}];return links.map(link=>({json:{...common,document:{...link,skip:false}}}));`);
sourceW.node('Loop Articles','splitInBatches',{batchSize:1,options:{}});
sourceW.iff('Article Available?','={{ !$json.document.skip }}');
sourceW.node('Article Crawl Delay','wait',{resume:'timeInterval',amount:'={{ $json.policy.delay_seconds }}',unit:'seconds'});
sourceW.http('Fetch Permitted Article','={{ $json.document.url }}','text');
sourceW.code('Keep Article HTML',`const c=$('Loop Articles').first(1).json;const r=$input.first().json;const e=envelope(c,c.source.id,r,'text',c.document.url);return [{json:{...c,article_envelope:e,article_html:typeof e.raw==='string'?e.raw:''}}];`);
sourceW.http('Extract Article and Dates','http://helper:8080/extract','json','POST','={{ JSON.stringify({url:$json.document.url,html:$json.article_html}) }}');
sourceW.code('Filter Article Evidence',`const c=$('Keep Article HTML').first().json;const r=$input.first().json;const body=r.body??r;const doc={url:c.document.url,title:body.metadata?.title||c.document.title,species_catalog:body.species_catalog||[],seasonal_month:body.seasonal_month||null,seasonal_ratings:body.seasonal_ratings||[],author:body.metadata?.author||null,published_at:c.document.published_at||body.metadata?.published_at||null,updated_at:body.metadata?.updated_at||null,scoped_location_id:c.document.scoped_location_id||null,retrieved_at:c.article_envelope.retrieved_at,text:body.text||''};const extractionFailed=!!r.error||body.status==='failed'||r.statusCode>=400;const records=extractionFailed?[]:extractEvidence(doc,c);return [{json:{run_id:c.run_id,location_id:c.location_id,source_id:c.source.id,status:c.article_envelope.status==='failed'||extractionFailed?'failed':'ok',records,document:doc,error:c.article_envelope.error||r.error||body.error||null,discovered_feeds:c.discovered_feeds}}];`);
sourceW.code('No Article Result',`const c=$input.first().json;return [{json:{run_id:c.run_id,location_id:c.location_id,source_id:c.source.id,status:c.listing_envelope.status==='failed'||c.discovery_failed?'failed':'empty',records:[],document:null,error:c.listing_envelope.status==='failed'||c.discovery_failed?c.document.reason:null,discovered_feeds:c.discovered_feeds}}];`);
sourceW.code('Source Result Envelope',`const c=$('Source Input').first().json;const items=$input.all().map(x=>x.json);invariant(items.every(i=>i.run_id===c.run_id&&i.location_id===c.location_id&&i.source_id===c.source.id),'Cross-run evidence merge');const discovery=$('Keep Discovered Feed and HTML Links').first().json.discovery||{};const listing=[...(discovery.listing_reports||[]),...(discovery.seasonal_month?[{url:c.source.url,title:'Sea Leveler '+c.window.period_start.slice(0,7)+' seasonal guide',text:discovery.text||'',published_at:discovery.metadata?.published_at||null,scoped_location_id:c.location_id,species_catalog:discovery.species_catalog||[],seasonal_ratings:discovery.seasonal_ratings||[],seasonal_month:discovery.seasonal_month}]:[])];const listingDocs=listing.filter(d=>sourceUrlAllowed(d.url,c.source)).map(d=>({...d,retrieved_at:new Date().toISOString()}));const records=relevantEvidence(deduplicateEvidence([...listingDocs.flatMap(d=>extractEvidence(d,c)),...items.flatMap(i=>i.records)]),c.window);return [{json:{schema_version:c.schema_version,run_id:c.run_id,location_id:c.location_id,scheduled_for:c.scheduled_for,mode:c.mode,source_id:c.source.id,status:items.every(i=>i.status==='failed')?'failed':records.length?'ok':'empty',retrieved_at:new Date().toISOString(),issued_at:null,records,documents:[...listingDocs,...items.map(i=>i.document).filter(Boolean)],discovered_feeds:[...new Set(items.flatMap(i=>i.discovered_feeds||[]))],warnings:items.filter(i=>i.error).map(i=>String(i.error)),error:items.every(i=>i.status==='failed')?'All article collection failed':null,url:c.source.url}}];`);
sourceW.chain('Source Input','Validate Approved Source','Fetch Robots Policy','Keep Robots Response','Evaluate Publisher Policy','Publisher Access Decision','Publisher Allows Fetch?');sourceW.link('Publisher Allows Fetch?','Listing Crawl Delay',0);sourceW.link('Publisher Allows Fetch?','Disabled Source Envelope',1);sourceW.chain('Listing Crawl Delay','Fetch Source Listing','Keep Listing HTML','Discover Article Links','Prepare Bounded Article Items','Loop Articles');sourceW.link('Loop Articles','Source Result Envelope',0);sourceW.link('Loop Articles','Article Available?',1);sourceW.link('Article Available?','Article Crawl Delay',0);sourceW.link('Article Available?','No Article Result',1);sourceW.chain('Article Crawl Delay','Fetch Permitted Article','Keep Article HTML','Extract Article and Dates','Filter Article Evidence','Loop Articles');sourceW.link('No Article Result','Loop Articles');
sourceW.note('Configured publishers only. Robots policy and crawl delays checked before fetching. Same-domain HTTPS URLs without query strings; redirects disabled. HTML/date extraction is private helper parsing. Zero items return an envelope. Publication, modification, trip and retrieval dates remain separate.');sourceW.save('40-source-evidence.json');

loc.data.connections['Normalize Astronomy']={main:[[{node:'Collect Fishing Sources?',type:'main',index:0}]]};
loc.iff('Collect Fishing Sources?','={{ !$json.use_fixtures }}');
loc.code('Prepare Fishing Source Items',`const c=$input.first().json;const sources=c.config.sources.filter(s=>s.enabled&&c.location.fishing_sources.includes(s.id));if(!sources.length)return [{json:{...c,source:null,no_sources:true}}];return sources.map(source=>({json:{...c,source:{...source,url:source.id==='sealeveler_monthly'?'https://www.sealeveler.com/fishing-month/'+['january','february','march','april','may','june','july','august','september','october','november','december'][Number(c.window.period_start.slice(5,7))-1]+'/':source.url},source_id:source.id,no_sources:false}}));`);
loc.node('Loop Fishing Sources','splitInBatches',{batchSize:1,options:{}});
loc.iff('Fishing Source Available?','={{ !$json.no_sources }}');
loc.child('Run Source Evidence Collector','fishing_source_v1');loc.data.nodes.find(n=>n.name==='Run Source Evidence Collector').onError='continueRegularOutput';
loc.code('Expected Source Outcome',`const item=$input.first().json;if(!item.error||item.source_id)return [{json:item}];const c=$('Loop Fishing Sources').first(1).json;return [{json:{source_id:c.source.id,run_id:c.run_id,location_id:c.location_id,status:'failed',retrieved_at:new Date().toISOString(),issued_at:null,records:[],warnings:[],error:item.error.message||String(item.error),url:c.source.url}}];`);
loc.code('No Fishing Source Envelope',`const c=$input.first().json;return [{json:{source_id:'fishing_sources',run_id:c.run_id,location_id:c.location_id,status:'empty',retrieved_at:new Date().toISOString(),issued_at:null,records:[],warnings:['No enabled fishing sources'],error:null,url:null}}];`);
loc.code('Combine Location Evidence',`const c=$('Normalize Astronomy').first().json;const sources=$input.all().map(i=>i.json);invariant(sources.every(s=>s.run_id===c.run_id&&s.location_id===c.location_id),'Cross-location source aggregation');c.collectors.push(...sources);c.evidence=deduplicateEvidence(sources.flatMap(s=>s.records||[]));return [{json:c}];`);
loc.link('Collect Fishing Sources?','Prepare Fishing Source Items',0);loc.link('Collect Fishing Sources?','Validate and Render Factual Briefing',1);loc.chain('Prepare Fishing Source Items','Loop Fishing Sources');loc.link('Loop Fishing Sources','Combine Location Evidence',0);loc.link('Loop Fishing Sources','Fishing Source Available?',1);loc.link('Fishing Source Available?','Run Source Evidence Collector',0);loc.link('Fishing Source Available?','No Fishing Source Envelope',1);loc.chain('Run Source Evidence Collector','Expected Source Outcome','Loop Fishing Sources');loc.link('No Fishing Source Envelope','Loop Fishing Sources');loc.chain('Combine Location Evidence','Validate and Render Factual Briefing');loc.save('20-location-report.json');
manifest.bundle_version='0.2.0-phase2';manifest.phase='2';manifest.workflows['40-source-evidence.json']=sourceW.data.name;manifest.implemented.push('publisher robots/delay checks','article discovery and extraction','date/geography/method filtering','deduplication');manifest.pending=manifest.pending.filter(x=>x!=='fishing evidence qualification');fs.writeFileSync(path.join(outputRoot,'manifest.json'),JSON.stringify(manifest,null,2)+'\n');
console.log('Added actual Phase 2 source collector and parent source loop.');

// Restricted subscription writer. One initial call and one repair; facts remain deterministic.
delete loc.data.connections['Validate and Render Factual Briefing'];
loc.code('Assemble Sanitized Writer Packet',`const c=$input.first().json;c.writer_packet=writerPacket(c);c.writer_attempt=1;return [{json:c}];`);
loc.iff('Writer Enabled and Marine Data Available?','={{ $json.config.llm.enabled && !$json.use_fixtures && $json.writer_packet.marine_data_available }}');
loc.pg('Reserve Initial Writer Call','SELECT reserve_writer($1::jsonb) AS context;');
loc.code('Unwrap Initial Writer Reservation','return [{json:$input.first().json.context}];');
loc.iff('Initial Writer Reservation Acquired?','={{ $json.writer_reserved }}');
loc.http('Call Restricted Codex Writer','http://writer:8081/write','json','POST','={{ JSON.stringify($json.writer_packet) }}');
for(const name of ['Call Restricted Codex Writer']){const n=loc.data.nodes.find(n=>n.name===name);n.retryOnFail=false;n.parameters.options.timeout=195000;}
loc.code('Validate Initial Writer Answer',`const c=$('Unwrap Initial Writer Reservation').first().json;const r=$input.first().json;c.writer_response=r.body??r;applyWriter(c,c.writer_response);return [{json:c}];`);
loc.pg('Record Initial Writer Outcome',`UPDATE writer_calls SET finished_at=now(),status=$2,usage=$3::jsonb,diagnostic=$4::jsonb WHERE run_id=$1 AND attempt=1;SELECT $5::jsonb AS context;`,'={{ [$json.db_run_id,$json.writer_validation.valid?"validated":"failed",JSON.stringify($json.writer_response.usage||null),JSON.stringify($json.writer_validation),JSON.stringify($json)] }}');
loc.code('Unwrap Initial Writer Outcome','return [{json:$input.first().json.context}];');
loc.iff('Bounded Writer Repair Needed?','={{ !$json.writer_validation.valid && $json.writer_response.status === "ok" && $json.config.llm.max_repair_attempts > 0 }}');
loc.code('Prepare One Writer Repair',`const c=$input.first().json;c.writer_attempt=2;c.writer_packet.repair={errors:c.writer_validation.errors,previous_answer:c.writer_response.result,instruction:'Correct the rejected answer using only the same packet. Use no numeric claims or URLs in prose.'};return [{json:c}];`);
loc.pg('Reserve Repair Writer Call','SELECT reserve_writer($1::jsonb) AS context;');
loc.code('Unwrap Repair Writer Reservation','return [{json:$input.first().json.context}];');
loc.iff('Repair Reservation Acquired?','={{ $json.writer_reserved }}');
loc.http('Call Codex Writer Repair','http://writer:8081/write','json','POST','={{ JSON.stringify($json.writer_packet) }}');
{const n=loc.data.nodes.find(n=>n.name==='Call Codex Writer Repair');n.retryOnFail=false;n.parameters.options.timeout=195000;}
loc.code('Validate Repair or Keep Fallback',`const c=$('Unwrap Repair Writer Reservation').first().json;const r=$input.first().json;c.writer_response=r.body??r;applyWriter(c,c.writer_response);return [{json:c}];`);
loc.pg('Record Repair Writer Outcome',`UPDATE writer_calls SET finished_at=now(),status=$2,usage=$3::jsonb,diagnostic=$4::jsonb WHERE run_id=$1 AND attempt=2;SELECT $5::jsonb AS context;`,'={{ [$json.db_run_id,$json.writer_validation.valid?"validated":"failed",JSON.stringify($json.writer_response.usage||null),JSON.stringify($json.writer_validation),JSON.stringify($json)] }}');
loc.code('Unwrap Repair Writer Outcome','return [{json:$input.first().json.context}];');
loc.iff('Live Alert Recheck Required?','={{ !$json.use_fixtures }}');
loc.http('Recheck Alerts Before Final Archive','={{ "https://api.weather.gov/alerts/active?zone="+$json.location.marine_zones.join(",") }}');
loc.code('Apply Final Alert Recheck',`const c=$('Live Alert Recheck Required?').first().json;const e=normalizeAlerts(envelope(c,'nws_alerts',$input.first().json,'json',(c.location.marine_provider==='open_meteo'?($input.first().json.body??$input.first().json).authority_url||null:'https://api.weather.gov/alerts/active?zone='+c.location.marine_zones.join(','))));const prior=c.collectors.find(x=>x.source_id==='nws_alerts');const changed=JSON.stringify(prior?.records||[])!==JSON.stringify(e.records)||e.status==='failed';c.collectors=c.collectors.filter(x=>x.source_id!=='nws_alerts');c.collectors.push(e);c.report.forecast_table=forecastTable(c);c.report.sources=c.report.sources.filter(x=>x.source_id!=='nws_alerts');c.report.sources.push({source_id:e.source_id,url:e.url,status:e.status,issued_at:e.issued_at,retrieved_at:e.retrieved_at});refreshDailyAfterAlerts(c,changed);c.final_alert_checked_at=e.retrieved_at;return [{json:c}];`);
loc.code('Render Final Validated Report',`const c=$input.first().json;invariant(c.report.window.dates.join(',')===c.window.dates.join(','),'Report dates changed');invariant(c.report.location_id===c.location_id,'Report location changed');c.rendered=render(c.report);return [{json:c}];`);
loc.pg('Archive Fishing Evidence','SELECT archive_fishing_evidence($1::jsonb); SELECT $1::jsonb AS context;');
loc.code('Unwrap Evidence Archive','return [{json:$input.all().map(i=>i.json).find(i=>i.context).context}];');
loc.chain('Validate and Render Factual Briefing','Assemble Sanitized Writer Packet','Writer Enabled and Marine Data Available?');
loc.link('Writer Enabled and Marine Data Available?','Reserve Initial Writer Call',0);loc.link('Writer Enabled and Marine Data Available?','Live Alert Recheck Required?',1);
loc.chain('Reserve Initial Writer Call','Unwrap Initial Writer Reservation','Initial Writer Reservation Acquired?');loc.link('Initial Writer Reservation Acquired?','Call Restricted Codex Writer',0);loc.link('Initial Writer Reservation Acquired?','Live Alert Recheck Required?',1);
loc.chain('Call Restricted Codex Writer','Validate Initial Writer Answer','Record Initial Writer Outcome','Unwrap Initial Writer Outcome','Bounded Writer Repair Needed?');loc.link('Bounded Writer Repair Needed?','Prepare One Writer Repair',0);loc.link('Bounded Writer Repair Needed?','Live Alert Recheck Required?',1);
loc.chain('Prepare One Writer Repair','Reserve Repair Writer Call','Unwrap Repair Writer Reservation','Repair Reservation Acquired?');loc.link('Repair Reservation Acquired?','Call Codex Writer Repair',0);loc.link('Repair Reservation Acquired?','Live Alert Recheck Required?',1);
loc.chain('Call Codex Writer Repair','Validate Repair or Keep Fallback','Record Repair Writer Outcome','Unwrap Repair Writer Outcome','Live Alert Recheck Required?');loc.link('Live Alert Recheck Required?','Recheck Alerts Before Final Archive',0);loc.link('Live Alert Recheck Required?','Render Final Validated Report',1);loc.chain('Recheck Alerts Before Final Archive','Apply Final Alert Recheck','Render Final Validated Report','Archive Fishing Evidence','Unwrap Evidence Archive','Archive Immutable Report');
loc.save('20-location-report.json');
manifest.bundle_version='0.3.0-phase3';manifest.phase='3';manifest.implemented.push('sanitized subscription writer packet','atomic two-call reservations','one repair and factual fallback','final alert recheck','fishing evidence persistence');manifest.pending=['writer authentication and live generation pilot','delivery','failure handler','fresh-instance final bundle reimport'];
fs.writeFileSync(path.join(outputRoot,'manifest.json'),JSON.stringify(manifest,null,2)+'\n');
console.log('Added restricted writer, bounded repair, evidence archive and final alert recheck.');

const delivery=new Workflow('Fishing Report — Deliver Archived Report','fishing_delivery_v1');
delivery.node('Archived Delivery Input','executeWorkflowTrigger',{inputSource:'passthrough'});
delivery.node('Manual Archived Delivery','manualTrigger');
delivery.code('Manual Archived Delivery Settings',`return [{json:{schema_version:'1.0',run_id:'manual_delivery_'+Date.now(),location_id:${JSON.stringify(config.locations[0].id)},scheduled_for:'2026-09-30T23:00:00Z',namespace:'test',mode:'dry_run',report_id:null}}];`);
delivery.pg('Load Archived Report and Subscribers',`SELECT $1::jsonb AS input,to_jsonb(r) AS archive,c.value AS config,
 COALESCE((SELECT jsonb_agg(to_jsonb(s)) FROM subscribers s),'[]'::jsonb) AS subscribers,
 COALESCE((SELECT jsonb_agg(d.recipient) FROM deliveries d WHERE d.report_id=r.report_id AND d.status='failed'),'[]'::jsonb) AS failed_recipients
 FROM reports r CROSS JOIN configuration c WHERE r.report_id=$1::jsonb->>'report_id' AND c.key='main';`);
delivery.code('Select Test Override or Subscribers',`const loaded=$input.first()?.json;invariant(loaded?.archive,'Archived report missing');return deliveryItems(loaded).map(json=>({json}));`);
delivery.node('Loop Recipients','splitInBatches',{batchSize:1,options:{}});
delivery.iff('Recipient Requires Sending?','={{ !$json.no_send }}');
delivery.code('No Send Outcome','return [{json:$input.first().json}];');
delivery.pg('Atomically Claim Recipient Delivery','SELECT claim_delivery($1::jsonb) AS context;');
delivery.code('Unwrap Delivery Claim','return [{json:$input.first().json.context}];');
delivery.iff('Recipient Claim Acquired?','={{ $json.delivery_claimed }}');
delivery.code('Skip Existing Recipient Delivery',`const c=$input.first().json;return [{json:{schema_version:c.schema_version,run_id:c.run_id,location_id:c.location_id,report_id:c.report_id,mode:c.mode,outcome:'existing_delivery_skipped'}}];`);
delivery.pg('Mark Recipient Sending Before SMTP','SELECT begin_delivery($1::jsonb) AS context;');
delivery.code('Unwrap Sending State',`const c=$input.first().json.context,a=$('Load Archived Report and Subscribers').first().json.archive,m=a?.report?.ocean_features?.map;const b64=m?.artifact_base64;const valid=typeof b64==='string'&&b64.length>0&&b64.length<=2000000&&/^[A-Za-z0-9+/]+={0,2}$/.test(b64)&&m?.mime_type==='image/png';const prepared=valid?{data:b64,mimeType:m.mime_type,fileName:'ocean-features.png'}:null;return [{json:c,...(prepared?{binary:{ocean_map:prepared}}:{})}];`);
delivery.iff('SMTP Send Authorized?','={{ $json.send_authorized }}');
delivery.node('Send Archived Email Once','emailSend',{resource:'email',operation:'send',fromEmail:'={{ $json.sender }}',toEmail:'={{ $json.recipient }}',subject:'={{ $json.subject }}',emailFormat:'both',text:'={{ $json.text }}',html:'={{ $json.html }}',options:{appendAttribution:false,attachments:"={{ $binary?.ocean_map ? 'ocean_map' : '' }}"}},{onError:'continueRegularOutput',retryOnFail:false,disabled:true});
delivery.code('Classify SMTP Acceptance Rejection or Unknown',`const c=$('Unwrap Sending State').first().json;return [{json:smtpOutcome($input.first().json,c)}];`);
delivery.pg('Persist Recipient SMTP Outcome','SELECT finish_delivery($1::jsonb) AS context;');
delivery.code('Compact Recipient Delivery Outcome','return [{json:$input.first().json.context}];');
delivery.code('Aggregate Delivery Outcomes',`const outcomes=$input.all().map(i=>i.json);const c=$('Load Archived Report and Subscribers').first().json.input;return [{json:{schema_version:c.schema_version,run_id:c.run_id,location_id:c.location_id,scheduled_for:c.scheduled_for,mode:c.mode,report_id:c.report_id,outcome:outcomes.some(x=>['failed','unknown'].includes(x.outcome))?'partial':'complete',recipient_outcomes:outcomes}}];`);
delivery.chain('Archived Delivery Input','Load Archived Report and Subscribers','Select Test Override or Subscribers','Loop Recipients');delivery.link('Loop Recipients','Aggregate Delivery Outcomes',0);delivery.link('Loop Recipients','Recipient Requires Sending?',1);delivery.link('Recipient Requires Sending?','Atomically Claim Recipient Delivery',0);delivery.link('Recipient Requires Sending?','No Send Outcome',1);delivery.link('No Send Outcome','Loop Recipients');
delivery.chain('Manual Archived Delivery','Manual Archived Delivery Settings','Load Archived Report and Subscribers');
delivery.chain('Atomically Claim Recipient Delivery','Unwrap Delivery Claim','Recipient Claim Acquired?');delivery.link('Recipient Claim Acquired?','Mark Recipient Sending Before SMTP',0);delivery.link('Recipient Claim Acquired?','Skip Existing Recipient Delivery',1);delivery.link('Skip Existing Recipient Delivery','Loop Recipients');
delivery.chain('Mark Recipient Sending Before SMTP','Unwrap Sending State','SMTP Send Authorized?');delivery.link('SMTP Send Authorized?','Send Archived Email Once',0);delivery.link('SMTP Send Authorized?','Skip Existing Recipient Delivery',1);delivery.chain('Send Archived Email Once','Classify SMTP Acceptance Rejection or Unknown','Persist Recipient SMTP Outcome','Compact Recipient Delivery Outcome','Loop Recipients');
delivery.note('Bind every Postgres node to Fishing Report - Database and Send Archived Email Once to Fishing Report - Gmail SMTP. No automatic SMTP retries. send_test overrides subscribers with the private test address. Accepted, sending and unknown ledger entries cannot be resent. Explicit retry_failed_deliveries selects only failed recipients of the same immutable report.');delivery.save('30-deliver-report.json');

delete loc.data.connections['Unwrap Archived Report'];
loc.code('Prepare Archived Delivery Reference',`const c=$input.first().json;return [{json:{schema_version:c.schema_version,run_id:c.run_id,location_id:c.location_id,scheduled_for:c.scheduled_for,mode:c.mode,namespace:c.namespace,report_id:c.report_id}}];`);
loc.child('Deliver Archived Report or Finish Dry-run','fishing_delivery_v1');loc.data.nodes.find(n=>n.name==='Deliver Archived Report or Finish Dry-run').onError='continueRegularOutput';
loc.code('Restore Location with Delivery Outcome',`const c=$('Unwrap Archived Report').first().json;const r=$input.first().json;c.delivery_summary=r.error?{outcome:'partial',error:r.error.message||String(r.error)}:r;return [{json:c}];`);
loc.chain('Unwrap Archived Report','Prepare Archived Delivery Reference','Deliver Archived Report or Finish Dry-run','Restore Location with Delivery Outcome','Finish Factual Run');
const finish=loc.data.nodes.find(n=>n.name==='Finish Factual Run');finish.parameters.query=`UPDATE runs SET status=$4,finished_at=now(),lease_owner=NULL,lease_until=NULL WHERE run_id=$1 AND lease_owner=$2; SELECT $3::jsonb AS result;`;
finish.parameters.options.queryReplacement='={{ [$json.db_run_id,$json.run_id,JSON.stringify({schema_version:$json.schema_version,run_id:$json.run_id,location_id:$json.location_id,scheduled_for:$json.scheduled_for,mode:$json.mode,report_id:$json.report_id,outcome:$json.delivery_summary.outcome==="partial"?"partial":"complete",outlook_mode:$json.report.outlook_mode,fixture:$json.use_fixtures,delivery:$json.delivery_summary}),$json.delivery_summary.outcome==="partial"?"partial":"complete"] }}';loc.save('20-location-report.json');

const failure=new Workflow('Fishing Report — Failure Handler','fishing_failure_v1');
failure.node('Unhandled Workflow Error','errorTrigger');failure.node('Expected Operational Failure','executeWorkflowTrigger',{inputSource:'passthrough'});
failure.code('Normalize Failure Diagnostic',`const e=$input.first().json;const execution=e.execution||{};return [{json:{kind:e.kind||'unhandled_workflow_error',run_id:e.run_id||null,execution_id:execution.id||e.execution_id||null,workflow_id:e.workflow?.id||null,diagnostic:{message:String(execution.error?.message||e.message||'Workflow failed').slice(0,1200),last_node:execution.lastNodeExecuted||null,execution_id:execution.id||e.execution_id||null,workflow_id:e.workflow?.id||null},production:e.production===true}}];`);
failure.pg('Record Failure and Release Affected Run',`WITH affected AS (
 UPDATE runs SET status='failed',finished_at=now(),lease_owner=NULL,lease_until=NULL,error=$1::jsonb->'diagnostic'
 WHERE status='running' AND (context->>'execution_id'=$1::jsonb->>'execution_id' OR scheduler_run_id=$1::jsonb->>'run_id') RETURNING namespace)
 INSERT INTO operational_events(kind,run_id,diagnostic) VALUES($1::jsonb->>'kind',$1::jsonb->>'run_id',$1::jsonb->'diagnostic');
 SELECT $1::jsonb AS input,value AS config FROM configuration WHERE key='main';`);
failure.code('Prepare Operator Notice',`const x=$input.all().map(i=>i.json).find(i=>i.config);invariant(x,'Missing operator config');const production=x.input.production||x.config.execution.mode==='production';const canNotify=production&&x.config.email.smtp_ready===true&&validEmail(x.config.email.operator)&&validEmail(x.config.email.sender)&&x.input.workflow_id!=='fishing_failure_v1';return [{json:{...x.input,can_notify:canNotify,sender:x.config.email.sender,recipient:x.config.email.operator,subject:'Fishing Report workflow failure',text:JSON.stringify(x.input.diagnostic,null,2)}}];`);
failure.iff('Notify Configured Operator?','={{ $json.can_notify }}');
failure.node('Send Operator Failure Notice Once','emailSend',{resource:'email',operation:'send',fromEmail:'={{ $json.sender }}',toEmail:'={{ $json.recipient }}',subject:'={{ $json.subject }}',emailFormat:'text',text:'={{ $json.text }}',options:{appendAttribution:false}},{onError:'continueRegularOutput',retryOnFail:false,disabled:true});
failure.code('Operator Notice Outcome',`const c=$('Prepare Operator Notice').first().json;return [{json:{kind:c.kind,run_id:c.run_id,status:$input.first().json.error?'notification_failed':'notification_attempted'}}];`);
failure.pg('Persist Operator Notice Outcome',`UPDATE operational_events SET notification_status=$2 WHERE id=(SELECT id FROM operational_events WHERE kind=$1 AND run_id IS NOT DISTINCT FROM $3 ORDER BY id DESC LIMIT 1);SELECT $4::jsonb AS outcome;`,'={{ [$json.kind,$json.status,$json.run_id,JSON.stringify($json)] }}');
failure.code('No Operator Notice for Test',`return [{json:{status:'failure_recorded_without_email',kind:$json.kind,run_id:$json.run_id}}];`);
failure.chain('Unhandled Workflow Error','Normalize Failure Diagnostic');failure.chain('Expected Operational Failure','Normalize Failure Diagnostic','Record Failure and Release Affected Run','Prepare Operator Notice','Notify Configured Operator?');failure.link('Notify Configured Operator?','Send Operator Failure Notice Once',0);failure.link('Notify Configured Operator?','No Operator Notice for Test',1);failure.chain('Send Operator Failure Notice Once','Operator Notice Outcome','Persist Operator Notice Outcome');
failure.note('Set this workflow as the error workflow for Scheduler, Location and Delivery. This handler has no error workflow itself. Expected operational failures can call its sub-workflow trigger. Tests log failures without operator email; production uses the configured operator. SMTP notices have no automatic retry.');failure.save('90-failure-handler.json');
for(const w of [scheduler,loc,delivery])w.data.settings.errorWorkflow='fishing_failure_v1';
scheduler.pg('Persist Caught Location Failures',`UPDATE runs SET status='failed',finished_at=now(),lease_owner=NULL,lease_until=NULL,error=$1::jsonb WHERE scheduler_run_id=$1::jsonb->>'run_id' AND location_id=$1::jsonb->>'location_id' AND status='running' AND $1::jsonb->>'outcome'='failed';SELECT $1::jsonb AS result;`);
scheduler.code('Unwrap Caught Location Outcome','return [{json:$input.first().json.result}];');delete scheduler.data.connections['Record Location Outcome'];scheduler.chain('Record Location Outcome','Persist Caught Location Failures','Unwrap Caught Location Outcome','Loop Locations');
scheduler.pg('Reconcile Interrupted SMTP Attempts','SELECT reconcile_abandoned_deliveries(); SELECT $1::jsonb AS context;');scheduler.code('Unwrap SMTP Reconciliation','return [{json:$input.all().map(i=>i.json).find(i=>i.context).context}];');
delete scheduler.data.connections['Catch-up Trigger Settings'];scheduler.chain('Catch-up Trigger Settings','Reconcile Interrupted SMTP Attempts','Unwrap SMTP Reconciliation','Load Owner Configuration');
scheduler.save('10-weekly-scheduler.json');loc.save('20-location-report.json');delivery.save('30-deliver-report.json');
manifest.workflows['30-deliver-report.json']=delivery.data.name;manifest.workflows['90-failure-handler.json']=failure.data.name;manifest.bundle_version='0.4.0-phase4';manifest.phase='4';manifest.implemented.push('archived multipart email delivery','atomic recipient claims','known/unknown SMTP ledger','operator failure handler','abandoned SMTP reconciliation');manifest.pending=['writer authentication/generation pilot','SMTP credentials and owner test','runtime delivery/failure tests','fresh-instance final bundle reimport'];fs.writeFileSync(path.join(outputRoot,'manifest.json'),JSON.stringify(manifest,null,2)+'\n');
console.log('Added durable archived delivery and operator failure workflows.');

// Use the publisher's advertised feed when available; HTML remains an explicit fallback.
delete sourceW.data.connections['Discover Article Links'];
sourceW.code('Keep Discovered Feed and HTML Links',`const c=$('Keep Listing HTML').first().json;const r=$input.first().json;const discovery=r.body??r;const feed=(c.source.id==='spacefish_surf'||discovery.seasonal_month?[]:(discovery.feeds||[])).find(url=>sourceUrlAllowed(url,c.source)&&!/comments/i.test(url));return [{json:{...c,discovery_response:r,discovery,feed_url:feed||null}}];`);
sourceW.iff('Advertised Fishing Feed Available?','={{ !!$json.feed_url }}');
sourceW.node('Feed Crawl Delay','wait',{resume:'timeInterval',amount:'={{ $json.policy.delay_seconds }}',unit:'seconds'});
sourceW.node('Read Advertised Fishing RSS','rssFeedRead',{url:'={{ $json.feed_url }}',options:{ignoreSSL:false}},{onError:'continueRegularOutput',alwaysOutputData:true,retryOnFail:false});
sourceW.code('Combine RSS and HTML Discovery',`const c=$('Keep Discovered Feed and HTML Links').first().json;const items=$input.all().map(i=>i.json);const links=items.filter(i=>i.link&&sourceUrlAllowed(i.link.trim(),c.source)).slice(0,15).map(i=>({url:i.link.trim(),title:i.title||'Fishing report',published_at:i.isoDate||i.pubDate||null,robots_allowed:true}));return [{json:{body:{...c.discovery,links:[...links,...(c.discovery.links||[])],feed_status:items.some(i=>i.error)?'failed':links.length?'ok':'empty'}}}];`);
sourceW.code('Use HTML Discovery Without Feed',`return [{json:$input.first().json.discovery_response}];`);
sourceW.chain('Discover Article Links','Keep Discovered Feed and HTML Links','Advertised Fishing Feed Available?');sourceW.link('Advertised Fishing Feed Available?','Feed Crawl Delay',0);sourceW.link('Advertised Fishing Feed Available?','Use HTML Discovery Without Feed',1);sourceW.chain('Feed Crawl Delay','Read Advertised Fishing RSS','Combine RSS and HTML Discovery','Prepare Bounded Article Items');sourceW.link('Use HTML Discovery Without Feed','Prepare Bounded Article Items');
delete sourceW.data.connections['Combine RSS and HTML Discovery'];
sourceW.http('Check RSS Article Publisher Access','http://helper:8080/robots','json','POST','={{ JSON.stringify({url:$("Keep Discovered Feed and HTML Links").first().json.source.url,text:$("Keep Discovered Feed and HTML Links").first().json.robots_text,http_status:$("Keep Discovered Feed and HTML Links").first().json.robots_status,links:$json.body.links}) }}');
sourceW.code('Apply RSS Article Access Policy',`const prior=$('Combine RSS and HTML Discovery').first().json;const r=$input.first().json;const body=r.body??r;return [{json:{body:{...prior.body,links:body.links||[],status:body.error||r.error?'failed':prior.body.status}}}];`);
sourceW.chain('Combine RSS and HTML Discovery','Check RSS Article Publisher Access','Apply RSS Article Access Policy','Prepare Bounded Article Items');
sourceW.save('40-source-evidence.json');manifest.implemented.push('advertised RSS with bounded HTML fallback');manifest.node_versions=versions;fs.writeFileSync(path.join(outputRoot,'manifest.json'),JSON.stringify(manifest,null,2)+'\n');

delete scheduler.data.connections['Catch-up Outside Window'];
scheduler.code('Prepare Missed Schedule Check',`const c=$('Normalize Scheduled Run').first().json;return [{json:{...c,period_start:reportWindow(c.scheduled_for,c.config.schedule.timezone).period_start}}];`);
scheduler.pg('Record Missed Schedule Once','SELECT record_missed_schedule($1::jsonb) AS context;');
scheduler.code('Unwrap Missed Schedule Check','return [{json:$input.first().json.context}];');
scheduler.iff('New Missed Production Schedule?','={{ $json.notify_missed }}');
scheduler.code('Prepare Missed Schedule Notice',`const c=$input.first().json;return [{json:{kind:'missed_schedule_notice',run_id:c.run_id,production:true,message:'The original Wednesday report was not archived within the configured catch-up window. Automatic late collection is suppressed; review the durable run ledger and replay deliberately.'}}];`);
scheduler.child('Notify Missed Schedule Operator','fishing_failure_v1');
scheduler.code('No New Missed Schedule Notice','return [{json:{status:"outside_catch_up_window",mode:$input.first().json.mode,scheduled_for:$input.first().json.scheduled_for}}];');
scheduler.chain('Catch-up Outside Window','Prepare Missed Schedule Check','Record Missed Schedule Once','Unwrap Missed Schedule Check','New Missed Production Schedule?');scheduler.link('New Missed Production Schedule?','Prepare Missed Schedule Notice',0);scheduler.link('New Missed Production Schedule?','No New Missed Schedule Notice',1);scheduler.chain('Prepare Missed Schedule Notice','Notify Missed Schedule Operator');
scheduler.code('Check Scheduler Operational Notice',`const s=$input.first().json.summary;return [{json:{...s,notify:s.mode==='production'&&(s.status==='partial'||s.outcomes.some(o=>o.outlook_mode==='data_unavailable')),kind:'scheduler_partial',production:s.mode==='production',message:'Report run needs attention: '+JSON.stringify(s.outcomes)}}];`);
scheduler.iff('Production Run Needs Operator Attention?','={{ $json.notify }}');
scheduler.child('Notify Partial Run Operator','fishing_failure_v1');
scheduler.code('Scheduler Completed Outcome',`return [{json:$input.first().json}];`);
scheduler.chain('Persist Scheduler Summary','Check Scheduler Operational Notice','Production Run Needs Operator Attention?');scheduler.link('Production Run Needs Operator Attention?','Notify Partial Run Operator',0);scheduler.link('Production Run Needs Operator Attention?','Scheduler Completed Outcome',1);
scheduler.save('10-weekly-scheduler.json');

// Reuse local report history without preserving an old item's "current" label.
loc.pg('Load Archived Local Fishing History',`SELECT $1::jsonb AS context,COALESCE((SELECT jsonb_agg(h.evidence) FROM (SELECT DISTINCT ON (e.evidence->>'duplicate_fingerprint') e.evidence FROM fishing_evidence e JOIN runs r ON r.run_id=e.run_id WHERE e.location_id=$1::jsonb->>'location_id' AND r.context->>'use_fixtures'='false' AND e.evidence->>'source_id' IN (SELECT jsonb_array_elements_text($1::jsonb#>'{location,fishing_sources}')) ORDER BY e.evidence->>'duplicate_fingerprint',r.started_at DESC LIMIT 100) h),'[]'::jsonb) AS history;`);
loc.code('Refresh History Dates and Combine Evidence',`const {context:c,history}=$input.first().json;const old=refreshEvidenceHistory(history||[],c);c.evidence=deduplicateEvidence([...c.evidence,...old]);return [{json:c}];`);
delete loc.data.connections['Combine Location Evidence'];loc.chain('Combine Location Evidence','Load Archived Local Fishing History','Refresh History Dates and Combine Evidence','Validate and Render Factual Briefing');loc.save('20-location-report.json');

manifest.bundle_version='0.6.0-daily-outlook';manifest.phase='daily recommendations testing';
manifest.implemented.push('concise daily method/species/location outlook','Spacefish Canaveral card provenance','Sea Leveler seasonal report history','same-location archived evidence reuse with refreshed age labels','dated tide/moon context without unsupported catch multipliers','final-alert invalidation of obsolete fishing plans','weather preferences in compact footer');
manifest.pending=['owner inbox/desktop/phone review','production activation explicitly deferred','two observed Wednesday production runs','real additional-location adapters when selected'];
fs.writeFileSync(path.join(outputRoot,'manifest.json'),JSON.stringify(manifest,null,2)+'\n');

// News is collected after synthesis and before the final alert recheck. It is
// an independently bounded appendix, never catch evidence or writer input.
for(const connection of Object.values(loc.data.connections))for(const branch of connection.main||[])for(const edge of branch||[])if(edge.node==='Live Alert Recheck Required?')edge.node='Prepare Fishing News';
loc.code('Prepare Fishing News',`return [{json:$input.first().json}];`);
loc.iff('Fishing News RSS Enabled?','={{ $json.config.news?.enabled === true && !$json.use_fixtures }}');
loc.http('Collect Fishing News RSS','http://helper:8080/news-rss','json','POST','={{ JSON.stringify({feed_ids:$json.config.news.feeds.filter(f=>f.enabled!==false).map(f=>f.id).slice(0,12)}) }}');
const newsRequest=loc.data.nodes.find(n=>n.name==='Collect Fishing News RSS');newsRequest.parameters.options.timeout=120000;newsRequest.retryOnFail=false;
loc.code('Attach Selected Fishing News',`const c=$('Prepare Fishing News').first().json;const r=$input.first().json;const body=r.body??r;const response=Array.isArray(body.records)?body:{status:'failed',records:[],sources:(c.config.news.feeds||[]).filter(f=>f.enabled!==false).map(f=>({source_id:f.id,name:f.name,status:'failed'}))};c.report.fishing_news=selectFishingNews(response,c.config.news);return [{json:c}];`);
loc.code('Skip News for Fixtures or Disabled Configuration',`const c=$input.first().json;c.report.fishing_news={enabled:false,status:c.use_fixtures?'fixture_not_requested':'disabled',items:[],sources:[]};return [{json:c}];`);
loc.chain('Prepare Fishing News','Fishing News RSS Enabled?');loc.link('Fishing News RSS Enabled?','Collect Fishing News RSS',0);loc.link('Fishing News RSS Enabled?','Skip News for Fixtures or Disabled Configuration',1);loc.chain('Collect Fishing News RSS','Attach Selected Fishing News','Live Alert Recheck Required?');loc.link('Skip News for Fixtures or Disabled Configuration','Live Alert Recheck Required?');loc.save('20-location-report.json');
manifest.bundle_version='0.7.0-rss-news';manifest.phase='RSS news testing';manifest.implemented.push('ten newest regional fishing RSS articles grouped by requested location','allowlisted bounded RSS/Atom collector with publisher robots policy','news failures isolated from weather and email delivery');fs.writeFileSync(path.join(outputRoot,'manifest.json'),JSON.stringify(manifest,null,2)+'\n');
manifest.bundle_version='0.8.0-bite-insights';manifest.phase='RSS and researched daily insights testing';manifest.implemented.push('daily all-high-low tide and moon tables','prior-night moon horizon exposure','live primary-source research for qualitative fishing insight','fresh scoped nearshore surface temperature');fs.writeFileSync(path.join(outputRoot,'manifest.json'),JSON.stringify(manifest,null,2)+'\n');

// Step 01: share the location pipeline and scheduler for weekly and Friday jobs.
// A separate Friday trigger uses the same configurable defaults as normalization.
const updateSchedule=config.update_schedule;
scheduler.node('Friday Configured Update','scheduleTrigger',{rule:{interval:[{field:'weeks',weeksInterval:1,triggerAtDay:[5],triggerAtHour:updateSchedule.hour,triggerAtMinute:updateSchedule.minute}]}});
scheduler.code('Friday Trigger Settings',`return [{json:{trigger:'update_scheduled',use_fixtures:false,compiled_update_schedule:${JSON.stringify(updateSchedule)}}}];`);
scheduler.chain('Friday Configured Update','Friday Trigger Settings','Reconcile Interrupted SMTP Attempts');
scheduler.data.nodes.find(n=>n.name==='Wednesday 19:00').parameters.rule.interval[0].triggerAtHour=config.schedule.hour;
scheduler.data.nodes.find(n=>n.name==='Wednesday 19:00').parameters.rule.interval[0].triggerAtMinute=config.schedule.minute;
scheduler.data.nodes.find(n=>n.name==='Manual Replay Settings').parameters.jsCode=core+`\nreturn [{json:{trigger:'manual',mode:'dry_run',scheduled_for:'2026-10-21T23:00:00Z',edition:1,use_fixtures:true}}];`;
loc.data.nodes.find(n=>n.name==='Duplicate Run Outcome').parameters.jsCode=core+`\nconst c=$input.first().json;return [{json:{schema_version:c.schema_version,run_id:c.run_id,location_id:c.location_id,scheduled_for:c.scheduled_for,mode:c.mode,outcome:c.outcome||'duplicate_skipped',evaluation_id:c.evaluation_id,notify_update:c.notify_update===true}}];`;
delete loc.data.connections['Run Claim Acquired?'];
loc.iff('Recover Archived Candidate?','={{ $json.resume_archive === true }}');
loc.link('Run Claim Acquired?','Recover Archived Candidate?',0);loc.link('Run Claim Acquired?','Duplicate Run Outcome',1);
loc.link('Recover Archived Candidate?','Synthetic Fixture?',1);
// Replace the final rendering boundary with a persisted comparison first.
loc.data.nodes.find(n=>n.name==='Render Final Validated Report').parameters.jsCode=core+`\nconst c=$input.first().json;invariant(c.report.window.dates.join(',')===c.window.dates.join(','),'Report dates changed');invariant(c.report.location_id===c.location_id,'Report location changed');carryHistoricalThursday(c);return [{json:c}];`;
delete loc.data.connections['Render Final Validated Report'];
loc.pg('Persist Final Friday Comparison','SELECT finalize_update($1::jsonb) AS context;');
loc.code('Unwrap Final Friday Comparison','return [{json:$input.first().json.context}];');
loc.iff('Finalization Deferred?','={{ $json.finalization_blocked === true }}');
loc.pg('Release Deferred Update Run',`UPDATE runs SET status='partial',finished_at=now(),lease_owner=NULL,lease_until=NULL WHERE run_id=$1::jsonb->>'db_run_id' AND lease_owner=$1::jsonb->>'run_id';SELECT $1::jsonb AS context;`);
loc.code('Deferred Update Outcome',`const c=$input.first().json.context;return [{json:{schema_version:c.schema_version,run_id:c.run_id,location_id:c.location_id,scheduled_for:c.scheduled_for,mode:c.mode,outcome:'deferred',notify_update:c.notify_update===true,evaluation_id:c.evaluation_id}}];`);
loc.code('Render Persisted Report and Subject',`const c=$input.first().json;c.report.effective_subject=composeSubject(c.report,c.config);c.rendered=render(c.report);c.rendered.subject=c.report.effective_subject;return [{json:c}];`);
loc.chain('Render Final Validated Report','Persist Final Friday Comparison','Unwrap Final Friday Comparison','Finalization Deferred?');
loc.chain('Release Deferred Update Run','Deferred Update Outcome');loc.link('Finalization Deferred?','Release Deferred Update Run',0);loc.link('Finalization Deferred?','Render Persisted Report and Subject',1);
loc.chain('Render Persisted Report and Subject','Archive Fishing Evidence');
delete loc.data.connections['Unwrap Archived Report'];
loc.code('Archived Candidate Context','return [{json:$input.first().json}];');
loc.chain('Unwrap Archived Report','Archived Candidate Context');loc.link('Recover Archived Candidate?','Archived Candidate Context',0);
loc.iff('Friday Candidate Allows Delivery?','={{ !$json.report.update || $json.report.update.eligibility === "changed" }}');
loc.chain('Archived Candidate Context','Friday Candidate Allows Delivery?');loc.link('Friday Candidate Allows Delivery?','Prepare Archived Delivery Reference',0);
loc.code('Suppress Friday Subscriber Delivery',`const c=$input.first().json;c.delivery_summary={outcome:c.report.update.eligibility,no_send:true};return [{json:c}];`);
loc.link('Friday Candidate Allows Delivery?','Suppress Friday Subscriber Delivery',1);
loc.data.nodes.find(n=>n.name==='Restore Location with Delivery Outcome').parameters.jsCode=core+`\nconst c=$('Archived Candidate Context').first().json;const r=$input.first().json;c.delivery_summary=r.error?{outcome:'partial',error:r.error.message||String(r.error)}:r;return [{json:c}];`;
delete loc.data.connections['Restore Location with Delivery Outcome'];
loc.pg('Finish Durable Friday Evaluation','SELECT finish_update($1::jsonb) AS context;');
loc.code('Unwrap Finished Friday Evaluation','return [{json:$input.first().json.context}];');
loc.chain('Restore Location with Delivery Outcome','Finish Durable Friday Evaluation');loc.chain('Suppress Friday Subscriber Delivery','Finish Durable Friday Evaluation','Unwrap Finished Friday Evaluation','Finish Factual Run');
finish.parameters.options.queryReplacement=finish.parameters.options.queryReplacement.replace('fixture:$json.use_fixtures,delivery:', 'fixture:$json.use_fixtures,update_outcome:$json.update_outcome,notify_update:$json.notify_update===true,delivery:');
const loadDelivery=delivery.data.nodes.find(n=>n.name==='Load Archived Report and Subscribers');
loadDelivery.parameters.query=loadDelivery.parameters.query.replace('c.value AS config,',`c.value AS config,(SELECT to_jsonb(e) FROM update_evaluations e WHERE e.candidate_report_id=r.report_id) AS evaluation,`);
scheduler.data.nodes.find(n=>n.name==='Prepare Missed Schedule Notice').parameters.jsCode=core+`\nconst c=$input.first().json;return [{json:{kind:'missed_schedule_notice',run_id:c.run_id,production:true,message:c.update_kind==='friday_decisions'?'The Friday decision update did not complete before local Friday noon. Review the evaluation and SMTP ledgers; automatic late updates are suppressed.':'The Wednesday report did not archive within its twelve-hour catch-up window. Review the run ledger and replay deliberately.'}}];`;
const notice=scheduler.data.nodes.find(n=>n.name==='Check Scheduler Operational Notice');
notice.parameters.jsCode=notice.parameters.jsCode.replace("s.status==='partial'||s.outcomes.some", "s.status==='partial'||s.outcomes.some(o=>o.notify_update===true)||s.outcomes.some");
for(const n of loc.data.nodes)if(n.name==='Setup and phase notes')n.parameters.content='Weekly and Friday share this collector, writer, final-alert and archive pipeline. Migration 005 owns Friday evaluations, atomic editions and recipient authorization. Archived-candidate recovery bypasses collection. Suppressed candidates never enter the delivery child.';
for(const n of scheduler.data.nodes)if(n.name==='Setup and phase notes')n.parameters.content='Wednesday 19:00 Eastern; configured Friday 07:00 Eastern; hourly :15 recovery. Wednesday has twelve hours; Friday ends at noon exclusive. Changing update_schedule requires rebuilding, syncing drafts with preserved live settings, and republishing the scheduler in rollout step 4. Exports stay inactive.';
scheduler.save('10-weekly-scheduler.json');loc.save('20-location-report.json');delivery.save('30-deliver-report.json');
manifest.bundle_version='0.9.0-friday-updates';manifest.phase='step 01 locally implemented; production remains 0.8.0';
manifest.migrations=[1,2,3,4,5];manifest.workflow_ids=[setup,sourceW,loc,delivery,failure,scheduler].map(w=>w.data.id);
manifest.schedules={timezone:config.schedule.timezone,weekly:{weekday:'Wednesday',hour:config.schedule.hour,minute:config.schedule.minute,catch_up_hours:12},update:updateSchedule};
manifest.implemented.push('freshest working temperature selection across both Canaveral buoys','immutable effective subject with date and deliberate test marker','Thursday through Tuesday calendar','durable Friday decision evaluation and suppression','shared post-final-alert comparison','atomic edition allocation and immutable candidate recovery','delivery-side persisted update validation');
manifest.production_state={verified:'2026-10-23',weekly_runs_observed:['2026-10-07','2026-10-14','2026-10-21'],enabled_subscribers:6,deployed_migrations:[1,2,3,4],update_deployed:false};
manifest.pending=['step 02 rough-seas humor','step 03 community research','step 04 controlled production rollout and recipient test','production recipient inbox confirmation','real additional-location adapters when selected'];
fs.writeFileSync(path.join(outputRoot,'manifest.json'),JSON.stringify(manifest,null,2)+'\n');
console.log('Built step 01 six-day/Friday bundle; six existing workflow IDs retained.');

// Step 02: recompute freshness at the last alert boundary before retaining quips.
const finalAlertNode=loc.data.nodes.find(n=>n.name==='Apply Final Alert Recheck');
finalAlertNode.parameters.jsCode=finalAlertNode.parameters.jsCode.replace('refreshDailyAfterAlerts(c,changed);','c.report.decision_checked_at=e.retrieved_at;refreshDailyAfterAlerts(c,changed);');
loc.save('20-location-report.json');
manifest.bundle_version='0.10.0-rough-seas-humor';manifest.phase='steps 01–02 locally implemented; production remains 0.8.0';
manifest.rough_seas={policy_version:'fresh-forecast-over-eight-v1',threshold_ft:8,threshold_comparison:'strictly_greater_than_unrounded',max_words:24,max_characters:220,writer_failure:'stable_dated_scoped_fallback_without_repair'};
manifest.implemented.push('fresh interval-scoped LLM rough-seas humor strictly above eight feet','bounded optional quip validation with deterministic fallback','final-alert scope/freshness recomputation and historical Thursday preservation');
manifest.pending=manifest.pending.filter(p=>p!=='step 02 rough-seas humor');
fs.writeFileSync(path.join(outputRoot,'manifest.json'),JSON.stringify(manifest,null,2)+'\n');
console.log('Built step 02 scoped rough-seas humor and fallbacks; production remains untouched.');

// Step 03: acquisition is independent; report generation only reads the cache.
const researchW=new Workflow('Fishing Report — Community Research','fishing_research_v1');
researchW.node('Manual Research Only','manualTrigger');
researchW.code('Manual Research Settings',`return [{json:{trigger:'manual',namespace:'test',request_id:'manual-'+Date.now()}}];`);
researchW.node('Research Child Input','executeWorkflowTrigger',{inputSource:'passthrough'});
const researchSchedule=communityDefaults();
function communityDefaults(){return config.community_research.schedule;}
for(const [name,day,hour] of [['Wednesday Research',3,researchSchedule.wednesday_hour],['Friday Research',5,researchSchedule.friday_hour]]){
 researchW.node(name,'scheduleTrigger',{rule:{interval:[{field:'weeks',weeksInterval:1,triggerAtDay:[day],triggerAtHour:hour,triggerAtMinute:researchSchedule.minute}]}});
 researchW.link(name,'Scheduled Research Settings');
}
researchW.node('Hourly Research Recovery','scheduleTrigger',{rule:{interval:[{field:'hours',hoursInterval:1,triggerAtMinute:35}]}});
researchW.code('Scheduled Research Settings',`return [{json:{trigger:'scheduled',compiled_schedule:${JSON.stringify(researchSchedule)}}}];`);
researchW.code('Keep Research Input',`return [{json:{...$input.first().json,execution_id:$execution.id}}];`);
researchW.pg('Load Research Configuration',`SELECT $1::jsonb AS input,value AS config FROM configuration WHERE key='main';`);
researchW.code('Build Bounded Research Job',`const {input,config}=$input.first().json;validateConfig(config);return config.locations.filter(l=>l.enabled&&(!input.location_id||l.id===input.location_id)).map(l=>({json:communityJob({...input,location_id:l.id},config)}));`);
researchW.pg('Claim Independent Research Lease','SELECT claim_research($1::jsonb) AS job;');
researchW.code('Unwrap Research Claim',`return [{json:$input.first().json.job}];`);
researchW.iff('Research Lease Acquired?','={{ $json.claimed === true }}');
researchW.http('Acquire Public Research','http://writer:8081/research','json','POST','={{ JSON.stringify($json) }}');
const researchHttp=researchW.data.nodes.find(n=>n.name==='Acquire Public Research');researchHttp.parameters.options.timeout=185000;researchHttp.retryOnFail=false;
researchW.code('Validate Research Response',`const c=$('Unwrap Research Claim').first().json,r=$input.first().json,b=r.body??r;const statuses=['completed','completed_empty','partial','access_unavailable','rate_limited','failed','skipped','disabled'];let result=(!r.error&&statuses.includes(b.status)&&Array.isArray(b.records))?b:{status:'failed',records:[],error:'acquisition_transport_failure'};if(JSON.stringify(result).length>120000||result.records.length>40)result={status:'failed',records:[],error:'research_response_budget'};const valid=result.records.every(e=>e.provenance_type==='verified_public_community'&&e.location_id===c.location_id&&communityUrl(e.url)&&e.provider!=='reddit'&&typeof e.excerpt==='string'&&e.excerpt.length<=500);if(!valid)result={status:'failed',records:[],error:'invalid_observation_contract'};return [{json:{...c,result}}];`);
researchW.pg('Persist Research Batch','SELECT finish_research($1::jsonb) AS outcome;');
researchW.code('Research Only Outcome',`return [{json:$input.first().json.outcome||{job_id:$json.job_id,status:$json.status||'skipped',email_sent:false}}];`);
researchW.chain('Manual Research Only','Manual Research Settings','Keep Research Input');researchW.link('Research Child Input','Keep Research Input');researchW.link('Hourly Research Recovery','Scheduled Research Settings');researchW.chain('Scheduled Research Settings','Keep Research Input','Load Research Configuration','Build Bounded Research Job','Claim Independent Research Lease','Unwrap Research Claim','Research Lease Acquired?');
researchW.link('Research Lease Acquired?','Acquire Public Research',0);researchW.link('Research Lease Acquired?','Research Only Outcome',1);
researchW.chain('Acquire Public Research','Validate Research Response','Persist Research Batch','Research Only Outcome');
researchW.note('Research only: no report/delivery/email children. Default Wednesday 17:00 and Friday 05:00 America/New_York, hourly :35 recovery within six hours, three preflight attempts fifteen minutes apart, at most one model invocation across the job. Main configuration community_research.enabled controls acquisition. Manual defaults to test namespace; child callers provide a stable request_id for replay. Report writing preempts discovery. Migration 006 required. Rebuild and republish after changing schedule. Exports remain inactive.');
researchW.save('50-community-research.json');
// Community history must still exist in the retained authoritative cache. A
// removed/expired observation cannot be revived from an old immutable report.
const historyNode=loc.data.nodes.find(n=>n.name==='Load Archived Local Fishing History');
historyNode.parameters.query=historyNode.parameters.query.replace("AND e.evidence->>'source_id' IN (SELECT jsonb_array_elements_text($1::jsonb#>'{location,fishing_sources}'))",`AND r.namespace=$1::jsonb->>'namespace' AND (e.evidence->>'source_id' IN (SELECT jsonb_array_elements_text($1::jsonb#>'{location,fishing_sources}')) OR (e.evidence->>'provenance_type'='verified_public_community' AND EXISTS(SELECT 1 FROM research_observations o JOIN research_batches b ON b.batch_id=o.batch_id WHERE o.identity=COALESCE(e.evidence->>'history_original_evidence_id',e.evidence->>'evidence_id') AND o.expires_at>now() AND b.namespace=$1::jsonb->>'namespace' AND b.location_id=$1::jsonb->>'location_id')))`);
loc.pg('Read Cached Community Research',`SELECT $1::jsonb AS context,cached_research($1::jsonb->>'namespace',$1::jsonb->>'location_id') AS research;`);
loc.code('Attach Reaged Community Cache',`const {context:c,research:r}=$input.first().json;const e=communityCache(r?.batch,r?.latest,c);c.community_research={status:e.detail_status,batch_id:e.batch_id,retrieved_at:e.retrieved_at,providers:e.providers};c.collectors.push(e);c.evidence=deduplicateEvidence([...c.evidence,...e.records]);return [{json:c}];`);
delete loc.data.connections['Refresh History Dates and Combine Evidence'];
loc.chain('Refresh History Dates and Combine Evidence','Read Cached Community Research','Attach Reaged Community Cache','Read Cached Ocean Features','Normalize Optional Ocean Features','Validate and Render Factual Briefing');
loc.data.connections['Collect Fishing Sources?'].main[1]=[{node:'Read Cached Community Research',type:'main',index:0}];
loc.save('20-location-report.json');
manifest.workflows['50-community-research.json']=researchW.data.name;
manifest.bundle_version='0.11.0-community-research';manifest.phase='steps 01–03 locally implemented; production remains 0.8.0';manifest.migrations=[1,2,3,4,5,6];manifest.workflow_ids.push(researchW.data.id);manifest.community_research={...config.community_research,model_invocations_per_job:1,max_query_strings:2,max_web_calls:2,max_host_requests:4,max_page_bytes:500000,max_response_bytes:120000,writer_priority:'preempt_research',direct_reddit:'disabled_without_approved_oauth'};
manifest.implemented.push('independent durable community research jobs and bounded read-only acquisition','verified direct public post provenance; unverified discovery URLs kept separate','re-aged applicable cache with regional Ponce separation and diversified writer packet');manifest.pending=manifest.pending.filter(p=>p!=='step 03 community research');
fs.writeFileSync(path.join(outputRoot,'manifest.json'),JSON.stringify(manifest,null,2)+'\n');
console.log('Built step 03 independent community research workflow; seven inactive exports.');
// Step 05: the ocean refresh is a separate inactive n8n schedule. The helper
// acquires only the bounded MUR regional background and remains env-gated.
const oceanAcquire=new Workflow('Fishing Report — Ocean Feature Cache','fishing_ocean_acquisition_v1');
oceanAcquire.data.settings.timezone=config.schedule.timezone;
oceanAcquire.data.settings.saveDataSuccessExecution='all';
oceanAcquire.node('Ocean Refresh Input','executeWorkflowTrigger',{inputSource:'passthrough'});
oceanAcquire.node('Manual Ocean Refresh','manualTrigger');
oceanAcquire.code('Manual Ocean Refresh Settings',`return [{json:{trigger:'manual'}}];`);
for(const [name,day,hour] of [['Wednesday Ocean Refresh',3,17],['Friday Ocean Refresh',5,5]]){
 oceanAcquire.node(name,'scheduleTrigger',{rule:{interval:[{field:'weeks',weeksInterval:1,triggerAtDay:[day],triggerAtHour:hour,triggerAtMinute:30}]}});
 oceanAcquire.code(name+' Settings',`return [{json:{trigger:'scheduled'}}];`);
 oceanAcquire.link(name,name+' Settings');
}
oceanAcquire.http('Acquire Bounded Ocean Background','http://helper:8080/ocean-acquire','json','POST','={{ JSON.stringify({location_id:$json.location_id}) }}');
const oceanHttp=oceanAcquire.data.nodes.find(n=>n.name==='Acquire Bounded Ocean Background');oceanHttp.parameters.options.timeout=300000;oceanHttp.retryOnFail=false;
oceanAcquire.code('Validate Ocean Refresh Outcome',`const r=$input.first().json,b=r.body??r;const accepted=['disabled','ok','analysis_only','partial','stale','unavailable'];if(r.error)return [{json:{location_id:${JSON.stringify(config.locations[0].id)},status:'unavailable',error:String(r.error).slice(0,180),email_sent:false}}];if(b.location_id!=='port_canaveral_fl'||!accepted.includes(b.status)||JSON.stringify(b).length>250000)return [{json:{location_id:${JSON.stringify(config.locations[0].id)},status:'failed',error:'invalid_ocean_summary_contract',email_sent:false}}];return [{json:{location_id:b.location_id,snapshot_id:b.snapshot_id,status:b.status,acquisition_status:b.acquisition_status,analysis_status:b.analysis_status,generated_at:b.generated_at,retrieved_at:b.retrieved_at,feature_count:Array.isArray(b.features)?b.features.length:0,map_hash:b.map?.sha256||null,warnings:b.warnings||[],email_sent:false}}];`);
oceanAcquire.chain('Manual Ocean Refresh','Manual Ocean Refresh Settings','Acquire Bounded Ocean Background','Validate Ocean Refresh Outcome');
oceanAcquire.chain('Wednesday Ocean Refresh Settings','Acquire Bounded Ocean Background');
oceanAcquire.chain('Friday Ocean Refresh Settings','Acquire Bounded Ocean Background');
oceanAcquire.note('Imports inactive. n8n owns Wednesday 17:30 and Friday 05:30 America/New_York scheduling. The helper feature gate defaults false. When owner-enabled, it fetches only a bounded MUR regional analysis background; it does not claim observed breaks or model currents. No email/report/delivery path. Current NOAA observed ACSPO and HYCOM providers remain disabled pending live subset verification.');
oceanAcquire.pg('Load Ocean Configuration',`SELECT $1::jsonb AS input,value AS config FROM configuration WHERE key='main';`);
oceanAcquire.code('Select Configured Ocean Locations',`const {input,config}=$input.first().json;return config.locations.filter(l=>l.enabled&&(!input.location_id||l.id===input.location_id)).map(l=>({json:{location_id:l.id}}));`);
for(const name of ['Manual Ocean Refresh Settings','Wednesday Ocean Refresh Settings','Friday Ocean Refresh Settings'])oceanAcquire.data.connections[name]={main:[[{node:'Load Ocean Configuration',type:'main',index:0}]]};
oceanAcquire.chain('Ocean Refresh Input','Load Ocean Configuration','Select Configured Ocean Locations','Acquire Bounded Ocean Background');
oceanAcquire.data.nodes.find(n=>n.name==='Validate Ocean Refresh Outcome').parameters.jsCode=`const r=$input.first().json,b=r.body??r;const expected=$('Select Configured Ocean Locations').item.json.location_id;if(r.error||b.location_id!==expected||b.status!=='disabled'&&b.acquisition_status!=='ok'||!['disabled','analysis_only','ok','partial','stale','unavailable'].includes(b.status))throw new Error('Invalid ocean refresh response');return [{json:{location_id:b.location_id,snapshot_id:b.snapshot_id,status:b.status,acquisition_status:b.acquisition_status,email_sent:false}}];`;
for(const n of oceanAcquire.data.nodes.filter(n=>n.type.endsWith('.scheduleTrigger')))n.parameters.misfirePolicy='coalesce';
loc.child('Refresh Ocean Cache Before Report','fishing_ocean_acquisition_v1');
loc.data.nodes.find(n=>n.name==='Refresh Ocean Cache Before Report').onError='continueRegularOutput';
loc.data.connections['Attach Reaged Community Cache']={main:[[{node:'Refresh Ocean Cache Before Report',type:'main',index:0}]]};
loc.data.connections['Refresh Ocean Cache Before Report']={main:[[{node:'Read Cached Ocean Features',type:'main',index:0}]]};
loc.data.nodes.find(n=>n.name==='Read Cached Ocean Features').parameters.url='={{ "http://helper:8080/ocean-features/"+$("Attach Reaged Community Cache").first().json.location_id }}';
fs.writeFileSync(path.join(outputRoot,'workflows/20-location-report.json'),JSON.stringify(loc.data,null,2)+'\n');
oceanAcquire.save('55-ocean-acquisition.json');
manifest.workflows['55-ocean-acquisition.json']=oceanAcquire.data.name;
manifest.workflow_ids.push(oceanAcquire.data.id);
manifest.schedules.ocean_features={timezone:'America/New_York',wednesday:{hour:17,minute:30},friday:{hour:5,minute:30},state:'draft_inactive'};
manifest.implemented.push('inactive n8n ocean-cache refresh schedule','bounded MUR analyzed-background cache and map path','location-scoped disabled-by-default ocean summary contract');
manifest.pending.push('verified ACSPO observed regional subset and quality/time check','verified current HYCOM numerical subset','real clear/cloudy map inspection and immutable map retry acceptance');
fs.writeFileSync(path.join(outputRoot,'manifest.json'),JSON.stringify(manifest,null,2)+'\n');

// Worldwide collectors use the same internal interval/envelope contracts.
loc.iff('Worldwide Provider?','={{ $json.location.marine_provider === "open_meteo" }}');
loc.http('Collect Worldwide Marine and Tides','http://helper:8080/global-collect','json','POST','={{ JSON.stringify({location:$json.location,window:$json.window}) }}');
loc.data.nodes.find(n=>n.name==='Collect Worldwide Marine and Tides').parameters.options.timeout=240000;
loc.data.nodes.find(n=>n.name==='Collect Worldwide Marine and Tides').retryOnFail=false;
loc.code('Normalize Worldwide Collectors',`const c=$('Worldwide Provider?').first().json,r=$input.first().json,b=r.body??r;if(r.error||b.location_id!==c.location_id||!Array.isArray(b.collectors)){c.collectors.push({source_id:'nws_alerts',location_id:c.location_id,status:'failed',records:[],warnings:['Worldwide collector unavailable'],error:'Provider unavailable'});}else{invariant(b.collectors.every(e=>e.location_id===c.location_id),'Mixed provider location');c.collectors.push(...b.collectors);}return [{json:c}];`);
loc.code('Marine Collector Context','return $input.all();');
loc.data.connections['Synthetic Fixture?'].main[1]=[{node:'Worldwide Provider?',type:'main',index:0}];
loc.link('Worldwide Provider?','Collect Worldwide Marine and Tides',0);loc.link('Worldwide Provider?','Marine Alerts',1);
loc.chain('Collect Worldwide Marine and Tides','Normalize Worldwide Collectors','Marine Collector Context');
loc.data.connections[lastMarine]={main:[[{node:'Marine Collector Context',type:'main',index:0}]]};
loc.data.connections['Load Synthetic Marine Fixtures']={main:[[{node:'Marine Collector Context',type:'main',index:0}]]};
loc.link('Marine Collector Context','Compute Astronomy');
loc.data.nodes.find(n=>n.name==='Normalize Astronomy').parameters.jsCode=core+`\nconst c=$('Marine Collector Context').first().json;const r=$input.first().json,b=r.body??r;let e=envelope(c,'skyfield_de421',r);if(e.status!=='failed'&&Array.isArray(b.records))e={...e,...b,location_id:c.location_id};c.collectors.push(e);return [{json:c}];`;
loc.iff('Worldwide Final Alerts?','={{ $json.location.marine_provider === "open_meteo" }}');
loc.http('Recheck Worldwide Alerts','http://helper:8080/global-alerts','json','POST','={{ JSON.stringify({location:$json.location}) }}');
loc.data.connections['Live Alert Recheck Required?'].main[0]=[{node:'Worldwide Final Alerts?',type:'main',index:0}];
loc.link('Worldwide Final Alerts?','Recheck Worldwide Alerts',0);loc.link('Worldwide Final Alerts?','Recheck Alerts Before Final Archive',1);
loc.link('Recheck Worldwide Alerts','Apply Final Alert Recheck');
// A custom configuration compiles timezone and schedule settings into its private build.
for(const w of [setup,scheduler,loc,delivery,sourceW,failure,researchW,oceanAcquire]){
 w.data.settings.timezone=config.schedule.timezone;
 for(const n of w.data.nodes){delete n.credentials;if(n.type.endsWith('.emailSend'))n.disabled=true;}
 w.data.active=false;w.data.pinData={};
}
manifest.phase='portable source distribution; inactive safe defaults';delete manifest.production_state;
manifest.bundle_version='1.0.0-portable';manifest.providers=['noaa','open_meteo','worldtides','MUR'];
fs.writeFileSync(path.join(outputRoot,'manifest.json'),JSON.stringify(manifest,null,2)+'\n');

// Write each fully assembled export once. Repeated staged writes can collide
// with OneDrive's file scanner on the owner workstation.
fs.mkdirSync(path.join(outputRoot,'workflows'),{recursive:true});
for(const w of [setup,scheduler,loc,delivery,sourceW,failure,researchW,oceanAcquire]){
 const file=path.join(outputRoot,'workflows',w.filename),bytes=JSON.stringify(w.data,null,2)+'\n';
 for(let attempt=0;;attempt++){try{fs.writeFileSync(file,bytes);break;}catch(e){if(attempt>=12||!['UNKNOWN','EBUSY','EPERM'].includes(e.code))throw e;Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,250);}}
}
console.log('Built inactive ocean feature cache workflow; no scheduler was activated.');
