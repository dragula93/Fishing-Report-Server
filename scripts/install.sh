#!/usr/bin/env bash
# Fresh-instance importer. Never run this over a configured production instance.
set -euo pipefail
umask 077
root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
cd "$root"
test "$(id -u)" = 0 || { echo 'Run with sudo bash scripts/install.sh after creating the n8n owner.' >&2; exit 1; }
test -f deploy/.env
test -f config/config.private.json
compose() { bash "$root/scripts/compose.sh" "$@"; }
exists=$(compose exec -T postgres psql -U fishing_app -d fishing -Atc "SELECT to_regclass('public.configuration') IS NOT NULL")
test "$exists" = f || { echo 'Existing report schema found; use the documented upgrade procedure.' >&2; exit 1; }
for migration in sql/[0-9][0-9][0-9]-*.sql; do
  compose exec -T postgres psql -U fishing_app -d fishing -v ON_ERROR_STOP=1 < "$migration" >/dev/null
done
python3 - <<'PY'
from pathlib import Path
import os,json
env=dict(line.split('=',1) for line in Path('deploy/.env').read_text().splitlines() if line and not line.startswith('#'))
p=Path('artifacts/private');p.mkdir(parents=True,exist_ok=True)
os.chmod(p,0o700);os.chown(p,1000,1000)
credential=[{'id':'fishing_database','name':'Fishing Report - Database','type':'postgres','data':{'host':'postgres','database':'fishing','user':'fishing_app','password':env['APP_DB_PASSWORD'],'port':5432,'ssl':'disable'}}]
f=p/'database-credential.json';f.write_text(json.dumps(credential));os.chmod(f,0o600);os.chown(f,1000,1000)
build=Path('artifacts/private/build/workflows')
if not build.exists(): raise SystemExit('Compile private workflows first; see docs/SETUP.md')
for source in build.glob('*.json'):
 w=json.loads(source.read_text());w['active']=False;w['pinData']={}
 for n in w['nodes']:
  if n['type']=='n8n-nodes-base.postgres':n['credentials']={'postgres':{'id':'fishing_database','name':'Fishing Report - Database'}}
 f=p/source.name;f.write_text(json.dumps(w));os.chmod(f,0o600);os.chown(f,1000,1000)
PY
trap 'rm -f -- artifacts/private/database-credential.json' EXIT
compose exec -T n8n n8n import:credentials --input=/private/database-credential.json >/dev/null
for workflow in 00-setup 90-failure-handler 30-deliver-report 40-source-evidence 50-community-research 55-ocean-acquisition 20-location-report 10-weekly-scheduler; do
 compose exec -T n8n n8n import:workflow --input="/private/$workflow.json" >/dev/null
done
python3 scripts/configure.py
compose restart n8n >/dev/null
compose up -d --wait --wait-timeout 180
echo 'Imported eight inactive workflows. SMTP and production remain disabled.'
