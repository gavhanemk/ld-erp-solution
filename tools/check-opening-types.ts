/**
 * Checks opening stock by kind — Finished Goods, Semi Finished Goods and Raw
 * Materials, each with its own template, rules and entry — against a running
 * API and the demo database (lderp_demo) only. Refuses any other database.
 * Each run gives the ZZTEST style a colour of its own (and makes its item the
 * way the entry screen does) and makes its own ZZTEST fabric, so every run
 * posts fresh stock. From apps/api:
 *
 *   DATABASE_URL="postgresql://postgres:demo@localhost:5433/lderp_demo?schema=ld_erp" \
 *   E2E_EMAIL=... E2E_PASSWORD=... E2E_API=http://localhost:5105/api npx tsx ../../tools/check-opening-types.ts
 */
import ExcelJS from 'exceljs'
import { prisma } from '../packages/database/src/index'

const API = (process.env.E2E_API || 'http://localhost:5101/api').replace(/\/+$/, '')
const HEADS = {
  FG: ['Style / Article No.', 'Item Code', 'Colour', 'Size', 'Opening Quantity', 'Rate Per Piece', 'Location', 'Stock Status', 'Remarks'],
  SFG: ['Style / Article No.', 'Process', 'Colour', 'Size', 'Opening Quantity', 'Rate / Valuation', 'Department', 'Location', 'Order Reference', 'Batch / Bundle Reference', 'Stock Status', 'Remarks'],
  RM: ['Material Category', 'Item Code', 'Item Name', 'Lot / Batch / Roll Number', 'Bundle / Barcode Number', 'UOM', 'Opening Quantity', 'Unit Rate', 'Location', 'Stock Status', 'Remarks'],
} as const
type K = keyof typeof HEADS
const SHEET: Record<K, string> = { FG: 'Finished Goods', SFG: 'Semi Finished Goods', RM: 'Raw Materials' }

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
const ok = (r: Res) => r.status >= 200 && r.status < 300

async function template(kind: K) {
  const res = await fetch(`${API}/inventory/opening-stock/import-template?type=${kind}`, { headers: { authorization: `Bearer ${token}` } })
  const wb = new ExcelJS.Workbook()
  await wb.xlsx.load(Buffer.from(await res.arrayBuffer()) as unknown as ExcelJS.Buffer)
  return wb
}
/** The kind's template with these rows filled in, as an upload body. */
async function sheet(kind: K, rows: Array<Partial<Record<string, string | number>>>, name: string) {
  const wb = await template(kind)
  const ws = wb.getWorksheet(SHEET[kind])!
  const heads = HEADS[kind] as readonly string[]
  rows.forEach((r, i) => heads.forEach((h, c) => { if (r[h] !== undefined) ws.getCell(i + 2, c + 1).value = r[h] as string | number }))
  return { fileName: `${name}.xlsx`, file: Buffer.from(await wb.xlsx.writeBuffer()).toString('base64') }
}
const problemsOf = (res: Res, row: number) => ((res.body?.data?.rows ?? []) as Array<{ row: number; problems: string[] }>).find((r) => r.row === row)?.problems.join(' | ') ?? ''

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

  // 1. Each kind's own template.
  for (const kind of ['FG', 'SFG', 'RM'] as K[]) {
    const ws = (await template(kind)).getWorksheet(SHEET[kind])
    const heads = ((ws?.getRow(1).values as unknown[]) ?? []).slice(1).map(String)
    check(`${kind} template: its own columns, in order`, JSON.stringify(heads) === JSON.stringify(HEADS[kind]), heads)
  }

  // 2. The test style, a colour of this run's own, its item made as the entry screen makes it.
  const style = await prisma.style.findFirstOrThrow({ where: { code: 'ZZTEST-SH-01' }, select: { id: true, code: true, colors: true, sizeGroupId: true } })
  const colour = `Z${stamp}`
  await prisma.style.update({ where: { id: style.id }, data: { colors: [...style.colors, colour] } })
  const made = await call('POST', '/inventory/opening-stock/colour-item', { styleId: style.id, colour })
  const item = made.body?.data?.item
  check("a colour with no item: made like the style's other colours", made.status === 201 && made.body?.data?.made === true && !!item?.code, made.body)
  const again = await call('POST', '/inventory/opening-stock/colour-item', { styleId: style.id, colour })
  check('asked again, the same item (not a second)', again.status === 200 && again.body?.data?.item?.id === item?.id, again.body)
  const sizes = await prisma.size.findMany({ where: { sizeGroupId: style.sizeGroupId! }, orderBy: { sequence: 'asc' }, select: { id: true, code: true } })
  const [s1, s2] = [sizes[0], sizes[1]]
  const fabricCat = await prisma.itemCategory.findFirstOrThrow({ where: { name: 'Fabric', isActive: true }, select: { id: true } })
  const mtr = await prisma.uOM.findFirstOrThrow({ where: { symbol: 'mtr' }, select: { id: true } })
  const fabric = (await call('POST', '/masters/items', { name: `ZZTEST Typed Fabric ${stamp}`, type: 'RAW_MATERIAL', categoryId: fabricCat.id, uomId: mtr.id })).body.data
  const shirt = await prisma.item.findFirstOrThrow({ where: { code: item.code }, select: { id: true, code: true } })
  check('test fabric made', !!fabric?.code, fabric)

  // 3. Finished Goods: style, colour, size into a store.
  const fgGood = [
    { 'Style / Article No.': style.code, Colour: colour, Size: s1.code, 'Opening Quantity': 12, 'Rate Per Piece': 250, Location: 'Store' },
    { 'Style / Article No.': style.code, 'Item Code': item.code, Colour: colour, Size: s2.code, 'Opening Quantity': 8, 'Rate Per Piece': 260, Location: 'Store', 'Stock Status': 'B-Grade' },
  ]
  const fgBad = [
    { 'Style / Article No.': style.code, 'Item Code': fabric.code, Size: s1.code, 'Opening Quantity': 1, 'Rate Per Piece': 1, Location: 'Store' },          // 4: a material
    { 'Style / Article No.': style.code, Colour: colour, Size: s1.code, 'Opening Quantity': 1, 'Rate Per Piece': 1, Location: 'Cutting Floor', 'Remarks': 'x' }, // 5: a floor
    { 'Style / Article No.': style.code, Colour: 'Purple', Size: s1.code, 'Opening Quantity': 1, 'Rate Per Piece': 1, Location: 'Store' },                   // 6: not its colour
    { 'Style / Article No.': style.code, Colour: colour, Size: 'XXXXL', 'Opening Quantity': 1, 'Rate Per Piece': 1, Location: 'Store' },                    // 7: not its size
    { 'Style / Article No.': style.code, Colour: colour, Size: s1.code, 'Opening Quantity': 1, Location: 'Store', 'Stock Status': 'Hold' },                // 8: no rate
  ]
  const noDate = await call('POST', '/inventory/opening-stock/import', { ...(await sheet('FG', fgGood, 'fg-nodate')), kind: 'FG' })
  check('a kind’s sheet needs the opening date from the screen', noDate.status === 400 && /opening date/i.test(noDate.body?.message ?? ''), noDate.body)
  const fgCheck = await call('POST', '/inventory/opening-stock/import', { ...(await sheet('FG', [...fgGood, ...fgBad], 'fg-check')), kind: 'FG', openingDate: today })
  check('FG: the good rows pass', problemsOf(fgCheck, 2) === '' && problemsOf(fgCheck, 3) === '', [problemsOf(fgCheck, 2), problemsOf(fgCheck, 3)])
  const fgExpect: Array<[number, RegExp, string]> = [
    [4, /A Finished Goods row, but .* is raw material/i, 'a raw material'],
    [5, /Cutting Floor is a process's floor, not a store/, 'a process floor as the store'],
    [6, /No finished item for ZZTEST-SH-01 in Purple/, 'a colour the style does not have'],
    [7, /Size XXXXL is not in the size run/, 'a size not in its run'],
    [8, /Give the Rate Per Piece\./, 'no rate (named as the template names it)'],
  ]
  for (const [row, re, what] of fgExpect) check(`FG row ${row} refused: ${what}`, re.test(problemsOf(fgCheck, row)), problemsOf(fgCheck, row))

  const wrong = await call('POST', '/inventory/opening-stock/import', { ...(await sheet('FG', fgGood, 'fg-as-sfg')), kind: 'SFG', openingDate: today })
  check('the FG template uploaded as SFG: says which template it is', wrong.status === 400 && wrong.body?.code === 'WRONG_TEMPLATE' && /Finished Goods template/.test(wrong.body?.message ?? ''), wrong.body)

  // The error report: the sheet back with its problems beside each row.
  const reportRes = await fetch(`${API}/inventory/opening-stock/import/report`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ ...(await sheet('FG', [...fgGood, ...fgBad], 'fg-check')), kind: 'FG', openingDate: today }),
  })
  const report = new ExcelJS.Workbook()
  await report.xlsx.load(Buffer.from(await reportRes.arrayBuffer()) as unknown as ExcelJS.Buffer)
  const rws = report.getWorksheet('Finished Goods')!
  const lastCol = HEADS.FG.length + 1
  check('error report: a Problems column, each bad row with its problem, good rows clean', rws.getRow(1).getCell(lastCol).value === 'Problems' && /process's floor/.test(String(rws.getRow(5).getCell(lastCol).value ?? '')) && !rws.getRow(2).getCell(lastCol).value, [rws.getRow(1).getCell(lastCol).value, rws.getRow(5).getCell(lastCol).value])
  // Corrected (the bad rows taken out), the report goes back up as it is.
  for (let r = 4; r <= 8; r++) rws.spliceRows(4, 1)
  const reup = await call('POST', '/inventory/opening-stock/import', { fileName: 'fg-fixed.xlsx', file: Buffer.from(await report.xlsx.writeBuffer()).toString('base64'), kind: 'FG', openingDate: today })
  check('the corrected error report uploads as it is: 2 rows, no problems', reup.body?.data?.summary?.lines === 2 && reup.body?.data?.summary?.problems === 0, reup.body?.data?.summary)

  const key = `zz-fg-${stamp}-key`
  const fgBody = { ...(await sheet('FG', fgGood, `fg-${stamp}`)), kind: 'FG', openingDate: today, requestKey: key }
  const fgDone = await call('POST', '/inventory/opening-stock/import', { ...fgBody, confirm: true })
  check('FG: imported', fgDone.status === 201 && fgDone.body?.data?.lines === 2, fgDone.body)
  const fgTwice = await call('POST', '/inventory/opening-stock/import', { ...fgBody, confirm: true })
  check('the same import sent twice: the first one back, nothing posted twice', fgTwice.status === 200 && fgTwice.body?.data?.again === true && fgTwice.body?.data?.number === fgDone.body?.data?.number, fgTwice.body)
  const fgLedger = await prisma.stockLedger.findMany({ where: { referenceId: fgDone.body?.data?.id }, select: { warehouse: { select: { name: true, departmentId: true } }, sizeId: true, grade: true, inQty: true } })
  check('FG ledger: 2 lines in the Store, by size, the B-grade as B', fgLedger.length === 2 && fgLedger.every((l) => l.warehouse.name === 'Store' && !l.warehouse.departmentId) && fgLedger.some((l) => l.sizeId === s2.id && l.grade === 'B'), fgLedger)
  const doc = await prisma.openingStock.findUnique({ where: { id: fgDone.body?.data?.id }, select: { kind: true, requestKey: true } })
  check('the entry is kept as FG with its key', doc?.kind === 'FG' && doc?.requestKey === key, doc)

  // 4. Semi Finished Goods: a process on the style's route (Cutting → Stitching → Finishing).
  const onFloorMo = await prisma.manufacturingOrder.findFirst({ where: { bundles: { some: {} } }, select: { moNumber: true } })
  const order = `ZZ-SFG-${stamp}`
  const sfgGood = [
    { 'Style / Article No.': style.code, Process: 'Cutting', Colour: colour, Size: s1.code, 'Opening Quantity': 40, 'Rate / Valuation': 60, 'Order Reference': order, 'Batch / Bundle Reference': `B-${stamp}-1` },
    { 'Style / Article No.': style.code, Process: 'Stitching', Colour: colour, Size: s2.code, 'Opening Quantity': 25, 'Rate / Valuation': 120, Department: 'Stitching', 'Order Reference': order },
  ]
  const sfgBad = [
    { 'Style / Article No.': style.code, Process: 'Washing', Colour: colour, Size: s1.code, 'Opening Quantity': 1, 'Rate / Valuation': 1 },                         // 4: off the route
    { 'Style / Article No.': style.code, Process: 'Cutting', Colour: colour, Size: s1.code, 'Opening Quantity': 1, 'Rate / Valuation': 1, Department: 'Packing', 'Batch / Bundle Reference': 'X1' }, // 5: department
    { 'Style / Article No.': style.code, Process: 'Cutting', Colour: colour, Size: s1.code, 'Opening Quantity': 1, 'Rate / Valuation': 1, Location: 'Stitching Floor', 'Batch / Bundle Reference': 'X2' }, // 6: another floor
    { 'Style / Article No.': style.code, Colour: colour, Size: s1.code, 'Opening Quantity': 1, 'Rate / Valuation': 1, 'Batch / Bundle Reference': 'X3' },             // 7: no process
    ...(onFloorMo ? [{ 'Style / Article No.': style.code, Process: 'Cutting', Colour: colour, Size: s1.code, 'Opening Quantity': 1, 'Rate / Valuation': 1, 'Order Reference': onFloorMo.moNumber }] : []), // 8: on the floor
  ]
  const sfgCheck = await call('POST', '/inventory/opening-stock/import', { ...(await sheet('SFG', [...sfgGood, ...sfgBad], 'sfg-check')), kind: 'SFG', openingDate: today })
  check('SFG: the good rows pass', problemsOf(sfgCheck, 2) === '' && problemsOf(sfgCheck, 3) === '', [problemsOf(sfgCheck, 2), problemsOf(sfgCheck, 3)])
  const sfgExpect: Array<[number, RegExp, string]> = [
    [4, /Washing is not on ZZTEST-SH-01's route \(Cutting → Stitching → Finishing\)/, 'a process off the route'],
    [5, /Department "Packing" is not where Cutting is done/, 'a department that is not the process'],
    [6, /Stitching Floor is Stitching's floor, not Cutting's/, "another process's floor"],
    [7, /Semi-finished pieces are at a process: give the Process/, 'no process'],
  ]
  if (onFloorMo) sfgExpect.push([8, /is already on the Production Floor/, 'an order whose pieces are on the Production Floor'])
  for (const [row, re, what] of sfgExpect) check(`SFG row ${row} refused: ${what}`, re.test(problemsOf(sfgCheck, row)), problemsOf(sfgCheck, row))
  const sfgDone = await call('POST', '/inventory/opening-stock/import', { ...(await sheet('SFG', sfgGood, `sfg-${stamp}`)), kind: 'SFG', openingDate: today, requestKey: `zz-sfg-${stamp}-key`, confirm: true })
  check('SFG: imported', sfgDone.status === 201 && sfgDone.body?.data?.lines === 2, sfgDone.body)
  const sfgLedger = await prisma.stockLedger.findMany({ where: { referenceId: sfgDone.body?.data?.id }, select: { warehouse: { select: { name: true, departmentId: true } }, orderNo: true } })
  check('SFG ledger: on the Cutting and Stitching floors, for the order', sfgLedger.length === 2 && sfgLedger.every((l) => !!l.warehouse.departmentId && l.orderNo === order) && sfgLedger.some((l) => l.warehouse.name === 'Cutting Floor') && sfgLedger.some((l) => l.warehouse.name === 'Stitching Floor'), sfgLedger)

  // Pieces at a process are not packed stock; the store's are.
  const fgStock = (await call('GET', `/finished-goods/stock?itemIds=${shirt.id}`)).body?.data ?? []
  const floors = await prisma.warehouse.findMany({ where: { departmentId: { not: null } }, select: { id: true } })
  check('finished goods "packed in stock": the Store’s 20, none from the process floors', fgStock.length === 2 && fgStock.every((r: any) => !floors.some((f) => f.id === r.warehouseId)) && fgStock.reduce((t: number, r: any) => t + r.qty, 0) === 20, fgStock)

  // 5. Raw Materials: category, item, lots, into a store.
  const rmGood = [
    { 'Material Category': 'Fabric', 'Item Code': fabric.code, 'Lot / Batch / Roll Number': `L-${stamp}`, 'Bundle / Barcode Number': `R-${stamp}-1`, UOM: 'mtr', 'Opening Quantity': 55.5, 'Unit Rate': 130, Location: 'Fabric Warehouse' },
    { 'Material Category': 'Fabric', 'Item Code': fabric.code, 'Lot / Batch / Roll Number': `L-${stamp}`, 'Bundle / Barcode Number': `R-${stamp}-2`, UOM: 'mtr', 'Opening Quantity': 44, 'Unit Rate': 130, Location: 'Fabric Warehouse', 'Stock Status': 'Hold' },
  ]
  const rmBad = [
    { 'Item Code': shirt.code, 'Opening Quantity': 1, 'Unit Rate': 1, Location: 'Store' },                                                     // 4: a garment
    { 'Material Category': 'Buttons', 'Item Code': fabric.code, 'Opening Quantity': 1, 'Unit Rate': 1, Location: 'Store', 'Bundle / Barcode Number': 'X1' }, // 5: category
    { 'Item Code': fabric.code, 'Opening Quantity': 1, 'Unit Rate': 1, Location: 'Cutting Floor', 'Bundle / Barcode Number': 'X2' },           // 6: a floor
    { 'Item Code': fabric.code, UOM: 'pcs', 'Opening Quantity': 1, 'Unit Rate': 1, Location: 'Store', 'Bundle / Barcode Number': 'X3' },       // 7: unit
  ]
  const rmCheck = await call('POST', '/inventory/opening-stock/import', { ...(await sheet('RM', [...rmGood, ...rmBad], 'rm-check')), kind: 'RM', openingDate: today })
  check('RM: the good rows pass', problemsOf(rmCheck, 2) === '' && problemsOf(rmCheck, 3) === '', [problemsOf(rmCheck, 2), problemsOf(rmCheck, 3)])
  const rmExpect: Array<[number, RegExp, string]> = [
    [4, /is finished goods, not a raw material: enter it under Finished Goods/, 'a garment'],
    [5, /not "Buttons"/, 'a category the item is not in'],
    [6, /Cutting Floor is a process's floor, not a store/, 'a process floor as the store'],
    [7, /counted in mtr, not pcs/, 'a unit not its own'],
  ]
  for (const [row, re, what] of rmExpect) check(`RM row ${row} refused: ${what}`, re.test(problemsOf(rmCheck, row)), problemsOf(rmCheck, row))
  const rmDone = await call('POST', '/inventory/opening-stock/import', { ...(await sheet('RM', rmGood, `rm-${stamp}`)), kind: 'RM', openingDate: today, requestKey: `zz-rm-${stamp}-key`, confirm: true })
  check('RM: imported, a sticker per roll', rmDone.status === 201 && rmDone.body?.data?.lines === 2 && rmDone.body?.data?.stickers === 2, rmDone.body)

  // 6. By hand, by kind: the same rules; a save sent twice posts once.
  const rmByHand = await call('POST', '/inventory/opening-stock/entry', { kind: 'RM', lines: [{ date: today, process: 'Store', location: 'Store', code: shirt.code, qty: 1, rate: 1 }] })
  check('by hand: a garment entered as a raw material is refused', /not a raw material/.test(rmByHand.body?.data?.rows?.[0]?.problems?.join(' ') ?? ''), rmByHand.body)
  const handKey = `zz-hand-${stamp}-key`
  const hand = { kind: 'FG', requestKey: handKey, notes: 'ZZTEST by hand', lines: [{ date: today, process: 'Finished Goods', location: 'Store', style: style.code, code: item.code, colour, size: s1.code, qty: 3, rate: 250, order: `ZZ-HAND-${stamp}` }] }
  const h1 = await call('POST', '/inventory/opening-stock/entry', { ...hand, confirm: true })
  const h2 = await call('POST', '/inventory/opening-stock/entry', { ...hand, confirm: true })
  const handLines = await prisma.openingStockLine.count({ where: { openingStock: { requestKey: handKey } } })
  check('by hand: saved once, the second press finds it', h1.status === 201 && h2.body?.data?.again === true && h2.body?.data?.number === h1.body?.data?.number && handLines === 1, { h1: h1.body?.message, h2: h2.body?.message, handLines })

  // 7. The list by kind: semi-finished at the floors, finished in the store.
  const lines = async (group: string) => ((await call('GET', `/inventory/opening-stock/lines?group=${group}&q=${encodeURIComponent(item.code)}&limit=200`)).body?.data?.lines ?? []) as Array<{ warehouse: { name: string } }>
  const sfgLines = await lines('SFG')
  const fgLines = await lines('FG')
  check('Semi Finished Goods: the 2 lines at the floors; Finished Goods: the 3 in the Store', sfgLines.length === 2 && sfgLines.every((l) => /Floor/.test(l.warehouse.name)) && fgLines.length === 3 && fgLines.every((l) => l.warehouse.name === 'Store'), { sfg: sfgLines.map((l) => l.warehouse.name), fg: fgLines.map((l) => l.warehouse.name) })

  // 8. A style without a size run is given one, once.
  const bare = await prisma.style.findFirst({ where: { code: 'ZZTEST-SH-03' }, select: { id: true } })
  if (!bare) console.log('SKIP  a style with no size run: no ZZTEST-SH-03 on this demo')
  else {
    await prisma.style.update({ where: { id: bare.id }, data: { sizeGroupId: null } })
    const run = await call('POST', '/inventory/opening-stock/style-size-run', { styleId: bare.id, sizeGroupId: style.sizeGroupId })
    const run2 = await call('POST', '/inventory/opening-stock/style-size-run', { styleId: bare.id, sizeGroupId: style.sizeGroupId })
    check('a style with no size run is given one; a second time is refused', ok(run) && run2.status === 400 && run2.body?.code === 'HAS_SIZE_RUN', { run: run.body, run2: run2.body })
  }

  console.log(`\n${pass} passed, ${fail} failed`)
  if (fail) process.exitCode = 1
}

main()
  .catch((e) => { console.error(e); process.exitCode = 1 })
  .finally(() => prisma.$disconnect())
