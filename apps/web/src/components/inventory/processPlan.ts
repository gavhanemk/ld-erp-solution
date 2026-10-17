import { packCount } from '@/components/packages/packageTypes'

/**
 * What the store can do with a requisition, line by line: what is still owed,
 * what each store has free for it, what is short, and what is already with
 * Purchase. The Process window shows it; the "together" buttons on the
 * requisitions list act on it for several at once — one set of rules for both.
 */

export interface ProcessLine {
  id: string
  requestedQty: string | number
  issuedQty: string | number
  purpose: string | null
  /** The garment style it is for, as given on the requisition. */
  styleNo?: string | null
  ownership?: 'OWNED' | 'CUSTOMER_OWNED'
  ownerCustomer?: { id: string; name: string } | null
  item: {
    id: string
    code: string
    name: string
    uom: { symbol: string }
    category?: { name: string; parent: { name: string } | null } | null
  }
  warehouse: { id: string; name: string }
}

export interface FulfilOrder {
  poId: string
  poNumber: string
  poDate: string
  status?: string
  deliveryDate?: string | null
  supplierName?: string
  unitRate?: number
  qty: number
  receivedQty: number
  /** Each goods receipt against it: what came, what the gate refused, and what its quality check passed and rejected (null: not checked). */
  receipts?: Array<{ grnNumber: string; grnDate: string; qty: number; refused?: number; qc?: { passed: number; rejected: number } | null }>
}

/** GET /inventory/requisitions/:id/fulfil */
export interface FulfilData {
  lines: Array<{ id: string; requestedQty: number; issuedQty: number; purchaseQty: number | null; fulfilment: string }>
  bought: Array<{ lineId: string; buyQty: number; orderedQty: number; receivedQty: number; orders?: FulfilOrder[] }>
  stock: Array<{ itemId: string; warehouseId: string; warehouseName: string; ownership: string; ownerCustomerId: string | null; qty: number }>
  reservations?: Array<{ itemId: string; warehouseId: string; mrLineId: string; qty: number; mrNumber: string; customerName: string | null }>
  itemBuys?: Array<{
    itemId: string
    lastBuy: { poNumber: string; poDate: string; supplierName: string; unitRate: number } | null
    otherOpen: Array<{ poNumber: string; supplierName: string; qty: number; receivedQty: number; deliveryDate: string | null; forMr: string | null }>
  }>
  events: Array<{ at: string; who: string; action: string; handedOver: string[] | null; reservedNow?: string[] | null; plan: unknown; closeReason: string | null }>
  /** The stickered rolls and boxes of these items on the racks, store by store. */
  packs?: Array<{ itemId: string; warehouseId: string; ownership: string; ownerCustomerId: string | null; packType: string; n: number; qty: number; racks: string[] | null }>
}

export const r3 = (v: number) => Math.round(v * 1000) / 1000

/** One item's figures, the same on every tab. */
export function planRows<L extends ProcessLine>(lines: L[], data: FulfilData) {
  return lines.map((l) => {
    const f = data.lines.find((x) => x.id === l.id)
    const asked = Number(f?.requestedQty ?? l.requestedQty)
    const issued = Number(f?.issuedQty ?? l.issuedQty)
    const owed = r3(Math.max(0, asked - issued))
    const theirs = l.ownership === 'CUSTOMER_OWNED'
    const b = data.bought.find((x) => x.lineId === l.id)
    const by = new Map<string, { id: string; name: string; onHand: number; others: number; own: number; holders: string[] }>()
    for (const s of data.stock) {
      if (s.itemId !== l.item.id || s.qty <= 0) continue
      if (theirs ? s.ownership !== 'CUSTOMER_OWNED' || s.ownerCustomerId !== l.ownerCustomer?.id : s.ownership !== 'OWNED') continue
      const cur = by.get(s.warehouseId) ?? { id: s.warehouseId, name: s.warehouseName, onHand: 0, others: 0, own: 0, holders: [] }
      cur.onHand += s.qty
      by.set(s.warehouseId, cur)
    }
    if (!theirs)
      for (const h of data.reservations ?? []) {
        const cur = h.itemId === l.item.id ? by.get(h.warehouseId) : undefined
        if (!cur) continue
        if (h.mrLineId === l.id) cur.own += h.qty
        else {
          cur.others += h.qty
          cur.holders.push(`${fmtQty(h.qty)} for ${h.customerName ?? h.mrNumber}`)
        }
      }
    const stores = [...by.values()]
      .map((s) => {
        const p = data.packs?.find(
          (x) => x.itemId === l.item.id && x.warehouseId === s.id && (theirs ? x.ownerCustomerId === l.ownerCustomer?.id : x.ownership === 'OWNED'),
        )
        return {
          ...s,
          free: r3(Math.max(0, s.onHand - s.others)),
          racks: p?.racks ?? [],
          // "3 rolls" only when the rolls are all of the stock there; a rejected roll held apart would make it a wrong count.
          packs: p && Math.abs(p.qty - s.onHand) < 0.001 ? packCount(p.n, p.packType) : null,
        }
      })
      .sort((a, c) => c.own - a.own || (a.id === l.warehouse.id ? -1 : c.id === l.warehouse.id ? 1 : c.free - a.free))
    const buys = data.itemBuys?.find((x) => x.itemId === l.item.id)
    const cat = l.item.category
    return {
      l,
      unit: l.item.uom.symbol,
      category: cat ? (cat.parent ? `${cat.parent.name} › ${cat.name}` : cat.name) : null,
      asked,
      issued,
      owed,
      theirs,
      stores,
      free: r3(stores.reduce((t, s) => t + s.free, 0)),
      reserved: r3(stores.reduce((t, s) => t + s.own, 0)),
      onIndent: b?.buyQty ?? 0,
      ordered: b?.orderedQty ?? 0,
      received: b?.receivedQty ?? 0,
      orders: b?.orders ?? [],
      lastBuy: buys?.lastBuy ?? null,
      otherOpen: buys?.otherOpen ?? [],
    }
  })
}

export type PlanRow<L extends ProcessLine = ProcessLine> = ReturnType<typeof planRows<L>>[number]

const fmtQty = (v: number) => v.toLocaleString('en-IN', { maximumFractionDigits: 3 })

/** What the store cannot give of what is still owed. */
export const shortOf = (r: PlanRow) => r3(Math.max(0, r.owed - r.free))
/** Already on a PO for at least what is short: nothing more to buy. */
export const coveredByPo = (r: PlanRow) => r.ordered > 0 && r.owed > 0 && r.ordered + 1e-9 >= shortOf(r)
/** No indent box on the Buy tab: nothing owed, the customer's own, or a PO covers it. */
export const noBuyBox = (r: PlanRow) => r.owed <= 0 || r.theirs || coveredByPo(r)

/**
 * What each tab starts filled in with: issue what stock covers, the
 * reservation as it stands, and the indent as it stands (or what stock cannot
 * cover). Quantities as typed text, blank for nothing.
 */
export function startingQty(rows: PlanRow[], canIssue: boolean) {
  const issue: Record<string, string> = {}
  const reserve: Record<string, string> = {}
  const buy: Record<string, string> = {}
  for (const r of rows) {
    const onOrder = Math.max(0, r.ordered - r.received)
    const give = canIssue ? Math.max(0, Math.min(r.owed - onOrder, r.free)) : 0
    issue[r.l.id] = give > 0 ? String(r3(give)) : ''
    reserve[r.l.id] = r.reserved > 0 ? String(r.reserved) : ''
    // Only what is short, never below what is already on a PO. Where nothing
    // is to be bought the indent stays as it is, so pressing Save changes nothing there.
    const b = noBuyBox(r) ? r.onIndent : Math.max(shortOf(r), r.ordered)
    buy[r.l.id] = b > 0 ? String(r3(b)) : ''
  }
  return { issue, reserve, buy }
}

/** Spreads a quantity over the stores in the row's order, never past what each has free. */
export function spread(r: PlanRow, total: number) {
  const out = new Map<string, number>()
  let left = total
  for (const s of r.stores) {
    const t = Math.min(s.free, left)
    if (t > 0) {
      out.set(s.id, r3(t))
      left = r3(left - t)
    }
  }
  return out
}
