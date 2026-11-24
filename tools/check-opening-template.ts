/**
 * Checks the opening stock templates' example row and optional columns, and
 * items made on import — against a running API and the demo database
 * (lderp_demo) only. Refuses any other database. Each run makes its own
 * ZZTEST items and gives the ZZTEST style colours of its own. From apps/api:
 *
 *   DATABASE_URL="postgresql://postgres:demo@localhost:5433/lderp_demo?schema=ld_erp" \
 *   E2E_EMAIL=... E2E_PASSWORD=... E2E_API=http://localhost:5105/api npx tsx ../../tools/check-opening-template.ts
 */
import ExcelJS from 'exceljs'
import { prisma } from '../packages/database/src/index'

const API = (process.env.E2E_API || 'http://localhost:5101/api').replace(/\/+$/, '')
const ALL_HEADS = [
  'Opening Date', 'Process', 'Department / Location', 'Order No.', 'Style / Article No.', 'Item Code', 'Item Description', 'Item Category', 'Fabric / Material',
  'Colour', 'Size', 'Lot / Batch / Roll No.', 'Bundle / Barcode No.', 'UOM', 'Opening Qty', 'Unit Rate', 'Opening Value', 'Stock Status', 'Remarks',
]
const REQUIRED = { ALL: ['Opening Date', 'Item Description', 'Opening Qty'], FG: ['Style / Article No.', 'Colour', 'Size', 'Opening Quantity'], RM: ['Item Name', 'Opening Quantity'] }
const SHEET = { ALL: 'Opening Stock', FG: 'Finished Goods', SFG: 'Semi Finished Goods', RM: 'Raw Materials' } as const
type Kind = keyof typeof SHEET
const EXAMPLE_REMARK = 'Example row: not brought in. Delete it, or add your stock below it'

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
async function template(kind: Kind) {
  const res = await fetch(`${API}/inventory/opening-stock/import-template${kind === 'ALL' ? '' : `?type=${kind}`}`, { headers: { authorization: `Bearer ${token}` } })
  const wb = new ExcelJS.Workbook()
  await wb.xlsx.load(Buffer.from(await res.arrayBuffer()) as unknown as ExcelJS.Buffer)
  return wb
}
const plain = (h: string) => h.replace(/\s*\*$/, '')
/** The template with these rows from row 3 on, the grey example left in row 2. */
async function sheet(kind: Kind, rows: Array<Record<string, string | number>>, name: string) {
  const wb = await template(kind)
  const ws = wb.getWorksheet(SHEET[kind])!
  const heads = ((ws.getRow(1).values as unknown[]) ?? []).slice(1).map((v) => plain(String(v)))
  rows.forEach((r, i) => heads.forEach((h, c) => { if (r[h] !== undefined) ws.getCell(i + 3, c + 1).value = r[h] }))
  return { fileName: `${name}.xlsx`, file: Buffer.from(await wb.xlsx.writeBuffer()).toString('base64') }
}
type Row = { row: number; problems: string[]; location: string; item: { code: string; name: string } | null; newItem: { name: string; category: string; unit: string } | null; rate: number | null }
const rowsOf = (r: Res) => (r.body?.data?.rows ?? []) as Row[]
const rowOf = (r: Res, n: number) => rowsOf(r).find((x) => x.row === n)
const problemsOf = (r: Res, n: number) => rowOf(r, n)?.problems.join(' | ') ?? ''

async function main() {
  const email = process.env.E2E_EMAIL
  const password = process.env.E2E_PASSWORD
  if (!email || !password) { console.error('Set E2E_EMAIL and E2E_PASSWORD.'); process.exitCode = 2; return }
  const [{ current_database: dbName }] = await prisma.$queryRaw<{ current_database: string }[]>`select current_database()`
  if (dbName !== 'lderp_demo') { console.error('Refusing to run: not lderp_demo.'); process.exitCode = 2; return }
  token = (await fetch(`${API}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password }) }).then((r) => r.json())).accessToken
  if (!token) throw new Error('login failed')
  const stamp = Date.now().toString().slice(-6)
  const india = new Date(Date.now() + 330 * 60 * 1000)
  const today = india.toISOString().slice(0, 10)
  const todayDmy = `${today.slice(8, 10)}-${today.slice(5, 7)}-${today.slice(0, 4)}`

  // 1. Every template: * on the columns that must be filled, the example in grey on row 2.
  for (const kind of ['ALL', 'FG', 'SFG', 'RM'] as Kind[]) {
    const ws = (await template(kind)).getWorksheet(SHEET[kind])!
    const heads = ((ws.getRow(1).values as unknown[]) ?? []).slice(1).map(String)
    const starred = heads.filter((h) => h.endsWith('*')).map(plain)
    if (kind !== 'SFG') check(`${kind} template: * on the required columns`, JSON.stringify(starred) === JSON.stringify(REQUIRED[kind]), starred)
    const remarkCol = heads.findIndex((h) => plain(h) === 'Remarks') + 1
    check(`${kind} template: the example on row 2`, String(ws.getCell(2, remarkCol).value) === EXAMPLE_REMARK, ws.getRow(2).values)
    check(`${kind} template: the example in grey italics`, ws.getRow(2).font?.italic === true)
  }
  const allWs = (await template('ALL')).getWorksheet(SHEET.ALL)!
  check('19-column template: the same 19 columns, in order', JSON.stringify(((allWs.getRow(1).values as unknown[]) ?? []).slice(1).map((v) => plain(String(v)))) === JSON.stringify(ALL_HEADS))
  const notes = Object.fromEntries(ALL_HEADS.map((h, i) => [h, String((allWs.getCell(1, i + 1).note as unknown as { texts?: Array<{ text: string }> })?.texts?.map((t) => t.text).join('') ?? allWs.getCell(1, i + 1).note ?? '')]))
  for (const h of ['Process', 'Department / Location', 'Order No.', 'Style / Article No.', 'Item Code', 'UOM', 'Unit Rate', 'Stock Status']) {
    check(`19-column template: ${h} says it is optional`, /^Optional/.test(notes[h]), notes[h])
  }

  // 2. The template sent back untouched: only the example, nothing to bring in.
  const untouched = await call('POST', '/inventory/opening-stock/import', await sheet('ALL', [], `zz-untouched-${stamp}`))
  check('untouched template: refused, only the example is filled in', untouched.status === 400 && /Only the example row/.test(untouched.body?.message ?? ''), untouched.body)
  const untouchedRm = await call('POST', '/inventory/opening-stock/import', { ...(await sheet('RM', [], `zz-untouched-rm-${stamp}`)), kind: 'RM', openingDate: today })
  check('untouched Raw Materials template: refused the same way', untouchedRm.status === 400 && /Only the example row/.test(untouchedRm.body?.message ?? ''), untouchedRm.body)

  // The masters the rows use.
  const fabric = await prisma.itemCategory.findFirstOrThrow({ where: { isActive: true, name: 'Fabric', parentId: { not: null } }, select: { id: true } })
  const like = await prisma.item.findFirst({ where: { categoryId: fabric.id, isActive: true }, orderBy: { createdAt: 'desc' }, select: { uom: { select: { symbol: true } } } })
  const stores = await prisma.warehouse.findMany({ where: { isActive: true, departmentId: null }, select: { name: true, code: true } })
  const mainStore = stores.find((w) => w.name.toLowerCase().replace(/[^a-z0-9]/g, '') === 'store')?.name
  const fgStore = stores.find((w) => /finish/i.test(w.name))?.name ?? mainStore
  const style = await prisma.style.findFirstOrThrow({ where: { code: 'ZZTEST-SH-01' }, select: { id: true, colors: true, sizeGroupId: true } })
  const made = await prisma.item.findFirstOrThrow({ where: { styleId: style.id, type: 'FINISHED_GOOD' }, select: { color: true } })
  const size = await prisma.size.findFirstOrThrow({ where: { sizeGroupId: style.sizeGroupId! }, orderBy: { sequence: 'asc' }, select: { code: true } })
  // Two colours of this run's own, with no item yet.
  const [newColour, kindColour] = [`Y${stamp}`, `X${stamp}`]
  await prisma.style.update({ where: { id: style.id }, data: { colors: [...style.colors, newColour, kindColour] } })

  // 3. The 19 columns: only date, description and quantity filled; items made on import.
  const poplin = `ZZTEST Poplin ${stamp}`
  const base = { 'Opening Date': todayDmy }
  const checked = await call('POST', '/inventory/opening-stock/import', await sheet('ALL', [
    { ...base, 'Item Description': poplin, 'Item Category': 'Fabric', 'Opening Qty': 50 },                                     // 3
    { ...base, 'Item Description': poplin, 'Lot / Batch / Roll No.': 'L2', 'Opening Qty': 30 },                               // 4: the same new item
    { ...base, 'Item Description': `ZZTEST Nocat ${stamp}`, 'Opening Qty': 5 },                                               // 5: no category
    { ...base, 'Item Code': 'ZZ-NOPE-1', 'Opening Qty': 5 },                                                                  // 6: a code not in the ERP
    { ...base, 'Item Description': `ZZTEST Main ${stamp}`, 'Item Category': 'Raw Materials', 'Opening Qty': 5 },             // 7: a main category
    { ...base, 'Style / Article No.': 'ZZTEST-SH-01', Colour: made.color!, 'Opening Qty': 3 },                                 // 8: a sized garment, no size
    { ...base, Process: 'Finished Goods', 'Style / Article No.': 'ZZTEST-SH-01', Colour: newColour, Size: size.code, 'Opening Qty': 4 }, // 9: a new colour
    { ...base, 'Item Description': `ZZTEST Ex ${stamp}`, 'Item Category': 'Fabric', 'Opening Qty': 1, Remarks: EXAMPLE_REMARK }, // 10: the example typed over in part
  ], `zz-optional-${stamp}`))
  check('check: answered', checked.status === 200, checked.body)
  check('check: the example row is left out', !rowOf(checked, 2), rowsOf(checked).map((r) => r.row))
  const r3 = rowOf(checked, 3)
  check('row 3: no code, location, unit, rate or status — accepted', problemsOf(checked, 3) === '', problemsOf(checked, 3))
  check(`row 3: no location is the store called Store (${mainStore})`, r3?.location === mainStore, r3?.location)
  check('row 3: a new item, under Fabric, in the category’s usual unit', /Fabric/.test(r3?.newItem?.category ?? '') && r3?.newItem?.unit === (like?.uom.symbol ?? 'pcs'), r3?.newItem)
  check('row 3: no rate is valued at nought', r3?.rate === 0, r3?.rate)
  check('row 4: the same new item, accepted', problemsOf(checked, 4) === '' && rowOf(checked, 4)?.newItem?.name === poplin, rowOf(checked, 4))
  check('row 5: a new item without a category is refused, saying so', /give its Item Category/.test(problemsOf(checked, 5)), problemsOf(checked, 5))
  check('row 6: a code not in the ERP is refused, saying to leave it empty', /No item with code ZZ-NOPE-1.*leave Item Code empty/.test(problemsOf(checked, 6)), problemsOf(checked, 6))
  check('row 7: a main category is refused, asking for its subcategory', /main category/.test(problemsOf(checked, 7)), problemsOf(checked, 7))
  check('row 8: a garment in sizes still needs its size', /comes in sizes: give the Size/.test(problemsOf(checked, 8)), problemsOf(checked, 8))
  const r9 = rowOf(checked, 9)
  check('row 9: a style’s new colour is made as a finished item', problemsOf(checked, 9) === '' && Boolean(r9?.newItem) && r9?.newItem?.name.endsWith(newColour) === true, r9)
  check(`row 9: no location is the finished goods store (${fgStore})`, r9?.location === fgStore, r9?.location)
  check('row 10: the example typed over in part is refused', /still has the example row's cells/.test(problemsOf(checked, 10)), problemsOf(checked, 10))
  const toMake = (checked.body?.data?.summary?.itemsToMake ?? []) as Array<{ name: string }>
  check('summary: two new items to make, each once', toMake.length === 2 && toMake.some((i) => i.name === poplin), toMake)

  // 4. The good rows brought in: the items made with their own codes, the stock in.
  const good = await call('POST', '/inventory/opening-stock/import', { ...(await sheet('ALL', [
    { ...base, 'Item Description': poplin, 'Item Category': 'Fabric', 'Fabric / Material': 'Cotton Poplin', Colour: 'White', 'Opening Qty': 50 },
    { ...base, 'Item Description': poplin, 'Lot / Batch / Roll No.': 'L2', 'Opening Qty': 30 },
    { ...base, Process: 'Finished Goods', 'Style / Article No.': 'ZZTEST-SH-01', Colour: newColour, Size: size.code, 'Opening Qty': 4, 'Unit Rate': 300 },
  ], `zz-optional-go-${stamp}`)), confirm: true, requestKey: `zz-optional-${stamp}` })
  check('import: brought in', good.status === 201, good.body)
  const itemsMade = (good.body?.data?.itemsMade ?? []) as Array<{ code: string; name: string }>
  check('import: two items made, with the ERP’s own codes', itemsMade.length === 2 && itemsMade.every((i) => /^[A-Z]{3}-\d{3}$/.test(i.code)), itemsMade)
  check('import: the message names the new items', /2 new items made/.test(good.body?.message ?? ''), good.body?.message)
  const newPoplin = await prisma.item.findFirst({ where: { name: poplin }, select: { id: true, code: true, categoryId: true, description: true, color: true, type: true } })
  check('the new item: under Fabric, a raw material, its fabric and colour kept', newPoplin?.categoryId === fabric.id && newPoplin?.type === 'RAW_MATERIAL' && newPoplin?.description === 'Cotton Poplin' && newPoplin?.color === 'White', newPoplin)
  check('the new item: its code starts FAB-', /^FAB-\d{3}$/.test(newPoplin?.code ?? ''), newPoplin?.code)
  const poplinLines = await prisma.openingStockLine.findMany({ where: { itemId: newPoplin?.id ?? '' }, select: { qty: true, warehouse: { select: { name: true } } } })
  check('the new item: both rows in stock, in the store called Store', poplinLines.length === 2 && poplinLines.every((l) => l.warehouse.name === mainStore), poplinLines)
  const garment = await prisma.item.findFirst({ where: { styleId: style.id, color: newColour }, select: { type: true, name: true } })
  check('the new colour: a finished item of the style, in that colour', garment?.type === 'FINISHED_GOOD', garment)

  // 5. The item made, named again: found by its name, not made twice.
  const again = await call('POST', '/inventory/opening-stock/import', await sheet('ALL', [
    { ...base, 'Item Description': poplin, 'Lot / Batch / Roll No.': 'L3', 'Opening Qty': 12 },
  ], `zz-optional-again-${stamp}`))
  check('named again: found by its name, nothing new to make', problemsOf(again, 3) === '' && !rowOf(again, 3)?.newItem && rowOf(again, 3)?.item?.code === newPoplin?.code, rowOf(again, 3))

  // 6. Each kind's own template the same way.
  const rmKind = await call('POST', '/inventory/opening-stock/import', { ...(await sheet('RM', [
    { 'Material Category': 'Fabric', 'Item Name': `ZZTEST RMK ${stamp}`, 'Opening Quantity': 10 },
  ], `zz-optional-rm-${stamp}`)), kind: 'RM', openingDate: today })
  check('Raw Materials sheet: name, category and quantity only — a new item, in Store', problemsOf(rmKind, 3) === '' && Boolean(rowOf(rmKind, 3)?.newItem) && rowOf(rmKind, 3)?.location === mainStore, rowOf(rmKind, 3))
  const fgKind = await call('POST', '/inventory/opening-stock/import', { ...(await sheet('FG', [
    { 'Style / Article No.': 'ZZTEST-SH-01', Colour: kindColour, Size: size.code, 'Opening Quantity': 6 },
  ], `zz-optional-fg-${stamp}`)), kind: 'FG', openingDate: today })
  check('Finished Goods sheet: a new colour made, in the finished goods store', problemsOf(fgKind, 3) === '' && Boolean(rowOf(fgKind, 3)?.newItem) && rowOf(fgKind, 3)?.location === fgStore, rowOf(fgKind, 3))

  // 7. Lines typed on the screen never make items: the screen picks them.
  const entry = await call('POST', '/inventory/opening-stock/entry', { lines: [{ date: today, description: `ZZTEST Typed ${stamp}`, category: 'Fabric', qty: 3 }] })
  check('typed lines: an unknown item is refused, not made', /No item named/.test(problemsOf(entry, 1)), problemsOf(entry, 1))

  console.log(`\n${pass} passed, ${fail} failed`)
  if (fail) process.exitCode = 1
}

main()
  .catch((e) => { console.error(e); process.exitCode = 1 })
  .finally(() => prisma.$disconnect())
