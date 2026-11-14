# Operations

Run commands from the repository root. `sudo bash scripts/compose.sh ps` shows service health. Use bounded `logs --tail 100 helper n8n writer` for diagnostics; treat logs as private. Keep the editor on loopback/SSH tunnel or configure HTTPS and secure cookies before publishing it.

## Stop, replay and deliver

Unpublish Weekly Scheduler and optional Research/Ocean schedules before maintenance. Disabling configuration readiness also blocks production collection; `sudo python3 scripts/configure.py` intentionally reapplies dry-run/SMTP-off gates. n8n publication and database execution gates are separate.

Manual replay uses the original explicit Wednesday instant, location, namespace and positive edition. Replaying the same identity is deduplicated by PostgreSQL claims. Use a new edition for a deliberate corrected report. Dry-run archives test data without subscriber sends. A manual Friday update must retain its Wednesday report anchor and Friday collection timestamp; use the existing update settings/validation rather than editing stored report bodies.

Delivery loads an existing archive and sends its immutable HTML/text/map. `send_test` selects only the configured test inbox. `retry_failed_deliveries` is for known failed recipients of the same report. Do not retry `accepted`, `sending` or `unknown` rows without reconciling with the SMTP provider first. A network timeout can occur after a provider accepts an email, and an accepted SMTP transaction does not prove inbox delivery.

## Backups and restore

```bash
sudo bash scripts/backup.sh /var/backups/fishing-report
```

This creates a private directory with both database dumps, deployment secrets and local config. Encrypt/copy it to protected storage outside this repo and test restores. Also preserve named volumes or their private snapshots: n8n data, writer authentication and SST cache. Original GPX/official-warning jobs are owner inputs and require their own protected backups. The backup script does not copy those volumes or GPX automatically. Never commit backup contents.

Restore both PostgreSQL databases into a stopped/test stack with matching roles, passwords and schema versions using `pg_restore`. Restore the original `N8N_ENCRYPTION_KEY` before starting n8n; otherwise saved credentials may be unreadable. Reauthenticate the writer if its auth volume was not restored. Restore local config/GPX and recreate mounts. Start with schedules unpublished and production gates off; verify archive/ledger consistency, run a dry-run and test delivery before republishing. Restoring an old delivery ledger can reintroduce duplicate-send risk, so reconcile provider history first.

## Changes and upgrades

Back up and unpublish schedules. Apply only new SQL migrations in numerical order; do not use the fresh installer against an existing schema. Rebuild helpers/writer after source/dependency changes. Keep n8n and runners on the same tested version. Rebuild your private exports after code or schedule changes and privately rebind Postgres/SMTP credentials before import. CLI imports overwrite workflow definitions, so saved bindings and disabled-node state must be restored deliberately.

Public exports always import inactive with email disabled and credentials omitted. They are source templates, not a round-trip backup of private installed settings. The Setup workflow seeds only absent configuration. The database `configuration` row and `subscribers` table remain authoritative for n8n; keep mounted private config synchronized through `configure.py`. Reapplying `--activate` sets a new activation boundary and should be deliberate.

After changes, restart n8n to reload CLI-imported workflows, verify child/error bindings, run an isolated dry-run, inspect provider gaps and test archived delivery. Re-enable only the schedules/features you intend. Roll back code/images/config together with compatible database backups; do not blindly run destructive down-migrations.

## Publishing source changes

Run `npm run build`, `npm test`, Python checks and `python3 scripts/scan-public.py`. Stage named source paths; inspect `git diff --cached --stat` and run `python3 scripts/scan-public.py --staged`. Scan additionally with a dedicated secret scanner before pushing. Never use raw credential exports, `export --all` execution dumps, private runtime backups or an entire server directory as a public bundle.

Configuration, waypoint files, archives, local SSH material, tokens and personal addresses belong in ignored paths or private n8n credentials. If publishing an updated workflow from a live instance, remove credential references, pinned/execution data, static state and personal/manual settings, disable schedules/email, and compare it to a rebuild from source. Regenerated sanitized exports are the preferred publication path.
