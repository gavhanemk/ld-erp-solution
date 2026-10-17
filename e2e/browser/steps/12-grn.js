// Purchase → Goods receipt for each PO: challan, quantities, packages, store. Stock goes in on save; stickers are made.
const c = S.cfg
S.grns = []
const out = []
for (let k = 0; k < c.pos.length; k++) {
  const g = c.pos[k]
  const po = S.pos[k]
  await h.say(`Step 9 · Goods Receipt against ${po} (${g.supplier}) — what arrived, their challan, packages and store; stock goes in on save`)
  await h.go('/purchase/grn')
  await page.locator('tbody tr').filter({ hasText: po }).first().getByRole('button', { name: 'Receive' }).click()
  await h.sleep(1500)
  const d = h.dlg()
  await h.type(d.getByLabel('Vehicle number', { exact: true }), 'GJ05 AB 4471')
  await h.type(d.getByLabel('Received on', { exact: true }), h.day())
  await h.type(d.getByLabel(/^Challan number/), g.challan)
  await h.type(d.getByLabel('Challan date*', { exact: true }), h.day())
  for (const [raw, qty, , packs] of g.lines) {
    const name = raw.replace(/"/g, '\\"')
    await h.type(d.locator(`[aria-label="Quantity of ${name} received on this receipt"]:visible`), String(qty))
    if (g.lot) await h.type(d.locator(`[aria-label="Lot number of ${name}"]:visible`), g.lot)
    await h.type(d.locator(`[aria-label="How many packages of ${name}"]:visible`), String(packs))
  }
  await h.beat(2000)
  await d.getByRole('button', { name: 'Receive goods' }).first().click()
  await h.sleep(2500)
  let note = 'received'
  if (await h.dlg().count()) {
    const t = await h.dlg().innerText()
    const m = t.match(/(\d+) stickers? ready for (GRN-\d{4}-\d{4})/)
    if (m) {
      S.grns.push(m[2]); note = `${m[2]} · ${m[1]} stickers`
      await h.beat(3000)
      await h.dlg().getByRole('button', { name: 'Later' }).click(); await h.sleep(800)
    } else note = 'DIALOG ' + t.replace(/\s+/g, ' ').slice(0, 500)
  }
  out.push(`${po}: ${note}`)
}
return out.join('\n')
