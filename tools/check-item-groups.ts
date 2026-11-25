/**
 * Checks Items & Products in four tabs (Raw Materials, Semi-Finished Goods,
 * Finished Goods, Fixed Assets) against a running API and the demo database (lderp_demo)
 * only. Refuses any other database. Each run makes its own ZZTEST records,
 * named with the time. From apps/api:
 *
 *   DATABASE_URL="postgresql://postgres:demo@localhost:5433/lderp_demo?schema=ld_erp" \
 *   E2E_EMAIL=... E2E_PASSWORD=... E2E_API=http://localhost:5105/api npx tsx ../../tools/check-item-groups.ts
 */
import { prisma } from '../packages/database/src/index'

const API = (process.env.E2E_API || 'http://localhost:5101/api').replace(/\/+$/, '')

let pass = 0, fail = 0
const check = (name: string, ok: boolean, extra?: unknown) => {
  ok ? pass++ : fail++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && extra !== undefined ? `  — ${JSON.stringify(extra).slice(0, 500)}` : ''}`)
}
type Res = { status: number; body: any }
let token = ''
async function call(method: string, path: string, body?: unknown): Promise<Res> {
  const r = await fetch(`${API}${path}`, { method, headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: body === undefined ? undefined : JSON.stringify(body) })
  let j: any = null
  try { j = await r.json() } catch {}
  return { status: r.status, body: j }
}
const okay = (r: Res) => r.status >= 200 && r.status < 300

interface Main { id: string; name: string; itemGroup: string; total: number; direct: number; processes: Array<{ name: string }>; subs: Array<{ id: string; name: string; count: number; process: { name: string } | null }> }
interface Group { group: string; count: number; categories: Main[] }
const tree = async () => (await call('GET', '/masters/items/groups?active=true')).body.data.groups as Group[]
const total = async (q: string) => (await call('GET', `/masters/items?limit=1&active=true&${q}`)).body.pagination.total as number

async function main() {
  const email = process.env.E2E_EMAIL
  const password = process.env.E2E_PASSWORD
  if (!email || !password) { console.error('Set E2E_EMAIL and E2E_PASSWORD.'); process.exitCode = 2; return }
  const [{ current_database: dbName }] = await prisma.$queryRaw<{ current_database: string }[]>`select current_database()`
  if (dbName !== 'lderp_demo') { console.error('Refusing to run: not lderp_demo.'); process.exitCode = 2; return }
  token = (await fetch(`${API}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password }) }).then((r) => r.json())).accessToken
  if (!token) throw new Error('login failed')
  const stamp = Date.now().toString().slice(-6)

  // The four tabs, and their figures agree with the list.
  let groups = await tree()
  check('four tabs, in order', groups.map((g) => g.group).join() === 'RAW_MATERIALS,SEMI_FINISHED,FINISHED_GOODS,FIXED_ASSETS', groups.map((g) => g.group))
  for (const g of groups) {
    check(`${g.group}: the tab's figure is the list's`, g.count === (await total(`group=${g.group}`)), { tab: g.count })
    for (const m of g.categories) {
      check(`${g.group} › ${m.name}: its figure is the list's`, m.total === (await total(`group=${g.group}&categoryId=${m.id}`)), { chip: m.total })
    }
  }
  const byGroup = Object.fromEntries(groups.map((g) => [g.group, g]))
  check('each tab is one category of its own name', ['Raw Materials', 'Semi-Finished Goods', 'Finished Goods', 'Fixed Assets'].every((n, i) => groups[i].categories.length === 1 && groups[i].categories[0].name === n), groups.map((g) => g.categories.map((c) => c.name)))
  const mains = await prisma.itemCategory.findMany({ where: { parentId: null, isActive: true }, select: { name: true } })
  check('no other main category but the expense heads\'', mains.every((m) => ['Raw Materials', 'Semi-Finished Goods', 'Finished Goods', 'Fixed Assets'].includes(m.name) || /expense/i.test(m.name)), mains.map((m) => m.name))
  check('no active item is filed in a switched-off category', (await prisma.item.count({ where: { isActive: true, category: { isActive: false } } })) === 0)
  const rawSubs = byGroup.RAW_MATERIALS.categories[0].subs
  check('Raw Materials: Fabric (cutting) first, Packing Material last', rawSubs[0]?.name === 'Fabric' && rawSubs[rawSubs.length - 1]?.name === 'Packing Material', rawSubs.map((c) => c.name))
  check('Fabric is for Cutting', rawSubs[0]?.process?.name === 'Cutting', rawSubs[0]?.process)
  const semi = byGroup.SEMI_FINISHED.categories[0]
  check('Semi-Finished starts with Cut Panels, Fused Parts, Embroidered Panels, Washed Garments', ['Cut Panels', 'Fused Parts', 'Embroidered Panels', 'Washed Garments'].every((n) => semi?.subs.some((s) => s.name === n)), semi?.subs.map((s) => s.name))
  check('Cut Panels is for Cutting', semi?.subs.find((s) => s.name === 'Cut Panels')?.process?.name === 'Cutting')
  const fg = byGroup.FINISHED_GOODS.categories
  check('Finished Goods holds only finished goods', fg.length > 0 && (await total('group=FINISHED_GOODS&type=RAW_MATERIAL,TRIM,PACKING_MATERIAL,CONSUMABLE,SEMI_FINISHED')) === 0)
  check('expense heads are in no tab', !groups.some((g) => g.categories.some((m) => /expense/i.test(m.name))))
  const all = await total('')
  check('every active item is in a tab or is an expense head', groups.reduce((n, g) => n + g.count, 0) + (await total('group=EXPENSES')) === all, { all })

  // An item has to fit its category's tab.
  const units = (await call('GET', '/masters/uoms?limit=100')).body.data as Array<{ id: string; symbol: string }>
  const pcs = units.find((u) => u.symbol === 'pcs')!
  const shirts = fg[0].subs.find((s) => s.name === 'Shirts')!
  const wrong = await call('POST', '/masters/items', { name: `ZZTEST Trim ${stamp}`, type: 'TRIM', categoryId: shirts.id, uomId: pcs.id })
  check('a trim under Shirts is refused, on the type box', wrong.status === 400 && wrong.body?.errors?.[0]?.path?.[0] === 'type' && /Finished Goods/.test(wrong.body.errors[0].message), wrong.body)
  const folded = await prisma.itemCategory.findFirst({ where: { isActive: false, parent: { parentId: { not: null } } }, select: { id: true, name: true } })
  if (folded) {
    const intoFolded = await call('POST', '/masters/items', { name: `ZZTEST Folded ${stamp}`, type: 'RAW_MATERIAL', categoryId: folded.id, uomId: pcs.id })
    check(`nothing can be filed under ${folded.name}, folded in`, intoFolded.status === 400 && intoFolded.body?.errors?.[0]?.path?.[0] === 'categoryId' && /folded into/.test(intoFolded.body.errors[0].message), intoFolded.body)
  }
  const cutPanels = semi.subs.find((s) => s.name === 'Cut Panels')!
  const panel = await call('POST', '/masters/items', { name: `ZZTEST Panel ${stamp}`, type: 'SEMI_FINISHED', categoryId: cutPanels.id, uomId: pcs.id })
  check('a semi-finished item under Cut Panels is saved', okay(panel), panel.body)
  groups = await tree()
  const semiAfter = groups.find((g) => g.group === 'SEMI_FINISHED')!
  check('it counts in Semi-Finished and in Cut Panels', semiAfter.count === byGroup.SEMI_FINISHED.count + 1 && semiAfter.categories[0].subs.find((s) => s.name === 'Cut Panels')!.count === cutPanels.count + 1)
  const asRaw = await call('PATCH', `/masters/items/${panel.body.data.id}`, { type: 'RAW_MATERIAL' })
  check('it cannot turn into a raw material under Cut Panels', asRaw.status === 400 && asRaw.body?.errors?.[0]?.path?.[0] === 'type', asRaw.body)
  const rated = await call('PATCH', `/masters/items/${panel.body.data.id}`, { standardRate: 12.5 })
  check('its rate can still be changed', okay(rated), rated.body)

  // Categories: a sub-category follows its main one; a main one's tab is picked or from its name.
  const fgMain = fg[0]
  const sub = await call('POST', '/masters/item-categories', { name: `ZZTEST Kidswear ${stamp}`, parentId: fgMain.id, itemGroup: 'RAW_MATERIALS' })
  check('a sub-category under Finished Goods is under Finished Goods, whatever was sent', okay(sub) && sub.body.data.itemGroup === 'FINISHED_GOODS', sub.body)
  const plain = await call('POST', '/masters/item-categories', { name: `ZZTEST Plain ${stamp}` })
  check('a fifth main category is refused, on the Category box', plain.status === 400 && plain.body?.errors?.[0]?.path?.[0] === 'parentId' && /four categories/.test(plain.body.errors[0].message), plain.body)
  const promoted = await call('PATCH', `/masters/item-categories/${sub.body.data.id}`, { parentId: null })
  check('a sub-category cannot be made a main category', promoted.status === 400 && promoted.body?.errors?.[0]?.path?.[0] === 'parentId', promoted.body)
  const expenses = await call('POST', '/masters/item-categories', { name: `ZZTEST Expenses ${stamp}` })
  check('the expense heads can still have their own category', okay(expenses) && expenses.body.data.itemGroup === 'EXPENSES', expenses.body)
  const rawSub = await call('POST', '/masters/item-categories', { name: `ZZTEST Buckles ${stamp}`, parentId: byGroup.RAW_MATERIALS.categories[0].id })
  check('a new sub-category under Raw Materials is under Raw Materials', okay(rawSub) && rawSub.body.data.itemGroup === 'RAW_MATERIALS', rawSub.body)
  const semiMain = byGroup.SEMI_FINISHED.categories[0]
  const refused = await call('PATCH', `/masters/item-categories/${semiMain.id}`, { itemGroup: 'FINISHED_GOODS' })
  check('a main category holding items that would not fit cannot change tab', refused.status === 400 && /cannot take/.test(refused.body?.errors?.[0]?.message ?? ''), refused.body)

  // Tidy: switch off what this run made.
  await call('DELETE', `/masters/items/${panel.body.data.id}`)
  for (const id of [sub.body?.data?.id, expenses.body?.data?.id, rawSub.body?.data?.id]) if (id) await call('DELETE', `/masters/item-categories/${id}`)

  console.log(`\n${pass} passed, ${fail} failed`)
  if (fail) process.exitCode = 1
}

main()
  .catch((e) => { console.error(e); process.exitCode = 1 })
  .finally(() => prisma.$disconnect())
