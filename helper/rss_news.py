"""Bounded, publisher-allowlisted RSS/Atom collection for the news appendix."""
import concurrent.futures
import datetime as dt
import email.utils
import html
import json
import pathlib
import threading
import time
import urllib.error
import urllib.request
import urllib.robotparser
from urllib.parse import urlsplit, urljoin
from lxml import etree, html as lxml_html

REGISTRY_PATH = pathlib.Path(__file__).with_name('news-feeds.json')
if not REGISTRY_PATH.exists(): REGISTRY_PATH = pathlib.Path(__file__).parents[1] / 'config/news-feeds.json'
FEEDS = {f['id']: f for f in json.loads(REGISTRY_PATH.read_text(encoding='utf-8'))}
config_path=pathlib.Path('/config/report.json')
if config_path.exists(): FEEDS={f['id']:f for f in json.loads(config_path.read_text()).get('news',{}).get('feeds',[])}
USER_AGENT = 'FishingReport/0.7 (private fishing-news RSS reader)'
MAX_BYTES = 2_000_000
_host_locks = {}
_locks_lock = threading.Lock()
_robots_cache = {}
_last_request = {}

def allowed_url(url, source):
    try:
        p = urlsplit(url)
        return p.scheme == 'https' and p.hostname in source['allowed_hosts'] and not p.username and not p.password and p.port in (None,443)
    except ValueError: return False

def fetch(url, source):
    if not allowed_url(url, source): raise ValueError('Unapproved RSS URL')
    class Redirect(urllib.request.HTTPRedirectHandler):
        max_redirections = 3
        max_repeats = 1
        def redirect_request(self, req, fp, code, msg, headers, newurl):
            if not allowed_url(newurl, source): raise ValueError('RSS redirect left approved publisher')
            return super().redirect_request(req, fp, code, msg, headers, newurl)
    opener = urllib.request.build_opener(Redirect)
    with opener.open(urllib.request.Request(url, headers={'User-Agent':USER_AGENT,'Accept':'application/rss+xml, application/atom+xml, text/xml'}), timeout=15) as response:
        data = response.read(MAX_BYTES + 1)
        if len(data) > MAX_BYTES: raise ValueError('RSS response exceeds size limit')
        return data, response.url

def plain(value, limit):
    value = html.unescape(value or '')
    try:
        tree = lxml_html.fromstring('<div>' + value + '</div>')
        for node in tree.xpath('.//script | .//style'):
            node.getparent().remove(node)
        value = tree.text_content()
    except (ValueError, etree.ParserError): pass
    return ' '.join(value.split())[:limit]

def published(value):
    if not value: return None
    try: timestamp = email.utils.parsedate_to_datetime(value)
    except (TypeError, ValueError):
        try: timestamp = dt.datetime.fromisoformat(value.replace('Z','+00:00'))
        except ValueError: return None
    if timestamp.tzinfo is None: return None
    return timestamp.astimezone(dt.timezone.utc).isoformat()

def parse_feed(data, source, retrieved_at):
    if len(data) > MAX_BYTES or b'<!DOCTYPE' in data.upper() or b'<!ENTITY' in data.upper(): raise ValueError('Unsupported or oversized XML')
    parser = etree.XMLParser(resolve_entities=False, no_network=True, load_dtd=False, huge_tree=False)
    root = etree.fromstring(data, parser)
    if etree.QName(root).localname not in ['rss','RDF','feed']: raise ValueError('Publisher did not return an RSS/Atom feed')
    def field(node, names):
        for name in names:
            found = node.xpath('./*[local-name()=$name]', name=name)
            if found:
                text = ''.join(found[0].itertext())
                if text.strip(): return text.strip()
        return None
    records = []
    for item in root.xpath('.//*[local-name()="item" or local-name()="entry"]')[:60]:
        title = plain(field(item,['title']),250)
        links = item.xpath('./*[local-name()="link"]')
        link = next((n.get('href') or (n.text or '').strip() for n in links if n.get('rel','alternate')=='alternate'),None)
        if not title or not allowed_url(link or '',source): continue
        # Atom updated is deliberately not promoted to an original publication.
        date = published(field(item,['pubDate','published','date']))
        categories = [plain(n.get('term') or ''.join(n.itertext()),100) for n in item.xpath('./*[local-name()="category"]')[:20]]
        records.append({'title':title,'url':link,'published_at':date,'description':plain(field(item,['description','summary','encoded','content']),5000),
                        'categories':categories,'source_id':source['id'],'source_name':source['name'],'feed_url':source['url'],
                        'default_region':source['default_region'],'fishing_only':source['fishing_only'],'retrieved_at':retrieved_at})
    return records

def collect_source(source):
    host = urlsplit(source['url']).hostname
    with _locks_lock: lock = _host_locks.setdefault(host,threading.Lock())
    try:
        with lock:
            cached = _robots_cache.get(host)
            if not cached or time.monotonic()-cached[0]>3600:
                robots_url = urljoin(source['url'],'/robots.txt')
                try:
                    text,_ = fetch(robots_url,source)
                    policy = urllib.robotparser.RobotFileParser();policy.parse(text.decode('utf-8',errors='replace').splitlines())
                except urllib.error.HTTPError as exc:
                    if exc.code != 404: raise
                    policy = None
                _last_request[host] = time.monotonic()
                cached = (time.monotonic(),policy);_robots_cache[host] = cached
            policy = cached[1]
            if policy and not policy.can_fetch('FishingReport',source['url']): raise ValueError('Publisher disallows this RSS path')
            delay = max(3,(policy.crawl_delay('FishingReport') or policy.crawl_delay('*') or 3) if policy else 3)
            if delay > 30: raise ValueError('Publisher crawl delay exceeds bounded news limit')
            remaining = delay-(time.monotonic()-_last_request.get(host,0))
            if remaining > 0: time.sleep(remaining)
            _last_request[host] = time.monotonic()
            data,final_url = fetch(source['url'],source)
        retrieved = dt.datetime.now(dt.timezone.utc).isoformat()
        records = parse_feed(data,source,retrieved)
        return {'source_id':source['id'],'name':source['name'],'url':source['url'],'final_url':final_url,'status':'ok' if records else 'empty','retrieved_at':retrieved,'item_count':len(records),'error':None},records
    except Exception as exc:
        return {'source_id':source['id'],'name':source['name'],'url':source['url'],'status':'failed','retrieved_at':dt.datetime.now(dt.timezone.utc).isoformat(),'item_count':0,'error':str(exc)[:180]},[]

def collect_news(payload):
    ids = payload.get('feed_ids',[])
    if not isinstance(ids,list) or len(ids)>12 or any(i not in FEEDS for i in ids): raise ValueError('Unknown or excessive news feed IDs')
    ids = list(dict.fromkeys(ids))
    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
        results = list(pool.map(collect_source,[FEEDS[i] for i in ids]))
    sources = [s for s,_ in results]
    status = 'partial' if any(s['status']=='failed' for s in sources) and any(s['status']=='ok' for s in sources) else 'failed' if sources and all(s['status']=='failed' for s in sources) else 'ok'
    return {'status':status,'retrieved_at':dt.datetime.now(dt.timezone.utc).isoformat(),'sources':sources,'records':[r for _,items in results for r in items]}
