import { Prisma } from '@prisma/client'
import { AppError } from '../middleware/errorHandler'
import { samplingPilotEnabled } from '../lib/pilot'
import { lockRequests, requestPools } from './samplePool.service'
import {
  SAMPLE_OVER_REASON_MIN,
  sampleOrdered,
  sampleReceived,
  type SampleNeed,
  type SampleOrderLine,
} from '../../../../packages/shared/src/sampling'

/**
 * Buying for a sample (sampling phase 3).
 *
 * A purchase order line names the sample BOM line it buys for
 * (PurchaseOrderLine.sampleMaterialId), whether it was raised from Sampling or
 * picked off the sample needs on the order form. What a sample line has on
 * order and has received is always summed off those order lines and their
 * receipts, never kept as a counter, so a cancelled order or a cancelled
 * receipt gives its quantity back on its own.
 */

type Tx = Prisma.TransactionClient
const round3 = (v: number) => Math.round(v * 1000) / 1000

/** How an order line names the sample it buys for: "SMP-… · Body". */
export const sampleLineSelect = {
  id: true,
  component: true,
  colour: true,
  round: { select: { id: true, revision: true, request: { select: { id: true, number: true } } } },
} satisfies Prisma.SampleMaterialSelect

/**
 * The order lines that count: none on an order in the recycle bin, and of a
 * cancelled order only one that received something before it was called off
 * (sampleOrdered counts it for what arrived; that stock is in the sample
 * store). A cancelled order that received nothing bought nothing.
 */
export const liveSampleOrders = {
  po: { deletedAt: null },
  OR: [{ po: { status: { not: 'CANCELLED' } } }, { receivedQty: { gt: 0 } }],
} satisfies Prisma.PurchaseOrderLineWhereInput

/** An order line as Sampling and the order form read it: no rates, which Sampling does not show. */
export const sampleOrderSelect = {
  id: true,
  qty: true,
  receivedQty: true,
  shortClosed: true,
  po: {
    select: {
      id: true,
      poNumber: true,
      status: true,
      poDate: true,
      deliveryDate: true,
      supplier: { select: { name: true } },
    },
  },
} satisfies Prisma.PurchaseOrderLineSelect

export function sampleOrderLine(
  l: Prisma.PurchaseOrderLineGetPayload<{ select: typeof sampleOrderSelect }>
): SampleOrderLine {
  return {
    id: l.id,
    poId: l.po.id,
    poNumber: l.po.poNumber,
    status: l.po.status,
    supplierName: l.po.supplier.name,
    poDate: l.po.poDate,
    deliveryDate: l.po.deliveryDate,
    qty: Number(l.qty),
    receivedQty: Number(l.receivedQty),
    shortClosed: l.shortClosed,
    cancelled: l.po.status === 'CANCELLED',
  }
}

const sampleLabel = (m: { component: string; round: { revision: number; request: { number: string } } }) =>
  `${m.round.request.number}${m.component ? ` · ${m.component}` : ''}`

/**
 * Checks the order lines that buy for a sample, before an order is raised or
 * its lines are rebuilt. A linked line has to be:
 *
 *   - for the very material the sample line names (a substitute is a change
 *     to the sample's BOM, made in Sampling, not on an order);
 *   - for material we buy (what the buyer sends is never bought);
 *   - for a round released and still being made, of a request not cancelled;
 *   - on goods, not on a service order;
 *   - the only line of this order buying for that sample line.
 *
 * And ordering more than the sample line still needs, after every other live
 * order (a supplier's minimum, a full roll), needs a reason on the line. The
 * sample lines are locked first, so two orders raised at once cannot both
 * take what is left.
 *
 * Returns the reason each linked line keeps: the one typed while it orders
 * more than is needed, otherwise none, so a reason never outlives the excess.
 */
export async function assertSampleLines(
  tx: Tx,
  lines: Array<{
    sampleMaterialId?: string | null
    sampleOverReason?: string | null
    qty: number
    itemId: string
    mrLineId?: string | null
  }>,
  opts: {
    isService: boolean
    /** The order goes straight to a customer: a sample's material cannot. */
    toCustomer?: boolean
    exceptPoId?: string
    /**
     * Sample lines this order already bought for before the edit, with the
     * quantity it had for each. An order placed while the sample was open can
     * still have its rate or date put right after the round moves on or the
     * request is cancelled, but not order more; only a new link has to find
     * the round open.
     */
    alreadyLinked?: ReadonlyMap<string, number>
  }
): Promise<Map<string, string | null>> {
  const reasons = new Map<string, string | null>()
  const linked = lines.filter((l) => l.sampleMaterialId)
  if (!linked.length) return reasons
  if (!samplingPilotEnabled())
    throw new AppError(
      'Sampling is not switched on here, so an order line cannot buy for a sample. Take the sample off the line.',
      400,
      'SAMPLING_OFF'
    )
  if (opts.isService)
    throw new AppError(
      'A service order buys work, not material, so none of its lines can buy for a sample.',
      400,
      'SAMPLE_ON_SERVICE'
    )
  if (opts.toCustomer)
    throw new AppError(
      'This order goes straight to a customer, and a sample’s material has to come to our sample store. Deliver it to our own store, or order the sample lines separately.',
      400,
      'SAMPLE_TO_CUSTOMER'
    )
  // An indent's line is received into a general store and issued on its
  // requisition; a sample's into a sample store and issued by Sampling.
  if (linked.some((l) => l.mrLineId))
    throw new AppError(
      'A line cannot buy for an indent and a sample at once. Put the sample’s quantity on a line of its own.',
      400,
      'SAMPLE_AND_INDENT'
    )
  const ids = [...new Set(linked.map((l) => l.sampleMaterialId!))]
  if (ids.length !== linked.length)
    throw new AppError(
      'Two lines of this order buy for the same sample line. Put the whole quantity on one line.',
      400,
      'SAMPLE_LINE_TWICE'
    )
  // What is still to buy is worked out per request and item, so the requests
  // are locked (in id order, before their lines, as actOnSample takes them):
  // two orders raised at once for one sample cannot both take what is left.
  await lockRequests(
    tx,
    (
      await tx.sampleMaterial.findMany({
        where: { id: { in: ids } },
        select: { round: { select: { requestId: true } } },
      })
    ).map((r) => r.round.requestId)
  )
  await tx.$queryRaw`SELECT id FROM ld_erp.sample_materials WHERE id IN (${Prisma.join(ids)}) ORDER BY id FOR UPDATE`
  const rows = await tx.sampleMaterial.findMany({
    where: { id: { in: ids } },
    select: {
      id: true,
      itemId: true,
      source: true,
      plannedQty: true,
      issuedQty: true,
      component: true,
      item: { select: { name: true, uom: { select: { symbol: true } } } },
      round: {
        select: {
          state: true,
          revision: true,
          requestId: true,
          request: { select: { number: true, cancelledAt: true } },
        },
      },
    },
  })
  const groups: Array<{ l: (typeof linked)[number]; m: (typeof rows)[number]; existing: boolean }> = []
  for (const l of linked) {
    const m = rows.find((r) => r.id === l.sampleMaterialId)
    if (!m)
      throw new AppError(
        'One of the sample lines this order buys for no longer exists. Pick it again from the sample needs.',
        400,
        'BAD_SAMPLE_LINE'
      )
    const label = sampleLabel(m)
    const name = m.item?.name ?? 'its material'
    const unit = m.item?.uom?.symbol ?? ''
    if (m.itemId !== l.itemId)
      throw new AppError(
        `${label} needs ${name}, not the item on this line. Change the sample's material in Sampling, or take the sample off this line.`,
        400,
        'SAMPLE_WRONG_ITEM'
      )
    if (m.source !== 'PURCHASE')
      throw new AppError(`${label}: the buyer sends ${name}, so it is never bought.`, 400, 'SAMPLE_BUYER_SENDS')
    const existing = opts.alreadyLinked?.has(m.id) ?? false
    const closed = !!m.round.request.cancelledAt || m.round.state !== 'RELEASED'
    // Kept on an order placed while the sample was open, but no more of it.
    if (existing && closed && round3(l.qty) > round3(opts.alreadyLinked!.get(m.id)!) + 1e-9)
      throw new AppError(
        `${m.round.request.number} is ${m.round.request.cancelledAt ? 'cancelled' : 'past making'}, so this order can keep the ${round3(opts.alreadyLinked!.get(m.id)!)} ${unit} of ${name} it had for it, but not order more.`,
        409,
        'SAMPLE_NOT_OPEN'
      )
    if (!existing && m.round.request.cancelledAt)
      throw new AppError(`${m.round.request.number} is cancelled, so nothing is bought for it.`, 409, 'SAMPLE_NOT_OPEN')
    if (!existing && m.round.state !== 'RELEASED')
      throw new AppError(
        m.round.state === 'DRAFT'
          ? `Round ${m.round.revision} of ${m.round.request.number} is not released yet. Its material is bought once the specification is released.`
          : `Round ${m.round.revision} of ${m.round.request.number} is past making, so nothing more is bought for it.`,
        409,
        'SAMPLE_NOT_OPEN'
      )
    groups.push({ l, m, existing: existing && closed })
  }
  // What each sample still has to buy of each item after what it holds and
  // what its other orders will bring (samplePool), the same figure its needs
  // show. An order may buy that much without a word; more needs a reason on
  // each of its lines for that item. A line kept on an order whose sample has
  // closed cannot grow (above), so it is not asked again.
  const pools = await requestPools(
    tx,
    groups.map((g) => g.m.round.requestId),
    { exceptPoId: opts.exceptPoId }
  )
  const byItem = new Map<string, typeof groups>()
  for (const g of groups) {
    if (g.existing) {
      reasons.set(g.m.id, g.l.sampleOverReason?.trim() || null)
      continue
    }
    const key = `${g.m.round.requestId}|${g.m.itemId}`
    byItem.set(key, [...(byItem.get(key) ?? []), g])
  }
  for (const [key, group] of byItem) {
    const [requestId, itemId] = key.split('|')
    const open = round3(pools.get(requestId)?.toBuyByItem[itemId] ?? 0)
    const total = round3(group.reduce((t, g) => t + g.l.qty, 0))
    const over = total > open + 1e-9
    const { m } = group[0]
    const name = m.item?.name ?? 'its material'
    const unit = m.item?.uom?.symbol ?? ''
    for (const g of group) {
      const reason = g.l.sampleOverReason?.trim() ?? ''
      if (over && reason.length < SAMPLE_OVER_REASON_MIN)
        throw new AppError(
          open > 0
            ? `${name}: ${total} ${unit} ordered for ${m.round.request.number}, which still needs ${open} ${unit} after what it holds and has on order. Say why more is ordered (the supplier's minimum, a full roll), or order ${open} ${unit}.`
            : `${name} for ${m.round.request.number} is covered by what it holds and has on order. Say why more is ordered (the supplier's minimum, a full roll), or take the sample off this line.`,
          400,
          'SAMPLE_OVER_ORDER'
        )
      reasons.set(g.m.id, over ? reason : null)
    }
  }
  return reasons
}

/**
 * A receipt's lines and the stores they go into: material bought for a sample
 * into a sample store, and nothing else into one. Ordinary goods booked into
 * a sample store would be issued to samples; a sample's material booked into
 * a general store would be drawn by production.
 */
export async function assertGrnSampleStores(
  tx: Tx,
  prepared: Array<{ warehouseId: string; poLine: { sampleMaterialId?: string | null; item: { name: string } } }>
) {
  const ids = [...new Set(prepared.map((p) => p.warehouseId))]
  const stores = new Map(
    (
      await tx.warehouse.findMany({ where: { id: { in: ids } }, select: { id: true, name: true, purpose: true } })
    ).map((w) => [w.id, w])
  )
  for (const p of prepared) {
    const store = stores.get(p.warehouseId)
    if (!store) continue
    if (p.poLine.sampleMaterialId && store.purpose !== 'SAMPLING')
      throw new AppError(
        `${p.poLine.item.name} is bought for a sample. Receive it into a sample store, not ${store.name}, so it is kept for that sample.`,
        409,
        'SAMPLE_GOODS_TO_SAMPLE_STORE'
      )
    if (!p.poLine.sampleMaterialId && store.purpose === 'SAMPLING')
      throw new AppError(
        `${store.name} is a sample store: only material bought for a sample is received there. Receive ${p.poLine.item.name} into a general store.`,
        409,
        'SAMPLE_STORE'
      )
  }
}

/**
 * What samples need bought: every bought line of every released round still
 * being made, of a request not cancelled, with the orders against it and what
 * has arrived. `includeDone` keeps lines already on order in full.
 */
export async function sampleNeeds(
  tx: Tx,
  f: { requestId?: string; q?: string; includeDone?: boolean } = {}
): Promise<SampleNeed[]> {
  const q = f.q?.trim() ?? ''
  const like = { contains: q, mode: 'insensitive' as const }
  const rows = await tx.sampleMaterial.findMany({
    where: {
      source: 'PURCHASE',
      itemId: { not: null },
      round: {
        state: 'RELEASED',
        request: { cancelledAt: null, ...(f.requestId ? { id: f.requestId } : {}) },
      },
      ...(q
        ? {
            OR: [
              { component: like },
              { item: { name: like } },
              { item: { code: like } },
              { round: { request: { number: like } } },
              { round: { request: { title: like } } },
              { round: { request: { buyerStyleRef: like } } },
              { round: { request: { customer: { name: like } } } },
              { round: { request: { style: { code: like } } } },
            ],
          }
        : {}),
    },
    include: {
      item: {
        select: {
          id: true,
          code: true,
          name: true,
          hsnCode: true,
          categoryId: true,
          uom: { select: { symbol: true } },
          taxRate: { select: { id: true, rate: true } },
        },
      },
      round: {
        select: {
          id: true,
          revision: true,
          request: {
            select: {
              id: true,
              number: true,
              title: true,
              requiredAt: true,
              buyerStyleRef: true,
              customer: { select: { name: true } },
              style: { select: { id: true, code: true } },
            },
          },
        },
      },
      poLines: { where: liveSampleOrders, select: sampleOrderSelect, orderBy: { po: { poDate: 'asc' } } },
    },
    // Every open line: only released rounds of open requests are read, and a
    // cap here would drop lines still to buy behind ones already on order.
    orderBy: [{ round: { request: { number: 'asc' } } }, { sequence: 'asc' }, { id: 'asc' }],
  })
  // What each still has to buy, after what it holds and has on order (samplePool).
  const pools = await requestPools(tx, rows.map((m) => m.round.request.id))
  return rows
    .map((m): SampleNeed => {
      const orders = m.poLines.map(sampleOrderLine)
      const requiredQty = Number(m.plannedQty)
      const orderedQty = sampleOrdered(orders)
      const request = m.round.request
      return {
        sampleMaterialId: m.id,
        requestId: request.id,
        requestNumber: request.number,
        title: request.title,
        customerName: request.customer?.name ?? null,
        buyerStyleRef: request.buyerStyleRef ?? null,
        style: request.style,
        requiredAt: request.requiredAt,
        roundId: m.round.id,
        revision: m.round.revision,
        component: m.component,
        colour: m.colour,
        item: {
          ...m.item!,
          taxRate: m.item!.taxRate ? { id: m.item!.taxRate.id, rate: Number(m.item!.taxRate.rate) } : null,
        },
        requiredQty,
        orderedQty,
        receivedQty: sampleReceived(orders),
        toBuy: pools.get(request.id)?.lines[m.id]?.toBuy ?? 0,
        estRate: m.estRate === null ? null : Number(m.estRate),
        orders,
      }
    })
    .filter((n) => f.includeDone || n.toBuy > 0)
}

/**
 * Reopening a sample order line closed short counts its whole quantity as
 * ordered again, where closing it had counted only what arrived. Checked as an
 * order for that quantity would be: the sample still open, and no more than it
 * still needs after every other order. Reopening takes no reason, so more than
 * that is refused; what is still missing is ordered afresh instead.
 */
export async function assertSampleReopen(
  tx: Tx,
  line: { sampleMaterialId: string | null; qty: Prisma.Decimal | number; receivedQty: Prisma.Decimal | number }
) {
  if (!line.sampleMaterialId) return
  const m = await tx.sampleMaterial.findUnique({
    where: { id: line.sampleMaterialId },
    select: {
      itemId: true,
      component: true,
      item: { select: { name: true, uom: { select: { symbol: true } } } },
      round: {
        select: { state: true, revision: true, requestId: true, request: { select: { number: true, cancelledAt: true } } },
      },
    },
  })
  if (!m || !m.itemId) return
  await lockRequests(tx, [m.round.requestId])
  const label = sampleLabel(m)
  if (m.round.request.cancelledAt || m.round.state !== 'RELEASED')
    throw new AppError(
      `${label} is ${m.round.request.cancelledAt ? 'cancelled' : 'past making'}, so this line stays closed: nothing more is bought for it.`,
      409,
      'SAMPLE_NOT_OPEN'
    )
  // While closed it counts only what came, so the pool already holds that and
  // its balance is not awaited: reopening asks for the balance on top.
  const pool = (await requestPools(tx, [m.round.requestId])).get(m.round.requestId)
  const open = round3(pool?.toBuyByItem[m.itemId] ?? 0)
  const more = round3(Math.max(0, Number(line.qty) - Number(line.receivedQty)))
  if (more > open + 1e-9) {
    const unit = m.item?.uom?.symbol ?? ''
    throw new AppError(
      `${label} still needs ${open} ${unit} after what it holds and has on order, and reopening this line would wait for ${more} ${unit} more. Leave it closed, and order what is still missing on a new line.`,
      409,
      'SAMPLE_OVER_ORDER'
    )
  }
}

/**
 * A return to the supplier, or a supplier's note that moves goods, keeps a
 * sample's material where it lives: a line traced to a sample order (through
 * its receipt or its bill) moves in a sample store, and nothing else does.
 * Otherwise a return against an ordinary bill could take a sample's material
 * off the sample store's shelf, and a note's replacement goods could put bulk
 * stock into it.
 */
export async function assertSampleStoreLines(
  tx: Tx,
  lines: Array<{ warehouseId: string | null; grnLineId?: string | null; billLineId?: string | null; itemName: string }>
) {
  const moving = lines.filter((l): l is typeof l & { warehouseId: string } => !!l.warehouseId)
  if (!moving.length) return
  const stores = new Map(
    (
      await tx.warehouse.findMany({
        where: { id: { in: [...new Set(moving.map((l) => l.warehouseId))] } },
        select: { id: true, name: true, purpose: true },
      })
    ).map((w) => [w.id, w])
  )
  const billLines = new Map(
    (
      await tx.purchaseInvoiceLine.findMany({
        where: { id: { in: moving.map((l) => l.billLineId).filter((id): id is string => !!id) } },
        select: { id: true, grnLineId: true, poLine: { select: { sampleMaterialId: true } } },
      })
    ).map((b) => [b.id, b])
  )
  const grnLineIds = [
    ...moving.map((l) => l.grnLineId),
    ...[...billLines.values()].map((b) => b.grnLineId),
  ].filter((id): id is string => !!id)
  const grnLines = new Map(
    (
      await tx.gRNLine.findMany({
        where: { id: { in: grnLineIds } },
        select: { id: true, poLine: { select: { sampleMaterialId: true } } },
      })
    ).map((g) => [g.id, g])
  )
  for (const l of moving) {
    const store = stores.get(l.warehouseId)
    if (!store) continue
    const bill = l.billLineId ? billLines.get(l.billLineId) : undefined
    const grnLineId = l.grnLineId ?? bill?.grnLineId ?? null
    const forSample = !!(
      (grnLineId ? grnLines.get(grnLineId)?.poLine?.sampleMaterialId : null) ?? bill?.poLine?.sampleMaterialId
    )
    if (store.purpose === 'SAMPLING' && !forSample)
      throw new AppError(
        `${store.name} is a sample store: only material bought for a sample moves there. ${l.itemName} was not bought for one; use a general store.`,
        409,
        'SAMPLE_STORE'
      )
    if (store.purpose !== 'SAMPLING' && forSample)
      throw new AppError(
        `${l.itemName} was bought for a sample and is kept in a sample store. Use that store, not ${store.name}.`,
        409,
        'SAMPLE_GOODS_TO_SAMPLE_STORE'
      )
  }
}
