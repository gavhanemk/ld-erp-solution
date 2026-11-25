/**
 * Checks physical packaging across Opening Stock, Stickers and Scan against a
 * running API and the demo database (lderp_demo) only — refuses any other.
 * Each run makes its own ZZTEST fabric, so it can be run again and again.
 * From apps/api:
 *
 *   DATABASE_URL="postgresql://postgres:demo@localhost:5433/lderp_demo?schema=ld_erp" \
 *   E2E_EMAIL=... E2E_PASSWORD=... E2E_API=http://localhost:5105/api npx tsx ../../tools/check-packaging.ts
 */
import ExcelJS from 'exceljs'
import { prisma } from '../packages/database/src/index'

const API = (process.env.E2E_API || 'http://localhost:5101/api').replace(/\/+$/, '')
const RM = ['Material Category', 'Item Code', 'Item Name', 'Lot / Batch / Roll Number', 'Bundle / Barcode Number', 'UOM', 'Opening Quantity', 'Unit Rate', 'Location', 'Package Type', 'Package Count', 'Qty per Package', 'Package Quantities', 'Package References', 'Stock Status', 'Remarks']

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
async function rmSheet(rows: Array<Partial<Record<string, string | number>>>, name: string) {
  const res = await fetch(`${API}/inventory/opening-stock/import-template?type=RM`, { headers: { authorization: `Bearer ${token}` } })
  const wb = new ExcelJS.Workbook()
  await wb.xlsx.load(Buffer.from(await res.arrayBuffer()) as unknown as ExcelJS.Buffer)
  const ws = wb.getWorksheet('Raw Materials')!
  // The template's grey example row goes first, as a person deletes it.
  ws.spliceRows(2, 1)
  rows.forEach((r, i) => RM.forEach((h, c) => { if (r[h] !== undefined) ws.getCell(i + 2, c + 1).value = r[h] as string | number }))
  return { fileName: `${name}.xlsx`, file: Buffer.from(await wb.xlsx.writeBuffer()).toString('base64') }
}
const problemsOf = (res: Res, row: number) => ((res.body?.data?.rows ?? []) as Array<{ row: number; problems: string[] }>).find((r) => r.row === row)?.problems.join(' | ') ?? ''
const packingOf = (res: Res, row: number) => ((res.body?.data?.rows ?? []) as Array<{ row: number; packing: string | null; stickers: number }>).find((r) => r.row === row)

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
  const fabricCat = await prisma.itemCategory.findFirstOrThrow({ where: { name: 'Fabric', isActive: true }, select: { id: true } })
  const mtr = await prisma.uOM.findFirstOrThrow({ where: { symbol: 'mtr' }, select: { id: true } })
  const fabric = (await call('POST', '/masters/items', { name: `ZZTEST Pack Fabric ${stamp}`, type: 'RAW_MATERIAL', categoryId: fabricCat.id, uomId: mtr.id })).body.data
  const store = 'Fabric Warehouse'
  const base = { 'Material Category': 'Fabric', 'Item Code': fabric.code, UOM: 'mtr', 'Unit Rate': 100, Location: store }

  // 1. The template carries the packing columns.
  const tpl = await fetch(`${API}/inventory/opening-stock/import-template?type=RM`, { headers: { authorization: `Bearer ${token}` } })
  const twb = new ExcelJS.Workbook()
  await twb.xlsx.load(Buffer.from(await tpl.arrayBuffer()) as unknown as ExcelJS.Buffer)
  const heads = ((twb.getWorksheet('Raw Materials')!.getRow(1).values as unknown[]) ?? []).slice(1).map(String)
  check('RM template: the packing columns after Location', JSON.stringify(heads.map((h) => h.replace(/\s*\*$/, ''))) === JSON.stringify(RM), heads)

  // 2. Every way of saying how it is packed.
  const good = [
    { ...base, 'Lot / Batch / Roll Number': `A-${stamp}`, 'Opening Quantity': 1000, 'Package Type': 'Roll', 'Package Quantities': '200, 250, 150, 180, 220', 'Package References': `S1-${stamp},S2-${stamp},S3-${stamp},S4-${stamp},S5-${stamp}` }, // 2: each roll
    { ...base, 'Lot / Batch / Roll Number': `B-${stamp}`, 'Opening Quantity': 1200, 'Package Type': 'Box', 'Qty per Package': 500 },                                 // 3: 500 + 500 + 200
    { ...base, 'Lot / Batch / Roll Number': `C-${stamp}`, 'Opening Quantity': 800, 'Package Type': 'Roll', 'Package Count': 4 },                                     // 4: count only → later
    { ...base, 'Lot / Batch / Roll Number': `D-${stamp}`, 'Bundle / Barcode Number': `BC-${stamp}`, 'Opening Quantity': 55.5 },                                     // 5: its own barcode → one
    { ...base, 'Lot / Batch / Roll Number': `E-${stamp}`, 'Opening Quantity': 300 },                                                                               // 6: nothing → waits
    { ...base, 'Lot / Batch / Roll Number': `F-${stamp}`, 'Opening Quantity': 100, 'Package Quantities': '60, 40', 'Stock Status': 'Hold' },                        // 7: all of it, held
  ]
  const bad = [
    { ...base, 'Lot / Batch / Roll Number': `X1-${stamp}`, 'Opening Quantity': 100, 'Package Quantities': '60, 50' },        // 8: more than the row
    { ...base, 'Lot / Batch / Roll Number': `X2-${stamp}`, 'Opening Quantity': 100, 'Package Count': 3, 'Package Quantities': '50, 50' }, // 9: count ≠ list
    { ...base, 'Lot / Batch / Roll Number': `X3-${stamp}`, 'Opening Quantity': 100, 'Package Type': 'Crate' },                // 10: unknown type
    { ...base, 'Lot / Batch / Roll Number': `X4-${stamp}`, 'Opening Quantity': 100, 'Qty per Package': 30, 'Package Count': 2 }, // 11: 4 packages, not 2
    { ...base, 'Lot / Batch / Roll Number': `X5-${stamp}`, 'Opening Quantity': 100, 'Package Quantities': '60' },             // 12: part of it on packages
  ]
  const checked = await call('POST', '/inventory/opening-stock/import', { ...(await rmSheet([...good, ...bad], 'pack-check')), kind: 'RM', openingDate: today })
  check('the good rows pass', [2, 3, 4, 5, 6, 7].every((r) => problemsOf(checked, r) === ''), [2, 3, 4, 5, 6, 7].map((r) => problemsOf(checked, r)))
  check('each roll its own sticker: 5 rolls', packingOf(checked, 2)?.stickers === 5 && /5 rolls: 200 \+ 250 \+ 150 \+ 180 \+ 220 mtr/.test(packingOf(checked, 2)?.packing ?? ''), packingOf(checked, 2))
  check('a quantity per package: 500 + 500 + 200', packingOf(checked, 3)?.stickers === 3 && /3 boxes: 500 \+ 500 \+ 200 mtr/.test(packingOf(checked, 3)?.packing ?? ''), packingOf(checked, 3))
  check('only a count: packaging pending, equal sizes never assumed', packingOf(checked, 4)?.stickers === 0 && /Packaging pending: 4 rolls, sizes to give later/.test(packingOf(checked, 4)?.packing ?? ''), packingOf(checked, 4))
  check('its own barcode: one package keeping it, nothing to print', packingOf(checked, 5)?.stickers === 0 && new RegExp(`its own barcode BC-${stamp} kept`).test(packingOf(checked, 5)?.packing ?? ''), packingOf(checked, 5))
  check('nothing to go by: packaging pending, none made up', packingOf(checked, 6)?.stickers === 0 && /^Packaging pending/.test(packingOf(checked, 6)?.packing ?? ''), packingOf(checked, 6))
  check('all of it on packages, held: 2 stickers', packingOf(checked, 7)?.stickers === 2 && /2 rolls?|2 packages|60 \+ 40/.test(packingOf(checked, 7)?.packing ?? ''), packingOf(checked, 7))
  const expect: Array<[number, RegExp, string]> = [
    [8, /add up to 110 mtr, but the row has 100 mtr/, 'packages more than the row'],
    [9, /Package Count says 3, but 2 quantities are given/, 'a count that does not match the list'],
    [10, /Package Type "Crate" is not one of/, 'an unknown package type'],
    [11, /at 30 a package is 4 rolls, not 2/, 'a count that does not match the quantity per package'],
    [12, /add up to 60 mtr, but the row has 100 mtr\. The packages must hold exactly all of it/, 'packages for only part of the row'],
  ]
  for (const [row, re, what] of expect) check(`row ${row} refused: ${what}`, re.test(problemsOf(checked, row)), problemsOf(checked, row))
  check('the summary: 10 stickers to print, 1 keeps its own barcode, 2 pending', checked.body?.data?.summary?.stickers === 10 && checked.body?.data?.summary?.kept === 1 && checked.body?.data?.summary?.waiting === 2, checked.body?.data?.summary)
  // Changed on the review before the import: row 3 as two boxes of 600.
  const edited = await call('POST', '/inventory/opening-stock/import', { ...(await rmSheet([...good, ...bad], 'pack-check')), kind: 'RM', openingDate: today, packs: { '3': { type: 'BOX', qtys: [600, 600] } } })
  check('a row changed on the review: checked again as changed', /2 boxes × 600 mtr/.test(packingOf(edited, 3)?.packing ?? '') && packingOf(edited, 3)?.stickers === 2, packingOf(edited, 3))
  const twice = await call('POST', '/inventory/opening-stock/import', {
    ...(await rmSheet([{ ...base, 'Lot / Batch / Roll Number': `T1-${stamp}`, 'Bundle / Barcode Number': `BT-${stamp}`, 'Opening Quantity': 5 }, { ...base, 'Lot / Batch / Roll Number': `T2-${stamp}`, 'Bundle / Barcode Number': `bt-${stamp}`, 'Opening Quantity': 6 }], 'twice')),
    kind: 'RM',
    openingDate: today,
  })
  check('the same barcode twice in a sheet: the second refused', /is also on row 2: one barcode is one package/.test(problemsOf(twice, 3)), problemsOf(twice, 3))

  const done = await call('POST', '/inventory/opening-stock/import', { ...(await rmSheet(good, `pack-${stamp}`)), kind: 'RM', openingDate: today, requestKey: `zz-pack-${stamp}`, confirm: true })
  check('imported: 10 stickers to print', done.status === 201 && done.body?.data?.stickers === 10, done.body)
  const docId = done.body?.data?.id
  const pkgs = await prisma.stockPackage.findMany({ where: { sourceId: docId }, select: { id: true, code: true, qty: true, notes: true, packType: true, grade: true, sourceLineId: true, lotNo: true }, orderBy: { code: 'asc' } })
  const rolls = pkgs.filter((p) => p.lotNo === `A-${stamp}`)
  check('the rolls keep their own references, and name their line', rolls.length === 5 && rolls.every((p) => p.sourceLineId && /^Ref S\d-/.test(p.notes ?? '')) && new Set(rolls.map((p) => p.sourceLineId)).size === 1, rolls)
  check('the held part is a held sticker', pkgs.some((p) => p.lotNo === `F-${stamp}` && p.grade === 'R' && Number(p.qty) === 60), pkgs.filter((p) => p.lotNo === `F-${stamp}`))
  const own = pkgs.find((p) => p.lotNo === `D-${stamp}`)!
  const byBarcode = await call('GET', `/packages/scan/${encodeURIComponent(`bc-${stamp}`)}`)
  check('scanning its own barcode finds the package', byBarcode.status === 200 && byBarcode.body?.data?.code === own.code && byBarcode.body?.data?.barcode === `BC-${stamp}`, byBarcode.body?.data && { code: byBarcode.body.data.code, barcode: byBarcode.body.data.barcode })
  const readyNow = (await call('GET', `/packages/ready?sourceType=OPENING&sourceId=${docId}`)).body?.data?.groups ?? []
  check('a package keeping its own barcode is not waiting to print', !readyNow.some((g: any) => g.ids.includes(own.id)), readyNow.map((g: any) => g.lots))
  const reused = await call('POST', '/inventory/opening-stock/import', {
    ...(await rmSheet([{ ...base, 'Lot / Batch / Roll Number': `Z-${stamp}`, 'Bundle / Barcode Number': `BC-${stamp}`, 'Opening Quantity': 5 }], 'again')),
    kind: 'RM',
    openingDate: today,
  })
  check('a barcode already on a package: refused, naming it', new RegExp(`BC-${stamp} is already on package ${own.code}`).test(problemsOf(reused, 2)), problemsOf(reused, 2))
  const ledger = await prisma.stockLedger.aggregate({ where: { referenceId: docId }, _sum: { inQty: true } })
  check('all the stock is in, stickered or not: 3,455.5 mtr', Math.abs(Number(ledger._sum.inQty) - 3455.5) < 0.001, ledger._sum)

  // 3. Each line says where it stands; the count-only line gets its sizes later.
  const lines = (await call('GET', `/inventory/opening-stock/lines?entry=${docId}&limit=50`)).body?.data?.lines ?? []
  const lineOf = (lot: string) => lines.find((l: any) => l.lotNo === lot)
  check('lines: 5 rolls made; the count-only line waits for 800', lineOf(`A-${stamp}`)?.stickers?.made === 5 && lineOf(`C-${stamp}`)?.stickers?.waiting === 800 && lineOf(`C-${stamp}`)?.packCount === 4, { a: lineOf(`A-${stamp}`)?.stickers, c: lineOf(`C-${stamp}`) && { s: lineOf(`C-${stamp}`).stickers, n: lineOf(`C-${stamp}`).packCount } })
  const cLine = lineOf(`C-${stamp}`)
  const tooMuch = await call('POST', `/inventory/opening-stock/lines/${cLine.id}/packages`, { pack: { type: 'ROLL', qtys: [300, 300, 300] } })
  check('later: more than the line has is refused', tooMuch.status === 400 && /add up to 900 mtr, but the row has 800 mtr/.test(tooMuch.body?.message ?? ''), tooMuch.body)
  const tooLittle = await call('POST', `/inventory/opening-stock/lines/${cLine.id}/packages`, { pack: { type: 'ROLL', qtys: [300] } })
  check('later: part of it is refused too — all 800 on stickers, or none', tooLittle.status === 400 && /add up to 300 mtr, but the row has 800 mtr/.test(tooLittle.body?.message ?? ''), tooLittle.body)
  const later = await call('POST', `/inventory/opening-stock/lines/${cLine.id}/packages`, { pack: { type: 'ROLL', qtys: [210, 190, 200, 200] } })
  check('later: the 4 rolls made, naming the line', later.status === 201 && later.body?.data?.ids?.length === 4 && later.body?.data?.left === 0, later.body)
  const again = await call('POST', `/inventory/opening-stock/lines/${cLine.id}/packages`, { pack: { qtys: [1] } })
  check('and once all is on stickers, nothing more', again.status === 400 && again.body?.code === 'ALL_PACKED', again.body)

  // 4. Change: opening stock is packed in full or not at all.
  const boxes = pkgs.filter((p) => p.lotNo === `B-${stamp}`)
  const partly = await call('POST', '/packages/restick', { ids: boxes.map((b) => b.id), qtys: [700], packType: 'BOX', leaveLoose: true })
  check('Change to one of 700, leaving 500 loose: refused for opening stock', partly.status === 400 && /packed in full or not at all/.test(partly.body?.message ?? ''), partly.body)
  const change = await call('POST', '/packages/restick', { ids: boxes.map((b) => b.id), qtys: [700, 500], packType: 'BOX', leaveLoose: true })
  check('Change to 700 + 500: all of it, nothing loose', change.status === 200 && !(change.body?.data?.leftLoose > 0), change.body)
  const lines2 = (await call('GET', `/inventory/opening-stock/lines?entry=${docId}&limit=50`)).body?.data?.lines ?? []
  check('the line waits for nothing', lines2.find((l: any) => l.lotNo === `B-${stamp}`)?.stickers?.waiting === 0, lines2.find((l: any) => l.lotNo === `B-${stamp}`)?.stickers)
  const old = await call('GET', `/packages/scan/${boxes[0].code}`)
  check('a changed sticker names what replaced it in its history', /made into 2 new: PK-/.test(JSON.stringify(old.body?.data?.moves ?? [])), old.body?.data?.moves?.[0])

  // 5. Merge: two rolls of one lot into one; across lots refused.
  const [r1, r2] = rolls
  const mixed = await call('POST', '/packages/merge', { ids: [r1.id, pkgs.find((p) => p.lotNo === `D-${stamp}`)!.id] })
  check('different lots cannot be put together', mixed.status === 400 && /differ in lot/.test(mixed.body?.message ?? ''), mixed.body)
  const merged = await call('POST', '/packages/merge', { ids: [r1.id, r2.id] })
  check('two rolls put together: 450 mtr on one new sticker', merged.status === 201 && merged.body?.data?.qty === 450, merged.body)
  const r1Now = await call('GET', `/packages/scan/${r1.code}`)
  check('the old sticker, scanned: merged, naming the new one', r1Now.body?.data?.status === 'MERGED' && r1Now.body?.data?.mergedInto?.code === merged.body?.data?.code && r1Now.body?.data?.replacedBy?.[0]?.code === merged.body?.data?.code, r1Now.body?.data && { s: r1Now.body.data.status, into: r1Now.body.data.mergedInto, by: r1Now.body.data.replacedBy })
  const age = await prisma.stockPackage.findMany({ where: { id: { in: [r1.id, merged.body?.data?.id] } }, select: { id: true, createdAt: true } })
  check('the new one keeps the oldest age (first in, first out)', age.length === 2 && age[0].createdAt.getTime() === age[1].createdAt.getTime(), age)
  const pos = await prisma.stockPackage.aggregate({ where: { itemId: fabric.id, status: 'IN_STOCK' }, _sum: { qty: true } })
  check('merging changes no stock: stickers still hold what they did', Math.abs(Number(pos._sum.qty) - (1000 + 1200 + 800 + 55.5 + 100)) < 0.001, pos._sum)
  const lines3 = (await call('GET', `/inventory/opening-stock/lines?entry=${docId}&limit=50`)).body?.data?.lines ?? []
  const aLine = lines3.find((l: any) => l.lotNo === `A-${stamp}`)
  check('the line counts its stock once after a merge: 4 stickers, nothing waiting', aLine?.stickers?.made === 4 && aLine?.stickers?.waiting === 0 && aLine?.stickers?.qty === 1000, aLine?.stickers)
  const toPrint = await call('GET', `/inventory/opening-stock/lines/${aLine?.id}/packages`)
  check("a line's stickers to print: the 3 rolls and the merged one", toPrint.body?.data?.ids?.length === 4 && toPrint.body.data.ids.includes(merged.body?.data?.id), toPrint.body)
  const issueOld = await call('POST', `/packages/${r1.id}/issue`, { mrId: 'none', lineId: 'none', qty: 1 })
  check('issuing from a merged sticker is refused, naming the one to scan', issueOld.status === 409 && issueOld.body?.code === 'STICKER_RETIRED' && issueOld.body?.message?.includes(merged.body?.data?.code), issueOld.body)

  // 6. Edit details; changed since printed.
  const third = rolls[2]
  await call('POST', '/packages/printed', { ids: [third.id] })
  const edit = await call('POST', `/packages/${third.id}/edit`, { lotNo: `A2-${stamp}`, notes: 'short width' })
  check('details corrected, said in its history', edit.status === 200 && /lot A-\d+ → A2-\d+/.test(edit.body?.message ?? '') && edit.body?.data?.moves?.[0]?.type === 'EDITED', edit.body?.message)
  check('printed before: now changed since printed', (edit.body?.data?.changedSincePrint ?? []).includes('details corrected'), edit.body?.data?.changedSincePrint)
  const changed = await call('GET', '/packages/changed')
  check('it is on the changed-since-printed list', (changed.body?.data ?? []).some((p: any) => p.id === third.id), (changed.body?.data ?? []).length)
  await new Promise((r) => setTimeout(r, 20))
  await call('POST', '/packages/printed', { ids: [third.id] })
  const changed2 = await call('GET', '/packages/changed')
  check('printed again: off the list', !(changed2.body?.data ?? []).some((p: any) => p.id === third.id))
  const nothing = await call('POST', `/packages/${third.id}/edit`, { lotNo: `A2-${stamp}` })
  check('editing to the same is "nothing changed"', nothing.status === 400 && nothing.body?.code === 'NO_CHANGE', nothing.body)
  const grp = (await call('GET', `/packages/groups?itemId=${fabric.id}`)).body?.data ?? []
  const inStore = grp.find((g: any) => g.store === store)
  check('the item line says what is without stickers (300 mtr) and none to reprint', Math.abs((inStore?.loose ?? -1) - 300) < 0.001 && inStore?.changed === 0, inStore && { loose: inStore.loose, changed: inStore.changed })

  // 7. Held shows as held on the scan card.
  const held = await call('GET', `/packages/scan/${pkgs.find((p) => p.grade === 'R')!.code}`)
  check('a held sticker scanned says it is held', held.body?.data?.held === true, held.body?.data?.held)

  // 8. Sticker settings, and copies on the labels.
  const before = (await call('GET', '/packages/templates')).body?.data
  check('sticker settings: one for each kind of package, with defaults', !!before?.templates?.ROLL && !!before?.templates?.DEFAULT && before.fields.includes('lot'), before && Object.keys(before.templates))
  const saved = await call('PATCH', '/packages/templates', { templates: { ...before.templates, ROLL: { ...before.templates.ROLL, fields: ['itemCode', 'qty', 'lot'], copies: 2, font: 'L' } } })
  check('settings saved', saved.status === 200 && saved.body?.data?.templates?.ROLL?.copies === 2, saved.body)
  const copies = await call('PATCH', `/masters/items/${fabric.id}`, { labelCopies: 3 })
  check('an item asks for 3 copies of its stickers', copies.status === 200 && copies.body?.data?.labelCopies === 3, copies.body?.data?.labelCopies ?? copies.body)
  const tooMany = await call('PATCH', `/masters/items/${fabric.id}`, { labelCopies: 9 })
  check('more than 5 copies refused', tooMany.status === 400, tooMany.status)
  const labels = await call('GET', `/packages/labels?ids=${rolls[3].id}`)
  check('labels carry the settings, the item’s copies and the line’s roll number', labels.body?.data?.templates?.ROLL?.copies === 2 && labels.body?.data?.packages?.[0]?.copies === 3 && labels.body?.data?.packages?.[0]?.seq?.of >= 3, labels.body?.data?.packages?.[0])
  await call('PATCH', '/packages/templates', { templates: before.templates })

  // 9. Ready to print: one group per line, with its lots.
  const ready = (await call('GET', `/packages/ready?sourceType=OPENING&sourceId=${docId}`)).body?.data?.groups ?? []
  check('Ready to print: a group for each line, with its lot', ready.length >= 4 && ready.every((g: any) => g.lots.length <= 1) && ready.some((g: any) => g.lots[0] === `A-${stamp}`), ready.map((g: any) => [g.lots, g.ids.length]))

  // 10. Labelled from Stickers → Packaging pending: the lines no longer wait.
  const linesBefore = (await call('GET', `/inventory/opening-stock/lines?entry=${docId}&limit=50`)).body?.data?.lines ?? []
  const pendingBefore = linesBefore.reduce((t: number, l: any) => t + (l.stickers?.waiting ?? 0), 0)
  const fabricStore = await prisma.warehouse.findFirstOrThrow({ where: { name: store }, select: { id: true } })
  const loose = await call('POST', '/packages', { itemId: fabric.id, warehouseId: fabricStore.id, qtys: [pendingBefore], packType: 'ROLL' })
  const linesAfter = (await call('GET', `/inventory/opening-stock/lines?entry=${docId}&limit=50`)).body?.data?.lines ?? []
  check(`stickered from Stickers (${pendingBefore} mtr): no line shows packaging pending`, loose.status === 201 && linesAfter.every((l: any) => (l.stickers?.waiting ?? 0) === 0), { made: loose.status, waiting: linesAfter.map((l: any) => [l.lotNo, l.stickers?.waiting]) })
  const dLine = linesAfter.find((l: any) => l.lotNo === `D-${stamp}`)
  const dPk = await call('GET', `/inventory/opening-stock/lines/${dLine?.id}/packages`)
  check("a line's stickers still whole can be changed", dPk.body?.data?.change?.ids?.length === 1 && dPk.body.data.change.qty === 55.5, dPk.body?.data)

  // 11. The entry form: every finished item of a style, by code, name and description.
  const form = (await call('GET', '/inventory/opening-stock/form')).body?.data
  const withItems = (form?.styles ?? []).filter((st: any) => st.items?.length)
  check("each style lists its finished items with code and name", withItems.length > 0 && withItems.every((st: any) => st.items.every((i: any) => i.id && i.code && typeof i.name === 'string' && 'description' in i)) && withItems.every((st: any) => st.colours.every((c: any) => !c.item || st.items.some((i: any) => i.id === c.item.id))), withItems.slice(0, 2).map((st: any) => [st.code, st.items.map((i: any) => i.code)]))

  // 12. By hand, packed as said.
  const hand = await call('POST', '/inventory/opening-stock/entry', {
    kind: 'RM',
    confirm: true,
    requestKey: `zz-packhand-${stamp}`,
    lines: [{ date: today, process: 'Store', location: store, code: fabric.code, qty: 30.5, rate: 100, lot: `H-${stamp}`, pack: { type: 'ROLL', qtys: [20, 10.5] } }],
  })
  check('by hand: 2 rolls as given', hand.status === 201 && hand.body?.data?.stickers === 2, hand.body)

  console.log(`\n${pass} passed, ${fail} failed`)
  if (fail) process.exitCode = 1
}

main()
  .catch((e) => { console.error(e); process.exitCode = 1 })
  .finally(() => prisma.$disconnect())
