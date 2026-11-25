/**
 * Checks fixed assets: their own tab and category, opening stock under Fixed
 * Assets with one asset tag per unit and its serial number, kept in a store or
 * at a department, moved between them with the tag, never issued, never in
 * closing stock or work in progress — against a running API and the demo
 * database (lderp_demo) only. Refuses any other database. Each run makes its
 * own ZZTEST records. From apps/api:
 *
 *   DATABASE_URL="postgresql://postgres:demo@localhost:5433/lderp_demo?schema=ld_erp" \
 *   E2E_EMAIL=... E2E_PASSWORD=... E2E_API=http://localhost:5105/api npx tsx ../../tools/check-fixed-assets.ts
 */
import ExcelJS from 'exceljs'
import { prisma } from '../packages/database/src/index'
import { inventoryValue } from '../apps/api/src/services/accounts/finalAccounts.service'

const API = (process.env.E2E_API || 'http://localhost:5101/api').replace(/\/+$/, '')
const HEADS = {
  FA: ['Asset Category', 'Item Code', 'Item Name', 'Serial Numbers', 'Quantity', 'Cost Each', 'Location', 'Stock Status', 'Remarks', 'HSN Code', 'GST %'],
  RM: ['Material Category', 'Item Code', 'Item Name', 'Lot / Batch / Roll Number', 'Bundle / Barcode Number', 'UOM', 'Opening Quantity', 'Unit Rate', 'Location', 'Package Type', 'Package Count', 'Qty per Package', 'Package Quantities', 'Package References', 'Stock Status', 'Remarks', 'HSN Code', 'GST %'],
} as const
type K = keyof typeof HEADS
const SHEET: Record<K, string> = { FA: 'Fixed Assets', RM: 'Raw Materials' }

let pass = 0, fail = 0
const check = (name: string, ok: boolean, extra?: unknown) => {
  ok ? pass++ : fail++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && extra !== undefined ? `  — ${JSON.stringify(extra).slice(0, 700)}` : ''}`)
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

async function template(kind: K) {
  const res = await fetch(`${API}/inventory/opening-stock/import-template?type=${kind}`, { headers: { authorization: `Bearer ${token}` } })
  const wb = new ExcelJS.Workbook()
  await wb.xlsx.load(Buffer.from(await res.arrayBuffer()) as unknown as ExcelJS.Buffer)
  return wb
}
async function sheet(kind: K, rows: Array<Partial<Record<string, string | number>>>, name: string) {
  const wb = await template(kind)
  const ws = wb.getWorksheet(SHEET[kind])!
  const heads = HEADS[kind] as readonly string[]
  ws.spliceRows(2, 1)
  rows.forEach((r, i) => heads.forEach((h, c) => { if (r[h] !== undefined) ws.getCell(i + 2, c + 1).value = r[h] as string | number }))
  return { fileName: `${name}.xlsx`, file: Buffer.from(await wb.xlsx.writeBuffer()).toString('base64') }
}
const rowOf = (r: Res, n: number) => ((r.body?.data?.rows ?? []) as any[]).find((x) => x.row === n)
const problemsOf = (r: Res, n: number) => (rowOf(r, n)?.problems ?? []).join(' | ')
const balance = async (itemId: string, warehouseId: string) => {
  const a = await prisma.stockLedger.aggregate({ where: { itemId, warehouseId }, _sum: { inQty: true, outQty: true } })
  return Number(a._sum.inQty ?? 0) - Number(a._sum.outQty ?? 0)
}

async function main() {
  const email = process.env.E2E_EMAIL
  const password = process.env.E2E_PASSWORD
  if (!email || !password) { console.error('Set E2E_EMAIL and E2E_PASSWORD.'); process.exitCode = 2; return }
  const [{ current_database: dbName }] = await prisma.$queryRaw<{ current_database: string }[]>`select current_database()`
  if (dbName !== 'lderp_demo') { console.error('Refusing to run: not lderp_demo.'); process.exitCode = 2; return }
  token = (await fetch(`${API}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password }) }).then((r) => r.json())).accessToken
  if (!token) throw new Error('login failed')
  const stamp = Date.now().toString().slice(-6)
  const today = new Date(Date.now() + 330 * 60 * 1000).toISOString().slice(0, 10)

  // 1. Items & Products: Fixed Assets is the fourth tab, with its own main category.
  const groups = (await call('GET', '/masters/items/groups?active=true')).body?.data?.groups as Array<{ group: string; categories: Array<{ id: string; name: string }> }>
  const faGroup = groups?.find((g) => g.group === 'FIXED_ASSETS')
  check('Fixed Assets is a tab of Items & Products', !!faGroup, groups?.map((g) => g.group))
  const faMain = faGroup?.categories.find((c) => c.name === 'Fixed Assets')
  check('with a main category Fixed Assets', !!faMain, faGroup?.categories)
  if (!faMain) return

  // 2. A sub-category under it, and a machine in it.
  const hsn = (await prisma.hsnCode.findFirst({ where: { code: { startsWith: '8452' } }, select: { code: true } })) ?? (await prisma.hsnCode.findFirst({ select: { code: true } }))
  const sub = await call('POST', '/masters/item-categories', { name: `ZZTEST Machines ${stamp}`, parentId: faMain.id, ...(hsn ? { hsnCode: hsn.code } : {}) })
  check('a sub-category under Fixed Assets is a fixed-asset category', okay(sub) && sub.body.data.itemGroup === 'FIXED_ASSETS', sub.body)
  const units = (await call('GET', '/masters/uoms?limit=100')).body.data as Array<{ id: string; symbol: string }>
  const pcs = units.find((u) => u.symbol === 'pcs')!
  const machine = await call('POST', '/masters/items', { name: `ZZTEST Lockstitch ${stamp}`, type: 'FIXED_ASSET', categoryId: sub.body.data.id, uomId: pcs.id })
  check('a fixed asset item is saved under it', okay(machine) && machine.body.data.type === 'FIXED_ASSET', machine.body)
  const wrongType = await call('POST', '/masters/items', { name: `ZZTEST Thread ${stamp}`, type: 'RAW_MATERIAL', categoryId: sub.body.data.id, uomId: pcs.id })
  check('a raw material under it is refused, on the type box', wrongType.status === 400 && wrongType.body?.errors?.[0]?.path?.[0] === 'type', wrongType.body)
  const asset = machine.body.data as { id: string; code: string }

  // 3. Its opening stock template.
  const ws = (await template('FA')).getWorksheet(SHEET.FA)
  const heads = ((ws?.getRow(1).values as unknown[]) ?? []).slice(1).map((h) => String(h).replace(/\s*\*$/, ''))
  check('Fixed Assets template: its own columns, in order', JSON.stringify(heads) === JSON.stringify(HEADS.FA), heads)

  // 4. Checked: two at a department with serial numbers; problems said plainly.
  const dept = await prisma.department.findFirst({ where: { isActive: true, name: 'Stitching' }, select: { id: true, name: true } })
    ?? (await prisma.department.findFirstOrThrow({ where: { isActive: true }, select: { id: true, name: true } }))
  const store = await prisma.warehouse.findFirstOrThrow({ where: { isActive: true, name: 'Store' }, select: { id: true, name: true } })
  const valueBefore = await inventoryValue(prisma, today)
  const bad = await sheet('FA', [
    { 'Item Code': asset.code, 'Item Name': `ZZTEST Lockstitch ${stamp}`, 'Serial Numbers': `SN-${stamp}-1, SN-${stamp}-2`, Quantity: 2, 'Cost Each': 18500, Location: dept.name },
    { 'Item Code': asset.code, 'Item Name': `ZZTEST Lockstitch ${stamp}`, 'Serial Numbers': 'ONLY-ONE', Quantity: 2, 'Cost Each': 18500, Location: 'Store' },
    { 'Item Code': asset.code, 'Item Name': `ZZTEST Lockstitch ${stamp}`, Quantity: 1, 'Cost Each': 18500, Location: 'Store', 'Stock Status': 'B-Grade' },
  ], `fa-check-${stamp}`)
  const checked = await call('POST', '/inventory/opening-stock/import', { ...bad, kind: 'FA', openingDate: today })
  check('checked: two at the department are fine', okay(checked) && problemsOf(checked, 2) === '', rowOf(checked, 2))
  check('it says two asset tags, each with its serial number', /2 asset tags, each with its serial number/.test(rowOf(checked, 2)?.packing ?? ''), rowOf(checked, 2))
  check('it is placed on the department\'s floor', new RegExp(`${dept.name} Floor`).test(rowOf(checked, 2)?.location ?? ''), rowOf(checked, 2))
  check('one serial number for two is refused', /1 given for 2/.test(problemsOf(checked, 3)), problemsOf(checked, 3))
  check('B-Grade is refused for a fixed asset', /B-Grade is for semi-finished and finished goods only/.test(problemsOf(checked, 4)), problemsOf(checked, 4))

  // 5. Brought in: the two at the department, and a new asset made in the store.
  const good = await sheet('FA', [
    { 'Item Code': asset.code, 'Item Name': `ZZTEST Lockstitch ${stamp}`, 'Serial Numbers': `SN-${stamp}-1, SN-${stamp}-2`, Quantity: 2, 'Cost Each': 18500, Location: dept.name },
    { 'Asset Category': `ZZTEST Machines ${stamp}`, 'Item Name': `ZZTEST Cutting Table ${stamp}`, Quantity: 1, 'Cost Each': 9000, Location: 'Store' },
  ], `fa-good-${stamp}`)
  const first = await call('POST', '/inventory/opening-stock/import', { ...good, kind: 'FA', openingDate: today })
  const resolve = Object.fromEntries(((first.body?.data?.summary?.decisions ?? []) as any[]).map((d) => [d.key, 'NEW']))
  const done = await call('POST', '/inventory/opening-stock/import', { ...good, kind: 'FA', openingDate: today, confirm: true, requestKey: `fa-${stamp}-import`, resolve })
  check('brought in', okay(done), done.body)
  const os = await prisma.openingStock.findFirst({ where: { fileName: `fa-good-${stamp}.xlsx` }, select: { id: true, lines: { select: { id: true, itemId: true, warehouseId: true, qty: true } } } })
  const line = os?.lines.find((l) => l.itemId === asset.id)
  const tags = line ? await prisma.stockPackage.findMany({ where: { sourceType: 'OPENING', sourceLineId: line.id }, orderBy: { code: 'asc' }, select: { id: true, code: true, qty: true, notes: true, warehouseId: true, createdAt: true } }) : []
  check('one asset tag for each machine', tags.length === 2 && tags.every((t) => Number(t.qty) === 1), tags)
  check('each tag carries its serial number', tags.map((t) => t.notes ?? '').join() === `S/N SN-${stamp}-1,S/N SN-${stamp}-2`, tags.map((t) => t.notes))
  const floor = line ? await prisma.warehouse.findUnique({ where: { id: line.warehouseId }, select: { name: true, departmentId: true } }) : null
  check(`they are at ${dept.name}`, floor?.departmentId === dept.id, floor)
  const table = await prisma.item.findFirst({ where: { name: `ZZTEST Cutting Table ${stamp}` }, select: { id: true, code: true, type: true, categoryId: true } })
  check('the new asset is made as a fixed asset in its category', table?.type === 'FIXED_ASSET' && table.categoryId === sub.body.data.id, table)
  const tableTags = table ? await prisma.stockPackage.count({ where: { itemId: table.id, sourceType: 'OPENING' } }) : 0
  check('and gets its own tag in the Store', tableTags === 1 && !!table && (await balance(table.id, store.id)) === 1, { tableTags })

  // 6. Not stock-in-trade: closing stock and work in progress leave it out.
  const valueAfter = await inventoryValue(prisma, today)
  check('closing stock value is unchanged by ₹46,000 of machines', Math.abs(valueAfter - valueBefore) < 0.01, { valueBefore, valueAfter })
  const wip = await call('GET', '/inventory/process-stock')
  check('the machines at the department are not work in progress', okay(wip) && !JSON.stringify(wip.body).includes(asset.code), okay(wip))

  // 7. A fixed asset is entered under Fixed Assets only; only a fixed asset sits at a department.
  const rmItem = await prisma.item.findFirst({ where: { isActive: true, type: 'RAW_MATERIAL', NOT: { name: { contains: 'VHAGAR', mode: 'insensitive' } }, category: { itemGroup: 'RAW_MATERIALS' } }, select: { code: true, name: true } })
  const rmFile = await sheet('RM', [
    { 'Item Code': asset.code, 'Item Name': `ZZTEST Lockstitch ${stamp}`, 'Opening Quantity': 1, 'Unit Rate': 100, Location: 'Store' },
    ...(rmItem ? [{ 'Item Code': rmItem.code, 'Item Name': rmItem.name, 'Opening Quantity': 1, 'Unit Rate': 10, Location: dept.name }] : []),
  ], `fa-rm-${stamp}`)
  const rm = await call('POST', '/inventory/opening-stock/import', { ...rmFile, kind: 'RM', openingDate: today })
  check('a fixed asset in the Raw Materials sheet is sent to Fixed Assets', /is a fixed asset: enter it under Fixed Assets/.test(problemsOf(rm, 2)), problemsOf(rm, 2))
  if (rmItem) check('a raw material at a department is refused', /only a fixed asset is kept at a department/.test(problemsOf(rm, 3)), problemsOf(rm, 3))

  // 8. Entered by hand: one more, in the Store, its serial on its tag.
  const entry = await call('POST', '/inventory/opening-stock/entry', {
    kind: 'FA',
    confirm: true,
    requestKey: `fa-${stamp}-entry`,
    lines: [{ date: today, status: 'Fresh', process: 'Store', location: 'Store', category: `ZZTEST Machines ${stamp}`, code: asset.code, uom: 'pcs', qty: 1, rate: 19000, lot: '', bundle: '', pack: { type: 'OTHER', qtys: [1], refs: [`SN-${stamp}-3`] } }],
  })
  check('entered by hand', okay(entry), entry.body)
  const handTag = await prisma.stockPackage.findFirst({ where: { itemId: asset.id, warehouseId: store.id, status: 'IN_STOCK' }, orderBy: { createdAt: 'desc' }, select: { id: true, code: true, notes: true } })
  check('its tag carries its serial number', handTag?.notes === `S/N SN-${stamp}-3`, handTag)

  // 9. Moved with its tag: department → Store, Store → department; no FIFO for a machine.
  const atDept = tags[0]
  const back = await call('POST', `/packages/${atDept.id}/transfer`, { toWarehouseId: store.id, qty: 1 })
  check(`${atDept.code} moved from ${dept.name} to the Store`, okay(back), back.body)
  check('the Store holds two of the machine now, the department one', (await balance(asset.id, store.id)) === 2 && (await balance(asset.id, line!.warehouseId)) === 1)
  if (handTag) {
    // The hand-entered tag is newer than the one just moved in: a roll would wait its turn, a machine does not.
    const out = await call('POST', `/packages/${handTag.id}/transfer`, { toWarehouseId: line!.warehouseId, qty: 1 })
    check('the newer machine goes to the department without a FIFO block', okay(out), out.body)
  }
  const issued = await call('POST', `/packages/${tags[1].id}/issue`, { mrId: 'none', lineId: 'none', qty: 1 })
  check('a machine is never issued (used up)', issued.status === 400 && issued.body?.code === 'FIXED_ASSET', issued.body)

  // 10. The opening stock list counts them under Fixed Assets.
  const list = await call('GET', '/inventory/opening-stock/lines?group=FA&q=' + encodeURIComponent(asset.code))
  check('the opening stock list shows them under Fixed Assets', okay(list) && JSON.stringify(list.body).includes(asset.code), list.status)

  console.log(`\n${pass} passed, ${fail} failed`)
  if (fail) process.exitCode = 1
}

main()
  .catch((e) => { console.error(e); process.exitCode = 1 })
  .finally(() => prisma.$disconnect())
