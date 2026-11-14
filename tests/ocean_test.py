import sys, tempfile, unittest
from pathlib import Path
import numpy as np
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'helper'))
import sst

ROOT=Path(__file__).resolve().parents[1]

class OceanTests(unittest.TestCase):
    def test_temperature_absolute_and_difference_conversions_are_distinct(self):
        self.assertAlmostEqual(sst.c_to_f(20),68)
        self.assertAlmostEqual(sst.delta_c_to_f(2),3.6)
        self.assertAlmostEqual(sst.k_per_km_to_f_per_nm(.15),.50004)
        values,mask=sst.normalize_cf_values([273.15,274.15,-32768],[{'_FillValue':-32768}][0], 'K')
        self.assertEqual(values[0],0);self.assertEqual(values[1],1);self.assertFalse(mask[2])
    def test_uniform_scene_has_no_gradient_and_missing_edge_masks_stencil(self):
        lat=np.linspace(27.8,28.2,41);lon=np.linspace(-80.8,-80.4,41)
        scene=np.ones((41,41))*24
        g=sst.metric_gradient(scene,lat,lon)
        self.assertTrue(np.isnan(g[0,0]));self.assertAlmostEqual(np.nanmax(g),0)
        scene[20,20]=np.nan;g=sst.metric_gradient(scene,lat,lon)
        self.assertTrue(np.isnan(g[20,19]));self.assertTrue(np.isnan(g[20,20]))
        self.assertEqual(sst.detect_breaks(scene,lat,lon),[])
    def test_metric_gradient_and_axis_directions(self):
        lat=np.linspace(28.2,27.8,41);lon=np.linspace(279.2,279.6,41)
        # 0.2 C/km north-south slope, coordinates deliberately descend and use 0..360 longitude.
        scene=np.repeat((24+0.2*(lat[:,None]-28)*111.195),41,axis=1)
        g=sst.metric_gradient(scene,lat,lon)
        self.assertAlmostEqual(float(np.nanmedian(g)),.2,places=2)
        self.assertTrue(sst.detect_breaks(scene,lat,lon,gradient_threshold=.15,contrast_threshold=.5))
    def test_mur_breaks_are_analysis_only_with_same_locator_references(self):
        points=[{'point_id':'p1','name':'BV-1','source':'fixture','source_hash':'gpx-a','latitude':28.4,'longitude':-80.2}]
        candidate={'kind':'temperature_break','method':'derived_metric_gradient','supported_transects':5,'length_km':8,'median_contrast_c':1.1,'median_gradient_c_per_km':.3,'transect_width_km':4,'locator':{'latitude':28.42,'longitude':-80.15},'geometry':{'type':'LineString','coordinates':[[-80.2,28.4],[-80.15,28.42]]}}
        features=sst.mur_analysis_features([candidate],'a'*64,points,'2026-11-07T09:00:00Z',48,.85)
        self.assertEqual(len(features),1);feature=features[0]
        self.assertEqual(feature['confidence']['label'],'analysis-only');self.assertEqual(feature['circulation_support'],'unknown')
        self.assertEqual(feature['waypoint_references'][0]['name'],'BV-1');self.assertEqual(feature['waypoint_references'][0]['role'],'nearest')
        self.assertEqual(feature['ranking']['policy'],'contrast-first-v1')
        self.assertEqual(sst.mur_analysis_features([candidate],'a'*64,points,'2026-11-01T09:00:00Z',144,.85),[])
    def test_invalid_and_negative_uncertainty_rejected(self):
        self.assertEqual(sst.uncertainty_mask([-1,0,.5,7]).tolist(),[False,True,True,False])
        self.assertEqual(sst.uncertainty_mask([.4],"degree_C").tolist(),[True])
    def test_gpx_synthetic_points_ignore_metadata_bounds(self):
        with tempfile.TemporaryDirectory() as d:
            p=Path(d)/'synthetic.gpx'
            p.write_text('<gpx><metadata><bounds minlat="88"/></metadata><wpt lat="0.1" lon="0.2"><name>Fixture A</name></wpt><wpt lat="0.3" lon="0.4"><name>Fixture B</name></wpt></gpx>')
            points,diag,snapshots,status=sst.parse_gpx([p])
            self.assertEqual((len(points),status),(2,'ok'))
            self.assertEqual(points[0]['name'],'Fixture A')
            self.assertNotIn(88,[v['latitude'] for v in points])
    def test_gpx_missing_and_doctype_are_explicit(self):
        with tempfile.TemporaryDirectory() as d:
            bad=Path(d)/'bad.gpx';bad.write_text('<!DOCTYPE gpx [<!ENTITY x SYSTEM "file:///secret">]><gpx>&x;</gpx>')
            pts,diag,_,status=sst.parse_gpx([bad,Path(d)/'missing.gpx'])
            self.assertEqual(pts,[]);self.assertEqual(status,'unavailable');self.assertEqual(diag[0]['status'],'failed')
    def test_wgs84_reference_bearing_direction_coincidence_and_second_point(self):
        pts=[{'point_id':'a','name':'A','source':'a.gpx','source_hash':'a','latitude':28.0,'longitude':-80.0},
             {'point_id':'b','name':'B','source':'b.gpx','source_hash':'b','latitude':28.2,'longitude':-80.0},
             {'point_id':'cluster','name':'A2','source':'a.gpx','source_hash':'a','latitude':28.00001,'longitude':-80.0}]
        refs=sst.waypoint_references({'latitude':28.1,'longitude':-79.9},pts,.1)
        self.assertEqual([r['name'] for r in refs],['B','A'])
        self.assertTrue(120<refs[0]['initial_bearing_true_deg']<160)
        same=sst.waypoint_references({'latitude':28.0,'longitude':-80.0},pts,.1)
        self.assertEqual(same[0]['wording'],'near');self.assertIsNone(same[0]['displayed_bearing_true_deg'])
        self.assertTrue(all(r['point_id'] in {'a','b','cluster'} for r in refs))
    def test_freshness_and_eddy_requires_co_timed_coherent_support(self):
        self.assertEqual(sst.analyze_freshness(36,'satellite_composite'),'current')
        self.assertEqual(sst.analyze_freshness(72,'satellite_composite'),'aging')
        self.assertEqual(sst.analyze_freshness(73,'satellite_composite'),'stale')
        self.assertEqual(sst.analyze_freshness(None,'satellite_composite'),'unknown')
        self.assertEqual(sst.assess_circulation(True,True,2,4,48,6),'model_supported')
        self.assertEqual(sst.assess_circulation(True,True,2,3,20,1),'unsupported')
        self.assertEqual(sst.assess_circulation(True,True,2,4,49,1),'unsupported')
    def test_atomic_cache_and_waypoint_hash_change(self):
        with tempfile.TemporaryDirectory() as d:
            path=Path(d)/'cache.json';sst.atomic_cache_write(path,{'retrieved_at':'2026-01-01T00:00:00+00:00','x':1})
            self.assertEqual(sst.cache_read(path,'2026-01-01T01:00:00+00:00')['cache_age_hours'],1)
            original=Path(d)/'original.gpx';original.write_text('<gpx><wpt lat="0.1" lon="0.2"><name>Fixture</name></wpt></gpx>')
            a=sst.cache_identity([original],{'a':1})
            copy=Path(d)/'changed.gpx';copy.write_text(original.read_text()+'\n')
            b=sst.cache_identity([copy],{'a':1});self.assertNotEqual(a,b)
    def test_cache_map_attachment_is_hash_checked_and_bounded(self):
        import base64,hashlib
        with tempfile.TemporaryDirectory() as d:
            data=b'\x89PNG\r\n\x1a\nfixture bytes';path=Path(d)/'port_canaveral_fl-snapshot.png';path.write_bytes(data)
            summary={'snapshot_id':'snapshot','map':{'status':'ok','relative_path':path.name,'sha256':hashlib.sha256(data).hexdigest()}}
            out=sst.attach_map_artifact(summary,d)
            self.assertEqual(base64.b64decode(out['map']['artifact_base64']),data)
            self.assertEqual(out['map']['attachment_filename'],'ocean-features-snapshot.png')
            with self.assertRaises(ValueError):sst.attach_map_artifact({'snapshot_id':'x','map':{'status':'ok','relative_path':'../secret.png','sha256':'0'*64}},d)
            with self.assertRaises(ValueError):sst.attach_map_artifact({'snapshot_id':'x','map':{'status':'ok','relative_path':path.name,'sha256':'0'*64}},d)
    def test_provider_body_rejects_html_as_data_and_large_responses(self):
        class Resp:
            def __init__(self,data):self.data=data
            def __enter__(self):return self
            def __exit__(self,*args):pass
            def read(self,n):return self.data[:n]
            def geturl(self):return 'https://coastwatch.pfeg.noaa.gov/test'
        def opener(*args,**kwargs):return Resp(b'<html>not numeric data</html>')
        data=sst.bounded_fetch('https://coastwatch.pfeg.noaa.gov/test',opener=opener)
        self.assertTrue(data.startswith(b'<html>')) # caller must parse the expected numeric format
        with self.assertRaises(ValueError):sst.parse_numeric_csv(data)
        csv=b'"time","latitude","longitude","analysed_sst"\n"UTC","degrees_north","degrees_east","degree_C"\n"2026-11-05T09:00:00Z",28.42,-80.60,25.1\n'
        self.assertEqual(sst.parse_numeric_csv(csv)['records'][0]['analysed_sst'],25.1)
        def large(*args,**kwargs):return Resp(b'x'*20)
        with self.assertRaises(ValueError):sst.bounded_fetch('https://coastwatch.pfeg.noaa.gov/test',max_bytes=10,opener=large)
        def timeout(*args,**kwargs):raise TimeoutError('fixture timeout')
        with self.assertRaises(TimeoutError):sst.bounded_fetch('https://coastwatch.pfeg.noaa.gov/test',opener=timeout)
    def test_map_renderer_writes_hashed_fahrenheit_fixture_with_gaps_and_land(self):
        lat=np.linspace(27.8,28.2,15);lon=np.linspace(-80.8,-80.4,15)
        scene=np.repeat(np.linspace(23,26,15)[:,None],15,axis=1);mask=np.ones(scene.shape,dtype=bool);mask[6:9,7:10]=False
        land=np.zeros(scene.shape,dtype=bool);land[:2,:]=True
        with tempfile.TemporaryDirectory() as d:
            result=sst.render_map_png(Path(d)/'fixture.png',lat,lon,scene,[],source_class='satellite_composite',source_label='SYNTHETIC fixture',analysis_time='2026-11-05T09:00:00Z',observed_mask=mask,land_mask=land)
            self.assertEqual(result['data_class'],'satellite_composite');self.assertEqual(result['mime_type'],'image/png');self.assertEqual(len(result['sha256']),64)
            self.assertTrue((Path(d)/'fixture.png').read_bytes().startswith(b'\x89PNG'))

if __name__=='__main__':unittest.main()
