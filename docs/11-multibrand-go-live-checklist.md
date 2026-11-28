# Multi-brand go-live checklist

Prepared 28 Nov 2026 for branch `feat/multibrand-p5` (21 commits ahead of `main`, local only). Nothing here has been pushed, migrated on live or deployed. Each step waits for the owner's go-ahead.

**In short:** eight database migrations go on live first, in order, after a backup that has been restored and checked. Then the code is deployed, the masters are set, opening stock is reconciled, and the open period is re-posted. A rollback is safe only with the prepared rollback build, never plain `main`, once a single brand transfer exists.

## 1. Before the day

- [ ] Owner approves the push and PR. Brand-wise moving average costing is still conditionally approved: get the CA's confirmation first, or go live knowing it may change.
- [ ] Rebase `feat/multibrand-p5` on the latest `origin/main`. Other open branches touch the same files (`challan.routes.ts`, `inventory.routes.ts`, `schema.prisma`). A migration dated between 20261128160000 and 20261130100000 on another branch must be checked against these migrations, or renamed to sort after them.
- [ ] On the demo, after the rebase, run all of these and expect zero failures:
  - the full regression (`regress-all.sh`: every `tools/check-*.ts` plus the e2e sales walk);
  - the seven e2e API suites (`node e2e/api/run-all.mjs`);
  - the acceptance walk (`tools/uat-multibrand.ts`).
- [ ] Agree a quiet window. Nobody enters documents on live from the backup until the smoke test ends.

**Results on 28 Nov 2026**

| Area | Result |
| --- | --- |
| Regression (every check) | clean; e2e sales walk 225/225 |
| E2E API suites | 7 of 7 pass (425 + 11 checks) |
| Acceptance walk (three brands) | 28/28 |
| Phase 7 check | 36/36 |
| Demo integrity snapshot | 0 problems |
| Stock Reconciliation | 0 findings |

## 2. Backup, and proof that it restores

1. Take the backup, read-only, from `apps/api`:
   `node --env-file=<live settings> ../../node_modules/tsx/dist/cli.mjs ../../tools/backup-db.ts "<Desktop>/LD ERP Backups/live-<date>.json"`
2. Take the reconciliation snapshot of live straight after, read-only:
   `tools/reconcile-snapshot.ts take live-before.json`
3. Also take a backup in Supabase itself (dashboard → Database → Backups), if the plan allows a manual one.
4. Prove the JSON restores:
   - Make a local scratch database named `lderp_restore_<date>` on the demo server.
   - Run `prisma migrate deploy` against it, so it matches live's migrations.
   - Run `tools/restore-db.ts live-<date>.json` against it. It refuses any other host or database name.
   - Snapshot the copy and compare it with `live-before.json`.
5. **Pass condition:** "No differences in stock, books, counts, holds, tags, lots, batches or stock history", and every table holds the backup's rows.

Proven on the demo on 28 Nov 2026: 182 tables and 20,719 rows restored, with no differences.

## 3. The eight migrations, in this order

Every migration only adds. None drops or renames a table, column or row.

| # | Migration | What it adds |
| --- | --- | --- |
| 1 | 20261128160000_line_grades | Grade on document lines |
| 2 | 20261128180000_in_transit_transfers | Transfers in transit; their receipts |
| 3 | 20261128200000_accounting_dimensions | Department beside brand on voucher lines |
| 4 | 20261129100000_departments_required_expense_allocation | Expense allocation rules and runs |
| 5 | 20261129120000_brand_stock_shares | Brand shares of stock, reallocations; adds `EARMARKED` to two existing types |
| 6 | 20261129130000_reallocation_type_return_share | Adds `REALLOCATION` to the stock movement type |
| 7 | 20261129140000_brand_documents_material_extras | Brand on GRN, opening, FG receipt, challan lines, cartons; extra material |
| 8 | 20261130100000_voucher_revisions_period_events | Voucher revisions, books-date events, reversal link; the database's no-delete rules |

1. Read-only pre-checks on live:
   - `SELECT COUNT(*) FROM ld_erp.acc_allocation_run_sources s LEFT JOIN ld_erp.acc_vouchers v ON v.id = s."voucherId" WHERE v.id IS NULL` must be 0. Migration 8 adds that foreign key.
   - No session sets `ld_erp.allow_books_delete`. Only the test tools ever set it, inside transactions they roll back.
2. Run `prisma migrate status` against live. Confirm the target is the Supabase `ld_erp` schema and that exactly these eight are pending.
3. Run `prisma migrate deploy`. Never `migrate dev`, a reset or `db push`, and never give the live address as a shadow database.
4. Run `migrate status` again (up to date), then snapshot live and compare with `live-before.json`. No differences are expected, because the migrations only add.

## 4. Deploy the code

- [ ] Squash-merge the PR.
- [ ] Vercel builds the web app. Confirm the deployment is READY.
- [ ] Render builds the API. Watch the build log: the build after #72 once failed on a shared-package import.
- [ ] Confirm read-only: the web bundle carries a new string (for example "Reopen closed periods"), and `/health` shows a fresh uptime.

## 5. Masters on live

- [ ] Open Accounts once, so each own brand (LD Cotton Mills, Stich Code, VHAGAR) has its profit centre.
- [ ] Settings → People: give **Override Sales Charge GST** only to the named sales people. Give **Reopen closed periods** only to the accountant and the MD. Neither comes with Sales-wide or Accounts-wide access; each must be ticked.
- [ ] Every expense ledger has a usual department.
- [ ] Expense allocation rules for the shared expenses, with percentages agreed with the CA.
- [ ] Extra charges: 10 of 15 charge types still await tax review with the CA.
- [ ] Books: set the real start date and import the opening balances, both still pending on live. The start is now set only in Accounts → Chart of Accounts → Books, with a reason once set. Settings → Company shows it read-only.
- [ ] Customers' brands as profit centres: decide with the Cleanup Impact Report (item 2) before re-posting.

## 6. Opening stock reconciliation

- [ ] Opening stock is entered or imported. Brand-specific opening stock goes in centrally and is then earmarked to its brand, approved by a second person.
- [ ] Stock Reconciliation: 0 findings. Every typed stock-out has had its labels window done.
- [ ] The Inventory Matrix's totals equal the stock summary, and brand plus central equals the company.
- [ ] Integrity snapshot: 0 problems.
- [ ] The books' stock value agrees with inventory's on the start date (Accounts → stock value), or the difference is explained.

## 7. Re-posting the open period

1. Note the trial balance totals.
2. Accounts → Day Book: bring pending documents in, then post the open period again. Document vouchers then follow the new rules (brand on purchase bills, departments).
3. Every rewrite keeps a revision, with source "posted again from the Day Book". The voucher view shows each one as it was.
4. Closed periods are not touched; a closed voucher keeps its wording.
5. The trial balance totals must be unchanged. Only the brand and department split may move.

## 8. Rollback

**Proven 28 Nov 2026 on a restored copy of the demo, which held brand transfers:**
- Plain `main` (#88) fails on the stock ledger with "Value 'REALLOCATION' not found in enum 'TransactionType'".
- The rollback build answered every probed screen with 200: stock ledger, stock summary, items, invoices, orders, POs, Day Book, trial balance, stickers.

| Situation | What to do |
| --- | --- |
| Before the migrations | Nothing to undo. |
| Migrations on, old code still running | Leave the migrations; they only add, and the old code ignores them. |
| New code live, problem found, no brand transfer yet | Plain `main` is safe only if these three counts are all 0: `stock_ledger` rows with type `REALLOCATION`; package moves `EARMARKED`; garment events `EARMARKED`. |
| Any brand transfer already posted | Deploy the **rollback build**: branch `rollback/compat-schema`, worktree `LD ERP Rollback`, local. It is `main`'s code on the multi-brand schema. |
| Data damaged | Restore is a Supabase-level operation, owner approval only. Restore into a new database first and compare snapshots. `restore-db.ts` writes only to local scratch databases. |

**While the rollback build runs:**
- Brand shares are not respected; stock totals stay right.
- Nothing writes voucher revisions.
- The database refuses voucher deletes, so do not move the books' start forward.
- Never run a migration from it, and never drop the new tables or columns.

**Rolling forward again:**
1. Run Stock Reconciliation.
2. Where central stock went below zero while a brand still held stock, release that brand stock to central with approved RELEASE documents.
3. Post the open period again.
4. Snapshot, and expect 0 integrity problems.

## 9. Sign-off

- [ ] Owner, after a walk on localhost:3307 (demo) using the acceptance walk's documents:
  - purchases PO-2627-0075 and PO-2627-0076, with return PRC-0017;
  - transfer STN-2627-0296;
  - orders SO-2627-0122 to 0124, MO-2627-0066, FGR-2627-0040;
  - brand transfers SRA-2627-0055 and 0056;
  - challans DC-2627-0102 to 0104;
  - invoices INV-2627-0039 to 0041, credit note CN-2627-0017;
  - September's PV-2627-0010 and 0011, ALC-2627-0003.
- [ ] CA, for brand-wise moving average and the charge tax review.
- [ ] Every step above ticked, with the before and after snapshots kept with the backup.
