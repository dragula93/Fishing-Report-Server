"""Bounded SST/ocean-feature utilities. No scheduler and no arbitrary URL fetch API."""
from __future__ import annotations

import datetime as dt
import base64
import hashlib
import json
import csv
import math
import os
import re
import shutil
import tempfile
import time
import urllib.request
import xml.etree.ElementTree as ET
from pathlib import Path
from typing import Any

import numpy as np

NM_M = 1852.0
EARTH_M = 6371008.8
COMPASS = ("N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW")
ALLOWED_HOSTS = {"coastwatch.pfeg.noaa.gov", "coastwatch.noaa.gov", "www.star.nesdis.noaa.gov", "ncss.hycom.org", "tds.hycom.org"}


def c_to_f(value: float) -> float:
    return float(value) * 9 / 5 + 32


def delta_c_to_f(value: float) -> float:
    return float(value) * 1.8


def k_per_km_to_f_per_nm(value: float) -> float:
    return float(value) * 3.3336


def normalize_longitudes(values):
    a = np.asarray(values, dtype=float)
    return (a + 180) % 360 - 180


def normalize_cf_values(raw, attrs: dict[str, Any], units: str | None = None):
    """Return Celsius values and a validity mask; offsets apply only to absolutes."""
    a = np.asarray(raw, dtype=float)
    valid = np.isfinite(a)
    for k in ("_FillValue", "missing_value"):
        if k in attrs:
            valid &= a != float(attrs[k])
    a = a * float(attrs.get("scale_factor", 1)) + float(attrs.get("add_offset", 0))
    u = (units or attrs.get("units") or "").lower().strip()
    if u in {"k", "kelvin", "degrees_k", "degree_k"}:
        a = a - 273.15
    elif u in {"c", "degree_c", "degrees_c", "degree_celsius", "degrees_celsius", "celsius"}:
        pass
    else:
        raise ValueError(f"Unsupported absolute temperature units: {u or 'unknown'}")
    valid &= (a > -3) & (a < 45)
    return np.where(valid, a, np.nan), valid


def uncertainty_mask(values, units="degree_Celsius"):
    a = np.asarray(values, dtype=float)
    # A standard deviation cannot be negative; implausible metadata is not repaired.
    valid = np.isfinite(a) & (a >= 0) & (a <= 5)
    if units.lower() not in {"degree_c", "degrees_c", "degree_celsius", "degrees_celsius", "c", "k", "kelvin"}:
        valid[:] = False
    return valid


def metric_gradient(sst_c, latitudes, longitudes, valid=None):
    """Mask-aware central differences in C/km; no cloud or land gap filling."""
    a = np.asarray(sst_c, dtype=float)
    lat = np.asarray(latitudes, dtype=float)
    lon = normalize_longitudes(longitudes)
    if a.ndim != 2 or a.shape != (lat.size, lon.size) or lat.size < 3 or lon.size < 3:
        raise ValueError("SST grid and coordinate axes do not agree")
    ok = np.isfinite(a) if valid is None else np.asarray(valid, dtype=bool) & np.isfinite(a)
    dx = np.deg2rad(np.diff(lon)) * EARTH_M * np.cos(np.deg2rad(np.mean(lat)))
    dy = np.deg2rad(np.diff(lat)) * EARTH_M
    if np.any(np.abs(dx) < 1) or np.any(np.abs(dy) < 1):
        raise ValueError("Invalid coordinate spacing")
    gx = np.full_like(a, np.nan); gy = np.full_like(a, np.nan)
    for j in range(1, a.shape[1]-1):
        supported = ok[:, j-1] & ok[:, j] & ok[:, j+1]
        gx[supported, j] = (a[supported, j+1]-a[supported, j-1]) / (dx[j-1]+dx[j]) * 1000
    for i in range(1, a.shape[0]-1):
        supported = ok[i-1, :] & ok[i, :] & ok[i+1, :]
        gy[i, supported] = (a[i+1, supported]-a[i-1, supported]) / (dy[i-1]+dy[i]) * 1000
    g = np.hypot(gx, gy)
    g[~np.isfinite(gx) | ~np.isfinite(gy)] = np.nan
    return g


def detect_breaks(sst_c, latitudes, longitudes, valid=None, gradient_threshold=0.15,
                  contrast_threshold=0.5, transect_km=4.0, min_length_km=5.0):
    """Small-grid, deterministic front screen. Returns supported transects, not fishing forecasts."""
    a=np.asarray(sst_c,dtype=float); lat=np.asarray(latitudes,dtype=float); lon=normalize_longitudes(longitudes)
    ok=np.isfinite(a) if valid is None else np.asarray(valid,dtype=bool)&np.isfinite(a)
    grad=metric_gradient(a,lat,lon,ok)
    dx=float(np.median(np.abs(np.diff(lon))))*111.195*math.cos(math.radians(float(np.mean(lat))))
    dy=float(np.median(np.abs(np.diff(lat))))*111.195
    if min(dx,dy)<=0: return []
    # Only transects that can be measured at the requested scale without interpolation qualify.
    points=[]
    for i in range(1,a.shape[0]-1):
      for j in range(1,a.shape[1]-1):
        if not np.isfinite(grad[i,j]) or grad[i,j]<gradient_threshold: continue
        gx=abs(float(a[i,j+1]-a[i,j-1]))/(2*dx)
        gy=abs(float(a[i+1,j]-a[i-1,j]))/(2*dy)
        axis=1 if gx>=gy else 0
        spacing=dx if axis==1 else dy
        if spacing>=transect_km/2: continue
        count=max(1,round((transect_km/2)/spacing))
        center=j if axis==1 else i
        indices=range(center-count,center+count+1)
        if min(indices)<0 or max(indices)>=(a.shape[1] if axis==1 else a.shape[0]): continue
        side_a=[];side_b=[];neighbors=[];supported=True
        for k in indices:
          ia,ja=(i,k) if axis==1 else (k,j)
          if not ok[ia,ja]: supported=False;break
          # The front center itself belongs to neither side. Missing samples reject the transect.
          if k<center: side_a.append(float(a[ia,ja]))
          elif k>center: side_b.append(float(a[ia,ja]))
          neighbors.append((ia,ja))
        if not supported or not side_a or not side_b: continue
        contrast=abs(float(np.median(side_a))-float(np.median(side_b)))
        if contrast < contrast_threshold: continue
        points.append({"row":i,"column":j,"latitude":float(lat[i]),"longitude":float(lon[j]),"gradient_c_per_km":float(grad[i,j]),"contrast_c":contrast,"transect_width_km":transect_km,"method":"derived_metric_gradient"})
    # Group only adjacent supported candidates; omit isolated detections, which cannot make a section.
    remaining=set((p['row'],p['column']) for p in points); by={(p['row'],p['column']):p for p in points}; out=[]
    while remaining:
      seed=remaining.pop(); stack=[seed]; group=[seed]
      while stack:
        r,c=stack.pop()
        for q in list(remaining):
          if max(abs(q[0]-r),abs(q[1]-c))<=1: remaining.remove(q);stack.append(q);group.append(q)
      cells=len(group); length=(cells-1)*min(dx,dy)
      if cells<3 or length<min_length_km: continue
      rows=[by[q] for q in group]; rows.sort(key=lambda p:(p['latitude'],p['longitude']))
      representative=min(rows,key=lambda p:(abs(p['contrast_c']-float(np.median([v['contrast_c'] for v in rows]))),p['latitude'],p['longitude']))
      coords=[[p['longitude'],p['latitude']] for p in rows]
      if abs(coords[-1][0]-coords[0][0])>=abs(coords[-1][1]-coords[0][1]): coords.sort(key=lambda p:p[0])
      else: coords.sort(key=lambda p:p[1])
      out.append({"kind":"temperature_break","method":"derived_metric_gradient","supported_transects":cells,"length_km":length,"median_contrast_c":float(np.median([p['contrast_c'] for p in rows])),"median_gradient_c_per_km":float(np.median([p['gradient_c_per_km'] for p in rows])),"max_gradient_c_per_km":max(p['gradient_c_per_km'] for p in rows),"transect_width_km":transect_km,"locator":{"latitude":representative['latitude'],"longitude":representative['longitude']},"geometry":{"type":"LineString","coordinates":coords}})
    return sorted(out,key=lambda x:(-x['median_contrast_c'],-x['length_km'],x['locator']['latitude'],x['locator']['longitude']))


def analyze_freshness(age_hours, class_name):
    if age_hours is None: return "unknown"
    if class_name=="satellite_composite":
        return "current" if age_hours<=36 else "aging" if age_hours<=72 else "stale"
    if class_name=="analysed_sst": return "current" if age_hours<=72 else "stale"
    return "unknown"


def assess_circulation(rotation_coherent, sea_level_compatible, persistent_times, diameter_cells, model_age_hours, time_offset_hours):
    if any(v is None for v in (rotation_coherent, persistent_times, diameter_cells, model_age_hours, time_offset_hours)):
        return "unknown"
    if model_age_hours>48 or time_offset_hours>6 or diameter_cells<4 or not rotation_coherent or persistent_times<2:
        return "unsupported"
    if sea_level_compatible is False: return "unsupported"
    return "model_supported"


def _vincenty(lat1, lon1, lat2, lon2):
    """WGS84 inverse; returns distance metres and initial true bearing degrees."""
    a, f = 6378137.0, 1 / 298.257223563
    b = (1-f)*a
    phi1, phi2 = math.radians(lat1), math.radians(lat2)
    L = math.radians(lon2-lon1)
    U1, U2 = math.atan((1-f)*math.tan(phi1)), math.atan((1-f)*math.tan(phi2))
    sinU1, cosU1, sinU2, cosU2 = math.sin(U1), math.cos(U1), math.sin(U2), math.cos(U2)
    lam = L
    for _ in range(100):
        sl, cl = math.sin(lam), math.cos(lam)
        ss = math.sqrt((cosU2*sl)**2 + (cosU1*sinU2-sinU1*cosU2*cl)**2)
        if ss == 0: return 0.0, None
        cs = sinU1*sinU2+cosU1*cosU2*cl
        sigma = math.atan2(ss, cs); sa = cosU1*cosU2*sl/ss
        c2a = 1-sa*sa
        c2sm = 0 if c2a == 0 else cs-2*sinU1*sinU2/c2a
        C = f/16*c2a*(4+f*(4-3*c2a))
        nxt = L+(1-C)*f*sa*(sigma+C*ss*(c2sm+C*cs*(-1+2*c2sm*c2sm)))
        if abs(nxt-lam) < 1e-12: lam=nxt; break
        lam=nxt
    else:
        # Haversine fallback is stable for the rare near-antipodal non-convergence.
        dphi=phi2-phi1; h=math.sin(dphi/2)**2+math.cos(phi1)*math.cos(phi2)*math.sin(L/2)**2
        return 2*EARTH_M*math.asin(math.sqrt(h)), (math.degrees(math.atan2(math.sin(L)*math.cos(phi2), math.cos(phi1)*math.sin(phi2)-math.sin(phi1)*math.cos(phi2)*math.cos(L)))+360)%360
    u2=c2a*(a*a-b*b)/(b*b)
    A=1+u2/16384*(4096+u2*(-768+u2*(320-175*u2)))
    B=u2/1024*(256+u2*(-128+u2*(74-47*u2)))
    ds=B*ss*(c2sm+B/4*(cs*(-1+2*c2sm*c2sm)-B/6*c2sm*(-3+4*ss*ss)*(-3+4*c2sm*c2sm)))
    dist=b*A*(sigma-ds)
    bearing=(math.degrees(math.atan2(cosU2*math.sin(lam),cosU1*sinU2-sinU1*cosU2*math.cos(lam)))+360)%360
    return dist,bearing


def parse_gpx(paths):
    points=[]; diagnostics=[]; snapshots=[]
    for rawpath in paths:
        path=Path(rawpath)
        try:
            content=path.read_bytes(); digest=hashlib.sha256(content).hexdigest()
            if b"<!DOCTYPE" in content.upper() or b"<!ENTITY" in content.upper(): raise ValueError("External entities/DOCTYPE are not permitted")
            root=ET.fromstring(content); source=path.name
            count=0; invalid=0
            for node in root.iter():
                if node.tag.rsplit("}",1)[-1] != "wpt": continue
                count+=1
                try:
                    lat=float(node.attrib["lat"]); lon=float(node.attrib["lon"])
                    if not math.isfinite(lat+lon) or not (-90<=lat<=90 and -180<=lon<=180): raise ValueError("bad coordinate")
                except (KeyError,ValueError): invalid+=1; continue
                fields={child.tag.rsplit("}",1)[-1]: (child.text or "").strip() for child in node}
                desc=fields.get("cmt") or fields.get("desc")
                if not desc:
                    for child in node.iter():
                        if child.tag.rsplit("}",1)[-1].lower()=="description" and child.text and child.text.strip(): desc=child.text.strip(); break
                name=fields.get("name") or f"unnamed-{count}"
                ident=hashlib.sha256(f"{digest}:{count}:{name}:{lat:.8f}:{lon:.8f}".encode()).hexdigest()[:20]
                points.append({"point_id":ident,"name":name,"description":desc or None,"latitude":lat,"longitude":lon,"source":source,"source_hash":digest})
            diagnostics.append({"source":source,"status":"ok" if invalid==0 else "partial","waypoint_count":count,"valid_count":sum(p["source"]==source for p in points),"invalid_count":invalid,"source_hash":digest})
            snapshots.append({"source":source,"source_hash":digest,"content":content.decode("utf-8-sig")})
        except Exception as exc:
            diagnostics.append({"source":path.name,"status":"failed","error":str(exc)[:160]})
    for record in diagnostics:
        subset=[p for p in points if p["source"]==record["source"]]
        record["recomputed_extents"]=(None if not subset else {"min_latitude":min(p["latitude"] for p in subset),"max_latitude":max(p["latitude"] for p in subset),"min_longitude":min(p["longitude"] for p in subset),"max_longitude":max(p["longitude"] for p in subset)})
    usable=sum(x.get("valid_count",0)>0 for x in diagnostics)
    return points, diagnostics, snapshots, ("ok" if usable==len(paths) else "partial" if usable else "unavailable")


def compass(bearing):
    return COMPASS[int((float(bearing)%360+11.25)//22.5)%16]


def waypoint_references(locator, points, uncertainty_nm=0.0):
    lat,lon=locator["latitude"],locator["longitude"]
    ranked=[]
    for p in points:
        d,b=_vincenty(p["latitude"],p["longitude"],lat,lon)
        ranked.append((d/NM_M,b,p))
    # GPX files can contain tightly clustered marks for the same spot. Keep one
    # deterministic label from each source cluster so the secondary reference
    # identifies another location rather than a duplicate pin.
    ranked.sort(key=lambda x:(x[0],x[2]["point_id"]))
    deduplicated=[]
    for row in ranked:
        duplicate=next((i for i,kept in enumerate(deduplicated)
                        if row[2]["source_hash"]==kept[2]["source_hash"] and
                        _vincenty(row[2]["latitude"],row[2]["longitude"],kept[2]["latitude"],kept[2]["longitude"])[0] <= 0.1*NM_M),None)
        if duplicate is None:
            deduplicated.append(row)
        elif (row[2]["name"].casefold(),row[2]["point_id"]) < (deduplicated[duplicate][2]["name"].casefold(),deduplicated[duplicate][2]["point_id"]):
            deduplicated[duplicate]=row
    ranked=deduplicated
    ranked.sort(key=lambda x:(x[0],x[2]["point_id"]))
    if not ranked: return []
    near=ranked[0]; refs=[_reference(near,"nearest",uncertainty_nm)]
    nearest_nm=near[0]
    maxdist=max(20,2*nearest_nm); baseline=max(1,2*uncertainty_nm)
    for candidate in ranked[1:]:
        if candidate[0]>maxdist: break
        # Baseline and direction are assessed at the locator using waypoint->locator bearings.
        gap,_=_vincenty(near[2]["latitude"],near[2]["longitude"],candidate[2]["latitude"],candidate[2]["longitude"])
        if gap/NM_M<baseline: continue
        angular=abs((near[1]-candidate[1]+180)%360-180) if near[1] is not None and candidate[1] is not None else None
        if angular is None or 30<=angular<=150:
            refs.append(_reference(candidate,"secondary",uncertainty_nm));break
    return refs


def _reference(row,role,uncertainty_nm):
    distance,b,p=row; exact=distance<=uncertainty_nm
    shown=round(distance*2)/2
    bearing=None if b is None or exact else (round(b/5)*5)%360
    return {"point_id":p["point_id"],"name":p["name"],"source":p["source"],"source_hash":p["source_hash"],"latitude":p["latitude"],"longitude":p["longitude"],"distance_nmi":distance,"initial_bearing_true_deg":b,"displayed_distance_nmi":shown,"displayed_bearing_true_deg":bearing,"compass_label":compass(bearing) if bearing is not None else None,"role":role,"rounding_policy":"nearest 0.5 nmi; 5 degree true bearing","wording":"near" if exact else "about"}


def mur_analysis_features(candidates, source_hash, points, analysis_time, analysis_age_hours, coverage, limit=3):
    """Build explicitly analysis-only feature rows from robust MUR transects."""
    if analysis_age_hours is None or analysis_age_hours > 72:
        return []
    selected=[]
    # detect_breaks already returns contrast-first order with deterministic ties.
    for rank,candidate in enumerate(candidates[:limit],1):
        loc=candidate["locator"]
        locator={"latitude":loc["latitude"],"longitude":loc["longitude"],"basis":"representative supported 4 km MUR analyzed transect","uncertainty_km":0.8}
        refs=waypoint_references(loc,points,uncertainty_nm=(math.sqrt(2)*0.555)/NM_M*1000)
        feature_id=hashlib.sha256(f"{source_hash}:{loc['latitude']:.4f}:{loc['longitude']:.4f}".encode()).hexdigest()[:20]
        selected.append({"feature_id":feature_id,"kind":"temperature_break","method":candidate["method"],"geometry":candidate["geometry"],"locator":locator,"contrast_c":candidate["median_contrast_c"],"transect_width_km":candidate["transect_width_km"],"gradient_c_per_km":candidate.get("median_gradient_c_per_km"),"extent_km":candidate["length_km"],"timestamps":{"analysis_time":analysis_time},"evidence_ids":["mur-analysis:"+source_hash[:24]],"coverage":{"analysis_fraction":coverage,"supported_transects":candidate["supported_transects"]},"confidence":{"label":"analysis-only","reasons":["Derived from the analyzed MUR background; not a direct satellite observation.","No validated current or sea-level field supports eddy classification."]},"circulation_support":"unknown","ranking":{"contrast_c":candidate["median_contrast_c"],"policy":"contrast-first-v1","rank":rank},"selection_reason":f"Rank {rank} by robust median contrast on the common 4 km transect scale; MUR analyzed background only.","waypoint_references":refs,"route_eligibility":{"status":"not_verified","route_qualified":False,"distance_is_route":False,"reason":"Waypoint distances are straight-line references; no verified navigable route is configured."}})
    return selected


def cache_identity(gpx_paths, config):
    _, diag, _, _ = parse_gpx(gpx_paths)
    return hashlib.sha256(json.dumps({"gpx":diag,"config":config},sort_keys=True,separators=(",",":")).encode()).hexdigest()


def render_map_png(path, latitudes, longitudes, sst_c, features, *, source_class,
                   source_label, analysis_time, observed_mask=None, land_mask=None, inland_water_mask=None,
                   context_bounds=None):
    """Render a static local PNG from a supplied regional grid; no data are invented here."""
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    from matplotlib.colors import Normalize
    from matplotlib.patches import Patch
    lat=np.asarray(latitudes,dtype=float);lon=normalize_longitudes(longitudes)
    temp=np.asarray(sst_c,dtype=float)
    if temp.shape!=(lat.size,lon.size) or not lat.size or not lon.size: raise ValueError("Grid axes do not match SST array")
    is_observed=source_class=="satellite_composite"
    valid=np.isfinite(temp)
    if is_observed and observed_mask is not None: valid &= np.asarray(observed_mask,dtype=bool)
    land=np.zeros(temp.shape,dtype=bool)
    if land_mask is not None:
        land=np.asarray(land_mask,dtype=bool)
        if land.shape!=temp.shape: raise ValueError("Land mask shape differs from SST array")
        valid &= ~land
    if inland_water_mask is not None:
        inland=np.asarray(inland_water_mask,dtype=bool)
        if inland.shape!=temp.shape: raise ValueError("Inland-water mask shape differs from SST array")
        valid &= ~inland
    masked=np.ma.masked_where(~valid,temp)
    fig,ax=plt.subplots(figsize=(11,7.5),constrained_layout=True)
    ax.set_facecolor("#d8e1e6")
    mesh=ax.pcolormesh(lon,lat,masked*1.8+32,shading="auto",cmap="turbo",norm=Normalize(45,90),zorder=1)
    if land_mask is not None:
        land=np.asarray(land_mask,dtype=bool)
        if land.shape!=temp.shape: raise ValueError("Land mask shape differs from SST array")
        # Contour observed land/water transition; use product mask, never a hand-drawn coastline.
        ax.contour(lon,lat,land.astype(float),levels=[.5],colors="#23343a",linewidths=1.0,zorder=4)
    if is_observed and observed_mask is not None:
        gaps=~np.asarray(observed_mask,dtype=bool)&~(np.asarray(land_mask,dtype=bool) if land_mask is not None else False)
        ax.contourf(lon,lat,gaps.astype(float),levels=[.5,1.5],colors=["#c4cbd0"],alpha=.75,hatches=["///"],zorder=3)
    for idx,feature in enumerate((features or [])[:3],1):
        loc=feature.get("locator") or {};x=loc.get("longitude");y=loc.get("latitude")
        if not isinstance(x,(int,float)) or not isinstance(y,(int,float)): continue
        geom=feature.get("geometry") or {}
        coords=geom.get("coordinates",[])
        # Render LineString/MultiPoint coordinates only when they are actual supplied geometry.
        if geom.get("type")=="LineString" and coords:
            ax.plot([p[0] for p in coords],[p[1] for p in coords],"--",color="#101820" if is_observed else "#fff4b0",lw=1.6,zorder=5)
        ax.scatter([x],[y],s=82,marker="o",facecolor="#fff" if is_observed else "#292347",edgecolor="#101820",linewidth=1.2,zorder=7)
        ax.text(x,y,str(idx),ha="center",va="center",fontsize=8,weight="bold",color="#111",zorder=8)
        refs=(feature.get("waypoint_references") or [])[:2]
        for ref in refs:
            rx=ref.get("longitude");ry=ref.get("latitude")
            if isinstance(rx,(int,float)) and isinstance(ry,(int,float)):
                ax.plot([rx,x],[ry,y],"--",color="#292347" if not is_observed else "#101820",lw=.7,alpha=.8,zorder=6)
        labels=[]
        for ref in refs:
            bearing=ref.get("displayed_bearing_true_deg")
            distance=ref.get("displayed_distance_nmi")
            label=ref.get("name","waypoint")
            if isinstance(distance,(int,float)):label+=f" {distance:g} nmi"
            if isinstance(bearing,(int,float)):label+=f" {ref.get('compass_label') or ''} ({bearing:03.0f}T)"
            labels.append(label)
        if labels: ax.annotate(" / ".join(labels),xy=(x,y),xytext=(5,7),textcoords="offset points",fontsize=7,color="#101820",zorder=8)
    ax.set_xlabel("Longitude (°E / °W)");ax.set_ylabel("Latitude (°N)")
    ax.grid(alpha=.23,linewidth=.4)
    cb=fig.colorbar(mesh,ax=ax,pad=.02);cb.set_label("Sea surface temperature (°F)")
    # Approximate scale-bar length is calculated at map center; label states geographic distance.
    center=float(np.mean(lat));nm_len=10;deg_lon=nm_len/(60*max(.1,math.cos(math.radians(center))))
    x0=float(np.min(lon)+.06*(np.max(lon)-np.min(lon)));y0=float(np.min(lat)+.06*(np.max(lat)-np.min(lat)))
    ax.plot([x0,x0+deg_lon],[y0,y0],color="#111",lw=3,zorder=9);ax.text(x0+deg_lon/2,y0+0.012*(np.max(lat)-np.min(lat)),"10 nmi approx.",ha="center",fontsize=8)
    style="Satellite composite observations" if is_observed else "Analyzed background — not direct observation"
    qualifier=" · SYNTHETIC FIXTURE — NOT CURRENT CONDITIONS" if "synthetic" in source_label.lower() else ""
    ax.set_title(f"{style}\n{source_label} · {analysis_time or 'time unknown'}{qualifier}")
    legend=[Patch(facecolor="#d8e1e6",edgecolor="#9aa7af",label="Observed gaps / no SST pixels" if is_observed else "No analyzed value")]
    ax.legend(handles=legend,loc="upper right",fontsize=8,framealpha=.92)
    if context_bounds: ax.text(.01,.01,"Context bounds: "+json.dumps(context_bounds,sort_keys=True),transform=ax.transAxes,fontsize=7,color="#394b53")
    path=Path(path);path.parent.mkdir(parents=True,exist_ok=True)
    fd,tmp=tempfile.mkstemp(prefix=".ocean-map-",suffix=".png",dir=path.parent);os.close(fd)
    try:
        fig.savefig(tmp,dpi=150,format="png");os.replace(tmp,path)
    finally:
        plt.close(fig)
        if os.path.exists(tmp): os.unlink(tmp)
    data=path.read_bytes()
    return {"status":"ok","relative_path":path.name,"mime_type":"image/png","sha256":hashlib.sha256(data).hexdigest(),"bytes":len(data),"data_class":source_class}


def atomic_cache_write(path, payload):
    path=Path(path);path.parent.mkdir(parents=True,exist_ok=True)
    fd,tmp=tempfile.mkstemp(prefix=".ocean-",dir=path.parent)
    try:
        with os.fdopen(fd,"w",encoding="utf-8") as f: json.dump(payload,f,separators=(",",":"));f.flush();os.fsync(f.fileno())
        os.replace(tmp,path)
    finally:
        if os.path.exists(tmp): os.unlink(tmp)


def cache_read(path, now=None, max_seconds=5):
    started=time.monotonic(); data=json.loads(Path(path).read_text(encoding="utf-8"))
    if time.monotonic()-started>max_seconds: raise TimeoutError("cache read exceeded budget")
    if now and data.get("retrieved_at"):
        data["cache_age_hours"]=max(0,(dt.datetime.fromisoformat(now.replace("Z","+00:00"))-dt.datetime.fromisoformat(data["retrieved_at"].replace("Z","+00:00"))).total_seconds()/3600)
        for source in data.get("sources") or []:
            stamp=source.get("analysis_time")
            if stamp:
                try:
                    parsed=dt.datetime.fromisoformat(stamp.replace("Z","+00:00"))
                    source["analysis_age_hours"]=max(0,(dt.datetime.fromisoformat(now.replace("Z","+00:00"))-parsed).total_seconds()/3600)
                    if source.get("class")=="analysed_sst" and source["analysis_age_hours"]>72:data["status"]="stale"
                except ValueError: source["analysis_age_hours"]=None
    return data


def attach_map_artifact(summary, cache_dir, max_bytes=1_500_000):
    """Add verified PNG bytes to the bounded report summary for immutable email archiving."""
    meta=summary.get("map") if isinstance(summary,dict) else None
    if not isinstance(meta,dict) or meta.get("status")!="ok": return summary
    name=meta.get("relative_path")
    if not isinstance(name,str) or not re.fullmatch(r"[A-Za-z0-9._-]{1,180}\.png",name):
        raise ValueError("Invalid cached map artifact name")
    root=Path(cache_dir).resolve();path=(root/name).resolve()
    if path.parent!=root: raise ValueError("Cached map path escaped cache directory")
    data=path.read_bytes()
    if not data.startswith(b"\x89PNG\r\n\x1a\n"): raise ValueError("Cached map is not a PNG")
    if len(data)>max_bytes: raise ValueError("Cached map exceeds attachment byte limit")
    digest=hashlib.sha256(data).hexdigest()
    if digest!=meta.get("sha256"): raise ValueError("Cached map hash does not match summary")
    meta["artifact_base64"]=base64.b64encode(data).decode("ascii")
    meta["attachment_filename"]="ocean-features-"+str(summary.get("snapshot_id","snapshot"))+".png"
    return summary


def bounded_fetch(url, max_bytes=65536, timeout=5, opener=None):
    from urllib.parse import urlsplit
    p=urlsplit(url)
    if p.scheme!="https" or p.hostname not in ALLOWED_HOSTS or p.username or p.password: raise ValueError("Unapproved provider URL")
    request=urllib.request.Request(url,headers={"User-Agent":"FishingReport-ocean-features/1.0","Accept":"text/csv,application/json,application/netcdf"})
    response=(opener or urllib.request.urlopen)(request,timeout=timeout)
    with response as r:
        final=urlsplit(r.geturl())
        if final.scheme!="https" or final.hostname not in ALLOWED_HOSTS: raise ValueError("Provider redirected outside allowlist")
        body=r.read(max_bytes+1)
    if len(body)>max_bytes: raise ValueError("Provider response exceeds byte limit")
    return body


def parse_numeric_csv(body):
    """Reject HTML/error pages, even with HTTP 200; return numeric CSV records only."""
    if not isinstance(body,(bytes,bytearray)): raise ValueError("CSV body must be bytes")
    text=bytes(body).decode("utf-8-sig","replace")
    if "<html" in text[:500].lower() or "<error" in text[:500].lower() or not text.strip(): raise ValueError("Provider returned non-numerical body")
    rows=list(csv.reader(text.splitlines()))
    if len(rows)<3 or not any(re.search(r"\d{4}-\d\d-\d\d",cell or "") for cell in rows[0]):
        # ERDDAP CSV has a variable-name heading and a units row, then ISO timestamps.
        if len(rows)<3 or not any(re.fullmatch(r"\d{4}-\d\d-\d\dT.*",cell or "") for row in rows[2:] for cell in row): raise ValueError("CSV has no dated numeric records")
    header=[x.strip().strip('"') for x in rows[0]]
    units=rows[1] if len(rows)>1 else []
    records=[]
    for row in rows[2:]:
        if len(row)!=len(header): continue
        if not any(re.match(r"^\d{4}-\d\d-\d\dT",v.strip()) for v in row): continue
        converted=[]
        for value in row:
            value=value.strip()
            try: converted.append(float(value))
            except ValueError: converted.append(value)
        records.append(dict(zip(header,converted)))
    if not records: raise ValueError("CSV has no parseable data rows")
    return {"columns":header,"units":units,"records":records}


def fetch_mur_regional(bounds, timeout=20, max_bytes=16*1024*1024, opener=None):
    """Fetch a bounded MUR SST/error/mask subset; called only by a background acquisition job."""
    south,north,west,east=(float(bounds[k]) for k in ("south","north","west","east"))
    if not (-90<=south<north<=90 and -180<=west<east<=180): raise ValueError("Invalid MUR bounds")
    cells=((north-south)/.01+2)*((east-west)/.01+2)
    if cells>100000: raise ValueError("MUR subset exceeds cell budget")
    axes=f"[(last)][({south:.2f}):1:({north:.2f})][({west:.2f}):1:({east:.2f})]"
    query=",".join(name+axes for name in ("analysed_sst","analysis_error","mask"))
    url="https://coastwatch.pfeg.noaa.gov/erddap/griddap/jplMURSST41.nc?"+query
    body=bounded_fetch(url,max_bytes=max_bytes,timeout=timeout,opener=opener)
    if not (body.startswith(b"\x89HDF\r\n\x1a\n") or body.startswith(b"CDF")): raise ValueError("MUR subset body is not NetCDF data")
    return body,url,hashlib.sha256(body).hexdigest()


def decode_cf_netcdf(payload, temperature_name="analysed_sst", require_clear_quality=False):
    """Decode one gridded NetCDF slice using its own coordinate/variable metadata."""
    import netCDF4
    ds=netCDF4.Dataset("ocean-subset",mode="r",memory=payload)
    try:
        def coord(axis,standard):
            for name,var in ds.variables.items():
                if getattr(var,"axis","")==axis or getattr(var,"standard_name","")==standard: return name,var
            raise ValueError(f"Missing CF {standard} coordinate")
        lat_name,lat_var=coord("Y","latitude");lon_name,lon_var=coord("X","longitude")
        lat=np.asarray(lat_var[:],dtype=float);lon_raw=np.asarray(lon_var[:],dtype=float)
        lon=normalize_longitudes(lon_raw)
        if temperature_name not in ds.variables: raise ValueError("Temperature variable missing")
        var=ds.variables[temperature_name];var.set_auto_maskandscale(False)
        raw=np.asarray(var[:],dtype=float)
        dims=list(var.dimensions)
        if "time" in dims:
            axis=dims.index("time");raw=np.take(raw,-1,axis=axis);dims.pop(axis)
        while raw.ndim>2: raw=np.take(raw,0,axis=0);dims.pop(0)
        if set(dims)!={lat_name,lon_name}: raise ValueError("Temperature dimensions do not match coordinate axes")
        if dims==[lon_name,lat_name]: raw=raw.T
        attrs={k:getattr(var,k) for k in ("_FillValue","missing_value","scale_factor","add_offset") if hasattr(var,k)}
        temp,valid=normalize_cf_values(raw,attrs,getattr(var,"units",None))
        if lat.size>1 and lat[0]>lat[-1]: lat=lat[::-1];temp=temp[::-1,:];valid=valid[::-1,:]
        order=np.argsort(lon);lon=lon[order];temp=temp[:,order];valid=valid[:,order]
        quality_policy="quality unavailable"
        if require_clear_quality:
            if "quality_level" not in ds.variables: raise ValueError("ACSPO clear-sky quality_level variable missing")
            q=ds.variables["quality_level"];q.set_auto_maskandscale(False);qa=np.asarray(q[:]);qd=list(q.dimensions)
            if "time" in qd: qa=np.take(qa,-1,axis=qd.index("time"));qd.remove("time")
            while qa.ndim>2: qa=np.take(qa,0,axis=0);qd.pop(0)
            if qd==[lon_name,lat_name]: qa=qa.T
            if lat_var[0]>lat_var[-1]: qa=qa[::-1,:]
            qa=qa[:,order];valid &= qa==5;quality_policy="quality_level == 5"
        else: quality_policy="product-specific fill/scale and physical SST bounds"
        error_name=next((n for n in ("analysis_error","sses_standard_deviation","sst_uncertainty") if n in ds.variables),None)
        uncertainty=None
        if error_name:
            e=ds.variables[error_name];e.set_auto_maskandscale(False);er=np.asarray(e[:],dtype=float);ed=list(e.dimensions)
            if "time" in ed: er=np.take(er,-1,axis=ed.index("time"));ed.remove("time")
            while er.ndim>2: er=np.take(er,0,axis=0);ed.pop(0)
            if ed==[lon_name,lat_name]: er=er.T
            if lat_var[0]>lat_var[-1]: er=er[::-1,:]
            er=er[:,order]
            ea={k:getattr(e,k) for k in ("_FillValue","missing_value","scale_factor","add_offset") if hasattr(e,k)}
            # Standard deviations have no absolute-temperature offset. Only scale applies.
            er=er*float(ea.get("scale_factor",1));er[er==float(ea.get("_FillValue",np.nan))]=np.nan
            uncertainty_masked=uncertainty_mask(er,getattr(e,"units","degree_Celsius"));uncertainty=np.where(uncertainty_masked,er,np.nan)
            valid &= uncertainty_masked
        mask_info=None;land_mask=np.zeros((lat.size,lon.size),dtype=bool);inland_mask=np.zeros((lat.size,lon.size),dtype=bool)
        if "mask" in ds.variables:
            m=ds.variables["mask"];m.set_auto_maskandscale(False);flags=np.asarray(m[:]);md=list(m.dimensions)
            if "time" in md: flags=np.take(flags,-1,axis=md.index("time"));md.remove("time")
            while flags.ndim>2: flags=np.take(flags,0,axis=0);md.pop(0)
            if md==[lon_name,lat_name]: flags=flags.T
            if lat_var[0]>lat_var[-1]: flags=flags[::-1,:]
            flags=flags[:,order]
            meanings=str(getattr(m,"flag_meanings","")).split();flag_masks=np.asarray(getattr(m,"flag_masks",[]),dtype=int).ravel();flag_values=np.asarray(getattr(m,"flag_values",[]),dtype=int).ravel()
            mask_info={"flag_masks":flag_masks.tolist(),"flag_values":flag_values.tolist(),"flag_meanings":meanings,"valid_values":[int(x) for x in np.unique(flags)[:32]]}
            if "open_sea" in meanings:
                idx=meanings.index("open_sea")
                if idx<len(flag_masks): valid &= (flags & int(flag_masks[idx]))!=0
                elif idx<len(flag_values): valid &= flags==int(flag_values[idx])
            if "land" in meanings:
                idx=meanings.index("land")
                land=(flags & int(flag_masks[idx]))!=0 if idx<len(flag_masks) else (flags==int(flag_values[idx]) if idx<len(flag_values) else np.zeros(flags.shape,dtype=bool))
                land_mask=land
                valid &= ~land
            if "open_lake" in meanings:
                idx=meanings.index("open_lake")
                lake=(flags & int(flag_masks[idx]))!=0 if idx<len(flag_masks) else (flags==int(flag_values[idx]) if idx<len(flag_values) else np.zeros(flags.shape,dtype=bool))
                inland_mask=lake
                valid &= ~lake
        def auxiliary(name):
            if name not in ds.variables:return None
            av=ds.variables[name];av.set_auto_maskandscale(False);arr=np.asarray(av[:]);ad=list(av.dimensions)
            if "time" in ad: arr=np.take(arr,-1,axis=ad.index("time"));ad.remove("time")
            while arr.ndim>2: arr=np.take(arr,0,axis=0);ad.pop(0)
            if ad==[lon_name,lat_name]: arr=arr.T
            if lat_var[0]>lat_var[-1]: arr=arr[::-1,:]
            return arr[:,order]
        front=auxiliary("sst_front_position")
        grad=auxiliary("sst_gradient_magnitude")
        times=None
        if "time" in ds.variables:
            t=ds.variables["time"];times=str(netCDF4.num2date(np.asarray(t[:])[-1],t.units,getattr(t,"calendar","standard"),only_use_cftime_datetimes=False))
        if times and not times.endswith('Z') and not '+' in times: times=times.replace(' ','T')+'Z'
        return {"latitude":lat,"longitude":lon,"sst_c":np.where(valid,temp,np.nan),"valid_mask":valid,"land_mask":land_mask,"inland_water_mask":inland_mask,"uncertainty":uncertainty,"uncertainty_variable":error_name,"mask_metadata":mask_info,"native_front_position":front,"native_gradient":grad,"analysis_time":times,"units":"degree_Celsius","quality_policy":quality_policy,"source_hash":hashlib.sha256(payload).hexdigest()}
    finally: ds.close()


def acquire_mur_background(location_id, cache_dir, gpx_paths, now=None, config=None):
    """n8n-triggered bounded cache refresh; MUR is analysis-only, never an observed-break source."""
    from datetime import timezone
    started=time.monotonic();now=now or dt.datetime.now(timezone.utc).isoformat()
    cache_dir=Path(cache_dir);cache_dir.mkdir(parents=True,exist_ok=True)
    lock=cache_dir/(location_id+'.acquire.lock')
    try: fd=os.open(lock,os.O_CREAT|os.O_EXCL|os.O_WRONLY,0o600)
    except FileExistsError: raise RuntimeError("Ocean acquisition already running")
    try:
        points,gpx_diagnostics,waypoint_snapshot,reference_status=parse_gpx(gpx_paths)
        if shutil.disk_usage(cache_dir).free<64*1024*1024: raise OSError("Insufficient free cache space")
        config=config or {}
        bounds=config['main_bounds']
        body,url,body_hash=fetch_mur_regional(bounds,timeout=20)
        if time.monotonic()-started>300: raise TimeoutError("Ocean acquisition exceeded 300 second budget")
        arrays=decode_cf_netcdf(body)
        valid=arrays['valid_mask'];ocean=~(arrays['land_mask']|arrays['inland_water_mask']);coverage=float(valid.sum()/ocean.sum()) if ocean.any() else None
        snapshot_id=hashlib.sha256(json.dumps({"body":body_hash,"waypoints":[d.get('source_hash') for d in gpx_diagnostics],"bounds":bounds},sort_keys=True).encode()).hexdigest()[:24]
        analysis_age=None
        if arrays['analysis_time']:
            try: analysis_age=max(0,(dt.datetime.fromisoformat(now.replace('Z','+00:00'))-dt.datetime.fromisoformat(arrays['analysis_time'].replace('Z','+00:00'))).total_seconds()/3600)
            except ValueError: pass
        candidates=detect_breaks(arrays['sst_c'],arrays['latitude'],arrays['longitude'],valid=valid & ocean)
        features=mur_analysis_features(candidates,body_hash,points,arrays['analysis_time'],analysis_age,coverage)
        png_name=f"{location_id}-{snapshot_id}.png"
        map_meta=render_map_png(cache_dir/png_name,arrays['latitude'],arrays['longitude'],arrays['sst_c'],features,source_class="analysed_sst",source_label="NASA/JPL MUR v4.1 ANALYZED BACKGROUND",analysis_time=arrays['analysis_time'],land_mask=arrays['land_mask'],inland_water_mask=arrays['inland_water_mask'],context_bounds=config.get('context_bounds',bounds))
        map_meta['relative_path']=png_name
        if time.monotonic()-started>300: raise TimeoutError("Ocean acquisition exceeded 300 second budget")
        source={"provider":"NASA/JPL","product":"MUR SST Analysis fv04.1","version":"4.1","url":"https://coastwatch.pfeg.noaa.gov/erddap/info/jplMURSST41/index.html","class":"analysed_sst","analysis_time":arrays['analysis_time'],"observation_interval":None,"pixel_age_available":False,"model_run":None,"model_valid_time":None,"model_lead_hours":None,"depth_m":None,"units":"degree_Celsius","grid_spacing_km":1.11,"quality_policy":"MUR analyzed field; provider land/lake flags excluded; not direct observation","content_hash":body_hash,"retrieved_at":now,"observation_age":"unknown"}
        source['analysis_age_hours']=analysis_age
        status='stale' if analysis_age is not None and analysis_age>72 else 'analysis_only'
        warnings=["MUR is an analyzed background, not a direct observation; temperature-break candidates are labeled analysis-only."]
        if status=='stale': warnings.append('Analyzed background exceeds the 72-hour freshness limit.')
        if coverage is None or coverage<0.2: warnings.append('Analyzed ocean coverage is below 20%; no domain-wide conclusion is made.')
        if features: warnings.append('Temperature break candidates are derived from the analyzed MUR field; circulation is unknown, so no eddy is claimed.')
        if reference_status!='ok': warnings.append('GPX reference inputs are incomplete; waypoint references are partial or unavailable.')
        analysis_status='not_run' if status=='stale' else 'ok' if features else 'no_feature'
        if coverage is None or coverage<0.2: analysis_status='partial'
        out={"schema_version":"1.0","location_id":location_id,"snapshot_id":snapshot_id,"status":status,"acquisition_status":"ok","analysis_status":analysis_status,"generated_at":now,"retrieved_at":now,"reference":config.get("reference"),"bounds":{"main":bounds,"context":config.get("context_bounds",bounds)},"sources":[source],"coverage":{"observed_fraction":None,"analysis_fraction":coverage,"valid_domain_fraction":coverage},"features":features if status!='stale' else [],"waypoint_snapshot":{"status":reference_status,"diagnostics":gpx_diagnostics,"points":points,"files":waypoint_snapshot},"map":map_meta,"warnings":warnings}
        atomic_cache_write(cache_dir/(location_id+'.json'),out)
        return out
    finally:
        os.close(fd)
        try:lock.unlink()
        except FileNotFoundError:pass


def empty_summary(location_id, status="unavailable", warnings=None, now=None):
    now=now or dt.datetime.now(dt.timezone.utc).isoformat()
    return {"schema_version":"1.0","location_id":location_id,"snapshot_id":hashlib.sha256(f"{location_id}:{status}".encode()).hexdigest()[:24],"status":status,"acquisition_status":"unavailable","analysis_status":"not_run","generated_at":now,"retrieved_at":None,"reference":None,"bounds":None,"sources":[],"coverage":{"observed_fraction":None,"analysis_fraction":None,"valid_domain_fraction":None},"features":[],"waypoint_snapshot":None,"map":{"status":"unavailable","path":None,"sha256":None},"warnings":warnings or []}
