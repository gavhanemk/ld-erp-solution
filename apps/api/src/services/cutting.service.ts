import type { Prisma } from '@prisma/client'
import { z } from 'zod'
import { AppError } from '../middleware/errorHandler'
import { recordMovement } from './stock.service'
import { lockMo, postEvent, reverseEvent } from './wip.service'
import { syncProgress } from './floor.service'

/**
 * Cutting, recorded against a manufacturing order — the cutting document.
 *
 * The store issues fabric to the cutting floor on a requisition; a cutting
 * says what happened to it there: the fabric used and the cut waste, against
 * one line of the order (a style in one colour), lay by lay — lot, marker
 * ratio, layers, who cut it — and the pieces cut by size, planned against
 * actual. Whatever is left goes back to the store on a floor return.
 *
 * On an order with a route the cutting sheet works in two steps, as the
 * cutting department does: sizes are issued to a cutting contractor (a lay,
 * with its lot, ratio and fabric), and what comes back cut is received
 * against that issue. The pieces received are tied into bundles of a chosen
 * size, each with its own number for the sticker, and go on the production
 * ledger as done at the cutting step, ready to send on. Nothing is issued for
 * cutting before the order's materials have been issued to it. On an order
 * without a route pieces are counted as before, and can be put into a store
 * as semi-finished panels.
 *
 * Numbered from the order (MO-2627-0001-C1, -C2). Cancelling takes the pieces
 * back — refused once any of them has moved on.
 */

type Db = Prisma.TransactionClient

const round3 = (n: number) => Math.round(n * 1000) / 1000
const round2 = (n: number) => Math.round(n * 100) / 100
const isFabric = (cat: { name: string; parent: { name: string } | null } | null) =>
  /fabric/i.test(cat?.name ?? '') || /fabric/i.test(cat?.parent?.name ?? '')

/** Pieces to a bundle when nothing else is said. */
export const DEFAULT_BUNDLE_SIZE = 20

const sizeQty = z.array(z.object({ sizeId: z.string().min(1), qty: z.number().int().min(0).max(1_000_000) }))

export const cuttingSchema = z.object({
  cutDate: z.coerce.date().optional(),
  /** The order line cut: one style in one colour. */
  moLineId: z.string().optional().nullable(),
  fabricItemId: z.string().min(1, 'Say which fabric was cut'),
  fabricUsed: z.number().min(0, 'Fabric used cannot be negative').max(9_999_999),
  wastage: z.number().min(0, 'Waste cannot be negative').max(9_999_999).optional(),
  noOfLayers: z.number().int().min(0).max(10_000).optional().nullable(),
  lotNo: z.string().trim().max(60).optional().nullable(),
  ratio: z.string().trim().max(120).optional().nullable(),
  cutterName: z.string().trim().max(120).optional().nullable(),
  /** Pieces to a bundle; 0 or empty ties each size into one bundle. */
  bundleSize: z.number().int().min(0).max(10_000).optional().nullable(),
  /** What the lay was planned to give, by size. */
  planned: sizeQty.optional(),
  /** Pieces cut by size, for a line with sizes. */
  sizes: sizeQty.optional(),
  /** Pieces cut, for a line without sizes. */
  pieces: z.number().int().min(0).optional(),
  /** Cut more than the order plans — an allowance — with a manager's say-so. */
  allowExcess: z.boolean().optional(),
  /** Put the cut panels into a store, as this semi-finished item (orders without a route only). */
  panelItemId: z.string().optional().nullable(),
  panelWarehouseId: z.string().optional().nullable(),
  notes: z.string().trim().max(1000).optional().nullable(),
  clientKey: z.string().trim().min(8).max(80).optional().nullable(),
})

type Breakup = Record<string, number>
const breakupOf = (v: unknown): Breakup => (v && typeof v === 'object' ? (v as Breakup) : {})

/** Everything the cutting form needs for one order. */
export async function cuttingPrep(db: Db, moId: string) {
  const mo = await db.manufacturingOrder.findUnique({
    where: { id: moId },
    select: {
      id: true,
      moNumber: true,
      status: true,
      heldAt: true,
      totalPlannedQty: true,
      totalCutQty: true,
      so: { select: { id: true, soNumber: true, isJobWork: true, customerId: true, customer: { select: { name: true } } } },
      lines: {
        select: {
          id: true,
          color: true,
          totalQty: true,
          style: { select: { code: true, name: true } },
          sizes: { select: { sizeId: true, qty: true, size: { select: { code: true, sequence: true } } } },
        },
      },
      steps: { orderBy: { sequence: 'asc' }, select: { id: true, name: true, kind: true } },
      cuttingOrders: {
        where: { status: { not: 'CANCELLED' } },
        orderBy: { createdAt: 'asc' },
        select: {
          id: true,
          cutOrderNumber: true,
          cutDate: true,
          moLineId: true,
          fabricItemId: true,
          fabricIssued: true,
          fabricUsed: true,
          wastage: true,
          actualPieces: true,
          plannedPieces: true,
          sizeBreakup: true,
          plannedBreakup: true,
          lotNo: true,
          ratio: true,
          cutterName: true,
          noOfLayers: true,
          bundleSize: true,
          status: true,
          notes: true,
          fabricItem: { select: { code: true, name: true, uom: { select: { symbol: true } } } },
          panelItem: { select: { code: true, name: true } },
          panelWarehouse: { select: { name: true } },
          createdBy: { select: { name: true } },
          _count: { select: { bundles: true } },
        },
      },
    },
  })
  if (!mo) throw new AppError('Manufacturing order not found', 404, 'NOT_FOUND')

  // What was issued to this order, item by item, less what came back.
  const issued = await db.materialRequisitionLine.findMany({
    where: { mr: { moId: mo.id }, issuedQty: { gt: 0 } },
    select: {
      itemId: true,
      issuedQty: true,
      returnedQty: true,
      ownership: true,
      item: { select: { code: true, name: true, uom: { select: { symbol: true } }, category: { select: { name: true, parent: { select: { name: true } } } } } },
    },
  })
  const byItem = new Map<string, { itemId: string; code: string; name: string; uom: string | null; fabric: boolean; theirs: boolean; issued: number }>()
  for (const l of issued) {
    const row = byItem.get(l.itemId) ?? {
      itemId: l.itemId,
      code: l.item.code,
      name: l.item.name,
      uom: l.item.uom?.symbol ?? null,
      fabric: isFabric(l.item.category),
      theirs: false,
      issued: 0,
    }
    row.issued = round3(row.issued + Number(l.issuedQty) - Number(l.returnedQty))
    row.theirs = row.theirs || l.ownership === 'CUSTOMER_OWNED'
    byItem.set(l.itemId, row)
  }
  const fabrics = [...byItem.values()]
    .map((f) => {
      const accounted = round3(
        mo.cuttingOrders.filter((c) => c.fabricItemId === f.itemId).reduce((s, c) => s + Number(c.fabricUsed ?? 0) + Number(c.wastage ?? 0), 0),
      )
      return { ...f, accounted, left: round3(f.issued - accounted) }
    })
    .sort((a, b) => Number(b.fabric) - Number(a.fabric) || a.name.localeCompare(b.name))

  // Pieces by size, for the whole order (cuttings made before lines were
  // recorded count here) and line by line.
  const planned = new Map<string, { sizeId: string; code: string; sequence: number; planned: number; cut: number }>()
  for (const l of mo.lines) {
    for (const z of l.sizes) {
      const row = planned.get(z.sizeId) ?? { sizeId: z.sizeId, code: z.size.code, sequence: z.size.sequence, planned: 0, cut: 0 }
      row.planned += z.qty
      planned.set(z.sizeId, row)
    }
  }
  for (const c of mo.cuttingOrders) {
    for (const [sizeId, qty] of Object.entries(breakupOf(c.sizeBreakup))) {
      const row = planned.get(sizeId)
      if (row) row.cut += Number(qty)
    }
  }
  const sizes = [...planned.values()].sort((a, b) => a.sequence - b.sequence)

  const lines = mo.lines.map((l) => {
    const mine = mo.cuttingOrders.filter((c) => c.moLineId === l.id)
    const cutBySize = new Map<string, number>()
    for (const c of mine) for (const [sizeId, qty] of Object.entries(breakupOf(c.sizeBreakup))) cutBySize.set(sizeId, (cutBySize.get(sizeId) ?? 0) + Number(qty))
    return {
      id: l.id,
      style: l.style,
      color: l.color,
      totalQty: l.totalQty,
      cut: mine.reduce((s, c) => s + c.actualPieces, 0),
      sizes: [...l.sizes]
        .sort((a, b) => a.size.sequence - b.size.sequence)
        .map((z) => ({ sizeId: z.sizeId, code: z.size.code, planned: z.qty, cut: cutBySize.get(z.sizeId) ?? 0 })),
    }
  })

  const [panelItems, warehouses, lastBundle] = await Promise.all([
    db.item.findMany({ where: { type: 'SEMI_FINISHED', isActive: true }, select: { id: true, code: true, name: true }, orderBy: { name: 'asc' } }),
    db.warehouse.findMany({ where: { isActive: true }, select: { id: true, name: true }, orderBy: { name: 'asc' } }),
    db.productionBundle.aggregate({ where: { moId: mo.id }, _max: { bundleNo: true } }),
  ])
  const cuttingStep = mo.steps.find((s) => s.kind === 'CUTTING') ?? null

  return {
    mo: {
      id: mo.id,
      moNumber: mo.moNumber,
      status: mo.status,
      held: !!mo.heldAt,
      totalPlannedQty: mo.totalPlannedQty,
      totalCutQty: mo.totalCutQty,
      so: mo.so,
      routed: mo.steps.length > 0,
      cuttingStep,
      nextBundleNo: (lastBundle._max.bundleNo ?? 0) + 1,
    },
    defaultBundleSize: DEFAULT_BUNDLE_SIZE,
    fabrics,
    sizes,
    lines,
    cuttings: mo.cuttingOrders,
    panelItems,
    warehouses,
  }
}

/** Splits pieces into bundles of `size`: 45 in 20s is 20, 20, 5. */
export function bundleSplit(pieces: number, size: number | null | undefined) {
  if (pieces <= 0) return []
  if (!size || size <= 0 || size >= pieces) return [pieces]
  const out: number[] = []
  for (let left = pieces; left > 0; left -= size) out.push(Math.min(size, left))
  return out
}

export const cutterIssueSchema = z.object({
  /** The job card cut: one style in one colour. */
  moLineId: z.string().min(1, 'Say which colour is being cut'),
  cutterName: z.string().trim().min(1, 'Name the cutting contractor').max(120),
  issuedOn: z.coerce.date().optional(),
  lotNo: z.string().trim().max(60).optional().nullable(),
  ratio: z.string().trim().max(120).optional().nullable(),
  noOfLayers: z.number().int().min(0).max(10_000).optional().nullable(),
  /** The fabric given to the contractor for the lay, and how much of it. */
  fabricItemId: z.string().optional().nullable(),
  fabricGiven: z.number().min(0).max(9_999_999).optional().nullable(),
  /** Pieces to cut, by size. */
  planned: sizeQty.optional(),
  /** Pieces to cut, for a line without sizes. */
  pieces: z.number().int().min(0).optional(),
  allowExcess: z.boolean().optional(),
  notes: z.string().trim().max(1000).optional().nullable(),
})

/**
 * Sizes issued to a cutting contractor — the first entry on a cutting sheet.
 * Refused before the order's materials have been issued to it, and for more
 * than is left to cut of each size, counting what other contractors already
 * have in hand.
 */
export async function issueToCutter(tx: Db, moId: string, d: z.infer<typeof cutterIssueSchema>, userId: string, opts: { mayApprove?: boolean } = {}) {
  await lockMo(tx, moId)
  const prep = await cuttingPrep(tx, moId)
  const { mo } = prep
  if (mo.status === 'DRAFT' || mo.status === 'CLOSED' || mo.status === 'COMPLETED') {
    throw new AppError(`${mo.moNumber} is ${mo.status.toLowerCase()}, so nothing is being cut for it`, 409, 'NOT_OPEN')
  }
  if (mo.held) throw new AppError(`${mo.moNumber} is on hold. Resume it before issuing anything for cutting.`, 409, 'ON_HOLD')
  if (!mo.routed) throw new AppError(`Load ${mo.moNumber}'s stages first: the cutting sheet comes from them.`, 409, 'NO_ROUTE')
  if (!prep.fabrics.some((f) => f.issued > 0)) {
    throw new AppError(`${mo.moNumber}'s materials have not been issued yet. Raise its requisition and have the store issue it before cutting starts.`, 409, 'MATERIALS_NOT_ISSUED')
  }
  const line = prep.lines.find((l) => l.id === d.moLineId)
  if (!line) throw new AppError(`That colour is not on ${mo.moNumber}`, 400, 'BAD_LINE')
  if (d.fabricItemId && !prep.fabrics.some((f) => f.itemId === d.fabricItemId)) {
    throw new AppError(`That fabric has not been issued to ${mo.moNumber}. Issue it on the order's requisition first.`, 400, 'FABRIC_NOT_ISSUED')
  }
  if (d.allowExcess && !opts.mayApprove) throw new AppError('Cutting more than the order plans needs a production manager.', 403, 'NEEDS_APPROVAL')
  const excessOk = !!(d.allowExcess && opts.mayApprove)

  // With the contractors still: issued and not yet received back.
  const open = prep.cuttings.filter((c) => c.moLineId === line.id && c.status === 'IN_PROGRESS')
  const withCutters = (sizeId: string) => open.reduce((s, c) => s + Number(breakupOf(c.plannedBreakup)[sizeId] ?? 0), 0)
  const planned: Breakup = {}
  if (line.sizes.length) {
    for (const z of d.planned ?? []) {
      if (z.qty <= 0) continue
      const own = line.sizes.find((x) => x.sizeId === z.sizeId)
      if (!own) throw new AppError(`That size is not on ${line.style.code} ${line.color}`, 400, 'BAD_SIZE')
      const out = withCutters(z.sizeId)
      if (!excessOk && own.cut + out + (planned[z.sizeId] ?? 0) + z.qty > own.planned) {
        throw new AppError(
          `${line.style.code} ${line.color}, size ${own.code}: ${own.planned} to make, ${own.cut} cut and ${out} with contractors, so ${z.qty} more is too many.`,
          400,
          'MORE_THAN_PLANNED',
        )
      }
      planned[z.sizeId] = (planned[z.sizeId] ?? 0) + z.qty
    }
  }
  const pieces = line.sizes.length ? Object.values(planned).reduce((s, n) => s + n, 0) : d.pieces ?? 0
  if (pieces <= 0) throw new AppError('Enter how many pieces of each size are issued for cutting.', 400, 'NOTHING_ISSUED')
  if (!line.sizes.length && !excessOk) {
    const out = open.reduce((s, c) => s + c.plannedPieces, 0)
    if (line.cut + out + pieces > line.totalQty) throw new AppError(`${line.totalQty} to make, ${line.cut} cut and ${out} with contractors, so ${pieces} more is too many.`, 400, 'MORE_THAN_PLANNED')
  }

  const count = await tx.cuttingOrder.count({ where: { moId } })
  return tx.cuttingOrder.create({
    data: {
      cutOrderNumber: `${mo.moNumber}-C${count + 1}`,
      moId,
      moLineId: line.id,
      cutDate: d.issuedOn ?? new Date(),
      fabricItemId: d.fabricItemId || null,
      fabricIssued: d.fabricGiven ?? null,
      noOfLayers: d.noOfLayers ?? null,
      lotNo: d.lotNo || null,
      ratio: d.ratio || null,
      cutterName: d.cutterName,
      plannedBreakup: Object.keys(planned).length ? planned : undefined,
      plannedPieces: pieces,
      actualPieces: 0,
      status: 'IN_PROGRESS',
      notes: d.notes ?? null,
      createdById: userId,
    },
  })
}

/** Records one cutting against an order, inside the caller's transaction. */
export async function createCutting(
  tx: Db,
  moId: string,
  data: z.infer<typeof cuttingSchema>,
  userId: string,
  opts: { mayApprove?: boolean; /** Received back against this issue to a contractor. */ issueId?: string } = {},
) {
  await lockMo(tx, moId)
  if (data.clientKey) {
    const dup = await tx.wipEvent.findUnique({ where: { clientKey: data.clientKey }, select: { cuttingOrderId: true } })
    if (dup?.cuttingOrderId) return tx.cuttingOrder.findUniqueOrThrow({ where: { id: dup.cuttingOrderId } })
  }
  // Received against an issue: the lay is the issue's, and it is completed
  // rather than a new cutting made.
  const issue = opts.issueId ? await tx.cuttingOrder.findUnique({ where: { id: opts.issueId } }) : null
  if (opts.issueId && (!issue || issue.moId !== moId)) throw new AppError('That issue to a cutting contractor was not found', 404, 'NOT_FOUND')
  if (issue && issue.status !== 'IN_PROGRESS') {
    throw new AppError(`${issue.cutOrderNumber} is ${issue.status === 'CANCELLED' ? 'cancelled' : 'already received'}.`, 409, 'NOT_WITH_CUTTER')
  }
  if (issue) {
    data = {
      ...data,
      moLineId: issue.moLineId,
      cutterName: data.cutterName || issue.cutterName,
      lotNo: data.lotNo || issue.lotNo,
      ratio: data.ratio || issue.ratio,
      noOfLayers: data.noOfLayers ?? issue.noOfLayers,
      fabricItemId: data.fabricItemId || issue.fabricItemId || '',
      planned: data.planned ?? Object.entries(breakupOf(issue.plannedBreakup)).map(([sizeId, qty]) => ({ sizeId, qty: Number(qty) })),
    }
  }
  const prep = await cuttingPrep(tx, moId)
  const { mo } = prep
  if (mo.status === 'DRAFT' || mo.status === 'CLOSED' || mo.status === 'COMPLETED') {
    throw new AppError(`${mo.moNumber} is ${mo.status.toLowerCase()}, so nothing is being cut for it`, 409, 'NOT_OPEN')
  }
  if (mo.held) throw new AppError(`${mo.moNumber} is on hold. Resume it before recording a cutting.`, 409, 'ON_HOLD')

  const fabric = prep.fabrics.find((f) => f.itemId === data.fabricItemId)
  if (!data.fabricItemId) throw new AppError('Say which fabric was cut', 400, 'NO_FABRIC')
  if (!fabric) {
    throw new AppError(`That fabric has not been issued to ${mo.moNumber}. Issue it on the order's requisition first.`, 400, 'FABRIC_NOT_ISSUED')
  }
  const wastage = data.wastage ?? 0
  if (round3(data.fabricUsed + wastage) > fabric.left + 1e-9) {
    throw new AppError(
      `Only ${fabric.left} ${fabric.uom ?? ''} of ${fabric.name} issued to ${mo.moNumber} is not yet accounted for; this cutting uses ${round3(data.fabricUsed + wastage)} with the waste.`.replace(/\s+/g, ' '),
      400,
      'MORE_THAN_ISSUED',
    )
  }

  // Which line: an order with a route cuts one colour at a time.
  let line = data.moLineId ? prep.lines.find((l) => l.id === data.moLineId) : undefined
  if (data.moLineId && !line) throw new AppError(`That line is not on ${mo.moNumber}`, 400, 'BAD_LINE')
  if (!line && mo.routed) {
    if (prep.lines.length !== 1) throw new AppError('Say which line — style and colour — was cut.', 400, 'NO_LINE')
    line = prep.lines[0]
  }
  const excessOk = !!(data.allowExcess && opts.mayApprove)
  if (data.allowExcess && !opts.mayApprove) throw new AppError('Cutting more than the order plans needs a production manager.', 403, 'NEEDS_APPROVAL')

  // Pieces: by size when there are sizes, never more than planned unless allowed.
  let pieces: number
  const breakup: Breakup = {}
  const sized = line ? line.sizes.length > 0 : prep.sizes.length > 0
  if (sized) {
    for (const z of data.sizes ?? []) {
      if (z.qty <= 0) continue
      const pooled = prep.sizes.find((x) => x.sizeId === z.sizeId)
      const own = line?.sizes.find((x) => x.sizeId === z.sizeId)
      if (!pooled || (line && !own)) throw new AppError(`That size is not on ${line ? `${line.style.code} ${line.color}` : mo.moNumber}`, 400, 'BAD_SIZE')
      if (!excessOk) {
        if (own && own.cut + z.qty > own.planned) {
          throw new AppError(`${line!.style.code} ${line!.color}, size ${own.code}: ${own.planned} planned and ${own.cut} already cut, so ${z.qty} more is too many.`, 400, 'MORE_THAN_PLANNED')
        }
        if (pooled.cut + z.qty > pooled.planned) {
          throw new AppError(`Size ${pooled.code}: ${pooled.planned} planned and ${pooled.cut} already cut, so ${z.qty} more is too many`, 400, 'MORE_THAN_PLANNED')
        }
      }
      breakup[z.sizeId] = (breakup[z.sizeId] ?? 0) + z.qty
    }
    pieces = Object.values(breakup).reduce((s, n) => s + n, 0)
  } else {
    pieces = data.pieces ?? 0
    const plannedHere = line ? line.totalQty : mo.totalPlannedQty
    const cutHere = line ? line.cut : mo.totalCutQty
    if (!excessOk && cutHere + pieces > plannedHere) {
      throw new AppError(`${plannedHere} planned and ${cutHere} already cut, so ${pieces} more is too many`, 400, 'MORE_THAN_PLANNED')
    }
  }
  if (pieces <= 0 && data.fabricUsed <= 0) throw new AppError('Enter the pieces cut and the fabric used', 400, 'NOTHING_CUT')
  if (mo.routed && pieces <= 0) throw new AppError('Enter the pieces cut: they become the bundles that go on to the next step.', 400, 'NOTHING_CUT')

  // Panels into a store, to go out for outside work — only without a route;
  // with one, outside work goes on a job work order.
  if (mo.routed && (data.panelItemId || data.panelWarehouseId)) {
    throw new AppError(`${mo.moNumber} has a route: send the bundles to an outside step on a job work order instead of putting panels into a store.`, 400, 'ROUTED')
  }
  const panelsIn = !!(data.panelItemId && data.panelWarehouseId && pieces > 0)
  if (data.panelItemId || data.panelWarehouseId) {
    if (!data.panelItemId || !data.panelWarehouseId) throw new AppError('Say both the panel item and the store to put them in', 400, 'PANELS_INCOMPLETE')
    const item = await tx.item.findUnique({ where: { id: data.panelItemId }, select: { type: true, code: true, isActive: true } })
    if (!item || item.type !== 'SEMI_FINISHED' || !item.isActive) {
      throw new AppError('Cut panels go into stock as an active semi-finished item. Make one in Masters → Items.', 400, 'NOT_SEMI_FINISHED')
    }
  }
  const plannedBreakup: Breakup = {}
  for (const z of data.planned ?? []) if (z.qty > 0) plannedBreakup[z.sizeId] = z.qty

  const count = await tx.cuttingOrder.count({ where: { moId } })
  const cutOrderNumber = issue?.cutOrderNumber ?? `${mo.moNumber}-C${count + 1}`
  const bundleSize = mo.routed ? (data.bundleSize ?? DEFAULT_BUNDLE_SIZE) : null
  const fields = {
      moLineId: line?.id ?? null,
      cutDate: data.cutDate ?? new Date(),
      fabricItemId: data.fabricItemId,
      fabricIssued: issue?.fabricIssued ?? fabric.issued,
      fabricUsed: data.fabricUsed,
      wastage,
      noOfLayers: data.noOfLayers ?? null,
      lotNo: data.lotNo || null,
      ratio: data.ratio || null,
      cutterName: data.cutterName || null,
      bundleSize,
      plannedBreakup: Object.keys(plannedBreakup).length ? plannedBreakup : undefined,
      plannedPieces: Object.keys(plannedBreakup).length ? Object.values(plannedBreakup).reduce((s, n) => s + n, 0) : line?.totalQty ?? mo.totalPlannedQty,
      actualPieces: pieces,
      sizeBreakup: Object.keys(breakup).length ? breakup : undefined,
      status: 'COMPLETED' as const,
      notes: [issue?.notes, data.notes].filter(Boolean).join(' · ') || null,
      panelItemId: panelsIn ? data.panelItemId : null,
      panelWarehouseId: panelsIn ? data.panelWarehouseId : null,
  }
  const created = issue
    ? await tx.cuttingOrder.update({ where: { id: issue.id }, data: fields })
    : await tx.cuttingOrder.create({ data: { ...fields, cutOrderNumber, moId, createdById: userId } })
  await tx.manufacturingOrder.update({ where: { id: moId }, data: { totalCutQty: { increment: pieces } } })

  if (mo.routed) {
    // Bundles: each size tied into bundles of bundleSize, numbered on from the
    // order's last, and the pieces done at the cutting step.
    const cuttingStep = mo.cuttingStep
    if (!cuttingStep) throw new AppError(`${mo.moNumber}'s route has no cutting step.`, 409, 'NO_CUTTING_STEP')
    const order = line!.sizes.length ? line!.sizes.filter((z) => breakup[z.sizeId]).map((z) => ({ sizeId: z.sizeId as string | null, qty: breakup[z.sizeId] })) : [{ sizeId: null, qty: pieces }]
    const tied = order.flatMap((part) => bundleSplit(part.qty, bundleSize).map((qty) => ({ sizeId: part.sizeId, qty })))
    if (tied.length > 2000) throw new AppError('That makes more than 2,000 bundles; tie bigger bundles.', 400, 'TOO_MANY_BUNDLES')
    await tx.productionBundle.createMany({
      data: tied.map((b, i) => {
        const no = mo.nextBundleNo + i
        return { code: `${mo.moNumber}-B${String(no).padStart(3, '0')}`, bundleNo: no, moId, moLineId: line!.id, cuttingOrderId: created.id, sizeId: b.sizeId, qty: b.qty }
      }),
    })
    const bundles = await tx.productionBundle.findMany({ where: { cuttingOrderId: created.id }, select: { id: true, qty: true } })
    await postEvent(tx, {
      moId,
      type: 'CUT',
      stepId: cuttingStep.id,
      cuttingOrderId: created.id,
      eventDate: created.cutDate,
      personName: data.cutterName ?? null,
      clientKey: data.clientKey ?? null,
      createdById: userId,
      moves: bundles.map((b) => ({ stepId: cuttingStep.id, bundleId: b.id, bucket: 'DONE' as const, qty: b.qty })),
    })
    await syncProgress(tx, moId)
  }

  if (panelsIn) {
    // The customer's panels on a job-work order (their fabric), at no value
    // of ours; our own at the value of the fabric that went into them.
    const theirs = !!(mo.so?.isJobWork && fabric.theirs)
    let rate = 0
    if (!theirs) {
      const issues = await tx.stockLedger.findMany({
        where: { referenceType: 'MATERIAL_REQUISITION', itemId: data.fabricItemId, outQty: { gt: 0 }, referenceId: { in: (await tx.materialRequisition.findMany({ where: { moId }, select: { id: true } })).map((m) => m.id) } },
        select: { outQty: true, unitRate: true },
      })
      const qty = issues.reduce((s, r) => s + Number(r.outQty), 0)
      const value = issues.reduce((s, r) => s + Number(r.outQty) * Number(r.unitRate ?? 0), 0)
      rate = qty > 0 && pieces > 0 ? round2(((value / qty) * data.fabricUsed) / pieces) : 0
    }
    const parts = Object.keys(breakup).length ? Object.entries(breakup).map(([sizeId, qty]) => ({ sizeId, qty })) : [{ sizeId: null as string | null, qty: pieces }]
    for (const p of parts) {
      await recordMovement(tx, {
        itemId: data.panelItemId!,
        warehouseId: data.panelWarehouseId!,
        sizeId: p.sizeId,
        ...(theirs ? { ownership: 'CUSTOMER_OWNED' as const, ownerCustomerId: mo.so!.customerId } : {}),
        transactionType: 'PRODUCTION',
        direction: 'IN',
        qty: p.qty,
        unitRate: rate,
        referenceType: 'CUTTING',
        referenceId: created.id,
        transactionDate: created.cutDate,
        notes: `Cut on ${cutOrderNumber}`,
      })
    }
  }
  return created
}

/** Takes a cutting back: its pieces off the order, its bundles or panels with them. */
export async function cancelCutting(tx: Db, id: string, reason: string, userId: string) {
  const head = await tx.cuttingOrder.findUnique({ where: { id }, select: { moId: true } })
  if (!head) throw new AppError('Cutting not found', 404, 'NOT_FOUND')
  await lockMo(tx, head.moId)
  const before = await tx.cuttingOrder.findUniqueOrThrow({ where: { id } })
  if (before.status === 'CANCELLED') throw new AppError(`${before.cutOrderNumber} is already cancelled`, 409, 'ALREADY_CANCELLED')

  // Its bundles off the floor — refused if any piece has moved on.
  const cut = await tx.wipEvent.findFirst({ where: { cuttingOrderId: id, type: 'CUT', reversedAt: null }, select: { id: true } })
  if (cut) {
    try {
      await reverseEvent(tx, cut.id, `Cancelled ${before.cutOrderNumber}: ${reason}`, userId)
    } catch (err) {
      if (err instanceof AppError && err.code === 'NOT_ENOUGH_PIECES') {
        throw new AppError(`${before.cutOrderNumber} cannot be cancelled: some of its bundles have already been sent on. Cancel that transfer first.`, 409, 'MOVED_ON')
      }
      throw err
    }
  }

  const ins = await tx.stockLedger.findMany({ where: { referenceType: 'CUTTING', referenceId: id, inQty: { gt: 0 } } })
  for (const row of ins) {
    await recordMovement(tx, {
      itemId: row.itemId,
      warehouseId: row.warehouseId,
      sizeId: row.sizeId,
      grade: row.grade,
      ownership: row.ownership,
      ownerCustomerId: row.ownerCustomerId,
      transactionType: 'ADJUSTMENT',
      direction: 'OUT',
      qty: Number(row.inQty),
      referenceType: 'CUTTING_CANCEL',
      referenceId: id,
      notes: `Cancelled ${before.cutOrderNumber}: ${reason}`,
    })
  }
  await tx.manufacturingOrder.update({ where: { id: before.moId }, data: { totalCutQty: { decrement: before.actualPieces } } })
  const after = await tx.cuttingOrder.update({
    where: { id },
    data: { status: 'CANCELLED', notes: [before.notes, `Cancelled: ${reason}`].filter(Boolean).join(' · ') },
  })
  if (cut) await syncProgress(tx, before.moId)
  return after
}
