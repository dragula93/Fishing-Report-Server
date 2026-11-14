# Fishing Report Server

Self-hosted n8n workflows that collect marine forecasts, tides, astronomy, dated fishing reports and SST maps, archive a report, and deliver it by email. Configure your own location, vessel limits, sources and subscribers. The original US collectors are preserved; worldwide coastal reports use Open-Meteo wind/wave forecasts and WorldTides tide predictions.

Start with [installation](docs/SETUP.md), then [location and provider configuration](docs/LOCATIONS.md). See the [architecture](docs/ARCHITECTURE.md) for workflow relationships and the [credentials guide](docs/CREDENTIALS.md) for every key or login you supply. [Operations](docs/OPERATIONS.md) covers activation, backups and upgrades; [validation](docs/VALIDATION.md) records what has been checked.

## What is included

| Directory | Purpose |
|---|---|
| `workflows/` | Eight generated n8n exports; inactive, unbound credentials, email nodes disabled |
| `src/code-nodes/` | Deterministic collector normalization, filtering, decisions, rendering and validation |
| `helper/` | Python astronomy, publisher extraction, RSS, worldwide providers and SST/GPX correlation |
| `writer/` | Optional restricted Codex writer and independent community research service |
| `sql/` | Six ordered PostgreSQL migrations for archives, leases, delivery and research |
| `deploy/` | Docker Compose stack and database initialization |
| `config/` | Public US and worldwide examples; safe defaults, no personal recipients |
| `scripts/`, `tests/`, `schemas/` | Build, install, configure, backup, public audit and verification |

The SST path comes from the active report implementation. It uses a bounded NASA/JPL MUR analyzed SST subset, ranks temperature-break candidates, renders a map, and optionally correlates candidates with **your own GPX waypoints**. Supply those files locally; none are included. MUR is an analyzed background, not a direct observed front or a verified eddy. ACSPO and HYCOM acquisition remain unimplemented.

## Behavior and boundaries

Reports cover Thursday through Tuesday, anchored to Wednesday in the configured timezone. A Friday update compares Saturday–Monday decisions and suppresses unchanged deliveries. Schedule hours and timezone are configurable; changing the weekdays or report length requires code changes. Use separate deployments for widely separated schedule timezones.

NOAA is appropriate for configured US coverage. Worldwide providers supply modeled conditions wherever their marine data covers the coordinates. Missing official warning coverage remains unknown and prevents a GO classification. WorldTides requires your own account/key and appropriate licensing. Fishing-source parsing is English-language and must be configured for local publishers and species. The optional community adapter remains specific to the original Canaveral region; it is disabled for other locations. These limits are detailed in [LOCATIONS.md](docs/LOCATIONS.md).

Docker installs the pinned n8n, matching task runners, PostgreSQL, Python packages, Node/npm and Codex dependencies. You do not need to install host npm or pip packages to run the stack.

```bash
# Node 22+ (or use the container commands in SETUP.md)
npm run build
npm test
python3 scripts/scan-public.py
```

This is source and reproducible setup material. It contains no deployment credentials, user database, report inboxes, live execution archives, original GPX files, SSH transport or server password-reset scripts. Keep local inputs and generated outputs in ignored paths.
