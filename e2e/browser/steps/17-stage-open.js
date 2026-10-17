// Production → Production Stages: open this job card's sheet on a stage tab.
// S.tab = the tab to open (e.g. 'Cutting'); S.caption = what to say.
if (S.caption) await h.say(S.caption)
await h.go('/production/stages')
const tabNames = (await page.getByRole('tab').allInnerTexts()).map((n) => n.replace(/\s+/g, ' ').replace(/ \d+ [a-z ]+$/, '').trim())
const ti = tabNames.indexOf(S.tab)
if (ti < 0) throw new Error('no tab ' + S.tab + ' in ' + tabNames.join(' | '))
await page.getByRole('tab').nth(ti).click()
await h.sleep(1000)
await h.beat(1200)
await page.locator('tbody tr').filter({ hasText: S.mo + '-JC1' }).first().click()
await h.sleep(1500)
await h.beat(1500)
return (await h.describe()).slice(0, 1600)
