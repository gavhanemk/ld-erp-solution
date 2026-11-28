/**
 * Checks the opening-stock import (the 19-column sheet) and process stock
 * (size-wise work in progress, moved process to process) against a running
 * API and the demo database (lderp_demo) only. Refuses any other database.
 * Each run makes its own ZZTEST items, named with the time. From apps/api:
 *
 *   DATABASE_URL="postgresql://postgres:demo@localhost:5433/lderp_demo?schema=ld_erp" \
 *   E2E_EMAIL=... E2E_PASSWORD=... E2E_API=http://localhost:5105/api npx tsx ../../tools/check-opening-stock.ts
 */
import ExcelJS from 'exceljs'
import { prisma } from '../packages/database/src/index'

const API = (process.env.E2E_API || 'http://localhost:5101/api').replace(/\/+$/, '')
const HEADS = [
  'Opening Date', 'Process', 'Department / Location', 'Order No.', 'Style / Article No.', 'Item Code', 'Item Description',
  'Item Category', 'Fabric / Material', 'Colour', 'Size', 'Lot / Batch / Roll No.', 'Bundle / Barcode No.', 'UOM',
  'Opening Qty', 'Unit Rate', 'Opening Value', 'Stock Status', 'Remarks', 'HSN Code', 'GST %', 'Design No.',
  // Multi-brand phase 5 (28 Nov 2026): the own brand the stock is earmarked for; empty is central.
  'Brand',
]

let pass = 0, fail = 0
const check = (name: string, ok: boolean, extra?: unknown) => {
  ok ? pass++ : fail++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && extra !== undefined ? `  — ${JSON.stringify(extra).slice(0, 600)}` : ''}`)
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

/** The downloaded template, with these rows filled in, as the upload body. */
async function sheetWith(template: ExcelJS.Workbook, rows: Array<Partial<Record<string, string | number>>>, name: string) {
  const wb = new ExcelJS.Workbook()
  await wb.xlsx.load((await template.xlsx.writeBuffer()) as ExcelJS.Buffer)
  const sheet = wb.getWorksheet('Opening Stock')!
  // The template's grey example row goes first, as a person deletes it.
  sheet.spliceRows(2, 1)
  rows.forEach((r, i) => HEADS.forEach((h, c) => { if (r[h] !== undefined) sheet.getCell(i + 2, c + 1).value = r[h] as string | number }))
  return { fileName: `${name}.xlsx`, file: Buffer.from(await wb.xlsx.writeBuffer()).toString('base64') }
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

  // The template: exactly the 19 columns, in order, in row 1.
  const tpl = await fetch(`${API}/inventory/opening-stock/import-template`, { headers: { authorization: `Bearer ${token}` } })
  const template = new ExcelJS.Workbook()
  await template.xlsx.load(Buffer.from(await tpl.arrayBuffer()) as unknown as ExcelJS.Buffer)
  const heads = (template.getWorksheet('Opening Stock')!.getRow(1).values as unknown[]).slice(1).map(String)
  check('template: the 19 columns, named and ordered as the sheet', JSON.stringify(heads.map((h) => h.replace(/\s*\*$/, ''))) === JSON.stringify(HEADS), heads)

  // Test items of our own: a fabric, a cut panel, a garment on the test style.
  const cats = (await call('GET', '/masters/item-categories?limit=200&active=true')).body.data as Array<{ id: string; name: string; parentId: string | null }>
  const units = (await call('GET', '/masters/uoms?limit=100')).body.data as Array<{ id: string; symbol: string }>
  const unit = (s: string) => units.find((u) => u.symbol === s)!
  const fabricCat = cats.find((c) => c.name === 'Fabric')!
  const panelCat = cats.find((c) => c.name === 'Cut Panels')!
  const shirtsCat = cats.find((c) => c.name === 'Shirts')!
  const fabric = (await call('POST', '/masters/items', { name: `ZZTEST Opening Fabric ${stamp}`, type: 'RAW_MATERIAL', categoryId: fabricCat.id, uomId: unit('mtr').id })).body.data
  const panel = (await call('POST', '/masters/items', { name: `ZZTEST Opening Panel ${stamp}`, type: 'SEMI_FINISHED', categoryId: panelCat.id, uomId: unit('pcs').id })).body.data
  const style = await prisma.style.findFirstOrThrow({ where: { code: 'ZZTEST-SH-01' }, select: { id: true, code: true, colors: true } })
  const colour = style.colors[0]
  // Work in progress is only where the style's route goes: the test style's route, made once.
  if (!(await prisma.routing.findFirst({ where: { styleId: style.id, isActive: true } }))) {
    const op = (name: string) => prisma.operation.findFirstOrThrow({ where: { name, isActive: true }, select: { id: true, departmentId: true } })
    const steps = [await op('Cutting'), await op('Stitching'), await op('Finishing')]
    await prisma.routing.create({
      data: { code: `ZZTEST-RT-${style.code}`, name: 'ZZTEST route for the opening stock checks', styleId: style.id, steps: { create: steps.map((o, i) => ({ sequence: i + 1, operationId: o.id, departmentId: o.departmentId })) } },
    })
  }
  let garment = await prisma.item.findFirst({ where: { styleId: style.id, color: colour }, select: { id: true, code: true } })
  if (!garment) garment = (await call('POST', '/masters/items', { name: `ZZTEST Opening Shirt ${stamp}`, type: 'FINISHED_GOOD', categoryId: shirtsCat.id, uomId: unit('pcs').id, styleId: style.id, color: colour })).body.data
  check('test items made', Boolean(fabric?.code && panel?.code && garment?.code), { fabric, panel, garment })
  const order = `ZZ-ORD-${stamp}`
  // Today in India (until 5:30 am there, the UTC date is still yesterday and would not test today).
  const today = new Date(Date.now() + 330 * 60 * 1000).toISOString().slice(0, 10)
  const base = { 'Opening Date': today, 'Opening Qty': 1, 'Unit Rate': 1, 'Stock Status': 'OK' }

  const good = [
    { ...base, Process: 'Store', 'Department / Location': 'Fabric Warehouse', 'Item Code': fabric.code, 'Item Category': 'Fabric', 'Lot / Batch / Roll No.': `LOT-${stamp}`, 'Bundle / Barcode No.': `R-${stamp}-1`, UOM: 'Mtr', 'Opening Qty': 50, 'Unit Rate': 120, 'Opening Value': 6000 },
    { ...base, Process: 'Store', 'Department / Location': 'WH-FAB', 'Item Code': fabric.code, 'Lot / Batch / Roll No.': `LOT-${stamp}`, 'Bundle / Barcode No.': `R-${stamp}-2`, UOM: 'mtr', 'Opening Qty': 40, 'Unit Rate': '', 'Opening Value': 4800, 'Stock Status': 'Hold' },
    { ...base, Process: 'Cutting', 'Order No.': order, 'Style / Article No.': style.code, 'Item Code': garment.code, 'Item Category': 'Semi-Finished', Size: 'S', UOM: 'pcs', 'Opening Qty': 100, 'Unit Rate': 50 },
    { ...base, Process: 'Stitching', 'Department / Location': '', 'Order No.': order, 'Style / Article No.': style.code, 'Item Code': garment.code, Size: 'M', 'Opening Qty': 80, 'Unit Rate': 80 },
    { ...base, Process: 'Cutting', 'Order No.': order, 'Style / Article No.': style.code, 'Item Code': panel.code, 'Item Category': 'Cut Panels', Size: 'L', 'Opening Qty': 30, 'Unit Rate': 20 },
    { ...base, Process: 'Finished Goods', 'Department / Location': 'Store', 'Order No.': order, 'Style / Article No.': style.code, Colour: colour, Size: 'XL', 'Opening Qty': 20, 'Unit Rate': 300, 'Stock Status': 'B-Grade' },
  ]
  const bad = [
    { ...good[0] },                                                                                          // 8: same as row 2
    { ...base, Process: 'Store', 'Department / Location': 'Store', 'Item Code': fabric.code, UOM: 'pcs', 'Bundle / Barcode No.': 'X1' }, // 9: unit
    { ...base, Process: 'Store', 'Department / Location': 'Store', 'Item Code': fabric.code, 'Item Category': 'Buttons', 'Bundle / Barcode No.': 'X2' }, // 10: category
    { ...base, Process: 'Store', 'Department / Location': 'Store', 'Item Code': fabric.code, Size: 'M', 'Bundle / Barcode No.': 'X3' }, // 11: size on a raw material
    { ...base, Process: 'Finished Goods', 'Department / Location': 'Store', 'Item Code': garment.code },     // 12: no size
    { ...base, Process: 'Accounts', 'Item Code': fabric.code },                                             // 13: not a process
    { ...base, Process: 'Store', 'Department / Location': 'Nowhere Godown', 'Item Code': fabric.code },     // 14: no such store
    { ...base, Process: 'Store', 'Department / Location': 'Store', 'Item Code': fabric.code, 'Opening Qty': 10, 'Unit Rate': 5, 'Opening Value': 80, 'Bundle / Barcode No.': 'X4' }, // 15: value
    { ...base, Process: 'Store', 'Department / Location': 'Store', 'Item Code': fabric.code, 'Opening Date': '2099-01-01', 'Bundle / Barcode No.': 'X5' }, // 16: future
    { ...base, Process: 'Store', 'Department / Location': 'Store', 'Item Code': fabric.code, 'Stock Status': 'Maybe', 'Bundle / Barcode No.': 'X6' }, // 17: status
    { ...base, Process: 'Store', 'Department / Location': 'Store', 'Item Code': 'NO-SUCH-CODE' },           // 18: no item
    { ...base, Process: 'Washing', 'Order No.': order, 'Style / Article No.': style.code, 'Item Code': garment.code, Size: 'S', 'Bundle / Barcode No.': 'X7' }, // 19: off the route
  ]
  const checked = await call('POST', '/inventory/opening-stock/import', await sheetWith(template, [...good, ...bad], 'opening-check'))
  check('the check answers', okay(checked), checked.body)
  const rows = (checked.body?.data?.rows ?? []) as Array<{ row: number; problems: string[] }>
  const problemsOf = (row: number) => rows.find((r) => r.row === row)?.problems.join(' | ') ?? ''
  check('good rows of each kind pass', [2, 3, 4, 5, 6, 7].every((r) => problemsOf(r) === ''), [2, 3, 4, 5, 6, 7].map((r) => `${r}: ${problemsOf(r)}`))
  const expect: Array<[number, RegExp, string]> = [
    [8, /Same as row 2/, 'a repeated row'],
    [9, /counted in mtr, not pcs/, 'a wrong unit'],
    [10, /filed under .*not "Buttons"/, 'a wrong category'],
    [11, /raw material, which is kept without sizes/, 'a size on a raw material'],
    [12, /comes in sizes: give the Size/, 'a garment without a size'],
    [13, /department, not a process/, 'a department given as a process'],
    [14, /No store named "Nowhere Godown"/, 'an unknown store'],
    [15, /Opening Value says ₹80/, 'qty × rate not the value'],
    [16, /later than today/, 'a future date'],
    [17, /not one of: OK, Hold, Rejected, B-Grade/, 'an unknown status'],
    [18, /No item with code NO-SUCH-CODE/, 'an unknown item'],
    [19, /Washing is not on ZZTEST-SH-01's route \(Cutting → Stitching → Finishing\)/, "a process off the style's route"],
  ]
  for (const [row, re, what] of expect) check(`row ${row} refused: ${what}`, re.test(problemsOf(row)), problemsOf(row))
  const summary = checked.body?.data?.summary
  check('summary counts lines, problems and value', summary?.lines === 6 && summary?.problems === 12 && summary?.value === 6000 + 4800 + 5000 + 6400 + 600 + 6000, summary)
  const stage = (g: string) => summary?.byGroup?.find((x: any) => x.group === g)?.lines
  check('summary: 2 raw, 3 work in progress (semi-finished), 1 finished', stage('RAW_MATERIALS') === 2 && stage('SEMI_FINISHED') === 3 && stage('FINISHED_GOODS') === 1, summary?.byGroup)
  const refusedImport = await call('POST', '/inventory/opening-stock/import', { ...(await sheetWith(template, [...good, ...bad], 'opening-bad')), confirm: true })
  check('importing with problems is refused, nothing written', refusedImport.status === 400 && (await prisma.stockLedger.count({ where: { itemId: fabric.id } })) === 0, refusedImport.body)

  // Import the good rows.
  const done = await call('POST', '/inventory/opening-stock/import', { ...(await sheetWith(template, good, 'opening-good')), confirm: true })
  check('the good rows import', done.status === 201 && done.body?.data?.lines === 6, done.body)
  const docId = done.body?.data?.id
  const ledger = await prisma.stockLedger.findMany({ where: { referenceId: docId }, include: { warehouse: { select: { name: true, departmentId: true } }, size: { select: { code: true } } } })
  const rowFor = (itemId: string, sizeCode?: string) => ledger.filter((l) => l.itemId === itemId && (sizeCode ? l.size?.code === sizeCode : true))
  check('raw material in its store, by lot, OK and held', rowFor(fabric.id).length === 2 && rowFor(fabric.id).every((l) => l.warehouse.name === 'Fabric Warehouse' && l.batchNumber === `LOT-${stamp}` && l.transactionType === 'OPENING') && rowFor(fabric.id).some((l) => l.grade === 'R'), rowFor(fabric.id))
  const cut = rowFor(garment.id, 'S')[0]
  const sti = rowFor(garment.id, 'M')[0]
  check('work in progress on its process floor, by size and order', cut?.warehouse.name === 'Cutting Floor' && !!cut.warehouse.departmentId && Number(cut.inQty) === 100 && cut.orderNo === order && sti?.warehouse.name === 'Stitching Floor' && Number(sti.inQty) === 80, { cut, sti })
  const fg = rowFor(garment.id, 'XL')[0]
  check('finished goods in their store, by size, B-grade', fg?.warehouse.name === 'Store' && fg.grade === 'B' && Number(fg.unitRate) === 300, fg)
  const pkgs = await prisma.stockPackage.findMany({ where: { sourceId: docId }, select: { lotNo: true, notes: true, qty: true, grade: true } })
  check('a sticker per roll, with its lot and roll number', pkgs.length === 2 && pkgs.every((p) => p.lotNo === `LOT-${stamp}`) && pkgs.some((p) => p.notes === `Barcode R-${stamp}-1` && Number(p.qty) === 50) && pkgs.some((p) => p.grade === 'R'), pkgs)
  // A process floor (made by the import just now, on a fresh demo) is not a store.
  const floorAsStore = await call('POST', '/inventory/opening-stock/import', await sheetWith(template, [{ ...base, Process: 'Store', 'Department / Location': 'Cutting Floor', 'Item Code': fabric.code, 'Bundle / Barcode No.': `X8-${stamp}` }], 'opening-floor-store'))
  check('a process floor given as a store is refused', /Cutting Floor is a process's floor, not a store/.test(floorAsStore.body?.data?.rows?.[0]?.problems?.join(' ') ?? ''), floorAsStore.body?.data?.rows?.[0])
  const lines = await prisma.openingStockLine.count({ where: { openingStockId: docId } })
  check('every row kept as typed', lines === 6)
  const list = await call('GET', '/inventory/opening-stock')
  check('the upload is listed with its lines and value', list.body?.data?.some((d: any) => d.id === docId && d.lines === 6 && d.value === 28800), list.body?.data?.[0])

  // The same sheet again: nothing twice.
  const again = await call('POST', '/inventory/opening-stock/import', await sheetWith(template, good, 'opening-again'))
  const againRows = (again.body?.data?.rows ?? []) as Array<{ problems: string[] }>
  check('the same sheet again: every row already brought in', againRows.length === 6 && againRows.every((r) => /Already brought in on OPS-/.test(r.problems.join(' '))), againRows.map((r) => r.problems))

  // Process stock: sizes against processes, by order.
  const ps = await call('GET', `/inventory/process-stock?orderNo=${order}`)
  const block = (ps.body?.data?.blocks ?? []).find((b: any) => b.item.id === garment!.id)
  const cols = (ps.body?.data?.columns ?? []) as Array<{ id: string; name: string }>
  const colId = (name: string) => cols.find((c) => c.name === name)?.id ?? ''
  const sizeId = (code: string) => block?.sizes.find((s: any) => s.code === code)?.id ?? 'none'
  check('process stock: S at Cutting, M at Stitching, for the order', block?.cells?.[sizeId('S')]?.[colId('Cutting')] === 100 && block?.cells?.[sizeId('M')]?.[colId('Stitching')] === 80 && block?.bGrade === 20, block)

  // Move 30 of S on to Stitching, part of the lot.
  const moved = await call('POST', '/inventory/process-stock/move', { itemId: garment.id, fromWarehouseId: colId('Cutting'), toWarehouseId: colId('Stitching'), orderNo: order, bundleNo: 'B-1', lines: [{ sizeId: sizeId('S'), qty: 30 }] })
  check('30 of S moved from Cutting to Stitching', moved.status === 201, moved.body)
  const after = (await call('GET', `/inventory/process-stock?orderNo=${order}`)).body?.data?.blocks?.find((b: any) => b.item.id === garment!.id)
  check('Cutting now 70 of S, Stitching 30 of S', after?.cells?.[sizeId('S')]?.[colId('Cutting')] === 70 && after?.cells?.[sizeId('S')]?.[colId('Stitching')] === 30, after?.cells)
  const tooMany = await call('POST', '/inventory/process-stock/move', { itemId: garment.id, fromWarehouseId: colId('Cutting'), toWarehouseId: colId('Stitching'), orderNo: order, lines: [{ sizeId: sizeId('S'), qty: 71 }] })
  check('never more than is there', tooMany.status === 400 && /has 70 size S/.test(tooMany.body?.message ?? ''), tooMany.body)
  const otherOrder = await call('POST', '/inventory/process-stock/move', { itemId: garment.id, fromWarehouseId: colId('Cutting'), toWarehouseId: colId('Stitching'), orderNo: `${order}-X`, lines: [{ sizeId: sizeId('S'), qty: 1 }] })
  check("another order's pieces are not taken", otherOrder.status === 400 && /has 0 size S/.test(otherOrder.body?.message ?? ''), otherOrder.body)
  const line = await prisma.stockTransferLine.findFirst({ where: { transfer: { id: moved.body?.data?.id } }, select: { orderNo: true, bundleNo: true, unitRate: true } })
  check('the move keeps order, bundle and the rate', line?.orderNo === order && line?.bundleNo === 'B-1' && Number(line?.unitRate) === 50, line)

  // A row found later, on a floor with pieces already moving: another order's
  // pieces still come in; the same order's do not.
  const lateRow = (orderNo: string, bundle: string) => ({ ...base, Process: 'Cutting', 'Order No.': orderNo, 'Style / Article No.': style.code, 'Item Code': garment!.code, Size: 'S', 'Opening Qty': 5, 'Unit Rate': 50, 'Bundle / Barcode No.': bundle })
  const late = await call('POST', '/inventory/opening-stock/import', await sheetWith(template, [lateRow(`${order}-B`, `LB-${stamp}`), lateRow(order, `LA-${stamp}`)], 'opening-late'))
  const lateRows = (late.body?.data?.rows ?? []) as Array<{ row: number; problems: string[] }>
  check("on a floor, another order's late row still comes in", lateRows.find((r) => r.row === 2)?.problems.length === 0, lateRows)
  check("…but not the same order's, once its pieces have moved there", /for order ZZ-ORD-\d+ already has stock moving at Cutting/.test(lateRows.find((r) => r.row === 3)?.problems.join(' ') ?? ''), lateRows)

  // Track & Trace: opening stock and a move on a sales order's own number show on its timeline.
  const so = await prisma.salesOrder.findFirst({ where: { customer: { name: { startsWith: 'ZZTEST' } } }, orderBy: { createdAt: 'desc' }, select: { id: true, soNumber: true } })
  check('a test sales order to trace', Boolean(so))
  if (so) {
    const traced = await call('POST', '/inventory/opening-stock/import', { ...(await sheetWith(template, [{ ...base, Process: 'Cutting', 'Order No.': so.soNumber, 'Style / Article No.': style.code, 'Item Code': panel.code, Size: 'L', 'Opening Qty': 10, 'Unit Rate': 20, 'Bundle / Barcode No.': `TR-${stamp}` }], 'opening-trace')), confirm: true })
    check('opening stock against a sales order', traced.status === 201, traced.body)
    const onSo = (await call('GET', `/inventory/process-stock?orderNo=${encodeURIComponent(so.soNumber)}`)).body?.data
    const soCol = (name: string) => (onSo?.columns ?? []).find((c: any) => c.name === name)?.id ?? ''
    const sizeL = onSo?.blocks?.find((b: any) => b.item.id === panel.id)?.sizes?.find((s: any) => s.code === 'L')?.id
    const soMove = await call('POST', '/inventory/process-stock/move', { itemId: panel.id, fromWarehouseId: soCol('Cutting'), toWarehouseId: soCol('Stitching'), orderNo: so.soNumber, lines: [{ sizeId: sizeL, qty: 4 }] })
    check('and 4 of them moved on', soMove.status === 201, soMove.body)
    const timeline = ((await call('GET', `/trace/order/SO/${so.id}`)).body?.data?.timeline ?? []) as Array<{ title: string; ref: string | null; detail: string | null }>
    check("trace: the opening stock is on the order's timeline", timeline.some((s) => s.ref === traced.body?.data?.number && /^Opening stock: 10 pcs at Cutting Floor$/.test(s.title) && /L 10/.test(s.detail ?? '')), timeline.slice(-6))
    check("trace: so is the move", timeline.some((s) => s.ref === soMove.body?.data?.transferNumber && /^4 pcs moved from Cutting Floor to Stitching Floor$/.test(s.title) && /L 4/.test(s.detail ?? '')), timeline.slice(-6))
  }

  console.log(`\n${pass} passed, ${fail} failed`)
  if (fail) process.exitCode = 1
}

main()
  .catch((e) => { console.error(e); process.exitCode = 1 })
  .finally(() => prisma.$disconnect())
