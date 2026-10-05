# Debian deployment with Cloudflare Tunnel and the existing database

This guide uses Docker Compose on Debian and `cloudflared` as a host systemd service. It preserves the existing SQLite database: accounts/password hashes, preferences, descriptions, invoices/PDFs, invoice versions/delivery records, tax settings and tax entries. Registration is disabled on the server; sign in with your existing email/password after importing the database.

The application preparation is tested in Debian-based Linux containers and disposable proxy/restore tests. Your actual server, domain, tunnel, Gmail connectivity and off-machine backup destination still need the final checks below. No remote server has been changed by this preparation.

## 1. Server and deployment directory

Use a supported 64-bit Debian release, Docker Engine and the Compose plugin, installed from [Docker's Debian instructions](https://docs.docker.com/engine/install/debian/). Build images on the server so Chromium/Node match its architecture. Allow room for SQLite, retained PDF versions and 14 backups. For this small service, 2 CPU cores and 4 GB RAM provide reasonable headroom for Chromium and password hashing; this is a starting estimate, not a capacity guarantee.

Create a private deployment directory owned by your deployment user, then clone the source:

```sh
sudo install -d -m 0750 -o "$(id -un)" -g "$(id -gn)" /opt/invoicing
git clone https://github.com/PovilasKamarauskas/invoicing.git /opt/invoicing
cd /opt/invoicing
cp deploy/production.env.example .env
chmod 600 .env
```

Edit `.env` privately. Set `APP_ORIGIN` to the exact public origin, for example `https://invoices.your-domain.com`, with no path. Fill the existing Gmail sender/app password and `BACKUP_STATUS_OWNER_EMAIL`; these values are separate from the database. Copying the database alone does not copy SMTP configuration. Do not put your filled `.env`, tunnel token, database or backups in GitHub.

Use this helper in every deployment terminal:

```sh
dc() { docker compose -p invoicing -f docker-compose.yml -f compose.production.yml "$@"; }
```

The stable project name `invoicing` gives the server its own `invoicing_invoice-data` volume. Always use the same helper for updates/restarts; changing project names can make it appear that your database is missing. The local Mac deployment retains its separate existing volume.

The production override enforces secure cookies, closed registration, trusted private proxy forwarding, unprivileged Node users, dropped capabilities, restricted privilege escalation, a read-only frontend, health checks, process reaping and bounded Docker logs. Only `127.0.0.1:5173` is published; the backend and SQLite have no published port. Chromium uses its existing container-compatible launch mode; the container is the additional isolation boundary.

## 2. Final consistent export on the current Mac

A private prepared transfer may already exist under `backups/debian-transfer-*`. It is a snapshot of the data at its creation time. Refresh it at the actual cutover if any invoices/settings changed afterwards.

Pause invoice/settings writes on the Mac, then make and verify a fresh SQLite backup:

```sh
cd /Users/povilaskamarauskas/invoice-tool
docker compose exec -T backend node /app/scripts/backup-database.mjs --force
```

Choose the newly created `.sqlite` in `backups/automatic`. Keep its matching `.sqlite.json` manifest. Verify that specific file:

```sh
node scripts/verify-backup.mjs backups/automatic/CHOSEN_SNAPSHOT.sqlite
```

The report includes schema/table counts and an invoice checksum; retain it for comparison. The current schema is 5. This backup uses SQLite's consistent backup API and includes invoice files stored as BLOBs. **Do not copy only the live main SQLite file while it is running:** committed data can also be in its WAL.

Once you choose this as the final cutover copy, stop the local backend and do not create further local invoices/settings until the server is confirmed:

```sh
docker compose stop backend
```

Keep the local database volume and the verified snapshot for rollback. The Mac and Debian will be independent copies; later writes on one do not synchronize to the other.

## 3. Transfer and import before first startup

On Debian, from `/opt/invoicing`, create the incoming folder before container ownership is applied:

```sh
install -d -m 0700 backups/automatic/incoming backups/secondary
```

Transfer the verified pair over SSH/SCP, using your real server login. Give them these names in the incoming folder:

```sh
# Run on the Mac; replace SERVER with your SSH destination.
scp -p backups/automatic/CHOSEN_SNAPSHOT.sqlite SERVER:/opt/invoicing/backups/automatic/incoming/invoices.sqlite
scp -p backups/automatic/CHOSEN_SNAPSHOT.sqlite.json SERVER:/opt/invoicing/backups/automatic/incoming/invoices.sqlite.json
```

If using a prepared transfer folder, substitute its `invoices.sqlite` and `invoices.sqlite.json` paths. They contain private financial/account data; transfer them separately from the source repository.

On Debian, build images and import into the **empty** database volume, with the backend stopped:

```sh
cd /opt/invoicing
dc build
dc run --rm --no-deps --user root --cap-add DAC_OVERRIDE --entrypoint node backend \
  /app/scripts/restore-database.mjs \
  /app/backups/incoming/invoices.sqlite /app/data/invoices.sqlite
```

The import checks the manifest/file hash, invoice hash, table counts, SQLite integrity and foreign keys. It installs the verified copy exclusively and refuses to replace an existing database or WAL/SHM sidecars. If it reports an existing destination, stop and inspect that volume; do not delete it to silence the error. Import is for first startup into an empty destination, not an online restore or merge.

The one-time root operator commands explicitly grant the capabilities needed to read the private input and set ownership; application containers keep all capabilities dropped. Apply private permissions and the container Node user's ownership to the imported database and writable directories:

```sh
dc run --rm --no-deps --user root --cap-add CHOWN --cap-add DAC_OVERRIDE --entrypoint sh backend -c \
  'chown 1000:1000 /app/data /app/data/invoices.sqlite /app/backups /app/secondary-backups && chmod 700 /app/data /app/backups /app/secondary-backups && chmod 600 /app/data/invoices.sqlite'
dc up -d
dc ps
curl --fail http://127.0.0.1:5173/api/health
```

Expect both services healthy and `{"status":"ok"}`. UID 1000 is the image's Node user; host backup directories may need `sudo` for operator access if your Debian login uses another UID. Do not recursively change permissions on an unrelated mounted network share. Configure a secondary backup destination separately with suitable ownership.

The import does not create or replace accounts. Password hashes remain intact. Existing browser cookies belong to the old hostname, so sign in again on the new public hostname. Retained session rows are included in the snapshot.

## 4. Host systemd tunnel and public hostname

Follow [Cloudflare's current Tunnel setup](https://developers.cloudflare.com/tunnel/get-started/) to install `cloudflared` on Debian, create or select a persistent tunnel, and install the connector as a systemd service using the dashboard-provided Linux command. Keep the tunnel token private on the server; it is not an application setting or repository file. If you already have a working systemd tunnel, add a published application route to it instead of replacing it.

Configure the published route:

| Setting | Value |
| --- | --- |
| Public hostname | The hostname in `APP_ORIGIN` |
| Service type | HTTP |
| Local service | `127.0.0.1:5173` |

The browser uses HTTPS at Cloudflare; the local hop to this loopback service uses HTTP. Do not route directly to port 3000, expose port 5173 on all interfaces, or enable permissive CORS. The frontend forwards `/api` and `/invoice` through the same public hostname. [Cloudflare supplies `CF-Connecting-IP`](https://developers.cloudflare.com/fundamentals/reference/http-headers/); the private frontend validates it and replaces client-supplied forwarding chains before the backend trusts its one proxy hop.

Verify the service:

```sh
sudo systemctl status cloudflared
```

For this hostname, configure a Cloudflare cache rule to **bypass cache**, particularly `/api/*` and `/invoice/*`; do not use a Cache Everything rule. Authenticated responses also send private/no-store headers and `Cloudflare-CDN-Cache-Control: no-store`. See [Cloudflare's cache-response documentation](https://developers.cloudflare.com/cache/concepts/cache-responses/).

Keep Rocket Loader and automatic script/HTML rewriting off for this application. Its content-security policy allows its own bundled scripts. Cloudflare Access restricting this hostname to your own identity is an optional additional login boundary; the application's existing email/password login remains required.

No inbound app/DB firewall port needs opening for the host tunnel. Permit the outbound traffic required by your tunnel, image builds and configured SMTP provider according to your server's network policy.

## 5. Public verification and backups

From a browser on a different network:

- Open your HTTPS hostname. The login page must have no Create an account action.
- Sign in with your existing account/password. Check seller/buyer details, saved descriptions, invoice history/versions and tax records against the Mac. Current transfer verification reports two accounts and nine invoices; refresh those expectations if you add data before cutover.
- Confirm the session cookie has Secure, HttpOnly and SameSite=Lax; sign out and sign in again. Invoice/API requests must stay on your public hostname.
- Inspect an existing invoice and download an existing retained version. Do not regenerate/email just to test database retention.
- Check the unauthenticated history route returns 401 and API responses are not cached. Check browser console errors, health status and the tunnel after a server reboot.
- Verify Settings → Backups is available only to the configured owner. Trigger a forced private backup, verify it and rehearse restoration into a disposable path using the operator commands below.
- Gmail delivery and the real tunnel cannot be established by local tests. When ready, intentionally email an existing invoice to your own account and check inbox/spam; this sends a real message.

```sh
dc exec -T backend node /app/scripts/backup-database.mjs --force
dc exec -T backend node /app/scripts/backup-database.mjs --status
# Substitute a real post-import backup basename; /tmp/rehearsal.sqlite must not exist.
dc exec -T backend node /app/scripts/verify-backup.mjs \
  /app/backups/CHOSEN_SERVER_BACKUP.sqlite /tmp/rehearsal.sqlite
dc exec -T backend node -e "require('node:fs').rmSync('/tmp/rehearsal.sqlite')"
```

Automatic daily backups remain private and retain 14 verified snapshots. An additional directory on this same server does not protect against losing the server; configure a second destination on another machine for that protection. Keep the Mac cutover backup until you have verified the server and its independent backup/restore process.

## 6. Updates and rollback

For normal source updates, use the same project name/Compose files:

```sh
cd /opt/invoicing
dc exec -T backend node /app/scripts/backup-database.mjs --force
git pull --ff-only
dc up -d --build
dc ps
```

Record the deployed source commit before upgrades. Forward database migrations preserve retained data, but an old image might not support a newer schema; rollback can require both the previous source and its matching verified database backup. Stop writers and preserve the current database before any manual disaster restore. Never run `docker compose down -v` on the real deployment, remove its volume, or rerun an import over the live database.

If cutover fails before any new Debian writes, leave the tunnel unavailable and restart the Mac backend with `docker compose up -d backend`. If the server has accepted new writes, preserve its current backup first and reconcile those changes before switching copies; do not silently replace either database with the other.
