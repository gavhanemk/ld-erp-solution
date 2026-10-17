// Purchase: one order per supplier, straight from the indent; rates typed; saved and sent.
const c = S.cfg
S.pos = []
const out = []
for (const o of c.pos) {
  await h.say(`Step 8 · Purchase Order to ${o.supplier} — "Select from indent", type the rates, save (sent)`)
  await h.go('/purchase/orders')
  await h.click('New Purchase Order')
  const d = h.dlg()
  await h.pick(d.locator('#po-supplier'), o.search, o.supplier)
  await h.pick(d.locator('#po-location'), o.location, o.location)
  await h.click('Select from indent', d)
  await h.sleep(1000)
  const ind = h.dlg()
  for (const [name, qty] of o.lines) {
    // Only this order's indent lines: match the box by one of our requisition numbers.
    let cb = null
    for (const mr of S.mrs) {
      const l = ind.locator(`input[type=checkbox][aria-label="Order ${name.replace(/"/g, '\\"')} from ${mr}"]:visible`)
      if (await l.count()) { cb = l.first(); break }
    }
    if (!cb) throw new Error(`no indent line for ${name} on ${S.mrs.join(', ')}`)
    await cb.scrollIntoViewIfNeeded()
    await cb.check()
    await h.beat(300)
    await h.type(cb.locator('xpath=ancestor::tr[1]').locator('[aria-label^="Quantity to order of"]'), String(qty))
  }
  await h.beat(1200)
  await ind.getByRole('button', { name: /Add .*to the order/ }).click()
  await h.sleep(1000)
  const po = h.dlg()
  for (let i = 0; i < o.lines.length; i++) {
    const rate = po.locator(`[aria-label="Row ${i + 1} rate"]:visible`)
    if (!(await rate.inputValue())) await h.type(rate, String(o.lines[i][2]))
  }
  await h.beat(2500)
  const number = await po.getByLabel('Purchase order*').inputValue()
  await po.getByRole('button', { name: 'Save', exact: true }).first().click()
  await h.waitClosed()
  S.pos.push(number)
  out.push(`${number} → ${o.supplier}: ${(await h.dlg().count()) ? 'STILL OPEN ' + (await h.describe()).slice(0, 600) : 'saved'}`)
}
return out.join('\n')
