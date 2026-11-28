import { Prisma } from '@prisma/client'
import type { Panel, ReportDefinition } from '../types'
import { round2 } from './shared'
import { rupees } from './inventory-shared'

/**
 * Work in progress, order by order: does it add up?
 *
 * Two records follow an order's pieces. The production floor counts them step
 * by step — cut, in hand, waiting a decision, scrapped, packed — and never
 * loses one: every piece cut is always somewhere. The stock ledger values
 * what came out of the stores and what came back in. This lays the two side
 * by side for each order and names where they part:
 *
 *   - packed on the floor but not received into stock as finished goods (or
 *     the other way round);
 *   - pieces also held in a process-floor store while the floor counts them,
 *     which a stock report would count twice;
 *   - cut panels booked into stock that nothing ever takes out again, whose
 *     value the finished goods carry as well.
 *
 * And it shows, for each order, the material issued against the finished
 * goods received, at their own costs. That difference is the cost of making
 * the order at the BOM's figure, not a fault.
 */
export const wipReconciliation: ReportDefinition = {
  id: 'wip-reconciliation',
  module: 'production',
  title: 'WIP Reconciliation',
  description:
    'Order by order, the production floor against the stock ledger: pieces cut, on the floor, scrapped, packed and received into stock; pieces also in process-floor stores; cut panels left in stock; material issued against finished goods received.',
  filters: [
    {
      key: 'which',
      label: 'Orders',
      type: 'select',
      options: [
        { value: 'open', label: 'Still being made' },
        { value: 'all', label: 'Every order' },
        { value: 'differences', label: 'Only those that do not add up' },
      ],
      emptyLabel: 'Still being made',
    },
  ],
  columns: [
    {
      key: 'result',
      label: 'Result',
      type: 'badge',
      width: 12,
      badges: { CLEAR: 'Adds up', CHECK: 'Look at it' },
      badgeTones: { CLEAR: 'good', CHECK: 'warn' },
    },
    { key: 'mo', label: 'MO', type: 'text', width: 16 },
    { key: 'order', label: 'For', type: 'text', width: 18 },
    { key: 'styles', label: 'Styles', type: 'text', width: 24 },
    { key: 'status', label: 'Stage', type: 'text', width: 12 },
    { key: 'planned', label: 'Planned', type: 'integer', total: 'sum' },
    { key: 'cut', label: 'Cut', type: 'integer', total: 'sum' },
    { key: 'onFloor', label: 'On the Floor', type: 'integer', total: 'sum' },
    { key: 'waiting', label: 'Waiting a Decision', type: 'integer', total: 'sum' },
    { key: 'scrapped', label: 'Scrapped', type: 'integer', total: 'sum' },
    { key: 'packed', label: 'Packed', type: 'integer', total: 'sum' },
    { key: 'received', label: 'Received as FG', type: 'integer', total: 'sum' },
    { key: 'packedNotReceived', label: 'Packed − Received', type: 'integer', total: 'sum' },
    { key: 'floorStock', label: 'In Floor Stores', type: 'qty', total: 'sum' },
    { key: 'panels', label: 'Cut Panels in Stock', type: 'qty', total: 'sum' },
    { key: 'panelValue', label: 'Panel Value', type: 'money', total: 'sum' },
    { key: 'issuedValue', label: 'Material Issued', type: 'money', total: 'sum' },
    { key: 'receivedValue', label: 'FG Received', type: 'money', total: 'sum' },
    { key: 'note', label: 'What does not add up', type: 'text', width: 60 },
  ],
  summary: {
    title: 'Orders to look at',
    columns: ['mo', 'order', 'cut', 'packed', 'received', 'note'],
    by: 'packedNotReceived',
    limit: 20,
  },

  async run({ tx, params, rowCap }) {
    const which = (params.which as string | undefined) || 'open'
    const mos = await tx.manufacturingOrder.findMany({
      where: which === 'open' ? { status: { notIn: ['DRAFT', 'COMPLETED', 'CLOSED'] } } : { status: { not: 'DRAFT' } },
      select: {
        id: true,
        moNumber: true,
        status: true,
        purpose: true,
        so: { select: { soNumber: true } },
        lines: { select: { totalQty: true, style: { select: { code: true } } } },
      },
      orderBy: { moNumber: 'desc' },
    })
    const ids = mos.map((m) => m.id)
    if (!ids.length) {
      return { rows: [], analysis: { headline: 'No orders to look at.', kpis: [], panels: [], insights: [], caveats: [] } }
    }

    // The production floor, by order and place.
    const wip = await tx.$queryRaw<Array<{ moId: string; bucket: string; qty: number; cut: number }>>`
      SELECT "moId", bucket::text AS bucket, SUM(qty)::int AS qty,
             COALESCE(SUM(qty) FILTER (WHERE "eventType"::text = 'CUT' AND qty > 0), 0)::int AS cut
      FROM ld_erp.wip_entries
      WHERE "moId" IN (${Prisma.join(ids)})
      GROUP BY "moId", bucket`
    // Finished goods received into stock against each order.
    const fg = await tx.$queryRaw<Array<{ moId: string; qty: number; value: number }>>`
      SELECT r."moId", SUM(l.qty)::float8 AS qty, SUM(l.qty * l."unitRate")::float8 AS value
      FROM ld_erp.finished_goods_receipt_lines l
      JOIN ld_erp.finished_goods_receipts r ON r.id = l."receiptId"
      WHERE r."moId" IN (${Prisma.join(ids)}) AND r."cancelledAt" IS NULL
      GROUP BY r."moId"`
    // Material issued on the order's requisitions, less what came back from the floor.
    const issued = await tx.$queryRaw<Array<{ moId: string; value: number }>>`
      SELECT mr."moId", SUM((s."outQty" - s."inQty") * COALESCE(s."unitRate", 0))::float8 AS value
      FROM ld_erp.stock_ledger s
      JOIN ld_erp.material_requisitions mr ON mr.id = s."referenceId"
      WHERE s."referenceType" IN ('MATERIAL_REQUISITION', 'MR_RETURN', 'MR_RETURN_CANCELLED') AND mr."moId" IN (${Prisma.join(ids)})
      GROUP BY mr."moId"`
    // Cut panels booked into stock on the order's cutting, as they stand.
    const panels = await tx.$queryRaw<Array<{ moId: string; qty: number; value: number }>>`
      SELECT c."moId", SUM(s."inQty" - s."outQty")::float8 AS qty, SUM((s."inQty" - s."outQty") * COALESCE(s."unitRate", 0))::float8 AS value
      FROM ld_erp.stock_ledger s
      JOIN ld_erp.cutting_orders c ON c.id = s."referenceId"
      WHERE s."referenceType" IN ('CUTTING', 'CUTTING_CANCEL') AND c."moId" IN (${Prisma.join(ids)})
      GROUP BY c."moId"`
    // Pieces in process-floor stores carrying the order's number (MO or SO).
    const numbers = mos.flatMap((m) => [m.moNumber, m.so?.soNumber].filter((n): n is string => !!n))
    const floors = numbers.length
      ? await tx.$queryRaw<Array<{ orderNo: string; qty: number }>>`
          SELECT s."orderNo", SUM(s."inQty" - s."outQty")::float8 AS qty
          FROM ld_erp.stock_ledger s
          JOIN ld_erp.warehouses w ON w.id = s."warehouseId"
          WHERE w."departmentId" IS NOT NULL AND s."orderNo" IN (${Prisma.join(numbers)})
          GROUP BY s."orderNo"
          HAVING ABS(SUM(s."inQty" - s."outQty")) > 0.0005`
      : []

    const ON_FLOOR = ['TRANSIT', 'WIP', 'DONE', 'REWORK', 'B_GRADE']
    const WAITING = ['DAMAGED', 'REJECTED', 'SHORT']
    const rows = mos
      .map((m) => {
        const mine = wip.filter((w) => w.moId === m.id)
        const sum = (buckets: string[]) => mine.filter((w) => buckets.includes(w.bucket)).reduce((t, w) => t + Number(w.qty), 0)
        const cut = mine.reduce((t, w) => t + Number(w.cut), 0)
        const packed = sum(['PACKED', 'PACKED_B'])
        const f = fg.find((x) => x.moId === m.id)
        const received = Math.round(Number(f?.qty ?? 0))
        const floorStock = Math.round(floors.filter((x) => x.orderNo === m.moNumber || x.orderNo === m.so?.soNumber).reduce((t, x) => t + Number(x.qty), 0) * 1000) / 1000
        const p = panels.find((x) => x.moId === m.id)
        const panelQty = Math.round(Number(p?.qty ?? 0) * 1000) / 1000
        const routed = cut > 0
        const packedNotReceived = routed ? packed - received : 0
        const notes: string[] = []
        if (routed && packedNotReceived > 0) notes.push(`${packedNotReceived} packed on the floor but not received into stock: receive them as finished goods.`)
        if (routed && packedNotReceived < 0) notes.push(`${-packedNotReceived} received as finished goods more than the floor packed: a receipt not taken from the floor.`)
        if (routed && floorStock > 0) notes.push(`${floorStock} also held in process-floor stores while the floor counts its pieces: a stock report counts them twice.`)
        if (panelQty > 0 && received > 0) notes.push(`${panelQty} cut panels still in stock after finished goods came in: their value is in the finished goods too.`)
        const order = m.so?.soNumber ?? (m.purpose === 'SAMPLE' ? 'Samples' : m.purpose === 'CUSTOMER' ? 'A customer, direct' : 'Stock')
        return {
          result: notes.length ? 'CHECK' : 'CLEAR',
          mo: m.moNumber,
          order,
          styles: [...new Set(m.lines.map((l) => l.style.code))].join(', '),
          status: m.status.charAt(0) + m.status.slice(1).toLowerCase(),
          planned: m.lines.reduce((t, l) => t + l.totalQty, 0),
          cut,
          onFloor: sum(ON_FLOOR),
          waiting: sum(WAITING),
          scrapped: sum(['SCRAPPED']),
          packed,
          received,
          packedNotReceived,
          floorStock,
          panels: panelQty,
          panelValue: round2(Number(p?.value ?? 0)),
          issuedValue: round2(Number(issued.find((x) => x.moId === m.id)?.value ?? 0)),
          receivedValue: round2(Number(f?.value ?? 0)),
          note: notes.join(' '),
        }
      })
      .filter((r) => which !== 'differences' || r.result === 'CHECK')

    const look = rows.filter((r) => r.result === 'CHECK')
    const unreceived = rows.reduce((t, r) => t + Math.max(0, r.packedNotReceived), 0)
    const panelValue = round2(rows.reduce((t, r) => t + (r.received > 0 ? r.panelValue : 0), 0))
    const doubled = rows.filter((r) => r.cut > 0 && r.floorStock > 0).length
    const issuedTotal = round2(rows.reduce((t, r) => t + r.issuedValue, 0))
    const receivedTotal = round2(rows.reduce((t, r) => t + r.receivedValue, 0))

    return {
      rows: rows.slice(0, rowCap),
      totalRows: rows.length > rowCap ? rows.length : undefined,
      analysis: {
        headline: rows.length
          ? look.length
            ? `${look.length} of ${rows.length} ${rows.length === 1 ? 'order does' : 'orders do'} not add up.`
            : `All ${rows.length} ${rows.length === 1 ? 'order adds' : 'orders add'} up.`
          : 'No orders to look at.',
        kpis: [
          { label: 'Orders to look at', value: look.length, format: 'integer', basis: `of ${rows.length} shown`, tone: look.length ? 'warn' : 'good' },
          { label: 'Packed, not received', value: unreceived, format: 'integer', basis: 'pieces packed on the floor but not in stock as finished goods', tone: unreceived ? 'warn' : undefined },
          { label: 'Panels counted twice', value: panelValue, format: 'money', basis: 'cut panels still in stock on orders whose finished goods came in', tone: panelValue ? 'warn' : undefined },
          { label: 'Material issued vs FG', value: round2(receivedTotal - issuedTotal), format: 'money', basis: `FG received ${rupees(receivedTotal)} − material issued ${rupees(issuedTotal)}` },
        ],
        panels: (
          [
            {
              title: 'What does not add up',
              question: 'composition' as const,
              format: 'integer' as const,
              points: [
                { label: 'Packed, not received', value: rows.filter((r) => r.packedNotReceived > 0).length, tone: 'warn' as const },
                { label: 'Received, not packed', value: rows.filter((r) => r.packedNotReceived < 0).length, tone: 'warn' as const },
                { label: 'Also in floor stores', value: doubled, tone: 'warn' as const },
                { label: 'Panels left in stock', value: rows.filter((r) => r.panels > 0 && r.received > 0).length, tone: 'warn' as const },
              ].filter((x) => x.value > 0),
            },
          ] as Panel[]
        ).filter((x) => x.points.length > 0),
        insights: [
          ...(look.length ? [] : rows.length ? ['On every order shown, what the floor packed is what came into stock, and nothing is counted twice.'] : []),
          ...(panelValue ? [`Cut panels worth ${rupees(panelValue)} are still in stock on orders whose finished goods came in: the same cloth is valued twice until they are taken out.`] : []),
        ],
        caveats: [
          'Pieces are the production floor\'s own count; the floor never loses a piece, so cut = on the floor + waiting + scrapped + packed on every order.',
          'An order made without its steps on the floor (no pieces cut there) is checked for panels only.',
          'Finished goods come in at the approved BOM\'s cost per piece; material is issued at the store\'s average cost. Their difference is the cost of making, not a fault.',
          'Floor stores are the process stores (Cutting Floor, Stitching Floor…) holding stock under the order\'s number.',
        ],
      },
    }
  },
}
