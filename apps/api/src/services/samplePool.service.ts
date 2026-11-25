import { Prisma } from '@prisma/client'
import { AppError } from '../middleware/errorHandler'
import { readQc } from './grnQc.service'
import { REASON_RULES } from './purchaseNote.service'
import type { SampleLineCover, SamplePool, SamplePoolStore } from '../../../../packages/shared/src/sampling'

/**
 * A sample request's own material in the sample stores (sampling phase 4).
 *
 * Sample stores are shared by every request, so the stock ledger alone cannot
 * say whose a metre is. A request's share of an item in a store is worked out
 * from its documents instead, every time, never kept as a counter:
 *
 *   what its receipts put there — each receipt line on an order line that
 *   buys for one of its sample lines, in a sample store —
 *     less what a quality check took out of good stock (moved to a reject
 *       godown, or held there as rejected and not used after all),
 *     less what went back to the supplier from that store other than goods
 *       the check was already holding as rejected,
 *     less or plus what a posted supplier note moved (a note raised from a
 *       return challan moves nothing of its own),
 *   less what its lines issued from that store, net of returns,
 *   less what was closed out (used up in the sample, or moved to a general
 *   store).
 *
 * That is what the request may issue from that store ("available"). The
 * latest round, while it is being made, then claims it line by line, in the
 * order the lines are listed: each line's still-to-issue quantity is covered
 * first from the pool, then from what its orders still have to bring, and the
 * rest is what is still to buy. So material left over from an earlier round
 * serves the next, and goods rejected or sent back show up as still to buy.
 */

type Tx = Prisma.TransactionClient
const r3 = (v: number) => Math.round(v * 1000) / 1000
const n = (v: unknown) => Number(v ?? 0)
const round3n = r3

export async function requestPools(
  tx: Tx,
  requestIds: string[],
  /** Leave this order out of what is still to arrive: it is the one being checked. */
  opts: { exceptPoId?: string } = {}
): Promise<Map<string, SamplePool>> {
  const ids = [...new Set(requestIds)]
  const out = new Map<string, SamplePool>()
  if (!ids.length) return out
  const [materials, closeOuts, requests] = await Promise.all([
    tx.sampleMaterial.findMany({
      where: { round: { requestId: { in: ids } } },
      select: {
        id: true,
        itemId: true,
        source: true,
        plannedQty: true,
        issuedQty: true,
        returnedQty: true,
        warehouseId: true,
        waivedAt: true,
        round: { select: { id: true, requestId: true, state: true, revision: true } },
      },
      orderBy: [{ sequence: 'asc' }, { id: 'asc' }],
    }),
    tx.sampleCloseOut.findMany({
      where: { requestId: { in: ids } },
      select: { requestId: true, itemId: true, warehouseId: true, qty: true },
    }),
    tx.sampleRequest.findMany({
      where: { id: { in: ids } },
      select: {
        id: true,
        customerId: true,
        cancelledAt: true,
        rounds: { orderBy: { revision: 'desc' }, take: 1, select: { id: true, state: true } },
      },
    }),
  ])
  const lineOf = new Map(materials.map((m) => [m.id, m]))
  // Every order line that ever bought for these lines (not one in the bin):
  // receipts count whatever became of the order; only live ones are awaited.
  const poLines = materials.length
    ? await tx.purchaseOrderLine.findMany({
        where: { sampleMaterialId: { in: materials.map((m) => m.id) }, po: { deletedAt: null } },
        select: {
          id: true,
          poId: true,
          sampleMaterialId: true,
          qty: true,
          receivedQty: true,
          shortClosed: true,
          po: { select: { status: true } },
        },
      })
    : []
  const poLineOf = new Map(poLines.map((p) => [p.id, p]))
  const grnLines = poLines.length
    ? await tx.gRNLine.findMany({
        where: { poLineId: { in: poLines.map((p) => p.id) }, grn: { status: { not: 'CANCELLED' } } },
        select: {
          id: true,
          grnId: true,
          poLineId: true,
          itemId: true,
          warehouseId: true,
          acceptedQty: true,
          warehouse: { select: { purpose: true } },
        },
      })
    : []
  const grnLineIds = grnLines.map((g) => g.id)
  const [checks, returns, notes] = grnLineIds.length
    ? await Promise.all([
        tx.inwardQC.findMany({
          where: { grnId: { in: [...new Set(grnLines.map((g) => g.grnId))] } },
          select: { checklistData: true },
        }),
        tx.purchaseReturnLine.findMany({
          where: { purchaseReturn: { status: { not: 'CANCELLED' } }, billLine: { grnLineId: { in: grnLineIds } } },
          select: { qty: true, warehouseId: true, billLine: { select: { grnLineId: true } } },
        }),
        tx.purchaseNoteLine.findMany({
          where: {
            note: { status: 'POSTED', returnId: null, warehouseId: { not: null } },
            OR: [{ grnLineId: { in: grnLineIds } }, { billLine: { grnLineId: { in: grnLineIds } } }],
          },
          select: {
            qty: true,
            grnLineId: true,
            billLine: { select: { grnLineId: true } },
            note: { select: { warehouseId: true, effect: true, reason: true } },
          },
        }),
      ])
    : [[], [], []]

  // What a live check took out of good stock on each receipt line, and what
  // of its held rejects has gone back to the supplier since.
  const qcOut = new Map<string, number>()
  const heldReturned = new Map<string, number>()
  const wanted = new Map(grnLines.map((g) => [g.id, g]))
  for (const c of checks) {
    const d = readQc(c.checklistData)
    if (!d || d.cancelled) continue
    for (const l of d.lines) {
      const g = wanted.get(l.grnLineId)
      if (!g || l.warehouseId !== g.warehouseId || !(l.rejectedQty > 0)) continue
      const took =
        d.hold === 'SAME_STORE'
          ? l.rejectedQty - (l.usedQty ?? 0)
          : d.rejectWarehouseId
            ? l.rejectedQty
            : 0
      qcOut.set(g.id, r3((qcOut.get(g.id) ?? 0) + took))
      if (d.hold === 'SAME_STORE')
        heldReturned.set(g.id, r3((heldReturned.get(g.id) ?? 0) + (l.returnedQty ?? 0)))
    }
  }
  const returned = new Map<string, number>()
  for (const r of returns) {
    const g = r.billLine.grnLineId ? wanted.get(r.billLine.grnLineId) : undefined
    if (!g || r.warehouseId !== g.warehouseId) continue
    returned.set(g.id, r3((returned.get(g.id) ?? 0) + n(r.qty)))
  }
  const noted = new Map<string, number>()
  for (const l of notes) {
    const g = wanted.get(l.grnLineId ?? l.billLine?.grnLineId ?? '')
    if (!g || l.note.warehouseId !== g.warehouseId || !REASON_RULES[l.note.reason]?.movesGoods) continue
    const sign = l.note.effect === 'REDUCES_PAYABLE' ? -1 : 1
    noted.set(g.id, r3((noted.get(g.id) ?? 0) + sign * n(l.qty)))
  }

  // The stores the request's lines issued from, to tell sample stores apart.
  const issueStores = [...new Set(materials.map((m) => m.warehouseId).filter((w): w is string => !!w))]
  const sampleStores = new Set(
    (
      await tx.warehouse.findMany({
        where: { id: { in: issueStores }, purpose: 'SAMPLING' },
        select: { id: true },
      })
    ).map((w) => w.id)
  )

  const stores = new Map<string, SamplePoolStore & { requestId: string }>()
  const storeOf = (requestId: string, itemId: string, warehouseId: string) => {
    const key = `${requestId}|${itemId}|${warehouseId}`
    let s = stores.get(key)
    if (!s) {
      s = { requestId, itemId, warehouseId, received: 0, issued: 0, closed: 0, available: 0 }
      stores.set(key, s)
    }
    return s
  }
  for (const g of grnLines) {
    if (g.warehouse.purpose !== 'SAMPLING') continue
    const line = lineOf.get(poLineOf.get(g.poLineId ?? '')?.sampleMaterialId ?? '')
    if (!line) continue
    const back = Math.max(0, (returned.get(g.id) ?? 0) - (heldReturned.get(g.id) ?? 0))
    const s = storeOf(line.round.requestId, g.itemId, g.warehouseId)
    s.received = r3(s.received + n(g.acceptedQty) - (qcOut.get(g.id) ?? 0) - back + (noted.get(g.id) ?? 0))
  }
  for (const m of materials) {
    if (m.source !== 'PURCHASE' || !m.itemId || !m.warehouseId || !sampleStores.has(m.warehouseId)) continue
    const s = storeOf(m.round.requestId, m.itemId, m.warehouseId)
    s.issued = r3(s.issued + n(m.issuedQty) - n(m.returnedQty))
  }
  for (const c of closeOuts) {
    const s = storeOf(c.requestId, c.itemId, c.warehouseId)
    s.closed = r3(s.closed + n(c.qty))
  }
  for (const s of stores.values()) s.available = r3(Math.max(0, s.received - s.issued - s.closed))

  // The buyer's own stock of each item in the sample stores, for material they send.
  const buyerItems = [
    ...new Set(materials.filter((m) => m.source === 'BUYER_SUPPLIED' && m.itemId).map((m) => m.itemId!)),
  ]
  const buyers = [...new Set(requests.map((r) => r.customerId).filter((c): c is string => !!c))]
  const buyerRows =
    buyerItems.length && buyers.length
      ? await tx.stockLedger.groupBy({
          by: ['itemId', 'ownerCustomerId', 'warehouseId'],
          where: {
            ownership: 'CUSTOMER_OWNED',
            grade: 'A',
            itemId: { in: buyerItems },
            ownerCustomerId: { in: buyers },
            warehouse: { purpose: 'SAMPLING' },
          },
          _sum: { inQty: true, outQty: true },
        })
      : []

  for (const req of requests) {
    const latest = req.rounds[0]
    // A cancelled request needs nothing more, whatever state its round was left in.
    const current = latest?.state === 'RELEASED' && !req.cancelledAt ? latest.id : null
    const mine = [...stores.values()].filter((s) => s.requestId === req.id)
    const lines: Record<string, SampleLineCover> = {}
    const buyerStock: Record<string, number> = {}
    const buyerStores: SamplePool['buyerStores'] = []
    const toBuyByItem: Record<string, number> = {}
    for (const row of buyerRows) {
      if (row.ownerCustomerId !== req.customerId) continue
      const qty = r3(Math.max(0, n(row._sum.inQty) - n(row._sum.outQty)))
      if (!(qty > 0)) continue
      buyerStores.push({ itemId: row.itemId, warehouseId: row.warehouseId, available: qty })
      buyerStock[row.itemId] = r3((buyerStock[row.itemId] ?? 0) + qty)
    }
    // What the pool and the orders still to arrive can give each item, store
    // by store: a line tied to a store by its first issue takes only what is
    // there (MATERIAL issues a line from its one store); any other line, from
    // whichever sample store has it.
    const poolLeft = new Map<string, number>()
    for (const s of mine) poolLeft.set(`${s.itemId}|${s.warehouseId}`, s.available)
    const buyerLeft = new Map(buyerStores.map((b) => [`${b.itemId}|${b.warehouseId}`, b.available]))
    const take = (left: Map<string, number>, itemId: string, store: string | null, want: number) => {
      let got = 0
      for (const [key, have] of left) {
        const [item, at] = key.split('|')
        if (item !== itemId || (store && at !== store) || !(have > 0) || got >= want) continue
        const t = r3(Math.min(have, want - got))
        left.set(key, r3(have - t))
        got = r3(got + t)
      }
      return got
    }
    const comingLeft = new Map<string, number>()
    for (const p of poLines) {
      const line = lineOf.get(p.sampleMaterialId ?? '')
      if (!line || line.round.requestId !== req.id || !line.itemId) continue
      if (p.shortClosed || p.po.status === 'CANCELLED' || p.poId === opts.exceptPoId) continue
      comingLeft.set(line.itemId, r3((comingLeft.get(line.itemId) ?? 0) + Math.max(0, n(p.qty) - n(p.receivedQty))))
    }
    for (const m of materials) {
      if (m.round.requestId !== req.id) continue
      const remaining =
        m.round.id === current && m.itemId && !m.waivedAt
          ? r3(Math.max(0, n(m.plannedQty) - (n(m.issuedQty) - n(m.returnedQty))))
          : 0
      const cover: SampleLineCover = { remaining, fromPool: 0, awaited: 0, toBuy: 0 }
      if (remaining > 0 && m.itemId) {
        // A line tied to a general store (issued before sample stores) draws
        // nothing from the pool: it is issued no more from there.
        const tied = m.warehouseId && sampleStores.has(m.warehouseId) ? m.warehouseId : null
        const offPool = !!m.warehouseId && !tied && round3n(n(m.issuedQty) - n(m.returnedQty)) > 0
        if (m.source === 'BUYER_SUPPLIED') {
          cover.fromPool = offPool ? 0 : take(buyerLeft, m.itemId, tied, remaining)
        } else {
          cover.fromPool = offPool ? 0 : take(poolLeft, m.itemId, tied, remaining)
          cover.awaited = r3(Math.min(remaining - cover.fromPool, comingLeft.get(m.itemId) ?? 0))
          comingLeft.set(m.itemId, r3((comingLeft.get(m.itemId) ?? 0) - cover.awaited))
          cover.toBuy = r3(remaining - cover.fromPool - cover.awaited)
        }
      }
      lines[m.id] = cover
      if (cover.toBuy > 0 && m.itemId) toBuyByItem[m.itemId] = r3((toBuyByItem[m.itemId] ?? 0) + cover.toBuy)
    }
    out.set(req.id, {
      stores: mine
        .filter((s) => s.received || s.issued || s.closed)
        .map(({ requestId: _r, ...s }) => s),
      lines,
      buyerStock,
      buyerStores,
      toBuyByItem,
    })
  }
  return out
}

/** One request's pool. */
export async function requestPool(tx: Tx, requestId: string, opts: { exceptPoId?: string } = {}) {
  return (await requestPools(tx, [requestId], opts)).get(requestId)!
}

/** What a request may still issue of an item from one sample store. */
export const availableIn = (pool: SamplePool, itemId: string, warehouseId: string) =>
  pool.stores.find((s) => s.itemId === itemId && s.warehouseId === warehouseId)?.available ?? 0

// ── Keeping one sample's material from another ───────────────────────────────
//
// Sampling issues and closes out only what a request holds (above). But a
// receipt can also be corrected, cancelled or deleted, its goods rejected on a
// quality check, sent back to the supplier, or written off on a supplier note,
// after the request has issued them. In a shared sample store the stock
// ledger would let that through on another request's goods. Every such
// document locks the requests whose receipts it touches (as actOnSample does,
// so their issues wait) and, once written, checks that none of them has
// issued or closed out more than it now holds.

/** The sample requests whose material these receipt lines brought in. */
export async function requestsOfGrnLines(tx: Tx, grnLineIds: string[]): Promise<string[]> {
  if (!grnLineIds.length) return []
  const rows = await tx.gRNLine.findMany({
    where: { id: { in: grnLineIds }, poLine: { sampleMaterialId: { not: null } } },
    select: { poLine: { select: { sampleMaterial: { select: { round: { select: { requestId: true } } } } } } },
  })
  return [...new Set(rows.map((r) => r.poLine?.sampleMaterial?.round.requestId).filter((x): x is string => !!x))]
}
/** The same, from bill lines (a return or a note raised against the bill). */
export async function requestsOfBillLines(tx: Tx, billLineIds: string[]): Promise<string[]> {
  if (!billLineIds.length) return []
  const rows = await tx.purchaseInvoiceLine.findMany({
    where: { id: { in: billLineIds } },
    select: { grnLineId: true },
  })
  return requestsOfGrnLines(
    tx,
    rows.map((r) => r.grnLineId).filter((x): x is string => !!x)
  )
}
/** Locks the requests, in id order, the way actOnSample takes each one. */
export async function lockRequests(tx: Tx, requestIds: string[]) {
  const ids = [...new Set(requestIds)].sort()
  if (!ids.length) return
  await tx.$queryRaw`SELECT id FROM ld_erp.sample_requests WHERE id IN (${Prisma.join(ids)}) ORDER BY id FOR UPDATE`
}
/**
 * After a document took material out of a sample store: refuses it if any of
 * these requests has now issued or closed out more of an item, there, than
 * its receipts leave it holding — the difference would be another sample's.
 */
export async function assertPoolsHold(tx: Tx, requestIds: string[], what: string) {
  if (!requestIds.length) return
  const pools = await requestPools(tx, requestIds)
  for (const [requestId, pool] of pools) {
    for (const s of pool.stores) {
      const over = r3(s.issued + s.closed - s.received)
      if (over <= 0.0005) continue
      const [request, item, store] = await Promise.all([
        tx.sampleRequest.findUnique({ where: { id: requestId }, select: { number: true } }),
        tx.item.findUnique({ where: { id: s.itemId }, select: { name: true, uom: { select: { symbol: true } } } }),
        tx.warehouse.findUnique({ where: { id: s.warehouseId }, select: { name: true } }),
      ])
      const unit = item?.uom?.symbol ?? ''
      throw new AppError(
        `${what} would take ${over} ${unit} of ${item?.name ?? 'material'} that ${request?.number ?? 'a sample'} has already issued or closed out from ${store?.name ?? 'the sample store'}: what is left there is another sample's. Return it from the sample in Sampling first, or take ${over} ${unit} less.`,
        409,
        'SAMPLE_MATERIAL_USED'
      )
    }
  }
}
