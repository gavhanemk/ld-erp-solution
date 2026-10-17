// Masters → Routing for the style: which processes it needs; stitching at an outside unit.
const c = S.cfg
await h.say(`Step 11 · Routing — the processes a ${c.styleName} goes through; stitching is done at an outside unit`)
await h.go('/masters/routings')
await h.beat(1200)
await page.getByText(c.styleName).first().click()
await page.waitForLoadState('networkidle'); await h.beat(2000)
await h.click('Make its routing')
await h.sleep(1000)
const d = h.dlg()
await h.type(d.getByLabel('Name', { exact: true }), c.routingName)
for (const p of ['Cutting', 'Fusing', 'Stitching', 'Kaj Button', 'Final QC', 'Packing']) { await d.getByRole('button', { name: p, exact: true }).click(); await h.beat(600) }
await h.pick(d.locator('[aria-label="Step 3 where it is done"]'), 'Outside', 'Outside unit')
await h.type(d.locator('[aria-label="Step 3 rate per piece"]'), '45')
await h.type(d.locator('[aria-label="Step 3 standard minutes a piece"]'), '18')
await h.type(d.locator('textarea').last(), 'Cutting and Fusing in-house, stitching outside, then Kaj Button, Final QC and Packing.')
await h.beat(2500)
await d.getByRole('button', { name: 'Create routing' }).first().click()
await h.sleep(2000)
await h.beat(2500)
return (await h.dlg().count()) ? 'STILL OPEN ' + (await h.describe()) : 'routing created: ' + (await page.locator('main').innerText()).replace(/\s+/g, ' ').match(/Steps.{0,200}/)?.[0]
