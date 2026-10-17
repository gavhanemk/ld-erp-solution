import type { Panel, ReportDefinition } from '../types'
import { materialGaps, orderReconciliation } from '../../services/reconciliation.service'

const r3 = (n: number) => Math.round(n * 1000) / 1000

/**
 * Job-work orders and the customer's material on each.
 *
 * The order's reconciliation, one order at a time, is on the sales order;
 * this is every job-work order at once, item by item, from the same figures
 * (`orderReconciliation`) — so it agrees with what closing the order checks.
 * What each order received, what went to production, what cutting used and
 * wasted, what went back, and what is still to account for before it can be
 * closed: still with us, on the floor, or missing.
 */
export const jobWorkOrders: ReportDefinition = {
  id: 'job-work-orders',
  module: 'inventory',
  title: 'Job-Work Orders: Customer Material',
  description:
    "Every job-work order with the customer's material on it — received, issued, used and wasted in cutting, sent back, still with us — and whether the order can be closed.",
  filters: [
    { key: 'customerId', label: 'Customer', type: 'select', optionsFrom: 'customers' },
    { key: 'all', label: 'Include completed and cancelled orders', type: 'boolean' },
  ],
  columns: [
    { key: 'state', label: 'Can Close?', type: 'badge', width: 18,
      badges: { READY: 'Yes — all accounted', WITH_US: 'No — material with us', ON_FLOOR: 'No — on the floor', MISSING: 'No — missing', CLOSED: 'Closed' },
      badgeTones: { READY: 'good', WITH_US: 'warn', ON_FLOOR: 'warn', MISSING: 'bad', CLOSED: 'neutral' } },
    { key: 'soNumber', label: 'Order', type: 'text', width: 16 },
    { key: 'orderStatus', label: 'Order Status', type: 'text', width: 18 },
    { key: 'customer', label: 'Customer', type: 'text', width: 26 },
    { key: 'itemCode', label: 'Item Code', type: 'text', width: 16 },
    { key: 'item', label: 'Their Material', type: 'text', width: 28 },
    { key: 'uom', label: 'UOM', type: 'text', width: 8 },
    { key: 'received', label: 'Received', type: 'qty', total: 'sum' },
    { key: 'rejected', label: 'Rejected at Gate', type: 'qty', total: 'sum' },
    { key: 'issued', label: 'Issued to Production', type: 'qty', total: 'sum' },
    { key: 'used', label: 'Used in Cutting', type: 'qty', total: 'sum' },
    { key: 'waste', label: 'Wasted in Cutting', type: 'qty', total: 'sum' },
    { key: 'onFloor', label: 'On the Floor', type: 'qty', total: 'sum' },
    { key: 'returned', label: 'Sent Back', type: 'qty', total: 'sum' },
    { key: 'atJobWorkers', label: 'Used at Job Workers', type: 'qty', total: 'sum' },
    { key: 'withUs', label: 'Still With Us', type: 'qty', total: 'sum' },
    { key: 'missing', label: 'Missing', type: 'qty', total: 'sum' },
    { key: 'bomForCut', label: 'BOM Allows for Cut', type: 'qty', total: 'sum' },
    { key: 'bomVariance', label: 'Over (+) / Under (−) BOM', type: 'qty', total: 'sum' },
    { key: 'piecesOrdered', label: 'Pieces Ordered', type: 'integer', total: 'none' },
    { key: 'piecesSent', label: 'Pieces Sent', type: 'integer', total: 'none' },
  ],
  summary: {
    title: 'Orders with material still to account for',
    columns: ['soNumber', 'customer', 'item', 'withUs', 'onFloor', 'missing'],
    by: 'withUs',
    limit: 12,
  },
  pivot: {
    rows: ['customer', 'soNumber'],
    values: ['received', 'used', 'returned', 'withUs'],
    slicers: ['state'],
    note: "Open a customer to see each order's material.",
  },

  async run({ tx, params, rowCap }) {
    const orders = await tx.salesOrder.findMany({
      where: {
        isJobWork: true,
        status: params.all ? { not: 'DRAFT' } : { notIn: ['DRAFT', 'COMPLETED', 'CANCELLED'] },
        ...(params.customerId ? { customerId: params.customerId } : {}),
      },
      orderBy: { createdAt: 'asc' },
      select: { id: true },
    })

    const all: Array<Record<string, unknown> & { state: string; soNumber: string; customer: string; withUs: number; onFloor: number; missing: number; uom: string }> = []
    const noMaterial: string[] = []
    for (const o of orders) {
      const r = await orderReconciliation(tx, o.id)
      if (!r.fabric.length) {
        noMaterial.push(r.order.soNumber)
        continue
      }
      const closed = ['COMPLETED', 'CANCELLED'].includes(r.order.status)
      const gaps = materialGaps(r)
      for (const f of r.fabric) {
        const mine = gaps.filter((g) => g.itemId === f.item.id)
        const of = (k: string) => mine.find((g) => g.kind === k)?.qty ?? 0
        const missing = of('MISSING'), onFloor = of('ON_FLOOR'), withUs = of('WITH_US')
        all.push({
          state: closed ? 'CLOSED' : missing > 0 ? 'MISSING' : onFloor > 0 ? 'ON_FLOOR' : withUs > 0 ? 'WITH_US' : 'READY',
          soNumber: r.order.soNumber,
          orderStatus: r.order.status.replace(/_/g, ' ').toLowerCase().replace(/^./, (c) => c.toUpperCase()),
          customer: r.order.customer,
          itemCode: f.item.code,
          item: f.item.name,
          uom: f.item.uom ?? '',
          received: r3(f.received),
          rejected: r3(f.rejected),
          issued: r3(f.issuedNet),
          used: r3(f.used),
          waste: r3(f.waste),
          onFloor: r3(onFloor),
          returned: r3(f.returned),
          atJobWorkers: r3(f.usedAtJobWorkers),
          withUs: r3(withUs),
          missing: r3(missing),
          bomForCut: f.bomForCut,
          bomVariance: f.bomVariance,
          piecesOrdered: r.pieces.ordered,
          piecesSent: r.pieces.sent,
        })
      }
    }

    const rows = all.slice(0, rowCap)
    const orderState = new Map<string, string>()
    // An order is as far from closing as its worst item.
    const rank = { MISSING: 4, ON_FLOOR: 3, WITH_US: 2, READY: 1, CLOSED: 0 } as Record<string, number>
    for (const r of all) {
      const was = orderState.get(r.soNumber)
      if (!was || rank[r.state] > rank[was]) orderState.set(r.soNumber, r.state)
    }
    const count = (s: string) => [...orderState.values()].filter((x) => x === s).length
    const ready = [...orderState].filter(([, s]) => s === 'READY').map(([so]) => so)
    const missingOrders = count('MISSING')

    const insights: string[] = []
    if (ready.length) insights.push(`${ready.length} ${ready.length === 1 ? 'order has' : 'orders have'} all the customer's material accounted for and can be closed: ${ready.slice(0, 6).join(', ')}${ready.length > 6 ? '…' : ''}.`)
    if (count('WITH_US')) insights.push(`${count('WITH_US')} ${count('WITH_US') === 1 ? 'order has' : 'orders have'} the customer's material still with us — use it, or send it back.`)
    if (count('ON_FLOOR')) insights.push(`${count('ON_FLOOR')} ${count('ON_FLOOR') === 1 ? 'order has' : 'orders have'} material issued to production and neither cut nor returned — record the cutting or the floor return.`)
    if (missingOrders) insights.push(`${missingOrders} ${missingOrders === 1 ? 'order has' : 'orders have'} material missing: the customer has less with us than the order's receipts leave.`)
    if (noMaterial.length) insights.push(`${noMaterial.length} open job-work ${noMaterial.length === 1 ? 'order has' : 'orders have'} no customer material received yet: ${noMaterial.slice(0, 6).join(', ')}${noMaterial.length > 6 ? '…' : ''}.`)

    return {
      rows,
      totalRows: all.length > rowCap ? all.length : undefined,
      analysis: {
        headline: orderState.size
          ? `${orderState.size} job-work ${orderState.size === 1 ? 'order' : 'orders'} with customer material: ${ready.length} can be closed, ${orderState.size - ready.length - count('CLOSED')} still have material to account for.`
          : 'No open job-work order has customer material on it.',
        kpis: [
          { label: 'Orders with their material', value: orderState.size || null, format: 'integer', basis: params.all ? 'all job-work orders' : 'open job-work orders' },
          { label: 'Ready to close', value: orderState.size ? ready.length : null, format: 'integer', basis: 'every metre accounted for', tone: ready.length ? 'good' : undefined },
          { label: 'Material still with us', value: orderState.size ? count('WITH_US') : null, format: 'integer', basis: 'orders — use it or send it back' },
          { label: 'Missing', value: orderState.size ? missingOrders : null, format: 'integer', basis: 'orders', tone: missingOrders ? 'bad' : undefined },
        ],
        exceptions: missingOrders
          ? [{ label: 'Orders with material missing', value: missingOrders, format: 'integer', basis: 'count the stock, or find the order that took it', tone: 'bad' }]
          : [],
        panels: (
          [
            {
              title: 'Where the orders stand',
              question: 'composition',
              format: 'integer',
              points: [
                { label: 'Ready to close', value: ready.length, tone: 'good' },
                { label: 'Material with us', value: count('WITH_US'), tone: 'warn' },
                { label: 'On the floor', value: count('ON_FLOOR'), tone: 'warn' },
                { label: 'Missing', value: missingOrders, tone: 'bad' },
              ],
            },
          ] as Panel[]
        ).filter((p) => p.points.some((x) => x.value > 0)),
        insights,
        caveats: [
          "Only the documents tied to each order count: its approved customer receipts, its requisitions, returns and job-work challans. Receipts with no order are nobody's until assigned.",
          'Still with us is in a store or at a job worker, for this order. On the floor is issued and neither cut nor brought back. Missing is more than the customer has with us at all.',
          'An order closes without an exception only when every item reads "Yes — all accounted".',
          `BOM allows is what the BOM needs for the pieces actually cut; blank when the BOM has no line for the material.`,
          "Received and the rest are in each material's own unit, so a total is only meaningful within one unit.",
        ],
      },
    }
  },
}
