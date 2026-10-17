// Quotation → Convert to order.
await h.say(`Step 4 · ${S.quote} is accepted — convert it to a sales order`)
const row = page.locator('tbody tr').filter({ hasText: S.quote }).first()
await row.scrollIntoViewIfNeeded()
await page.locator(`[aria-label="Actions for ${S.quote}"]`).click()
await h.beat(900)
await page.getByRole('menuitem', { name: /Convert to order/ }).click()
await page.waitForLoadState('networkidle'); await h.sleep(2000)
return /Sales Order/.test(await h.dlg().innerText()) ? 'order form open' : 'UNEXPECTED ' + (await h.describe())
