# Fresh Linux or container installation

## Hosts and dependencies

Instructions checked against vendor documentation on 2026-11-14: Ubuntu **26.10** (latest release) or **26.04 LTS**, Debian **13** stable (current point release 13.7), and Rocky Linux **10** (current point release 10.2). Obtain current patched media from [Ubuntu](https://releases.ubuntu.com/), [Debian](https://www.debian.org/releases/) or [Rocky](https://docs.rockylinux.org/releases/). Use a fresh 64-bit Linux VM or host with systemd, Internet/DNS, sufficient persistent disk, and at least a few GB of RAM for the helper/map build. The original deployment and isolated validation use Debian; Ubuntu/Rocky commands are documented from vendor instructions, not claimed as tested VM installations.

The deployment is **container based on each distribution**. Docker pulls n8n and matching external task runners; the helper Dockerfile installs Python 3.13 and the locked pip packages; the writer Dockerfile installs Node 22, npm and Codex CLI 0.160.0. PostgreSQL comes from the pinned image. No host npm, n8n, PostgreSQL server or scientific pip install is required. Host Python 3 runs the configuration utilities. This avoids relying on distribution Node/npm versions. Preserve matching n8n/runners versions (2.41.6 here); test upgrades deliberately.

### Ubuntu and Debian

Run on a fresh supported host. For an existing host with Docker/containerd/Podman packages, resolve conflicts using the vendor instructions first. These commands install the official Docker packages using the host's own codename.

```bash
sudo apt-get update
sudo apt-get install -y ca-certificates curl git python3 python3-venv openssl
sudo install -m 0755 -d /etc/apt/keyrings
. /etc/os-release
case "$ID" in ubuntu|debian) ;; *) echo 'Use the Rocky instructions'; exit 1;; esac
sudo curl -fsSL "https://download.docker.com/linux/$ID/gpg" -o /etc/apt/keyrings/docker.asc
sudo chmod a+r /etc/apt/keyrings/docker.asc
printf 'Types: deb\nURIs: https://download.docker.com/linux/%s\nSuites: %s\nComponents: stable\nArchitectures: %s\nSigned-By: /etc/apt/keyrings/docker.asc\n' \
  "$ID" "$VERSION_CODENAME" "$(dpkg --print-architecture)" | sudo tee /etc/apt/sources.list.d/docker.sources >/dev/null
sudo apt-get update
sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
sudo systemctl enable --now docker
sudo docker version
sudo docker compose version
```

References: [Docker on Ubuntu](https://docs.docker.com/engine/install/ubuntu/) and [Docker on Debian](https://docs.docker.com/engine/install/debian/).

### Rocky Linux

Keep SELinux enabled. The supplied mounts use SELinux relabel options; do not share these private mounts between unrelated stacks.

```bash
sudo dnf install -y ca-certificates curl git python3 openssl dnf-plugins-core
sudo dnf config-manager --add-repo https://download.docker.com/linux/rhel/docker-ce.repo
sudo dnf install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
sudo systemctl enable --now docker
sudo docker version
sudo docker compose version
```

Reference: [Rocky Docker installation](https://docs.rockylinux.org/gemstones/containers/docker/). If the installed DNF plugin uses a different `config-manager` syntax, use that version's help or the linked instructions. Do not disable SELinux to work around a missing file label.

## Clone, configure and build

The following shell commands run as your normal login user, using `sudo` for Docker/system operations. Clone into a private parent directory; the clone itself remains ordinary source.

```bash
mkdir -p ~/fishing
chmod 700 ~/fishing
cd ~/fishing
git clone https://github.com/dragula93/Fishing-Report-Server.git
cd Fishing-Report-Server
python3 scripts/init-env.py
# Pick ONE starting example:
cp config/config.global.example.json config/config.private.json
# For NOAA/US instead: cp config/config.example.json config/config.private.json
mkdir -p data/gpx data/alerts artifacts/private
chmod 700 data artifacts
chmod 755 data/gpx data/alerts
chmod 644 config/config.private.json
```

The private parent directory prevents other host users from traversing the clone. The mounted config file must be readable by helper UID 10001. Do not put provider keys or passwords in it; use `deploy/.env` or n8n credentials instead. The app's local `.env` is mode 600 and ignored by Git. `init-env.py` refuses to overwrite an existing file.

Edit `config/config.private.json` following [LOCATIONS.md](LOCATIONS.md): set verified coordinates, timezone, provider, vessel preferences and source IDs. Set your own email sender, operator and test inbox. Keep `configuration_ready=false`, execution mode `dry_run`, SMTP readiness false and subscribers disabled. The worldwide example deliberately has no fishing sources or news feeds; provide local ones before expecting catch recommendations.

Edit `deploy/.env`: set `REPORT_TIMEZONE` to your schedule timezone. The default editor bind is `127.0.0.1`, host `localhost`. Fill `WORLDTIDES_API_KEY` for global tide predictions and any optional commercial Open-Meteo key; leave SST disabled until its bounds and your GPX inputs are ready. Keep all generated database/encryption/broker secrets. Do not print resolved `docker compose config` output into logs because it expands secrets.

Compile a **private** workflow build for your schedule timezone/hours. This does not change public exports:

```bash
sudo docker run --rm --user "$(id -u):$(id -g)" \
  -v "$PWD:/work:Z" -w /work \
  -e FISHING_CONFIG=config/config.private.json \
  -e FISHING_OUTPUT_DIR=artifacts/private/build \
  node:22-bookworm-slim node scripts/build-workflows.js
sudo bash scripts/compose.sh build --pull helper writer
sudo bash scripts/compose.sh up -d --wait --wait-timeout 240
sudo bash scripts/compose.sh ps
```

Builds download pip/npm dependencies and the hash-checked JPL DE421 ephemeris. No production credentials are required to build the images. Container services restart automatically after a host reboot.

## Create owner and import

On the Linux host open `http://localhost:5678`. For a remote VM, forward its loopback port from your workstation:

```bash
ssh -L 5678:127.0.0.1:5678 your-user@your-linux-host
```

Open `http://localhost:5678` on the workstation and create **your own** n8n owner login. For shared or Internet-facing editor access configure an HTTPS reverse proxy, corresponding n8n editor/webhook URLs and secure cookies first. The supplied HTTP/secure-cookie-false settings are for loopback/tunneled use. Docker-published ports require Docker-aware firewall rules; retaining the loopback bind avoids unintentionally publishing the editor.

After the owner exists, run:

```bash
sudo bash scripts/install.sh
```

The installer refuses an existing report schema. It applies SQL migrations 001–006, privately binds the Postgres credential, imports all eight workflows inactive, applies local configuration/subscribers with sending gated off, deletes its temporary plaintext credential file, then restarts n8n. The generated workflow bindings remain under ignored `artifacts/private/`. This is a **fresh installation** importer, not an upgrade command.

In the editor verify **Fishing Report - Database** uses `postgres:5432`, database `fishing`, user `fishing_app`, and the locally generated application password. SSL is disabled only for the private Compose network. Check child references and error workflow settings against ARCHITECTURE.md. Stable IDs should survive CLI import; reselect children if importing manually gives new IDs.

Publish the child workflows in this order: Failure Handler, Delivery, Source Evidence, Ocean Feature Cache, Location Report. Leave the Weekly Scheduler and Community Research unpublished during testing. Child publication also activates any schedule in that child: SST remains inert while both SST gates are off; enable SST only after configuration. Setup can remain unpublished and be run manually; it will not replace the configuration already applied by the installer.

## Verify and send a test

In Scheduler → **Manual Replay Settings**, choose an explicit Wednesday timestamp with timezone offset and a fresh positive edition, `mode:'dry_run'`, `use_fixtures:true`. Execute manually. Verify six local dates, immutable archive, per-location isolation and no deliveries. Then use `use_fixtures:false` and another edition for live collection. Inspect data gaps, provider names, tide datum, attribution and warning coverage. A historical manual timestamp with live collectors does not turn today's forecasts into historical forecasts.

To enable the optional writer, use your own account:

```bash
sudo bash scripts/compose.sh exec -T writer codex login --device-auth
sudo bash scripts/compose.sh exec -T writer codex login status
```

Set `llm.enabled=true` in your private config and reapply with `sudo python3 scripts/configure.py`. This defaults back to dry-run gates. A missing/unavailable writer leaves factual output.

Create and test your SMTP credential in n8n, bind both email nodes and enable them. For a one-inbox test, set `execution.test_recipient`, `email.sender`, `email.operator`, and `email.smtp_ready=true` in the **database configuration** while keeping overall mode dry-run. The normal configure command intentionally resets SMTP readiness; use the database editor/query below for this temporary test gate:

```bash
sudo bash scripts/compose.sh exec -T postgres psql -U fishing_app -d fishing <<'SQL'
UPDATE configuration SET value=jsonb_set(value,'{email,smtp_ready}','true') WHERE key='main';
SQL
```

In Delivery → **Manual Archived Delivery Settings**, enter the actual archived report ID/location/original Wednesday timestamp, `namespace:'test'`, `mode:'send_test'`. Run it once. The test recipient overrides subscribers. Confirm the report and optional map in your inbox, and the delivery ledger's accepted status. `Send Test Email` on a credential/node is not a substitute for verifying archived delivery.

## Activate your deployment

After reviewing live output and your one-inbox test, enable only intended subscribers in `config/config.private.json`. Confirm provider licensing, official warning coverage and vessel settings. Apply production gates and a new activation boundary:

```bash
sudo python3 scripts/configure.py --activate
```

Publish Weekly Scheduler. Publish Community Research only for its supported region and after writer authentication. Configure and enable SST as described in LOCATIONS.md before allowing its schedule to acquire data. No existing subscriber set is inherited from the original installation. Activation suppresses automatic collection of occurrences before the new boundary; a deliberate manual replay is separate.

See [operations](OPERATIONS.md) for stopping schedules, retrying deliveries, private backups and upgrades. See [n8n Docker documentation](https://docs.n8n.io/hosting/installation/docker/) and [CLI commands](https://docs.n8n.io/hosting/cli-commands/) for upstream import/publication behavior.
