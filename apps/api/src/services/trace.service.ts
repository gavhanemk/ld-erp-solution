import { prisma, type Prisma } from '@ld-erp/database'
import { AppError } from '../middleware/errorHandler'
import { normaliseGarmentCode } from './garment.service'
import { stepFigures } from './floor.service'
import type { garmentDetail } from '../routes/garments.routes'

/*
 * Track & trace: one place to look anything up — a garment by its tag, an
 * order, a style or a customer — and see its whole story, from the order
 * being booked to the piece leaving on a challan and being billed, every step
 * dated, timed and signed. It only reads; nothing here changes anything.
 */

/** Which part of the journey a step belongs to, for its colour and icon on the screen. */
export type Phase = 'order' | 'material' | 'cutting' | 'production' | 'qc' | 'store' | 'tag' | 'despatch' | 'return'

export interface Step {
  at: Date
  phase: Phase
  title: string
  detail?: string | null
  ref?: string | null
  by?: string | null
  /** Undone afterwards: shown, but greyed out. */
  undone?: boolean
}

const byTime = (a: Step, b: Step) => a.at.getTime() - b.at.getTime()
const n = (v: unknown) => Number(v ?? 0)
const day = (d: Date) => d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' })

// ── Search ──────────────────────────────────────────────────────────────────

export interface Hit {
  kind: 'GARMENT' | 'SO' | 'MO' | 'CUSTOMER' | 'STYLE'
  id: string
  title: string
  sub: string
}

/**
 * Everything a few letters could mean: a tag, an order (by our number, the
 * buyer's PO, a challan or a receipt on it), a customer or a style.
 */
export async function search(raw: string): Promise<Hit[]> {
  const q = raw.trim()
  if (q.length < 2) return []
  const like = { contains: q, mode: 'insensitive' as const }
  const code = /^\d{1,8}$/.test(q) ? `G-${q.padStart(8, '0')}` : normaliseGarmentCode(q)
  const digits = q.replace(/^g-?/i, '').replace(/^0+/, '')

  const [garments, sos, mos, challans, receipts, customers, styles] = await Promise.all([
    /^G-\d{8}$/.test(code) || /^\d{3,}$/.test(digits)
      ? prisma.garment.findMany({
          where: /^G-\d{8}$/.test(code) ? { OR: [{ code }, ...(digits.length >= 3 ? [{ code: { contains: digits } }] : [])] } : { code: { contains: digits } },
          select: { code: true, status: true, size: { select: { code: true } }, item: { select: { name: true, color: true } } },
          orderBy: { code: 'asc' },
          take: 5,
        })
      : [],
    prisma.salesOrder.findMany({
      where: { OR: [{ soNumber: like }, { customerPORef: like }] },
      select: { id: true, soNumber: true, customerPORef: true, status: true, customer: { select: { name: true } } },
      orderBy: { createdAt: 'desc' },
      take: 5,
    }),
    prisma.manufacturingOrder.findMany({
      where: { moNumber: like },
      select: { id: true, moNumber: true, status: true, so: { select: { customer: { select: { name: true } } } }, lines: { select: { style: { select: { code: true } }, color: true }, take: 2 } },
      orderBy: { createdAt: 'desc' },
      take: 5,
    }),
    prisma.deliveryChallan.findMany({
      where: { dcNumber: like },
      select: { dcNumber: true, soId: true, so: { select: { soNumber: true, customer: { select: { name: true } } } } },
      take: 3,
    }),
    prisma.finishedGoodsReceipt.findMany({
      where: { fgrNumber: like, moId: { not: null } },
      select: { fgrNumber: true, moId: true, mo: { select: { moNumber: true } } },
      take: 3,
    }),
    prisma.customer.findMany({
      where: { OR: [{ name: like }, { code: like }], salesOrders: { some: {} } },
      select: { id: true, name: true, code: true, billingCity: true },
      take: 5,
    }),
    prisma.style.findMany({
      where: { OR: [{ code: like }, { name: like }] },
      select: { id: true, code: true, name: true },
      take: 5,
    }),
  ])

  return [
    ...garments.map((g) => ({
      kind: 'GARMENT' as const,
      id: g.code,
      title: g.code,
      sub: `${g.item.name}${g.item.color ? ` · ${g.item.color}` : ''}${g.size ? ` · size ${g.size.code}` : ''}`,
    })),
    ...sos.map((s) => ({ kind: 'SO' as const, id: s.id, title: s.soNumber, sub: [s.customer.name, s.customerPORef ? `PO ${s.customerPORef}` : null].filter(Boolean).join(' · ') })),
    ...challans.map((c) => ({ kind: 'SO' as const, id: c.soId, title: c.dcNumber, sub: `Challan on ${c.so.soNumber} · ${c.so.customer.name}` })),
    ...mos.map((m) => ({
      kind: 'MO' as const,
      id: m.id,
      title: m.moNumber,
      sub: [m.so?.customer.name ?? 'For stock', ...m.lines.map((l) => `${l.style.code} ${l.color}`)].join(' · '),
    })),
    ...receipts.map((r) => ({ kind: 'MO' as const, id: r.moId!, title: r.fgrNumber, sub: `Finished goods in for ${r.mo?.moNumber ?? 'an order'}` })),
    ...customers.map((c) => ({ kind: 'CUSTOMER' as const, id: c.id, title: c.name, sub: [c.code, c.billingCity].filter(Boolean).join(' · ') })),
    ...styles.map((s) => ({ kind: 'STYLE' as const, id: s.id, title: s.code, sub: s.name })),
  ]
}

// ── One garment ─────────────────────────────────────────────────────────────

const TAG_EVENT: Record<string, { phase: Phase; title: string }> = {
  TAGGED: { phase: 'tag', title: 'Tag made for this piece' },
  PACKED: { phase: 'store', title: 'Packed into a carton' },
  UNPACKED: { phase: 'store', title: 'Taken out of its carton' },
  ON_CHALLAN: { phase: 'despatch', title: 'Put on a delivery challan' },
  OFF_CHALLAN: { phase: 'despatch', title: 'Taken off the challan' },
  DISPATCHED: { phase: 'despatch', title: 'Despatched' },
  RETURNED: { phase: 'return', title: 'Came back from the customer' },
  TRANSFERRED: { phase: 'store', title: 'Moved to another store' },
  SCRAP_REQUESTED: { phase: 'return', title: 'Write-off asked for' },
  SCRAP_REFUSED: { phase: 'return', title: 'Write-off refused' },
  SCRAPPED: { phase: 'return', title: 'Written off' },
  VOIDED: { phase: 'tag', title: 'Tag withdrawn' },
}

/** A garment's whole life, from its order being booked to today. */
export async function garmentTrace(id: string, moId: string, dcId: string | null, detailOf: typeof garmentDetail) {
  const [detail, g, mrs, dc] = await Promise.all([detailOf(id), garmentBase(id), materialIssues(moId), challanOf(dcId)])
  if (!g) throw new AppError('That garment does not exist', 404, 'NOT_FOUND')
  return assemble(detail, g, mrs, dc)
}

const garmentBase = (id: string) =>
  prisma.garment.findUnique({
    where: { id },
    select: {
      moId: true,
      dcId: true,
      mo: {
        select: {
          moNumber: true,
          status: true,
          createdAt: true,
          actualStartDate: true,
          actualEndDate: true,
          createdBy: { select: { name: true } },
          so: {
            select: {
              id: true,
              soNumber: true,
              orderDate: true,
              deliveryDate: true,
              customerPORef: true,
              createdAt: true,
              approvedAt: true,
              createdBy: { select: { name: true } },
              approvedBy: { select: { name: true } },
              customer: { select: { id: true, name: true } },
            },
          },
        },
      },
      item: { select: { style: { select: { id: true, imageUrl: true, mrp: true } } } },
      fgReceipt: { select: { createdBy: { select: { name: true } }, warehouse: { select: { name: true } } } },
    },
  })

const materialIssues = (moId: string) =>
  prisma.materialRequisition.findMany({
    where: { moId, issuedAt: { not: null } },
    select: { mrNumber: true, issuedAt: true, department: { select: { name: true } }, issuedBy: { select: { name: true } } },
    orderBy: { issuedAt: 'asc' },
  })

/** The challan a piece went on: still on the piece once despatched. */
const challanOf = (dcId: string | null) =>
  dcId
      ? prisma.deliveryChallan.findUnique({
          where: { id: dcId },
          select: {
            dcNumber: true,
            dcDate: true,
            status: true,
            dispatchedAt: true,
            deliveredAt: true,
            vehicleNumber: true,
            transporter: true,
            lrNumber: true,
            customer: { select: { name: true } },
            dispatchedBy: { select: { name: true } },
            invoices: { where: { status: { not: 'CANCELLED' } }, select: { invoiceNumber: true, invoiceDate: true, createdBy: { select: { name: true } } } },
          },
        })
      : Promise.resolve(null)

function assemble(
  detail: Awaited<ReturnType<typeof garmentDetail>>,
  g: NonNullable<Awaited<ReturnType<typeof garmentBase>>>,
  mrs: Awaited<ReturnType<typeof materialIssues>>,
  dc: Awaited<ReturnType<typeof challanOf>>,
) {
  const so = g.mo.so
  const steps: Step[] = []
  if (so) {
    steps.push({
      at: so.createdAt,
      phase: 'order',
      title: `Order ${so.soNumber} booked`,
      detail: [so.customer.name, so.customerPORef ? `their PO ${so.customerPORef}` : null, so.deliveryDate ? `wanted by ${day(so.deliveryDate)}` : null].filter(Boolean).join(' · '),
      ref: so.soNumber,
      by: so.createdBy?.name,
    })
    if (so.approvedAt) steps.push({ at: so.approvedAt, phase: 'order', title: 'Order approved', ref: so.soNumber, by: so.approvedBy?.name })
  }
  steps.push({ at: g.mo.createdAt, phase: 'order', title: `Manufacturing order ${g.mo.moNumber} raised`, ref: g.mo.moNumber, by: g.mo.createdBy?.name })
  for (const m of mrs) {
    steps.push({ at: m.issuedAt!, phase: 'material', title: 'Materials issued for the order', detail: `To ${m.department.name}`, ref: m.mrNumber, by: m.issuedBy?.name })
  }
  // The bundle it was sewn in, step by step through the floor.
  for (const e of detail.production) {
    const cut = e.type === 'Cut'
    steps.push({
      at: new Date(e.date),
      phase: cut ? 'cutting' : e.check ? 'qc' : 'production',
      title: cut ? 'Cut' : `${e.type} · ${e.step}`,
      detail: `${detail.bundle ? `Bundle ${detail.bundle.code}: ` : ''}${e.changes.join(', ')}`,
      ref: e.ref,
      by: e.by,
      undone: e.reversed,
    })
  }
  steps.push({
    at: new Date(detail.receipt.receiptDate),
    phase: 'store',
    title: 'Received into finished goods',
    detail: g.fgReceipt.warehouse.name,
    ref: detail.receipt.fgrNumber,
    by: g.fgReceipt.createdBy?.name,
    undone: Boolean(detail.receipt.cancelledAt),
  })
  for (const e of detail.events) {
    const t = TAG_EVENT[e.type] ?? { phase: 'store' as Phase, title: e.type }
    steps.push({ at: new Date(e.at), phase: t.phase, title: t.title, detail: e.notes, ref: e.referenceNumber, by: e.by })
  }
  if (detail.lastPrintedAt) {
    steps.push({
      at: new Date(detail.lastPrintedAt),
      phase: 'tag',
      title: detail.printCount > 1 ? `Label printed (${detail.printCount} times, last here)` : 'Label printed',
      ref: detail.code,
    })
  }
  if (dc) {
    for (const inv of dc.invoices) {
      steps.push({ at: inv.invoiceDate, phase: 'despatch', title: 'Invoiced', detail: dc.customer?.name ?? null, ref: inv.invoiceNumber, by: inv.createdBy?.name })
    }
    if (dc.deliveredAt) steps.push({ at: dc.deliveredAt, phase: 'despatch', title: 'Delivered to the customer', ref: dc.dcNumber })
  }
  steps.sort(byTime)

  // The milestones across the top: when each was first reached, or not yet.
  const firstAt = (pred: (s: Step) => boolean) => steps.find((s) => pred(s) && !s.undone)?.at ?? null
  const lastAt = (pred: (s: Step) => boolean) => [...steps].reverse().find((s) => pred(s) && !s.undone)?.at ?? null
  const despatched = detail.events.find((e) => e.type === 'DISPATCHED')
  const returned = detail.events.find((e) => e.type === 'RETURNED')
  const milestones = [
    { key: 'order', label: 'Ordered', at: so?.createdAt ?? g.mo.createdAt },
    { key: 'cut', label: 'Cut', at: (detail.bundle?.cutDate ? new Date(detail.bundle.cutDate) : null) ?? firstAt((s) => s.phase === 'cutting') },
    { key: 'sewn', label: 'Through production', at: lastAt((s) => s.phase === 'production') },
    { key: 'qc', label: 'Checked', at: lastAt((s) => s.phase === 'qc') },
    { key: 'fg', label: 'Finished goods', at: new Date(detail.receipt.receiptDate) },
    { key: 'tag', label: 'Labelled', at: detail.lastPrintedAt ? new Date(detail.lastPrintedAt) : null },
    { key: 'despatch', label: 'Despatched', at: despatched ? new Date(despatched.at) : (dc?.dispatchedAt ?? null) },
    { key: 'invoice', label: 'Invoiced', at: dc?.invoices[0]?.invoiceDate ?? null },
    ...(returned ? [{ key: 'return', label: 'Returned', at: new Date(returned.at) }] : []),
  ]

  // Where it is now, in a sentence.
  const where =
    detail.status === 'DISPATCHED'
      ? `Despatched to ${dc?.customer?.name ?? detail.buyer ?? 'the customer'}${dc ? ` on ${dc.dcNumber}` : ''}${dc?.dispatchedAt ? `, ${day(dc.dispatchedAt)}` : ''}`
      : detail.status === 'PACKED'
        ? `Packed in a carton in ${detail.store}`
        : detail.status === 'IN_STOCK'
          ? `In the finished-goods store: ${detail.store}${dc ? `, on challan ${dc.dcNumber} to go` : ''}`
          : detail.status === 'SCRAPPED'
            ? 'Written off as damaged'
            : detail.status === 'VOID'
              ? 'Tag withdrawn'
              : detail.status

  return {
    ...detail,
    where,
    soId: so?.id ?? null,
    customerId: so?.customer.id ?? null,
    styleId: g.item.style?.id ?? null,
    imageUrl: g.item.style?.imageUrl ?? null,
    mrp: g.item.style?.mrp == null ? null : n(g.item.style.mrp),
    moStatus: g.mo.status,
    orderDate: so?.orderDate ?? null,
    deliveryDate: so?.deliveryDate ?? null,
    challan: dc
      ? {
          dcNumber: dc.dcNumber,
          dcDate: dc.dcDate,
          status: dc.status,
          dispatchedAt: dc.dispatchedAt,
          deliveredAt: dc.deliveredAt,
          vehicle: dc.vehicleNumber,
          transporter: dc.transporter,
          lr: dc.lrNumber,
          invoice: dc.invoices[0]?.invoiceNumber ?? null,
        }
      : null,
    milestones,
    timeline: steps,
  }
}

// ── Pieces, counted ─────────────────────────────────────────────────────────

const GARMENT_STATES = ['IN_STOCK', 'PACKED', 'DISPATCHED', 'SCRAPPED', 'VOID'] as const

/** Tagged pieces by colour, size and where they are, for a set of orders. */
async function piecesOf(where: { moId?: { in: string[] }; item?: { styleId: string } }) {
  const [grouped, list] = await Promise.all([
    prisma.garment.groupBy({ by: ['itemId', 'sizeId', 'status'], where, _count: { _all: true } }),
    prisma.garment.findMany({
      where,
      select: {
        code: true,
        status: true,
        grade: true,
        printCount: true,
        size: { select: { code: true } },
        item: { select: { color: true, style: { select: { code: true } } } },
        warehouse: { select: { name: true } },
        dc: { select: { dcNumber: true } },
        mo: { select: { moNumber: true } },
      },
      orderBy: { code: 'asc' },
      take: 1000,
    }),
  ])
  const [items, sizes] = await Promise.all([
    prisma.item.findMany({ where: { id: { in: [...new Set(grouped.map((r) => r.itemId))] } }, select: { id: true, color: true, style: { select: { code: true } } } }),
    prisma.size.findMany({ where: { id: { in: grouped.map((r) => r.sizeId).filter((x): x is string => !!x) } }, select: { id: true, code: true, sequence: true } }),
  ])
  const itemOf = new Map(items.map((i) => [i.id, i]))
  const sizeOf = new Map(sizes.map((s) => [s.id, s]))
  const rows = new Map<string, { style: string; color: string; size: string; seq: number; counts: Record<string, number>; total: number }>()
  const totals: Record<string, number> = Object.fromEntries(GARMENT_STATES.map((s) => [s, 0]))
  for (const r of grouped) {
    const it = itemOf.get(r.itemId)
    const sz = r.sizeId ? sizeOf.get(r.sizeId) : null
    const key = `${r.itemId}|${r.sizeId ?? ''}`
    const row = rows.get(key) ?? { style: it?.style?.code ?? '', color: it?.color ?? '', size: sz?.code ?? '—', seq: sz?.sequence ?? 0, counts: {}, total: 0 }
    row.counts[r.status] = (row.counts[r.status] ?? 0) + r._count._all
    if (r.status !== 'VOID') row.total += r._count._all
    totals[r.status] = (totals[r.status] ?? 0) + r._count._all
    rows.set(key, row)
  }
  return {
    totals,
    tagged: GARMENT_STATES.filter((s) => s !== 'VOID').reduce((t, s) => t + (totals[s] ?? 0), 0),
    bySize: [...rows.values()].sort((a, b) => a.style.localeCompare(b.style) || a.color.localeCompare(b.color) || a.seq - b.seq),
    list: list.map((g) => ({
      code: g.code,
      status: g.status,
      grade: g.grade,
      printed: g.printCount > 0,
      style: g.item.style?.code ?? '',
      color: g.item.color ?? '',
      size: g.size?.code ?? '',
      store: g.warehouse.name,
      dcNumber: g.dc?.dcNumber ?? null,
      moNumber: g.mo.moNumber,
    })),
  }
}

// ── An order ────────────────────────────────────────────────────────────────

const moSelect = {
  id: true,
  moNumber: true,
  status: true,
  createdAt: true,
  actualStartDate: true,
  actualEndDate: true,
  closedAt: true,
  totalPlannedQty: true,
  totalCutQty: true,
  totalPackedQty: true,
  createdBy: { select: { name: true } },
  lines: { select: { color: true, totalQty: true, style: { select: { id: true, code: true, name: true } } } },
  steps: { orderBy: { sequence: 'asc' as const }, select: { id: true, sequence: true, kind: true, isQcStep: true, skippedAt: true, name: true, execution: true } },
} as const

/**
 * An order's whole story: a sales order with every manufacturing order on it,
 * or one manufacturing order — what was asked for, how far each step has got,
 * where every tagged piece is, and everything that happened, in order.
 */
export async function orderTrace(kind: 'SO' | 'MO', id: string) {
  const soSelect = {
    id: true,
    soNumber: true,
    status: true,
    orderDate: true,
    deliveryDate: true,
    customerPORef: true,
    createdAt: true,
    approvedAt: true,
    createdBy: { select: { name: true } },
    approvedBy: { select: { name: true } },
    customer: { select: { id: true, name: true, billingCity: true } },
    lines: { select: { totalQty: true, deliveredQty: true, styleCode: true, color: true } },
  } as const
  let so: Awaited<ReturnType<typeof loadSo>> | null = null
  async function loadSo(soId: string) {
    return prisma.salesOrder.findUnique({ where: { id: soId }, select: soSelect })
  }
  let mos
  if (kind === 'SO') {
    so = await loadSo(id)
    if (!so) throw new AppError('That order does not exist', 404, 'NOT_FOUND')
    mos = await prisma.manufacturingOrder.findMany({ where: { soId: id }, select: moSelect, orderBy: { createdAt: 'asc' } })
  } else {
    const mo = await prisma.manufacturingOrder.findUnique({ where: { id }, select: { ...moSelect, soId: true } })
    if (!mo) throw new AppError('That manufacturing order does not exist', 404, 'NOT_FOUND')
    mos = [mo]
    if (mo.soId) so = await loadSo(mo.soId)
  }
  const moIds = mos.map((m) => m.id)

  const [stages, pieces, mrs, cuts, transfers, qcEvents, receipts, challans] = await Promise.all([
    Promise.all(
      mos.map(async (m) => ({
        moId: m.id,
        moNumber: m.moNumber,
        planned: m.totalPlannedQty,
        steps: m.steps.length
          ? (await stepFigures(prisma, m.id, m.steps, m.totalPlannedQty)).map((f) => {
              const s = m.steps.find((x) => x.id === f.stepId)!
              return {
                name: s.name,
                kind: s.kind,
                check: s.isQcStep || s.kind === 'QC',
                state: f.state,
                received: f.received,
                completed: f.completed,
                inHand: f.inHand + f.inTransit,
                atVendor: f.atVendor,
                rework: f.inRework,
                waiting: f.waiting,
                damaged: f.damagedNow + f.rejectedNow,
              }
            })
          : [],
      })),
    ),
    piecesOf({ moId: { in: moIds } }),
    prisma.materialRequisition.findMany({
      where: { moId: { in: moIds } },
      select: { mrNumber: true, requestDate: true, createdAt: true, approvedAt: true, issuedAt: true, status: true, department: { select: { name: true } }, raisedBy: { select: { name: true } }, approvedBy: { select: { name: true } }, issuedBy: { select: { name: true } } },
    }),
    prisma.cuttingOrder.findMany({
      where: { moId: { in: moIds }, status: { not: 'CANCELLED' } },
      select: { cutOrderNumber: true, cutDate: true, createdAt: true, actualPieces: true, plannedPieces: true, lotNo: true, cutterName: true, createdBy: { select: { name: true } }, moLine: { select: { color: true, style: { select: { code: true } } } } },
    }),
    prisma.processTransfer.findMany({
      where: { moId: { in: moIds } },
      select: {
        transferNumber: true,
        dispatchDate: true,
        receivedAt: true,
        cancelledAt: true,
        isRework: true,
        issuedBy: true,
        receivedBy: true,
        createdBy: { select: { name: true } },
        fromStep: { select: { name: true } },
        toStep: { select: { name: true } },
        vendor: { select: { name: true } },
        lines: { select: { dispatchedQty: true, receivedQty: true } },
      },
    }),
    // Checks: each decision at a QC step, with what passed and what did not.
    prisma.wipEvent.findMany({
      where: { moId: { in: moIds }, type: { in: ['PROCESS', 'DECIDE', 'REWORK_DONE'] }, OR: [{ step: { isQcStep: true } }, { step: { kind: 'QC' } }] },
      select: { eventDate: true, type: true, reversedAt: true, personName: true, createdBy: { select: { name: true } }, step: { select: { name: true } }, entries: { select: { bucket: true, qty: true } } },
      orderBy: { eventDate: 'asc' },
      take: 300,
    }),
    prisma.finishedGoodsReceipt.findMany({
      where: { moId: { in: moIds } },
      select: { fgrNumber: true, receiptDate: true, cancelledAt: true, cancelReason: true, createdBy: { select: { name: true } }, warehouse: { select: { name: true } }, lines: { select: { qty: true } } },
    }),
    so
      ? prisma.deliveryChallan.findMany({
          where: { soId: so.id },
          select: {
            dcNumber: true,
            dcDate: true,
            createdAt: true,
            status: true,
            dispatchedAt: true,
            deliveredAt: true,
            cancelledAt: true,
            createdBy: { select: { name: true } },
            dispatchedBy: { select: { name: true } },
            lines: { select: { qty: true } },
            invoices: { where: { status: { not: 'CANCELLED' } }, select: { invoiceNumber: true, invoiceDate: true, totalAmount: true, createdBy: { select: { name: true } } } },
            _count: { select: { garments: true } },
          },
        })
      : Promise.resolve([]),
  ])

  const steps: Step[] = []
  if (so) {
    steps.push({ at: so.createdAt, phase: 'order', title: `Order ${so.soNumber} booked`, detail: [so.customer.name, so.customerPORef ? `their PO ${so.customerPORef}` : null].filter(Boolean).join(' · '), ref: so.soNumber, by: so.createdBy?.name })
    if (so.approvedAt) steps.push({ at: so.approvedAt, phase: 'order', title: 'Order approved', ref: so.soNumber, by: so.approvedBy?.name })
  }
  for (const m of mos) {
    const what = m.lines.map((l) => `${l.style.code} ${l.color} ${l.totalQty} pcs`).join(', ')
    steps.push({ at: m.createdAt, phase: 'order', title: `Manufacturing order ${m.moNumber} raised`, detail: what, ref: m.moNumber, by: m.createdBy?.name })
    if (m.actualStartDate) steps.push({ at: m.actualStartDate, phase: 'production', title: 'Production started', ref: m.moNumber })
    if (m.actualEndDate) steps.push({ at: m.actualEndDate, phase: 'production', title: 'Production completed', ref: m.moNumber })
    if (m.closedAt) steps.push({ at: m.closedAt, phase: 'order', title: 'Manufacturing order closed', ref: m.moNumber })
  }
  for (const r of mrs) {
    steps.push({ at: r.createdAt, phase: 'material', title: 'Materials asked for', detail: r.department.name, ref: r.mrNumber, by: r.raisedBy?.name })
    if (r.approvedAt) steps.push({ at: r.approvedAt, phase: 'material', title: 'Material request approved', ref: r.mrNumber, by: r.approvedBy?.name })
    if (r.issuedAt) steps.push({ at: r.issuedAt, phase: 'material', title: 'Materials issued', detail: `To ${r.department.name}`, ref: r.mrNumber, by: r.issuedBy?.name })
  }
  for (const c of cuts) {
    steps.push({
      at: c.cutDate,
      phase: 'cutting',
      title: `Cut ${c.actualPieces || c.plannedPieces} pieces`,
      detail: [c.moLine ? `${c.moLine.style.code} ${c.moLine.color}` : null, c.lotNo ? `lot ${c.lotNo}` : null, c.cutterName ? `cutter ${c.cutterName}` : null].filter(Boolean).join(' · '),
      ref: c.cutOrderNumber,
      by: c.createdBy?.name,
    })
  }
  for (const t of transfers) {
    const sent = t.lines.reduce((s, l) => s + n(l.dispatchedQty), 0)
    const got = t.lines.reduce((s, l) => s + n(l.receivedQty), 0)
    steps.push({
      at: t.dispatchDate,
      phase: 'production',
      title: `${sent} pcs sent from ${t.fromStep.name} to ${t.toStep.name}${t.isRework ? ' for rework' : ''}`,
      detail: t.vendor ? `At ${t.vendor.name}` : null,
      ref: t.transferNumber,
      by: t.issuedBy ?? t.createdBy?.name,
      undone: Boolean(t.cancelledAt),
    })
    if (t.receivedAt && got > 0) {
      steps.push({ at: t.receivedAt, phase: 'production', title: `${got} pcs received at ${t.toStep.name}`, detail: t.vendor ? `From ${t.vendor.name}` : null, ref: t.transferNumber, by: t.receivedBy })
    }
  }
  for (const e of qcEvents) {
    const by = new Map<string, number>()
    for (const x of e.entries) if (x.qty > 0) by.set(x.bucket, (by.get(x.bucket) ?? 0) + x.qty)
    const said = [
      by.get('DONE') ? `${by.get('DONE')} passed` : null,
      by.get('REWORK') ? `${by.get('REWORK')} for rework` : null,
      by.get('REJECTED') ? `${by.get('REJECTED')} rejected` : null,
      by.get('DAMAGED') ? `${by.get('DAMAGED')} damaged` : null,
      by.get('B_GRADE') ? `${by.get('B_GRADE')} B-grade` : null,
    ].filter(Boolean)
    if (!said.length) continue
    steps.push({ at: e.eventDate, phase: 'qc', title: `Checked at ${e.step?.name ?? 'QC'}`, detail: said.join(', '), by: e.personName ?? e.createdBy?.name, undone: Boolean(e.reversedAt) })
  }
  for (const r of receipts) {
    const pcs = r.lines.reduce((s, l) => s + n(l.qty), 0)
    steps.push({ at: r.receiptDate, phase: 'store', title: `${pcs} pcs into finished goods`, detail: r.cancelledAt ? `Cancelled: ${r.cancelReason ?? ''}` : r.warehouse.name, ref: r.fgrNumber, by: r.createdBy?.name, undone: Boolean(r.cancelledAt) })
  }
  for (const c of challans) {
    const pcs = c._count.garments || c.lines.reduce((s, l) => s + n(l.qty), 0)
    steps.push({ at: c.createdAt, phase: 'despatch', title: 'Delivery challan made', detail: `${pcs} pcs`, ref: c.dcNumber, by: c.createdBy?.name, undone: Boolean(c.cancelledAt) })
    if (c.dispatchedAt) steps.push({ at: c.dispatchedAt, phase: 'despatch', title: `${pcs} pcs despatched`, ref: c.dcNumber, by: c.dispatchedBy?.name, undone: Boolean(c.cancelledAt) })
    if (c.deliveredAt) steps.push({ at: c.deliveredAt, phase: 'despatch', title: 'Delivered to the customer', ref: c.dcNumber })
    for (const inv of c.invoices) {
      steps.push({ at: inv.invoiceDate, phase: 'despatch', title: 'Invoiced', detail: `₹${n(inv.totalAmount).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`, ref: inv.invoiceNumber, by: inv.createdBy?.name })
    }
  }
  steps.sort(byTime)

  const ordered = so ? so.lines.reduce((s, l) => s + n(l.totalQty), 0) : mos.reduce((s, m) => s + m.totalPlannedQty, 0)
  const sent = challans.filter((c) => c.dispatchedAt && !c.cancelledAt).reduce((s, c) => s + c.lines.reduce((t, l) => t + n(l.qty), 0), 0)
  const intoFg = receipts.filter((r) => !r.cancelledAt).reduce((s, r) => s + r.lines.reduce((t, l) => t + n(l.qty), 0), 0)
  return {
    kind,
    so: so && {
      id: so.id,
      soNumber: so.soNumber,
      status: so.status,
      orderDate: so.orderDate,
      deliveryDate: so.deliveryDate,
      poRef: so.customerPORef,
      customer: so.customer,
    },
    mos: mos.map((m) => ({
      id: m.id,
      moNumber: m.moNumber,
      status: m.status,
      planned: m.totalPlannedQty,
      cut: m.totalCutQty,
      packed: m.totalPackedQty,
      styles: m.lines.map((l) => ({ styleId: l.style.id, style: l.style.code, name: l.style.name, color: l.color, qty: l.totalQty })),
    })),
    figures: {
      ordered,
      cut: mos.reduce((s, m) => s + m.totalCutQty, 0),
      intoFg,
      tagged: pieces.tagged,
      inStore: (pieces.totals.IN_STOCK ?? 0) + (pieces.totals.PACKED ?? 0),
      despatched: so ? sent : (pieces.totals.DISPATCHED ?? 0),
      scrapped: pieces.totals.SCRAPPED ?? 0,
      delivered: so ? so.lines.reduce((s, l) => s + n(l.deliveredQty), 0) : null,
    },
    stages,
    pieces,
    timeline: steps.slice(-400),
  }
}

// ── A customer, a style ─────────────────────────────────────────────────────

/** Orders as rows: what each asked for, how far it has got. */
async function orderRows(soIds: string[]) {
  if (!soIds.length) return []
  const [sos, garments] = await Promise.all([
    prisma.salesOrder.findMany({
      where: { id: { in: soIds } },
      select: {
        id: true,
        soNumber: true,
        status: true,
        orderDate: true,
        deliveryDate: true,
        customerPORef: true,
        customer: { select: { id: true, name: true } },
        lines: { select: { totalQty: true, deliveredQty: true, styleCode: true, color: true } },
        manufacturingOrders: { select: { id: true, moNumber: true, totalCutQty: true, totalPackedQty: true, status: true } },
        deliveryChallans: { where: { dispatchedAt: { not: null }, cancelledAt: null }, select: { lines: { select: { qty: true } } } },
      },
      orderBy: { orderDate: 'desc' },
    }),
    prisma.garment.groupBy({ by: ['soId', 'status'], where: { soId: { in: soIds } }, _count: { _all: true } }),
  ])
  const count = (soId: string, status: string) => garments.find((g) => g.soId === soId && g.status === status)?._count._all ?? 0
  return sos.map((s) => ({
    id: s.id,
    soNumber: s.soNumber,
    status: s.status,
    orderDate: s.orderDate,
    deliveryDate: s.deliveryDate,
    poRef: s.customerPORef,
    customer: s.customer,
    styles: [...new Set(s.lines.map((l) => [l.styleCode, l.color].filter(Boolean).join(' ')).filter(Boolean))],
    mos: s.manufacturingOrders.map((m) => ({ id: m.id, moNumber: m.moNumber, status: m.status })),
    ordered: s.lines.reduce((t, l) => t + n(l.totalQty), 0),
    cut: s.manufacturingOrders.reduce((t, m) => t + m.totalCutQty, 0),
    packed: s.manufacturingOrders.reduce((t, m) => t + m.totalPackedQty, 0),
    inStore: count(s.id, 'IN_STOCK') + count(s.id, 'PACKED'),
    despatched: Math.max(count(s.id, 'DISPATCHED'), s.deliveryChallans.reduce((t, c) => t + c.lines.reduce((u, l) => u + n(l.qty), 0), 0)),
    delivered: s.lines.reduce((t, l) => t + n(l.deliveredQty), 0),
  }))
}

const sumOf = (rows: Awaited<ReturnType<typeof orderRows>>, k: 'ordered' | 'cut' | 'packed' | 'inStore' | 'despatched' | 'delivered') => rows.reduce((t, r) => t + r[k], 0)

/** A customer: every order they have placed, and how far each has got. */
export async function customerTrace(id: string) {
  const c = await prisma.customer.findUnique({
    where: { id },
    select: { id: true, code: true, name: true, billingCity: true, billingState: true, phone: true, email: true, gstin: true, salesOrders: { where: { status: { not: 'CANCELLED' } }, select: { id: true } } },
  })
  if (!c) throw new AppError('That customer does not exist', 404, 'NOT_FOUND')
  const orders = await orderRows(c.salesOrders.map((s) => s.id))
  return {
    customer: { id: c.id, code: c.code, name: c.name, city: [c.billingCity, c.billingState].filter(Boolean).join(', '), phone: c.phone, email: c.email, gstin: c.gstin },
    figures: { orders: orders.length, ordered: sumOf(orders, 'ordered'), cut: sumOf(orders, 'cut'), packed: sumOf(orders, 'packed'), inStore: sumOf(orders, 'inStore'), despatched: sumOf(orders, 'despatched') },
    orders,
  }
}

/** A style: every order it was made on, and where its pieces are. */
export async function styleTrace(id: string) {
  const s = await prisma.style.findUnique({
    where: { id },
    select: { id: true, code: true, name: true, imageUrl: true, mrp: true, composition: true, fabricType: true, category: true, season: true, colors: true },
  })
  if (!s) throw new AppError('That style does not exist', 404, 'NOT_FOUND')
  const lines = await prisma.mOLine.findMany({
    where: { styleId: id },
    select: { color: true, totalQty: true, mo: { select: { id: true, moNumber: true, status: true, soId: true, totalCutQty: true, totalPackedQty: true, createdAt: true, so: { select: { soNumber: true, customer: { select: { id: true, name: true } } } } } } },
    orderBy: { mo: { createdAt: 'desc' } },
  })
  const pieces = await piecesOf({ item: { styleId: id } })
  const byMo = new Map<string, { id: string; moNumber: string; status: string; soId: string | null; soNumber: string | null; customer: { id: string; name: string } | null; colors: string[]; qty: number; cut: number; packed: number; createdAt: Date }>()
  for (const l of lines) {
    const row = byMo.get(l.mo.id) ?? {
      id: l.mo.id,
      moNumber: l.mo.moNumber,
      status: l.mo.status,
      soId: l.mo.soId,
      soNumber: l.mo.so?.soNumber ?? null,
      customer: l.mo.so?.customer ?? null,
      colors: [],
      qty: 0,
      cut: l.mo.totalCutQty,
      packed: l.mo.totalPackedQty,
      createdAt: l.mo.createdAt,
    }
    row.colors.push(l.color)
    row.qty += l.totalQty
    byMo.set(l.mo.id, row)
  }
  const orders = [...byMo.values()]
  return {
    style: { ...s, mrp: s.mrp == null ? null : n(s.mrp) },
    figures: {
      orders: orders.length,
      planned: orders.reduce((t, o) => t + o.qty, 0),
      tagged: pieces.tagged,
      inStore: (pieces.totals.IN_STOCK ?? 0) + (pieces.totals.PACKED ?? 0),
      despatched: pieces.totals.DISPATCHED ?? 0,
    },
    orders,
    pieces,
  }
}

// ── Advanced search: pieces by customer, style, order, colour, size, status, date ──

/**
 * What the filters can offer: only what has tagged pieces, with the links
 * between them — an order's customer, an MO's order and styles — so picking a
 * customer can narrow the order list to theirs.
 */
export async function filterOptions() {
  const [byMo, byItem, bySize] = await Promise.all([
    prisma.garment.groupBy({ by: ['moId'], _count: { _all: true } }),
    prisma.garment.groupBy({ by: ['itemId'], _count: { _all: true } }),
    prisma.garment.groupBy({ by: ['sizeId'], _count: { _all: true } }),
  ])
  const [mos, items, sizes] = await Promise.all([
    prisma.manufacturingOrder.findMany({
      where: { id: { in: byMo.map((r) => r.moId) } },
      select: {
        id: true,
        moNumber: true,
        soId: true,
        so: { select: { soNumber: true, customerPORef: true, customer: { select: { id: true, name: true } } } },
        lines: { select: { styleId: true } },
      },
      orderBy: { createdAt: 'desc' },
    }),
    prisma.item.findMany({ where: { id: { in: byItem.map((r) => r.itemId) } }, select: { color: true, style: { select: { id: true, code: true, name: true } } } }),
    prisma.size.findMany({ where: { id: { in: bySize.map((r) => r.sizeId).filter((x): x is string => !!x) } }, select: { id: true, code: true, sequence: true }, orderBy: { sequence: 'asc' } }),
  ])
  const customers = new Map<string, { id: string; name: string }>()
  const sos = new Map<string, { id: string; soNumber: string; poRef: string | null; customerId: string; customer: string }>()
  for (const m of mos) {
    if (!m.so || !m.soId) continue
    customers.set(m.so.customer.id, m.so.customer)
    sos.set(m.soId, { id: m.soId, soNumber: m.so.soNumber, poRef: m.so.customerPORef, customerId: m.so.customer.id, customer: m.so.customer.name })
  }
  const styles = new Map<string, { id: string; code: string; name: string }>()
  for (const i of items) if (i.style) styles.set(i.style.id, i.style)
  return {
    customers: [...customers.values()].sort((a, b) => a.name.localeCompare(b.name)),
    sos: [...sos.values()],
    mos: mos.map((m) => ({ id: m.id, moNumber: m.moNumber, soId: m.soId, customerId: m.so?.customer.id ?? null, styleIds: [...new Set(m.lines.map((l) => l.styleId))] })),
    styles: [...styles.values()].sort((a, b) => a.code.localeCompare(b.code)),
    colors: [...new Set(items.map((i) => i.color).filter((c): c is string => !!c))].sort(),
    sizes: sizes.map((s) => ({ id: s.id, code: s.code })),
  }
}

export interface PieceFilter {
  q?: string
  customerId?: string
  styleId?: string
  soId?: string
  moId?: string
  color?: string
  sizeId?: string
  status?: string
  from?: string
  to?: string
  page?: number
}

/** Tagged pieces matching every filter given, and what was typed — 50 a page, with the count in each state. */
export async function findPieces(f: PieceFilter) {
  const and: Prisma.GarmentWhereInput[] = []
  if (f.customerId) and.push({ mo: { so: { customerId: f.customerId } } })
  if (f.soId) and.push({ mo: { soId: f.soId } })
  if (f.moId) and.push({ moId: f.moId })
  if (f.styleId) and.push({ item: { styleId: f.styleId } })
  if (f.color) and.push({ item: { color: { equals: f.color, mode: 'insensitive' } } })
  if (f.sizeId) and.push({ sizeId: f.sizeId })
  if (f.from || f.to) {
    and.push({ fgReceipt: { receiptDate: { ...(f.from ? { gte: new Date(f.from) } : {}), ...(f.to ? { lte: new Date(`${f.to}T23:59:59.999Z`) } : {}) } } })
  }
  const q = f.q?.trim()
  if (q && q.length >= 2) {
    const like = { contains: q, mode: 'insensitive' as const }
    const digits = q.replace(/^g-?/i, '').replace(/^0+/, '')
    and.push({
      OR: [
        ...(/^\d+$/.test(digits) ? [{ code: { contains: digits } }] : []),
        { code: like },
        { item: { style: { code: like } } },
        { item: { color: like } },
        { mo: { moNumber: like } },
        { mo: { so: { soNumber: like } } },
        { mo: { so: { customerPORef: like } } },
        { mo: { so: { customer: { name: like } } } },
        { dc: { dcNumber: like } },
        { fgReceipt: { fgrNumber: like } },
        { bundle: { code: like } },
        { bundle: { cuttingOrder: { lotNo: like } } },
      ],
    })
  }
  const base: Prisma.GarmentWhereInput = and.length ? { AND: and } : {}
  const where: Prisma.GarmentWhereInput = f.status ? { ...base, status: f.status as Prisma.GarmentWhereInput['status'] } : { ...base, status: { not: 'VOID' } }
  const page = Math.max(1, f.page ?? 1)
  const [total, counts, rows] = await Promise.all([
    prisma.garment.count({ where }),
    prisma.garment.groupBy({ by: ['status'], where: base, _count: { _all: true } }),
    prisma.garment.findMany({
      where,
      select: {
        code: true,
        status: true,
        grade: true,
        printCount: true,
        size: { select: { code: true } },
        item: { select: { color: true, style: { select: { code: true } } } },
        warehouse: { select: { name: true } },
        dc: { select: { dcNumber: true } },
        mo: { select: { moNumber: true, so: { select: { soNumber: true, customer: { select: { name: true } } } } } },
        fgReceipt: { select: { receiptDate: true } },
        bundle: { select: { cuttingOrder: { select: { lotNo: true } } } },
      },
      orderBy: { code: 'asc' },
      skip: (page - 1) * 50,
      take: 50,
    }),
  ])
  return {
    total,
    page,
    pages: Math.max(1, Math.ceil(total / 50)),
    counts: Object.fromEntries(counts.map((c) => [c.status, c._count._all])),
    rows: rows.map((g) => ({
      code: g.code,
      status: g.status,
      grade: g.grade,
      printed: g.printCount > 0,
      style: g.item.style?.code ?? '',
      color: g.item.color ?? '',
      size: g.size?.code ?? '',
      customer: g.mo.so?.customer.name ?? null,
      soNumber: g.mo.so?.soNumber ?? null,
      moNumber: g.mo.moNumber,
      store: g.warehouse.name,
      dcNumber: g.dc?.dcNumber ?? null,
      receivedOn: g.fgReceipt.receiptDate,
      lot: g.bundle?.cuttingOrder?.lotNo ?? null,
    })),
  }
}
