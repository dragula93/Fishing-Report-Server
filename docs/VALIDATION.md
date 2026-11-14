# Validation

Validated on 2026-11-14 using the curated source, a separate Debian 13 Docker Compose project, separate volumes/ports and a synthetic n8n owner. No production workflow, subscriber list or credentials were modified.

## Checks performed

| Check | Result |
|---|---|
| JavaScript transformation, policy, workflow graph and private-build tests | 198 cases pass on the final source; includes ocean-refresh failure preservation and Sydney calendar/isolation |
| Python astronomy, publisher, community, RSS, global providers, SST and synthetic GPX tests | 37 cases pass inside the built Python helper image |
| Shell syntax / Python compilation | Pass |
| Helper and writer Dockerfiles | Both build successfully with locked dependencies |
| Isolated Compose stack | PostgreSQL, n8n, runners, helper and writer healthy |
| Fresh owner / six migrations / eight CLI imports | Complete; imports inactive, SMTP disabled, dry-run configuration |
| Actual n8n Sydney fixture report | Succeeds; archive starts 2026-11-19 in the Sydney timezone; zero deliveries |
| Actual n8n worldwide live-provider report | Succeeds and archives six Sydney dates; missing tide key/warning feed remain visible and all decisions remain HOLD |
| Open-Meteo live wind and wave adapter | Sydney, Cape Town and Lisbon each return 168 hourly wind and wave records; issue time remains explicitly unknown |
| Secret scan | Gitleaks 8.30.1 and public-source/staged checks; no findings; additional comparison against known local private values |

Actual GPX files were excluded. GPX tests generate clearly synthetic points at runtime, including malformed/missing inputs, hash changes, reference geometry, land/cloud masks and map attachment integrity. Public rebuilds are deterministic. Custom configuration builds are checked to leave public exports unchanged.

## Reproduce the local checks

With Node 22+ and Python 3:

```bash
npm run build
npm test
python3 scripts/scan-public.py
python3 -m compileall -q helper scripts tests
for file in scripts/*.sh deploy/*.sh; do bash -n "$file"; done
```

Without host Node/npm, use the Node 22 container as in SETUP.md. To run Python tests using the built helper's scientific packages without private configuration or network access:

```bash
helper_image=$(sudo bash scripts/compose.sh images -q helper)
sudo docker run --rm --network none \
  -v "$PWD/tests:/tests:ro,Z" -e PYTHONPATH=/app \
  --entrypoint python "$helper_image" \
  -m unittest discover -s /tests -p '*_test.py'
```

For an additional source scan, use [Gitleaks](https://github.com/gitleaks/gitleaks). Run the directory scan on a clean source checkout before creating private inputs; a configured deployment intentionally contains secrets in ignored files.

```bash
sudo docker run --rm -v "$PWD:/repo:ro,Z" \
  ghcr.io/gitleaks/gitleaks:v8.30.1 dir /repo --redact --no-banner
# After staging only intended source files:
python3 scripts/scan-public.py --staged
```

Keep private config and outputs out of any committed index. A zero-finding scan is a check on the selected files, not a replacement for reviewing what is staged.

## Limits of this validation

Ubuntu/Rocky installation commands were checked against official documentation; full installs on those distributions were not run here. WorldTides behavior is verified with response fixtures and missing-key/failure tests; no paid account/key was used for live tide calls. SMTP transmission and writer authorization on a new owner's account still require that owner's credentials and inbox review. No production email was sent during validation.

National-warning integrations outside NOAA require the operator's local authority adapter. Without a fresh verified feed the report keeps warning status unknown. Worldwide tests verify provider responses and contracts, not the forecast accuracy at every coordinate or country. Optional regional community research remains limited to its documented adapter. MUR acquisition comes from the active SST implementation; the new configurable regions and owners' GPX correlations need local review. Direct observed ACSPO fronts and HYCOM circulation are not implemented.
