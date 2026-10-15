import { Router } from 'express'
import { prisma, Prisma } from '@ld-erp/database'
import { requirePermission, type AuthRequest } from '../middleware/auth'
import { AppError } from '../middleware/errorHandler'
import { getPrintHeader } from '../lib/printData'
import { MOVEMENT_DOC_JOIN, PARTY_KIND_LABEL, documentLabel, type PartyKind } from '../services/movementDocs.service'

/**
 * Statements to hand to someone outside the mill: a customer asking what has
 * become of the fabric they sent, and a job worker settling what they were
 * sent against what they sent back. Each reads only what is already recorded
 * — the stock ledger and the job-work challans — and prints as it is.
 */
const router = Router()
const MODULE = 'inventory'

const r3 = (n: number) => Math.round(n * 1000) / 1000
const r2 = (n: number) => Math.round(n * 100) / 100
const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined)

/** The period asked for: from the start of `from`, to the end of `to` (today when not given). */
function periodOf(query: Record<string, unknown>) {
  const f = str(query.from)
  const t = str(query.to)
  const from = f && !Number.isNaN(Date.parse(f)) ? new Date(`${f}T00:00:00+05:30`) : null
  const to = t && !Number.isNaN(Date.parse(t)) ? new Date(`${t}T23:59:59.999+05:30`) : new Date()
  if (from && from > to) throw new AppError('The start date is after the end date', 400, 'BAD_PERIOD')
  return { from, to }
}

/** Which group of a customer's statement a movement belongs to. */
type Bucket = 'received' | 'returned' | 'production' | 'jobwork' | 'dispatched' | 'adjusted' | 'moved'
function bucketOf(type: string | null): Bucket {
  if (!type) return 'adjusted'
  if (type.startsWith('CUSTOMER_GRN')) return 'received'
  if (type.startsWith('CUSTOMER_RETURN')) return 'returned'
  if (type === 'MATERIAL_REQUISITION' || type === 'MR_RETURN' || type.startsWith('CUTTING') || type.startsWith('FG_RECEIPT')) return 'production'
  if (type.startsWith('JOB_WORK')) return 'jobwork'
  if (type.startsWith('DELIVERY_CHALLAN') || type.startsWith('CREDIT_NOTE')) return 'dispatched'
  if (type.startsWith('STOCK_TRANSFER')) return 'moved'
  return 'adjusted'
}

/** Both legs of these are written together, out of one store and into another. */
const PAIRED = new Set(['STOCK_TRANSFER', 'STOCK_TRANSFER_CANCELLED', 'JOB_WORK_CHALLAN', 'JOB_WORK_CHALLAN_CANCELLED'])

type LedgerLine = {
  id: string
  itemId: string
  warehouseId: string
  store: string
  size: string | null
  referenceType: string | null
  referenceId: string | null
  transactionDate: Date
  inQty: number
  outQty: number
  notes: string | null
  doc: string | null
  partyKind: PartyKind | null
  partyName: string | null
}

/**
 * GET /api/inventory/statements/customer/:customerId?from&to&moves=1
 *
 * Everything that has happened to one customer's material: for each item, what
 * there was at the start, every receipt, return, issue, job-work trip and
 * dispatch in the period with its document, what is left, and where it is.
 * Moves between our own stores are left out unless asked for: they change
 * where the material is, not how much of it there is.
 */
router.get('/customer/:customerId', requirePermission(MODULE, 'view'), async (req: AuthRequest, res) => {
  const customer = await prisma.customer.findUnique({
    where: { id: req.params.customerId },
    select: {
      id: true, code: true, name: true, gstin: true, phone: true, email: true,
      billingAddress: true, billingCity: true, billingState: true, billingStateCode: true, billingPincode: true,
    },
  })
  if (!customer) throw new AppError('That customer does not exist', 404, 'NOT_FOUND')
  const { from, to } = periodOf(req.query as Record<string, unknown>)
  const showMoves = req.query.moves === '1'
  const owner = Prisma.sql`s."ownerCustomerId" = ${customer.id} AND s.ownership = 'CUSTOMER_OWNED'::ld_erp."StockOwnership"`

  const [opening, lines, here, jwStores, header] = await Promise.all([
    from
      ? prisma.$queryRaw<Array<{ itemId: string; qty: number }>>`
          SELECT s."itemId", SUM(s."inQty" - s."outQty")::float8 AS qty
          FROM ld_erp.stock_ledger s WHERE ${owner} AND s."transactionDate" < ${from}
          GROUP BY 1`
      : Promise.resolve([]),
    prisma.$queryRaw<LedgerLine[]>`
      SELECT s.id, s."itemId", s."warehouseId", w.name AS store, sz.code AS size, s."referenceType", s."referenceId",
             s."transactionDate", s."inQty"::float8 AS "inQty", s."outQty"::float8 AS "outQty", s.notes,
             p.doc, p."partyKind", p."partyName"
      FROM ld_erp.stock_ledger s
      JOIN ld_erp.warehouses w ON w.id = s."warehouseId"
      LEFT JOIN ld_erp.sizes sz ON sz.id = s."sizeId"
      ${MOVEMENT_DOC_JOIN}
      WHERE ${owner} ${from ? Prisma.sql`AND s."transactionDate" >= ${from}` : Prisma.empty} AND s."transactionDate" <= ${to}
      ORDER BY s."transactionDate", s."createdAt"`,
    // Where it is at the end of the period, store by store.
    prisma.$queryRaw<Array<{ itemId: string; warehouseId: string; store: string; qty: number }>>`
      SELECT s."itemId", s."warehouseId", w.name AS store, SUM(s."inQty" - s."outQty")::float8 AS qty
      FROM ld_erp.stock_ledger s JOIN ld_erp.warehouses w ON w.id = s."warehouseId"
      WHERE ${owner} AND s."transactionDate" <= ${to}
      GROUP BY 1, 2, 3 HAVING ABS(SUM(s."inQty" - s."outQty")) > 0.0005`,
    // The stores that stand for a job worker's floor.
    prisma.jobWorkChallan.findMany({ distinct: ['toWarehouseId'], select: { toWarehouseId: true } }),
    getPrintHeader('CMS'),
  ])
  const atJobWorker = new Set(jwStores.map((c) => c.toWarehouseId))

  // Material still with job workers, from the challans themselves.
  const withJobWorkers = await prisma.jobWorkChallanLine.findMany({
    where: { ownerCustomerId: customer.id, challan: { status: { not: 'CANCELLED' } } },
    select: {
      itemId: true,
      qty: true,
      returnLines: { select: { consumedQty: true, wastedQty: true } },
      challan: { select: { challanNumber: true, challanDate: true, process: true, expectedBackOn: true, jobWorker: { select: { name: true } } } },
      item: { select: { code: true, name: true, uom: { select: { symbol: true } } } },
    },
    orderBy: { challan: { challanDate: 'asc' } },
  })

  // Pair the two legs of a move into one line: "from A to B".
  type Row = {
    date: Date
    doc: string | null
    what: string
    party: string | null
    store: string
    toStore?: string
    size: string | null
    inQty: number
    outQty: number
    moved?: number
    notes: string | null
    bucket: Bucket
  }
  const used = new Set<string>()
  const byItem = new Map<string, Row[]>()
  const push = (itemId: string, r: Row) => byItem.set(itemId, [...(byItem.get(itemId) ?? []), r])
  const partyText = (l: LedgerLine) => (l.partyName ? `${l.partyName}${l.partyKind ? ` (${PARTY_KIND_LABEL[l.partyKind]})` : ''}` : null)
  for (const l of lines) {
    if (used.has(l.id)) continue
    const bucket = bucketOf(l.referenceType)
    if (l.referenceType && PAIRED.has(l.referenceType) && l.outQty > 0) {
      const twin = lines.find(
        (o) => !used.has(o.id) && o.id !== l.id && o.referenceId === l.referenceId && o.referenceType === l.referenceType &&
          o.itemId === l.itemId && o.size === l.size && o.inQty > 0 && Math.abs(o.inQty - l.outQty) < 0.0005,
      )
      if (twin) {
        used.add(l.id)
        used.add(twin.id)
        if (bucket === 'moved' && !showMoves) continue
        push(l.itemId, {
          date: l.transactionDate, doc: l.doc, what: documentLabel(l.referenceType), party: partyText(l),
          store: l.store, toStore: twin.store, size: l.size, inQty: 0, outQty: 0, moved: r3(l.outQty), notes: l.notes, bucket,
        })
        continue
      }
    }
    used.add(l.id)
    // A job-work return takes what the job worker used off their floor, and
    // brings back what they made: the two halves read differently.
    const what = l.referenceType === 'JOB_WORK_RETURN' && l.outQty > 0 ? 'Used at the job worker' : documentLabel(l.referenceType)
    push(l.itemId, {
      date: l.transactionDate, doc: l.doc, what, party: partyText(l),
      store: l.store, size: l.size, inQty: r3(l.inQty), outQty: r3(l.outQty), notes: l.notes, bucket,
    })
  }

  const itemIds = [...new Set([...opening.filter((o) => Math.abs(o.qty) > 0.0005).map((o) => o.itemId), ...lines.map((l) => l.itemId), ...here.map((h) => h.itemId)])]
  const items = await prisma.item.findMany({
    where: { id: { in: itemIds } },
    select: { id: true, code: true, name: true, uom: { select: { symbol: true } } },
  })
  const openOf = new Map(opening.map((o) => [o.itemId, Number(o.qty)]))

  const statement = items
    .map((it) => {
      const open = r3(openOf.get(it.id) ?? 0)
      let bal = open
      const rows = (byItem.get(it.id) ?? []).map((r) => {
        bal = r3(bal + r.inQty - r.outQty)
        return { ...r, balance: bal }
      })
      const sum = (b: Bucket) => r3(rows.filter((r) => r.bucket === b).reduce((s, r) => s + r.inQty - r.outQty, 0))
      return {
        itemId: it.id,
        code: it.code,
        name: it.name,
        uom: it.uom?.symbol ?? '',
        opening: open,
        received: sum('received'),
        returned: r3(-sum('returned')),
        production: r3(-sum('production')),
        jobwork: r3(-sum('jobwork')),
        dispatched: r3(-sum('dispatched')),
        adjusted: sum('adjusted'),
        closing: bal,
        rows,
        where: here
          .filter((h) => h.itemId === it.id)
          .map((h) => ({ store: h.store, qty: r3(Number(h.qty)), atJobWorker: atJobWorker.has(h.warehouseId) }))
          .sort((a, b) => b.qty - a.qty),
      }
    })
    .filter((s) => s.rows.length || Math.abs(s.opening) > 0.0005 || Math.abs(s.closing) > 0.0005)
    .sort((a, b) => a.name.localeCompare(b.name))

  res.json({
    success: true,
    data: {
      ...header,
      customer,
      period: { from, to },
      showMoves,
      items: statement,
      withJobWorkers: withJobWorkers
        .map((l) => {
          const accounted = l.returnLines.reduce((s, r) => s + Number(r.consumedQty), 0)
          return {
            challanNumber: l.challan.challanNumber,
            challanDate: l.challan.challanDate,
            process: l.challan.process,
            jobWorker: l.challan.jobWorker.name,
            expectedBackOn: l.challan.expectedBackOn,
            code: l.item.code,
            item: l.item.name,
            uom: l.item.uom?.symbol ?? '',
            sent: r3(Number(l.qty)),
            wasted: r3(l.returnLines.reduce((s, r) => s + Number(r.wastedQty), 0)),
            pending: r3(Math.max(0, Number(l.qty) - accounted)),
          }
        })
        .filter((l) => l.pending > 0.0005),
    },
  })
})

/**
 * GET /api/inventory/statements/job-worker/:supplierId?from&to&open=1
 *
 * A job worker's account of material: every challan sent to them in the
 * period, line by line, with what came back against it on which return, what
 * they wasted or spoiled, and what they still hold.
 */
router.get('/job-worker/:supplierId', requirePermission(MODULE, 'view'), async (req: AuthRequest, res) => {
  const worker = await prisma.supplier.findUnique({
    where: { id: req.params.supplierId },
    select: { id: true, code: true, name: true, gstin: true, phone: true, address: true, city: true, state: true, stateCode: true, pincode: true },
  })
  if (!worker) throw new AppError('That job worker does not exist', 404, 'NOT_FOUND')
  const { from, to } = periodOf(req.query as Record<string, unknown>)
  const openOnly = req.query.open === '1'

  const [challans, header] = await Promise.all([
    prisma.jobWorkChallan.findMany({
      where: {
        jobWorkerId: worker.id,
        status: { not: 'CANCELLED' },
        challanDate: { ...(from ? { gte: from } : {}), lte: to },
      },
      orderBy: { challanDate: 'asc' },
      select: {
        id: true,
        challanNumber: true,
        challanDate: true,
        process: true,
        expectedBackOn: true,
        status: true,
        fromWarehouse: { select: { name: true } },
        so: { select: { soNumber: true } },
        mo: { select: { moNumber: true } },
        lines: {
          select: {
            id: true,
            qty: true,
            unitRate: true,
            ownership: true,
            ownerCustomer: { select: { name: true } },
            size: { select: { code: true } },
            item: { select: { code: true, name: true, uom: { select: { symbol: true } } } },
            returnLines: {
              select: {
                consumedQty: true,
                receivedQty: true,
                wastedQty: true,
                damagedQty: true,
                item: { select: { code: true, name: true, uom: { select: { symbol: true } } } },
                warehouse: { select: { name: true } },
                jobWorkReturn: { select: { returnNumber: true, returnDate: true, theirChallanNo: true } },
              },
              orderBy: { jobWorkReturn: { returnDate: 'asc' } },
            },
          },
        },
      },
    }),
    getPrintHeader('JWS'),
  ])

  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' })
  const list = challans
    .map((c) => {
      const lines = c.lines.map((l) => {
        const sent = Number(l.qty)
        const accounted = l.returnLines.reduce((s, r) => s + Number(r.consumedQty), 0)
        const pending = r3(Math.max(0, sent - accounted))
        const rate = l.unitRate === null ? null : Number(l.unitRate)
        return {
          id: l.id,
          code: l.item.code,
          item: l.item.name,
          uom: l.item.uom?.symbol ?? '',
          size: l.size?.code ?? null,
          customer: l.ownership === 'CUSTOMER_OWNED' ? (l.ownerCustomer?.name ?? 'a customer') : null,
          sent: r3(sent),
          accounted: r3(accounted),
          wasted: r3(l.returnLines.reduce((s, r) => s + Number(r.wastedQty), 0)),
          damaged: r3(l.returnLines.reduce((s, r) => s + Number(r.damagedQty), 0)),
          pending,
          rate,
          pendingValue: rate === null ? null : r2(pending * rate),
          returns: l.returnLines.map((r) => ({
            returnNumber: r.jobWorkReturn.returnNumber,
            returnDate: r.jobWorkReturn.returnDate,
            theirChallanNo: r.jobWorkReturn.theirChallanNo,
            accounted: r3(Number(r.consumedQty)),
            received: r3(Number(r.receivedQty)),
            receivedCode: r.item.code,
            receivedItem: r.item.name,
            receivedUom: r.item.uom?.symbol ?? '',
            wasted: r3(Number(r.wastedQty)),
            damaged: r3(Number(r.damagedQty)),
            store: r.warehouse.name,
          })),
        }
      })
      const open = lines.some((l) => l.pending > 0.0005)
      const due = c.expectedBackOn ? c.expectedBackOn.toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' }) : null
      return {
        id: c.id,
        challanNumber: c.challanNumber,
        challanDate: c.challanDate,
        process: c.process,
        expectedBackOn: c.expectedBackOn,
        fromStore: c.fromWarehouse.name,
        order: c.so?.soNumber ?? null,
        mo: c.mo?.moNumber ?? null,
        state: open ? (due && due < today ? 'OVERDUE' : 'OPEN') : 'SETTLED',
        lines,
      }
    })
    .filter((c) => !openOnly || c.state !== 'SETTLED')

  // Item by item, across every challan.
  const perItem = new Map<string, { code: string; item: string; uom: string; sent: number; accounted: number; wasted: number; damaged: number; pending: number; pendingValue: number }>()
  for (const c of list) {
    for (const l of c.lines) {
      const k = `${l.code}|${l.uom}`
      const t = perItem.get(k) ?? { code: l.code, item: l.item, uom: l.uom, sent: 0, accounted: 0, wasted: 0, damaged: 0, pending: 0, pendingValue: 0 }
      t.sent = r3(t.sent + l.sent)
      t.accounted = r3(t.accounted + l.accounted)
      t.wasted = r3(t.wasted + l.wasted)
      t.damaged = r3(t.damaged + l.damaged)
      t.pending = r3(t.pending + l.pending)
      t.pendingValue = r2(t.pendingValue + (l.pendingValue ?? 0))
      perItem.set(k, t)
    }
  }

  res.json({
    success: true,
    data: {
      ...header,
      jobWorker: worker,
      period: { from, to },
      openOnly,
      challans: list,
      items: [...perItem.values()].sort((a, b) => a.item.localeCompare(b.item)),
      totals: {
        challans: list.length,
        open: list.filter((c) => c.state !== 'SETTLED').length,
        overdue: list.filter((c) => c.state === 'OVERDUE').length,
        pendingValue: r2([...perItem.values()].reduce((s, t) => s + t.pendingValue, 0)),
      },
    },
  })
})

export default router
