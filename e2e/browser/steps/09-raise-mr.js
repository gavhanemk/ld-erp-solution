// From the MO: ask the store for every material, per process.
const c = S.cfg
await h.say(`Step 6 · ${S.mo} — raise material requisitions straight from the BOM: cloth from Fabric Warehouse, trims from Store`)
if (!(await h.dlg().count())) { await h.go('/production/orders?open=' + S.moId); await h.sleep(1500) }
const d = h.dlg()
await d.getByRole('heading', { name: 'Materials from the BOM' }).scrollIntoViewIfNeeded()
await h.beat(2000)
for (const code of c.trimsFromStore) {
  const row = d.locator('tr').filter({ hasText: code }).first()
  await h.pick(row.locator('[role=combobox]').last(), 'Store', 'Store')
}
await h.type(d.getByLabel('Needed by'), h.day(5))
await h.beat(1500)
await h.click('Raise requisitions', d)
await h.sleep(2500)
const mrs = (await d.innerText()).match(/MR-\d{4}-\d{4}/g) ?? []
S.mrs = [...new Set(mrs)].sort()
await d.getByRole('heading', { name: 'Requisitions' }).scrollIntoViewIfNeeded().catch(() => {})
await h.beat(2000)
return 'MRs: ' + S.mrs.join(', ')
