// The browser walk-through: one LD Cotton Mills order made end to end in the
// real web app on the demo — item, BOM, quotation, order, MO, indent, PO, GRN,
// QC, issue, routing, every production stage (stitching at an outside unit),
// finished goods, dispatch, invoice, Track & Trace.
//
//   npm run test:walk                         headless, full speed
//   npm run test:walk -- --headed             in a Chrome window
//   SLOW=1 npm run test:walk -- --headed      at a watchable pace, with captions
//   npm run test:walk -- show                 which order to make (browser/configs.mjs; default "show")
//
// It makes a NEW item, BOM and routing for its style, so it runs once per
// freshly reset demo database: it stops before starting if the style already
// has a BOM or a routing. It uses the installed Google Chrome (channel
// "chrome"); no browser download is needed. Each file in steps/ is the body
// of an async function with page, ctx, h, S and browser in scope. The run
// stops at the first step that fails and says which.
import { chromium } from 'playwright'
import { readFileSync, mkdirSync, appendFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { API as API_BASE, WEB, demoDb, adminLogin, required } from '../lib/demo.mjs'
import { configs } from './configs.mjs'

const args = process.argv.slice(2)
const headed = args.includes('--headed')
const which = args.find((a) => !a.startsWith('--')) ?? 'show'
const cfg = configs[which]
if (!cfg) { console.error(`No config "${which}" in browser/configs.mjs (have: ${Object.keys(configs).join(', ')})`); process.exit(2) }
const slow = Number(process.env.SLOW ?? 0)
const email = required('E2E_EMAIL', 'the sign-in for the walk')
const password = required('E2E_PASSWORD', 'the sign-in for the walk')
// The steps call `${h.API}/api/...`: the API's origin, without /api.
const API = API_BASE.replace(/\/api$/, '')
const DIR = fileURLToPath(new URL('.', import.meta.url))
const STEPS = `${DIR}steps/`
const LOG = `${DIR}walk-${which}.log`
mkdirSync(`${DIR}shots`, { recursive: true })

const stop = (msg) => { console.error(msg); process.exit(2) }

// ── Before anything is written: the demo database, its style, and an API using it ──
const db = await demoDb()
const style = (await db.query(`SELECT id, code, name, "brandType"::text AS brand FROM styles WHERE code = $1`, [cfg.styleCode])).rows[0]
if (!style) stop(`Style ${cfg.styleCode} is not in the demo database. Copy the masters first ("npm run db:copy-masters").`)
if (style.brand !== 'LD_COTTON_MILLS' || /vhagar/i.test(`${style.name} ${cfg.styleName} ${cfg.customer}`)) stop(`The walk runs only on LD Cotton Mills styles, never VHAGAR: ${cfg.styleCode} is ${style.brand}.`)
const boms = Number((await db.query(`SELECT COUNT(*)::int n FROM bom WHERE "styleId" = $1`, [style.id])).rows[0].n)
const routings = Number((await db.query(`SELECT COUNT(*)::int n FROM routings WHERE "styleId" = $1`, [style.id])).rows[0].n)
if (boms || routings)
  stop(
    `${cfg.styleCode} ${cfg.styleName} already has ${[boms ? `${boms} BOM${boms > 1 ? 's' : ''}` : '', routings ? `${routings} routing${routings > 1 ? 's' : ''}` : ''].filter(Boolean).join(' and ')}.\n` +
      'The walk makes a new item, BOM and routing for its style, so it needs a freshly reset demo database ("npm run db:reset"),\n' +
      'or a config in browser/configs.mjs for a style with no BOM or routing yet.',
  )
await adminLogin(db) // proves the API writes to this demo database

// ── The browser, and the helpers every step uses (as the old pw-server built them) ──
const browser = await chromium.launch({ channel: 'chrome', headless: !headed, args: headed ? ['--start-maximized'] : [] })
const ctx = await browser.newContext(headed ? { viewport: null } : { viewport: { width: 1500, height: 900 } })
const page = await ctx.newPage()
const S = {}
const errors = []
page.on('dialog', (d) => { errors.push('confirm: ' + d.message().slice(0, 120)); d.accept().catch(() => {}) })
ctx.on('page', (p) => p.on('dialog', (d) => d.accept().catch(() => {})))
process.on('unhandledRejection', (e) => errors.push('unhandled: ' + (e?.message ?? e)))
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message))
page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text().slice(0, 300)) })
page.on('response', (r) => { if (r.url().startsWith(API) && r.status() >= 400) errors.push(`HTTP ${r.status()} ${r.request().method()} ${r.url().replace(API, '')}`) })

// A short, readable picture of what is on screen: the open dialog if there is one, else the main page.
const describe = async (scope) => page.evaluate((scopeSel) => {
  const vis = (el) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none' }
  const dialogs = [...document.querySelectorAll('[role=dialog],[role=alertdialog]')].filter(vis)
  const root = scopeSel ? document.querySelector(scopeSel) : (dialogs[dialogs.length - 1] || document.querySelector('main') || document.body)
  if (!root) return 'no root'
  const txt = (el) => (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim()
  const out = []
  out.push(`URL ${location.pathname}${location.search}${dialogs.length ? `  [dialog x${dialogs.length}]` : ''}`)
  for (const h of root.querySelectorAll('h1,h2,h3,h4')) if (vis(h)) out.push(`# ${txt(h).slice(0, 90)}`)
  const labelOf = (el) => {
    if (el.getAttribute('aria-label')) return el.getAttribute('aria-label')
    if (el.id) { const l = document.querySelector(`label[for="${el.id}"]`); if (l) return txt(l) }
    const l = el.closest('label'); if (l) return txt(l).slice(0, 40)
    const p = el.parentElement?.parentElement; const lab = p?.querySelector('label'); if (lab) return txt(lab).slice(0, 40)
    return el.getAttribute('placeholder') || el.name || ''
  }
  const fields = []
  for (const el of root.querySelectorAll('input,select,textarea,[role=combobox]')) {
    if (!vis(el) || el.type === 'hidden') continue
    let v = el.tagName === 'SELECT' ? (el.selectedOptions[0]?.text ?? '') : (el.type === 'checkbox' ? (el.checked ? '☑' : '☐') : (el.value ?? txt(el)))
    fields.push(`[${el.tagName.toLowerCase()}${el.type && el.tagName === 'INPUT' ? ':' + el.type : ''}] ${labelOf(el)} = ${String(v).slice(0, 50)}${el.disabled ? ' (disabled)' : ''}`)
  }
  if (fields.length) out.push('FIELDS: ' + fields.slice(0, 60).join(' ; '))
  const btns = [...root.querySelectorAll('button,a[href],[role=tab]')].filter(vis).map((b) => {
    const t = txt(b).slice(0, 40) || b.getAttribute('aria-label') || b.getAttribute('title') || ''
    return t + (b.disabled ? '(off)' : '') + (b.getAttribute('role') === 'tab' ? '(tab)' : '')
  }).filter(Boolean)
  out.push('BUTTONS: ' + [...new Set(btns)].slice(0, 90).join(' | '))
  const tables = [...root.querySelectorAll('table')].filter(vis)
  for (const t of tables.slice(0, 3)) {
    const head = [...t.querySelectorAll('thead th')].map(txt).join(' · ')
    const rows = [...t.querySelectorAll('tbody tr')].slice(0, 6).map((r) => [...r.children].map((c) => txt(c).slice(0, 28)).join(' · '))
    out.push(`TABLE (${t.querySelectorAll('tbody tr').length} rows) ${head}\n   ` + rows.join('\n   '))
  }
  const alerts = [...document.querySelectorAll('[role=alert],[data-sonner-toast],.toast')].filter(vis).map(txt)
  if (alerts.length) out.push('TOAST: ' + alerts.join(' / ').slice(0, 300))
  return out.join('\n')
}, scope)

const h = {
  WEB, API, describe,
  creds: { email, password },
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  async login() {
    await page.goto(`${WEB}/login`)
    const ok = await page.evaluate(async ({ api, creds }) => {
      const r = await fetch(`${api}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(creds) })
      const d = await r.json()
      if (!d.accessToken) return false
      localStorage.setItem('access_token', d.accessToken); localStorage.setItem('refresh_token', d.refreshToken); localStorage.setItem('user', JSON.stringify(d.user)); localStorage.setItem('theme', 'light')
      return true
    }, { api: API, creds: h.creds })
    if (!ok) throw new Error(`sign-in refused for ${email}`)
  },
  async api(method, path, body) {
    return page.evaluate(async ({ api, method, path, body }) => {
      const r = await fetch(`${api}/api${path}`, { method, headers: { 'content-type': 'application/json', authorization: `Bearer ${localStorage.getItem('access_token')}` }, body: body ? JSON.stringify(body) : undefined })
      const t = await r.text(); let d; try { d = JSON.parse(t) } catch { d = t }
      return { status: r.status, data: d }
    }, { api: API, method, path, body })
  },
  async shot(name, full = false) { const p = `${DIR}shots/${name}.png`; await page.screenshot({ path: p, fullPage: full }); return p },
  errors: () => errors.splice(0),
}

const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor
// Runs one step's text, as the old pw-server did: its answer, then any errors seen meanwhile.
const runStep = async (body) => {
  let out
  try {
    const fn = new AsyncFunction('page', 'ctx', 'h', 'S', 'browser', body)
    const r = await fn(page, ctx, h, S, browser)
    out = typeof r === 'string' ? r : JSON.stringify(r, null, 1)
  } catch (e) { out = 'ERROR ' + (e.message || e).toString().split('\n').slice(0, 8).join('\n') }
  const errs = h.errors()
  if (errs.length) out += '\n!! ' + errs.slice(0, 8).join('\n!! ')
  return (out ?? 'ok').trim()
}
const step = (file) => readFileSync(STEPS + file, 'utf8')
const finish = async (code) => { await browser.close().catch(() => {}); await db.end().catch(() => {}); process.exit(code) }

// The order of the walk.
const plan = [
  ['01-item.js'], ['02-bom-materials.js'], ['03-bom-costing.js'], ['04-bom-price.js'],
  ['05-quotation.js'], ['06-convert.js'], ['07-so.js'], ['08-mo.js'], ['09-raise-mr.js'],
  ['10-approve-indent.js'], ['11-po.js'], ['12-grn.js'], ['13-qc.js'], ['14-issue.js'],
  ['15-routing.js'], ['16-stages.js'], ['16b-jobcard.js'],
  ['17-stage-open.js', { tab: 'Cutting', caption: 'Step 14 · Production Stages — every process is a tab; this job card waits on Cutting' }],
  ['18-cut-issue.js'], ['19-cut-receive.js'],
  ['20-send.js', { dest: 'Fusing', unit: null, issuedBy: 'Ramesh (cutting)', caption: 'Step 15 · Process transfer — the 4 bundles go from Cutting to Fusing; a transfer card prints for Fusing' }],
  ['17-stage-open.js', { tab: 'Fusing', caption: 'Step 15 · Fusing counts the bundles in, as sent' }],
  ['21-countin.js', { receivedBy: 'Meena (fusing)' }],
  ['22-work.js', { caption: 'Step 15 · Fusing — record the work: all 60 fused', doneBy: 'Meena (fusing)' }],
  ['20-send.js', { dest: 'Stitching', unit: cfg.unit, due: new Date(Date.now() + 7 * 86400000).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' }), issuedBy: 'Meena (fusing)', caption: `Step 16 · Job work — the 60 fused pieces go out to ${cfg.unit} on a job-work challan, ₹45 a piece` }],
  ['17-stage-open.js', { tab: 'Stitching', caption: null }],
  ['23-vendor-back.js'],
  ['20-send.js', { dest: 'Kaj Button', unit: null, issuedBy: 'Suresh (stitching)', caption: 'Step 18 · Process transfer — the stitched pieces go to Kaj Button for buttonholes and buttons' }],
  ['17-stage-open.js', { tab: 'Kaj Button', caption: 'Step 18 · Kaj Button counts them in' }],
  ['21-countin.js', { receivedBy: 'Anil (kaj button)' }],
  ['20-send.js', { dest: 'Final QC', unit: null, issuedBy: 'Anil (kaj button)', caption: 'Step 18 · Buttons done — on to Final QC' }],
  ['17-stage-open.js', { tab: 'Final QC', caption: 'Step 19 · Final QC counts them in' }],
  ['21-countin.js', { receivedBy: 'Kavita (QC)' }],
  ['22-work.js', { caption: 'Step 19 · Final QC — every piece checked: all 60 passed', doneBy: 'Kavita (QC)' }],
  ['20-send.js', { dest: 'Packing', unit: null, issuedBy: 'Kavita (QC)', caption: 'Step 20 · Final QC → Packing — the same department, so they are counted in at once, no card' }],
  ['17-stage-open.js', { tab: 'Packing', caption: null }],
  ['22-work.js', { caption: 'Step 20 · Packing — each piece folded, labelled and poly-bagged: all 60 packed', doneBy: 'Rekha (packing)' }],
  ['24-fg.js'], ['25-dispatch.js'], ['26-invoice.js'], ['27-trace.js'],
]

const started = Date.now()
appendFileSync(LOG, `\n=== ${which} ${new Date().toISOString()} slow=${slow} headed=${headed}\n`)
console.log(`walk "${which}": ${cfg.styleCode} ${cfg.styleName}, ${cfg.colour} — web ${WEB}, api ${API_BASE}`)
S.slow = slow
S.cfg = cfg
console.log(await runStep(step('00-helpers.js')))

// Sign in, then make sure the web app talks to this API (and so to the demo database).
try { await h.login() } catch (e) { console.error(`Cannot sign in through the web at ${WEB}: ${e.message}`); await finish(2) }
let webUsesApi = false
const seen = (r) => { if (r.url().startsWith(`${API}/api/`)) webUsesApi = true }
page.on('request', seen)
try { await page.goto(`${WEB}/masters/items`); await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {}) } catch (e) { console.error(`Cannot open the web app at ${WEB}: ${e.message}`); await finish(2) }
page.off('request', seen)
if (!webUsesApi) { console.error(`The web app at ${WEB} did not call the API at ${API_BASE}: start it with NEXT_PUBLIC_API_URL=${API_BASE}.`); await finish(2) }
h.errors()
console.log('signed in; the web app uses the demo API')

for (let i = 0; i < plan.length; i++) {
  const [file, set] = plan[i]
  if (set) Object.assign(S, set)
  const t0 = Date.now()
  const out = await runStep(step(file))
  const line = `[${i}] ${file} (${((Date.now() - t0) / 1000).toFixed(1)}s) ${out.split('\n').filter((l) => !l.startsWith('!! HTTP 401') && !/401 \(Unauthorized\)/.test(l)).join('\n    ')}`
  console.log(line)
  appendFileSync(LOG, line + '\n')
  if (out.startsWith('ERROR') || /STILL OPEN|UNEXPECTED|DIALOG /.test(out)) {
    const shot = await h.shot(`failed-${String(i).padStart(2, '0')}-${file.replace(/\.js$/, '')}`).catch(() => null)
    console.log(`\nFAILED at step [${i}] ${file}${shot ? ` — screenshot: ${shot}` : ''}`)
    await finish(1)
  }
}
console.log(`\nall ${plan.length} steps done in ${((Date.now() - started) / 60000).toFixed(1)} min`)
await finish(0)
