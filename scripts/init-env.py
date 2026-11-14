#!/usr/bin/env python3
"""Create local secrets without placing them in command history or stdout."""
from pathlib import Path
import os
import secrets
root=Path(__file__).resolve().parents[1]
target=root/'deploy/.env'
text=(root/'deploy/.env.example').read_text()
for name in ['POSTGRES_ADMIN_PASSWORD','N8N_DB_PASSWORD','APP_DB_PASSWORD','N8N_ENCRYPTION_KEY','N8N_RUNNERS_AUTH_TOKEN']:
    text=text.replace(name+'=REPLACE_WITH_RANDOM_SECRET',name+'='+secrets.token_hex(32))
fd=os.open(target,os.O_CREAT|os.O_EXCL|os.O_WRONLY,0o600)
with os.fdopen(fd,'w') as stream: stream.write(text)
print('Created deploy/.env with fresh secrets (existing files are never replaced).')
