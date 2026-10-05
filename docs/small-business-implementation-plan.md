# Small-business implementation handoff

Status: implementation started on 2026-10-04. B1 automatic backup/restore tooling and V1 invoice version/delivery history are implemented, verified and deployed (V1 on 2026-10-05); P1 payments is the next task. Owner-only Settings access is configured for the registration email supplied by the user.

This document is the implementation roadmap requested by the owner. It defines the intended behavior and acceptance criteria for another model to implement in small releases. Use the completion tracker below to distinguish delivered tasks from the remaining roadmap. Start with Release 1 when implementation is requested; complete and verify each task before moving on.

## 1. Product context and decisions to preserve

The owner is a self-employed computer programmer working remotely from Lithuania, mainly for a Belgian business. The existing tax profile uses accrual income, the 30% presumed expense method, no additional pension contribution, and personally paid PSD. These are the owner's stated settings, not defaults to mark confirmed for other accounts.

Preserve these established behaviors:

- Keep React/Vite, Nest, Node 24, SQLite and the current local Docker deployment at `http://localhost:5173`. A database replacement is unnecessary for this scope.
- Every invoice, payment, draft, template, forecast and export belongs to the authenticated account. Resolve ownership on the server; do not trust a user ID supplied by the browser.
- Mutation routes use the existing authentication/origin guard and `X-Invoice-Client: web` header. Sensitive responses use `Cache-Control: no-store`.
- Generation and edit retries are idempotent. New amounts use the shared exact-decimal, per-line cent-rounding rules. Preserve legacy calculation versions until an explicit edit upgrades that invoice.
- The suggested SF number follows retained history. SF 43 and SF 44 imply SF 45; deleting SF 44 permits SF 44 again. Do not change this into an irreversible numbering counter.
- After generation, the form remains editable, retains the entered details/items, advances its number, and can generate another invoice without a reload. Download last invoice is a separate action. Do not restore the old read-only form.
- Editing history changes the same invoice ID, updates its tax contribution, checks stale revisions and conflicting numbers, and rebuilds both language PDFs. Explicitly reviewed earned dates remain intact.
- New and regenerated invoices are currently emailed to the owner's registration address. Editing does not automatically email. Keep those choices when adding background delivery.
- Do not send invoices or reminders to clients automatically. Client-email sending is outside this plan.
- The 30% allowance reduces the tax base but is not cash spending. Theoretical take-home remains full recognized revenue minus estimated GPM, VSD and PSD.
- Keep both existing averages: theoretical net divided by 12, and the same net divided by months from January through the latest earned invoice/positive income adjustment. September means 9, including gaps. Both include the selected annual PSD minimums.
- Tax estimates currently support 2026 only. Unverified years remain unavailable for calculation. Payment tracking must not switch tax recognition to cash basis.
- Exclude VAT calculations, registration reminders and declaration guidance, as explicitly requested by the owner. Preserve existing invoice comments.
- Keep the current explicit history deletion capability. Any new records removed with an invoice must be identified in the existing deletion confirmation. Do not silently convert deletion into archival or reserve deleted numbers forever.

Deferred: bank synchronization, bank transfers, tax filing, client portals, full expense accounting, multi-currency, automatic recurring issuance, client-email delivery, and a broad CRM. Password recovery/account management can be a separate follow-up; it is not required for these releases.

## 2. Current implementation map

| Area | Files and current behavior |
| --- | --- |
| Database | `backend/src/account/database.service.ts`, `migrations.ts`; migrations 1–5 exist. Version 4 added revision counters/idempotency; version 5 retains immutable invoice versions, exact delivery artifacts and delivery events with current-state baselines. |
| Invoice operations | `backend/src/invoice/invoice.controller.ts`, `invoice-history.service.ts`; generation, ownership, numbering, atomic retention, optimistic edits, download/regeneration/deletion. |
| Documents and money | `backend/src/invoice/invoice.service.ts`, `shared/invoice-rules.cjs`, `shared/invoice-rules.d.cts`; EN/LT PDFs in a ZIP, shared validation and arithmetic. |
| Email | `backend/src/invoice/invoice-email.service.ts`; synchronous SMTP, immutable events/artifacts per version plus a current-version compatibility summary. Generation currently waits for sending; the E1 outbox remains planned. |
| Form and account | `frontend/src/components/InvoiceForm.tsx`, `frontend/src/App.tsx`, `frontend/src/account.ts`; parties autosave to preferences, unfinished invoice drafts do not persist. |
| History | `frontend/src/components/InvoiceHistory.tsx`; paginated list, details, edit, Versions panel with saved/attachment downloads, regenerate, email and delete. No payment ledger or search. |
| Taxes | `backend/src/tax/*`, `frontend/src/components/YearlyTaxes.tsx`, `YearlyTaxes.css`; account/year settings, earned dates, adjustments, tax payments and CSV. |
| Tests | Backend `*.spec.ts`, `backend/test/app.e2e-spec.ts`, `scripts/invoice-browser-smoke.mjs`, `scripts/tax-browser-smoke.mjs`. |
| Operational reference | `README.md`, `docs/invoicing-rules.md`, `docs/yearly-tax-summary-plan.md`, `docs/implementation-progress.md`. The old `project-review.md` describes historical findings, several already fixed. |

Read the current files before editing; this map is a starting point, not a substitute for inspecting changes made by another implementer. Do not invent a Git commit identifier: this workspace previously had no Git repository.

## 3. Release sequence

| Release | Tasks, in implementation order | User-visible result |
| --- | --- | --- |
| 1 — Protect work and track receipts | B1 backup/restore tooling; V1 invoice versions; P1 payment tracking; D1 draft recovery | Recoverable changes, paid/outstanding visibility, recoverable unfinished work. |
| 2 — Reduce monthly administration | E1 background email; T1 templates and monthly drafting; H1 history filters/export | Faster generation, reusable monthly billing, easier lookup and annual handoff. |
| 3 — Planning and annual maintenance | F1 tax reserves/forecast; Y1 year-specific tax rules | Clear estimates for money reserved and planned future income; independently verified support for subsequent years. |

Each task includes backend, UI where relevant, migration, tests, documentation and deployment verification. Avoid leaving a release with a new endpoint but no usable interface. Complete Release 1 before expanding into Release 2.

The proposed schema names below are contracts for intent. Exact column types/index names may be refined, but document changes. Allocate the next unused migration number at implementation time; do not modify already-applied migrations or let separate work streams assign conflicting numbers.

## 4. B1 — Automated private backups and restore verification

### Behavior

- Provide a repeatable consistent backup command using Node's SQLite backup API. Do not copy just the live main SQLite file while ignoring its WAL.
- Run backups daily while the computer/Docker deployment is running. On startup, run a catch-up backup if the latest success is more than 24 hours old; do not imply a sleeping computer ran a scheduled job.
- Default retention: the latest 14 successful daily backups. Prune only after a new backup has completed and passed integrity verification.
- Write to a separate host-mounted backup directory outside the database volume, with owner-only permissions. Support an explicitly configured second destination outside this computer; show whether it is configured. Do not invent remote storage credentials or upload private data anywhere automatically.
- Record last success, last error, destination availability and backup schema version. Show a small backup-status panel in Settings (add a minimal Settings view) without exposing full host paths or raw errors to unrelated accounts. Authorize `GET /api/system/backup-status` against an explicitly configured `BACKUP_STATUS_OWNER_EMAIL` matching the authenticated account; if unset, expose status only through the operator command. Hide the UI for accounts without that capability. Do not make this a public route or an unrestricted multi-user database download.
- A whole-database backup includes all accounts, session tokens/hashes and invoice files. Keep restore as an operator command, not an ordinary account upload action. An account export is a separate feature.

### Implementation

Add scripts such as `scripts/backup-database.mjs` and `scripts/verify-backup.mjs`, documented Compose mounts/configuration and a single non-overlapping scheduler. Use a temporary output name and atomic rename for completed backups. Limit permissions and avoid logging contents or credentials.

Restore verification must open a disposable copy, run `PRAGMA integrity_check`, validate schema/version and compare record counts and invoice payload/ZIP checksums. A real restore requires stopping writes, retaining a backup of the current database and documenting rollback. Never perform a test restore against the live volume.

Reference: [SQLite backup API](https://sqlite.org/backup.html); the existing README already demonstrates Node's backup API.

### Acceptance

- [x] Backup during active test writes produces an internally consistent snapshot.
- [x] Failure/full destination keeps the previous successful backups and records a useful status.
- [x] Retention does not delete unrelated files and concurrent runs cannot corrupt outputs.
- [x] Restore rehearsal into an empty disposable database recovers invoices, versions, payments and settings.
- [x] Backups, credentials and restored data are excluded from source control and Docker build contexts.

## 5. V1 — Preserve invoice versions and delivery history

### Behavior

History gains a Versions panel. Each version shows its number, amount, saved time and associated email delivery information. Download a previous version's retained PDFs without changing the current invoice or its tax contribution.

Editing creates a new version. The existing `invoices` row remains the authoritative current invoice, so existing history and tax queries keep their semantics. Regeneration alone does not create a financial revision. Historical versions do not contribute extra revenue or reserve historical invoice numbers.

### Data and API

Add `invoice_versions` with composite primary key `(invoice_id, revision)`, creation timestamp, origin (`baseline`, `generated`, `edited`), invoice number/date/due date, saved buyer name, payload JSON, calculation version, authoritative total/total cents, and retained ZIP. Tie ownership to the parent invoice and index version lookup. Treat versions as immutable.

Backfill exactly one baseline from each current invoice using its current revision and exact stored bytes. If its revision is already 3, backfill revision 3; do not fabricate revisions 0–2 or claim to recover overwritten files.

Add immutable delivery-attempt history tied to invoice ID and revision, preserving recipient, attempt/result time and status. Existing delivery rows provide only the last known state: import it as a legacy observation rather than pretending it is a complete send history. Continue exposing a current-version summary to existing UI consumers.

Proposed endpoints:

- `GET /invoice/history/:id/versions`
- `GET /invoice/history/:id/versions/:revision`
- `GET /invoice/history/:id/versions/:revision/download`
- `GET /invoice/history/:id/versions/:revision/deliveries/:deliveryId/download` (exact files supplied for the attempt)

Keep the current `PUT /invoice/history/:id` contract. In its transaction, insert the new version, update the current record and save the edit request result together, after rendering has succeeded and revision/number checks have been repeated. For generation, save revision 0 in the same transaction as the original invoice. Return the existing saved result on an idempotent retry.

Sending after regeneration must be traceable to the exact bytes sent. Because regeneration can produce different bytes for the same financial revision, retain the delivery artifact (or a deduplicated reference to it) for that attempt; do not label the original retained ZIP as the exact emailed artifact if it differs.

Deletion still deletes the invoice. Cascade versions and delivery history, extend the existing confirmation accordingly, and release its current number using the established rule. Version history provides recovery from edits, not recovery from an explicitly confirmed permanent deletion.

### Acceptance

- [x] Baseline migration preserves every current payload, authoritative amount, ZIP checksum and revision.
- [x] Editing twice gives three downloadable versions with one current invoice and one tax contribution.
- [x] Rendering/transaction failure leaves both current data and the version list unchanged.
- [x] Lost responses produce no extra revision; stale tabs and another account cannot edit or read versions.
- [x] Previous delivery observations survive editing; UI does not show an old version as newly emailed.
- [x] Renumbering, deletion and SF-number reuse still satisfy the existing tests.

## 6. P1 — Payments, outstanding balances and overdue status

### Behavior

Add Record payment to history. Capture actual receipt date, EUR amount and an optional note/reference; default to today's Vilnius date and the outstanding amount. Support multiple partial receipts, correcting a receipt and deleting a mistaken receipt.

Derive status from recorded payments, never from email delivery:

- No recorded receipts: unpaid once reviewed.
- Some receipts but less than invoice total: partially paid.
- Receipts equal total: paid.
- Receipts above total: paid with an explicit excess amount; do not silently discard the excess.
- Overdue is a separate flag when due date is earlier than today and outstanding is positive. An invoice due today is not yet overdue.

For existing invoices, payment history is unknown. Mark them **Payment status not reviewed** until the owner records a payment or explicitly confirms unpaid. Do not suddenly present old paid invoices as overdue debts. Newly issued invoices start reviewed and unpaid. Zero-total reviewed invoices have nothing outstanding.

Show total billed, recorded receipts and outstanding amounts with clearly stated date scopes. A receipts report uses receipt dates, including receipts for invoices issued in a previous year. A billed report uses invoice issue dates. The tax page continues to use earned dates. Label unreviewed amounts separately and do not include them in a claimed confirmed-overdue total.

### Data and API

Add `invoice_payments(id, invoice_id, received_date, amount_cents, note, revision, created_at, updated_at)` and an invoice-level payment-review flag. Store receipt-creation idempotency records with a canonical request fingerprint so reuse with different data is rejected. Keep a deleted receipt's request outcome as a tombstone until its parent invoice is deleted; a retry must not recreate a receipt the owner deleted.

Use positive integer cents internally, decimal strings at input boundaries, bounded notes, valid calendar dates and safe aggregate limits. Reject future receipt dates for this actual-payments feature. Permit receipts before the invoice issue date. Use optimistic revisions for corrections/deletion.

Proposed endpoints under owned invoice IDs:

- `GET/POST /invoice/history/:id/payments`
- `PUT/DELETE /invoice/history/:id/payments/:paymentId`
- `PUT /invoice/history/:id/payment-review`

Return updated payment summary after each mutation. Calculate outstanding as `max(invoice total − recorded receipts, 0)` and excess as the reverse positive difference. Invoice edits preserve receipts. If an edit lowers the total below recorded receipts, show excess; never modify receipts automatically.

An explicit invoice deletion also removes its receipt records. Extend the existing deletion confirmation with the receipt count/total and the effect on receipt summaries. This retains the owner's chosen permanent-delete workflow.

### Acceptance

- [ ] A €1,000 invoice with receipts of €400 and €600 moves from unpaid to partial to paid.
- [ ] Correcting/deleting a receipt recalculates amounts and status; retries do not create duplicate cash.
- [ ] Editing that invoice to €900 leaves €1,000 received and shows €100 excess.
- [ ] A January receipt for a December invoice appears in January receipts without moving its earned tax income.
- [ ] Existing unreviewed invoices are visibly distinct from confirmed unpaid invoices.
- [ ] Paying an invoice does not change GPM/VSD/PSD estimates or either theoretical take-home average.
- [ ] Server ownership, stale-write, validation, timezone-boundary and deletion behavior are tested.

## 7. D1 — Account-owned draft recovery

### Behavior

Autosave unfinished new invoices after a short debounce (about 700 ms) and restore them after refresh or signing in again. Show Saving, Saved and Retry states. If several drafts exist, show a compact resume list; opening the same draft in another tab must not silently overwrite it.

A draft is not an issued invoice: it has no reserved invoice number, no tax contribution, no PDF and no email. Retain auto/manual numbering mode; refresh an automatic suggestion on resume, preserve a manual number and validate availability on issuance.

Preserve partially entered values, including blank/invalid numeric input text, without treating the draft as a valid invoice. Draft validation should enforce a bounded schema, lengths and item count, while issuance still applies full invoice validation.

### Data and lifecycle

Add `invoice_drafts(id, user_id, revision, payload, state, generation_key, generation_fingerprint, invoice_id, created_at, updated_at)`. Use stable client-created UUIDs or an equivalent idempotent creation key. States: draft, issuing, issued. Distinct tabs may create distinct drafts; conflicts on the same draft require reload or Save as separate draft, never an automatic overwrite.

Endpoints: `GET/POST /api/invoice-drafts`, `GET/PUT/DELETE /api/invoice-drafts/:id`. Updates carry the expected revision. Mutations remain account-owned and no-store responses apply.

Integrate with issuance carefully:

1. Flush the exact draft being submitted and persist its generation request key/fingerprint before rendering. Capture the account/draft epoch so late responses cannot populate another account or a replacement draft.
2. Extend generation with an optional draft ID and expected draft revision. Atomically freeze that draft for issuance alongside the existing number/request reservation. Reject changes while issuance is pending.
3. On successful invoice retention, mark the draft issued and link its invoice ID in the same database transaction. On a known render failure, release the reservation and return it to a retryable draft state.
4. On lost response/reload, resolve the existing generation key. If saved, show the existing invoice outcome; if pending, show progress/retry; never silently issue another copy with a new key. If its linked invoice was subsequently deleted, retain the issued outcome/tombstone and show that it was deleted; do not revive the old request as a draft. Use a nullable invoice reference with an issued-state/request record retained for this purpose.
5. Once issuance is confirmed, create/prepare a fresh draft with the retained input details and next automatic number, preserving the current consecutive-generation workflow. Its identity must be distinct and its creation retry-safe.
6. New invoice resets to a fresh draft with monthly default quantity; explicitly discarding a changed draft requires a clear discard action. On sign-out/account switch, clear local state and cancel queued work. Failed saving must not be presented as saved.

For Release 1, history edits keep the existing explicit Save changes/Cancel editing workflow. Do not mix those edits into new-invoice drafts; offer a navigation warning for unsaved history edits if appropriate. This avoids restoring an obsolete edit over a newer saved revision.

### Acceptance

- [ ] Refresh restores descriptions, quantities, prices, parties, dates and comments, including partially entered numeric text.
- [ ] An older fetch/autosave response cannot overwrite newer typing or another account's data.
- [ ] Two tabs editing the same draft produce a visible conflict with a recovery option.
- [ ] A response lost after committed generation and a subsequent page reload recover exactly one invoice and email request.
- [ ] Consecutive generation remains editable, preserves the prior invoice and uses a fresh request key for the next invoice.
- [ ] Draft creation, discarding and autosaving never reserve numbers or alter tax totals.

## 8. E1 — Background email with revision-aware delivery

### Behavior and data

Generation returns the retained download as soon as rendering/database storage succeed. Show Email queued, Sending, Sent, Failed or Delivery uncertain independently. The browser polls briefly while visible or refreshes status when history reopens; it must not hold the form disabled while SMTP is pending.

Add a durable SQLite outbox with account/invoice/revision reference, exact attachment artifact reference, recipient snapshot, request key, status, attempt count, scheduled time, lease expiry, stable message ID and sanitized error code. Automatic generation/regeneration queues one job per idempotent operation; explicit Email me requests get their own idempotency keys and retain resend cooldowns. Job insertion belongs to the transaction that commits the relevant document/operation outcome. No SMTP work occurs inside a database transaction.

Use one bounded worker initially, claiming jobs in short transactions with leases. Retry known transient pre-delivery failures on a bounded schedule (for example 1, 5 and 30 minutes). Permanent authentication/recipient errors stop with a useful status; raw SMTP messages and secrets are not returned to users.

SMTP does not provide an exactly-once guarantee. A connection loss after acceptance, or a worker crash between acceptance and recording success, can leave delivery uncertain. A stable Message-ID helps tracing but does not guarantee recipient deduplication. Treat ambiguous attempts as uncertain and offer an explicit resend rather than claiming safe automatic duplicate prevention. Expired leases that may have sent must follow this rule.

With SMTP disabled, store/show not configured rather than retrying forever. Editing leaves queued jobs tied to the version/artifact that was requested, not the new mutable invoice payload. Clearly label pending old-version delivery; provide Cancel for jobs not yet sending. A leased/sending job blocks invoice deletion until finished/uncertain; deletion cancels queued jobs and removes associated data according to the confirmation.

### Acceptance

- [ ] Slow/failed SMTP does not delay the PDF response or prevent the next invoice being prepared.
- [ ] Restart recovers queued work; two workers cannot claim the same available job concurrently.
- [ ] Generation replay queues no duplicate job; explicit resend uses the selected current version.
- [ ] Editing before a queued job runs cannot substitute new invoice content into that old request.
- [ ] Crash/ambiguous-acceptance tests produce Delivery uncertain, not a false Sent or endless resend.
- [ ] Tests use a fake SMTP transport; no live client or owner emails are sent during verification.

## 9. T1 — Reusable templates and next-month drafting

### Behavior

Add Save as template and Create from template. Store a name, buyer snapshot, optional seller override, item descriptions/units/rates, configurable default quantities, payment-term days and comment. The current seller preference is the default unless a template explicitly includes an override. Applying a template changes the draft, not the account defaults or old invoices.

Saved-description autocomplete remains available. Templates add rates and other billing defaults; they do not silently replace that existing feature. An extra client-management database is unnecessary in this release: each template can hold its own buyer details.

History gains Create next month's draft. It copies the selected invoice's current details into a new draft, chooses the next service month, and obtains an automatic number only when appropriate to the draft/issuance lifecycle. It does not edit, regenerate or send the source invoice. If the source has no stored service month, require choosing one in the copy dialog rather than guessing from the issue date.

The monthly draft preview shows:

- Service month, invoice issue date and payment due date as separate values.
- Base Monday–Friday count for the selected month, days off, selected non-billable dates and additional billable days.
- Calculated days and the day rate. Recalculate only designated day-based lines; hours, fixed fees and overtime remain separate lines.
- A manual quantity override, visibly preserved until the user chooses Recalculate.

Do not assume Lithuanian or Belgian public holidays apply to the owner's contract. Allow explicit excluded dates and day adjustments; automatic national holiday calendars are deferred. Reject negative final quantities and preserve the shared precision limits. Avoid counting an excluded date twice or subtracting weekends as weekdays.

For a selected whole service month, prefill earned date to that month's final day, display it for review and allow correction. Persist it using the existing tax-metadata mechanism, unreviewed until confirmed. Do not derive payment receipt dates from it. Existing invoices without service-period metadata retain their current earned-date behavior.

### Data and API

Add account-owned, revisioned `billing_templates` with bounded JSON and timestamps, plus GET/POST/PUT/DELETE under `/api/billing-templates`. Template-create requests need idempotent IDs/keys; edits/deletes use expected revisions.

Extend draft and new invoice payload contracts with optional service-month/earned-date metadata. Include accepted metadata in request fingerprints and immutable versions; validation/controller normalization must not silently drop it. Store invoice/tax metadata atomically on generation. Render the chosen service period consistently in both PDFs. Missing optional metadata must preserve legacy rendering and downloads.

Extract a pure selected-month weekday/adjustment helper into shared rules, keeping the existing current-month default behavior for ordinary blank invoices. Do not store draft/template totals as authoritative invoice totals; calculate them with shared rules.

### Acceptance

- [ ] January/February, leap years and December-to-January copying select correct months and weekday counts.
- [ ] Exclusions, partial days and manual overrides behave predictably without modifying unrelated line items.
- [ ] Applying a template or copying an invoice produces an editable draft with no tax contribution/email.
- [ ] A September service month invoiced in October contributes to September after the shown earned-date choice is saved.
- [ ] Changing a template later cannot alter saved invoices, versions or already-created drafts.
- [ ] Template/draft endpoints reject another account's IDs and stale mutations.

## 10. H1 — Search, filters and annual export

History filters: invoice-number/buyer text search, issue-date range, payment status and overdue flag. Add total/count summaries for the complete filtered dataset, not just the first page. Use parameterized queries, bounded search input and stable pagination (current descending invoice ID is suitable). Reset cursors when filters change; late responses for old filters cannot replace the current results.

Extend `GET /invoice/history` with documented optional filters. Return pagination and aggregate summary from the same snapshot or clearly documented consistent result. Prefer derived receipt/status queries or maintained aggregates with transaction tests; do not load every ZIP to calculate a count.

Add `GET /api/taxes/:year/archive` for an annual package containing:

- Existing tax-summary CSV, with its settings, rule version and source records.
- Current EN/LT invoice PDFs for invoices contributing to that earned tax year.
- Separate receipt CSV for payments received during that calendar year, including references to invoices from other earned years.
- A manifest listing invoice ID, current revision, number, issue date, earned date, amount and filenames; explain the two date scopes.

Use safe paths containing ID and revision, so reused invoice numbers cannot overwrite each other. Include current versions by default; historical revisions are available individually through V1 and must not become extra tax rows. Reuse retained files rather than regenerating or emailing them. Export manual income adjustments even though they have no PDFs.

Apply size/time limits with a clear message before exhausting memory. For this small deployment, compute a manifest and selected immutable version IDs in a short snapshot, then build the archive from those versions with deletion coordination. Do not hold an open write transaction across slow file/archive work. Reject unauthorized cross-account references at every stage.

### Acceptance

- [ ] Search/filter pagination and totals include results beyond 50 invoices without duplicates or cross-account results.
- [ ] Paid/partial/overdue/unreviewed filters match P1 semantics.
- [ ] Reused numbers and edited invoices produce distinct, safe archive paths with correct current revisions.
- [ ] Archive CSV and manifest reconcile to the selected snapshot; export creates no invoices, emails or tax changes.
- [ ] Empty years, unsupported-tax years (income only), large exports and edits/deletion during export are handled explicitly.
- [ ] CSV cells retain existing spreadsheet-formula protection and correct quoting.

## 11. F1 — Tax reserve and optional forecast

### Reserve view

Reuse the existing tax estimates and recorded tax-payment ledger. Add a manually entered **currently reserved amount** for each of GPM, VSD and PSD, persisted by account/year with an optimistic revision. These amounts describe money the owner currently has set aside; they are not recorded tax payments and are not added to or deducted from taxable revenue.

For each available category:

- `unpaidEstimate = max(estimated liability − recorded tax payments, 0)`
- `reserveGap = max(unpaidEstimate − currently reserved amount, 0)`
- Show overpayment/excess reserve separately. Do not offset a PSD excess against another tax automatically.

When a tax payment is recorded, recalculate unpaid estimates and remind the owner to update currently reserved amounts if they paid from that reserve. Do not automatically invent a transfer between accounts. Missing tax estimates keep that category and any combined complete-total claim unavailable.

Label this an estimate based on entered records and the selected annual PSD obligations. Do not describe it as money definitely available to spend; bank balances and actual expenses are outside the model.

### Forecast view

Add an explicit forecast panel with one **additional expected revenue** amount for each month, optionally calculated from planned days × day rate. Default all additions to zero. Existing recorded income, including any future-dated records, remains the actual baseline. Warn beside months already containing income that the input is additional, so the same work is not projected twice.

Run the same pure tax calculator on `recorded monthly income + additional projected monthly income`. Present recorded-results and forecast-results separately, with projected revenue, annual tax and net, and calendar-year projected monthly average. Do not change either existing actual-income average or extend its billed-month denominator using forecast data.

Save scenario inputs in a separate account/year table with revision/timestamps. Do not create placeholder invoices or `tax_entries` for projections. Return the tax rule version and actual-data revision used. New real income refreshes the baseline; preserve the scenario but flag it for review to avoid double-counting work now billed.

### Acceptance

- [ ] Zero projection equals the existing actual-data calculation exactly.
- [ ] Forecasting changes no invoices, actual tax records or recorded-only monthly averages.
- [ ] Unpaid liability, reserved money and paid tax remain distinct and no amount is deducted twice.
- [ ] Unsupported years/profiles and incomplete tax categories remain explicitly unavailable.
- [ ] Current 30% allowance treatment, negative corrections, PSD annual minimums and calculator boundary tests stay intact.

## 12. Y1 — Tax-year maintenance

Create a tax-rule registry keyed by year, retaining immutable rule-version identifiers and their official-source references. Move existing 2026 constants/formulas into its 2026 entry without changing results. Route summary, forecast and CSV through the same registry.

Adding another year is a research-and-verification task, not copying 2026 values. Before enabling it, consult official VMI and Sodra guidance for that year, record URLs and verification dates, identify changed bases/rates/thresholds/minimums and obtain expected results from authoritative examples where available. Preserve historical calculations and the supported-profile limitations. Update `docs/yearly-tax-summary-plan.md` with the evidence and tests.

Until that work is complete, income/receipt views continue to work and the new year's tax estimate clearly says unavailable. This roadmap does not assert any 2027 tax rules or deadlines.

## 13. Shared migration, testing and deployment contract

### Migration and integrity

- Take a consistent private backup immediately before deploying a schema change. Verify the backup on a disposable copy first.
- Add forward, transactional migrations to `migrations.ts`. Test both a fresh database and an upgraded copy of the schema that is actually deployed; the plan's baseline is v4.
- Before and after migration, compare account/invoice counts and hashes of existing invoice payloads, totals and ZIPs. Do not print real payloads, emails, credentials or files into tool logs.
- Preserve `invoice_id_counter`, foreign-key behavior, issued-number claims, generation/edit idempotency, tax metadata and the existing account preferences.
- Use a supported money-range policy and exact cent arithmetic for all new aggregates. Do not introduce floating-point currency calculations in a component or CSV exporter.
- Query current invoices for tax contributions; never join versions/payments in a way that multiplies invoice income.

### Verification commands

Run checks relevant to the changed layer, then the release's browser workflow:

```sh
npm run build --prefix backend
npm run lint --prefix backend
npm test --prefix backend -- --runInBand --watchman=false
npm run test:e2e --prefix backend -- --runInBand --watchman=false
npm run build --prefix frontend
npm run lint --prefix frontend
REVIEW_URL=http://127.0.0.1:5173 npm run test:browser --prefix frontend
REVIEW_URL=http://127.0.0.1:5173 npm run test:tax-browser --prefix frontend
```

HTTP/Chromium tests may require permission to run outside the filesystem/network sandbox. Use the available execution approval mechanism; do not weaken tests because a sandbox prevents binding a port. Browser tests must intercept APIs or use a disposable backend and fake SMTP, not mutate real invoice/account data. Expand existing smoke checks around meaningful workflows rather than tests that only mirror component implementation.

At minimum, every new financial mutation needs account-isolation, validation, stale-write, idempotent-retry and transaction-failure coverage where applicable. Test integration between versions, receipts, draft issuance and outbox rather than only isolated CRUD endpoints.

### Deployment

Use the existing local Docker workflow for an implementation task that includes applying changes. Do not deploy when the user asked only for a plan or review. Rebuild changed images and recreate their services; a local Vite build does not update localhost:5173. Keep the database volume, loopback port binding and environment secrets intact. Never use `docker compose down -v`.

The current environment has used `DOCKER_CONFIG=/tmp/invoice-docker-public` to bypass a local keychain problem. Check whether that configuration still exists before relying on it; do not create or modify credentials to reproduce a historical workaround.

After deployment, verify the served build, authenticated routes, schema version and data-integrity comparison. Use disposable browser fixtures. Record any failed check and its disposition rather than claiming a full pass after an unverified retry. Do not send test mail through the owner's Gmail account.

### Handoff after each task

Update `docs/implementation-progress.md`, relevant README/rules and the checklist below. Include files changed, migration number, exact checks/results, deployment state and concrete remaining issues. State whether a feature is implemented, tested and deployed separately. Leave unrelated application data and user changes intact.

## 14. Completion tracker

| Task | Implemented | Verified | Deployed | Evidence / remaining work |
| --- | --- | --- | --- | --- |
| B1 backup/restore | [x] | [x] | [x] | Daily private backups, manifests, restore rehearsal, secondary destination support, protected Settings. Owner-only Settings access configured from the supplied registration email; operator status available. |
| V1 versions/delivery observations | [x] | [x] | [x] | Migration 5, immutable snapshots/events and exact attachment ZIPs, owned Versions UI/API. 61 backend tests, 4 API end-to-end tests, deployed browser workflows and live checksum/migration verification passed. Nine current invoices preserved; earlier overwritten versions are unavailable. |
| P1 payments/status | [ ] | [ ] | [ ] | |
| D1 draft recovery | [ ] | [ ] | [ ] | |
| E1 email outbox | [ ] | [ ] | [ ] | |
| T1 templates/monthly draft | [ ] | [ ] | [ ] | |
| H1 filters/annual archive | [ ] | [ ] | [ ] | |
| F1 reserves/forecast | [ ] | [ ] | [ ] | |
| Y1 tax-year registry | [ ] | [ ] | [ ] | New years require their own evidence and tests. |

Suggested instruction for the next implementing model:

> Read `docs/small-business-implementation-plan.md` and the current implementation files. Implement the next incomplete task in Release 1, preserving all established behaviors in section 1. Complete its migration, UI/API, tests and documentation. If applying it locally is part of the task, rebuild Docker, verify the deployed app and preserve live data. Record concrete results in the tracker and implementation-progress document. Do not claim completion based only on code compilation.
