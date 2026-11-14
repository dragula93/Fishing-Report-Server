#!/usr/bin/env bash
set -euo pipefail
umask 077
root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
dest=${1:?Supply an absolute protected backup directory outside the repository}
test "${dest:0:1}" = /
case "$(realpath -m "$dest")/" in "$root/"*) echo 'Backups must be outside the repository.' >&2; exit 1;; esac
mkdir -p "$dest"; chmod 700 "$dest"
out=$(mktemp -d "$dest/$(date -u +%Y%m%dT%H%M%SZ).XXXXXX")
bash "$root/scripts/compose.sh" exec -T postgres pg_dump -U n8n_app -d n8n -Fc > "$out/n8n.dump"
bash "$root/scripts/compose.sh" exec -T postgres pg_dump -U fishing_app -d fishing -Fc > "$out/fishing.dump"
cp "$root/deploy/.env" "$out/deployment.env"
cp "$root/config/config.private.json" "$out/config.private.json"
echo "Private backup saved under $out. Protect it like credentials."
