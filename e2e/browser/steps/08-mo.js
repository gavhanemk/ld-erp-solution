// Manufacturing Order from the sales order, released to the floor.
await h.say(`Step 5 · Manufacturing Order — "Plan production" on ${S.so}: all 60 pieces, released to the floor`)
await page.locator('tbody tr').filter({ hasText: S.so }).first().locator('[aria-label^="Actions"]').click()
await h.beat(900)
await page.getByRole('menuitem', { name: 'Plan production' }).click()
await page.waitForLoadState('networkidle'); await h.sleep(1500)
const d = h.dlg()
await h.type(d.locator('#mo-notes'), 'Demo run · cut in one lot')
await h.beat(2000)
await h.click('Save & release', d)
await h.sleep(3000)
const r = await h.api('GET', '/production/orders?q=' + S.so + '&limit=5')
const mo = (r.data?.data ?? [])[0]
S.mo = mo?.moNumber; S.moId = mo?.id
return `${S.mo} ${mo?.status}`
