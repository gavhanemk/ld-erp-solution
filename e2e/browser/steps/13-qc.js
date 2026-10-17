// Purchase → optional quality check on the fabric receipt: all passed.
const grn = S.grns[0]
await h.say(`Step 9 · Quality check on ${grn} — shade, width and GSM checked; all of it passed`)
await h.go('/purchase/grn')
await page.getByRole('tab', { name: /Goods receipts/ }).click(); await h.sleep(1000)
await page.locator('tbody tr').filter({ hasText: grn }).first().locator('[aria-label^="Actions"]').first().click(); await h.beat(900)
await page.getByRole('menuitem', { name: 'Quality check (QC)' }).click(); await h.sleep(1200)
const d = h.dlg()
await h.type(d.getByLabel('Remarks'), 'Shade, width and GSM checked — all passed')
await h.beat(2000)
await d.getByRole('button', { name: 'Save QC' }).first().click()
await h.waitClosed()
return (await h.dlg().count()) ? 'STILL OPEN ' + (await h.describe()) : 'QC saved'
