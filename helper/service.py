"""Private, bounded astronomy and article-extraction endpoints; no scheduling."""
import datetime as dt
import os
import json
import os
import re
import urllib.robotparser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit, urljoin
from zoneinfo import ZoneInfo
from skyfield.api import load, load_file, wgs84
from skyfield import almanac
import trafilatura
from rss_news import collect_news
from community import collect_pages
from publisher import source_fields, title_targets
from providers import global_collect, global_alerts
from pathlib import Path
from sst import acquire_mur_background, attach_map_artifact, cache_read, empty_summary
from lxml import html as lxml_html

TS = load.timescale(builtin=True)
EPH = load_file('/app/de421.bsp')
PHASES = ['New moon','Waxing crescent','First quarter','Waxing gibbous','Full moon','Waning gibbous','Last quarter','Waning crescent']
def report_config():
    path=Path(os.environ.get('REPORT_CONFIG','/config/report.json'))
    if not path.exists(): path=Path('/app/report.example.json')
    return json.loads(path.read_text())

def configured_location(location_id):
    if not re.fullmatch(r'[a-z0-9_-]{1,80}',location_id): raise ValueError('Invalid location ID')
    return next(l for l in report_config()['locations'] if l['id']==location_id)

def approved_hosts():
    return {s['domain'] for s in report_config().get('sources',[]) if s.get('enabled')}


def astronomy(payload):
    lat,lon=float(payload['latitude']),float(payload['longitude'])
    if not (-90 <= lat <= 90 and -180 <= lon <= 180): raise ValueError('Invalid coordinates')
    zone=ZoneInfo(payload['timezone'])
    dates=payload['dates']
    if not 1 <= len(dates) <= 8: raise ValueError('Invalid date count')
    site=wgs84.latlon(lat,lon)
    records=[]
    for date in dates:
        day=dt.date.fromisoformat(date)
        start=dt.datetime.combine(day,dt.time(),zone)
        end=dt.datetime.combine(day+dt.timedelta(days=1),dt.time(),zone)
        times,states=almanac.find_discrete(TS.from_datetime(start),TS.from_datetime(end),almanac.sunrise_sunset(EPH,site))
        record={'date':date,'sunrise':None,'sunset':None}
        for event,state in zip(times,states):
            record['sunrise' if state else 'sunset']=event.utc_datetime().astimezone(zone).isoformat()
        noon=TS.from_datetime(dt.datetime.combine(day,dt.time(12),zone))
        angle=float(almanac.moon_phase(EPH,noon).degrees)
        record.update(moon_phase=PHASES[int((angle+22.5)//45)%8],moon_phase_degrees=round(angle,3),
                      illumination_percent=round(float(almanac.fraction_illuminated(EPH,'moon',noon))*100,2),phase_sample_time='12:00 local')
        # The preceding sunset-to-sunrise interval, not phase alone, describes
        # the potential moon exposure before this day's fishing. No cloud model.
        prior=start-dt.timedelta(days=1)
        pt,ps=almanac.find_discrete(TS.from_datetime(prior),TS.from_datetime(start),almanac.sunrise_sunset(EPH,site))
        sunset=next((t.utc_datetime() for t,s in zip(pt,ps) if not s),None)
        sunrise=dt.datetime.fromisoformat(record['sunrise']) if record['sunrise'] else None
        record['preceding_night']=None
        if sunset and sunrise:
            observer=EPH['earth']+site; moon=EPH['moon']
            t0,t1=TS.from_datetime(sunset),TS.from_datetime(sunrise)
            transitions=[]
            for routine,state in [(almanac.find_risings,True),(almanac.find_settings,False)]:
                mt,valid=routine(observer,moon,t0,t1)
                transitions.extend((t.utc_datetime(),state) for t,v in zip(mt,valid) if v)
            transitions.sort(key=lambda x:x[0])
            visible=(not transitions[0][1]) if transitions else float(observer.at(t0).observe(moon).apparent().altaz()[0].degrees)>0
            cursor=sunset; above=0
            for event,state in transitions+[(sunrise,False)]:
                if visible: above+=(event-cursor).total_seconds()
                cursor,visible=event,state
            midpoint=TS.from_datetime(sunset+(sunrise-sunset)/2)
            record['preceding_night']={'start':sunset.astimezone(zone).isoformat(),'end':sunrise.astimezone(zone).isoformat(),
                'moon_above_horizon_hours':round(above/3600,2),'night_hours':round((sunrise-sunset).total_seconds()/3600,2),
                'illumination_percent':round(float(almanac.fraction_illuminated(EPH,'moon',midpoint))*100,2),
                'scope':'astronomical moonlight potential; cloud cover not included'}
        records.append(record)
    return {'source_id':'skyfield_de421','status':'ok','retrieved_at':dt.datetime.now(dt.timezone.utc).isoformat(),
            'issued_at':None,'records':records,'warnings':[], 'error':None,
            'provenance':{'skyfield':'1.55','ephemeris':'JPL DE421','sha256':'a20a7139da04cbc462454634918e9a9ca69127044e2cc9d4f9c16e238d2deedc'}}

def extract(payload):
    url=payload['url']
    parsed=urlsplit(url)
    if parsed.scheme!='https' or parsed.hostname not in approved_hosts(): raise ValueError('Unapproved article URL')
    page=payload['html']
    if not isinstance(page,str) or len(page)>2_000_000: raise ValueError('Article too large')
    tree=lxml_html.fromstring(page)
    metadata={'published_at':None,'updated_at':None,'author':None,'title':None}
    def meta(key):
        values=tree.xpath('//meta[@property=$key or @name=$key]/@content',key=key)
        return values[0] if values else None
    metadata.update(published_at=meta('article:published_time'),updated_at=meta('article:modified_time'),author=meta('author'),title=meta('og:title'))
    for raw in tree.xpath('//script[@type="application/ld+json"]/text()'):
        try:
            doc=json.loads(raw)
            entries=doc if isinstance(doc,list) else [doc]
            for item in list(entries):
                if isinstance(item,dict): entries.extend(item.get('@graph',[]))
            for item in entries:
                if not isinstance(item,dict): continue
                kind=item.get('@type',[])
                if isinstance(kind,str): kind=[kind]
                if any(k in kind for k in ['Article','BlogPosting','NewsArticle']):
                    metadata['published_at']=metadata['published_at'] or item.get('datePublished')
                    metadata['updated_at']=metadata['updated_at'] or item.get('dateModified')
                    metadata['title']=metadata['title'] or item.get('headline')
                    author=item.get('author')
                    if isinstance(author,dict): metadata['author']=metadata['author'] or author.get('name')
        except (TypeError,ValueError): pass
    # Remove hidden contest dialogs and navigation before the bounded article extraction.
    clean=lxml_html.fromstring(page)
    for node in clean.xpath('//nav | //footer | //aside | //*[contains(concat(" ",normalize-space(@class)," ")," report-byte ") or contains(concat(" ",normalize-space(@class)," ")," fusion-modal ") or contains(@class,"post-navigation") or contains(@class,"related-post") or contains(@class,"entry-meta") or contains(@class,"post-tags")]'):
        if node.getparent() is not None: node.getparent().remove(node)
    raw=trafilatura.extract(lxml_html.tostring(clean,encoding='unicode'),output_format='json',include_comments=False,include_tables=False,with_metadata=True)
    article=json.loads(raw) if raw else {}
    text=article.get('text','')[:40000]
    publisher=source_fields(tree,url)
    if publisher.get('seasonal_text'):
        text=publisher.pop('seasonal_text')
    metadata['title']=metadata['title'] or article.get('title')
    metadata['author']=metadata['author'] or article.get('author')
    # Do not promote trafilatura's inferred/modified date to a published date.
    feeds=[]
    for href in tree.xpath('//link[@rel="alternate" and (@type="application/rss+xml" or @type="application/atom+xml")]/@href'):
        candidate=urljoin(url,href)
        if urlsplit(candidate).hostname==parsed.hostname: feeds.append(candidate)
    links=[]
    for anchor in tree.xpath('//a[@href]'):
        candidate=urljoin(url,anchor.get('href').strip()).split('#')[0]
        u=urlsplit(candidate)
        label=anchor.text_content().strip()
        if u.scheme=='https' and u.hostname==parsed.hostname and not u.query and candidate!=url and len(label)>12:
            if any(s in u.path for s in ['/category/','/tag/','/wp-','/author/','/shop/','/booking','/contact','/privacy','/terms']): continue
            if candidate not in [link['url'] for link in links]: links.append({'url':candidate,'title':label[:200]})
    listing_reports=[]
    # The geographic scope and dates belong to these actual Canaveral cards,
    # not to unrelated sidebar links or the listing page's creation timestamp.
    if parsed.hostname=='spacefish.com' and parsed.path.rstrip('/') in ['/canaveral','/surf']:
        for card in tree.xpath('//*[contains(concat(" ",normalize-space(@class)," ")," report-byte ")]')[:16]:
            headings=card.xpath('.//h3');anchors=card.xpath('.//a[@href]')
            target=next((urljoin(url,a.get('href')) for a in anchors if 'VIEW REPORT' in a.text_content().upper()),None)
            raw_text=card.text_content();date=re.search(r'\b(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},\s+20\d{2}\b',raw_text)
            if not target or not headings or not date:continue
            paragraphs=[p.text_content().strip() for p in card.xpath('.//p') if len(p.text_content().strip())>35]
            author=re.search(r'(?:^|\n)\s*by\s+([^\n\r|]+)',raw_text,re.I)
            published=dt.datetime.strptime(date.group(),'%B %d, %Y').replace(hour=12,tzinfo=ZoneInfo('America/New_York')).isoformat()
            title=headings[0].text_content().strip()
            listing_reports.append({'url':target,'title':title,'author':author.group(1).strip() if author else None,'published_at':published,'updated_at':None,'text':'\n'.join(paragraphs)[:12000],'scoped_location_id':'port_canaveral_fl','regional_context_only':parsed.path.rstrip('/')=='/surf','species_catalog':title_targets(title)})
            for link in links:
                if link['url']==target:link['scoped_location_id']='port_canaveral_fl';link['published_at']=published
    robots=payload.get('robots')
    permissions=[]
    if robots is not None:
        parser=urllib.robotparser.RobotFileParser();parser.parse(str(robots).splitlines())
        for link in links:
            link['robots_allowed']=parser.can_fetch('FishingReport',link['url'])
        feeds=[feed for feed in feeds if parser.can_fetch('FishingReport',feed)]
    return {'metadata':metadata,'text':text,**publisher,'feeds':list(dict.fromkeys(feeds)), 'links':links[:80],'listing_reports':listing_reports,'extracted':bool(text)}

def robots_policy(payload):
    url=payload['url'];parsed=urlsplit(url)
    if parsed.scheme!='https' or parsed.hostname not in approved_hosts(): raise ValueError('Unapproved source')
    code=int(payload.get('http_status',0))
    if code==404:return {'allowed':True,'delay_seconds':3,'warning':'No robots file (404)','links':[link for link in payload.get('links',[])[:100] if urlsplit(link.get('url','')).scheme=='https' and urlsplit(link.get('url','')).hostname==parsed.hostname and not urlsplit(link.get('url','')).query]}
    if code<200 or code>=300:return {'allowed':False,'delay_seconds':3,'warning':'Robots lookup unavailable; source disabled for this run'}
    parser=urllib.robotparser.RobotFileParser();parser.parse(str(payload['text']).splitlines())
    delay=parser.crawl_delay('FishingReport') or parser.crawl_delay('*') or 3
    result={'allowed':parser.can_fetch('FishingReport',url) and delay<=60,'delay_seconds':max(3,delay), 'warning':None if delay<=60 else 'Publisher delay exceeds bounded collector limit'}
    if 'links' in payload:
        result['links']=[link for link in payload['links'][:100] if urlsplit(link.get('url','')).scheme=='https' and urlsplit(link.get('url','')).hostname==parsed.hostname and not urlsplit(link.get('url','')).query and parser.can_fetch('FishingReport',link['url'])]
    return result

class Handler(BaseHTTPRequestHandler):
    def log_message(self,*args): pass
    def send(self,status,payload):
        body=json.dumps(payload,ensure_ascii=False).encode()
        self.send_response(status); self.send_header('Content-Type','application/json'); self.send_header('Content-Length',str(len(body))); self.end_headers(); self.wfile.write(body)
    def do_GET(self):
        if self.path=='/healthz': self.send(200,{'status':'ok','skyfield':'1.55'})
        elif self.path.startswith('/ocean-features/'):
            location_id=self.path.removeprefix('/ocean-features/')
            try: location=configured_location(location_id)
            except (ValueError,StopIteration): return self.send(404,{'error':'Unknown location'})
            if not location.get('ocean_features',{}).get('enabled'): return self.send(200,empty_summary(location_id,'disabled'))
            if os.environ.get('OCEAN_FEATURES_ENABLED','false').lower()!='true':
                return self.send(200,empty_summary(location_id,'disabled',now=dt.datetime.now(dt.timezone.utc).isoformat()))
            root=os.environ.get('OCEAN_CACHE_DIR','/data/ocean-cache')
            path=os.path.join(root,location_id+'.json')
            try:
                result=cache_read(path,dt.datetime.now(dt.timezone.utc).isoformat(),5)
                result=attach_map_artifact(result,root)
                return self.send(200,result)
            except Exception as exc:
                return self.send(200,empty_summary(location_id,'unavailable',[f'Optional ocean cache unavailable: {type(exc).__name__}'],dt.datetime.now(dt.timezone.utc).isoformat()))
        else: self.send(404,{'error':'Unknown route'})
    def do_POST(self):
        try:
            count=int(self.headers.get('Content-Length','0'))
            if count<1 or count>2_100_000: raise ValueError('Invalid payload size')
            payload=json.loads(self.rfile.read(count))
            if self.path=='/global-collect': result=global_collect(payload)
            elif self.path=='/global-alerts': result=global_alerts(payload['location'])
            elif self.path=='/ocean-acquire':
                location_id=payload['location_id']; location=configured_location(location_id)
                ocean=location.get('ocean_features',{})
                if os.environ.get('OCEAN_FEATURES_ENABLED','false').lower()!='true' or not ocean.get('enabled'):
                    result=empty_summary(location_id,'disabled')
                else:
                    root=os.environ.get('OCEAN_CACHE_DIR','/data/ocean-cache')
                    paths=[]
                    for value in ocean.get('gpx_inputs',[]):
                        p=Path(value).resolve()
                        if not p.is_relative_to(Path('/data/gpx')): raise ValueError('GPX path must be under /data/gpx')
                        paths.append(str(p))
                    try:
                        result=acquire_mur_background(location_id,root,paths,config=ocean)
                    except Exception as exc:
                        try: result=cache_read(os.path.join(root,location_id+'.json'),dt.datetime.now(dt.timezone.utc).isoformat(),5)
                        except Exception: result=empty_summary(location_id,'unavailable')
                        result['acquisition_status']='failed'
                        result.setdefault('warnings',[]).append('SST refresh failed: '+type(exc).__name__)
            elif self.path=='/astronomy': result=astronomy(payload)
            elif self.path=='/extract': result=extract(payload)
            elif self.path=='/robots': result=robots_policy(payload)
            elif self.path=='/news-rss': result=collect_news(payload)
            elif self.path=='/research-fetch': result=collect_pages(payload)
            else: return self.send(404,{'error':'Unknown route'})
            self.send(200,result)
        except Exception as exc: self.send(422,{'status':'failed','records':[],'warnings':[],'error':str(exc)[:250]})

if __name__=='__main__': ThreadingHTTPServer(('0.0.0.0',8080),Handler).serve_forever()
