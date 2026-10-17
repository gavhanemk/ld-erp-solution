// Sales → Delivery challan for all 60, and the tax invoice in the same go.
const c = S.cfg
await h.say(`Step 22 · Dispatch — all 60 pieces leave Store on a delivery challan to ${c.customer}`)
await h.go('/sales/orders?q=' + S.so)
await page.locator('tbody tr').filter({ hasText: S.so }).first().locator('[aria-label^="Actions"]').click(); await h.beat(900)
await page.getByRole('menuitem', { name: 'Dispatch' }).click()
await page.waitForLoadState('networkidle'); await h.sleep(1500)
const d = h.dlg()
await h.click('Fill what can go', d)
await h.type(d.getByLabel('Cartons'), '2')
await h.type(d.getByLabel('Transporter'), 'Konkan Roadways Cargo')
await h.type(d.getByLabel('Vehicle no.'), 'GJ05 CX 9012')
await h.type(d.getByLabel('LR no.'), 'LR/' + S.so.slice(-4))
await h.beat(2500)
const popup = ctx.waitForEvent('page', { timeout: 6000 }).catch(() => null)
await d.getByRole('button', { name: 'Dispatch & invoice' }).first().click()
await h.sleep(3000)
const p = await popup; if (p) { await h.beat(3000); await p.close().catch(() => {}) }
const so = (await h.api('GET', '/sales/orders?q=' + S.so)).data?.data?.[0]
return `SO ${so?.soNumber} ${so?.status} · ${(await h.dlg().count()) ? (await h.dlg().locator('h1,h2,h3').first().innerText()) : 'no window'}`
