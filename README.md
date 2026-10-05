# Invoice studio

A small React + Nest application with email/password accounts and SQLite persistence.

Future work is specified in the [small-business implementation handoff](docs/small-business-implementation-plan.md), with ordered releases, acceptance criteria and a completion tracker. Automatic backup/restore tooling and invoice version history are implemented; the handoff tracker identifies the remaining planned features.

## Run with Docker

```sh
docker compose up -d --build
```

The service binds to 127.0.0.1 only. Open http://localhost:5173, choose **Create an account**, and enter an email and a password of at least 8 characters. If this browser already has details from the previous version, registration offers an optional checkbox to import them. Imported data is copied into the new account; the original browser data is retained.

Seller details and the most recent buyer are saved automatically. Type an item description and press Enter to save it to your account; use the same field's arrow to select saved descriptions. Signing in from another browser loads the same account values. Invoice numbers are reserved by the server; numbers still in history cannot be reused. The suggested SF number is one above the highest in history; deleting the highest releases that number for reuse. After generation the form stays editable, retains its details and items, and advances to the next suggested invoice number. Generate again to create another invoice; Download last invoice retrieves the previous files and New invoice clears the line items. Network retries return the same retained invoice without another email. New amounts use exact decimal multiplication and per-line rounding to cents. Every successfully generated invoice is retained in your account with its original details and ZIP containing English and Lithuanian PDFs. Open **Invoice history** to view details, download the retained ZIP, edit saved details and rebuild both PDFs, regenerate both PDFs from the saved snapshot, or delete an entry after confirmation. Deletion permanently removes its saved details, every retained version, attachment files and email delivery history; the next suggested number follows the remaining history and does not remove files or emails already received. Editing keeps the same history entry, updates its current details/files and tax contribution, and preserves each saved version. Use **Versions** to inspect earlier details and download their exact retained PDFs without changing the current invoice or tax income. Versions also show delivery attempts and offer **Attachment files** for the exact files supplied to email, including regenerated files. Existing invoices start with one baseline of their current saved state; previously overwritten edits cannot be recovered. Older email records are labelled as last-known observations, with no claim that their exact attachment files were retained. Explicitly reviewed earned dates are preserved. Concurrent stale edits are rejected and lost-response retries do not duplicate changes. Edited legacy invoices adopt current cent rounding. Edits do not send email automatically; use **Email me** to send the updated files. Regeneration does not overwrite retained files, create a duplicate history entry, or change your next invoice-number suggestion. Unfinished invoice drafts are not stored. Invoices generated before this feature was added cannot be recovered from the server.

SQLite is stored at `/app/data/invoices.sqlite` in the named Docker volume `invoice-tool_invoice-data` (the prefix follows the Compose project name). Normal restarts, rebuilds, and `docker compose down` retain this volume. `docker compose down -v` deletes it, including all accounts and settings.

## Debian and Cloudflare Tunnel

Use the [Debian deployment and database transfer guide](docs/debian-deployment.md) with `compose.production.yml` and `deploy/production.env.example`. It imports the existing verified SQLite snapshot into an empty server volume, keeps the origin on loopback, enforces HTTPS cookies, closes new-account registration and preserves existing login/accounts/invoices. `cloudflared` runs as a host systemd service. Keep database exports, backups and credentials out of GitHub.

## Local development

Backend requires Node 24 (uses built-in `node:sqlite`). Frontend dependencies also support Node 24.

```sh
cd backend
npm ci
npm run start:dev
```

In a second terminal:

```sh
cd frontend
npm ci
npm run dev
```

Without Docker, SQLite defaults to `backend/data/invoices.sqlite` when the backend is started from its directory. Set `DATABASE_PATH` to choose another location.

## Accounts and sessions

- Each account has independent seller details, buyer details, saved descriptions and invoice numbering suggestion.
- Passwords use salted scrypt hashes. The app stores no plaintext passwords.
- Sessions last 30 days and are stored in SQLite as hashed random tokens. Cookies are HttpOnly, SameSite=Lax, and revoked on sign-out. Restarting the app retains valid sessions.
- Authentication attempts are limited to 30 per IP per 15 minutes; this small in-memory limit resets on backend restart. The backend trusts only the private frontend's one forwarding hop. Production forwarding validates Cloudflare's client IP and replaces untrusted forwarding chains, so visitors do not share one tunnel IP. Local direct requests do not trust client-supplied Cloudflare headers.
- API mutations require the `X-Invoice-Client: web` header; cross-site browser mutations are rejected. Account preferences and invoice generation require authentication.
- The production override enforces `COOKIE_SECURE=true`, closed registration and a configured HTTPS `APP_ORIGIN`. Production startup rejects insecure or incomplete origin/cookie/proxy settings. Local Compose keeps HTTP cookies and registration available by default.
- Public deployments can disable registration while retaining existing account login. The login UI reads the registration policy from the server.
- This first version has no email verification, password reset, or account-management screen.

## Yearly taxes and theoretical monthly take-home

Open **Yearly taxes** and review the tax profile and PSD months once for each account/year. The supported profile uses accrual income, the 30% presumed expense allowance, no extra pension contribution and standard Lithuanian individual-activity contributions. Estimates are available for 2026; earlier years show income totals without applying newer tax rules.

The monthly table shows full invoice income minus allocated GPM, VSD and PSD. The 30% allowance reduces the tax base but is not treated as money spent, so it stays within theoretical take-home. Annual taxes are calculated first and allocated to income months, with required PSD minimums assigned to their months. The calendar-year average divides theoretical take-home by twelve. A second average divides that same total by the months from January through the latest earned invoice or positive income adjustment: September means nine, including months with no invoices. No billed income shows no second average. Both estimates include the selected annual PSD minimums and recalculate after invoice editing/deletion or changes to earned dates. This assumes invoices are paid, excludes actual business expenses and does not forecast missing future income.

Review service/earned dates when work belongs to a different period than the invoice date. Add signed income adjustments for income outside the tool and record tax payments under the year they cover, even if paid the following year. Payments change outstanding estimates without changing theoretical take-home. Entries can be edited/deleted; CSV export includes settings, calculations, income records and payments. Deleting an invoice from history removes its contribution to this page too.

Unknown settings, partial-month PSD cases, unsupported tax years and broader GPM cases produce incomplete estimates rather than assumed zeros. Estimates use cents; declaration rounding can differ. VAT features are excluded from this page. See [the tax summary plan](docs/yearly-tax-summary-plan.md) for formulas, assumptions and official sources.

## Automatic private backups

Docker checks on startup and hourly for a daily backup, creating a consistent SQLite snapshot at least 24 hours after the previous success while the application is running. It retains the latest 14 verified snapshots in `backups/automatic`, mounted separately from `invoice-data`. Backup files/manifests are private (0600), the destination directory is 0700, and pruning touches only verified snapshots created by this tool. A stopped/sleeping computer cannot run backups; startup catches up. Backups contain all accounts, sessions, settings and invoice documents, so keep them private.

Configure `BACKUP_STATUS_OWNER_EMAIL` in `.env` with the registration email of the account allowed to see **Settings → Backups**. Other accounts cannot access the operational endpoint. With that value unset, status remains available through the operator command below. `BACKUP_HOST_DIR` selects the host directory and `BACKUP_RETENTION` changes the retention count (1–365).

```sh
docker compose exec backend node /app/scripts/backup-database.mjs --status
docker compose exec backend node /app/scripts/backup-database.mjs --force
```

A snapshot's `.sqlite.json` manifest records schema version, record counts and checksums. Verify it and rehearse restoration into a **new, disposable path**:

```sh
DATABASE_PATH=backend/data/invoices.sqlite BACKUP_DIR=backups/automatic node scripts/backup-database.mjs --force
node scripts/verify-backup.mjs backups/automatic/CHOSEN_SNAPSHOT.sqlite /tmp/invoice-restore-rehearsal.sqlite
```

The verify command rejects an existing destination, including the live database. It verifies the file checksum, schema/table counts, original invoice payload/ZIP checksum, SQLite integrity and foreign keys. No real database is replaced by this command. Use an appropriate `DATABASE_PATH` when running the backup command locally; the local-development database and Docker database are different.

To keep a second copy outside this computer, mount a destination you control (for example a network share) and set `BACKUP_SECONDARY_HOST_DIR` to it and `BACKUP_SECONDARY_DIR=/app/secondary-backups` in `.env`; recreate the backend. The software never provisions a storage account or uploads to an unconfigured service. A second local folder does not protect against loss of the computer. Secondary failures retain a valid primary backup and appear separately in status; both destinations retain the configured number of verified snapshots after successful copies. A failed second copy is retried on the next daily backup or an explicit forced run, rather than filling the primary destination with hourly duplicates.

The application and operator command share a `.backup-lock` directory. An abandoned lock is deliberately not stolen by age. If a crash leaves it behind: stop the backend and every operator backup command, confirm none is still running, then remove **only** `backups/automatic/.backup-lock` (or its configured equivalent) and start the backend. Do not remove a lock while a backup is running.

For a real disaster restore: stop application writes, preserve a consistent backup of any current database first, verify the chosen snapshot into a disposable path, then replace the stopped database in its existing volume. Remove old WAL/SHM sidecars only while the database is stopped and after preserving the old database for rollback. Restart, check integrity/schema, counts and invoice checksums, and run the application checks. Rollback requires stopping again and restoring the preserved previous database. Never use `docker compose down -v`; this deletes the live volume.

## Checks

```sh
npm run build --prefix backend
npm run test --prefix backend -- --runInBand --watchman=false
npm run build --prefix frontend
npm run lint --prefix frontend
npm run lint --prefix backend
npm run test:e2e --prefix backend -- --runInBand --watchman=false
npm run test:deployment --prefix frontend
```

See [the implemented invoicing rules](docs/invoicing-rules.md). SQLite and cryptographic primitives use the [Node SQLite API](https://nodejs.org/api/sqlite.html) and [Node crypto API](https://nodejs.org/api/crypto.html).

## Email invoices with Gmail

New and regenerated invoices are emailed automatically to the signed-in account's registration email, with the English and Lithuanian PDFs attached separately. Invoice history also has an **Email me** action that resends the current retained PDFs. SMTP failures leave invoice retention and downloads working; status is shown in the UI and recorded in SQLite.

The root `.env` file has been prepared with Gmail's SMTP host and TLS port. Fill `SMTP_USER` and `MAIL_FROM` with the sending Gmail address and `SMTP_PASS` with its Google app password, then apply it:

```sh
docker compose up -d --force-recreate backend
```

Gmail app passwords require 2-Step Verification. Create one for Invoice studio through [Google's app-password settings](https://myaccount.google.com/apppasswords); see [Google's instructions](https://support.google.com/accounts/answer/185833). Use the app password without its display spaces. The sender is separate from the recipient: invoices go only to the logged-in account's registration email, regardless of the invoice buyer.

The configuration uses `smtp.gmail.com`, port 465, implicit TLS. A provider using port 587 should set `SMTP_SECURE=false` for STARTTLS. SMTP authentication values are server-only, excluded from version control and Docker build contexts. See [.env.example](.env.example). For local backend development, start with `node --env-file=../.env dist/main.js` after building from the backend directory.

Manual resend is limited to once per minute after a successful send (five seconds after failure). Concurrent sends of the same invoice are prevented. “Sent” means the SMTP server accepted the email; final inbox delivery is controlled by the mail provider. There is no background retry queue; retry through **Email me** when needed.

## Browser smoke check

With both dependencies installed and the frontend running, `npm run test:browser --prefix frontend` exercises validation, decimal inputs, generation, saved download and New invoice. It intercepts account/invoice requests with fixtures and disables test downloads; it does not create accounts, change the real database or send email. For Vite on another port, set `REVIEW_URL=http://127.0.0.1:5174`.

After building the backend, `REVIEW_URL=http://127.0.0.1:5173 npm run test:tax-browser --prefix frontend` verifies the tax UI against a separately started in-memory backend. All account/invoice API requests from the browser are redirected to that disposable backend. The check covers the 30% allowance, both monthly averages, lost-response payment and invoice-edit retries, rebuilt PDFs, editing/deletion, CSV export, unsupported years and mobile overflow; it sends no email and does not access live account data. Without `REVIEW_URL`, it expects a Vite preview on port 5174.

Both Docker build contexts are now the repository root so they can include `shared/`. Backend code remains under `backend/`; the database path and named volume are unchanged. Schema migrations preserve original invoice payloads/files and mark their calculation version as legacy. See [implementation progress](docs/implementation-progress.md).

The first default item uses the current month's Monday–Friday weekday count as its quantity (public holidays are not deducted). Additional rows start at 1. The suggested number refreshes when returning from history or refocusing the window.
