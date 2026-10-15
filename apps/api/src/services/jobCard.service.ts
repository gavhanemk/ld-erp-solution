import type { Prisma, PrismaClient, ProcessKind, WipBucket, WipEventType } from '@prisma/client'
import { z } from 'zod'
import { AppError } from '../middleware/errorHandler'
import { figuresFrom, type FigureStep, type Flows } from './floor.service'
import { flowSummary } from './floorView.service'
import { isCheck, nextStepAfter } from './route.service'

/**
 * Job cards: one per line of a manufacturing order — a style in one colour or
 * design — as the floor works it. The header the department sheets print
 * (order no., project ID, fabric quality, design no., metres, average, ratio)
 * is kept here; the pieces and where they are come off the floor's entries.
 *
 * The departments' sheets are a job card seen from one stage of its route:
 * the cutting sheet, the stitching sheet, the other processes' sheets and the
 * checks. Which sheets a job card has follows from the stages loaded into its
 * order.
 */

type Db = PrismaClient | Prisma.TransactionClient
type Tx = Prisma.TransactionClient

const round3 = (n: number) => Math.round(n * 1000) / 1000

/** The department sheet a stage is worked on. */
export type Stage = 'CUTTING' | 'STITCHING' | 'OTHER' | 'QC'
export const STAGES: Stage[] = ['CUTTING', 'STITCHING', 'OTHER', 'QC']
export const stageOf = (s: { kind: ProcessKind; isQcStep: boolean }): Stage => (isCheck(s) ? 'QC' : s.kind === 'CUTTING' ? 'CUTTING' : s.kind === 'STITCHING' ? 'STITCHING' : 'OTHER')

/**
 * Makes the job cards an order lacks: one per line, numbered from the order,
 * with what the sales order and the BOM say of the line filled in. Run when
 * the order is released; harmless to run again.
 */
export async function ensureJobCards(tx: Tx, moId: string) {
  const mo = await tx.manufacturingOrder.findUniqueOrThrow({
    where: { id: moId },
    select: {
      id: true,
      moNumber: true,
      createdById: true,
      so: { select: { customerPORef: true } },
      lines: {
        orderBy: { id: 'asc' },
        select: {
          id: true,
          totalQty: true,
          style: { select: { name: true, category: true } },
          soLine: { select: { description: true, fabric: true, printName: true } },
          bom: { select: { lines: { select: { effectiveQty: true, componentItem: { select: { name: true, category: { select: { name: true, parent: { select: { name: true } } } } } } } } } },
          jobCard: { select: { id: true } },
        },
      },
      _count: { select: { jobCards: true } },
    },
  })
  let n = mo._count.jobCards
  for (const l of mo.lines) {
    if (l.jobCard) continue
    // The main fabric on the line's BOM: its quality, and what one garment takes.
    const fabric = l.bom?.lines.find((b) => /fabric/i.test(b.componentItem.category?.name ?? '') || /fabric/i.test(b.componentItem.category?.parent?.name ?? ''))
    const average = fabric ? Number(fabric.effectiveQty) : null
    n += 1
    await tx.jobCard.create({
      data: {
        jobCardNumber: `${mo.moNumber}-JC${n}`,
        moId: mo.id,
        moLineId: l.id,
        orderNo: mo.so?.customerPORef ?? null,
        description: l.soLine?.description || l.style.category || l.style.name,
        fabricQuality: l.soLine?.fabric || fabric?.componentItem.name || null,
        designNo: l.soLine?.printName ?? null,
        average,
        meters: average != null ? round3(average * l.totalQty) : null,
        createdById: mo.createdById,
      },
    })
  }
  await fillJobCardBlanks(tx, moId)
}

/** The sizes cut in their smallest whole ratio: 30, 60, 80 pieces → "38:3 40:6 42:8". */
function ratioOf(sizes: Array<{ qty: number; size: { code: string; sequence: number } }>) {
  const live = sizes.filter((z) => z.qty > 0).sort((a, b) => a.size.sequence - b.size.sequence)
  if (!live.length) return null
  const gcd = (a: number, b: number): number => (b ? gcd(b, a % b) : a)
  const g = live.reduce((t, z) => gcd(t, z.qty), 0) || 1
  return live.map((z) => `${z.size.code}:${z.qty / g}`).join(' ')
}

/**
 * Fills the blanks of an order's job cards from what is already known, so the
 * floor never retypes it: the buyer's PO no. as the order no., the sales order
 * as the project ID, the lot the fabric came in (from the rolls issued to the
 * order, else the rolls bought for it), the size ratio and the order's note.
 * Only blanks — whatever somebody typed stays. Run when the cards are made,
 * when material is issued to the order, and when a card is opened.
 */
export async function fillJobCardBlanks(tx: Tx, moId: string) {
  const mo = await tx.manufacturingOrder.findUnique({
    where: { id: moId },
    select: {
      moNumber: true,
      notes: true,
      so: { select: { soNumber: true, customerPORef: true } },
      materialRequisitions: { select: { id: true } },
      jobCards: {
        select: {
          id: true,
          orderNo: true,
          projectId: true,
          lotNo: true,
          ratio: true,
          notes: true,
          moLine: { select: { sizes: { select: { qty: true, size: { select: { code: true, sequence: true } } } } } },
        },
      },
    },
  })
  if (!mo?.jobCards.length) return
  const blank = (v: string | null) => !v?.trim()
  const needLot = mo.jobCards.some((c) => blank(c.lotNo))
  let lot: string | null = null
  if (needLot) {
    const fabric = {
      OR: [
        { category: { name: { contains: 'fabric', mode: 'insensitive' as const } } },
        { category: { parent: { name: { contains: 'fabric', mode: 'insensitive' as const } } } },
      ],
    }
    const mrIds = mo.materialRequisitions.map((m) => m.id)
    // The fabric rolls handed over against the order's requisitions…
    const issued = mrIds.length
      ? await tx.stockPackage.findMany({
          where: { lotNo: { not: null }, item: fabric, moves: { some: { referenceType: 'MATERIAL_REQUISITION', referenceId: { in: mrIds } } } },
          select: { lotNo: true },
          distinct: ['lotNo'],
        })
      : []
    // …or, before any is issued, the rolls received on orders bought for it.
    const bought = issued.length
      ? []
      : await tx.stockPackage.findMany({
          where: {
            lotNo: { not: null },
            item: fabric,
            grnLineId: { in: (await tx.gRNLine.findMany({ where: { poLine: { mrLine: { mr: { moId } } } }, select: { id: true } })).map((g) => g.id) },
          },
          select: { lotNo: true },
          distinct: ['lotNo'],
        })
    const lots = [...issued, ...bought].map((p) => p.lotNo!).filter(Boolean)
    lot = lots.length ? lots.slice(0, 3).join(', ').slice(0, 60) : null
  }
  for (const c of mo.jobCards) {
    const data: Record<string, string> = {}
    if (blank(c.orderNo) && mo.so?.customerPORef) data.orderNo = mo.so.customerPORef
    if (blank(c.projectId)) data.projectId = mo.so?.soNumber ?? mo.moNumber
    if (blank(c.lotNo) && lot) data.lotNo = lot
    if (blank(c.ratio)) {
      const r = ratioOf(c.moLine.sizes)
      if (r) data.ratio = r.slice(0, 120)
    }
    if (blank(c.notes) && mo.notes?.trim()) data.notes = mo.notes.trim().slice(0, 1000)
    if (Object.keys(data).length) await tx.jobCard.update({ where: { id: c.id }, data })
  }
}

const text = (max: number) => z.string().trim().max(max).optional().nullable()

export const jobCardSchema = z.object({
  orderNo: text(60),
  projectId: text(60),
  description: text(200),
  fabricQuality: text(200),
  designNo: text(80),
  lotNo: text(60),
  meters: z.number().min(0).max(9_999_999).optional().nullable(),
  average: z.number().min(0).max(10_000).optional().nullable(),
  ratio: text(120),
  notes: text(1000),
})

export async function updateJobCard(tx: Tx, id: string, d: z.infer<typeof jobCardSchema>) {
  const card = await tx.jobCard.findUnique({ where: { id }, select: { id: true, mo: { select: { status: true, moNumber: true } } } })
  if (!card) throw new AppError('Job card not found', 404, 'NOT_FOUND')
  if (card.mo.status === 'CLOSED') throw new AppError(`${card.mo.moNumber} is closed.`, 409, 'NOT_OPEN')
  const blank = (v: string | null | undefined) => (v?.trim() ? v.trim() : null)
  return tx.jobCard.update({
    where: { id },
    data: {
      orderNo: blank(d.orderNo),
      projectId: blank(d.projectId),
      description: blank(d.description),
      fabricQuality: blank(d.fabricQuality),
      designNo: blank(d.designNo),
      lotNo: blank(d.lotNo),
      meters: d.meters ?? null,
      average: d.average ?? null,
      ratio: blank(d.ratio),
      notes: blank(d.notes),
    },
  })
}

// ─── Figures for many job cards at once ───────────────────────

type Held = { stepId: string; vendorId: string | null; bucket: WipBucket; qty: number }
type Flow = { stepId: string; bucket: WipBucket; eventType: WipEventType; qty: number }

/**
 * Balances and flows of these order lines, read in three queries and split by
 * a key of each entry (the line, or the line and size), so a list of job
 * cards does not read the ledger once per card.
 */
async function ledgerBy(db: Db, where: Prisma.WipEntryWhereInput, key: 'moLineId' | 'sizeId') {
  const live: Prisma.WipEntryWhereInput = { ...where, eventType: { not: 'REVERSAL' }, event: { reversedAt: null } }
  const [held, ins, outs] = await Promise.all([
    db.wipEntry.groupBy({ by: ['moLineId', 'sizeId', 'stepId', 'vendorId', 'bucket'], where, _sum: { qty: true } }),
    db.wipEntry.groupBy({ by: ['moLineId', 'sizeId', 'stepId', 'bucket', 'eventType'], where: { ...live, qty: { gt: 0 } }, _sum: { qty: true } }),
    db.wipEntry.groupBy({ by: ['moLineId', 'sizeId', 'stepId', 'bucket', 'eventType'], where: { ...live, qty: { lt: 0 } }, _sum: { qty: true } }),
  ])
  const keyOf = (r: { moLineId: string; sizeId: string | null }) => (key === 'moLineId' ? r.moLineId : r.sizeId ?? '')
  const heldOf = new Map<string, Held[]>()
  for (const r of held) {
    const qty = r._sum.qty ?? 0
    if (!qty) continue
    const k = keyOf(r)
    heldOf.set(k, [...(heldOf.get(k) ?? []), { stepId: r.stepId, vendorId: r.vendorId, bucket: r.bucket, qty }])
  }
  const flowsOf = new Map<string, Flows>()
  const add = (rows: typeof ins, side: 'ins' | 'outs') => {
    for (const r of rows) {
      const k = keyOf(r)
      const f = flowsOf.get(k) ?? { ins: [] as Flow[], outs: [] as Flow[] }
      f[side].push({ stepId: r.stepId, bucket: r.bucket, eventType: r.eventType, qty: Math.abs(r._sum.qty ?? 0) })
      flowsOf.set(k, f)
    }
  }
  add(ins, 'ins')
  add(outs, 'outs')
  return (k: string) => ({ held: heldOf.get(k) ?? [], flows: flowsOf.get(k) ?? { ins: [], outs: [] } })
}

const stepSelect = {
  id: true,
  sequence: true,
  name: true,
  kind: true,
  isQcStep: true,
  execution: true,
  skippedAt: true,
  operationId: true,
  operation: { select: { name: true, sortOrder: true } },
  department: { select: { id: true, name: true } },
  workstation: { select: { supplier: { select: { id: true, name: true } } } },
} satisfies Prisma.MOStepSelect

const cardSelect = {
  id: true,
  jobCardNumber: true,
  orderNo: true,
  projectId: true,
  description: true,
  fabricQuality: true,
  designNo: true,
  lotNo: true,
  createdAt: true,
  moLine: { select: { id: true, color: true, totalQty: true, style: { select: { code: true, name: true } } } },
  mo: {
    select: {
      id: true,
      moNumber: true,
      status: true,
      heldAt: true,
      plannedEndDate: true,
      so: { select: { soNumber: true, customerPORef: true, customer: { select: { name: true } } } },
      steps: { orderBy: { sequence: 'asc' }, select: stepSelect },
    },
  },
} satisfies Prisma.JobCardSelect

/** Job cards with each stage's figures for their own line, and what is with cutting contractors. */
async function loadCards(db: Db, where: Prisma.JobCardWhereInput) {
  const cards = await db.jobCard.findMany({ where, orderBy: { createdAt: 'desc' }, select: cardSelect, take: 1000 })
  if (!cards.length) return []
  const lineIds = cards.map((c) => c.moLine.id)
  const [ledger, withCutters] = await Promise.all([
    ledgerBy(db, { moLineId: { in: lineIds } }, 'moLineId'),
    db.cuttingOrder.groupBy({ by: ['moLineId'], where: { moLineId: { in: lineIds }, status: 'IN_PROGRESS' }, _sum: { plannedPieces: true }, _count: true }),
  ])
  return cards.map((c) => {
    const { held, flows } = ledger(c.moLine.id)
    const figures = c.mo.steps.length ? figuresFrom(c.mo.steps as FigureStep[], c.moLine.totalQty, held, flows) : []
    const cutters = withCutters.find((w) => w.moLineId === c.moLine.id)
    const steps = c.mo.steps.map((s) => ({ ...s, stage: stageOf(s), figures: figures.find((f) => f.stepId === s.id)! }))
    const cutting = steps.find((s) => s.kind === 'CUTTING')
    const lastStep = [...steps].reverse().find((s) => !s.skippedAt)
    const finished = steps.length > 0 && steps.every((s) => s.figures.state === 'DONE' || s.figures.state === 'SKIPPED')
    const started = (cutting?.figures.completed ?? 0) > 0 || (cutters?._count ?? 0) > 0
    return {
      ...c,
      steps,
      withCutters: cutters?._sum.plannedPieces ?? 0,
      cut: cutting?.figures.completed ?? 0,
      packed: lastStep?.figures.packed ?? 0,
      /** Where its pieces are now. */
      atStages: steps
        .filter((s) => s.figures.inTransit + s.figures.inHand + s.figures.waiting + s.figures.atVendor + s.figures.inRework + s.figures.damagedNow + s.figures.rejectedNow + s.figures.short > 0)
        .map((s) => s.name),
      state: !c.mo.steps.length ? 'NO_STAGES' : finished ? 'DONE' : started ? 'IN_PROGRESS' : 'NOT_STARTED',
    }
  })
}

const searchOf = (q: string | undefined): Prisma.JobCardWhereInput =>
  q
    ? {
        OR: [
          { jobCardNumber: { contains: q, mode: 'insensitive' } },
          { designNo: { contains: q, mode: 'insensitive' } },
          { orderNo: { contains: q, mode: 'insensitive' } },
          { projectId: { contains: q, mode: 'insensitive' } },
          { mo: { moNumber: { contains: q, mode: 'insensitive' } } },
          { mo: { so: { soNumber: { contains: q, mode: 'insensitive' } } } },
          { mo: { so: { customer: { name: { contains: q, mode: 'insensitive' } } } } },
          { moLine: { color: { contains: q, mode: 'insensitive' } } },
          { moLine: { style: { code: { contains: q, mode: 'insensitive' } } } },
        ],
      }
    : {}

/** GET /job-cards — every job card of open orders, or all, with where its pieces are. */
export async function listJobCards(db: Db, q: { q?: string; show?: string; moId?: string; page: number; limit: number }) {
  const where: Prisma.JobCardWhereInput = {
    AND: [searchOf(q.q), q.moId ? { moId: q.moId } : {}, q.show === 'all' ? {} : { mo: { status: { notIn: ['CLOSED'] } } }],
  }
  let rows = await loadCards(db, where)
  if (q.show === 'open' || !q.show) rows = rows.filter((r) => r.state !== 'DONE')
  const total = rows.length
  return { data: rows.slice((q.page - 1) * q.limit, q.page * q.limit), total }
}

/** A row for each job card at each stage of its route, with that stage's figures and what waits there. */
async function stageRows(db: Db, q: { q?: string }) {
  const where: Prisma.JobCardWhereInput = { AND: [searchOf(q.q), { mo: { status: { notIn: ['DRAFT', 'CLOSED'] }, steps: { some: {} } } }] }
  const cards = await loadCards(db, where)
  // Transfers sent to a stage of ours and not yet counted in there.
  const open = cards.length
    ? await db.processTransfer.groupBy({
        by: ['jobCardId', 'toStepId'],
        where: { jobCardId: { in: cards.map((c) => c.id) }, vendorId: null, status: { in: ['DISPATCHED', 'PARTLY_RECEIVED'] } },
        _count: true,
      })
    : []
  return cards.flatMap((c) =>
    c.steps.map((s) => {
      const f = s.figures
      const before = c.steps.filter((x) => nextStepAfter(c.steps, x.id)?.id === s.id)
      const next = nextStepAfter(c.steps, s.id)
      const busy = f.inTransit + f.inHand + f.waiting + f.atVendor + f.inRework + f.damagedNow + f.rejectedNow + f.short
      return {
        card: {
          id: c.id,
          jobCardNumber: c.jobCardNumber,
          orderNo: c.orderNo,
          projectId: c.projectId,
          designNo: c.designNo,
          lotNo: c.lotNo,
          line: c.moLine,
          mo: { id: c.mo.id, moNumber: c.mo.moNumber, held: !!c.mo.heldAt, due: c.mo.plannedEndDate, so: c.mo.so },
        },
        step: {
          id: s.id,
          name: s.name,
          sequence: s.sequence,
          kind: s.kind,
          isQcStep: s.isQcStep,
          execution: s.execution,
          operationId: s.operationId,
          sortOrder: s.operation.sortOrder,
          department: s.department,
          unit: s.workstation?.supplier ?? null,
          skipped: !!s.skippedAt,
          last: !next,
        },
        stage: s.stage,
        from: before.map((b) => b.name),
        next: next ? { id: next.id, name: next.name, execution: next.execution } : null,
        figures: f,
        withCutters: s.stage === 'CUTTING' ? c.withCutters : 0,
        /** Transfers sent here and not yet counted in. */
        toCountIn: open.find((o) => o.jobCardId === c.id && o.toStepId === s.id)?._count ?? 0,
        /** Something is there, or on its way there, now. */
        active: busy > 0 || (s.stage === 'CUTTING' && (c.withCutters > 0 || (f.state !== 'DONE' && c.state !== 'DONE'))),
      }
    }),
  )
}

/**
 * GET /stage-sheets?operationId=|stage= — the sheets of one stage (a process
 * of the master, or a kind of stage): a row for each job card at that stage
 * of its route, with its figures. The list a department works from.
 */
export async function stageSheets(db: Db, q: { stage?: Stage; q?: string; show?: string; operationId?: string; page: number; limit: number }) {
  let rows = (await stageRows(db, q)).filter((r) => (!q.stage || r.stage === q.stage) && (!q.operationId || r.step.operationId === q.operationId))
  if (q.show === 'done') rows = rows.filter((r) => r.figures.state === 'DONE')
  else if (q.show === 'waiting') rows = rows.filter((r) => r.figures.state === 'NOT_STARTED' && !r.active)
  else if (q.show !== 'all') rows = rows.filter((r) => r.active)
  // Work to count in first, then the rest by order.
  rows.sort((a, b) => b.toCountIn - a.toCountIn || a.card.mo.moNumber.localeCompare(b.card.mo.moNumber) || a.card.jobCardNumber.localeCompare(b.card.jobCardNumber))
  const total = rows.length
  return { data: rows.slice((q.page - 1) * q.limit, q.page * q.limit), total }
}

/**
 * GET /stage-tabs — the stages on the routes of open orders, cutting first
 * and then in the process master's order, each with how many job cards have
 * work there now and how many transfers wait to be counted in: the tabs of
 * the production stages screen.
 */
export async function stageTabs(db: Db) {
  const rows = await stageRows(db, {})
  const tabs = new Map<string, { operationId: string; name: string; stage: Stage; sortOrder: number; sequence: number; sheets: number; active: number; toCountIn: number }>()
  for (const r of rows) {
    const t = tabs.get(r.step.operationId) ?? { operationId: r.step.operationId, name: r.step.name, stage: r.stage, sortOrder: r.step.sortOrder, sequence: r.step.sequence, sheets: 0, active: 0, toCountIn: 0 }
    t.sheets += 1
    if (r.active) t.active += 1
    t.toCountIn += r.toCountIn
    t.sequence = Math.min(t.sequence, r.step.sequence)
    tabs.set(r.step.operationId, t)
  }
  return [...tabs.values()].sort(
    (a, b) => Number(b.stage === 'CUTTING') - Number(a.stage === 'CUTTING') || a.sortOrder - b.sortOrder || a.sequence - b.sequence || a.name.localeCompare(b.name),
  )
}

// ─── One job card, for its sheets ─────────────────────────────

/**
 * Everything a job card's sheets show: its header, its order's stages with
 * the card's own figures (in all, and size by size), its bundles and where
 * they are, its transfers, its cutting contractors' issues, outside work, the
 * entries line by line for the sheets' logs, and whether the order's
 * materials have been issued — cutting waits for that.
 */
export async function jobCardDetail(db: Db, id: string) {
  const card = await db.jobCard.findUnique({
    where: { id },
    select: {
      id: true,
      jobCardNumber: true,
      moId: true,
      moLineId: true,
      orderNo: true,
      projectId: true,
      description: true,
      fabricQuality: true,
      designNo: true,
      lotNo: true,
      meters: true,
      average: true,
      ratio: true,
      notes: true,
      createdAt: true,
      updatedAt: true,
      mo: { select: { plannedEndDate: true, so: { select: { soNumber: true, customerPORef: true, reference: true, customer: { select: { name: true } } } } } },
    },
  })
  if (!card) throw new AppError('Job card not found', 404, 'NOT_FOUND')

  const [flow, cuttings, bySize, log, requisitions] = await Promise.all([
    flowSummary(db, card.moId, { moLineId: card.moLineId, jobCardId: card.id }),
    db.cuttingOrder.findMany({
      where: { moLineId: card.moLineId },
      orderBy: { createdAt: 'asc' },
      select: {
        id: true,
        cutOrderNumber: true,
        cutDate: true,
        updatedAt: true,
        status: true,
        cutterName: true,
        lotNo: true,
        ratio: true,
        noOfLayers: true,
        fabricIssued: true,
        fabricUsed: true,
        wastage: true,
        bundleSize: true,
        plannedPieces: true,
        actualPieces: true,
        plannedBreakup: true,
        sizeBreakup: true,
        notes: true,
        fabricItem: { select: { id: true, code: true, name: true, uom: { select: { symbol: true } } } },
        createdBy: { select: { name: true } },
        _count: { select: { bundles: true } },
      },
    }),
    ledgerBy(db, { moLineId: card.moLineId }, 'sizeId'),
    db.wipEntry.findMany({
      where: { moLineId: card.moLineId, eventType: { not: 'REVERSAL' }, event: { reversedAt: null } },
      orderBy: { createdAt: 'asc' },
      select: {
        stepId: true,
        bundleId: true,
        sizeId: true,
        bucket: true,
        qty: true,
        vendorId: true,
        eventType: true,
        event: {
          select: {
            id: true,
            eventDate: true,
            personName: true,
            reason: true,
            transfer: { select: { transferNumber: true } },
            cuttingOrder: { select: { cutOrderNumber: true } },
            jobWorkOrder: { select: { orderNumber: true } },
            fgReceipt: { select: { fgrNumber: true } },
            createdBy: { select: { name: true } },
          },
        },
      },
    }),
    db.materialRequisition.findMany({
      where: { moId: card.moId },
      orderBy: { createdAt: 'asc' },
      select: { id: true, mrNumber: true, status: true, issuedAt: true, closedAt: true, department: { select: { name: true } }, lines: { select: { issuedQty: true } } },
    }),
  ])

  const line = flow.lines[0]
  const sizeFigures = Object.fromEntries(
    (line?.sizes ?? []).map((z) => {
      const { held, flows } = bySize(z.id)
      return [z.id, flow.steps.length ? figuresFrom(flow.steps as FigureStep[], z.qty, held, flows) : []]
    }),
  )
  const issued = requisitions.some((r) => r.lines.some((l) => Number(l.issuedQty) > 0))

  return {
    ...flow,
    card: {
      ...card,
      meters: card.meters == null ? null : Number(card.meters),
      average: card.average == null ? null : Number(card.average),
      so: card.mo.so,
      due: card.mo.plannedEndDate,
    },
    line,
    sizeFigures,
    cuttings,
    log: log.map((e) => ({
      eventId: e.event.id,
      type: e.eventType,
      date: e.event.eventDate,
      person: e.event.personName,
      by: e.event.createdBy.name,
      reason: e.event.reason,
      document: e.event.transfer?.transferNumber ?? e.event.cuttingOrder?.cutOrderNumber ?? e.event.jobWorkOrder?.orderNumber ?? e.event.fgReceipt?.fgrNumber ?? null,
      stepId: e.stepId,
      bundleId: e.bundleId,
      sizeId: e.sizeId,
      bucket: e.bucket,
      qty: e.qty,
      vendorId: e.vendorId,
    })),
    materials: {
      issued,
      requisitions: requisitions.map((r) => ({
        id: r.id,
        mrNumber: r.mrNumber,
        status: r.status,
        department: r.department.name,
        issued: r.lines.some((l) => Number(l.issuedQty) > 0),
        closed: !!r.closedAt,
      })),
    },
  }
}
