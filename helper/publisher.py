"""Read publisher-owned species/month data without a species recommendation list."""
import datetime as dt
import json
import re
from urllib.parse import urlsplit


def source_fields(tree, url):
    result = {'species_catalog': [], 'seasonal_ratings': [], 'seasonal_month': None}
    # Parse JSON as data only. Never evaluate publisher JavaScript.
    if urlsplit(url).hostname != 'www.sealeveler.com':
        return result
    match = re.fullmatch(r'/fishing-month/([a-z]+)/?', urlsplit(url).path)
    months = [dt.date(2000, m, 1).strftime('%B').lower() for m in range(1, 13)]
    if not match or match[1] not in months:
        return result
    month = months.index(match[1]) + 1
    for script in tree.xpath('//script/text()'):
        marker = re.search(r'window\.SLMonthlyBuilderData\s*=\s*', script)
        if not marker:
            continue
        try:
            data = json.JSONDecoder().raw_decode(script[marker.end():])[0]
        except (ValueError, TypeError):
            continue
        if not isinstance(data, dict) or not isinstance(data.get('fish'), list):
            continue
        result['seasonal_month'] = month
        for fish in data.get('fish', [])[:100]:
            if not isinstance(fish, dict):
                continue
            label = fish.get('label', '')
            ratings = fish.get('ratings', [])
            if not isinstance(label, str) or not re.fullmatch(r'[A-Za-z][A-Za-z ()/-]{1,65}', label):
                continue
            result['species_catalog'].append(label)
            if not isinstance(ratings, list) or len(ratings) != 12 or type(ratings[month-1]) is not int or not 0 <= ratings[month-1] <= 5:
                continue
            result['seasonal_ratings'].append({'species': label, 'month': month,
                'rating': ratings[month-1], 'scale': '0–5 publisher seasonal opportunity rating; not a catch probability',
                'areas': [a for a in fish.get('areas', []) if a in ['offshore', 'nearshore', 'long_range']]})
        # Use the selected month's fishing paragraphs, excluding other months,
        # historical average temperatures and booking/weather claims.
        passages = []
        for row in data.get('months', []):
            if row.get('month_number') == month:
                passages.append(row.get('month_description', ''))
        for row in data.get('trips', []):
            if row.get('month_number') == month:
                passages.append(row.get('why_this_trip', ''))
        result['seasonal_text'] = '\n'.join(passages)[:20000]
        break
    return result


def title_targets(title):
    # A publisher's explicit target in a title can extend the legacy recognizer.
    # It remains an attributed report target, not a hard-coded hot-fish list.
    match = re.fullmatch(r'([A-Za-z -]{2,45})\s+Run\W*', title.strip(), re.I)
    return [match[1].strip()] if match else []
