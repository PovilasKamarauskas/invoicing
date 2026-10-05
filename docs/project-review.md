# Project review and improvement plan

Reviewed 2026-10-03. Scope: the current React frontend, Nest backend, SQLite schema, invoice renderer, SMTP delivery, tests and Docker configuration. This checkout has no Git history, so findings concern the current implementation; authorship and individual model changes cannot be established.

Implementation has started. See [current implementation progress](implementation-progress.md) for completed work and remaining batches; the findings below describe the original reviewed state.

## Assessment

The app has a useful foundation. Keep React, Nest and SQLite. Account ownership is enforced in history queries; passwords use salted scrypt; session tokens are random and hashed in storage; HTML is escaped before PDF rendering. Invoice snapshots, original ZIPs and numbering preferences are saved transactionally. The description field is an integrated combobox, as requested.

The next work should concentrate on invoice correctness, duplicate prevention, recoverability and a repeatable deployment. Further visual redesign can follow those changes.

Priority: **P1** = address first because ordinary use can produce incorrect records or deployment has significant gaps; **P2** = next reliability iteration; **P3** = usability/maintenance follow-up. Reproduced findings are distinguished below from code inspection and unverified operational risks.

## Findings

### 1. P1 — Money is rounded independently in several places

Evidence: `backend/src/invoice/invoice.service.ts:55`, `:182`, `:362`; `backend/src/invoice/invoice-history.service.ts:65`; `frontend/src/components/LineItems.tsx:79`.

The renderer sums raw floating-point products, rounds each displayed line separately, and separately derives euros and cents for words. The UI and retained total repeat the calculation.

Reproduced with the actual HTML renderer:

- Two lines of quantity `0.5` at price `0.01`: each line displays `0.01`, but the invoice total displays `0.01`. The visible lines add up to `0.02`.
- Quantity `0.5` at price `3.99`: numeric total `2.00`, English words `one EUR and one hundred cents`; Lithuanian words `vienas EUR ir šimtas centų`.

**Change:** define decimal precision and rounding once. Recommended policy: decimal multiplication for fractional quantities, round each line to integer cents, then sum those cents. Derive displayed amounts and words from the same canonical result. Integer cents for price alone do not solve fractional-quantity rounding. Version the calculation policy for retained invoices; preserve existing original documents.

### 2. P1 — Repeated generation creates duplicate invoice numbers

Evidence: `frontend/src/components/InvoiceForm.tsx:25`, `:47`, `:80`; `backend/src/invoice/invoice-history.service.ts:62`; `backend/src/account/database.service.ts:28`.

The next number is calculated only when the form mounts. Successful generation leaves that number in the form. Clicking Generate again creates another record and another email. Separate tabs can also start with the same suggestion. There is no unique constraint on owner/number or idempotency key on generation. Repeated saves of the same number were accepted in an isolated database.

**Change:** separate “issue new invoice” from downloading an existing invoice. Allocate the next number on the server transactionally, preserve prefixes/padding, enforce the chosen uniqueness scope, and make generation retries idempotent. Offer an explicit New invoice action after success. Inventory existing duplicate numbers before adding a constraint; never silently renumber issued documents. Keep the numbering sequence independent of deletion and older manually entered numbers.

### 3. P1 — Incomplete invoices pass validation

Evidence: `backend/src/invoice/invoice.controller.ts:43`; `backend/src/account/preferences.ts`; `frontend/src/components/InvoiceForm.tsx:61`.

A controller probe accepted empty seller/buyer details, no items, `invoiceDate: "not-a-date"` and an empty payment date. The current checks primarily validate types and length. The form uses a click handler, so input attributes do not supply comprehensive submission validation.

**Change:** validate required business fields, real calendar dates, date ordering, at least one meaningful line, description/unit values, numeric precision and magnitude. Show field-specific errors before rendering. Keep optional registration/bank/tax fields configurable rather than assuming every business has the same requirements. Make the default “Reverse charge” comment a deliberate setting; the app currently applies it to every new invoice without a tax-mode decision. This review does not establish tax/legal compliance.

### 4. P1 — Docker builds a different frontend from local development

Evidence: `frontend/Dockerfile:1`, `:3`, `:4`, `:8`, `:10`; `frontend/package.json:23`.

The package manifest uses Vite 8/plugin 6. Docker installs Vite 5/plugin 4 and uses `npm install` without copying the lockfile first, in both build and runtime stages. Dependency resolution can change between builds, and local verification covers different tooling. Docker also uses Node 20, which is now EOL according to the [official Node release table](https://nodejs.org/en/about/previous-releases).

**Change:** standardize on the project's supported Node 24 runtime, copy both package files, use `npm ci`, remove the Vite downgrade, and test the resulting Docker image. Add an application build identifier so the deployed revision can be checked when localhost appears stale.

### 5. P1 before wider access — Exposure, dependencies and resource limits need attention

Evidence: `docker-compose.yml:21`; `backend/src/account/auth.service.ts:48`; `backend/src/invoice/invoice.service.ts:466`; `backend/src/invoice/invoice-email.service.ts:90`.

Compose publishes `5173:80` without a loopback binding. It does not restrict access to localhost; actual reachability depends on the Docker host and firewall. Registration is open and email ownership is not verified. A registered caller can trigger two Chromium processes per generation, retain unlimited invoices and send automatic emails. The manual resend cooldown does not cover automatic mail from generation/regeneration. There are no generation concurrency limits or container resource budgets.

The production dependency audit reported **4 affected backend packages (3 high, 1 moderate)** and **7 frontend packages (4 high, 3 moderate)**. These counts include transitive/parent packages and are not counts of independently exploitable application bugs. Findings include Nest/Multer, brace-expansion, Axios, Express/qs and the proxy's micromatch/braces chain. The current source does not expose file uploads or accept user-supplied glob patterns, and several Axios advisories require another vulnerability or a different adapter; direct exploitability has not been established. See the [Axios advisory](https://github.com/advisories/GHSA-vh66-26gq-q6x8) and [braces advisory](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm). The audit covers workspace dependencies, not installed packages inside existing images.

**Change:** default the personal deployment to `127.0.0.1:5173:80`. For shared access, deliberately configure HTTPS, secure cookies, restricted registration or email verification. Bound generation concurrency and rate-limit all email paths. Upgrade affected dependencies after checking compatibility and reachability; do not apply `npm audit fix --force` blindly (the current suggestion for the proxy chain includes a major downgrade). Reduce container privileges and set resource limits while testing Chromium compatibility.

**Credential follow-up:** a normal Gmail password and an app password were posted in the earlier conversation. If still valid, change the normal password and revoke/replace that app password through Google. Enter the replacement directly in the local environment file. No credentials were read into this report or changed during the review.

### 6. P2 — Deleting during regeneration produces an unhandled database error

Evidence: `backend/src/invoice/invoice.controller.ts:150`; `backend/src/invoice/invoice-history.service.ts:102`, `:109`; `backend/src/invoice/invoice-email.service.ts:60`, `:140`.

Reproduced: start regeneration, delete its row while the renderer is pending, then finish rendering. Updating `regenerated_at` silently affects zero rows; recording email status throws `FOREIGN KEY constraint failed`. This also occurs with email disabled. With email enabled, deletion while SMTP is pending can similarly make completion-status recording fail. The UI disables actions within one history component, but another tab/request can still delete the invoice.

**Change:** define the lifecycle of active work versus deletion. For this app, rejecting deletion while an invoice operation is active is sufficient if enforced on the server, with cleanup after failures/restarts. Alternatively, cancellation/tombstones must be understood by workers. Check affected rows, return a deliberate conflict/not-found response and avoid status writes against deleted records. Already accepted emails cannot be recalled.

### 7. P2 — Email delivery delays downloads and is hard to diagnose/recover

Evidence: `backend/src/invoice/invoice.controller.ts:98`, `:153`; `backend/src/invoice/invoice-email.service.ts:49`, `:127`, `:140`.

Generation saves the invoice and then waits for SMTP before returning the ZIP. A slow SMTP operation delays the download by its timeout. A lost response encourages generation retries, which currently create duplicates. A process exit can leave a delivery marked pending with no recovery worker. Failures discard the original error and store only the latest status; logs cannot distinguish authentication failure, connection timeout or recipient rejection. SMTP acceptance still does not prove inbox placement.

**Change:** save an email job transactionally with the invoice, return the ZIP promptly, and process jobs through a small SQLite-backed worker. Use bounded retries and account-wide limits. Store sanitized error category/code, attempt timestamps and provider message ID. Handle ambiguous SMTP timeouts explicitly: SMTP cannot guarantee exactly-once delivery. Poll status in history. Redis or a separate queue service is unnecessary at this scale.

Regeneration uses the current renderer but retains only the original ZIP. A later “Email me” sends that original. Preserve this behavior clearly in labels or add explicit artifact versions; record the renderer/calculation version used so historical output remains explainable.

### 8. P2 — Autosave can prevent logout; stale tabs can overwrite preferences

Evidence: `frontend/src/App.tsx:66`, `:111`, `:142`; `frontend/src/components/InvoiceForm.tsx:93`; `backend/src/account/database.service.ts:58`.

Code inspection shows each keystroke queues a complete seller/buyer record. Any preference-save error disables Sign out until Retry save succeeds; normal later saves do not clear that error. A rejected queue promise can also prevent the logout request from being attempted. On a persistently failing save endpoint, the user cannot use the app's logout action.

Separate tabs replace whole preference objects without revision checks, so stale fields can overwrite newer values. Account identity is checked on startup, not when another tab changes the shared session cookie. An old tab can consequently submit its displayed data under the newly logged-in account. The cross-tab scenario needs a dedicated browser regression test; this is not a claim that owner-scoped SQL can be bypassed.

**Change:** allow logout independently of preference-save success, with an explicit option to discard pending edits. Coalesce writes, track acknowledged/dirty fields and add revision checks where needed. Broadcast account changes between tabs, revalidate on focus and reject stale-session mutations before accepting them. Keep failed edits recoverable.

### 9. P2 — Default date can be yesterday in Lithuania

Evidence: `frontend/src/components/InvoiceForm.tsx:15`.

`toISOString()` uses UTC. At `2026-10-03 00:30` in Vilnius, the form calculates `2026-10-02`. The due-date helper also mixes UTC parsing with local arithmetic.

**Change:** use calendar-date helpers with an explicit timezone policy. Test midnight and daylight-saving boundaries. Recalculate a default due date when the invoice date changes, while preserving an explicitly edited due date.

### 10. P2 — Login throttling groups all proxied users together

Evidence: `backend/src/account/account.controller.ts:29`; `frontend/server.mjs:12`; `backend/src/main.ts:4`.

The limiter uses `req.ip`, but production requests reach Nest through the frontend proxy. The proxy does not provide a trusted client-address setup, so users share one 30-attempt/15-minute budget. Failed and successful authentication attempts both consume it. One caller can temporarily prevent everyone else from signing in.

**Change:** configure forwarded addresses only across a trusted proxy boundary, add per-account throttling and retain a global resource limit for expensive password hashing. Do not simply trust arbitrary incoming forwarded headers. Test two clients through the actual proxy.

### 11. P2 — Persistence exists, but recovery and schema upgrades are manual

Evidence: `backend/src/account/database.service.ts:14`; `README.md` Backup section; `docker-compose.yml:14`.

A named Docker volume survives rebuilds, but is not an independent backup. The README provides a consistent SQLite backup command, which is good; the repository provides no scheduled backup/retention/restore automation. Schema initialization uses `CREATE TABLE IF NOT EXISTS` without versioned migrations. Upcoming money, numbering and delivery changes need controlled upgrades. Existing external backups were not inspected.

**Change:** introduce ordered migrations, back up before schema changes, schedule private backups outside the live volume, and document/test a restore into a fresh volume. Keep original invoice artifacts immutable. Agree on deletion/undo behavior before changing the current explicit permanent-delete feature; do not silently replace it with soft deletion.

### 12. P2 — Verification does not cover the most important failure paths

Evidence: `backend/test/app.e2e-spec.ts:20`; `backend/src/invoice/invoice.service.spec.ts:4`; `backend/src/account/account.spec.ts:38`; `frontend/package.json:6`.

The end-to-end scaffold expects an unregistered `GET /` route to return Hello World and consistently fails. The account tests provide useful isolation/retention coverage, but share ordered state and mock PDF generation. The only renderer test focuses on escaping. There is no committed frontend test command, complete browser journey or real PDF regression check. Backend lint also reports an error and two warnings.

**Change:** replace the scaffold with a meaningful application smoke test, isolate test fixtures and explicitly disable/mock outbound SMTP in tests. Cover rounding, duplicate/retried requests, delete/regenerate races, failed saves/logout and account changes across tabs. Add one browser journey and a real two-language PDF smoke test. Add non-mutating lint and repeatable CI checks. Establish version control for this checkout with secrets/data excluded.

## Suggested implementation sequence

| Phase | Work | Completion criteria |
| --- | --- | --- |
| 0 — Protect the baseline | Rotate previously shared credentials; create a consistent backup; verify restore; establish Git history; bind the personal deployment to loopback. | Existing accounts/invoices can be restored in isolation; secrets and databases are excluded from commits. |
| 1 — Trustworthy invoices | Add migrations; implement canonical money calculations, validation, local dates, transactional numbering and idempotency. Add New invoice/download-existing behavior. | Both languages, UI and stored totals agree; concurrent/retried issuance produces one invoice per operation; invalid invoices are rejected before rendering. Existing duplicates are reported for review. Original documents stay intact. |
| 2 — Reliable history and email | Resolve deletion races; add SQLite delivery jobs, limits, safe diagnostic logging and artifact-version metadata/labels. | SMTP delay/failure does not delay downloads; restart recovers pending work; concurrent delete/regenerate has a defined response; retries never create a second invoice. |
| 3 — Accounts and daily use | Fix autosave/logout; handle cross-tab account changes; correct proxy throttling; add drafts, saved-description editing/deletion and history search. | Failed saves do not trap logout; unfinished work can be recovered; another tab cannot submit stale account data; normal users do not share one login quota. |
| 4 — Repeatable releases | Align Node/tooling and lockfile installs; review dependency upgrades; repair E2E/lint; add browser/PDF smoke tests, health checks and a visible build ID. | Clean Docker build and local build use the same lockfiles/toolchain; checks pass; startup and deployed revision can be verified. Rebuild against a disposable database before applying to the live volume. |

Phases 0 and 1 should precede further UI polish. The Docker/toolchain and test repairs in phase 4 can be pulled forward to provide the baseline for phase 1. Each phase should be a separately reviewable change.

## Smaller follow-ups and product choices

- Persist account-scoped drafts; currently reload loses line items, dates and comment even though seller/buyer are saved.
- Add history search by number/buyer/date, and saved-description rename/delete. Optional price/unit defaults would turn descriptions into a small item catalog; that is a new feature, not required to fix the dropdown.
- Test combobox scrolling with many entries, keyboard focus after deleting a history row and mobile layouts. The highlighted combobox option currently has no explicit scroll-into-view handling.
- Test long names, unbroken text and 200-row PDFs; define page-break rules and finish Lithuanian labels. These are coverage gaps, not verified examples of broken PDFs.
- Add password change/recovery when the app is used beyond its current personal deployment. Define verified registration before opening it publicly.
- Decide the numbering series/reset policy, accepted decimal precision, tax/comment defaults and whether issued invoices need an archive/void workflow. These decisions should be recorded in the existing invoicing-rules document.

## Validation performed and limits

| Check | Result |
| --- | --- |
| Backend build | Passed. |
| Frontend build and lint | Passed. |
| Backend tests | 18/18 passed on repeat. The first run with local listener permission had 2 failures (unexpected 403 and a subsequent renderer-mock failure); cause not established. A prior sandbox-only run could not bind test listeners and is excluded from the code assessment. |
| Separate backend E2E | Failed: expected 200 at `/`, received 404. Used an in-memory database with email disabled. |
| Backend lint, without `--fix` | 1 error (`no-require-imports`) and 2 warnings (`no-floating-promises`). |
| Renderer/controller/database probes | Confirmed line/total mismatch, 100-cent words, acceptance of incomplete data, duplicate numbers, deletion/regeneration foreign-key failure and UTC date mismatch. Used an in-memory database and mock PDF generation; no emails sent. |
| Production dependency audit | Backend: 4 affected packages. Frontend: 7 affected packages. Registry results are time-sensitive; repeat when upgrading. |

Application source was not changed and Docker was not rebuilt or redeployed for this review. Builds refreshed local generated outputs. No live invoice records were edited. This was a source/configuration review with targeted checks, not a complete penetration test, legal review, visual browser audit or inspection of the running images.
