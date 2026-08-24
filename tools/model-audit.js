/**
 * Audits every Prisma model: how it relates to the rest of the schema, whether
 * any API code touches it, whether the web app mentions it, and whether it is
 * seeded. The point is to find models that exist on paper and nowhere else.
 */
const fs = require('fs')
const path = require('path')

// Run from anywhere: `node tools/model-audit.js`
const ROOT = path.resolve(__dirname, '..')
const schema = fs.readFileSync(path.join(ROOT, 'packages/database/prisma/schema.prisma'), 'utf8')

const models = {}
for (const m of schema.matchAll(/^model\s+(\w+)\s*\{([\s\S]*?)^\}/gm)) {
  const fields = []
  for (const line of m[2].split('\n')) {
    const t = line.trim()
    if (!t || t.startsWith('//') || t.startsWith('/') || t.startsWith('@@')) continue
    const fm = t.match(/^(\w+)\s+(\w+)(\[\])?(\?)?/)
    if (fm) fields.push({ name: fm[1], type: fm[2], list: !!fm[3], opt: !!fm[4], raw: t })
  }
  models[m[1]] = { name: m[1], fields, body: m[2] }
}

const names = Object.keys(models)
const isModel = (t) => names.includes(t)

function readAll(dir, exts) {
  const acc = []
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name)
      if (e.isDirectory()) {
        if (!/node_modules|\.next|dist/.test(e.name)) walk(p)
      } else if (exts.some((x) => e.name.endsWith(x))) {
        acc.push({ p: p.replace(ROOT, '').replace(/\\/g, '/'), src: fs.readFileSync(p, 'utf8') })
      }
    }
  }
  walk(dir)
  return acc
}

const apiFiles = readAll(path.join(ROOT, 'apps/api/src'), ['.ts'])
const webFiles = readAll(path.join(ROOT, 'apps/web/src'), ['.ts', '.tsx'])
const seed = fs.readFileSync(path.join(ROOT, 'packages/database/prisma/seed.ts'), 'utf8')

// The CRUD factory reaches its models through a dynamic delegate, so a plain
// `prisma.<model>` search reports them as untouched when they are fully served.
const factoryServed = new Set(
  apiFiles
    .flatMap((f) => [...f.src.matchAll(/model:\s*'(\w+)'/g)])
    .map((m) => m[1].charAt(0).toUpperCase() + m[1].slice(1)),
)

// Line and child tables are written through their parent's nested create, which
// is the correct pattern — they are not orphans just because no delegate names them.
const nestedWrite = new Set()
for (const n of names) {
  const child = n.charAt(0).toLowerCase() + n.slice(1)
  const rel = names.some((parent) =>
    models[parent].fields.some((f) => f.type === n && f.list),
  )
  if (rel) nestedWrite.add(n)
  void child
}

const rows = []
for (const n of names) {
  const m = models[n]
  const delegate = n.charAt(0).toLowerCase() + n.slice(1)
  const use = new RegExp('(?:prisma|tx)\\.' + delegate + '(?![A-Za-z0-9_])')

  const apiIn = apiFiles.filter((f) => use.test(f.src))
  const webIn = webFiles.filter((f) => new RegExp('\\b' + n + '\\b').test(f.src))

  const factory = factoryServed.has(n)
  rows.push({
    model: n,
    fields: m.fields.length,
    outRel: m.fields.filter((f) => isModel(f.type)).length,
    inRel: names.filter((o) => o !== n && models[o].fields.some((f) => f.type === n)).length,
    api: apiIn.length,
    apiWhere: factory && !apiIn.length ? 'crud factory' : apiIn.map((f) => f.p.split('/').pop()).join(','),
    reachable: apiIn.length > 0 || factory,
    child: nestedWrite.has(n),
    web: webIn.length,
    seeded: use.test(seed),
  })
}

const pad = (s, n) => String(s).padEnd(n)
console.log(pad('MODEL', 25) + pad('fld', 4) + pad('out', 4) + pad('in', 4) + pad('API', 4) + pad('WEB', 4) + pad('SEED', 6) + 'API FILES')
console.log('-'.repeat(100))

const unreachable = []
const childOnly = []
for (const r of rows.sort((a, b) => Number(a.reachable) - Number(b.reachable) || a.model.localeCompare(b.model))) {
  console.log(
    pad(r.model, 25) + pad(r.fields, 4) + pad(r.outRel, 4) + pad(r.inRel, 4) +
    pad(r.api, 4) + pad(r.web, 4) + pad(r.seeded ? 'yes' : '-', 6) + r.apiWhere,
  )
  if (!r.reachable) (r.child ? childOnly : unreachable).push(r.model)
}

console.log(
  '\n=== NO WAY TO REACH THESE FROM THE API (' + unreachable.length + '/' + names.length + ') ===',
)
console.log(unreachable.join(', ') || '  none')
console.log(
  '\n=== CHILD TABLES, written through a parent (' + childOnly.length + ') ===\n' +
    'These are only reachable once their parent has a create path.',
)
console.log(childOnly.join(', ') || '  none')

// Relations that point one way only — a foreign key with no matching back-relation
console.log('\n=== ONE-WAY RELATIONS (declared on one side only) ===')
for (const n of names) {
  for (const f of models[n].fields) {
    if (!isModel(f.type)) continue
    const back = models[f.type].fields.some((g) => g.type === n)
    if (!back) console.log('  ' + n + '.' + f.name + ' -> ' + f.type + '   (no field of type ' + n + ' on ' + f.type + ')')
  }
}

// Free-text columns that should almost certainly be foreign keys
console.log('\n=== TEXT FIELDS THAT LOOK LIKE THEY SHOULD BE RELATIONS ===')
const suspicious = /^(department|lineNumber|category|operation|process|workstation|status|brand|style|color|size|unit|uom|state|paymentMode)$/i
for (const n of names) {
  for (const f of models[n].fields) {
    if (f.type === 'String' && suspicious.test(f.name)) {
      console.log('  ' + pad(n + '.' + f.name, 40) + f.raw.trim())
    }
  }
}
