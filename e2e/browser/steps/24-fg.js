// Packing sheet → "Into finished goods": the 60 packed shirts go into Store against the SO; the MO completes.
await h.say(`Step 21 · Finished goods — 60 packed pieces into Store against ${S.so}; ${S.mo} completes by itself`)
await h.click('Into finished goods', h.dlg())
await page.waitForLoadState('networkidle'); await h.sleep(2500)
const d = h.dlg()
await h.pick(d.locator('[role=combobox]').filter({ hasText: 'Choose a store' }).first(), 'Store', 'Store')
await h.type(d.getByLabel('Notes'), 'Packed and poly-bagged')
await h.beat(2500)
await d.getByRole('button', { name: 'Put into stock' }).first().click()
await h.sleep(2500)
await h.beat(2000)
const mo = (await h.api('GET', '/production/orders/' + S.moId)).data?.data
return `MO ${mo?.moNumber} ${mo?.status}` + ((await h.dlg().count()) ? ' · STILL OPEN ' + (await h.describe()).slice(0, 600) : '')
