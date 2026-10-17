// Masters → Items: the finished garment we will sell and make.
const c = S.cfg
await h.say(`Step 1 · Masters — the finished garment as an item: ${c.itemName}`)
await h.go('/masters/items')
await h.click('New Item')
const d = h.dlg()
await h.type(d.getByLabel('Item Name*'), c.itemName)
await d.locator('[id$=-type]').click(); await h.beat(400)
await page.getByRole('option', { name: 'Finished Good', exact: true }).click(); await h.beat(500)
await h.pick(d.locator('[id$=-uomId]'), 'Piece', 'Piece')
await h.pick(d.locator('[id$=-mainCategoryId]'), 'Finished', 'Finished Goods')
await h.pick(d.locator('[id$=-subCategoryId]'), c.subCategory, c.subCategory)
await h.type(d.locator('[id$=-hsnCode]'), c.hsn); await page.keyboard.press('Tab')
await h.pick(d.locator('[id$=-styleId]'), c.styleName.split(' ').slice(1, 3).join(' '), c.styleName)
await h.pick(d.locator('[id$=-color]'), c.colour, c.colour)
await h.beat(1200)
await h.click('Save item', d)
await h.sleep(1500)
return (await h.dlg().count()) ? 'STILL OPEN\n' + (await h.describe()) : 'item saved'
