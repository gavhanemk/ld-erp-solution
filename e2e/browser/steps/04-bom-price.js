// BOM, step 3: the selling price. Saving it leaves a draft, so "Saved as a draft" offers the review,
// and Approve there makes it the BOM orders and MOs use.
const c = S.cfg
const d = h.dlg()
await h.say('Step 2 · BOM pricing — a 25% margin gives the selling price per piece')
await h.type(d.locator('#bom-margin'), '25')
await h.beat(2000)
S.price = await d.locator('#bom-price').inputValue()
await h.click('Save price', d)
await h.sleep(1500)
await h.say('Step 2 · Approve the BOM, so the order and production can use it')
await h.click('Review and approve now', h.dlg())
await h.sleep(1500)
await h.beat(1500)
await h.dlg().getByRole('button', { name: 'Approve', exact: true }).first().click()
await h.sleep(2000)
const said = await h.toast()
await h.closeAll()
const boms = (await h.api('GET', '/masters/bom?limit=200')).data?.data ?? []
const bom = boms.find((b) => b.style?.code === c.styleCode && b.color === c.colour)
if (bom?.status !== 'APPROVED') throw new Error(`the BOM is ${bom ? bom.status : 'missing'} after Approve: ${said}`)
return `price ${S.price}; ${said}`
