'use strict';
const NEWS_REGIONS=[{id:'brevard',label:'Port Canaveral / Brevard County'},{id:'ponce',label:'Ponce Inlet area'},{id:'keys',label:'Florida Keys'}];
function cleanNewsText(value){return String(value||'').replace(/<[^>]*>/g,' ').replace(/\s+/g,' ').trim();}
function canonicalNewsUrl(value,source){
 const m=/^https:\/\/([^/?#]+)([^?#]*)(?:\?([^#]*))?(?:#.*)?$/i.exec(String(value||''));
 if(!m||!source.allowed_hosts.includes(m[1].toLowerCase()))return null;
 const query=(m[3]||'').split('&').filter(p=>p&&!/^(?:utm_[^=]*|fbclid|gclid|mc_cid|mc_eid)=/i.test(p)).sort().join('&');
 return 'https://'+m[1].toLowerCase()+(m[2].replace(/\/$/,'')||'/')+(query?'?'+query:'');
}
function newsRegion(item,source){
 const match=text=>/\b(?:port|cape)\s+canaveral|\bbrevard|\bspace\s+coast|\bcocoa\s+beach|\bmerritt\s+island|\btitusville|\bmelbourne\s+(?:beach|florida)/i.test(text)?'brevard':
  /\bponce\s+(?:de\s+leon\s+)?inlet|\bnew\s+smyrna|\bdaytona|\bport\s+orange|\bhalifax|\bvolusia/i.test(text)?'ponce':
  /\bflorida\s+keys|\b(?:upper|middle|lower)\s+keys|\bkey\s+(?:west|largo|colony)|\bislamorada|\bsugarloaf|\b(?:marathon|big\s+pine)\s+(?:key|fishing)|\bkeys\s+(?:fishing|fish\s+report|bragboard)/i.test(text)?'keys':null;
 // A headline/category establishes article scope before a longer description
 // that may mention anglers or trips from several regions.
 const headline=match(item.title);if(headline)return headline;
 if(/\b(?:naples|sarasota|destin|pensacola|emerald\s+coast|fort\s+lauderdale|tampa|stuart|treasure\s+coast|russia)\b/i.test(item.title))return null;
 const primary=match((item.categories||[]).join(' '));if(primary)return primary;
 const body=match(item.description||'');if(body)return body;
 return source.default_region||null;
}
function selectFishingNews(response,config,now=new Date().toISOString()){
 const sources=new Map((config?.feeds||[]).filter(f=>f.enabled!==false).map(f=>[f.id,f])),candidates=[];
 for(const item of response.records||[]){
  const source=sources.get(item.source_id);if(!source)continue;
  const date=Date.parse(item.published_at),url=canonicalNewsUrl(item.url,source),title=cleanNewsText(item.title).slice(0,250);
  if(!url||!title||!Number.isFinite(date)||date>Date.parse(now))continue;
  const body=(item.description||'').replace(/The post .*? appeared first on .*$/i,'');
  const text=title+' '+(item.categories||[]).join(' ')+' '+body;
  if(!source.fishing_only&&!/\bfish(?:ing|eries|ery|ermen)?\b|\bangling|\bbragboard|\bsnapper|\btarpon|\bsnook|\bmahi|\blobster|\bsportfish|\bredfish|\bbonefish|\bmarlin|\bwahoo|\bkingfish|\bcobia|\bmackerel/i.test(text))continue;
  if(/\b(?:discount|coupon|price\s+guide|how\s+much.*cost|book\s+now)\b/i.test(title))continue;
  const regions=config?.regions||NEWS_REGIONS;const region=config?.regions?(regions.find(r=>(r.terms||[]).some(t=>(item.title+' '+item.description).toLowerCase().includes(t.toLowerCase())))?.id||source.default_region):newsRegion(item,source);if(!regions.some(r=>r.id===region))continue;
  candidates.push({title,url,published_at:new Date(date).toISOString(),region,source_id:source.id,source_name:source.name,feed_url:source.url,retrieved_at:item.retrieved_at||response.retrieved_at});
 }
 candidates.sort((a,b)=>Date.parse(b.published_at)-Date.parse(a.published_at)||a.url.localeCompare(b.url));
 const urls=new Set(),headlines=new Set(),unique=[];
 for(const item of candidates){const headline=item.title.toLowerCase().replace(/[^\p{L}\p{N}]+/gu,' ').trim();if(urls.has(item.url)||headline.length>=30&&headlines.has(headline))continue;urls.add(item.url);if(headline.length>=30)headlines.add(headline);unique.push(item);}
 const limit=Math.min(10,Math.max(1,Number(config?.max_items)||10));
 const items=unique.slice(0,limit).sort((a,b)=>(config?.regions||NEWS_REGIONS).findIndex(r=>r.id===a.region)-(config?.regions||NEWS_REGIONS).findIndex(r=>r.id===b.region)||Date.parse(b.published_at)-Date.parse(a.published_at)||a.url.localeCompare(b.url));
 return {regions:config?.regions||NEWS_REGIONS,enabled:config?.enabled!==false,status:response.status||'failed',selection:'ten_newest_overall_then_location',retrieved_at:response.retrieved_at||now,candidate_count:unique.length,items,sources:response.sources||[]};
}
function renderFishingNews(report){
 const news=report.fishing_news;if(!news?.enabled)return {html:'',lines:[]};
 let html='<h2 style="font-size:16px">Fishing news</h2><p style="font-size:11px;color:#536775">Ten newest RSS articles overall, grouped by area; dates are publication dates.</p>';
 const lines=['','Fishing news — ten newest RSS articles overall, grouped by area'];
 for(const region of (news.regions||NEWS_REGIONS)){const items=(news.items||[]).filter(i=>i.region===region.id);html+=`<h3 style="font-size:14px;margin:12px 0 5px">${escapeHtml(region.label)}</h3>`;lines.push(region.label);
  if(!items.length){const note=news.status==='failed'?'RSS feeds unavailable for this run.':'No articles from this area among the ten newest available items.';html+=`<p style="font-size:11px;color:#657783;margin:4px 0">${escapeHtml(note)}</p>`;lines.push(note);}
  for(const item of items){const date=new Intl.DateTimeFormat('en-US',{timeZone:report.window.timezone,year:'numeric',month:'short',day:'numeric'}).format(new Date(item.published_at));html+=`<p style="font-size:13px;line-height:1.4;margin:7px 0"><a href="${escapeHtml(item.url)}" style="color:#176579">${escapeHtml(item.title)}</a><br><span style="font-size:11px;color:#657783">${escapeHtml(item.source_name)} · ${escapeHtml(date)}</span></p>`;lines.push(`${date} — ${item.title} (${item.source_name}) ${item.url}`);}
 }
 const failed=(news.sources||[]).filter(s=>s.status==='failed');
 if(failed.length){const note='Unavailable feeds: '+failed.map(s=>s.name).join(', ')+'.';html+=`<p style="font-size:11px;color:#755422">${escapeHtml(note)}</p>`;lines.push(note);}
 return {html,lines};
}
if(typeof module!=='undefined')module.exports={NEWS_REGIONS,canonicalNewsUrl,newsRegion,selectFishingNews,renderFishingNews};
