// Keyboard-only checks: the ERP worked without the mouse.
//
//   npm run test:keys                        headless
//   npm run test:keys -- --headed            in a Chrome window
//
// Every check below drives the app with key presses only — no clicks. (Where
// a check needs to start from a known box, it says so and puts focus there,
// the way a Tab from the box before would.) Each prints PASS or FAIL; the run
// ends with "N passed, M failed" and exits non-zero on a failure.
//
// It WRITES a little to the demo, and only the demo: one brand named
// "ZZKEY Brand …" (made, then renamed) and one draft purchase order. Same
// guards as every suite here: the database must be lderp_demo and the API
// must be using it.
import { chromium } from 'playwright'
import { mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { API as API_BASE, WEB, demoDb, adminLogin, required, exit } from '../lib/demo.mjs'

const headed = process.argv.includes('--headed')
const email = required('E2E_EMAIL', 'the sign-in for the checks')
const password = required('E2E_PASSWORD', 'the sign-in for the checks')
const API = API_BASE.replace(/\/api$/, '')
const SHOTS = fileURLToPath(new URL('./shots/', import.meta.url))
mkdirSync(SHOTS, { recursive: true })

const db = await demoDb()
const token = await adminLogin(db)

const browser = await chromium.launch({ channel: 'chrome', headless: !headed, args: headed ? ['--start-maximized'] : [] })
const ctx = await browser.newContext(headed ? { viewport: null } : { viewport: { width: 1440, height: 900 } })
const page = await ctx.newPage()
const errors = []
page.on('pageerror', (e) => errors.push(e.message))

await page.goto(`${WEB}/login`)
const signedIn = await page.evaluate(
  async ({ api, creds }) => {
    const r = await fetch(`${api}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(creds) })
    const d = await r.json()
    if (!d.accessToken) return false
    localStorage.setItem('access_token', d.accessToken)
    localStorage.setItem('refresh_token', d.refreshToken)
    localStorage.setItem('user', JSON.stringify(d.user))
    localStorage.setItem('theme', 'light')
    return true
  },
  { api: API, creds: { email, password } },
)
if (!signedIn) {
  console.error(`Sign-in refused for ${email}.`)
  await browser.close()
  await exit(2)
}

let passed = 0
let failed = 0
const check = async (name, fn) => {
  try {
    const why = await fn()
    if (why === true || why === undefined) {
      passed++
      console.log(`PASS  ${name}`)
    } else {
      failed++
      console.log(`FAIL  ${name} — ${why}`)
      await page.screenshot({ path: `${SHOTS}keys-${passed + failed}.png` })
    }
  } catch (e) {
    failed++
    console.log(`FAIL  ${name} — ${e.message.split('\n')[0]}`)
    await page.screenshot({ path: `${SHOTS}keys-${passed + failed}.png` }).catch(() => {})
  }
}
const wait = (ms) => page.waitForTimeout(ms)
const key = (k) => page.keyboard.press(k)
const type = (t) => page.keyboard.type(t, { delay: 15 })
const open = async (path) => {
  await page.goto(`${WEB}${path}`)
  await page.waitForLoadState('networkidle')
  await wait(700)
}
/** What has focus, in words: tag, label, and which dialog it is in. */
const focus = () =>
  page.evaluate(() => {
    const el = document.activeElement
    if (!el || el === document.body) return { what: 'nothing', inDialog: false, label: '' }
    const label = (el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.textContent || '').trim().slice(0, 60)
    return { what: el.tagName.toLowerCase(), label, inDialog: !!el.closest('[role="dialog"]'), row: el.hasAttribute('data-row'), value: el.value ?? null }
  })
const note = () => page.locator('[role="status"]').innerText({ timeout: 1500 }).catch(() => '')
const api = async (path) => (await fetch(`${API}/api${path}`, { headers: { authorization: `Bearer ${token}`, connection: 'close' } })).json()
const stamp = Date.now().toString(36).toUpperCase()

// ─── 1. Open a module without the mouse ───────────────────────────────────────
await open('/dashboard')
await check('Ctrl+K opens the palette with focus in its search box', async () => {
  await key('Control+k')
  await wait(200)
  const f = await focus()
  return f.what === 'input' && f.inDialog ? true : `focus is on ${f.what} "${f.label}"`
})
await check('typing a screen name and Enter opens that screen', async () => {
  await type('material req')
  await wait(400)
  await key('Enter')
  await page.waitForURL('**/inventory/requisitions', { timeout: 8000 })
  return true
})

// ─── 8. Shortcuts never eat what is typed ────────────────────────────────────
await check('"/" goes to the list search; "/" and "?" typed there stay as text', async () => {
  await wait(800)
  await key('/')
  const f = await focus()
  if (f.what !== 'input') return `"/" put focus on ${f.what}`
  await type('a/b?')
  const v = (await focus()).value
  const helpOpen = await page.getByRole('dialog', { name: 'Keyboard shortcuts' }).isVisible().catch(() => false)
  await page.keyboard.press('Control+a')
  await key('Backspace')
  return v === 'a/b?' && !helpOpen ? true : `box holds "${v}", help open: ${helpOpen}`
})
await check('Alt+/ shows the shortcut list and Esc closes it', async () => {
  await key('Escape')
  await key('Alt+/')
  await wait(200)
  const shown = await page.getByRole('dialog', { name: 'Keyboard shortcuts' }).isVisible()
  await key('Escape')
  await wait(200)
  const gone = !(await page.getByRole('dialog', { name: 'Keyboard shortcuts' }).isVisible().catch(() => false))
  return shown && gone ? true : `shown ${shown}, closed ${gone}`
})

// ─── 6. Lists: into the list, along it, open a line ─────────────────────────
await open('/purchase/orders')
await check('"/" then ↓ puts focus on the first line of the list', async () => {
  await key('/')
  await key('ArrowDown')
  const f = await focus()
  return f.row ? true : `focus is on ${f.what} "${f.label}"`
})
await check('↓ moves to the next line, ↑ back', async () => {
  const first = await page.evaluate(() => document.activeElement?.textContent?.slice(0, 40))
  await key('ArrowDown')
  const second = await page.evaluate(() => document.activeElement?.textContent?.slice(0, 40))
  await key('ArrowUp')
  const back = await page.evaluate(() => document.activeElement?.textContent?.slice(0, 40))
  return first !== second && back === first ? true : 'focus did not move line by line'
})
await check('Enter opens the line (its items show)', async () => {
  const before = await page.locator('[data-row]:focus [aria-expanded="true"]').count()
  await key('Enter')
  await wait(600)
  const after = await page.locator('[data-row]:focus [aria-expanded="true"]').count()
  await key('Enter') // shut it again
  return after > before ? true : 'nothing opened'
})
await check('Shift+F10 opens the line’s Actions menu, Esc shuts it and focus returns', async () => {
  await key('Shift+F10')
  await wait(200)
  const inMenu = await page.evaluate(() => document.activeElement?.getAttribute('role') === 'menuitem')
  await key('ArrowDown')
  await key('Escape')
  await wait(150)
  const back = await page.evaluate(() => document.activeElement?.getAttribute('aria-haspopup') === 'menu')
  return inMenu && back ? true : `in menu ${inMenu}, back on its button ${back}`
})

// ─── 5. Find and open a record by its number ─────────────────────────────────
const mr = (await api('/inventory/requisitions?limit=1')).data?.[0]
await check('Ctrl+K, a requisition number, Enter: its list opens with that line found', async () => {
  if (!mr?.mrNumber) return 'no requisition in the demo to look for'
  await key('Control+k')
  await type(mr.mrNumber)
  await page.locator('#palette-list [role="option"]', { hasText: mr.mrNumber }).first().waitFor({ timeout: 5000 })
  await key('Enter')
  await page.waitForURL('**/inventory/requisitions', { timeout: 8000 })
  await page.waitForFunction((n) => document.activeElement?.hasAttribute('data-row') && document.activeElement.textContent.includes(n), mr.mrNumber, { timeout: 8000 })
  return true
})

// ─── 2. Make a record and change it, keys only ───────────────────────────────
const brand = `ZZKEY Brand ${stamp}`
await open('/masters/brands')
await check('Alt+N opens a new brand with focus in its first box', async () => {
  await key('Alt+n')
  await wait(500)
  const f = await focus()
  return f.what === 'input' && f.inDialog ? true : `focus is on ${f.what} "${f.label}"`
})
await check('typed, a dropdown chosen by keys, Ctrl+S: the brand is saved', async () => {
  await type(brand)
  await key('Tab') // the Kind dropdown
  await key('Enter') // open it: it starts on "Select..."
  await wait(200)
  await key('ArrowDown') // the first kind
  await key('Enter')
  await wait(300)
  await key('Control+s')
  await page.locator('form[role="dialog"]').waitFor({ state: 'detached', timeout: 8000 })
  const found = (await api(`/masters/brands?search=${encodeURIComponent(brand)}`)).data ?? []
  return found.some((b) => b.name === brand) ? true : 'not in the brands list after saving'
})
await check('found again with "/", opened with ↓ Enter, renamed, Ctrl+S', async () => {
  await wait(600)
  await key('/')
  await type(brand)
  await wait(900)
  await key('ArrowDown')
  await key('Enter')
  await page.locator('form[role="dialog"]').waitFor({ timeout: 5000 })
  await wait(300)
  await key('End')
  await type(' Edited')
  await key('Control+s')
  await page.locator('form[role="dialog"]').waitFor({ state: 'detached', timeout: 8000 })
  const found = (await api(`/masters/brands?search=${encodeURIComponent(brand)}`)).data ?? []
  return found.some((b) => b.name === `${brand} Edited`) ? true : 'the new name was not saved'
})
await check('after the save the list still answers the keyboard ("/" works)', async () => {
  await wait(500)
  await key('/')
  const f = await focus()
  return f.what === 'input' && !f.inDialog ? true : `focus is on ${f.what}`
})

// ─── 3, 7, 9, 11. A form: dropdowns, Enter, Tab inside, an error, Esc ──────
await open('/inventory/requisitions')
await check('Alt+N opens a new requisition with focus on its first box', async () => {
  await key('Alt+n')
  await page.waitForFunction(() => document.activeElement?.getAttribute('role') === 'combobox', null, { timeout: 5000 })
  return true
})
await check('Ctrl+S on an empty form saves nothing and says what is missing', async () => {
  const before = (await api('/inventory/requisitions?limit=1')).data?.[0]?.mrNumber
  await key('Control+s')
  await wait(800)
  const after = (await api('/inventory/requisitions?limit=1')).data?.[0]?.mrNumber
  const msg = await page.locator('[role="dialog"]').innerText()
  return before === after && /department/i.test(msg) ? true : `newest MR ${before} → ${after}`
})
await check('a letter finds a department, Enter chooses it and moves on', async () => {
  const dept = page.locator('[role="dialog"] button[role="combobox"]').first()
  await dept.focus() // back to the first box, as Shift+Tab would
  await type('k')
  await wait(300)
  await key('Enter')
  await wait(500)
  const chosen = (await dept.innerText()).trim()
  const moved = !(await dept.evaluate((d) => d === document.activeElement))
  return /^k/i.test(chosen) && moved ? true : `chose "${chosen}", moved on ${moved}`
})
await check('Tab stays inside the open form', async () => {
  for (let i = 0; i < 50; i++) await key('Tab')
  return (await focus()).inDialog ? true : 'focus left the form'
})
await check('Esc closes the form and focus goes back to New requisition', async () => {
  await key('Escape')
  await wait(400)
  const f = await focus()
  return /new requisition/i.test(f.label) ? true : `focus is on ${f.what} "${f.label}"`
})

// ─── 4. Several item lines, keys only, saved as a draft ──────────────────────
await open('/purchase/orders')
const draftsBefore = (await api('/purchase/orders?status=DRAFT&limit=1')).pagination?.total ?? null
await check('a purchase order with two item lines, made and saved as a draft by keys', async () => {
  await key('Alt+n')
  await page.locator('[aria-labelledby="po-dialog-title"]').waitFor({ timeout: 8000 })
  await wait(1500)
  // The supplier box, as Tab from the box before would reach it.
  const supplier = page.locator('[aria-labelledby="po-dialog-title"] button[role="combobox"]', { hasText: /supplier/i }).first()
  await supplier.focus()
  await type('shree')
  await wait(300)
  await key('Enter')
  await wait(1200)
  const fill = async (n) => {
    const row = page.locator('tbody[data-grid] > [data-grid-row]').nth(n)
    await row.locator('button[role="combobox"]').nth(3).focus() // the item box
    await key('Enter')
    await wait(200)
    await type('button')
    await wait(300)
    await key('Enter')
    await wait(800)
    await row.getByLabel(/quantity/i).focus()
    await type('10')
    await key('Enter') // on to the rate
    await type('5')
  }
  await fill(0)
  await key('Alt+a')
  await wait(500)
  await fill(1)
  const lines = await page.locator('tbody[data-grid] > [data-grid-row]').count()
  await key('Control+s')
  await page.locator('[aria-labelledby="po-dialog-title"]').waitFor({ state: 'detached', timeout: 10000 })
  const after = (await api('/purchase/orders?status=DRAFT&limit=1')).pagination?.total ?? null
  return lines === 2 && after !== null && draftsBefore !== null && after === draftsBefore + 1 ? true : `lines ${lines}, drafts ${draftsBefore} → ${after}`
})

// ─── 10. Nothing went wrong in the page ──────────────────────────────────────
await check('no errors in the page during the run', async () => (errors.length ? errors.slice(0, 3).join(' | ') : true))

await browser.close()
await db.end()
console.log(`\n${passed} passed, ${failed} failed`)
await exit(failed ? 1 : 0)
