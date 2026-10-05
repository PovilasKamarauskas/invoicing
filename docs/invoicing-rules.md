# Invoicing rules and review

Updated 2026-10-03. These are application rules, not a determination of tax or legal compliance.

## Accounts and persistence

- Email/password registration and login are required to access the workspace and generate invoices. Emails are trimmed, normalized to lowercase and unique. Registration requires 8–256 password characters; email length is limited to 254.
- Passwords are stored as salted scrypt hashes (N=131072, r=8, p=1). Sessions use random 32-byte tokens, stored as SHA-256 hashes in SQLite. Session cookies are HttpOnly and SameSite=Lax, lasting 30 days. Logout removes the server session.
- All saved data is scoped to the authenticated user's ID. No request can specify another user ID.
- Seller and latest buyer details save automatically as they are edited. Writes from a browser are queued to preserve their order. The UI reports pending saves, failures, and offers retry. Sign-out waits for saves; it is disabled while a save error needs retry.
- Saved descriptions persist in SQLite and are shared across the signed-in user's devices. Last generated invoice number is stored after successful ZIP generation; it suggests the next number.
- SQLite contains users, sessions and invoices tables. Account preferences are stored as JSON on the user row. WAL, foreign keys and a 5-second busy timeout are enabled. Docker mounts a persistent named volume at `/app/data`.
- New accounts start with empty seller/buyer details. Registration offers an explicit optional import when legacy browser values exist. It copies valid seller fields, last buyer, saved descriptions and last invoice number into that account. Legacy localStorage remains intact; it is no longer used for ordinary saves.
- Invoice history retains generated invoice snapshots and original ZIPs. No payment tracking, persistent draft storage, email verification or password reset is implemented.

## Defaults, numbering and dates

- The initial number is `SF 1`. The form displays a suggestion; the server assigns the next available number at generation. Older custom numbers do not affect the highest retained number. Trailing digits increment with prefix and leading zeros retained. Suggestions come from the highest numeric SF number in the account history, not the saved counter. Deleting the highest number makes it the next suggestion again. Deleted numbers can be reused for new invoices; old retry keys still return Gone.
- The server reserves the next available number atomically for automatic numbering. Manual numbers remain editable before issuance; numbers still in history cannot be reused; deleting an invoice releases its number. Prefixes and leading zero padding are retained. After successful generation the form stays editable, retains the entered details/items, and advances to the next available number. Download last invoice retrieves the previous saved files; New invoice clears the items. Idempotency keys return the same stored invoice on retry without another email.
- Invoice date defaults to the browser's local calendar date. Payment due defaults to today plus 30 calendar days. Date addition uses UTC noon calendar arithmetic to avoid daylight-saving shifts.
- Both dates are editable. Changing invoice date recalculates the default due date until the due date is explicitly edited. Both UI and API require real ISO calendar dates (1900–9999) and payment due on or after issue date.
- Comment defaults to `Reverse charge`. It can be changed or removed. It does not calculate tax or check eligibility.
- A new invoice has one blank item, quantity prefilled with the current local month's Monday–Friday weekdays, unit `d`, price 0. Public holidays are not deducted. Added rows still start with quantity 1. Item rows, dates and comments reset on reload.

## Fields, items and amounts

- Seller: name, individual activity number, tax registration number, address, bank name, SWIFT, IBAN. Buyer: name, VAT code, address.
- Each item has description, quantity, unit and price. Frontend units are `d`, `h`, `pcs`, `month`; API permits any unit text up to 30 characters.
- Any row can be removed, including the last. Added rows use the same defaults as the first.
- Quantity is positive, at most 1,000,000 and has up to three decimal places. Price is nonnegative, at most EUR 99,999.99 and has up to two decimals. Decimal input text is preserved while typing; empty/unparseable numeric values are validated before generation.
- Calculation v1 multiplies price and quantity as exact decimals, rounds each line half-up to cents, then sums integer cents. The UI, stored total and both PDFs share the same rule. Original invoices from before this change retain calculation v0 and their original ZIPs. Currency is EUR. No VAT calculation, discounts, deposits, shipping, withholding or exchange rates.
- Invoice number must be nonblank, at most 100 characters, and contain no quotes, slashes, backslashes or CR/LF. Date text is limited to 100 characters; other text fields to 2,000. Seller/buyer fields must all be present as strings; names are required while other fields remain optional. Between 1 and 200 rows are required, with nonblank descriptions and units.
- Total must be finite and below EUR 100,000 to avoid the current Lithuanian large-number limitation. The limit applies to the rounded total. New invoices use canonical decimal calculations and cents carrying.

## Saved descriptions

- Description is one editable combobox with an integrated arrow. Clicking the field/arrow shows all saved descriptions. Typing filters them. Arrow keys navigate, Enter selects a highlighted description, and Escape closes the dropdown.
- Enter without a highlighted option saves the typed description. It is trimmed; blank values are ignored. Case-insensitive duplicates use the existing entry. Up to 500 descriptions, each at most 500 characters, can be saved.
- Descriptions sort alphabetically. Selection changes only description text, preserving price, quantity and unit.
- Saving uses a dedicated authenticated API call, retaining descriptions added from other tabs. Failure feedback does not claim the item was saved.

## Generation and PDFs

- Frontend sends `POST /invoice/generate` with metadata, seller, buyer, items and `additionalComment`. Generate is disabled while the request runs.
- Backend validates the payload, escapes user text for HTML, generates English and Lithuanian HTML, renders two A4 PDFs with print backgrounds, and returns a ZIP at compression level 9.
- Frontend downloads `invoice-<invoiceNumber>.zip`. Server's header uses an ASCII-safe variant. PDF names replace whitespace in the number with hyphens and end with `-en.pdf` or `-lt.pdf`.
- PDFs contain metadata, seller/payment details, buyer details, numbered items, total, total in words, seller as issuer, blank acceptance line and optional nonempty comment.
- Labels are translated; descriptions, units, names and comments are copied. The Lithuanian tax registration label remains in English.
- Lithuanian address generation replaces case-sensitive whole-word country names: Lithuania, Belgium, France, Germany, Netherlands, Luxembourg, Poland, Latvia, Estonia, Sweden, Finland, Denmark, Norway, Austria, Switzerland, United Kingdom, Ireland, Spain, Portugal, Italy, Czech Republic, Slovakia, Hungary, Romania, Bulgaria, Croatia, United States, USA.
- Words derive whole euros and cents from the rounded amount, carrying to euros so cents stay between 0 and 99. Lithuanian grammar is applied to thousands and cents; currency text remains `EUR`.
- PDFs render concurrently in two Chromium browser instances, which close in `finally` blocks. PDFs and ZIP are buffered in memory. The original ZIP containing both PDFs is retained as a SQLite BLOB with the invoice snapshot.
- Success feedback means browser download was triggered, not that saving to disk completed.

## Runtime and API

- Backend listens on 3000. Development CORS allows `http://localhost:5173` with credentials for GET/POST/PUT/DELETE.
- Both Vite and production frontend proxy `/api` and `/invoice` to the backend. Compose binds the frontend to 127.0.0.1:5173 for local access.
- Mutating API calls require `X-Invoice-Client: web`; cross-site browser mutations are rejected. Authentication endpoints are public but throttled at 30 requests/IP/15 minutes. All other routes use the session guard.
- Production Express uses `BACKEND_URL` (default `http://backend:3000`) and `PORT` (default 80). Backend Docker uses Node 24 and installed Chromium/fonts. `DATABASE_PATH` defaults to `./data/invoices.sqlite`, overridden in Docker to `/app/data/invoices.sqlite`.
- Chromium runs with sandbox-disabling arguments. Both Docker images use Node 24 and lockfile-based npm ci; the frontend uses the same Vite/plugin versions as local development. Both builds include the shared invoice rules.

## Original review findings (see current implementation status below)

1. Choose an integer-cent/decimal rounding policy and fix total-in-words cents carrying.
2. Define numbering uniqueness if needed; history retention now exists but does not enforce unique invoice numbers.
3. Use local calendar dates, validate date order and make due-date recalculation explicit.
4. Decide required business fields and tax rules. Reverse charge is still only default text.
5. Existing scaffold end-to-end test expects an unregistered root route; use the new account integration tests for account coverage. They verify hashing/cookies, isolation, persistence, invalid input, logout/login, expiry, rate limiting and number saving after generation. HTML tests verify escaping in both languages.

## Invoice retention and regeneration

- Successful generation saves the original payload, number, dates, buyer name, total, original ZIP, creation timestamp and owner user ID in SQLite. Invoice retention and last-number/buyer preference updates share one transaction; failure rolls back both.
- Each successful new issuance creates a history entry. Used invoice numbers are rejected; retrying the same idempotency key returns the original entry and ZIP. Failed rendering releases its reservation. After a process crash, pending reservations expire after five minutes and can be retried. Older duplicates are preserved rather than renumbered. Failed PDF generation does not create an entry. Previous invoices generated before retention was introduced are not recoverable from the application.
- The history view lists the signed-in account's invoices, newest first, 50 per page, with a cursor for loading older entries. Details expose the current saved seller, buyer, payment information, line items and comment. Versions exposes immutable earlier snapshots.
- Download returns the stored original ZIP without rendering. Regenerate renders a new ZIP from the stored snapshot using the current PDF renderer and records its successful regeneration time. It preserves the original files, does not create a new history entry, and does not change buyer preferences or the last invoice number. A renderer/template update can change regenerated appearance.
- GET `/invoice/history`, GET `/invoice/history/:id`, GET `/invoice/history/:id/download` and POST `/invoice/history/:id/regenerate` all require authentication. All queries include owner user ID. Missing or another user's invoice returns 404. History/details/download responses disable HTTP caching.
- Stored invoice files are part of the same persistent Docker database volume and SQLite backups. There is no automatic expiration. History edits preserve earlier snapshots; manual deletion permanently removes all versions after confirmation.
- Switching between the creation form and history keeps the current form mounted, preserving unfinished edits within the session. Reload still resets the unfinished form.

## Invoice version history

- Migration 5 backfills exactly one baseline of each existing invoice at its current revision, retaining exact payload, total/cents, calculation version, number and ZIP bytes. Overwritten earlier revisions cannot be recovered; no missing revisions are fabricated.
- New issuance atomically saves revision 0 with the current invoice. Each successful history edit saves its next version in the same transaction as the current record, number claims and idempotency result. Rendering/storage failure leaves current data and versions unchanged; retries create no extra revision. Editing does not automatically send email.
- The Versions panel lists snapshots newest first, 50 per page, showing the current version, amounts, saved details and per-version delivery attempts. Previous version downloads use retained bytes without rendering, emailing, changing the current invoice, reserving historical numbers or adding tax revenue. Regeneration alone creates no financial revision.
- Authenticated, account-owned GET routes: `/invoice/history/:id/versions` (optional `beforeRevision` cursor), `/versions/:revision`, `/versions/:revision/download`, and `/versions/:revision/deliveries/:deliveryId/download` beneath that invoice. Responses disable caching; foreign/missing records return 404 and invalid revisions/cursors return 400.
- Version details show one latest result per email attempt; underlying started/result events remain immutable. Sent means the provider accepted the message. A started attempt with no completion recorded remains distinguishable from a successful send. Editing clears the current email summary but preserves previous-version attempts. Original saved PDFs and exact attempt attachment files are distinct downloads.
- SQLite triggers prohibit changing snapshots/events/artifacts or deleting them while their parent invoice exists. Explicit invoice deletion cascades them all and releases the current number; downloaded files and sent mail remain outside the application.

## Invoice email

- Generation and regeneration attempt email after invoice retention succeeds. A SMTP failure does not prevent saving or downloading the ZIP. Both English and Lithuanian PDFs are extracted from the exact generated ZIP and attached individually.
- Recipient is always the authenticated account's registration email, represented as one address. Client-provided recipients and invoice buyer details cannot change it.
- POST `/invoice/history/:id/email` resends the current retained PDFs after enforcing invoice ownership. GET `/invoice/email/config` reports readiness and the account recipient without exposing credentials.
- Immutable `invoice_delivery_events` preserve each attempt and its result against the financial revision. `invoice_delivery_artifacts` retains deduplicated ZIP bytes supplied for validated delivery attempts, so regenerated attachments can differ from the saved version files. Legacy imports record only the last known state and have no exact attachment download. The `invoice_email_delivery` table remains a compatibility summary of the current revision: latest attempt status, recipient, attempt time and latest successful-send time. Status is pending, sent, failed or not_configured. History exposes status and successful-send time. Generation responses also contain `X-Invoice-Email-Status`.
- SMTP configuration lives in environment variables: SMTP_HOST, SMTP_PORT, SMTP_SECURE, SMTP_REQUIRE_TLS, SMTP_USER, SMTP_PASS and MAIL_FROM. Gmail configuration uses smtp.gmail.com:465 with TLS and a Google app password. Without complete configuration, the UI reports that email delivery is not configured.
- SMTP access times out, certificate verification remains enabled, and remote/file attachment access is disabled. Only the two retained PDF buffers are attached. Credentials are not included in application responses or logs.
- Manual resend has a 60-second cooldown after success or five seconds after failure. Concurrent sends of one invoice are blocked. Automatic email is attempted once per generation; there is no background queue or automatic retry after restart.
- Sent means SMTP accepted the message, not confirmed inbox delivery. Last successful-send time is retained even if a later attempt fails.

## Deleting history entries

- Each history row has a Delete action with a confirmation naming the invoice. Cancel or Escape dismisses it. The entry is removed from the UI only after the API succeeds; errors leave the confirmation available for retry.
- DELETE `/invoice/history/:id` requires the authenticated account and the mutation header. Its SQL includes the account user ID. Another account's ID or a nonexistent ID returns 404; anonymous requests return 401.
- Deletion removes the current snapshot and ZIP BLOB, every invoice version, email delivery event and retained delivery artifact through foreign-key cascades. Files already downloaded and emails already sent remain outside the application's control. Account preferences are unchanged; the next suggested invoice number is recalculated from remaining history.
- While regeneration or email delivery is active in the single backend process, deletion returns a conflict instead of removing its row. The number is released when no remaining invoice uses it; idempotency tombstones survive deletion; retrying a deleted invoice returns Gone. Deletion has no undo. Tests use disposable accounts/data to verify ownership, cascade removal and inaccessible deleted download/regeneration/email endpoints.
- Invoice IDs use a persistent monotonic counter, initialized from existing invoices. Deleted IDs are never reused, so an old invoice link cannot point to a later invoice.

## First implementation batch, 2026-10-03

Canonical calculations, stricter issuance validation, local dates, atomic number reservation, retry idempotency, versioned schema migration, deletion guards and consistent Docker tooling are implemented. The scaffold end-to-end test was replaced with authentication checks, and regression tests cover issuance/concurrency. Remaining work is tracked in [implementation progress](implementation-progress.md). Existing credentials, draft retention, background SMTP delivery, dependency upgrades and account recovery were not changed in this batch.

## History numbering and monthly defaults update

The suggestion loads from the server when opening the form, returning from history, or refocusing the window. Manually entered numbers are preserved. If the currently displayed issued invoice was deleted, the form unlocks and refreshes its suggested number. The first row resets to the current month's weekday count on New invoice. Migration v2 releases stale reservations for previously deleted invoices.

## Debian and public-tunnel deployment

The production Compose override enforces HTTPS-origin/secure-cookie settings and closes registration while preserving existing accounts. Browser mutations reject foreign origins; account and API error responses are private/no-store. The frontend replaces untrusted forwarding chains and, for the private Cloudflare tunnel origin, validates the visitor IP used by backend login limits. Existing local HTTP defaults remain available.

Production uses unprivileged Node users, private volumes, health checks, restricted container privileges and security headers. Cloudflared runs as a Debian systemd service targeting loopback port 5173. The operator imports a verified SQLite snapshot into an empty volume before first startup; imports refuse to overwrite an existing DB or sidecars. See [the deployment/cutover guide](debian-deployment.md); the real tunnel, SMTP connectivity and remote backup destination need verification on that server.
