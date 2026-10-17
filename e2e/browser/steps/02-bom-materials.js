// BOM, step 1: the materials for one shirt.
const c = S.cfg
await h.say(`Step 2 · Bill of Materials — what one ${c.styleName} (${c.colour}) needs, line by line`)
await h.go('/masters/bom')
await h.click('New BOM')
const d = h.dlg()
await h.pick(d.locator('#bom-style'), c.styleCode, c.styleCode)
await h.pick(d.locator('#bom-colour'), c.colour, c.colour)
for (let i = 0; i < c.bom.length; i++) {
  const [item, proc, qty, rate] = c.bom[i]
  const n = i + 1
  if (i > 0) { await d.locator('[title="Add a component below this one"]').nth(i - 1).click(); await h.beat(400) }
  await h.pick(d.locator(`[aria-label="Line ${n} item"]`), item)
  await h.pick(d.locator(`[aria-label="Line ${n} process"]`), proc, proc)
  await h.type(d.locator(`[aria-label^="Line ${n} quantity per piece"]`), qty)
  await h.type(d.locator(`[aria-label^="Line ${n} rate"]`), rate)
}
await h.type(d.locator('#bom-notes'), `Demo run: ${c.bom[0][2]} m of fabric a piece.`)
await h.beat(1500)
await h.click('Save and continue', d)
await h.sleep(1500)
return /Labour/.test(await h.dlg().innerText()) ? 'materials saved, on costing' : 'UNEXPECTED\n' + (await h.describe())
