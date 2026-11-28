import { prisma } from '../packages/database/src/index'
import { balanceOf } from '../apps/api/src/services/stock.service'

/**
 * Multi-brand phase 5, part 2 — purchases through the API, as the screens
 * send them, each undone at the end:
 *
 *   1. A PO with a brand: its GRN line, its stock rows and its stickers are
 *      that brand's share. A PO with none: central.
 *   2. A QC rejection held in the same store stays on the share (grade R),
 *      and its cancellation puts it back.
 *   3. Cancelling the GRN takes the goods out of the same share and withdraws
 *      its stickers: every share back where it was, and Stock Reconciliation
 *      finds nothing on the item.
 *
 *   E2E_EMAIL=... E2E_PASSWORD=... E2E_API=http://localhost:5105/api \
 *   DATABASE_URL=...lderp_demo... npx tsx ../../tools/check-brand-purchase.ts
 */

const API = (process.env.E2E_API || 'http://localhost:5105/api').replace(/\/+$/, '')
let pass = 0
let fail = 0
const check = (name: string, ok: boolean, extra?: unknown) => {
  ok ? pass++ : fail++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && extra !== undefined ? `  — ${JSON.stringify(extra).slice(0, 700)}` : ''}`)
}
type Res = { status: number; body: any }
let token = ''
async function call(method: string, path: string, body?: unknown): Promise<Res> {
  const r = await fetch(`${API}${path}`, { method, headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: body === undefined ? undefined : JSON.stringify(body) })
  let j: any = null
  try {
    j = await r.json()
  } catch {}
  return { status: r.status, body: j }
}
const okay = (r: Res) => r.status >= 200 && r.status < 300
const stamp = Date.now().toString(36).slice(-5).toUpperCase()

async function main() {
  const [{ db }] = await prisma.$queryRaw<{ db: string }[]>`SELECT current_database() AS db`
  if (db !== 'lderp_demo') {
    console.error('Refusing to run: not lderp_demo.')
    process.exitCode = 2
    return
  }
  if (!process.env.E2E_EMAIL || !process.env.E2E_PASSWORD) {
    console.error('Set E2E_EMAIL and E2E_PASSWORD.')
    process.exitCode = 2
    return
  }
  const login = await fetch(`${API}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: process.env.E2E_EMAIL, password: process.env.E2E_PASSWORD }) }).then((r) => r.json())
  token = (login.data ?? login).accessToken

  const LD = await prisma.brand.findFirstOrThrow({ where: { isActive: true, isDefault: true }, select: { id: true, name: true } })
  // A general store that issues: a ZZTEST one, else the one called Store.
  const general = { isActive: true, kind: 'GENERAL' as const, departmentId: null, purpose: { not: 'SAMPLING' as const } }
  const store =
    (await prisma.warehouse.findFirst({ where: { ...general, name: { startsWith: 'ZZTEST' } }, select: { id: true, name: true } })) ??
    (await prisma.warehouse.findFirstOrThrow({ where: { ...general, name: 'Store' }, select: { id: true, name: true } }))
  // A ZZTEST material of a category kept on stickers, so the receipt's stickers can be checked too.
  const tracked = await prisma.itemCategory.findMany({ where: { trackPackages: true }, select: { id: true } })
  const item =
    (await prisma.item.findFirst({ where: { isActive: true, type: 'RAW_MATERIAL', name: { startsWith: 'ZZTEST' }, categoryId: { in: tracked.map((c) => c.id) } }, select: { id: true, code: true, name: true } })) ??
    (await prisma.item.findFirstOrThrow({ where: { isActive: true, type: 'RAW_MATERIAL', categoryId: { in: tracked.map((c) => c.id) }, name: { not: { contains: 'VHAGAR' } } }, select: { id: true, code: true, name: true } }))
  const supplier = ((await call('GET', '/masters/suppliers?limit=5')).body?.data ?? [])[0]
  const share = (brandId: string | null, grade = 'A') => balanceOf(prisma, { itemId: item.id, warehouseId: store.id, grade, brandId }).then((b) => b.qty)
  const startLD = await share(LD.id)
  const startC = await share(null)
  const undo: Array<() => Promise<Res | void>> = []

  try {
    // ── 1. A PO with a brand ──
    const po = await call('POST', '/purchase/orders', { supplierId: supplier?.id, deliveryWarehouseId: store.id, brandId: LD.id, notes: `ZZTEST brand purchase ${stamp}`, lines: [{ itemId: item.id, qty: 12, unitRate: 40, gstRate: 5 }] })
    check(`a PO under ${LD.name} is saved with its brand`, okay(po) && po.body.data.brandId === LD.id, [po.status, po.body?.message])
    if (!okay(po)) return
    await call('PATCH', `/purchase/orders/${po.body.data.id}/send`, {})
    const grn = await call('POST', '/purchase/grn', {
      poId: po.body.data.id,
      challanNo: `ZZ-BP-${stamp}`,
      challanDate: new Date().toISOString(),
      lines: [{ poLineId: po.body.data.lines[0].id, warehouseId: store.id, receivedQty: 12, packQtys: [5, 7] }],
    })
    check('received: 12 against it', okay(grn), [grn.status, grn.body?.message])
    if (!okay(grn)) return
    const grnId = grn.body.data.id as string
    undo.push(() => call('PATCH', `/purchase/grn/${grnId}/cancel`, { reason: 'ZZTEST brand purchase undone' }))
    const line = await prisma.gRNLine.findFirstOrThrow({ where: { grnId }, select: { id: true, brandId: true } })
    const rows = await prisma.stockLedger.findMany({ where: { referenceType: 'GRN', referenceId: grnId }, select: { brandId: true, inQty: true } })
    check(`the GRN line and its stock rows are ${LD.name}'s share`, line.brandId === LD.id && rows.length > 0 && rows.every((r) => r.brandId === LD.id))
    check(`${LD.name}'s share in ${store.name} up by 12, central unchanged`, (await share(LD.id)) === startLD + 12 && (await share(null)) === startC)
    const stickers = await prisma.stockPackage.findMany({ where: { grnLineId: line.id, status: 'IN_STOCK' }, select: { code: true, qty: true, brandId: true } })
    check(`its stickers (5 and 7) carry ${LD.name}`, stickers.length === 2 && stickers.every((p) => p.brandId === LD.id) && stickers.map((p) => Number(p.qty)).sort((a, b) => a - b).join(',') === '5,7', stickers)

    // ── 2. A QC rejection held in the same store ──
    const qc = await call('POST', '/purchase/qc', { grnId, lines: [{ grnLineId: line.id, rejectedQty: 2, reasonCode: 'QUALITY_REJECTION', reason: 'ZZTEST brand QC' }] })
    check(`2 rejected, held in the store: still ${LD.name}'s, as rejects`, okay(qc) && (await share(LD.id, 'R')) === 2 && (await share(LD.id)) === startLD + 10, [qc.status, qc.body?.message, await share(LD.id, 'R')])
    if (okay(qc)) {
      const qcId = qc.body?.data?.id ?? (await prisma.inwardQC.findFirst({ where: { grnId }, orderBy: { createdAt: 'desc' }, select: { id: true } }))?.id
      const cancel = await call('POST', `/purchase/qc/${qcId}/cancel`, { reason: 'ZZTEST brand QC undone' })
      check(`the check cancelled: the 2 are good stock of ${LD.name} again`, okay(cancel) && (await share(LD.id, 'R')) === 0 && (await share(LD.id)) === startLD + 12, [cancel.status, cancel.body?.message])
    }

    // ── 3. A PO with no brand: central ──
    const po2 = await call('POST', '/purchase/orders', { supplierId: supplier?.id, deliveryWarehouseId: store.id, notes: `ZZTEST central purchase ${stamp}`, lines: [{ itemId: item.id, qty: 3, unitRate: 40, gstRate: 5 }] })
    if (okay(po2)) {
      await call('PATCH', `/purchase/orders/${po2.body.data.id}/send`, {})
      const g2 = await call('POST', '/purchase/grn', { poId: po2.body.data.id, challanNo: `ZZ-BP2-${stamp}`, challanDate: new Date().toISOString(), lines: [{ poLineId: po2.body.data.lines[0].id, warehouseId: store.id, receivedQty: 3 }] })
      if (okay(g2)) undo.push(() => call('PATCH', `/purchase/grn/${g2.body.data.id}/cancel`, { reason: 'ZZTEST central purchase undone' }))
      const l2 = okay(g2) ? await prisma.gRNLine.findFirst({ where: { grnId: g2.body.data.id }, select: { brandId: true } }) : null
      check('a PO with no brand (and no indent or style): central stock', okay(g2) && l2?.brandId === null && (await share(null)) === startC + 3, [g2.status, g2.body?.message])
    }
  } finally {
    for (const u of undo.reverse()) {
      const r = await u()
      if (r && !okay(r)) console.log(`clean-up: ${r.status} ${r.body?.message ?? ''}`)
    }
  }
  // ── 4. All undone ──
  check('each GRN cancelled: both shares back where they started', (await share(LD.id)) === startLD && (await share(null)) === startC, [await share(LD.id), startLD, await share(null), startC])
  const lines = await prisma.gRNLine.findMany({ where: { grn: { challanNo: { startsWith: `ZZ-BP` }, status: { not: 'CANCELLED' } } }, select: { id: true } })
  const left = await prisma.stockPackage.count({ where: { status: 'IN_STOCK', grnLineId: { in: (await prisma.gRNLine.findMany({ where: { grn: { challanNo: { endsWith: stamp } } }, select: { id: true } })).map((l) => l.id) } } })
  check('no test receipt left standing', lines.length === 0, lines.length)
  check('their stickers withdrawn with them', left === 0, left)
  const recon = await call('GET', '/reports/stock-reconciliation/run')
  const mine = (recon.body?.data?.rows ?? []).filter((r: any) => r.itemCode === item.code)
  check('Stock Reconciliation: nothing on the item, share by share', okay(recon) && mine.length === 0, mine)
  console.log(`\n${pass} passed, ${fail} failed`)
  if (fail) process.exitCode = 1
}

main().finally(() => prisma.$disconnect())
