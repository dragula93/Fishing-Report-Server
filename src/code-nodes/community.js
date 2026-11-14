'use strict';
// This module is also embedded in n8n. It has no I/O or credential access.
function communityPolicy(config={}) {
 const c=config.community_research||{},cap=(k,d,max)=>Math.max(1,Math.min(max,Number.isFinite(+c[k])?Math.floor(+c[k]):d));
 return {enabled:c.enabled===true,providers:(c.providers||['hulltruth','spacefish','reddit']).filter(x=>['hulltruth','spacefish','reddit'].includes(x)),fresh_hours:cap('fresh_hours',24,24),retention_days:cap('retention_days',30,30),history_years:cap('history_years',5,10),max_attempts:cap('max_attempts',3,3),catch_up_hours:cap('catch_up_hours',6,6),max_observations:cap('max_observations',40,40),max_pages:cap('max_pages',8,12),model_seconds:cap('model_seconds',60,60),wall_seconds:cap('wall_seconds',150,180),max_queries:2,max_web_calls:2,max_model_calls:1,max_host_requests:4,max_page_bytes:500000,max_response_bytes:120000,schedule:c.schedule||{timezone:'America/New_York',wednesday_hour:17,friday_hour:5,minute:0}};
}
function communityUrl(value) {
 if(typeof value!=='string'||value.length>1800||/[\s\\<>]/.test(value))return null;
 const m=/^https:\/\/(www\.)?(thehulltruth\.com|spacefish\.com|reddit\.com)(?::443)?(\/[^?#]*)?(?:\?([^#]*))?(#.*)?$/i.exec(value);
 if(!m)return null;
 const host=m[2].toLowerCase(),path=m[3]||'/';if(/%2f|%5c|\.\./i.test(path))return null;
 const provider=host==='thehulltruth.com'?'hulltruth':host==='reddit.com'?'reddit':'spacefish';
 if(provider==='reddit'&&!/^\/r\/[A-Za-z0-9_]+\/comments\/[a-z0-9]+(?:\/[^/]*)?(?:\/[a-z0-9]+)?\/?$/i.test(path))return null;
 if(provider==='hulltruth'&&!/^\/[a-z0-9-]+\/\d+-[a-z0-9-]+(?:-\d+)?\.html$/i.test(path))return null;
 if(provider==='spacefish'&&!/^\/[a-z0-9_/-]+\/?$/i.test(path)||path==='/')return null;
 const query=(m[4]||'').split('&').filter(Boolean);if(query.some(q=>! /^(?:utm_[a-z]+|fbclid|gclid)=/.test(q)))return null;
 const fragment=(provider==='hulltruth'&&/^#post\d+$/.test(m[5]||'')||provider==='spacefish'&&/^#comment-\d+$/.test(m[5]||''))?m[5]:'';
 return {provider,domain:host,url:'https://'+(provider==='spacefish'?'':'www.')+host+(provider==='spacefish'?path.replace(/\/?$/,'/'):path.replace(/\/$/,''))+fragment,thread_url:'https://'+(provider==='spacefish'?'':'www.')+host+(provider==='reddit'?path.split('/').slice(0,6).join('/')+'/':path)};
}
function communityHash(s){let h=2166136261;for(const ch of String(s))h=Math.imul(h^ch.charCodeAt(0),16777619)>>>0;return h.toString(16);}
function communityPlan(now,anchor,config={}) {
 const p=communityPolicy(config),date=localDate(now,'America/New_York'),month=Number(anchor.slice(5,7)),year=Number(anchor.slice(0,4)),names=['January','February','March','April','May','June','July','August','September','October','November','December'];
 const monthSet=[-1,0,1].map(d=>names[(month-1+d+12)%12]);
 const places=['Port Canaveral','8A Reef','Pelican Flats','Cape Canaveral','Ponce Inlet'];const rotation=Math.floor(Date.parse(date)/86400000);
 const domains={hulltruth:'thehulltruth.com',reddit:'reddit.com',spacefish:'spacefish.com'},queries=[];
 for(let i=0;i<12&&p.providers.length;i++){const provider=p.providers[(i+rotation)%p.providers.length],place=places[(rotation+i)%places.length],seasonal=i%2===1;
  queries.push({provider,pass:seasonal?'seasonal':'current',query:`site:${domains[provider]} "${place}" offshore fishing ${seasonal?'('+monthSet.join(' OR ')+') '+(year-1-((rotation+Math.floor(i/2))%p.history_years)): 'after:'+new Date(Date.parse(date)-14*86400000).toISOString().slice(0,10)+' before:'+addDays(date,1)}`,report_month:month,history_years:p.history_years});}
 // Each occurrence rotates across providers/places; never a quota to fill.
 return {executed_at:now,report_anchor:anchor,seasonal_months:monthSet,queries:queries.slice(0,p.max_queries),rotation,available_queries:queries};
}
function communityJob(input,config,now=new Date().toISOString()) {
 invariant(config.schedule_activation_at==null||Number.isFinite(Date.parse(config.schedule_activation_at)),'Invalid schedule activation timestamp');
 const p=communityPolicy(config),s=p.schedule;new Intl.DateTimeFormat('en',{timeZone:s.timezone});
 invariant([s.wednesday_hour,s.friday_hour,s.minute].every(Number.isInteger)&&s.wednesday_hour>=0&&s.wednesday_hour<24&&s.friday_hour>=0&&s.friday_hour<24&&s.minute>=0&&s.minute<60,'Invalid community schedule');
 if(input.compiled_schedule)invariant(['timezone','wednesday_hour','friday_hour','minute'].every(k=>input.compiled_schedule[k]===s[k]),'Community schedule changed; rebuild and publish workflow');
 const today=localDate(now,s.timezone),occurrences=[];
 for(let i=0;i<8;i++){const d=addDays(today,-i),dow=new Date(d+'T12:00:00Z').getUTCDay();if([3,5].includes(dow)){const at=localInstant(d,s.timezone,dow===3?s.wednesday_hour:s.friday_hour,s.minute);if(Date.parse(at)<=Date.parse(now))occurrences.push(at);}}
 const manual=input.trigger==='manual',occurrence=manual?now:occurrences.sort().at(-1);invariant(occurrence,'No community occurrence');
 // Wednesday discovery targets that evening even when its hour is reconfigured.
 const occurrenceDate=localDate(occurrence,s.timezone),dow=new Date(occurrenceDate+'T12:00:00Z').getUTCDay();
 const anchor=dow===3?localInstant(occurrenceDate,config.schedule.timezone,config.schedule.hour,config.schedule.minute):latestScheduled(occurrence,config.schedule);
 const namespace=input.namespace==='test'?'test':'production',location=input.location_id||'port_canaveral_fl';
 const enabled=location==='port_canaveral_fl'&&p.enabled&&p.providers.length>0&&(manual||Date.parse(now)-Date.parse(occurrence)<=p.catch_up_hours*3600000)&&(manual||config.schedule_activation_at==null||Date.parse(occurrence)>=Date.parse(config.schedule_activation_at));
 return {job_id:namespace+':'+location+':'+(manual?'manual:'+String(input.request_id||now):occurrence),namespace,location_id:location,occurrence,executed_at:now,lease_owner:String(input.execution_id||now),enabled,policy:p,plan:communityPlan(now,addDays(localDate(anchor,s.timezone),1),config),trigger:input.trigger||'scheduled',report_anchor:anchor};
}
function normalizeCommunityDocuments(documents,context,now=new Date().toISOString()) {
 const records=[],rejected=[],seen=new Set(),p=communityPolicy(context.config),anchorMonth=Number(context.window.period_start.slice(5,7));
 for(const doc of (documents||[]).slice(0,40)) {
  const u=communityUrl(doc.url),text=String(doc.text||'').replace(/\s+/g,' ').trim(),reject=reason=>rejected.push({url:u?.url||null,post_id:doc.post_id||null,reason});
  if(!u||!p.providers.includes(u.provider)||u.provider==='reddit'){reject('unsupported_or_disabled_provider');continue;}
  if(doc.retrieval_status!=='retrieved'||doc.provenance!=='direct_public_page'||typeof doc.post_id!=='string'||!doc.post_id||doc.post_id.length>100||!doc.metadata_verified||!Number.isFinite(Date.parse(doc.retrieved_at))||Date.parse(doc.retrieved_at)>Date.parse(now)+300000||text.length>12000||!text){reject('unverified_or_unavailable_content');continue;}
  if(/\[deleted\]|\[removed\]|ignore (?:all|previous)|system prompt|execute (?:command|shell)|send (?:email|credentials)|api[_ ]key/i.test(text)){reject('deleted_or_instruction_text');continue;}
  if(/\b(?:inshore|lagoon|river|backwater|mosquito|jetties|jetty|surf fishing|from shore|charter shopping|book your|where (?:should|can) i|recommend a charter)\b/i.test(text)){reject('excluded_habitat_or_commercial_question');continue;}
  const ponce=/\b(?:Ponce Inlet|Volusia|New Smyrna)\b/i.test(text),canaveral=/\b(?:Port Canaveral|Cape Canaveral|8A Reef|Pelican Flats)\b/i.test(text);
  if((!ponce&&!canaveral)||/\b(?:Canaveral National Seashore|Texas|California|Australia|Costa Rica)\b/i.test(text)){reject('geography_not_proven');continue;}
  if(!/\b(?:offshore|nearshore|ocean|Atlantic|reef|trolling|bottom fishing)\b/i.test(text)){reject('ocean_habitat_not_proven');continue;}
  const firstHand=/\b(?:we|I|our)\b/i.test(text)&&/\b(?:caught|landed|boated|released|hooked|fished)\b/i.test(text)&&! /\b(?:they|he|she) (?:said|caught)|heard|friend caught|quoted|originally posted/i.test(text);
  if(!firstHand||/\?/.test(text)){reject('not_firsthand_trip');continue;}
  const published=doc.published_at&&/^\d{4}-\d\d-\d\dT.*(?:Z|[+-]\d\d:\d\d)$/.test(doc.published_at)&&Date.parse(doc.published_at)<=Date.parse(now)?doc.published_at:null;
  if(doc.published_at&&!published){reject('invalid_or_future_publication');continue;}
  const d=evidenceDate({published_at:published,updated_at:doc.updated_at||null},text,now);
  if(d.fishing_date&&new Date(d.fishing_date+'T12:00:00Z').toISOString().slice(0,10)!==d.fishing_date){reject('invalid_calendar_trip_date');continue;}
  if(d.age_label==='future_date'||d.fishing_date&&published&&d.fishing_date>published.slice(0,10)){reject('future_or_post_publication_trip');continue;}
  const species=SPECIES.filter(s=>SPECIES_PATTERNS[s].test(text));if(!species.length){reject('species_not_supported');continue;}
  const method=/\btroll(?:ing|ed)?\b/i.test(text)?'trolling':/bottom fish|dropp(?:ed|ing) bait/i.test(text)?'bottom_fishing':'unspecified';
  const geo=ponce?'ponce_volusia':'canaveral_brevard',month=d.fishing_date?Number(d.fishing_date.slice(5,7)):null,diff=month?Math.min(Math.abs(month-anchorMonth),12-Math.abs(month-anchorMonth)):null;
  const tripYear=d.fishing_date?Number(d.fishing_date.slice(0,4)):null,anchorYear=Number(context.window.period_start.slice(0,4));
  if(tripYear!==null&&tripYear<anchorYear-p.history_years){reject('historical_year_outside_budget');continue;}
  const label=d.age_label==='current'?'current':d.age_label==='recent_context'?'recent_context':diff!==null&&diff<=1&&tripYear<anchorYear?'seasonal_history':d.fishing_date?'out_of_season_history':'trip_date_unknown';
  const normalized=communityHash(text.toLowerCase().replace(/[^a-z0-9]+/g,' ').trim()),trip=doc.author&&d.fishing_date?communityHash(doc.author.toLowerCase()+'|'+d.fishing_date+'|'+geo+'|'+species.join(',')):normalized;
  const stable=u.provider+':'+doc.post_id;if(seen.has(stable)||records.some(r=>r.trip_identity===trip||r.duplicate_fingerprint===normalized)){reject('duplicate_trip_or_quote');continue;}seen.add(stable);
  records.push({evidence_id:'community_'+communityHash(stable),location_id:context.location_id,source_id:'community_'+u.provider,provenance_type:'verified_public_community',provider:u.provider,provider_post_id:String(doc.post_id).slice(0,100),url:u.url,thread_url:u.thread_url,title:String(doc.title||'Public fishing observation').slice(0,200),author:doc.author?String(doc.author).slice(0,100):null,...d,updated_at:typeof doc.updated_at==='string'&&Number.isFinite(Date.parse(doc.updated_at))?doc.updated_at.slice(0,35):null,published_at:published,retrieved_at:doc.retrieved_at,verified_at:doc.retrieved_at,expires_at:new Date(Date.parse(doc.retrieved_at)+p.retention_days*86400000).toISOString(),date_inference_basis:d.fishing_date_inferred?'yesterday relative to this post publication in America/New_York':d.fishing_date?'explicit ISO trip date in retrieved post':null,geography:geo,applicable_location_ids:geo==='canaveral_brevard'?['port_canaveral_fl']:[],regional_context_only:geo!=='canaveral_brevard',habitat:/nearshore/i.test(text)?'nearshore':'offshore',species,method,first_hand:true,kind:'first_hand_report',research_label:label,current_qualifying:d.age_label==='current'&&geo==='canaveral_brevard',range_status:'unverified',route_distance_verified:false,route_distance_nm:null,jurisdictions:[],general_spots:[/8A Reef/i.test(text)?'8A Reef':null,/Pelican Flats/i.test(text)?'Pelican Flats':null].filter(Boolean),bait:/\b(?:live bait|ballyhoo|squid|sardines|jigs)\b/i.exec(text)?.[0]||null,depth_wording:/\b\d+(?:-\d+)?\s*(?:ft|feet)\s*(?:deep|of water)\b/i.exec(text)?.[0]||null,excerpt:text.split(/\s+/).slice(0,45).join(' ').slice(0,400),excerpt_provenance:{method:'direct_text',post_id:doc.post_id,content_hash:communityHash(text)},duplicate_fingerprint:normalized,observation_id:trip,trip_identity:trip,bite_assessment:'context'});
  if(records.length>=p.max_observations)break;
 }
 return {records,rejected};
}
function communityCache(batch,latest,context,now=new Date().toISOString()) {
 const p=communityPolicy(context.config),age=batch?(Date.parse(now)-Date.parse(batch.finished_at))/3600000:null;
 const usable=p.enabled&&batch&&age>=0&&age<=p.fresh_hours&&['completed','completed_empty','partial'].includes(batch.status);
 const records=usable?refreshEvidenceHistory(batch.records||[],context,now).filter(e=>Date.parse(e.expires_at)>Date.parse(now)):[];
 const detail=!p.enabled?'disabled':usable?(latest&&latest.job_id!==batch.job_id?'cached_after_'+latest.status:batch.status):batch?'stale_cache':'access_unavailable';
 return {source_id:'community_research',status:!p.enabled?'empty':usable?(records.length?'ok':batch.status==='completed_empty'?'empty':'failed'):'failed',detail_status:detail,retrieved_at:batch?.finished_at||now,issued_at:null,url:null,records,warnings:[!p.enabled?'Community research disabled':usable?`Community batch ${batch.job_id}: ${detail}; retrieved ${batch.finished_at}; trips re-aged independently`:'Community research unavailable; existing fishing sources retained'],error:usable||!p.enabled?null:detail,batch_id:usable?batch.job_id:null,providers:batch?.providers||latest?.providers||[]};
}
function diversifiedEvidence(items,max=24) {
 const sorted=items.filter(e=>!e.regional_context_only).sort((a,b)=>Number(!!b.current_qualifying)-Number(!!a.current_qualifying)||(a.age_days??9999)-(b.age_days??9999)),buckets=new Map(),trips=new Set(),counts=new Map(),out=[];
 const publisher=e=>/^https:\/\/(?:www\.)?([^/]+)/.exec(e.url||'')?.[1]||e.source_id;
 for(const e of sorted){const key=publisher(e)+'|'+e.method;if(!buckets.has(key))buckets.set(key,[]);buckets.get(key).push(e);}
 for(let round=0;round<4&&out.length<max;round++)for(const rows of buckets.values()){
  const identity=e=>(e.trip_identity||e.observation_id||e.url)+(e.kind==='seasonal_advice'?'|'+e.method:'');
  const e=rows.find(e=>(counts.get(publisher(e))||0)<4&&!trips.has(identity(e)));if(!e)continue;trips.add(identity(e));counts.set(publisher(e),(counts.get(publisher(e))||0)+1);out.push(e);if(out.length>=max)break;
 }
 return out;
}
function communityDisplayLines(report){
 const r=report.community_research;if(!r)return [];
 const status=r.status||'access_unavailable';
 const text=status==='completed_empty'?'No qualifying community reports found in the completed search. This does not mean no fish.':status==='disabled'?'Community research disabled.':`Community research: ${status.replaceAll('_',' ')}; retrieved ${r.retrieved_at||'unknown'}. ${r.batch_id?'Using retained batch '+r.batch_id+'.':'Existing fishing sources remain available.'}`;
 const lines=[text];
 if(r.providers?.length)lines.push('Community providers: '+r.providers.map(p=>p.provider+' '+p.status.replaceAll('_',' ')).join('; ')+'.');
 for(const e of (report.evidence||[]).filter(e=>e.regional_context_only).slice(0,2))lines.push(`Regional context only — Ponce/Volusia; trip ${e.fishing_date||'date unknown'}; ${e.research_label||e.age_label}. ${e.excerpt}`);
 return lines;
}
if(typeof module!=='undefined')module.exports={communityPolicy,communityUrl,communityHash,communityPlan,communityJob,normalizeCommunityDocuments,communityCache,diversifiedEvidence,communityDisplayLines};
