// From the open stage sheet: "Transfer on" → pick where they go → send every bundle.
// S.dest = destination step name; S.unit = outside unit (optional); S.caption.
if (S.caption) await h.say(S.caption)
let d = h.dlg()
if (!/Process transfer from/.test(await d.innerText())) { await h.click('Transfer on', d); await h.sleep(1200); d = h.dlg() }
const card = d.getByRole('button').filter({ hasText: new RegExp('^' + S.dest) }).first()
if (await card.count()) { await card.click(); await h.beat(800) }
if (S.unit) {
  const unitPick = d.locator('[role=combobox]').filter({ hasText: /unit|Unit|Pick|Choose|Select/ }).first()
  await h.pick(unitPick, S.unit.split(' ')[0], S.unit)
  if (S.rate) await h.type(d.getByLabel(/Rate per piece/).first(), String(S.rate))
  if (S.due) await h.type(d.getByLabel(/Due back/).first(), S.due)
}
const by = d.getByLabel('Issued by')
if (await by.count()) await h.type(by, S.issuedBy ?? 'Supervisor')
await h.click('Send all', d)
await h.beat(1500)
const btn = d.getByRole('button', { name: /^(Send|Move|Send out) \d+ pcs$/ }).first()
const label = await btn.innerText()
const popup = ctx.waitForEvent('page', { timeout: 6000 }).catch(() => null)
await btn.click()
await h.sleep(2000)
const p = await popup
let printed = ''
if (p) { await p.waitForLoadState().catch(() => {}); await p.bringToFront().catch(() => {}); printed = p.url().replace(h.WEB, ''); await h.beat(3500); await p.close().catch(() => {}); await page.bringToFront() }
return `${label} → ${S.dest}${printed ? ' · printed ' + printed : ''}\n` + (await h.describe()).slice(0, 900)
