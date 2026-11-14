"""Synthetic parser/network-policy fixtures. No network access."""
import sys,json,unittest
from pathlib import Path
from unittest.mock import patch
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'helper'))
import community as c

class CommunityTests(unittest.TestCase):
 def test_comments_own_metadata_and_quotes(self):
  obj={'@type':'DiscussionForumPosting','@id':'thread','text':'We fished offshore Port Canaveral on 2026-10-20.','author':{'name':'A'},'datePublished':'2026-10-21T12:00:00Z','comment':[{'@type':'Comment','@id':'https://www.thehulltruth.com/florida/123-fixture.html#post2','text':'<blockquote>Quoted catch by A</blockquote>We caught kingfish trolling Pelican Flats yesterday.','author':{'name':'B'},'datePublished':'2026-10-23T12:00:00Z'}]}
  data=('<script type="application/ld+json">'+json.dumps(obj)+'</script>').encode()
  rows=c.parse_posts(data,'https://www.thehulltruth.com/florida/123-fixture.html','2026-10-23T13:00:00Z')
  self.assertEqual(len(rows),2);self.assertEqual(rows[1]['author'],'B');self.assertNotEqual(rows[0]['published_at'],rows[1]['published_at']);self.assertNotIn('Quoted',rows[1]['text'])
 def test_unstructured_or_unknown_markup_is_not_a_post(self):
  self.assertEqual(c.parse_posts(b'<p>We caught kingfish offshore Port Canaveral yesterday.</p>','https://spacefish.com/report/','2026-10-23T00:00:00Z'),[])
 def test_compiled_article_requires_explicit_passage_trip_date(self):
  text='<article><h1>Offshore report</h1><p>We caught kingfish trolling offshore at Pelican Flats on 2024-10-20. We used live bait and landed several fish in clear water.</p><p>We caught kingfish offshore at Ponce Inlet yesterday. Lots of people fished around the inlet.</p></article>'
  with patch.object(c.trafilatura,'extract',return_value='We caught kingfish trolling offshore at Pelican Flats on 2024-10-20.\nWe caught kingfish offshore at Ponce Inlet yesterday.'):
   rows=c.parse_posts(text.encode(),'https://spacefish.com/report/','2026-10-23T00:00:00Z');self.assertEqual(len(rows),1);self.assertIsNone(rows[0]['published_at']);self.assertEqual(rows[0]['content_scope'],'explicitly_dated_article_passage')
 def test_retrieved_article_with_no_qualifying_passage_is_completed_empty_not_blocked(self):
  with patch.object(c.trafilatura,'extract',return_value='A local fishing article without a dated firsthand trip.'):
   rows,supported=c.parse_posts(b'<title>Fishing report</title><p>Context</p>','https://spacefish.com/report/','2026-10-23T00:00:00Z',with_status=True);self.assertTrue(supported);self.assertEqual(rows,[])
  self.assertRaisesRegex(RuntimeError,'access_unavailable',c.parse_posts,b'<title>Just a moment</title>','https://spacefish.com/report/','2026-10-23T00:00:00Z')
 def test_private_addresses_and_credentials_rejected(self):
  for url in ['https://127.0.0.1/','https://[::1]/','https://169.254.169.254/','https://spacefish.com@127.0.0.1/','https://spacefish.com:444/report','https://spacefish.com/report?next=private','https://reddit.com/r/fishing/comments/abcd/','https://www.thehulltruth.com/../report']:
   with self.assertRaises(ValueError,msg=url):c.valid_url(url)
 def test_dns_rebinding_is_rejected_before_connect(self):
  with patch.object(c.socket,'getaddrinfo',return_value=[(2,1,6,'',('127.0.0.1',443))]):
   with self.assertRaisesRegex(ValueError,'nonpublic_dns'):c.Budget().get('https://spacefish.com/robots.txt',True)
 def test_redirect_host_is_checked(self):
  self.assertRaises(ValueError,c.valid_url,'https://spacefish.com.evil/report')
 def test_robots_block_and_rate_limit(self):
  for code,text,expected in [(200,b'User-agent: *\nDisallow: /','robots_blocked'),(403,b'','robots_unavailable'),(429,b'','rate_limited')]:
   with patch.object(c.Budget,'get',return_value=(code,text,'https://spacefish.com/robots.txt')):
    r=c.collect_pages({'urls':['https://spacefish.com/report']});self.assertEqual(r['documents'],[]);self.assertEqual(r['outcomes'][0]['status'],expected)
 def test_request_and_page_size_budgets(self):
  b=c.Budget();b.requests=12
  self.assertRaisesRegex(TimeoutError,'request_budget',b.get,'https://spacefish.com/robots.txt',True)
  self.assertRaisesRegex(ValueError,'page_size_budget',c.parse_posts,b'x'*500001,'https://spacefish.com/report','2026-10-23T00:00:00Z')
 def test_deleted_and_unavailable_pages_have_no_new_observations(self):
  with patch.object(c.Budget,'get',side_effect=[(404,b'','https://spacefish.com/robots.txt'),(410,b'','https://spacefish.com/report')]),patch.object(c.time,'sleep'):
   r=c.collect_pages({'urls':['https://spacefish.com/report']});self.assertEqual(r['documents'],[]);self.assertEqual(r['outcomes'][0]['status'],'deleted_or_unavailable')
if __name__=='__main__':unittest.main()
