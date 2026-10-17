// Inventory → Track & Trace: the whole story of the order on one screen.
await h.say(`Step 24 · Track & Trace — ${S.mo}'s whole journey on one screen: materials, purchase, every stage, dispatch`)
await h.go('/inventory/trace')
const box = page.getByLabel('Package code').first()
await h.type(box, S.mo)
await h.beat(800)
await box.press('Enter')
await page.waitForLoadState('networkidle').catch(() => {})
await h.sleep(2500)
const t = (await page.locator('main').innerText()).replace(/\s+/g, ' ')
// Scroll slowly down the story so it can be read.
if (S.slow) {
  const height = await page.evaluate(() => document.scrollingElement.scrollHeight)
  for (let y = 0; y < height; y += 260) { await page.mouse.wheel(0, 260); await h.sleep(900) }
  await h.sleep(1500)
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'smooth' }))
}
await h.say(`Done · ${S.cfg.styleName}: BOM → ${S.quote} → ${S.so} → ${S.mo} → ${S.pos.join(' + ')} → ${S.grns.join(' + ')} → stages → finished goods → dispatched → ${S.invoice ?? 'invoice'}`)
return t.match(/Where the whole order stands.{0,260}/)?.[0] ?? t.slice(0, 400)
