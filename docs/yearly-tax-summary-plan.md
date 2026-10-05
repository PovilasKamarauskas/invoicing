# Yearly tax summary implementation plan

Status: implemented on 2026-10-04. Verification and deployment details are in `implementation-progress.md`.

Prepared: 2026-10-03.

Reviewed: 2026-10-04 against VMI/Sodra guidance and the current database/history implementation. The specification below records the agreed behavior.

## Goal

Add a yearly tax summary for Lithuanian individual activity under a certificate (`individuali veikla pagal pažymą`). Use the logged-in account's retained invoices and separately entered adjustments to estimate annual GPM, VSD and PSD. Explain the calculation and distinguish annual liability from payments already made.

## Confirmed user profile

| Setting | Agreed value |
| --- | --- |
| Activity | Computer programming |
| Working location | Remotely from Lithuania |
| Main client | Belgian business with a valid Belgian VAT number |
| Current VAT registration | Unregistered; informational profile value only |
| Expense method | 30% of recognized revenue as presumed expenses |
| Additional pension contribution | None |
| PSD | Paid personally each month |
| Income recognition | Accrual: when services are earned, with invoice date as the default service date |

The user wants a theoretical monthly wage after taxes, assuming the presumed 30% expenses are not actually spent. Display `Theoretical take-home = full recognized revenue − GPM − VSD − PSD`. The 30% allowance reduces the tax base but remains within full revenue: do not deduct it as spending or add it to full revenue a second time. Equivalently, `take-home = 30% of revenue + (70% of revenue − taxes)`. Label this an estimate before actual expenses and assuming invoices are paid; accrual revenue can include unpaid invoices.

## Scope and exclusions

- Add a `Yearly taxes` view alongside the existing invoice form and history.
- First release calculates 2026 estimates. Other years may display income totals, but must clearly show that tax calculations are unavailable until their rules are separately verified and implemented.
- Save settings and financial adjustments in SQLite, attached to the authenticated account and tax year.
- Include a monthly breakdown, annual calculation details and CSV export.
- Make theoretical monthly take-home a primary result, including each month's estimate and a clearly labeled calendar-year monthly average and an average through the latest billed/earned month.
- Exclude VAT calculations, VAT registration reminders and VAT declaration guidance, as explicitly requested by the user. This scope decision does not make a determination about VAT obligations.
- Do not change existing invoice VAT comments, invoice generation, email delivery, numbering or history deletion behavior.
- Do not submit declarations or payments to VMI or Sodra.
- Do not implement actual-expense bookkeeping, bank synchronization or a complete personal income-tax return in this release.
- Keep the first version specific to the confirmed 30% expense/no-extra-pension profile. Store these assumptions, but do not offer selectable expense or pension options whose calculations are unsupported. Other accounts must review their own profile; never copy this user's personal answers into their settings as confirmed facts.

## Calculation rules for 2026

Let `R` be recognized annual individual-activity revenue from retained invoices plus signed income adjustments. Let `P = R × 70%` be taxable profit under the 30% expense method.

This assumes eligibility for the 30% method and ordinary Lithuanian individual activity, with no foreign tax credits or loss carryforwards. Activity income received from an employer can make the 30% method unavailable. Record profile applicability once per year; unsupported circumstances produce an incomplete estimate rather than an incorrect alternative calculation. Account for all activity revenue, including income generated outside this tool.

### GPM

- For `0 ≤ P ≤ €20,000`: `GPM = P × 5%`.
- For `€20,000 < P ≤ €42,500`: `GPM = P × 20% − credit`, where `credit = P × (0.15 − (2 / 300000) × (P − 20000))`.
- Above €42,500, the credit does not apply. The general progressive calculation involves relevant other annual income: 20% up to €83,237.40, 25% on the next portion up to €138,729, and 32% above that.
- When activity is the only relevant income and `P > €42,500`, calculate `0.20 × min(P, 83237.40) + 0.25 × min(max(P − 83237.40, 0), 55491.60) + 0.32 × max(P − 138729, 0)`. These are marginal bands, not a single rate applied to all profit.
- The first release must not silently assume the user has no other income. For profit above €42,500, require an explicit confirmation that activity is the only relevant income before producing a standalone estimate. Otherwise show GPM as requiring a broader calculation; VSD and PSD estimates may still be displayed. Explain that activity income can also affect the taxation of other income below this limit.
- Under the 30% expense method, do not deduct VSD/PSD again from `P`.

### VSD

- Contribution base: `90% × P`, before deducting VSD/PSD.
- Standard rate for the confirmed profile: 12.52%.
- Apply the 2026 contribution-base ceiling of €99,422.45.
- Thus `B = min(0.90 × P, 99422.45)` and standard VSD is `12.52% × B` (maximum €12,447.69 after cent rounding). The cap is on the contribution base, not gross revenue or profit.
- Use the standard obligation by default. Identify the estimate as assuming no first-year or other contribution exemption. Do not automatically infer an exemption from registration dates.

### PSD

- Income-based contribution: `6.98% × B`, using the same capped base as VSD. The maximum is €6,939.69 after cent rounding. Do not use the older 2025 ceiling visible in some sections of Sodra's multi-year guidance.
- Required monthly contribution in 2026: €80.48 for each month an obligation applies.
- Collect activity months and any months exempt from the monthly obligation. Prefill the user's profile as paying personally, but require review of the months rather than assuming a full year of activity.
- Reconcile the income-based annual contribution with required monthly minimums according to Sodra's rules. Monthly contributions are payments toward annual PSD, not an additional tax to add on top of it.
- For the supported ordinary profile, annual PSD is the greater of the income-based amount and the sum of applicable monthly minimums. Twelve obligated months give a €965.76 minimum (`12 × €80.48`). Confirm partial-month and coverage-transition treatment against an official rule or calculator before supporting those cases; do not invent daily proration or infer obligations from months containing invoices. Until confirmed, flag those cases as incomplete.
- A monthly-payment exemption must not automatically zero the annual income-based PSD amount. Keep monthly coverage status separate from any exemption from Lithuanian social insurance itself; the latter is outside this first version.
- Keep required payments and recorded payments separate. Do not mark €80.48 as paid merely because it was due.

### Money and presentation

- Read invoice amounts using their saved calculation version and authoritative stored total. Preserve historical invoice values.
- Use integer cents/exact decimal arithmetic for money and avoid premature rounding of effective tax rates. Verify final tax rounding against official examples.
- Show GPM, VSD and PSD separately, their total, recorded payments and remaining estimated balances. Show overpayments separately rather than hiding them behind a zero balance.
- For each tax, `balance = estimated annual liability − recorded payments allocated to that tax year/category`. Do not subtract recorded payments again from revenue after estimated taxes or automatically offset a PSD overpayment against GPM/VSD. Describe a negative balance as an estimated excess of recorded payments, not a confirmed refundable balance from Sodra/VMI.
- If any tax is unavailable, show only the available subtotal with its categories named. Leave the combined tax total and revenue-after-tax figure unavailable; never treat a missing GPM or PSD value as zero.
- Label outputs as estimates based on the entered profile and available records.
- For the current year, label the result an annual estimate from entered records, show the calculation date and any future-dated income, and do not automatically extrapolate revenue. Distinguish planned future PSD minimums from monthly obligations already due. A remaining annual estimate is not an overdue balance.
- Reject invalid dates, unsupported years for calculation, negative aggregate revenue and invalid payment amounts. Signed income adjustments require a date and reason.

### Theoretical monthly wage

This is a budgeting view of annual taxes, not a separate monthly tax assessment. Calculate annual GPM/VSD/PSD first; do not restart GPM bands every month or multiply one month's tax by twelve.

- Show monthly columns for full invoice/adjusted income, the 30% presumed deduction (informational), allocated GPM, allocated VSD, allocated PSD and theoretical take-home.
- Allocate annual GPM and VSD across months in proportion to positive recognized monthly income. For corrections that make a month's revenue negative, use `weight_m = max(revenue_m, 0) / sum(max(revenue_month, 0))`; preserve the negative revenue in the take-home row.
- Allocate required PSD monthly minimums to their corresponding obligated months, then distribute any annual PSD above the summed minimums using the same income weights. This keeps PSD visible even in a month with no income. For zero annual revenue, GPM/VSD and the income-based PSD top-up are zero; only applicable monthly PSD minimums remain.
- `monthly take-home = full monthly revenue − allocated GPM − allocated VSD − allocated PSD`. Do not subtract the 30% deduction or previously recorded tax payments from this result.
- Round allocations to cents with a deterministic remainder distribution so all monthly tax amounts and take-home values sum exactly to their annual totals. Allow negative monthly take-home where income is lower than the allocated obligations.
- Show `Calendar-year monthly average = annual theoretical take-home / 12`, explicitly labeled as a 12-month average. For an unfinished year this is based on entered records, not a forecast of future earnings. Each month's own take-home remains visible separately.
- Explain that monthly allocations can change as more annual income is entered. Hide complete take-home results when any required annual tax estimate is unavailable.
- Include these monthly allocations and assumptions in the backend result and CSV export, using the same calculation snapshot as the annual summary.

## Income records and history behavior

- Each retained invoice contributes exactly once. Regeneration, re-download and email resend do not create additional income.
- Default the income recognition date to the saved invoice date. Allow a separate service/earned date when the invoice was created in a different period from the work.
- Existing invoices default to their saved invoice dates and must not be marked as reviewed automatically. Show how many still need a recognition-date review.
- Keep this review nonblocking: allow estimates immediately using invoice dates and provide one bulk confirmation action after reviewing the list. Show a compact completeness note rather than requiring a click for every historical invoice.
- Support signed, dated manual income adjustments for invoices generated elsewhere and corrections, with a required explanatory note.
- Keep history deletion as it is today: deleting an invoice removes it from summaries based on retained history. Explain this in the tax view and deletion confirmation so the user understands that the remaining history may be incomplete.
- Previously deleted invoices cannot be reconstructed from retained history. The user can restore their income through a manual adjustment.
- Do not change number reuse or introduce hidden retained tax copies of deleted invoices in this release.
- Invoice payment tracking is not required for this accrual-only first version. Tax-payment tracking is required to show remaining liabilities.
- Scope the first version to EUR, matching current invoices. Do not silently mix currencies. Corrections affecting a prior tax year belong to that year rather than the correction-entry timestamp.

## Data and backend design

Add versioned migrations for:

- `tax_year_settings`: unique account/year, expense method, pension setting, activity-month information, monthly PSD exemptions, other-income confirmation and reviewed profile assumptions.
- `invoice_tax_metadata`: account-owned invoice reference, earned date and review status. Use a foreign key so metadata follows the current invoice deletion behavior.
- `tax_entries`: income adjustments and payments share a table, distinguished by the constrained category (`income`, `GPM`, `VSD`, `PSD`). Each has an account, covered year, date, signed income amount or positive payment amount in cents, note/reason, timestamps and unique request key. Income dates must belong to their covered year; payment dates may be in another year.

Settings must distinguish unknown values from confirmed zero/none. Add created/updated timestamps and validation constraints to editable records. Support editing/deleting adjustments and payment entries, and guard creation against duplicate submission/retries. Combined Sodra payments must be allocated between VSD and PSD according to the user's records; do not guess an allocation from the transfer amount.

Keep original invoice payloads and ZIP attachments unchanged. Use the existing account/session authentication for every endpoint, mutation and export. Derive the account ID from the authenticated session, never from a client-supplied owner ID.

Create a deterministic backend calculation module with an explicit rules version. The frontend renders its results rather than implementing a second tax formula. Return calculation inputs, rule year/version, completeness status and individual tax breakdowns.

Annual aggregation must query all owned invoices by effective earned date (`metadata.earned_date` falling back to `invoice_date`). The existing history endpoint returns only 50 displayed entries per page and is not the source for annual totals. Do not filter by invoice creation timestamp, regeneration timestamp or invoice number; deleted numbers can be reused by different invoice IDs. Query amounts without loading ZIP BLOBs.

Use `total_cents` for newer invoices. For legacy rows where it is null, convert the original saved total to its existing displayed EUR-cent amount using a documented, tested conversion. Do not recompute legacy line items using the new rounding rules or mutate stored historical totals.

Return summary and breakdown from a consistent database snapshot, including data/rules revision information in exports. Refresh after invoice generation/deletion, earned-date changes, adjustments, settings or payment changes, and when returning to the tax view. Clear cached tax data when the account changes. CSV text cells must be escaped and spreadsheet-formula injection neutralized.

## Page layout

1. Year selector and compact profile/settings panel.
2. Summary cards: full recognized revenue, estimated taxes, annual theoretical take-home and calendar-year average monthly take-home. Keep presumed expenses and taxable profit in the calculation breakdown.
3. Monthly table showing income, invoice count, allocated taxes and theoretical take-home. Display the 30% allowance as an informational tax deduction, not money spent. Do not present monthly GPM as final liability because the calculation is annual.
4. GPM/VSD/PSD breakdown showing base, credit/rate/cap, annual liability, recorded payments and remaining balance.
5. Income adjustments, earned-date review and tax-payment entry controls.
6. CSV export containing the year, profile assumptions, invoice contributions, adjustments, payments and calculation breakdown.

Support loading, empty, incomplete-profile and error states. Do not display missing tax inputs as zero or unsupported calculations as successful estimates.

## Implementation sequence

1. Verify rule fixtures, PSD minimum/cap reconciliation and final rounding; document the exact calculation assumptions. Resolve GPM declaration rounding separately from cent-based estimates, and verify partial-month PSD cases before enabling them. Do not copy a 2026 filing deadline for 2025 income into the 2026 tax-year view; deadline reminders are outside this release.
2. Back up SQLite and add migrations. Validate migration on a disposable restored copy and confirm existing invoice data is unchanged.
3. Implement authenticated settings, earned-date metadata, income adjustments, payments and annual summary endpoints.
4. Implement the deterministic 2026 calculator and meaningful regression tests.
5. Build the page and CSV export using the existing UI conventions.
6. Verify the complete flow in a disposable test account with email delivery disabled or mocked.
7. Run appropriate backend tests and frontend/backend builds and lint. Rebuild Docker and verify the page at localhost:5173.

## Acceptance checks

- GPM boundaries: €20,000 and €42,500 profit, including values immediately below and above.
- Progressive GPM boundaries at €83,237.40 and €138,729; other-income state unknown/present must not produce an unsupported complete total above the credit range.
- Official example: €30,000 taxable profit produces €3,500 GPM in 2026.
- End-to-end profile example: €30,000 recognized revenue gives €9,000 presumed expenses, €21,000 profit, €18,900 social-contribution base, €1,190 GPM, €2,366.28 VSD and €1,319.22 income-based PSD, assuming standard obligations and no other relevant income. Annual total: €4,875.50 before subtracting recorded tax payments.
- The same example produces €25,124.50 annual theoretical take-home and a €2,093.71 calendar-year monthly average. The €9,000 deduction is retained within revenue, not subtracted as spending and not added twice.
- Monthly allocations sum exactly to annual tax/take-home totals, including uneven income, zero-income months, negative monthly corrections and cent remainders. Recording a tax payment changes the outstanding balance but does not change theoretical take-home.
- PSD minimum for low/zero income, partial-year activity, exempt months, recorded monthly payments and overpayments.
- Full-year, zero-revenue standard profile: VSD/GPM €0 and PSD minimum €965.76. In the €30,000 revenue example, twelve recorded €80.48 PSD payments leave €353.46 estimated PSD outstanding, not another €1,319.22 to pay.
- VSD/PSD contribution ceilings and unsupported rule years.
- Invoice dated January for services earned in December contributes to the prior service year.
- More than 50 invoices, reused invoice numbers with distinct IDs, legacy null `total_cents`, current-year future dates and changing a service date between years.
- Regeneration and downloads leave revenue unchanged; deletion and adjustments behave as documented.
- Settings, records and exports cannot be accessed by another account.
- Duplicate payment/adjustment submissions do not double count; payment dates in the following year can still cover the selected tax year; combined transfers are not silently misallocated.
- Existing history, saved invoices, numbering, email delivery and working-day defaults continue to behave as before.
- Page totals, API results and CSV values agree; no existing income is silently marked as verified.

## Official references

- [VMI: 2026 GPM rates and individual-activity credit](https://www.vmi.lt/evmi/5725).
- [VMI: allowed deductions and 30% expense method](https://www.vmi.lt/evmi/leid%C5%BEiami-/-neleid%C5%BEiami-atskaitymai1).
- [VMI: GPM commentary, Article 18, expense alternatives and social contribution deductions](https://www.vmi.lt/evmi/documents/20142/391224/GPM%2Baktualus%2Bkomentaras%2B%28aktuali%2Bredakcija%2B2026-06-22%29%2B.pdf/541c2138-7e9c-3e99-33bf-fc547c5cdc28?t=1782133552770).
- [Sodra: individual-activity VSD/PSD rates, payment rules and exemptions](https://sodra.lt/imokos/vykdau-individualia-veikla).
- [VMI: individual-activity guide, sections 3.1, 11 and 12 on recognition, contribution bases and PSD](https://www.vmi.lt/evmi/documents/20142/391098/KM1778%2Bleidinys%2Bindividualios%2Bveiklos%2Bpagal%2Bpa%C5%BEym%C4%85%2Bypatumai.pdf/968b944a-689a-ff44-bec0-625574837d52?t=1780999921610).
- [VMI: income recognition under cash and accrual accounting](https://www.vmi.lt/evmi/kada-laikoma-kad-j%C5%ABs-gavote-individualios-veiklos-pajam%C5%B3-).

Recheck the applicable official rules before implementation and when adding another tax year. Keep tax-year constants versioned; do not overwrite historical calculations with a newer year's rates.

## First-release limits retained deliberately

- Partial-month/coverage-transition PSD remains unavailable; the page asks the user to identify those cases rather than inventing proration.
- Calculation outputs are exact-decimal, cent-based budgeting estimates. Whole-euro declaration rounding is not represented as an official return calculation.
- The supported profile is fixed at 30% expenses and no extra pension. No controls offer unsupported alternative calculations.
- No live account is pre-confirmed from this conversation. Each account reviews the supported profile and monthly PSD obligations before a complete estimate is displayed.

### Implemented follow-up: billed-period average and history editing

Keep the calendar-year average (net ÷ 12). Also display the same theoretical net divided by the latest earned month number, counting January through that month, including gaps: September means 9 months. Positive external income adjustments extend this period; tax payments and negative corrections do not. With no billed income the second average is unavailable. Both use the same annual tax estimate, including selected annual PSD minimums, and are included in CSV export.

History editing updates the existing invoice record, exact cent totals and retained English/Lithuanian PDF ZIP atomically after successful rendering. Its income contribution updates automatically; explicitly reviewed earned dates remain unchanged. Editing does not automatically email. Stale edits and conflicting/reserved invoice numbers are rejected; idempotent retries return the saved files. Legacy invoices use current cent rounding only upon an explicit edit.
