// Masters → Routing for the style: a row per step, each process picked from Routing Masters;
// stitching at an outside unit (its rate is set when the pieces are sent).
const c = S.cfg
await h.say(`Step 11 · Routing — the processes a ${c.styleName} goes through; stitching is done at an outside unit`)
await h.go('/masters/routings')
await h.beat(1200)
// Routings are listed by style; a style with none has "Make routing" on its line.
const line = page.locator('tbody tr').filter({ hasText: c.styleCode }).filter({ has: page.getByRole('button', { name: 'Make routing' }) }).first()
await line.scrollIntoViewIfNeeded()
await h.beat(1500)
await line.getByRole('button', { name: 'Make routing' }).click()
await h.sleep(1000)
const d = h.dlg()
await h.type(d.getByRole('textbox', { name: 'Name', exact: true }), c.routingName)
const steps = ['Cutting', 'Fusing', 'Stitching', 'Kaj Button', 'Final QC', 'Packing']
for (let i = 0; i < steps.length; i++) {
  const box = d.locator(`[aria-label="Step ${i + 1} process"]`)
  if (!(await box.count())) { await h.click('Blank step', d); await h.beat(400) }
  await h.pick(box, steps[i], steps[i])
}
await h.pick(d.locator('[aria-label="Step 3 where it is done"]'), 'Outside', 'Outside unit')
await h.type(d.locator('[aria-label="Step 3 standard minutes a piece"]'), '18')
await h.type(d.locator('textarea').last(), 'Cutting and Fusing in-house, stitching outside, then Kaj Button, Final QC and Packing.')
await h.beat(2500)
await d.getByRole('button', { name: 'Create routing' }).first().click()
await h.sleep(2000)
await h.beat(2500)
if (await h.dlg().count()) return 'STILL OPEN ' + (await h.describe())
return 'routing created: ' + (await page.locator('tbody tr').filter({ hasText: c.styleCode }).first().innerText()).replace(/\s+/g, ' ').slice(0, 200)
