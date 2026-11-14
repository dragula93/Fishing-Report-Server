"""Worldwide marine/wind and tide adapters. Credentials never leave this process."""
import datetime as dt
import json
import math
import os
from pathlib import Path
import re
import urllib.parse
import urllib.request

UTC = dt.timezone.utc
HOSTS = {'api.open-meteo.com', 'marine-api.open-meteo.com',
         'customer-api.open-meteo.com', 'customer-marine-api.open-meteo.com', 'www.worldtides.info'}

def instant(value):
    return dt.datetime.fromisoformat(value.replace('Z', '+00:00')).astimezone(UTC)

def fetch_json(host, path, params):
    if host not in HOSTS:
        raise ValueError('Unapproved provider')
    class NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, *args, **kwargs):
            raise ValueError('Provider redirect refused')
    url = 'https://' + host + path + '?' + urllib.parse.urlencode(params)
    try:
        with urllib.request.build_opener(NoRedirect).open(
            urllib.request.Request(url, headers={'User-Agent': 'FishingReport/1.0'}), timeout=20) as response:
            body = response.read(2_000_001)
        if len(body) > 2_000_000:
            raise ValueError('Provider response exceeds limit')
        data = json.loads(body)
        if data.get('error'):
            raise ValueError('Provider rejected request')
        return data
    except Exception as exc:
        # HTTPError/URLError may contain a key-bearing URL. Never propagate it.
        raise ValueError('Provider request failed: ' + type(exc).__name__) from None

def envelope(location, source, status='failed', records=None, url=None, warnings=None):
    return dict(source_id=source, location_id=location['id'], status=status,
                retrieved_at=dt.datetime.now(UTC).isoformat(), issued_at=None,
                records=records or [], warnings=warnings or [], error=None if status!='failed' else 'Provider unavailable', url=url)

def hourly_intervals(data, variable, factor=1, unit=None):
    hourly=data.get('hourly', {})
    times=hourly.get('time', [])
    values=hourly.get(variable, [])
    if len(times)!=len(values):
        return []
    rows=[]
    for at,value in zip(times,values):
        if isinstance(value,(int,float)) and math.isfinite(value):
            start=dt.datetime.fromisoformat(at).replace(tzinfo=UTC) if '+' not in at and not at.endswith('Z') else instant(at)
            rows.append(dict(start=start.isoformat(),end=(start+dt.timedelta(hours=1)).isoformat(), value=value*factor,unit=unit))
    return rows

def open_meteo(location, point, get=fetch_json):
    common=dict(latitude=point['latitude'], longitude=point['longitude'], timezone='GMT', forecast_days=7)
    key=os.environ.get('OPEN_METEO_API_KEY','')
    if key: common['apikey']=key
    weather_host='customer-api.open-meteo.com' if key else 'api.open-meteo.com'
    marine_host='customer-marine-api.open-meteo.com' if key else 'marine-api.open-meteo.com'
    w=get(weather_host,'/v1/forecast',dict(common,hourly='wind_speed_10m,wind_gusts_10m,wind_direction_10m,weather_code',wind_speed_unit='kn',cell_selection='nearest'))
    m=get(marine_host,'/v1/marine',dict(common,hourly='wave_height,wave_period,swell_wave_period',cell_selection='sea'))
    wu=w.get('hourly_units',{});mu=m.get('hourly_units',{})
    if wu.get('wind_speed_10m')!='kn' or wu.get('wind_gusts_10m')!='kn' or mu.get('wave_height')!='m' or mu.get('wave_period')!='s':
        raise ValueError('Unexpected provider units')
    fields=dict(wind_knots=hourly_intervals(w,'wind_speed_10m',unit='knots'),
                gust_knots=hourly_intervals(w,'wind_gusts_10m',unit='knots'),
                wind_direction=hourly_intervals(w,'wind_direction_10m',unit='degrees'),
                seas_ft=hourly_intervals(m,'wave_height',1/0.3048,'feet'),
                period_seconds=hourly_intervals(m,'wave_period',unit='seconds'),
                period2_seconds=hourly_intervals(m,'swell_wave_period',unit='seconds'),hazards=[],weather=[])
    for row in hourly_intervals(w,'weather_code'):
        if row['value'] in [95,96,99]: fields['weather'].append(dict(row,value=[{'weather':'thunderstorm'}]))
    result=envelope(location,'grid_'+point['id'],'ok', [dict(point_id=point['id'],zone=point.get('zone',point['id']),fields=fields)],'https://open-meteo.com/')
    # Fetch time is NOT model issuance. Keep unknown issue time explicit.
    result['warnings']=['Open-Meteo model forecast; model issuance time unavailable. Open-Meteo data: CC BY 4.0. Marine model coverage varies; missing hours remain unavailable.']
    if not fields['seas_ft'] or not fields['wind_knots']: result['status']='failed'
    result['coverage']={k:rows[-1]['end'] if rows else None for k,rows in fields.items()}
    return result

def worldtides(location, window, get=fetch_json):
    result=envelope(location,'noaa_tides',url='https://www.worldtides.info/')
    key=os.environ.get('WORLDTIDES_API_KEY','')
    if not key:
        result['warnings']=['Worldwide tides unavailable: set WORLDTIDES_API_KEY in deploy/.env.']
        return result
    point=location['astronomy_point']
    data=get('www.worldtides.info','/api/v3',dict(extremes='',lat=point['latitude'],lon=point['longitude'],
             start=int(instant(window['start_utc']).timestamp()), length=int((instant(window['end_utc'])-instant(window['start_utc'])).total_seconds()),
             datum=location.get('tide_datum','MSL'),key=key))
    if data.get('status')!=200 or not data.get('responseDatum') or not data.get('copyright'):
        raise ValueError('Invalid tide response or missing attribution/datum')
    records=[]
    for row in data.get('extremes',[]):
        at=dt.datetime.fromtimestamp(row['dt'],UTC)
        if instant(window['start_utc'])<=at<instant(window['end_utc']) and row.get('type') in ['High','Low'] and isinstance(row.get('height'),(int,float)):
            records.append(dict(time_utc=at.isoformat(),height_ft=row['height']/0.3048,type=row['type'][0],datum=data['responseDatum']))
    result.update(status='ok' if records else 'empty',error=None,records=records,
                  warnings=['WorldTides prediction; datum: '+data['responseDatum']+'. '+str(data['copyright'])])
    return result

def global_alerts(location):
    """Read operator-managed, location-scoped official GeoJSON. No universal all-clear."""
    result={'type':'FeatureCollection','features':[]}
    name=location['id']
    if not re.fullmatch(r'[a-z0-9_-]{1,80}',name): raise ValueError('Invalid location ID')
    path=Path(os.environ.get('ALERTS_DIR','/data/alerts'))/(name+'.json')
    try:
        if path.stat().st_size>500_000: raise ValueError('Oversized warnings')
        data=json.loads(path.read_text())
        age=(dt.datetime.now(UTC)-instant(data['checked_at'])).total_seconds()
        if data.get('location_id')!=name or not 0<=age<=3600 or not str(data.get('authority_url','')).startswith('https://') or not isinstance(data.get('features'),list):
            raise ValueError('Invalid warning feed')
        for f in data['features']:
            p=f['properties']
            if not p.get('event') or not p.get('onset',p.get('effective')) or not p.get('ends',p.get('expires')): raise ValueError('Undated warning')
            instant(p.get('onset',p.get('effective')));instant(p.get('ends',p.get('expires')))
        result['features']=data['features'];result['authority_url']=data['authority_url']
        return result
    except (OSError,ValueError,KeyError,TypeError):
        return {'error':'Official warning status unavailable: configure a fresh location-specific authority feed.'}

def global_collect(payload, get=fetch_json):
    location=payload['location'];window=payload['window'];collectors=[]
    if len(location['forecast_points'])>8: raise ValueError('Too many forecast points')
    for point in location['forecast_points']:
        try: collectors.append(open_meteo(location,point,get))
        except Exception: collectors.append(envelope(location,'grid_'+point['id'],warnings=['Open-Meteo forecast unavailable.']))
    try: collectors.append(worldtides(location,window,get))
    except Exception: collectors.append(envelope(location,'noaa_tides',warnings=['WorldTides unavailable. Check account, credits and coordinates.']))
    alerts=global_alerts(location)
    records=[dict(id=f.get('id'),**f['properties']) for f in alerts.get('features',[])]
    collectors.append(envelope(location,'nws_alerts','failed' if alerts.get('error') else 'ok' if records else 'empty',records,alerts.get('authority_url'),[alerts['error']] if alerts.get('error') else []))
    return {'location_id':location['id'],'collectors':collectors}
