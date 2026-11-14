# Locations, data providers and SST

## Pick a starting profile

`config.example.json` is a sanitized US/NOAA example with public publisher URLs. `config.global.example.json` demonstrates Sydney, Australia, with global weather/tide providers and no inherited Florida fishing sources. Copy one to ignored `config/config.private.json`, then replace its example settings with your own.

| Location field | What to supply |
|---|---|
| `id`, `name`, `timezone` | Stable lower-case ID (`a-z`, digits, `_`, `-`), label and valid IANA timezone |
| `departure_point`, `astronomy_point` | Your verified latitude/longitude and coordinate basis |
| `marine_provider` | `noaa` for configured US coverage, `open_meteo` for worldwide modeled weather/waves |
| `forecast_points` | Two sea points, IDs `nearshore` and `offshore`, with valid coordinates; choose points representing your fishing grounds |
| `marine_zones`, `marine_product_url` | NOAA marine warning zones and your local NWS coastal product URL; not used by global collectors |
| `tide_station`, `buoy_stations`, `temperature_buoy_station` | Appropriate NOAA/NDBC identifiers in US mode; no inherited Florida stations in global mode |
| `tide_datum` | WorldTides requested datum, e.g. `MSL`; output labels use the actual returned datum, never assume MLLW |
| `max_one_way_distance`, `habitats`, `methods` | Travel limit/unit and supported nearshore/offshore fishing methods |
| `vessel` | Your vessel label, wind/gust/wave/period limits; do not treat example preferences as universal limits |
| `geography_terms`, `species_catalog` | Unambiguous English local-place terms and additional local species names for publisher extraction |
| `fishing_sources` | IDs from the root `sources` list, selected for this location only |
| `verified_routes`, root `target_rules` | Independently verified route distances and applicable species/rule eligibility; empty does not establish a legal harvest or a verified route |

Keep the deployment schedule, Friday update and optional community schedule timezones consistent. Wednesday evening anchors the Thursday–Tuesday report; Friday morning compares Saturday–Monday. Run separate Compose deployments for distant timezones so a single scheduler timestamp remains Wednesday in each location's timezone. Clone into separate private directories with different `COMPOSE_PROJECT_NAME` and editor bind port if running multiple stacks; the supplied Compose editor port is 5678 and must be edited for the second stack.

Run `scripts/configure.py` after editing the local config to update PostgreSQL; restart the helper to reload its RSS registry. When changing schedule timezone/hours, rebuild **private** exports, import/rebind the affected workflows, and republish them. A JSON config change cannot alter already-published n8n triggers. The helper reads mounted config; the report workflow reads database config, so keep both synchronized.

## Worldwide marine forecasts and tides

The global adapter calls [Open-Meteo weather](https://open-meteo.com/en/docs) for wind, gusts, direction and thunderstorm codes, and [Open-Meteo Marine](https://open-meteo.com/en/docs/marine-weather-api) for waves and periods. It requests seven days; model coverage can be shorter. Returned hourly intervals are converted to knots/feet/seconds. Missing/null hours remain gaps; fetching a response is not treated as a model issue timestamp. It does not label modeled SST as an observed buoy temperature.

Eligible noncommercial Open-Meteo access needs no key. For commercial access, supply `OPEN_METEO_API_KEY` and verify your plan covers the weather and marine customer endpoints. Observe [Open-Meteo terms and attribution](https://open-meteo.com/en/terms). Reports retain its attribution notice. Provider coverage is not a guarantee at every nearshore coordinate.

[WorldTides](https://www.worldtides.info/apidocs) supplies high/low predictions at your local coordinate and requires `WORLDTIDES_API_KEY`. The adapter requests only extrema over the report interval, preserves the returned reference datum and copyright text, and converts height to feet. Purchase/allocate your own credits as needed and check licensing for sending reports to multiple subscribers. The app does not silently buy credits. An absent key or failed request yields unavailable tides; it does not substitute a nearby US tide station or derive tide extrema from an unrelated model.

The retained `noaa_tides` / `nws_alerts` collector IDs are compatibility names inside the report contract; use provenance URL/attribution and datum to identify the actual source. Provider keys remain exclusively in the helper process environment and are not echoed in exception messages.

## Official warnings outside NOAA coverage

There is no implemented universal national marine-warning feed. Global forecast data is still usable for a factual briefing, but the report refuses GO classifications while official warning status is unavailable. Integrate your country's authority into a small local job that writes `data/alerts/<id>.json` atomically. That job should verify geographic coverage and completeness, preserve active warning intervals and provenance, and refresh at least hourly. A single manually created empty file is not an ongoing warning integration.

The accepted envelope is:

```json
{
  "location_id": "your_location",
  "checked_at": "2026-11-18T08:00:00Z",
  "authority_url": "https://example.org/your-national-marine-authority",
  "features": [
    {
      "id": "authority-warning-id",
      "properties": {
        "event": "Authority warning title",
        "severity": "Severe",
        "onset": "2026-11-18T08:00:00Z",
        "ends": "2026-11-18T20:00:00Z",
        "description": "Original authority description"
      }
    }
  ]
}
```

`features:[]` means the authority integration checked your actual coverage and found no active warnings. Missing files, wrong location IDs, timestamps older than one hour, undated features or invalid JSON produce unknown warning status. The workflow rechecks immediately before archiving, and warning changes can invalidate an earlier decision.

## Local fishing publishers and RSS

Add source entries containing `id`, HTTPS `url`, matching `domain`, `enabled`, `min_delay_seconds`, `role` and `article_limit`, then add those IDs only to applicable locations. The helper derives approved article hosts from your mounted config. Both discovery and extraction enforce host boundaries, robots policy and request delays. The generic parser accepts configured local-place terms and species names, keeps original publication/trip dates, and cannot promote an edited old catch into a fresh report. It uses English fishing/method vocabulary; non-English publisher adapters require explicit implementation and fixtures.

The preserved Spacefish/Sea Leveler specialized parsers are examples of site-specific adapters. They are never relabeled as Sydney catches. Generic pages still need real dated fishing content; adding a URL does not guarantee extraction. Add representative sanitized HTML fixtures when supporting a new publisher, and check seasonal/range/rule behavior before using it for recommendations.

For news, configure root `news.feeds` with exact allowed publisher hosts and `default_region`. Set `news.regions` to an ordered list of `{id,label,terms}` for your areas; only matching configured region IDs are selected. The default US profile retains its historical three-region grouping; the worldwide profile disables news until you configure local feeds. Restart helper after changes so its feed registry and n8n config agree.

Independent community research preserves the existing Canaveral-specific direct-post and geography verification adapters. Other locations are explicitly disabled for this optional research path, so unsupported observations cannot be mislabeled with a new location ID. Direct Reddit OAuth and broader worldwide forum adapters are not implemented. The worldwide weather/tide/publisher pipeline does not depend on this research workflow.

## SST and your own GPX waypoints

The active SST implementation is retained. For each location set:

```json
{
  "ocean_features": {
    "enabled": true,
    "main_bounds": {"south": -34.2, "north": -33.5, "west": 151.1, "east": 152.2},
    "context_bounds": {"south": -34.2, "north": -33.5, "west": 151.1, "east": 152.2},
    "reference": {"latitude": -33.84, "longitude": 151.28, "basis": "your verified reference"},
    "gpx_inputs": ["/data/gpx/your-waypoints.gpx"]
  }
}
```

Copy your file to `data/gpx/your-waypoints.gpx`, then set `OCEAN_FEATURES_ENABLED=true` in `deploy/.env` and recreate the helper with `sudo bash scripts/compose.sh up -d helper`. The global env gate and individual location gate must both be true. Use short safe IDs; path traversal is rejected. Inputs must be under `/data/gpx`. No original GPX is built into the image or tracked by Git. Mount read-only files readable by UID 10001; protect their containing host directory as in SETUP.md.

Use a compact sea bounding box with south < north, west < east, no antimeridian crossing, and fewer than 100,000 requested MUR grid cells (roughly 0.01° resolution). Shrink the region if the cell/byte/time limits reject it. The helper downloads a bounded MUR NetCDF subset, excludes land/lake pixels, keeps analysis time separate from retrieval time, ranks at most three candidates, and renders a hashed map. Rank/range/bearing calculations correlate with available GPX points; missing inputs produce partial/unavailable references instead of invented positions. Waypoints do not verify a navigable route.

The ocean child is also called before a live report reads its cache, preserving the existing freshness behavior. It can run Wednesday/Friday on its own schedule. Refresh failures retain a prior cache with a failed-refresh warning. Delivery uses the exact archived map rather than a mutable cache file. Maps, waypoint snapshots and cache files remain private outputs.

MUR is an **analyzed SST background**. It can show analyzed temperature-break candidates but does not establish a directly observed current front, circulation or an eddy. ACSPO quality-controlled observed subsets and HYCOM currents are not implemented here. High-latitude, cloud/ice, land-mask and provider-outage gaps remain visible.
