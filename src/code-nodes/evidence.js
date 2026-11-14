'use strict';
const SPECIES=['king mackerel','mahi-mahi','cobia','sailfish','wahoo','blackfin tuna','red snapper','mangrove snapper','lane snapper','mutton snapper','gag grouper','red grouper','triggerfish','amberjack','tarpon','Spanish mackerel','snook','red drum','sheepshead'];
const SPECIES_PATTERNS={'king mackerel':/\bking(?:fish|\s+mackerel|s)\b/i,'mahi-mahi':/\b(?:mahi(?:-mahi)?|dolphinfish)\b/i,'cobia':/\bcobia\b/i,'sailfish':/\bsailfish\b/i,'wahoo':/\bwahoo\b/i,'blackfin tuna':/\bblackfin(?:\s+tuna)?\b/i,'red snapper':/\bred\s+snapper\b/i,'mangrove snapper':/\bmangrove\s+snapper\b/i,'lane snapper':/\blane\s+snapper\b/i,'mutton snapper':/\bmutton\s+snapper\b/i,'gag grouper':/\bgag(?:\s+grouper)?\b/i,'red grouper':/\bred\s+grouper\b/i,'triggerfish':/\btriggerfish\b/i,'amberjack':/\bamberjack\b/i};
Object.assign(SPECIES_PATTERNS,{'tarpon':/\btarpon\b/i,'Spanish mackerel':/\bspanish\s+mackerel\b/i,'snook':/\bsnook\b/i,'red drum':/\bred\s+(?:drum|fish)\b/i,'sheepshead':/\bsheepshead\b/i});
SPECIES_PATTERNS['mangrove snapper']=/\b(?:mangrove(?:\s+snapper)?|gray\s+snapper)\b/i;
SPECIES_PATTERNS['mutton snapper']=/\bmutton(?:s|\s+snapper)?\b/i;
function sourceUrlAllowed(url,source){const m=/^https:\/\/([^/?#]+)(?:\/|$)/.exec(url);return !!m&&m[1]===source.domain&&!url.includes('?')&&!/[\s@]/.test(m[1]);}
function seasonalMonthFromTitle(title){
 const months=['january','february','march','april','may','june','july','august','september','october','november','december'];
 const match=/\b([A-Za-z]+)\s+fishing\s+(?:in|guide|forecast)\b/i.exec(title||'');
 return match&&months.includes(match[1].toLowerCase())?months.indexOf(match[1].toLowerCase())+1:null;
}
function evidenceRelevance(e,window,now=new Date().toISOString()){
 const anchor=window?.period_start||now.slice(0,10),dates=window?.dates?.length?window.dates:[anchor];
 const original=e.fishing_date||e.published_at;
 const originalTime=original?Date.parse(original):NaN;
 if(e.kind==='marketing'||e.age_label==='future_date'||Number.isFinite(originalTime)&&originalTime>Date.parse(now))return null;
 const day=original?.slice(0,10);
 const parts=Object.fromEntries(new Intl.DateTimeFormat('en-CA',{timeZone:window?.timezone||'America/New_York',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date(now)).map(p=>[p.type,p.value]));
 const age=day?(Date.parse(`${parts.year}-${parts.month}-${parts.day}`)-Date.parse(day))/86400000:NaN;
 const seasonMonth=e.seasonal_month||(e.kind==='seasonal_advice'?seasonalMonthFromTitle(e.title):null);
 const explicitSeasonal=e.kind==='seasonal_advice'&&/\bseasonal\b|\b(?:spring|summer|fall|winter)\s+(?:fishing\s+)?(?:guide|forecast|patterns?)\b/i.test((e.title||'')+' '+(e.excerpt||''));
 const seasonal=seasonMonth||explicitSeasonal||day&&day.slice(0,4)<anchor.slice(0,4);
 if(!seasonal)return Number.isFinite(age)&&age>=0&&age<=28?(e.current_qualifying?'current trip':e.fishing_date?'recent trip':'recent report; trip date uncertain'):null;
 if(!seasonMonth&&!day)return null;
 // Compare calendar dates across adjacent years; handles December/January
 // and leap years without treating whole neighboring months as eight weeks.
 let distance=Infinity;
 for(const date of dates){const year=Number(date.slice(0,4));for(const y of [year-1,year,year+1]){
  const candidates=seasonMonth?[`${y}-${String(seasonMonth).padStart(2,'0')}-01`,new Date(Date.UTC(y,seasonMonth,0)).toISOString().slice(0,10)]:[`${y}-${day.slice(5)}`];
  if(seasonMonth&&Number(date.slice(5,7))===Number(seasonMonth))distance=0;
  for(const candidate of candidates)distance=Math.min(distance,Math.abs(Date.parse(date)-Date.parse(candidate))/86400000);
 }}
 // Undated annual guides must have been fetched for this run/recently.
 if(seasonMonth&&(!Number.isFinite(Date.parse(e.retrieved_at))||Date.parse(now)-Date.parse(e.retrieved_at)>28*86400000))return null;
 return distance<=56?'seasonal history':null;
}
function relevantEvidence(items,window,now=new Date().toISOString()){
 return items.filter(e=>evidenceRelevance(e,window,now));
}
function articleCandidates(discovery,source,month=new Date().getUTCMonth()+1,now=new Date().toISOString()){
 const seen=new Set();
 const scoped=new Map((discovery.links||[]).filter(l=>l.scoped_location_id).map(l=>[l.url.trim().replace(/\/$/,''),l]));
 return (discovery.links||[]).map(link=>({...link,...(scoped.get(link.url.trim().replace(/\/$/,''))||{}),url:link.url.trim()})).filter(link=>{const key=link.url.replace(/\/$/,'');if(seen.has(key))return false;seen.add(key);return link.robots_allowed!==false&&sourceUrlAllowed(link.url,source)&&/fish|offshore|canaveral|snapper|mahi|king|report|cobia|wahoo|grouper|week|captain/i.test(link.title+' '+link.url)&&!/^https:\/\/[^/]+\/?$/.test(link.url)&&!/(?:submission|spacebyte-reports|caught-on-camera|\/charter\/|coupon|\/\d{4}\/\d{2}\/\d{2}\/$)/i.test(link.url);})
 .filter(link=>!link.published_at||!!evidenceRelevance({published_at:link.published_at},{period_start:now.slice(0,4)+'-'+String(month).padStart(2,'0')+'-'+now.slice(8,10)},now))
 .map(link=>{const monthNames=['january','february','march','april','may','june','july','august','september','october','november','december'];const namedMonth=monthNames.findIndex(m=>(link.title+' '+link.url).toLowerCase().includes(m));const delta=namedMonth<0?0:Math.min(Math.abs(month-1-namedMonth),12-Math.abs(month-1-namedMonth));return {...link,score:(link.scoped_location_id?30:0)+(link.published_at?Date.parse(link.published_at)/1e12:0)+(/report|offshore|fishing/i.test(link.title)?5:0)+(/\d{4}|\d{2}-|weekly/i.test(link.url)?10:0)+(namedMonth===month-1?25:0),seasonal_candidate:delta<=2};}).filter(l=>l.seasonal_candidate).sort((a,b)=>Number(!!b.published_at)-Number(!!a.published_at)||(b.published_at&&a.published_at?Date.parse(b.published_at)-Date.parse(a.published_at):b.score-a.score)).slice(0,source.article_limit);
}
function evidenceDate(doc,sentence,now){
 const published=doc.published_at && Number.isFinite(Date.parse(doc.published_at))?doc.published_at:null;
 let trip=null,inferred=false,original=null;
 const exact=/\b(20\d{2}-\d{2}-\d{2})\b/.exec(sentence);
 if(exact&&Number.isFinite(Date.parse(exact[1]))){trip=exact[1];original=exact[0];}
 else if(/\byesterday\b/i.test(sentence)&&published){const p=new Intl.DateTimeFormat('en-CA',{timeZone:'America/New_York',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date(published));const v=Object.fromEntries(p.map(x=>[x.type,x.value]));const d=new Date(`${v.year}-${v.month}-${v.day}T12:00:00Z`);d.setUTCDate(d.getUTCDate()-1);trip=d.toISOString().slice(0,10);inferred=true;original='yesterday';}
 const timestamp=trip?Date.parse(trip+'T00:00:00Z'):published?Date.parse(published):null;
 const parts=new Intl.DateTimeFormat('en-CA',{timeZone:'America/New_York',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date(now));const calendar=Object.fromEntries(parts.map(p=>[p.type,p.value]));
 const currentDate=Date.parse(`${calendar.year}-${calendar.month}-${calendar.day}T00:00:00Z`);
 const age=timestamp===null?null:((trip?currentDate:Date.parse(now))-timestamp)/86400000;
 // A publication date alone never establishes the trip date.
 const label=age===null?'unknown_date':age<0?'future_date':age>14?'dated_background':!trip?'published_context_trip_date_unknown':age<=7?'current':'recent_context';
 return {published_at:published,updated_at:doc.updated_at||null,fishing_date:trip,fishing_date_inferred:inferred,original_date_wording:original,age_days:age===null?null:Math.round(age*100)/100,age_label:label};
}
function extractEvidence(doc,context,now=new Date().toISOString()){
 const source=context.source;
 const title=doc.title||'Untitled fishing report';
 const seasonMonth=doc.seasonal_month||seasonalMonthFromTitle(title);
 const whole=(doc.text||'').replace(/\s+/g,' ').trim();
 const paragraphs=(doc.text||'').split(/\n+/).map(x=>x.trim()).filter(Boolean);
 const sentences=paragraphs.flatMap(paragraph=>paragraph.split(/(?<=[.!?])\s+/).map(sentence=>({sentence:sentence.trim(),paragraph})));
 const ocean=/\b(?:offshore|nearshore|ocean|atlantic|deep\s+sea|reef|wreck|beach|surf(?:\s+zones?)?|pelican|8a|troll(?:ing)?|bottom\s+fish(?:ing)?)\b/i;
 const inshore=/\b(?:inshore|lagoon|river|backwater|mosquito|banana\s+river|indian\s+river|pond|lake)\b/i;
 const scoped=doc.scoped_location_id===context.location_id;
 const terms=context.location.geography_terms||[context.location.name];const local=scoped||terms.some(t=>(title+' '+whole).toLowerCase().includes(t.toLowerCase()));
 if(!local)return [];
 const output=[];
 for(const entry of sentences){
  const {sentence,paragraph}=entry;
  if(inshore.test(sentence)||!(ocean.test(sentence)||(scoped&&ocean.test(paragraph)))||/post navigation|related posts|category:|tags:|author:|tell us whether|different experience from|not enough/i.test(sentence))continue;
  if(source.id==='spacefish_canaveral'&&!scoped&&!/canaveral/i.test(title+' '+sentence))continue;
  const sourceSpecies=(doc.species_catalog||[]).filter(s=>typeof s==='string').map(s=>s.toLowerCase());
  const catalog=[...new Set([...sourceSpecies,...SPECIES,...(context.location.species_catalog||[])])];
  const species=catalog.filter(s=>{if(typeof s!=='string'||s.length>70)return false;const pattern=SPECIES_PATTERNS[s];return pattern?pattern.test(sentence):new RegExp('\\b'+s.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'\\b','i').test(sentence);});
  if(!species.length)continue;
  const methodsIn=text=>[(/\btroll(?:ing)?\b/i.test(text)&&!/no\s+troll|not\s+troll/i.test(text))?'trolling':null,((/bottom\s+fish/i.test(text)&&!/haven.t\s+(?:been\s+)?bottom|no\s+bottom|not\s+been\s+bottom/i.test(text))||/drop(?:ping)?\s+(?:live\s+)?bait/i.test(text))?'bottom_fishing':null,/\b(?:beach|surf\s+zone|nearshore)\b/i.test(text)?'nearshore_bait':null].filter(Boolean);
  const explicitMethods=methodsIn(sentence),paragraphMethods=methodsIn(paragraph);
  let method=explicitMethods[0]||(paragraphMethods.length===1?paragraphMethods[0]:'unspecified');
  if(method==='bottom_fishing'&&!species.some(s=>sourceSpecies.includes(s)||/snapper|grouper|triggerfish|amberjack|sheepshead/.test(s)))method='unspecified';
  if(method!=='unspecified'&&!context.location.methods.includes(method))continue;
  const marketing=/book\s+(?:a|your)|reserve|discount|special\s+offer|call\s+us/i.test(sentence);
  const firstHand=/\b(?:we|our|i)\b/i.test(paragraph)&&/\b(?:caught|catching|landed|hauled\s+in|boated|released|hooked|fished|slow\s+pick|produced)\b/i.test(sentence);
  const date=evidenceDate(doc,sentence+(scoped?' '+paragraph:''),now);
  let rangeStatus='unverified',distanceNm=null;
  const distance=/\b(\d+(?:\.\d+)?)\s*(?:nautical\s+miles?|nm|nmi)\s*(?:out|offshore|from\s+(?:the\s+)?(?:inlet|port|canaveral))?/i.exec(sentence);
  if(distance){distanceNm=+distance[1];rangeStatus=distanceNm<=context.location.max_one_way_distance.value?'reported_distance_within_limit_route_unverified':'outside_limit';}
  if(rangeStatus==='outside_limit')continue;
  const depth=/\b(\d+(?:\s*[-–]\s*\d+)?)\s*(?:feet|ft)\s*(?:of\s+water|deep|depth)/i.exec(sentence);
  const bait=/\b(?:live\s+(?:pogies|menhaden|bait|pinfish)|squid|sardines|ballyhoo|shrimp|jigs?|dead\s+bait)\b/i.exec(sentence);
  const normalized=sentence.toLowerCase().replace(/[^a-z0-9]+/g,' ').trim();
  const verifiedRoute=(context.location.verified_routes||[]).find(r=>r.name&&sentence.toLowerCase().includes(r.name.toLowerCase())&&Number.isFinite(r.one_way_distance_nm)&&r.one_way_distance_nm<=context.location.max_one_way_distance.value&&r.verification_basis&&Number.isFinite(Date.parse(r.verified_at))&&Date.parse(r.verified_at)<=Date.parse(now)&&Date.parse(now)-Date.parse(r.verified_at)<=30*86400000);
  let documentHash=2166136261;for(const ch of doc.url||'')documentHash=Math.imul(documentHash^ch.charCodeAt(0),16777619)>>>0;
  output.push({evidence_id:`${context.run_id}_${source.id}_${documentHash.toString(16)}_${output.length+1}`,location_id:context.location_id,source_id:source.id,url:doc.url,title,
   author:doc.author||null,...date,retrieved_at:doc.retrieved_at,source_species:sourceSpecies,seasonal_month:seasonMonth,regional_context_only:doc.regional_context_only===true,geography:doc.regional_context_only?'regional_context':context.location_id,habitat:/\b(?:beach|surf)\b/i.test(sentence)?'beach':/\bnearshore\b/i.test(sentence)?'nearshore':'offshore',species,method,
   first_hand:firstHand,kind:marketing?'marketing':seasonMonth||/\bseasonal\b|\b(?:spring|summer|fall|winter)\s+(?:fishing\s+)?(?:guide|forecast|patterns?)\b/i.test(title)?'seasonal_advice':firstHand?'first_hand_report':'attributed_context',
   range_status:verifiedRoute?'verified_route_within_limit':rangeStatus,reported_distance_nm:distanceNm,route_distance_verified:!!verifiedRoute,route_distance_nm:verifiedRoute?.one_way_distance_nm??null,jurisdictions:verifiedRoute?.jurisdictions||[],route_verification:verifiedRoute||null,depth_wording:depth?.[0]||null,bait:bait?.[0]||null,
   general_spots:[...new Set([/\b8a\b/i.test(paragraph)?'8A Reef':null,/\bpelican\b/i.test(paragraph)?'Pelican Flats':null,/\b(?:beach|surf\s+zone)\b/i.test(sentence)?'local beach / nearshore bait schools':null,/\bwreck/i.test(sentence)?'local wrecks':null,/\breef/i.test(paragraph)?'nearshore reefs':null,/\b(?:stay|fish)\s+shallow/i.test(paragraph)?'shallow bottom areas':null,/\bweed(?:line|s)|sargassum/i.test(sentence)?'offshore weedlines':null].filter(Boolean))],
   bite_assessment:/slow\s+pick|slow(?:ed)?\s+(?:bite|fishing)|not\s+(?:that\s+)?good|not\s+on\s+fire/i.test(sentence)?'slow':/consistent|solid|great|produced|caught|landed/i.test(sentence)?'positive':'context',
   timing_associations:{moon:/\b(?:full|new|quarter)\s+moon\b/i.exec(sentence)?.[0]||null,tide:/\b(?:incoming|outgoing|rising|falling|moving|high|low)\s+(?:tide|water)\b/i.exec(sentence)?.[0]||null},
   excerpt:sentence.split(/\s+/).slice(0,45).join(' '),duplicate_fingerprint:normalized,observation_id:(doc.author||source.id).toLowerCase()+'_'+(date.fishing_date||doc.url),
   current_qualifying:date.age_label==='current'&&firstHand&&!marketing&&source.role!=='seasonal_background'});
 }
 for(const rating of doc.seasonal_ratings||[]){
  if(typeof rating.species!=='string'||rating.species.length>70||!Number.isInteger(rating.month)||rating.month<1||rating.month>12||!Number.isInteger(rating.rating)||rating.rating<0||rating.rating>5)continue;
  output.push({evidence_id:`${context.run_id}_${source.id}_rating_${output.length}`,location_id:context.location_id,source_id:source.id,url:doc.url,title,author:doc.author||null,published_at:doc.published_at||null,fishing_date:null,retrieved_at:doc.retrieved_at,seasonal_month:rating.month,seasonal_rating:rating.rating,rating_scale:rating.scale,species:[rating.species],method:'unspecified',habitat:rating.areas.includes('offshore')?'offshore':'nearshore',kind:'seasonal_advice',first_hand:false,current_qualifying:false,age_label:'seasonal_history',general_spots:[],excerpt:`${rating.species}: ${rating.rating}/5 for month ${rating.month}; publisher seasonal opportunity rating, not a current catch.`,observation_id:doc.url+'|'+rating.month+'|'+rating.species,duplicate_fingerprint:doc.url+'|'+rating.month+'|'+rating.species});
 }
 return output;
}
function deduplicateEvidence(items){
 const seen=new Map(),result=[];
 for(const e of items){
  const passage=String(e.excerpt||'').toLowerCase().replace(/[^a-z0-9]+/g,' ').trim();
  const keys=[e.duplicate_fingerprint?'fingerprint:'+e.duplicate_fingerprint:null,passage.length>=20?'passage:'+passage+'|'+(e.fishing_date||'unknown'):null,e.provider_post_id?'post:'+e.provider+':'+e.provider_post_id:null].filter(Boolean);
  const duplicate=keys.map(k=>seen.get(k)).find(Boolean);
  if(duplicate){if(!duplicate.duplicate_urls.includes(e.url))duplicate.duplicate_urls.push(e.url);duplicate.duplicate_evidence_ids.push(e.evidence_id);continue;}
  const copy={...e,duplicate_urls:[],duplicate_evidence_ids:[],independent_observation_count:e.current_qualifying?1:0};for(const key of keys)seen.set(key,copy);result.push(copy);
 }
 return result.sort((a,b)=>(b.current_qualifying?1:0)-(a.current_qualifying?1:0)+(a.age_days??9999)-(b.age_days??9999));
}
function refreshEvidenceHistory(items,context,now=new Date().toISOString()){
 const allowed=new Set(context.config.sources.filter(s=>s.enabled&&context.location.fishing_sources.includes(s.id)).map(s=>s.id));
 return items.filter(e=>e.location_id===context.location_id&&(allowed.has(e.source_id)||e.provenance_type==='verified_public_community'&&context.config.community_research?.enabled===true&&(context.config.community_research.providers||['hulltruth','spacefish','reddit']).includes(e.provider)&&e.provider!=='reddit'&&Date.parse(e.expires_at)>Date.parse(now)&&Date.parse(now)-Date.parse(e.verified_at)<=Math.min(24,context.config.community_research.fresh_hours||24)*3600000)).map((e,i)=>{
  const date=evidenceDate(e,e.fishing_date||'',now);
  let researchLabel=e.research_label;
  if(e.provenance_type==='verified_public_community'){
   const month=Number(context.window.period_start.slice(5,7)),tripMonth=Number((date.fishing_date||'').slice(5,7)),delta=tripMonth?Math.min(Math.abs(month-tripMonth),12-Math.abs(month-tripMonth)):99;
   researchLabel=date.age_label==='current'?'current':date.age_label==='recent_context'?'recent_context':date.fishing_date&&delta<=1&&date.fishing_date.slice(0,4)<context.window.period_start.slice(0,4)?'seasonal_history':date.fishing_date?'out_of_season_history':'trip_date_unknown';
  }
  return {...e,...date,research_label:researchLabel,original_date_wording:e.original_date_wording||date.original_date_wording,fishing_date_inferred:e.fishing_date_inferred||date.fishing_date_inferred,evidence_id:context.run_id+'_history_'+i,history_original_evidence_id:e.history_original_evidence_id||e.evidence_id,current_qualifying:date.age_label==='current'&&e.first_hand&&e.kind!=='marketing'&&e.kind!=='seasonal_advice'&&(!e.provenance_type||e.applicable_location_ids?.includes(context.location_id)&&!e.regional_context_only),history_origin:'application_archive'};
 });
}
if(typeof module!=='undefined')module.exports={SPECIES,sourceUrlAllowed,articleCandidates,evidenceDate,extractEvidence,deduplicateEvidence,refreshEvidenceHistory,evidenceRelevance,relevantEvidence};
