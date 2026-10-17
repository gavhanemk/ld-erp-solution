// Sales → Quotation for 60 shirts; the rate comes straight from the BOM's selling price.
const c = S.cfg
const pcs = c.sizes.reduce((a, [, q]) => a + q, 0)
await h.say(`Step 3 · Sales Quotation — ${pcs} ${c.styleName} for ${c.customer}; the rate comes from the BOM`)
await h.go('/sales/quotations')
await h.click('New quotation')
const d = h.dlg()
await h.pick(d.locator('#qt-customer'), c.customerSearch, c.customer)
await h.type(d.locator('#qt-ref'), c.buyerRef)
await h.type(d.locator('#qt-sp'), 'Rohit')
await h.pick(d.locator('[aria-label="Row 1 style"]'), c.styleCode, c.styleCode)
await h.sleep(500)
const colour = d.locator('[aria-label="Row 1 colour"]')
if ((await colour.getAttribute('role')) === 'combobox') await h.pick(colour, c.colour, c.colour)
else await h.type(colour, c.colour)
await h.sleep(500)
const item = d.locator('[aria-label="Row 1 item billed as"]')
if (!(await item.innerText()).includes(c.itemName.split(' — ')[0])) await h.pick(item, c.colour, c.itemName)
await h.type(d.locator('[aria-label="Row 1 pieces"]'), String(pcs))
await h.beat(2500)
await h.click('Save & mark sent', d)
await h.sleep(2000)
const r = await h.api('GET', '/sales/quotations?q=' + encodeURIComponent(c.buyerRef))
const q = (r.data?.data ?? [])[0]
S.quote = q?.quoteNumber ?? q?.quotationNumber; S.quoteId = q?.id
await h.go('/sales/quotations')
await h.beat(1500)
return `${S.quote} ${q?.status}`
