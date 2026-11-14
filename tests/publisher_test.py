import json
import sys
import unittest
from pathlib import Path
from lxml import html
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'helper'))
from publisher import source_fields, title_targets


class PublisherTest(unittest.TestCase):
    def test_source_owned_species_and_month(self):
        data = {'fish': [{'label': 'Silver examplefish', 'ratings': [1]*10+[5,2], 'areas': ['offshore']}],
                'months': [{'month_number': 11, 'month_description': 'November offshore example.'}],
                'trips': [{'month_number': 8, 'why_this_trip': 'Wrong season.'}, {'month_number': 11, 'why_this_trip': 'Bottom fishing offshore.'}]}
        tree = html.fromstring('<html><script>window.SLMonthlyBuilderData='+json.dumps(data)+';</script></html>')
        result = source_fields(tree, 'https://www.sealeveler.com/fishing-month/november/')
        self.assertEqual(result['species_catalog'], ['Silver examplefish'])
        self.assertEqual(result['seasonal_ratings'][0]['rating'], 5)
        self.assertNotIn('Wrong season', result['seasonal_text'])
        self.assertEqual(source_fields(tree, 'https://spacefish.com/')['seasonal_ratings'], [])

    def test_no_species_list_for_title_target(self):
        self.assertEqual(title_targets('Silver Examplefish Run!'), ['Silver Examplefish'])
        self.assertEqual(title_targets('Weekend Report'), [])


if __name__ == '__main__':
    unittest.main()
