// On the receiving stage's sheet: count the bundles in as sent.
let d = h.dlg()
if (!/^Count in/m.test(await d.locator('h1,h2,h3').first().innerText())) { await h.click('Count in', d); await h.sleep(1200); d = h.dlg() }
await h.type(d.getByLabel('Received by'), S.receivedBy ?? 'Supervisor')
await h.beat(1500)
const btn = d.getByRole('button', { name: /^Count in \d+ pcs$/ }).first()
const label = await btn.innerText()
await btn.click()
await h.sleep(2000)
return label + '\n' + (await h.describe()).slice(0, 800)
