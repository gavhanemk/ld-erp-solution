// Sales Order from the quotation: split the pieces by size, confirm.
const c = S.cfg
await h.say('Step 4 · Sales Order — filled in from the quotation; split the 60 pieces by size, then confirm')
const d = h.dlg()
await h.type(d.getByLabel('Buyer PO no.'), c.buyerPo)
await h.type(d.getByLabel('Shipment / delivery date'), h.day(34))
for (const [size, q] of c.sizes) await h.type(d.locator(`[aria-label="Row 1, size ${size}"]:visible`), String(q))
await h.beat(2500)
await h.click('Confirm order', d)
await h.waitClosed()
if (await h.dlg().count()) return 'STILL OPEN\n' + (await h.describe())
const r = await h.api('GET', '/sales/orders?q=' + encodeURIComponent(c.buyerPo) + '&limit=5')
const so = (r.data?.data ?? [])[0]
S.so = so?.soNumber; S.soId = so?.id
await h.go('/sales/orders?q=' + S.so)
await h.beat(1500)
return `${S.so} ${so?.status} ₹${so?.totalAmount}`
