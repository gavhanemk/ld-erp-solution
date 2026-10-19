// Runs every API scenario suite in turn against the demo, then a summary table.
//   npm run test:api                 all seven
//   npm run test:api -- cgrn itc04   only the suites whose file name holds one of these words
// Exits non-zero when any check failed or any suite stopped early.
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { required } from '../lib/demo.mjs'

// The order matters on a fresh demo: later suites find what earlier ones made.
const SUITES = [
  ['e2e-jobwork-test.mjs', 'Job-work order end to end'],
  ['jw-e2e-test.mjs', 'Job work out and back'],
  ['cgrn-test.mjs', 'Customer GRN controls'],
  ['cgrn-cut-test.mjs', 'Cutting with mixed owners'],
  ['cgrn-import-test.mjs', 'Customer GRN sheet import'],
  ['itc04-test.mjs', 'ITC-04 reports'],
  ['sales-test.mjs', 'Sales, quotation to cash'],
]

required('E2E_EMAIL', 'the sign-in for the tests')
required('E2E_PASSWORD', 'the sign-in for the tests')
const only = process.argv.slice(2)
const plan = only.length ? SUITES.filter(([f]) => only.some((w) => f.includes(w))) : SUITES
if (!plan.length) { console.error(`No suite matches ${only.join(', ')}`); process.exit(2) }

const runOne = (file) =>
  new Promise((resolve) => {
    const child = spawn(process.execPath, [fileURLToPath(new URL(`./${file}`, import.meta.url))], { stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    child.stdout.on('data', (d) => { out += d; process.stdout.write(d) })
    child.stderr.on('data', (d) => { out += d; process.stderr.write(d) })
    child.on('close', (code) => resolve({ code, out }))
  })

const results = []
for (const [file, title] of plan) {
  console.log(`\n━━ ${title} (${file}) ━━`)
  const t0 = Date.now()
  const { code, out } = await runOne(file)
  const m = out.match(/(\d+) passed, (\d+) failed(?:, (\d+) skipped)?\s*$/m)
  results.push({
    title, file, code,
    passed: m ? Number(m[1]) : 0,
    failed: m ? Number(m[2]) : 0,
    skipped: m?.[3] ? Number(m[3]) : 0,
    finished: !!m,
    secs: ((Date.now() - t0) / 1000).toFixed(0),
  })
}

const pad = (s, n) => String(s).padEnd(n)
const num = (s, n) => String(s).padStart(n)
console.log(`\n${pad('Suite', 30)}${num('Passed', 8)}${num('Failed', 8)}${num('Skipped', 9)}  Result`)
console.log('─'.repeat(70))
for (const r of results) {
  const result = !r.finished ? `stopped early (exit ${r.code})` : r.failed || r.code ? 'FAILED' : 'ok'
  console.log(`${pad(r.title, 30)}${num(r.passed, 8)}${num(r.failed, 8)}${num(r.skipped, 9)}  ${result} · ${r.secs}s`)
}
const total = (k) => results.reduce((s, r) => s + r[k], 0)
console.log('─'.repeat(70))
console.log(`${pad('All suites', 30)}${num(total('passed'), 8)}${num(total('failed'), 8)}${num(total('skipped'), 9)}`)
const bad = results.filter((r) => !r.finished || r.failed || r.code)
console.log(bad.length ? `\n${bad.length} of ${results.length} suites did not pass: ${bad.map((r) => r.file).join(', ')}` : `\nAll ${results.length} suites passed.`)
process.exit(bad.length ? 1 : 0)
