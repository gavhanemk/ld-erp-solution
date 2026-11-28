# Multi-brand go-live checklist

Final version, 28 Nov 2026, for branch `feat/multibrand-p5` (all eight phases done and approved on the demo). The branch is pushed for review as a draft pull request. Nothing has been merged, migrated on live or deployed. Each step below waits for the owner's go-ahead.

**In short:**
- Take a backup of live and prove it restores.
- Then put the database migrations on live, in name order, deploy the code, set the masters, reconcile opening stock and re-post the open period.
- Rollback is safe only with the prepared rollback build, never plain `main`, once a single brand transfer exists. Rolling forward again has a proven repair.
- No test data, demo login or password goes near live.
- No field, table or history is removed in this release.

## 1. Before the day

- [ ] The owner approves the merge.
- [ ] The CA confirms two things, or the owner accepts going live knowing either may change:
  - brand-wise moving average costing (conditionally approved);
  - the GST treatment of extra charges (10 of 15 charge types await review).
- [ ] If `main` has moved, rebase on the latest `origin/main`, then rerun the three test runs below on the demo. Expect zero failures:
  - the full regression: every `tools/check-*.ts`, plus the e2e sales walk;
  - the seven e2e API suites: `node e2e/api/run-all.mjs`;
  - the acceptance walk: `tools/uat-multibrand.ts`.
- [ ] Two other branches go out in the same window: `feat/sales-print-sizes` and `feat/challan-job-format`. They have been tested together with this one (see "Tested together" below). Merge order does not matter, because `migrate deploy` applies whatever is pending in name order.
- [ ] Agree a quiet window. From the backup until the smoke test ends, nobody enters documents on live.

**Results on 28 Nov 2026**

| Area | Result |
| --- | --- |
| This branch: every check | clean; e2e sales walk 225/225 |
| This branch: e2e API suites | 7 of 7, 436 checks |
| Acceptance walk, three brands | 28/28 |
| Phase 7 controls | 36/36 |
| Tested together with the two other branches | 64 of 65 checks pass, 0 failures; the 65th (FIFO), whose guard admits only the shared demo, passed 30/30 from a temporary copy allowed onto the test database; e2e 7 of 7, 436 checks |
| Rollback build | reads and writes proven; roll-forward repair proven (section 9) |
| Demo integrity snapshot / Stock Reconciliation | 0 problems / 0 findings |

**Tested together.** The three branches were merged on a local test branch, `integration/release-20261128` (worktree `LD ERP Integration`, never pushed). They were tested on a separate copy of the demo.

| Branch | Its migrations | Where it overlaps this branch | Resolved |
| --- | --- | --- | --- |
| `feat/sales-print-sizes` | `20261129190500_quotation_line_sizes`, `20261129203000_invoice_old_erp_fields` | stock-transfer print; invoice dialog; quotation dialog | their layout and fields, plus this branch's in-transit lines ("Goes", status, "On arrival" note) and style groups |
| `feat/challan-job-format` (up to e0b7b056) | `20261130150000_job_challan_rolls`, `20261130170000_dispatch_packing` | challan routes (dispatch redesigned), roll stickers, the access list | two conflicts, both import or list lines: Brand Stock kept beside "Job Work Out", and the brand-stock dispatch kept beside the new fabric trace. A challan still sends the order's brand share first and puts the moves back when cancelled. The Sales challan prints "DELIVERY CHALLAN" and the job-worker's "JOB WORK CHALLAN"; the challan window counts loose pieces and those on other drafts. |

## 2. Test data stays off live

- [ ] **Credentials.** Demo logins and passwords live only in files outside the repository. The repository holds no password, token or live address. Checked on this branch's 18,372 added lines: the only database address is the local demo's.
- [ ] **Tools.**
  - Every check, test and acceptance tool refuses to run unless the database is the demo (`lderp_demo`). Three older checks and the test-orders helper gained that guard on 28 Nov.
  - `restore-db.ts` writes only to local databases named `lderp_restore_…`.
  - `backup-db.ts` only reads.
  - Never point a check, e2e suite, acceptance walk or seed at live.
- [ ] **Migrations.** All of them add structure only. None inserts a row, and none names test data.
- [ ] **Read-only check on live,** before the migrations and again after the smoke test. Every count must be 0:

```sql
SELECT 'users' AS what, COUNT(*) FROM ld_erp.users WHERE email ILIKE 'zztest%'
UNION ALL SELECT 'roles', COUNT(*) FROM ld_erp.roles WHERE name ILIKE 'ZZTEST%'
UNION ALL SELECT 'customers', COUNT(*) FROM ld_erp.customers WHERE name ILIKE 'ZZTEST%'
UNION ALL SELECT 'suppliers', COUNT(*) FROM ld_erp.suppliers WHERE name ILIKE 'ZZTEST%'
UNION ALL SELECT 'items', COUNT(*) FROM ld_erp.items WHERE name ILIKE 'ZZTEST%'
UNION ALL SELECT 'brands', COUNT(*) FROM ld_erp.brands WHERE name ILIKE 'ZZTEST%'
UNION ALL SELECT 'stores', COUNT(*) FROM ld_erp.warehouses WHERE name ILIKE 'ZZTEST%';
```

## 3. Backup, and proof that it restores

1. Take the backup, read-only, from `apps/api`:
   `node --env-file=<live settings> ../../node_modules/tsx/dist/cli.mjs ../../tools/backup-db.ts "<Desktop>/LD ERP Backups/live-<date>.json"`
   The backup also carries the three code counters: sticker, garment tag and carton numbers. Without them, a restored database would hand out codes that already exist.
2. Straight after, take the reconciliation snapshot of live, also read-only: `tools/reconcile-snapshot.ts take live-before.json`.
3. Also take a backup in Supabase itself (dashboard → Database → Backups), if the plan allows a manual one.
4. Prove the JSON restores:
   - make a local scratch database named `lderp_restore_<date>` on the demo server;
   - run `prisma migrate deploy` against it, so it matches live's migrations;
   - run `tools/restore-db.ts live-<date>.json` against it (it refuses any other host or database name);
   - snapshot the copy and compare it with `live-before.json`.
5. **Pass condition:** "No differences in stock, books, counts, holds, tags, lots, batches or stock history". Every table holds the backup's rows, and the three counters equal the backup's.

Proven on the demo on 28 Nov 2026: 182 tables and 20,719 rows restored with no differences, counters included.

## 4. The migrations

This branch's eight migrations only add: none drops or renames a table, column or row. Each other branch's migrations are pending too, if it has merged and they are not yet on live. One of those, the job-work challan's `20261130170000_dispatch_packing`, drops a table (see the note under the table):

| # | Migration | From | What it adds |
| --- | --- | --- | --- |
| 1 | 20261128160000_line_grades | this branch | Grade on document lines |
| 2 | 20261128180000_in_transit_transfers | this branch | Transfers in transit; their receipts |
| 3 | 20261128200000_accounting_dimensions | this branch | Department beside brand on voucher lines |
| 4 | 20261129100000_departments_required_expense_allocation | this branch | Expense allocation rules and runs |
| 5 | 20261129120000_brand_stock_shares | this branch | Brand shares of stock, reallocations; `EARMARKED` on two existing types |
| 6 | 20261129130000_reallocation_type_return_share | this branch | `REALLOCATION` on the stock movement type |
| 7 | 20261129140000_brand_documents_material_extras | this branch | Brand on GRN, opening, FG receipt, challan lines, cartons; extra material |
| – | 20261129190500_quotation_line_sizes | sales print sizes | Sizes on quotation lines |
| – | 20261129203000_invoice_old_erp_fields | sales print sizes | The old ERP's invoice fields |
| 8 | 20261130100000_voucher_revisions_period_events | this branch | Voucher revisions, books-date events, reversal link; the database's no-delete rules |
| – | 20261130150000_job_challan_rolls | job-work challan | Rolls on customer GRNs and challans |
| – | 20261130170000_dispatch_packing | job-work challan | Bale numbers, packing list reference and gross weight on challans; **drops `delivery_challan_rolls`** |

All twelve were applied together, in this order, on the test copy. `migrate deploy` applies older-named pending migrations without complaint.

- [ ] **The one drop: owner's OK needed.** `20261130170000_dispatch_packing` drops `delivery_challan_rolls`, which `20261130150000` creates in the same release. On live it is therefore created and dropped empty, so no data is lost. It is still the release's only destructive statement, and destructive changes were deferred until separately approved. If the drop is not approved, the job-work challan branch must keep the table, or `20261130150000` must stop creating it before either reaches live.

1. Read-only pre-checks on live:
   - `SELECT COUNT(*) FROM ld_erp.acc_allocation_run_sources s LEFT JOIN ld_erp.acc_vouchers v ON v.id = s."voucherId" WHERE v.id IS NULL` must be 0, because migration 8 adds that foreign key.
   - No session sets `ld_erp.allow_books_delete`. Only the test tools set it, inside transactions they roll back.
2. Run `prisma migrate status` against live. Confirm the target is the Supabase `ld_erp` schema, and that exactly the expected migrations are pending.
3. Run `prisma migrate deploy`. Never run `migrate dev`, a reset or `db push`, and never give the live address as a shadow database.
4. Run `migrate status` again and expect "up to date". Then snapshot live and compare with `live-before.json`. Expect no differences, because the migrations only add.

## 5. Deploy the code

- [ ] Squash-merge the PR.
- [ ] Vercel builds the web app. Confirm the deployment is READY.
- [ ] Render builds the API. Watch the build log: the build after #72 once failed on a shared-package import.
- [ ] Confirm, read-only, that the web bundle carries a new string (for example "Reopen closed periods") and that `/health` shows a fresh uptime.

## 6. Masters on live

- [ ] Open Accounts once, so each own brand (LD Cotton Mills, Stich Code, VHAGAR) gets its profit centre.
- [ ] In Settings → People, tick these rights for named people only. Neither comes with Sales-wide or Accounts-wide access:
  - **Override Sales Charge GST:** the named sales people;
  - **Reopen closed periods:** the accountant and the MD.
- [ ] Brand transfers: store keepers may raise them (Inventory: create). The store manager approves them (Inventory: approve). Nobody approves their own.
- [ ] Every expense ledger has a usual department.
- [ ] Expense allocation rules cover the shared expenses, with percentages agreed with the CA.
- [ ] Extra charges: the 10 charge types awaiting tax review are settled with the CA.
- [ ] Books: set the real start date and import the opening balances; both are still pending on live. The start date is set only in Accounts → Chart of Accounts → Books, with a reason once set. Settings → Company shows it read-only.
- [ ] Customers' brands as profit centres: decide with the Cleanup Impact Report (item 2) before re-posting.

## 7. Opening stock reconciliation

- [ ] Opening stock is entered or imported. Brand-specific opening stock goes in centrally and is then earmarked to its brand, approved by a second person.
- [ ] Stock Reconciliation shows 0 findings, and every typed stock-out has had its labels window done.
- [ ] The Inventory Matrix's totals equal the stock summary, and brand plus central equals the company.
- [ ] The integrity snapshot shows 0 problems.
- [ ] The books' stock value agrees with inventory's on the start date (Accounts → stock value), or the difference is explained.

## 8. Re-posting the open period

1. Note the trial balance totals.
2. In Accounts → Day Book, bring pending documents in, then post the open period again. Document vouchers then follow the new rules: brand on purchase bills, departments.
3. Every rewrite keeps a revision, with source "posted again from the Day Book". The voucher view shows each one as it was.
4. Closed periods are not touched, and a closed voucher keeps its wording.
5. The trial balance totals must be unchanged. Only the brand and department split may move.

## 9. Rollback, and rolling forward again

**Proven on 28 Nov 2026, on a restored copy of the demo that held brand transfers:**

- **Plain `main` (#88)** fails on the stock ledger with "Value 'REALLOCATION' not found in enum 'TransactionType'".
- **Reading.** The rollback build answered every probed screen with 200: stock ledger, stock summary, items, invoices, orders, POs, Day Book, trial balance, stickers.
- **Writing.** Through the rollback build:
  - an order, challan and invoice took 7 plain shirts where central stock held 6 and Stich Code 1 (SO-2627-0166, DC-2627-0128, INV-2627-0055);
  - a Stich Code purchase order was received: PO-2627-0087, GRN-2627-0059, 10 m of fabric;
  - a payment was typed (PV-2627-0013).

  Everything saved. Company stock stayed right (the shirt's balance came to 0), the books balanced, and the integrity snapshot was clear. Only the brand split drifted: the shirt showed central −1 and Stich Code +1, and the brand's fabric landed in central.

| Situation | What to do |
| --- | --- |
| Before the migrations | Nothing to undo. |
| Migrations on, old code still running | Leave the migrations. They only add, and the old code ignores them. |
| New code live, a problem found, no brand transfer yet | Plain `main` is safe only if all three counts are 0: `stock_ledger` rows of type `REALLOCATION`; package moves `EARMARKED`; garment events `EARMARKED`. |
| Any brand transfer already posted | Deploy the **rollback build**: branch `rollback/compat-schema` (local, 82b5614d), worktree `LD ERP Rollback`. It is `main`'s code on the multi-brand schema. Note the time it goes live. |
| Data damaged | A restore is a Supabase-level operation, with owner approval only. Restore into a new database first and compare snapshots. `restore-db.ts` writes only to local scratch databases. |

**While the rollback build runs:**
- Brand shares are not respected, but stock totals stay right.
- Nothing writes voucher revisions.
- The database refuses voucher deletes, so do not move the books' start date forward.
- Never run a migration from the rollback build, and never drop the new tables or columns.

**Rolling forward again.** Proven on the same copy, from the moment the release code was back:

1. Deploy the release code and run Stock Reconciliation.
2. For each "below zero" finding on central stock, look at the same item and store: does one of the brands hold the same amount? If so, the rollback build sold or issued that brand's stock.
   - Do not "correct it with a count", whatever the finding's advice says; that would invent stock.
   - Instead, in Inventory → Brand Stock, raise a **RELEASE** from that brand to central for the amount central is short. A second person approves it.
3. Purchases received during the rollback against a brand's order went into central. List them read-only. Use the rollback build's start time in UTC (IST minus 5:30). The time matters, because receipts made before multi-brand also have no share:

```sql
SELECT g."grnNumber", p."poNumber", i.code AS item, gl."acceptedQty" AS qty, w.name AS store,
       COALESCE(bp.name, bm.name, bs.name) AS brand_it_was_for
FROM ld_erp.grn_lines gl
JOIN ld_erp.grn g ON g.id = gl."grnId"
JOIN ld_erp.purchase_order_lines pl ON pl.id = gl."poLineId"
JOIN ld_erp.purchase_orders p ON p.id = pl."poId"
JOIN ld_erp.items i ON i.id = gl."itemId"
JOIN ld_erp.warehouses w ON w.id = gl."warehouseId"
LEFT JOIN ld_erp.brands bp ON bp.id = p."brandId" AND bp.type <> 'CUSTOM'
LEFT JOIN ld_erp.material_requisition_lines ml ON ml.id = pl."mrLineId"
LEFT JOIN ld_erp.material_requisitions mr ON mr.id = ml."mrId"
LEFT JOIN ld_erp.manufacturing_orders mo ON mo.id = mr."moId"
LEFT JOIN ld_erp.brands bm ON bm.id = mo."brandId" AND bm.type <> 'CUSTOM'
LEFT JOIN ld_erp.styles st ON st.id = pl."styleId"
LEFT JOIN ld_erp.brands bs ON bs.id = st."brandId" AND bs.type <> 'CUSTOM'
WHERE g."createdAt" >= '<rollback start, UTC>'
  AND gl."brandId" IS NULL
  AND w.purpose IS DISTINCT FROM 'SAMPLING'
  AND COALESCE(bp.id, bm.id, bs.id) IS NOT NULL
ORDER BY g."grnNumber";
```

   For each row, raise an **EARMARK** from central to that brand for the quantity, naming its rolls (stickers). If the rolls are not named, approval refuses it with "STICKERS_NEEDED". A second person approves. Finished goods received during the rollback for a brand's order need the same treatment.
4. Orders, challans and invoices made during the rollback carry LD Cotton Mills, the database's default. Leave them, unless a sale really was another brand's.
5. Post the open period again (section 8). Documents made during the rollback take the release's rules, for example the department on sales lines, and each rewrite keeps a revision.
6. Check: Stock Reconciliation shows 0 findings, the integrity snapshot is clear, and the trial balance totals are unchanged.

**On the copy:**
- One finding: central −1 on the shirt.
- RELEASE SRA-2627-0076, raised by the store keeper and approved by the admin. The keeper's own approval was refused.
- EARMARK SRA-2627-0078, naming roll PK-1370. A first try without the roll was refused at approval and withdrawn.
- The re-post rewrote 6 invoices: the rollback one (it gained its department), plus 5 that the e2e sales test had back-dated directly in the database.
- Trial balance ₹18,00,206.42 = ₹18,00,206.42 before and after.
- Then 0 findings, 0 integrity problems, and company stock unchanged. Only the brand split moved back.

## 10. Keep until production is stable

Delete none of these until the owner confirms that production is stable:

- the live backups and snapshots in `Desktop/LD ERP Backups` (`live-<date>.json`, `live-before.json`, `live-after.json`), and the Supabase backup;
- the restored copy of the live backup (`lderp_restore_<date>`, demo server);
- the rollback build: branch `rollback/compat-schema` and worktree `LD ERP Rollback`, with its packages installed;
- the rehearsal evidence: `Desktop/LD ERP Backups/demo-rehearsal-multibrand-2026-11-28` (demo only) and the copy `lderp_restore_20261128` (demo server);
- the test branch `integration/release-20261128` and worktree `LD ERP Integration`.

## 11. Cleanup is deferred

No destructive cleanup is part of this release. Every existing field, table and history row stays, including the ones the release has replaced. The Cleanup Impact Report lists each one (claude.ai/artifact/GP6MmBe3LY4M65cgVPR214). Every removal waits for its own approval, after production is stable.

## 12. Sign-off

- [ ] The owner, after a walk on localhost:3307 (demo) through the acceptance walk's documents:
  - purchases PO-2627-0075 and PO-2627-0076, with return PRC-0017;
  - transfer STN-2627-0296;
  - orders SO-2627-0122 to 0124, with MO-2627-0066 and FGR-2627-0040;
  - brand transfers SRA-2627-0055 and 0056;
  - challans DC-2627-0102 to 0104;
  - invoices INV-2627-0039 to 0041, with credit note CN-2627-0017;
  - September's PV-2627-0010 and 0011, with ALC-2627-0003.
- [ ] The CA, for brand-wise moving average and for the GST treatment of extra charges.
- [ ] Every step above ticked, with the before and after snapshots kept with the backup.
