import datetime as dt
import unittest
from unittest.mock import patch
import rss_news as rss

class NewsParserTest(unittest.TestCase):
 def setUp(self):self.source=rss.FEEDS['spacefish_news'];self.now='2026-10-02T18:00:00Z'
 def parse(self,xml):return rss.parse_feed(xml.encode(),self.source,self.now)
 def test_rss_original_date_safe_text_and_host(self):
  rows=self.parse('''<rss><channel><item><title>Fish &amp; tides</title><link>https://spacefish.com/report/</link><pubDate>Fri, 02 Oct 2026 13:00:00 -0400</pubDate><description>&lt;p&gt;Fishing report&lt;/p&gt;&lt;script&gt;bad&lt;/script&gt;</description><category>Brevard</category></item><item><title>Unsafe link</title><link>https://127.0.0.1/private</link></item></channel></rss>''')
  self.assertEqual(len(rows),1);self.assertEqual(rows[0]['published_at'],'2026-10-02T17:00:00+00:00');self.assertEqual(rows[0]['description'],'Fishing report');self.assertEqual(rows[0]['categories'],['Brevard'])
 def test_atom_published_not_updated(self):
  rows=self.parse('''<feed xmlns="http://www.w3.org/2005/Atom"><entry><title>Fishing</title><link rel="alternate" href="https://spacefish.com/atom/"/><published>2025-01-01T00:00:00Z</published><updated>2026-10-02T00:00:00Z</updated><category term="Brevard"/></entry><entry><title>Updated only</title><link href="https://spacefish.com/updated/"/><updated>2026-10-02T00:00:00Z</updated></entry></feed>''')
  self.assertEqual(rows[0]['published_at'],'2025-01-01T00:00:00+00:00');self.assertIsNone(rows[1]['published_at'])
 def test_dtd_and_html_rejected(self):
  for xml in ['<!DOCTYPE rss [<!ENTITY x SYSTEM "file:///etc/passwd">]><rss/>','<html><body>Blocked</body></html>']:
   with self.assertRaises(ValueError):self.parse(xml)
 def test_unknown_feed_and_partial_failure_isolation(self):
  with self.assertRaises(ValueError):rss.collect_news({'feed_ids':['unapproved']})
  def result(source):return ({'source_id':source['id'],'status':'failed' if source['id']=='spacefish_news' else 'ok'},[])
  with patch.object(rss,'collect_source',side_effect=result):self.assertEqual(rss.collect_news({'feed_ids':['spacefish_news','keys_weekly_news']})['status'],'partial')
 def test_credentials_ports_and_redirect_hosts_are_rejected(self):
  for url in ['http://spacefish.com/feed/','https://spacefish.com@127.0.0.1/feed/','https://spacefish.com:9999/feed/','https://evil.example/feed/']:
   self.assertFalse(rss.allowed_url(url,self.source))

if __name__ == '__main__':
 unittest.main()
