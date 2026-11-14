#!/usr/bin/env python3
"""Audit tracked/index files, or an untracked distribution, without printing values."""
from pathlib import Path
import argparse,json,re,subprocess,sys
root=Path(__file__).resolve().parents[1]
p=argparse.ArgumentParser();p.add_argument('--staged',action='store_true');args=p.parse_args()
def git(*a):return subprocess.check_output(['git','-C',str(root),*a])
if (root/'.git').exists():
 names=git('diff','--cached','--name-only','--diff-filter=ACMR','-z').decode().split('\0') if args.staged else git('ls-files','--cached','--others','--exclude-standard','-z').decode().split('\0')
else:names=[str(f.relative_to(root)).replace('\\','/') for f in root.rglob('*') if f.is_file() and not any(x in f.relative_to(root).parts for x in ['artifacts','data','__pycache__','.venv']) and not f.name.endswith('.private.json') and f.name!='.env']
rules=[('private key',r'-----BEGIN (?:OPENSSH |RSA |EC |DSA )?PRIVATE KEY-----'),
 ('GitHub token',r'\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{30,})'),
 ('OpenAI token',r'\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{24,}'),
 ('AWS access key',r'\b(?:AKIA|ASIA)[A-Z0-9]{16}\b'),
 ('JWT',r'\beyJ[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}'),
 ('URL credentials',r'https?://[^\s/:]+:[^\s/@]+@')]
issues=[];count=0
for name in filter(None,names):
 path=Path(name)
 if path.name=='.env' or name.endswith('.private.json') or path.suffix.lower() in ['.gpx','.pem','.key','.dump','.db','.sqlite','.gz','.zip'] or any(x in path.parts for x in ['.private','data','artifacts','backups']):issues.append((name,'forbidden private artifact'));continue
 data=git('show',':'+name) if args.staged else (root/name).read_bytes()
 try:text=data.decode('utf-8')
 except UnicodeDecodeError:issues.append((name,'unexpected binary'));continue
 count+=1
 for label,pattern in rules:
  if name!='scripts/scan-public.py' and re.search(pattern,text):issues.append((name,label))
 if name.startswith('workflows/') and name.endswith('.json'):
  w=json.loads(text)
  if w.get('active') or w.get('pinData') or any(n.get('credentials') for n in w['nodes']):issues.append((name,'active workflow, pinned data or credentials'))
  if any(not n.get('disabled') for n in w['nodes'] if n['type'].endswith('.emailSend')):issues.append((name,'enabled email node'))
for name,reason in issues:print(name+': '+reason)
print(f'Public audit: {count} text files; {len(issues)} findings (values never printed).')
sys.exit(bool(issues))
