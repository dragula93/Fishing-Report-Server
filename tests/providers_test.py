import datetime as dt
import json,os,sys,tempfile,unittest
from pathlib import Path
from unittest.mock import patch
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'helper'))
import providers as p

class WorldwideTests(unittest.TestCase):
 def setUp(self):
  self.location={'id':'sydney_au','astronomy_point':{'latitude':-33.8,'longitude':151.3},'forecast_points':[{'id':'nearshore','latitude':-33.8,'longitude':151.4}]}
  self.window={'start_utc':'2026-11-18T13:00:00Z','end_utc':'2026-11-24T13:00:00Z'}
 def fixture(self,host,path,params):
  if path=='/v1/forecast':return {'hourly_units':{'wind_speed_10m':'kn','wind_gusts_10m':'kn'},'hourly':{'time':['2026-11-19T00:00','2026-11-19T01:00'],'wind_speed_10m':[10,None],'wind_gusts_10m':[15,20],'wind_direction_10m':[90,100],'weather_code':[95,0]}}
  return {'hourly_units':{'wave_height':'m','wave_period':'s'},'hourly':{'time':['2026-11-19T00:00','2026-11-19T01:00'],'wave_height':[1,None],'wave_period':[8,9],'swell_wave_period':[10,11]}}
 def test_global_units_missing_hours_and_thunderstorm_survive(self):
  out=p.open_meteo(self.location,self.location['forecast_points'][0],self.fixture)
  self.assertEqual(out['location_id'],'sydney_au');self.assertIsNone(out['issued_at'])
  f=out['records'][0]['fields'];self.assertAlmostEqual(f['seas_ft'][0]['value'],3.280839895)
  self.assertEqual(len(f['seas_ft']),1);self.assertEqual(len(f['wind_knots']),1)
  self.assertEqual(f['weather'][0]['value'][0]['weather'],'thunderstorm')
 def test_tides_do_not_claim_mllw_and_credit_attribution_is_preserved(self):
  def get(host,path,params):return {'status':200,'responseDatum':'MSL','copyright':'Synthetic attribution','extremes':[{'dt':int(p.instant('2026-11-19T01:00:00Z').timestamp()),'type':'High','height':1}]}
  with patch.dict(os.environ,{'WORLDTIDES_API_KEY':'synthetic-key'}):out=p.worldtides(self.location,self.window,get)
  self.assertEqual(out['records'][0]['datum'],'MSL');self.assertIn('Synthetic attribution',' '.join(out['warnings']))
 def test_missing_key_never_makes_a_paid_request(self):
  with patch.dict(os.environ,{'WORLDTIDES_API_KEY':''}):out=p.worldtides(self.location,self.window,lambda *a:self.fail('unfunded call'))
  self.assertEqual(out['status'],'failed');self.assertEqual(out['records'],[])
 def test_provider_failure_and_official_warning_gap_stay_visible(self):
  with patch.dict(os.environ,{'WORLDTIDES_API_KEY':''}):out=p.global_collect({'location':self.location,'window':self.window},lambda *a:(_ for _ in ()).throw(ValueError('unavailable')))
  self.assertTrue(all(c['status']=='failed' for c in out['collectors']))
 def test_stale_or_wrong_location_alerts_cannot_mean_all_clear(self):
  with tempfile.TemporaryDirectory() as d,patch.dict(os.environ,{'ALERTS_DIR':d}):
   file=Path(d)/'sydney_au.json';now=dt.datetime.now(dt.timezone.utc).isoformat()
   file.write_text(json.dumps({'location_id':'sydney_au','checked_at':now,'authority_url':'https://example.com/official','features':[]}))
   self.assertEqual(p.global_alerts(self.location)['features'],[])
   file.write_text(json.dumps({'location_id':'wrong','checked_at':now,'authority_url':'https://example.com/official','features':[]}))
   self.assertIn('error',p.global_alerts(self.location))

if __name__=='__main__':unittest.main()
