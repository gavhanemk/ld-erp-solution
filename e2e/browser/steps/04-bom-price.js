// BOM, step 3: the selling price, then approve it.
const c = S.cfg
const d = h.dlg()
await h.say('Step 2 · BOM pricing — a 25% margin gives the selling price per piece')
await h.type(d.locator('#bom-margin'), '25')
await h.beat(2000)
S.price = await d.locator('#bom-price').inputValue()
await h.click('Save price', d)
await h.sleep(1500)
await h.closeAll()
await h.say('Step 2 · Approve the BOM, so the order and production can use it')
await h.go('/masters/bom')
const row = page.locator('tr, li, [class*=card]').filter({ hasText: c.styleCode }).filter({ hasText: c.colour }).first()
await row.scrollIntoViewIfNeeded()
await h.beat(1000)
await row.locator('[title="Approve BOM"]').first().click()
await h.sleep(2000)
await h.beat(1500)
return `price ${S.price}; approve button left: ${await row.locator('[title="Approve BOM"]').count()}`
