import type { Panel, ReportDefinition } from '../types'
import { round2 } from './shared'
import { asOnEnd, asOnFilter, asOnLabel, bucketOf, daysBetween } from './inventory-shared'

const r3 = (n: number) => Math.round(n * 1000) / 1000

/**
 * Customers' own material: what they sent, what we used, what we sent back,
 * and what we still hold for them.
 *
 * Their cloth is not our money, but it is our responsibility. A customer
 * asking "how much of my fabric do you have?" gets this, and material held
 * for months against an order that never came is something to send back.
 */
export const customerMaterialStock: ReportDefinition = {
  id: 'customer-material-stock',
  module: 'inventory',
  title: 'Customer Material',
  description:
    "Each customer's own material, item by item — received, rejected at the gate, used in production, returned, and still held — with how long it has been with us.",
  filters: [asOnFilter, { key: 'customerId', label: 'Customer', type: 'select', optionsFrom: 'customers' }],
  columns: [
    { key: 'customer', label: 'Customer', type: 'text', width: 26 },
    { key: 'itemCode', label: 'Item Code', type: 'text', width: 16 },
    { key: 'item', label: 'Item', type: 'text', width: 30 },
    { key: 'uom', label: 'UOM', type: 'text', width: 8 },
    { key: 'received', label: 'Received', type: 'qty', total: 'sum' },
    { key: 'rejected', label: 'Rejected at Gate', type: 'qty', total: 'sum' },
    { key: 'used', label: 'Used', type: 'qty', total: 'sum' },
    { key: 'returned', label: 'Returned', type: 'qty', total: 'sum' },
    { key: 'other', label: 'Other (+/−)', type: 'qty', total: 'sum' },
    { key: 'held', label: 'Held Now', type: 'qty', total: 'sum' },
    { key: 'usedShare', label: 'Used %', type: 'percent', total: 'none' },
    { key: 'firstIn', label: 'First Received', type: 'date', width: 14 },
    { key: 'lastMoved', label: 'Last Movement', type: 'date', width: 14 },
    { key: 'daysHeld', label: 'Days Held', type: 'integer', total: 'none' },
  ],
  summary: {
    title: 'Material held longest',
    columns: ['customer', 'item', 'held', 'uom', 'daysHeld'],
    by: 'daysHeld',
    limit: 12,
  },
  pivot: {
    rows: ['customer', 'item'],
    values: ['received', 'used', 'returned', 'held'],
    note: 'Open a customer to see each item of theirs. Quantities add up per item only.',
  },

  async run({ tx, params, rowCap }) {
    const end = asOnEnd(params)
    const entries = await tx.stockLedger.findMany({
      where: {
        ownership: 'CUSTOMER_OWNED',
        transactionDate: { lte: end },
        ...(params.customerId ? { ownerCustomerId: params.customerId } : {}),
      },
      select: {
        itemId: true,
        ownerCustomerId: true,
        transactionType: true,
        referenceType: true,
        inQty: true,
        outQty: true,
        transactionDate: true,
        item: { select: { code: true, name: true, uom: { select: { symbol: true } } } },
        ownerCustomer: { select: { name: true } },
      },
    })
    // Rejected at the gate is kept on the receipt line, not as a movement:
    // rejected material still goes into stock, flagged.
    const rejectLines = await tx.customerGRNLine.findMany({
      where: {
        grn: { cancelledAt: null, receiptDate: { lte: end }, ...(params.customerId ? { customerId: params.customerId } : {}) },
        rejectedQty: { gt: 0 },
      },
      select: { itemId: true, rejectedQty: true, grn: { select: { customerId: true } } },
    })
    const rejected = new Map<string, number>()
    for (const r of rejectLines) {
      const k = `${r.grn.customerId}|${r.itemId}`
      rejected.set(k, (rejected.get(k) ?? 0) + Number(r.rejectedQty))
    }

    const now = new Date()
    const byKey = new Map<
      string,
      { customer: string; itemCode: string; item: string; uom: string; received: number; used: number; returned: number; other: number; held: number; firstIn: Date | null; lastMoved: Date }
    >()
    for (const e of entries) {
      const key = `${e.ownerCustomerId}|${e.itemId}`
      let r = byKey.get(key)
      if (!r) {
        r = { customer: e.ownerCustomer?.name ?? 'Unknown', itemCode: e.item.code, item: e.item.name, uom: e.item.uom?.symbol ?? '', received: 0, used: 0, returned: 0, other: 0, held: 0, firstIn: null, lastMoved: e.transactionDate }
        byKey.set(key, r)
      }
      const net = Number(e.inQty) - Number(e.outQty)
      const b = bucketOf(e.transactionType, e.referenceType)
      r.held += net
      if (e.referenceType?.startsWith('CUSTOMER_RETURN')) r.returned += -net
      else if (b === 'customer' || b === 'opening') r.received += net
      else if (b === 'issue') r.used += -net
      // Moves between our own stores leave what we hold unchanged.
      else if (b !== 'transfer') r.other += net
      if (Number(e.inQty) > 0 && (!r.firstIn || e.transactionDate < r.firstIn)) r.firstIn = e.transactionDate
      if (e.transactionDate > r.lastMoved) r.lastMoved = e.transactionDate
    }

    const all = [...byKey.entries()]
      .map(([key, r]) => ({
        customer: r.customer,
        itemCode: r.itemCode,
        item: r.item,
        uom: r.uom,
        received: r3(r.received),
        rejected: r3(rejected.get(key) ?? 0),
        used: r3(r.used),
        returned: r3(r.returned),
        other: r3(r.other),
        held: r3(r.held),
        usedShare: r.received > 0 ? Math.min(1, r.used / r.received) : null,
        firstIn: r.firstIn,
        lastMoved: r.lastMoved,
        daysHeld: r.held > 0.0005 && r.firstIn ? daysBetween(r.firstIn, params.asOn ? end : now) : 0,
      }))
      .filter((r) => r.received || r.held || r.used || r.returned)
      .sort((a, b) => a.customer.localeCompare(b.customer) || a.item.localeCompare(b.item))
    const rows = all.slice(0, rowCap)

    const holding = all.filter((r) => r.held > 0.0005)
    const customers = new Set(holding.map((r) => r.customer))
    const old = holding.filter((r) => r.daysHeld > 90)
    const withRejects = all.filter((r) => r.rejected > 0)
    const perCustomer = [...new Set(holding.map((r) => r.customer))].map((c) => ({ label: c, value: holding.filter((r) => r.customer === c).length }))

    const insights: string[] = []
    if (holding.length) insights.push(`We hold material for ${customers.size} customers across ${holding.length} item lines, as on ${asOnLabel(params)}.`)
    if (old.length) insights.push(`${old.length} lines have been with us over 90 days: ${old.slice(0, 3).map((r) => `${r.item} for ${r.customer}`).join(', ')}${old.length > 3 ? '…' : ''}. Ask whether to use them or send them back.`)
    if (withRejects.length) insights.push(`${withRejects.length} items arrived with some rejected at the gate; that quantity is in stock but flagged.`)
    const unused = holding.filter((r) => r.used === 0)
    if (unused.length) insights.push(`${unused.length} lines have not been used at all since they arrived.`)

    return {
      rows,
      totalRows: all.length > rowCap ? all.length : undefined,
      analysis: {
        headline: holding.length
          ? `Holding material for ${customers.size} customers as on ${asOnLabel(params)}; ${old.length} lines over 90 days.`
          : `No customer material held as on ${asOnLabel(params)}.`,
        kpis: [
          { label: 'Customers with material', value: customers.size || null, format: 'integer', basis: 'material still held' },
          { label: 'Item lines held', value: holding.length || null, format: 'integer', basis: `of ${all.length} ever received` },
          { label: 'Held over 90 days', value: holding.length ? old.length : null, format: 'integer', basis: 'lines to use up or return', tone: old.length ? 'warn' : undefined },
          { label: 'Lines with rejections', value: withRejects.length || null, format: 'integer', basis: 'rejected at the gate' },
        ],
        exceptions: old.length
          ? [{ label: 'Held over 90 days', value: old.length, format: 'integer', basis: "customers' material sitting with us", tone: 'warn' }]
          : [],
        panels: (
          [
            { title: 'Item lines held, by customer', question: 'ranking', format: 'integer', points: perCustomer.sort((a, b) => b.value - a.value) },
            {
              title: 'How long material has been with us',
              question: 'ageing',
              format: 'integer',
              points: [
                { label: 'Up to 30 days', value: holding.filter((r) => r.daysHeld <= 30).length, tone: 'normal' as const },
                { label: '31–90 days', value: holding.filter((r) => r.daysHeld > 30 && r.daysHeld <= 90).length, tone: 'warn' as const },
                { label: 'Over 90 days', value: old.length, tone: 'bad' as const },
              ],
            },
          ] as Panel[]
        ).filter((p) => p.points.some((x) => x.value > 0)),
        insights,
        caveats: [
          "Quantities only. Customers' material is not the mill's and carries no value.",
          'Rejected at gate is from the receipt; that quantity is in Received and Held, not taken out of them.',
          'Days held runs from the first receipt of the item for that customer.',
          'A cancelled receipt or return is reversed in the ledger and nets to nought.',
        ],
      },
    }
  },
}
