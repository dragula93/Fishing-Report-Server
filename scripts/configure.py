#!/usr/bin/env python3
"""Apply owner config and subscribers atomically; never publishes workflows."""
import argparse,json,subprocess,secrets
from pathlib import Path
root=Path(__file__).resolve().parents[1]
p=argparse.ArgumentParser();p.add_argument('--activate',action='store_true');args=p.parse_args()
config=json.loads((root/'config/config.private.json').read_text())
if not args.activate:
 config['configuration_ready']=False;config['execution']['mode']='dry_run';config['email']['smtp_ready']=False
else:
 from datetime import datetime,timezone
 if not config['email'].get('sender') or not config['email'].get('operator'): raise SystemExit('Set sender and operator addresses before activation')
 if not any(s.get('enabled') for s in config['subscribers']): raise SystemExit('Enable intended subscribers in the private config first')
 config['configuration_ready']=True;config['execution']['mode']='production';config['email']['smtp_ready']=True
 config['schedule_activation_at']=datetime.now(timezone.utc).isoformat()
tag='$config_'+secrets.token_hex(16)+'$'
data=json.dumps(config)
query=f'''BEGIN;
INSERT INTO configuration(key,value) VALUES('main',{tag}{data}{tag}::jsonb) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value;
UPDATE subscribers SET enabled=false;
INSERT INTO subscribers(email,enabled,locations)
 SELECT s->>'email',COALESCE((s->>'enabled')::boolean,false),ARRAY(SELECT jsonb_array_elements_text(s->'locations'))
 FROM jsonb_array_elements({tag}{data}{tag}::jsonb->'subscribers') s
 ON CONFLICT(email) DO UPDATE SET enabled=EXCLUDED.enabled,locations=EXCLUDED.locations;
COMMIT;
'''
subprocess.run(['bash',str(root/'scripts/compose.sh'),'exec','-T','postgres','psql','-U','fishing_app','-d','fishing','-v','ON_ERROR_STOP=1'],input=query,text=True,check=True,stdout=subprocess.DEVNULL)
print('Configuration applied; workflow publication remains a separate step.')
