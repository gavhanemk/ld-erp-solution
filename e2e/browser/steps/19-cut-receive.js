// Cutting sheet: receive the cut pieces back — bundles of 20, each with a sticker.
const c = S.cfg
await h.say(`Step 14 · Cutting — 60 cut pieces back from the contractor; ${c.fabricUsed} m used, ${c.waste} m waste; bundles of 20 get stickers`)
await h.click('Receive cut', h.dlg()); await h.sleep(1200)
const d = h.dlg()
await h.type(d.getByLabel('Fabric used'), c.fabricUsed)
await h.type(d.getByLabel('Cut waste'), c.waste)
await h.type(d.getByLabel('Note'), 'Lay of ' + c.layers + ', clean cut')
await h.beat(2000)
const popup = ctx.waitForEvent('page', { timeout: 8000 }).catch(() => null)
await d.getByRole('button', { name: /^Receive \d+ pcs$/ }).first().click()
await h.sleep(2000)
const p = await popup
let stick = ''
if (p) { await p.waitForLoadState().catch(() => {}); await p.bringToFront().catch(() => {}); stick = p.url().replace(h.WEB, ''); await h.beat(5000); await p.close().catch(() => {}); await page.bringToFront() }
await h.beat(1500)
return 'stickers: ' + stick + ' · ' + ((await h.dlg().innerText()).match(/All \d+ bundle stickers/) || [])[0]
