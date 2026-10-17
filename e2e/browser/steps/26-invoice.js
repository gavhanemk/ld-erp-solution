// Sales → the tax invoice, opened from the challan already filled in: save it.
const d = h.dlg()
await h.say(`Step 23 · Tax invoice — filled in from the challan: HSN ${S.cfg.hsn}, 60 × ₹${S.price}, GST added; due in 30 days`)
await h.beat(3500)
const popup = ctx.waitForEvent('page', { timeout: 6000 }).catch(() => null)
await d.getByRole('button', { name: 'Save invoice' }).first().click()
await h.sleep(3000)
const p = await popup; if (p) { await h.beat(3000); await p.close().catch(() => {}) }
await h.go('/sales/invoices?q=' + S.so)
await h.beat(2000)
const row = (await page.locator('tbody tr').first().innerText().catch(() => '')).replace(/\s+/g, ' ')
S.invoice = (row.match(/INV-\d{4}-\d{4}/) || [])[0]
return row.slice(0, 200)
