// Inventory → the store issues every requisition to the floor.
await h.say('Step 10 · Store issues the materials to the departments — straight from what the receipts brought in')
await h.go('/inventory/requisitions?q=' + encodeURIComponent(S.mo))
const out = []
for (const mr of S.mrs) {
  const row = () => page.locator('tbody tr').filter({ hasText: mr }).first()
  await row().scrollIntoViewIfNeeded()
  await row().getByRole('button', { name: 'Process' }).click()
  await h.sleep(1200)
  const d = h.dlg()
  await d.getByRole('tab', { name: /Issue from store/ }).click().catch(() => {})
  await h.beat(1500)
  const popup = ctx.waitForEvent('page', { timeout: 6000 }).catch(() => null)
  await d.getByRole('button', { name: 'Issue', exact: true }).click()
  await h.sleep(2000)
  const p = await popup
  if (p) { await h.beat(1500); await p.close().catch(() => {}) }
  await h.closeAll()
  out.push(((await row().innerText()).replace(/\s+/g, ' ').match(/(Issued|Part issued|To be issued|Arrived[^·]*)/) || [])[0] ?? '?')
}
await h.beat(1500)
return S.mrs.map((m, i) => `${m}: ${out[i]}`).join('\n')
