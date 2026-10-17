// On the open stage sheet: record the work (or the check) — all done / all passed.
if (S.caption) await h.say(S.caption)
let d = h.dlg()
if (!/^(Work|Check) at/m.test(await d.locator('h1,h2,h3').first().innerText())) {
  const b = d.getByRole('button', { name: /^(Record work|Record the check)/ }).first()
  await b.click(); await h.sleep(1200); d = h.dlg()
}
await d.getByRole('button', { name: /^All (done|passed)$/ }).first().click()
await h.beat(800)
const by = d.getByLabel(/^(Done by|Checked by)$/)
if (await by.count()) await h.type(by.first(), S.doneBy ?? 'Supervisor')
await h.beat(1200)
const btn = d.getByRole('button', { name: /^Record/ }).first()
const label = await btn.innerText()
await btn.click()
await h.sleep(2000)
return label + '\n' + (await h.describe()).slice(0, 700)
