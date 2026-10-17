// Cutting sheet (opened by 17-stage-open): issue the lay to a cutting contractor.
const c = S.cfg
await h.click('Issue to cutting contractor', h.dlg()); await h.sleep(1200)
await h.say(`Step 14 · Cutting — issue all 60 pieces (${c.layers} layers) and ${c.fabricGiven} m of fabric to the cutting contractor`)
const d = h.dlg()
await h.type(d.getByLabel('Cutting contractor'), 'Ramesh Cutting Works')
await page.keyboard.press('Tab')
await h.type(d.getByLabel('Layers'), c.layers)
await h.type(d.getByLabel('Fabric given'), c.fabricGiven)
await h.click('Issue all that is left', d)
await h.beat(2000)
const btn = d.getByRole('button', { name: /^Issue \d+ pcs$/ }).first()
const label = await btn.innerText()
await btn.click()
await h.sleep(2000)
await h.beat(1500)
return label + ' · ' + ((await h.dlg().innerText()).match(/CUT\/\d{4}-\d{4}\/\d+/) || [])[0]
