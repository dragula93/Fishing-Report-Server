"""Read-only public-page verification. Reddit has no direct adapter without OAuth.

No proxies, cookies, credentials or browser automation. DNS is validated and pinned
on every request, including redirects. Unknown markup yields no observations.
"""
import datetime as dt
import hashlib
import http.client
import ipaddress
import json
import re
import socket
import ssl
import time
import urllib.robotparser
from urllib.parse import urlsplit, urljoin
from lxml import html
import trafilatura

HOSTS = {'thehulltruth.com', 'www.thehulltruth.com', 'spacefish.com', 'www.spacefish.com'}
UA = 'FishingReport/0.11 (private public fishing observation reader)'
MAX_BYTES = 500000

def valid_url(url, robots=False):
    p = urlsplit(url)
    if p.scheme != 'https' or p.hostname not in HOSTS or p.username or p.password or p.port not in (None, 443) or '\\' in url or re.search(r'%2f|%5c|\.\.', p.path, re.I):
        raise ValueError('unapproved_url')
    if p.query: raise ValueError('query_not_supported')
    if robots and p.path != '/robots.txt': raise ValueError('invalid_robots_path')
    if not robots:
        if 'thehulltruth' in p.hostname and not re.fullmatch(r'/[a-z0-9-]+/\d+-[a-z0-9-]+\.html', p.path, re.I): raise ValueError('unsupported_forum_permalink')
        if 'spacefish' in p.hostname and not re.fullmatch(r'/[a-z0-9_/-]+', p.path, re.I): raise ValueError('unsupported_article_permalink')
    return p

class Budget:
    def __init__(self):
        self.deadline = time.monotonic() + 60
        self.hosts = {}
        self.requests = 0
        self.audit = []
        self.last = {}
        self.delays = {}
        self.robots = {}

    def get(self, url, robots=False):
        for redirect in range(3):
            p = valid_url(url, robots)
            if time.monotonic() >= self.deadline: raise TimeoutError('wall_budget')
            if self.requests >= 12 or self.hosts.get(p.hostname, 0) >= 4: raise TimeoutError('request_budget')
            wait=max(0,self.last.get(p.hostname,0)+self.delays.get(p.hostname,3)-time.monotonic())
            if time.monotonic()+wait>=self.deadline:raise TimeoutError('wall_budget')
            time.sleep(wait);self.last[p.hostname]=time.monotonic()
            self.requests += 1
            self.hosts[p.hostname] = self.hosts.get(p.hostname, 0) + 1
            addresses = {x[4][0] for x in socket.getaddrinfo(p.hostname, 443, type=socket.SOCK_STREAM)}
            if not addresses or any(not ipaddress.ip_address(ip).is_global for ip in addresses): raise ValueError('nonpublic_dns')
            remaining = self.deadline - time.monotonic()
            if remaining <= 0: raise TimeoutError('wall_budget')
            # Pin the verified address while retaining hostname/SNI verification.
            conn = http.client.HTTPSConnection(p.hostname, timeout=min(8, remaining))
            conn.connect = lambda: setattr(conn, 'sock', ssl.create_default_context().wrap_socket(socket.create_connection((sorted(addresses)[0],443),timeout=min(8,remaining)),server_hostname=p.hostname))
            try:
                conn.request('GET', p.path or '/', headers={'Host':p.hostname,'User-Agent':UA,'Accept':'text/html,text/plain','Accept-Encoding':'identity'})
                res = conn.getresponse()
                self.audit.append({'url':url,'at':dt.datetime.now(dt.timezone.utc).isoformat(),'http_status':res.status})
                if res.status in (301,302,303,307,308):
                    target=urljoin(url,res.getheader('Location',''));dest=valid_url(target,robots)
                    if dest.hostname!=p.hostname:raise ValueError('cross_host_redirect_not_permitted')
                    if not robots:
                        parser,code=self.robots.get(p.hostname,(None,None))
                        if code!=404 and (not parser or not parser.can_fetch(UA,target)):raise ValueError('robots_redirect_disallowed')
                    url=target; continue
                if res.status != 200: return res.status, b'', url
                data=b''
                while True:
                    if time.monotonic() >= self.deadline: raise TimeoutError('wall_budget')
                    block=res.read(min(32768,MAX_BYTES+1-len(data)))
                    if not block: break
                    data+=block
                    if len(data)>MAX_BYTES: raise ValueError('page_size_budget')
                return res.status,data,url
            finally: conn.close()
        raise ValueError('redirect_budget')

def parse_posts(data, url, retrieved_at, with_status=False):
    if len(data)>MAX_BYTES: raise ValueError('page_size_budget')
    tree=html.fromstring(data)
    title=' '.join(tree.xpath('//title/text()'))[:200]
    if re.search(r'Just a moment|Access Denied|Attention Required|captcha|enable javascript and cookies',title,re.I):raise RuntimeError('access_unavailable')
    records=[]
    supported=False
    def own_text(value):
        node=html.fromstring('<div>'+value+'</div>')
        for quote in node.xpath('.//blockquote | .//*[contains(concat(" ",normalize-space(@class)," ")," quote ")] | .//script | .//style'):
            quote.drop_tree()
        return ' '.join(node.text_content().split())[:12000]
    def emit(item, parent_url):
        nonlocal supported
        if not isinstance(item,dict):return
        types=item.get('@type',[]);types=[types] if isinstance(types,str) else types
        if any(t in ('DiscussionForumPosting','Comment','SocialMediaPosting','Article','BlogPosting','NewsArticle') for t in types):
            body=item.get('articleBody') or item.get('text')
            if isinstance(body,str) and body.strip():
                supported=True
                author=item.get('author');author=author[0] if isinstance(author,list) and author else author
                author=author.get('name') if isinstance(author,dict) else author if isinstance(author,str) else None
                ident=item.get('@id') or item.get('identifier') or item.get('url') or parent_url
                if not isinstance(ident,str):ident=parent_url
                permalink=parent_url
                candidate=item.get('url') if isinstance(item.get('url'),str) else ident
                if isinstance(candidate,str) and candidate.startswith('https://'):
                    try:
                        target=valid_url(candidate);parent=urlsplit(parent_url)
                        if target.hostname==parent.hostname and target.path.rstrip('/')==parent.path.rstrip('/') and (not target.fragment or re.fullmatch(r'post\d+|comment-\d+',target.fragment)):
                            permalink=candidate
                    except ValueError:pass
                # Comments without their own stable identity are not conflated with the thread.
                if 'Comment' not in types or ident!=parent_url and urlsplit(permalink).fragment:
                    records.append({'url':permalink,'post_id':hashlib.sha256(ident.encode()).hexdigest()[:24], 'text':own_text(body), 'author':author,'published_at':item.get('datePublished'),'updated_at':item.get('dateModified'),'title':title,'retrieved_at':retrieved_at,'provenance':'direct_public_page','metadata_verified':True,'retrieval_status':'retrieved'})
        for child in item.get('comment',[]) if isinstance(item.get('comment'),list) else [item.get('comment')]:emit(child,parent_url)
        for child in item.get('@graph',[]):emit(child,parent_url)
    for script in tree.xpath('//script[@type="application/ld+json"]/text()')[:12]:
        try:
            obj=json.loads(script)
            for item in obj if isinstance(obj,list) else [obj]:emit(item,url)
        except (ValueError,TypeError):continue
    if not records and 'thehulltruth' in urlsplit(url).hostname:
        for body in tree.xpath('//*[starts-with(@id,"post_message_")]')[:40]:
            supported=True
            post_id=body.get('id').replace('post_message_','')
            parents=body.xpath('ancestor::*[@id=$id]',id='post'+post_id)
            parent=parents[0] if parents else body
            authors=parent.xpath('.//*[contains(concat(" ",normalize-space(@class)," ")," bigusername ")]/text()')
            dates=parent.xpath('.//time/@datetime')
            for quote in body.xpath('.//blockquote | .//*[contains(concat(" ",normalize-space(@class)," ")," quote ")]'):quote.drop_tree()
            text=' '.join(body.text_content().split())
            records.append({'url':url.split('#')[0]+'#post'+post_id,'post_id':post_id,'text':text[:12000],'author':authors[0].strip() if authors else None,'published_at':dates[0] if dates else None,'updated_at':None,'title':title,'retrieved_at':retrieved_at,'provenance':'direct_public_page','metadata_verified':True,'retrieval_status':'retrieved'})
    if not records and 'spacefish.com' in urlsplit(url).hostname:
        # A compiled publisher article does not provide each captain's original
        # post timestamp. Accept only a self-contained paragraph with its own
        # explicit ISO trip date; never infer its "yesterday" from publication.
        text=trafilatura.extract(data,include_comments=False,include_tables=False) or ''
        supported=supported or bool(text.strip())
        for paragraph in text.splitlines()[:150]:
            if not re.search(r'\b20\d\d-\d\d-\d\d\b',paragraph):continue
            if not re.search(r'Port Canaveral|Cape Canaveral|8A Reef|Pelican Flats|Ponce Inlet',paragraph,re.I):continue
            if len(paragraph)>1500:continue
            ident=hashlib.sha256(paragraph.encode()).hexdigest()[:24]
            records.append({'url':url,'post_id':ident,'text':paragraph,'author':None,'published_at':None,'updated_at':None,'title':title,'retrieved_at':retrieved_at,'provenance':'direct_public_page','metadata_verified':True,'retrieval_status':'retrieved','content_scope':'explicitly_dated_article_passage'})
    return (records[:40],supported) if with_status else records[:40]

def collect_pages(payload):
    budget=Budget();docs=[];outcomes=[];policies={};max_pages=min(12,max(1,int(payload.get('max_pages',8))))
    for candidate in payload.get('urls',[])[:max_pages]:
        url=candidate if isinstance(candidate,str) else ''
        try:
            p=valid_url(url)
            if p.hostname not in policies:
                code,data,_=budget.get('https://'+p.hostname+'/robots.txt',True)
                if code==429:raise RuntimeError('rate_limited')
                if code not in (200,404):raise RuntimeError('robots_unavailable')
                parser=urllib.robotparser.RobotFileParser();parser.parse(data.decode('utf-8','replace').splitlines() if code==200 else [])
                policies[p.hostname]=(parser,code)
                budget.robots[p.hostname]=(parser,code)
            parser,code=policies[p.hostname];delay=parser.crawl_delay(UA) or parser.crawl_delay('*') or 3
            if code==200 and not parser.can_fetch(UA,url):raise RuntimeError('robots_blocked')
            if delay>10:raise RuntimeError('crawl_delay_exceeds_budget')
            budget.delays[p.hostname]=delay
            code,data,final=budget.get(url.split('#')[0]);at=dt.datetime.now(dt.timezone.utc).isoformat()
            if code==429:raise RuntimeError('rate_limited')
            if code in (401,403):raise RuntimeError('access_unavailable')
            if code in (404,410):raise RuntimeError('deleted_or_unavailable')
            if code!=200:raise RuntimeError('http_'+str(code))
            extracted,supported=parse_posts(data,final,at,with_status=True);docs.extend(extracted)
            outcomes.append({'url':url,'status':'retrieved' if supported else 'unsupported_markup','retrieved_at':at,'posts':len(extracted)})
        except Exception as exc:
            outcomes.append({'url':url[:1800],'status':str(exc)[:100]})
    # Do not ship raw pages or whole threads to the model or database.
    result={'documents':docs[:40],'outcomes':outcomes,'requests':budget.requests,'audit':budget.audit}
    while len(json.dumps(result).encode())>100000 and result['documents']:result['documents'].pop()
    return result
