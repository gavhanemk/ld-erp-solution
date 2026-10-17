// BOM, step 2: labour and overheads. Row labels follow the name typed ("Stitching amount").
const d = h.dlg()
await h.say('Step 2 · BOM costing — labour and overheads for one piece')
const labour = [['Stitching', '45'], ['Cutting', '6']]
for (let i = 0; i < labour.length; i++) {
  const [name, amt] = labour[i]
  if ((await d.locator('[aria-label="Labour name"]').count()) <= i) {
    if (i === 0) await h.click('Add labour', d)
    else { await d.locator('[title="Add a labour row below this one"]').nth(i - 1).click(); await h.beat(400) }
  }
  await h.type(d.locator('[aria-label="Labour name"]').nth(i), name)
  await h.pick(d.locator(`[aria-label="Department for ${name}"]`), name, name)
  await h.type(d.locator(`[aria-label="${name} amount"]`), amt)
}
if (!(await d.locator('[aria-label="Overhead name"]').count())) await h.click('Add overhead', d)
await h.type(d.locator('[aria-label="Overhead name"]').first(), 'Power and rent')
await h.type(d.locator('[aria-label$="overhead amount"], [aria-label="Power and rent amount"]').first(), '12')
await h.beat(1500)
await h.click('Save and continue', d)
await h.sleep(1500)
return (await h.toast()) + '\n' + (await h.describe())
