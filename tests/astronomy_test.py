"""Checks the exact prior local night used by the fishing interpretation."""
import unittest
from datetime import datetime
from service import astronomy

class AstronomyTests(unittest.TestCase):
    def test_prior_night_and_phase_are_dated_and_bounded(self):
        result=astronomy({'latitude':28.41,'longitude':-80.59,'timezone':'America/New_York','dates':['2026-10-01','2026-10-07']})
        for record in result['records']:
            night=record['preceding_night']
            self.assertEqual(datetime.fromisoformat(night['end']).date().isoformat(),record['date'])
            self.assertLess(datetime.fromisoformat(night['start']).date(),datetime.fromisoformat(night['end']).date())
            self.assertGreater(night['night_hours'],10)
            self.assertTrue(0<=night['moon_above_horizon_hours']<=night['night_hours'])
            self.assertTrue(0<=night['illumination_percent']<=100)
            self.assertIn('cloud cover not included',night['scope'])
        self.assertGreater(result['records'][0]['illumination_percent'],result['records'][1]['illumination_percent'])
        self.assertGreater(result['records'][0]['preceding_night']['moon_above_horizon_hours'],result['records'][1]['preceding_night']['moon_above_horizon_hours'])

    def test_dst_nights_use_actual_elapsed_time(self):
        result=astronomy({'latitude':28.41,'longitude':-80.59,'timezone':'America/New_York','dates':['2026-11-01','2026-03-08']})
        for record in result['records']:
            n=record['preceding_night']
            elapsed=(datetime.fromisoformat(n['end'])-datetime.fromisoformat(n['start'])).total_seconds()/3600
            self.assertAlmostEqual(n['night_hours'],elapsed,places=2)

if __name__=='__main__':unittest.main()
