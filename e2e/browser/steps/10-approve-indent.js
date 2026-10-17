// Inventory → Requisitions: approve each; nothing is in stock, so put the shortfall on the indent for Purchase.
await h.say('Step 7 · Store — approve the requisitions; nothing is in stock, so each one goes on the indent for Purchase')
await h.go('/inventory/requisitions?q=' + encodeURIComponent(S.mo))
const out = []
for (const mr of S.mrs) {
  const row = () => page.locator('tbody tr').filter({ hasText: mr }).first()
  await row().scrollIntoViewIfNeeded()
  if (await row().getByRole('button', { name: 'Approve', exact: true }).count()) {
    await h.beat(500)
    await row().getByRole('button', { name: 'Approve', exact: true }).click()
    await h.sleep(1500)
  }
  await row().getByRole('button', { name: 'Process' }).click()
  await h.sleep(1200)
  const d = h.dlg()
  await d.getByRole('tab', { name: /Buy what/ }).click()
  await h.beat(1200)
  await d.getByRole('button', { name: 'Save indent' }).click()
  await h.sleep(1500)
  await h.closeAll()
  out.push(((await row().innerText()).replace(/\s+/g, ' ').match(/(Waiting for purchase|To be issued|Part issued|Arrived[^·]*|Issued)/) || [])[0] ?? '?')
}
await h.beat(1500)
return S.mrs.map((m, i) => `${m}: ${out[i]}`).join('\n')
