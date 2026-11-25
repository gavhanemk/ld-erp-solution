/**
 * Checks the controls on opening stock: a new item's HSN and GST, similar
 * names matched instead of made, valuation pending and its rate set from the
 * opening date (issues since priced again), corrections and reversals asked
 * for and approved, and an import that fails half way leaving nothing behind
 * — against a running API and the demo database (lderp_demo) only. Refuses
 * any other database. Each run makes its own ZZTEST items. From apps/api:
 *
 *   DATABASE_URL="postgresql://postgres:demo@localhost:5433/lderp_demo?schema=ld_erp" \
 *   E2E_EMAIL=... E2E_PASSWORD=... E2E_API=http://localhost:5105/api npx tsx ../../tools/check-opening-controls.ts
 */
import ExcelJS from 'exceljs'
import { prisma } from '../packages/database/src/index'
import * as openingStock from '../apps/api/src/services/openingStock.service'

const API = (process.env.E2E_API || 'http://localhost:5101/api').replace(/\/+$/, '')
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
const plain = (h: string) => h.replace(/\s*\*$/, '')
/** The 19-column template, the example row deleted, these rows filled in. */
async function sheet(rows: Array<Record<string, string | number>>, name: string) {
  const res = await fetch(`${API}/inventory/opening-stock/import-template`, { headers: { authorization: `Bearer ${token}` } })
  const wb = new ExcelJS.Workbook()
  await wb.xlsx.load(Buffer.from(await res.arrayBuffer()) as unknown as ExcelJS.Buffer)
  const ws = wb.getWorksheet('Opening Stock')!
  ws.spliceRows(2, 1)
  const heads = ((ws.getRow(1).values as unknown[]) ?? []).slice(1).map((v) => plain(String(v)))
  rows.forEach((r, i) => heads.forEach((h, c) => { if (r[h] !== undefined) ws.getCell(i + 2, c + 1).value = r[h] }))
  return { fileName: `${name}.xlsx`, file: Buffer.from(await wb.xlsx.writeBuffer()).toString('base64') }
}
const rowOf = (r: Res, n: number) => ((r.body?.data?.rows ?? []) as any[]).find((x) => x.row === n)
const problemsOf = (r: Res, n: number) => (rowOf(r, n)?.problems ?? []).join(' | ')
/** Checked, then imported with every new item approved. */
async function importApproved(file: { fileName: string; file: string }, key: string, extra: Record<string, unknown> = {}) {
  const checked = await call('POST', '/inventory/opening-stock/import', { ...file, ...extra })
  const resolve = Object.fromEntries(((checked.body?.data?.summary?.decisions ?? []) as any[]).map((d) => [d.key, 'NEW']))
  return call('POST', '/inventory/opening-stock/import', { ...file, ...extra, confirm: true, requestKey: key, resolve })
}
const balance = async (itemId: string, warehouseId: string) => {
  const a = await prisma.stockLedger.aggregate({ where: { itemId, warehouseId, sizeId: null, grade: 'A' }, _sum: { inQty: true, outQty: true } })
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
  const date = `${today.slice(8, 10)}-${today.slice(5, 7)}-${today.slice(0, 4)}`
  const fabric = await prisma.itemCategory.findFirstOrThrow({ where: { isActive: true, name: 'Fabric', parentId: { not: null } }, select: { id: true, hsnCode: true } })
  const stores = await prisma.warehouse.findMany({ where: { isActive: true, departmentId: null }, select: { id: true, name: true }, orderBy: { name: 'asc' } })
  const store = stores.find((w) => w.name.toLowerCase() === 'store')!
  const other = stores.find((w) => w.id !== store.id)!

  // 1. A new item's HSN and GST: the sheet's, else its category's — always a code in the HSN list.
  await prisma.itemCategory.update({ where: { id: fabric.id }, data: { hsnCode: null } })
  const n = (s: string) => `ZZTEST Ctrl ${s} ${stamp}`
  const taxCheck = await call('POST', '/inventory/opening-stock/import', await sheet([
    { 'Opening Date': date, 'Item Description': n('Noh'), 'Item Category': 'Fabric', 'Opening Qty': 5 },                                   // 2: none anywhere
    { 'Opening Date': date, 'Item Description': n('Sheet'), 'Item Category': 'Fabric', 'Opening Qty': 5, 'HSN Code': '5208' },            // 3: the sheet's
    { 'Opening Date': date, 'Item Description': n('Unlisted'), 'Item Category': 'Fabric', 'Opening Qty': 5, 'HSN Code': '99999999' },     // 4: not in the list
    { 'Opening Date': date, 'Item Description': n('Wrong'), 'Item Category': 'Fabric', 'Opening Qty': 5, 'HSN Code': '5208', 'GST %': 12 }, // 5: GST not the code's
  ], `zz-ctrl-tax-${stamp}`))
  check('no HSN anywhere: not refused, made without one and said so', problemsOf(taxCheck, 2) === '' && rowOf(taxCheck, 2)?.newItem?.hsn === null && /No HSN code yet/.test(rowOf(taxCheck, 2)?.newItem?.tax ?? ''), rowOf(taxCheck, 2))
  check('the summary counts the new items with no HSN code', taxCheck.body?.data?.summary?.noHsn === 1, taxCheck.body?.data?.summary?.noHsn)
  const nohKey = rowOf(taxCheck, 2)?.newItem?.key
  const typedFile = await sheet([{ 'Opening Date': date, 'Item Description': n('Noh'), 'Item Category': 'Fabric', 'Opening Qty': 5 }], `zz-ctrl-typed-${stamp}`)
  const typed = await call('POST', '/inventory/opening-stock/import', { ...typedFile, hsn: { [nohKey]: '5208' } })
  check("an HSN typed for it on the review: taken, with the code's GST", problemsOf(typed, 2) === '' && rowOf(typed, 2)?.newItem?.hsn === '5208' && /HSN 5208 · GST 5% \(from the HSN code typed for it\)/.test(rowOf(typed, 2)?.newItem?.tax ?? ''), rowOf(typed, 2)?.newItem)
  const typedBad = await call('POST', '/inventory/opening-stock/import', { ...typedFile, hsn: { [nohKey]: '99999999' } })
  check('an HSN typed that is not in the list: refused', /HSN 99999999 \(from the HSN code typed for it\) is not in Masters → HSN \/ SAC Codes/.test(problemsOf(typedBad, 2)), problemsOf(typedBad, 2))
  const nohIn = await importApproved(typedFile, `zz-ctrl-noh-${stamp}`)
  const noh = await prisma.item.findFirst({ where: { name: n('Noh') }, select: { hsnCode: true, taxRateId: true } })
  check('imported with no HSN: the item is made, its HSN and GST empty', nohIn.status === 201 && !!noh && noh.hsnCode === null && noh.taxRateId === null, { status: nohIn.status, noh })
  check("the sheet's HSN: taken, with the code's GST", problemsOf(taxCheck, 3) === '' && /HSN 5208 · GST 5% \(from the HSN Code column\)/.test(rowOf(taxCheck, 3)?.newItem?.tax ?? ''), rowOf(taxCheck, 3)?.newItem)
  check('an HSN not in the list: refused', /HSN 99999999 .* is not in Masters → HSN \/ SAC Codes/.test(problemsOf(taxCheck, 4)), problemsOf(taxCheck, 4))
  check('a GST % that is not the code’s: refused', /HSN 5208 carries GST 5% in Masters → HSN \/ SAC Codes, not 12%/.test(problemsOf(taxCheck, 5)), problemsOf(taxCheck, 5))
  const setHsn = await call('PATCH', `/masters/item-categories/${fabric.id}`, { hsnCode: '5208' })
  check('the category takes an HSN code', setHsn.status === 200, setHsn.body)
  const fromCat = await call('POST', '/inventory/opening-stock/import', await sheet([{ 'Opening Date': date, 'Item Description': n('Cat'), 'Item Category': 'Fabric', 'Opening Qty': 5 }], `zz-ctrl-cat-${stamp}`))
  check("no HSN on the sheet: the category's", problemsOf(fromCat, 2) === '' && /from the category Fabric/.test(rowOf(fromCat, 2)?.newItem?.tax ?? ''), rowOf(fromCat, 2)?.newItem)

  // 2. A name like one already there: matched, not made twice.
  const base = n('Poplin')
  const first = await importApproved(await sheet([{ 'Opening Date': date, 'Item Description': base, 'Item Category': 'Fabric', 'Opening Qty': 40, 'Unit Rate': 90 }], `zz-ctrl-base-${stamp}`), `zz-ctrl-base-${stamp}`)
  check('an item made and approved', first.status === 201 && first.body?.data?.itemsMade?.length === 1, first.body)
  const made = await prisma.item.findFirstOrThrow({ where: { name: base }, select: { id: true, code: true } })
  const typo = n('Poplim')
  const typoFile = await sheet([{ 'Opening Date': date, 'Item Description': typo, 'Item Category': 'Fabric', 'Lot / Batch / Roll No.': 'T1', 'Opening Qty': 10, 'Unit Rate': 90 }], `zz-ctrl-typo-${stamp}`)
  const typoCheck = await call('POST', '/inventory/opening-stock/import', typoFile)
  const d0 = typoCheck.body?.data?.summary?.decisions?.[0]
  check('a spelling slip: the item already there offered as similar', d0?.decision === 'PENDING' && (d0?.similar ?? []).some((x: any) => x.id === made.id), d0)
  const matched = await call('POST', '/inventory/opening-stock/import', { ...typoFile, resolve: { [d0.key]: made.id } })
  check('matched to it: no new item, the row on the item already there', !(matched.body?.data?.summary?.itemsToMake ?? []).length && rowOf(matched, 2)?.item?.code === made.code && rowOf(matched, 2)?.matched?.name === typo, rowOf(matched, 2))
  const matchedIn = await call('POST', '/inventory/opening-stock/import', { ...typoFile, confirm: true, requestKey: `zz-ctrl-typo-${stamp}`, resolve: { [d0.key]: made.id } })
  check('imported onto it; nothing made', matchedIn.status === 201 && !(matchedIn.body?.data?.itemsMade ?? []).length && !(await prisma.item.findFirst({ where: { name: typo } })), matchedIn.body)

  // 3. Valuation pending: in at nought, flagged; its rate set later, from the opening date.
  const pendingName = n('Twill')
  const pendFile = await sheet([{ 'Opening Date': date, 'Item Description': pendingName, 'Item Category': 'Fabric', 'Opening Qty': 50 }], `zz-ctrl-pend-${stamp}`)
  const pendCheck = await call('POST', '/inventory/opening-stock/import', pendFile)
  check('no rate: the row flagged valuation pending', rowOf(pendCheck, 2)?.valuationPending === true && pendCheck.body?.data?.summary?.valuationPending === 1, rowOf(pendCheck, 2))
  const pendIn = await importApproved(pendFile, `zz-ctrl-pend-${stamp}`)
  const twill = await prisma.item.findFirstOrThrow({ where: { name: pendingName }, select: { id: true } })
  const pLine = await prisma.openingStockLine.findFirstOrThrow({ where: { openingStockId: pendIn.body?.data?.id }, select: { id: true, valuationPending: true, ledgerId: true } })
  check('in at nought, the line says valuation pending, and knows its movement', pLine.valuationPending && Boolean(pLine.ledgerId), pLine)
  const moved = await call('POST', '/inventory/transfers', { fromWarehouseId: store.id, toWarehouseId: other.id, lines: [{ itemId: twill.id, qty: 20 }] })
  check('20 of it sent to another store before it is valued', moved.status === 201 || moved.status === 200, moved.body)
  const valued = await call('POST', `/inventory/opening-stock/lines/${pLine.id}/rate`, { rate: 100 })
  check('its rate set: valued from the opening date', valued.status === 200 && valued.body?.data?.value === 5000 && valued.body?.data?.repriced >= 2, valued.body)
  const transferRows = await prisma.stockLedger.findMany({ where: { itemId: twill.id, transactionType: 'TRANSFER' }, select: { unitRate: true, inQty: true, outQty: true } })
  check('the transfer since priced again, both ends at ₹100', transferRows.length === 2 && transferRows.every((r) => Number(r.unitRate) === 100), transferRows)
  const value = async (warehouseId: string) => {
    const rows = await prisma.stockLedger.findMany({ where: { itemId: twill.id, warehouseId }, select: { inQty: true, outQty: true, unitRate: true } })
    return rows.reduce((t, r) => t + (Number(r.inQty) - Number(r.outQty)) * Number(r.unitRate ?? 0), 0)
  }
  check('stock value now: ₹3,000 in the store, ₹2,000 where it went', Math.abs((await value(store.id)) - 3000) < 0.01 && Math.abs((await value(other.id)) - 2000) < 0.01, { store: await value(store.id), other: await value(other.id) })
  const again = await call('POST', `/inventory/opening-stock/lines/${pLine.id}/rate`, { rate: 110 })
  check('valued once: a different rate is a correction, asked for', again.status === 400 && again.body?.code === 'ALREADY_VALUED', again.body)

  // 4. A correction: asked for with a reason, posted once approved.
  const doc = first.body?.data?.id
  const line = await prisma.openingStockLine.findFirstOrThrow({ where: { openingStockId: doc }, select: { id: true, qty: true } })
  const noReason = await call('POST', `/inventory/opening-stock/${doc}/changes`, { kind: 'CORRECTION', reason: '', lines: [{ lineId: line.id, qty: 45 }] })
  check('no reason: refused', noReason.status === 400, noReason.body)
  const asked = await call('POST', `/inventory/opening-stock/${doc}/changes`, { kind: 'CORRECTION', reason: 'Recounted: 5 m more on the roll', lines: [{ lineId: line.id, qty: 45, rate: 95 }] })
  check('a correction asked for: waiting, nothing posted yet', asked.status === 201 && asked.body?.data?.status === 'PENDING' && Number((await prisma.openingStockLine.findUniqueOrThrow({ where: { id: line.id } })).qty) === 40, asked.body)
  const twice = await call('POST', `/inventory/opening-stock/${doc}/changes`, { kind: 'REVERSAL', reason: 'Wrong sheet' })
  check('one request at a time on an entry', twice.status === 400 && twice.body?.code === 'PENDING_CHANGE', twice.body)
  const approved = await call('POST', `/inventory/opening-stock/changes/${asked.body?.data?.id}/approve`, { note: 'Seen the count sheet' })
  const after = await prisma.openingStockLine.findUniqueOrThrow({ where: { id: line.id } })
  const corr = await prisma.stockLedger.findFirst({ where: { referenceType: 'OPENING_CORRECTION', referenceId: asked.body?.data?.id }, select: { inQty: true, unitRate: true } })
  check('approved: 5 more posted at ₹95, the line now 45 at ₹95', approved.status === 200 && Number(after.qty) === 45 && Number(after.unitRate) === 95 && Number(corr?.inQty) === 5 && Number(corr?.unitRate) === 95, { approved: approved.body, after: { qty: after.qty, rate: after.unitRate }, corr })
  const opening = await prisma.stockLedger.findUniqueOrThrow({ where: { id: after.ledgerId! }, select: { unitRate: true } })
  check('the opening movement itself at the corrected rate', Number(opening.unitRate) === 95, opening)

  // 5. A reversal: the whole entry taken back, its stickers voided; the same stock may come in again.
  const revName = n('Rev')
  const revFile = await sheet([
    { 'Opening Date': date, 'Item Description': revName, 'Item Category': 'Fabric', 'Lot / Batch / Roll No.': 'R1', 'Opening Qty': 50, 'Unit Rate': 80 },
    { 'Opening Date': date, 'Item Description': revName, 'Item Category': 'Fabric', 'Lot / Batch / Roll No.': 'R2', 'Opening Qty': 25, 'Unit Rate': 80 },
  ], `zz-ctrl-rev-${stamp}`)
  // Its first lot packed as two rolls, as the review's Change sets it.
  const revIn = await importApproved(revFile, `zz-ctrl-rev-${stamp}`, { packs: { '2': { type: 'ROLL', qtys: [30, 20] } } })
  const revDoc = revIn.body?.data?.id
  const revItem = await prisma.item.findFirstOrThrow({ where: { name: revName }, select: { id: true } })
  check('an entry in: 75 m, 2 stickers', revIn.status === 201 && (await balance(revItem.id, store.id)) === 75 && revIn.body?.data?.stickers === 2, revIn.body)
  const rej = await call('POST', `/inventory/opening-stock/${revDoc}/changes`, { kind: 'REVERSAL', reason: 'Imported twice by mistake' })
  const turned = await call('POST', `/inventory/opening-stock/changes/${rej.body?.data?.id}/reject`, { note: 'It was not twice' })
  check('turned down with a reason: nothing posted', turned.status === 200 && turned.body?.data?.status === 'REJECTED' && (await balance(revItem.id, store.id)) === 75, turned.body)
  const rev = await call('POST', `/inventory/opening-stock/${revDoc}/changes`, { kind: 'REVERSAL', reason: 'Wrong store: re-entering it' })
  const revOk = await call('POST', `/inventory/opening-stock/changes/${rev.body?.data?.id}/approve`, {})
  const voided = await prisma.stockPackage.count({ where: { sourceId: revDoc, status: 'VOID' } })
  const revEntry = await prisma.openingStock.findUniqueOrThrow({ where: { id: revDoc }, select: { reversedAt: true, lines: { select: { id: true } } } })
  check('reversed: its stock out again, its stickers voided, the entry kept and marked', revOk.status === 200 && (await balance(revItem.id, store.id)) === 0 && voided === 2 && Boolean(revEntry.reversedAt) && revEntry.lines.length === 2, { body: revOk.body, voided, reversedAt: revEntry.reversedAt })
  const reAgain = await call('POST', '/inventory/opening-stock/import', revFile)
  check('the same stock may be brought in again after the reversal', reAgain.status === 200 && [2, 3].every((r) => problemsOf(reAgain, r) === ''), [problemsOf(reAgain, 2), problemsOf(reAgain, 3)])
  const late = await call('POST', `/inventory/opening-stock/${revDoc}/changes`, { kind: 'CORRECTION', reason: 'too late', lines: [{ lineId: revEntry.lines[0].id, qty: 1 }] })
  check('a reversed entry takes no more requests', late.status === 400 && late.body?.code === 'REVERSED', late.body)

  // A reversal is refused once some of the stock has gone.
  const goneName = n('Gone')
  const goneIn = await importApproved(await sheet([{ 'Opening Date': date, 'Item Description': goneName, 'Item Category': 'Fabric', 'Opening Qty': 30, 'Unit Rate': 50 }], `zz-ctrl-gone-${stamp}`), `zz-ctrl-gone-${stamp}`)
  const gone = await prisma.item.findFirstOrThrow({ where: { name: goneName }, select: { id: true } })
  await call('POST', '/inventory/transfers', { fromWarehouseId: store.id, toWarehouseId: other.id, lines: [{ itemId: gone.id, qty: 10 }] })
  const goneRev = await call('POST', `/inventory/opening-stock/${goneIn.body?.data?.id}/changes`, { kind: 'REVERSAL', reason: 'Testing a used entry' })
  const goneOk = await call('POST', `/inventory/opening-stock/changes/${goneRev.body?.data?.id}/approve`, {})
  check('some of it used since: the reversal refused, nothing posted', goneOk.status === 400 && /cannot be taken back whole/.test(goneOk.body?.message ?? '') && (await balance(gone.id, store.id)) === 20, goneOk.body)
  const withdrawn = await call('POST', `/inventory/opening-stock/changes/${goneRev.body?.data?.id}/withdraw`, {})
  check('the one who asked can withdraw it', withdrawn.status === 200 && withdrawn.body?.data?.status === 'WITHDRAWN', withdrawn.body)

  // 6. All or nothing: an import failing half way leaves no item, stock, sticker or entry behind.
  const ghost = n('Ghost')
  const rows = [
    { row: 2, raw: { date, description: ghost, category: 'Fabric', lot: 'G1', qty: '30', rate: '10', packQtys: '20, 10' } },
    { row: 3, raw: { date, description: ghost, category: 'Fabric', lot: 'G2', qty: '15', rate: '10' } },
  ]
  const planned = await openingStock.planImport(rows as any, { makeItems: true })
  const key = planned.find((r) => r.plan.newItem)?.plan.newItem?.key
  const approvedPlan = await openingStock.planImport(rows as any, { makeItems: true, resolve: key ? { [key]: 'NEW' } : {} })
  // The second row's store made one that does not exist: the database refuses it half way.
  approvedPlan[1].ready!.warehouseId = 'no-such-store'
  let failed = false
  try {
    await openingStock.runImport(approvedPlan, { fileName: `zz-ghost-${stamp}.xlsx`, userId: null, requestKey: `zz-ghost-${stamp}` })
  } catch {
    failed = true
  }
  const leftItem = await prisma.item.count({ where: { name: ghost } })
  const leftDoc = await prisma.openingStock.count({ where: { requestKey: `zz-ghost-${stamp}` } })
  const leftPkg = await prisma.stockPackage.count({ where: { lotNo: 'G1', item: { name: ghost } } })
  check('failed half way: no new item, no entry, no stickers, no stock', failed && leftItem === 0 && leftDoc === 0 && leftPkg === 0, { failed, leftItem, leftDoc, leftPkg })

  console.log(`\n${pass} passed, ${fail} failed`)
  if (fail) process.exitCode = 1
}

main()
  .catch((e) => { console.error(e); process.exitCode = 1 })
  .finally(() => prisma.$disconnect())
