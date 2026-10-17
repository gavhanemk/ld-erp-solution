// Helpers every step uses. S.slow = 0 when rehearsing, ~1 when showing it live.
S.slow = S.slow ?? 0
S.log = S.log ?? []
h.beat = (ms = 900) => h.sleep(Math.round(ms * S.slow))

// A caption at the bottom of the screen saying what is happening, kept across page loads.
if (!S.captionInstalled) {
  await ctx.addInitScript(() => {
    const draw = () => {
      const t = sessionStorage.getItem('walk-caption')
      if (!t || !document.body) return
      let el = document.getElementById('walk-caption')
      if (!el) {
        el = document.createElement('div')
        el.id = 'walk-caption'
        el.style.cssText = 'position:fixed;left:50%;bottom:18px;transform:translateX(-50%);z-index:2147483647;pointer-events:none;max-width:min(92vw,980px);padding:10px 18px;border-radius:12px;background:rgba(15,23,42,.92);color:#fff;font:600 15px/1.4 system-ui,sans-serif;box-shadow:0 8px 30px rgba(0,0,0,.35);text-align:center'
        document.body.appendChild(el)
      }
      el.textContent = t
    }
    window.__walkDraw = draw
    document.addEventListener('DOMContentLoaded', draw)
    setInterval(draw, 700)
  })
  S.captionInstalled = true
}
h.say = async (text) => {
  S.log.push(text)
  await page.evaluate((t) => { sessionStorage.setItem('walk-caption', t); window.__walkDraw?.() }, text).catch(() => {})
  await h.beat(1400)
}

h.go = async (path) => {
  await page.goto(h.WEB + path)
  await page.waitForLoadState('networkidle').catch(() => {})
  await h.beat(1200)
}

// The open dialog (the top one), or the page.
h.dlg = () => page.locator('[role=dialog]').filter({ has: page.locator('h1,h2,h3') }).last()

// Click something by its visible text (button first, then any text).
h.click = async (text, scope = page, opts = {}) => {
  const exact = opts.exact ?? false
  let loc = scope.getByRole('button', { name: text, exact })
  if (!(await loc.count())) loc = scope.getByText(text, { exact })
  loc = opts.nth != null ? loc.nth(opts.nth) : loc.first()
  await loc.scrollIntoViewIfNeeded().catch(() => {})
  await h.beat(500)
  await loc.click()
  await h.beat(700)
}

// A search dropdown: click its trigger, type, pick the option that contains `option`.
h.pick = async (trigger, search, option = search) => {
  await trigger.scrollIntoViewIfNeeded().catch(() => {})
  await trigger.click()
  await h.beat(400)
  await page.keyboard.type(search, { delay: S.slow ? 60 : 0 })
  await h.sleep(500)
  const opts = page.getByRole('option')
  await opts.filter({ hasText: option }).first().waitFor({ timeout: 8000 })
  const texts = (await opts.allInnerTexts()).map((t) => t.split(/\n/)[0].trim())
  const placeholder = (t) => /(…|\.\.\.)$/.test(t)
  let idx = texts.findIndex((t) => t === option)
  if (idx < 0) idx = texts.findIndex((t) => t.startsWith(option) && !placeholder(t))
  if (idx < 0) idx = (await opts.allInnerTexts()).findIndex((t, i) => t.includes(option) && !placeholder(texts[i]))
  if (idx < 0) throw new Error(`no option "${option}" in: ${texts.join(' | ')}`)
  await h.beat(400)
  await opts.nth(idx).click()
  await h.beat(500)
}

// Type into a box, replacing what is there.
h.type = async (loc, value) => {
  await loc.scrollIntoViewIfNeeded().catch(() => {})
  await loc.click()
  const kind = await loc.getAttribute('type').catch(() => null)
  if (kind === 'date' || kind === 'time' || kind === 'datetime-local') { await loc.fill(String(value)); await h.beat(250); return }
  await loc.fill('')
  if (S.slow) await loc.pressSequentially(String(value), { delay: 55 })
  else await loc.fill(String(value))
  await h.beat(250)
}

// The toast after a save, if any.
h.toast = async () => {
  await h.sleep(600)
  return page.evaluate(() => [...document.querySelectorAll('[data-sonner-toast],[role=status],[role=alert]')].map((e) => e.innerText.replace(/\s+/g, ' ').trim()).filter(Boolean).join(' / '))
}


// API calls from the page, renewing the login once if the token has run out.
// The sign-in comes from the runner (E2E_EMAIL / E2E_PASSWORD), never from this file.
h.api = async (method, path, body) => page.evaluate(async ({ api, method, path, body, creds }) => {
  const call = () => fetch(`${api}/api${path}`, { method, headers: { 'content-type': 'application/json', authorization: `Bearer ${localStorage.getItem('access_token')}` }, body: body ? JSON.stringify(body) : undefined })
  let r = await call()
  if (r.status === 401) {
    const l = await fetch(`${api}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(creds) }).then((x) => x.json())
    if (l.accessToken) { localStorage.setItem('access_token', l.accessToken); localStorage.setItem('refresh_token', l.refreshToken) }
    r = await call()
  }
  const t = await r.text(); let d; try { d = JSON.parse(t) } catch { d = t }
  return { status: r.status, data: d }
}, { api: h.API, method, path, body, creds: h.creds })

// Close whatever window is open without Escape (Escape closes every window at once).
h.closeAll = async () => {
  for (let i = 0; i < 4 && (await h.dlg().count()); i++) {
    const c = h.dlg().getByRole('button', { name: /^(Close|Cancel|Later)$/ }).first()
    if (!(await c.count())) break
    await c.click().catch(() => {}); await h.sleep(500)
  }
}

// Wait up to `ms` for the open window to close after a save.
h.waitClosed = async (ms = 10000) => { const end = Date.now() + ms; while (Date.now() < end && (await h.dlg().count())) await h.sleep(400); return !(await h.dlg().count()) }

// A date counted from today in India, as a date box takes it: h.day(7) is a week on.
h.day = (offset = 0) => {
  const d = new Date(Date.now() + offset * 86400000)
  return d.toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' })
}

h.note = (k, v) => { S[k] = v; return `${k} = ${typeof v === 'string' ? v : JSON.stringify(v)}` }
return 'helpers ready, slow=' + S.slow
