import type { Prisma } from '@prisma/client'
import type { Panel, ReportDefinition, Tone } from '../types'
import {
  dateRangeFilters,
  dayRange,
  itemFilter,
  ratio,
  round2,
  searchFilter,
  supplierFilter,
} from './shared'

/*
 * Where an indent line has got to on the purchase side.
 *
 * Worked out from the order and receipt lines rather than stored, for the
 * same reason the indent picker on the order form works it out: a stored
 * "ordered" counter and the orders it counts disagree the first time an order
 * is cancelled.
 */
const STAGE_WORDS: Record<string, string> = {
  NOT_ORDERED: 'Not ordered',
  PART_ORDERED: 'Part ordered',
  ORDERED: 'Ordered',
  RECEIVED: 'Received',
}

const STAGE_TONE: Record<string, Tone> = {
  NOT_ORDERED: 'bad',
  PART_ORDERED: 'warn',
  ORDERED: 'info',
  RECEIVED: 'good',
}

const DAY = 86_400_000

/**
 * Every approved purchase indent line, and the orders raised against it.
 *
 * One row per indent line rather than per order line. An indent ordered in
 * two lots would otherwise appear twice and its quantity would be counted
 * twice; here the orders are listed in one cell and the quantities are summed
 * once.
 */
export const indentAgainstPo: ReportDefinition = {
  id: 'indent-against-po',
  module: 'purchase',
  title: 'Indent Against PO',
  description:
    'Every approved purchase indent line, which orders were raised against it, and how much is still to order or still to arrive.',
  filters: [
    ...dateRangeFilters,
    supplierFilter,
    itemFilter,
    {
      key: 'stage',
      label: 'Stage',
      type: 'select',
      options: Object.entries(STAGE_WORDS).map(([value, label]) => ({ value, label })),
    },
    { ...searchFilter, help: 'Indent number or order number' },
  ],
  columns: [
    { key: 'requestDate', label: 'Indent Date', type: 'date', width: 13 },
    { key: 'mrNumber', label: 'Indent No.', type: 'text', width: 16 },
    { key: 'department', label: 'Department', type: 'text', width: 18 },
    { key: 'moNumber', label: 'MO No.', type: 'text', width: 14 },
    { key: 'requiredDate', label: 'Needed By', type: 'date', width: 13 },
    { key: 'itemCode', label: 'Item Code', type: 'text', width: 16 },
    { key: 'item', label: 'Item', type: 'text', width: 30 },
    { key: 'uom', label: 'UOM', type: 'text', width: 8 },
    { key: 'indentQty', label: 'Indent Qty', type: 'qty', total: 'sum' },
    { key: 'orderedQty', label: 'Ordered', type: 'qty', total: 'sum' },
    { key: 'toOrder', label: 'Still to Order', type: 'qty', total: 'sum' },
    { key: 'receivedQty', label: 'Received', type: 'qty', total: 'sum' },
    { key: 'poNumbers', label: 'Order No(s).', type: 'text', width: 22 },
    { key: 'suppliers', label: 'Supplier(s)', type: 'text', width: 28 },
    { key: 'store', label: 'For Store', type: 'text', width: 20 },
    {
      key: 'stage',
      label: 'Stage',
      type: 'badge',
      badges: STAGE_WORDS,
      badgeTones: STAGE_TONE,
      width: 14,
    },
    { key: 'daysWaiting', label: 'Days Waiting', type: 'integer', width: 12 },
  ],

  summary: {
    // The indents the buyer has sat on longest, not the biggest: a small
    // indent that has waited three weeks is the one that stops a line.
    title: 'Waiting longest to be ordered',
    columns: ['requestDate', 'mrNumber', 'department', 'item', 'toOrder', 'stage', 'daysWaiting'],
    by: 'daysWaiting',
    limit: 12,
  },

  pivot: {
    rows: 'department',
    values: ['indentQty', 'orderedQty', 'toOrder', 'receivedQty'],
    slicers: ['stage', 'uom'],
    note: 'Quantities in different units share these columns. Pick a UOM before reading a total.',
  },

  async run({ tx, params, rowCap }) {
    const range = dayRange(params)
    // Orders the report counts: not cancelled, not in the recycle bin.
    const liveOrder: Prisma.PurchaseOrderWhereInput = {
      status: { not: 'CANCELLED' },
      deletedAt: null,
    }

    const where: Prisma.MaterialRequisitionLineWhereInput = {
      fulfilment: 'PURCHASE',
      mr: { status: 'APPROVED', ...(range ? { requestDate: range } : {}) },
      ...(params.itemId ? { itemId: params.itemId } : {}),
      ...(params.supplierId
        ? { poLines: { some: { po: { ...liveOrder, supplierId: params.supplierId } } } }
        : {}),
      ...(params.q
        ? {
            OR: [
              { mr: { mrNumber: { contains: params.q, mode: 'insensitive' as const } } },
              {
                poLines: {
                  some: {
                    po: {
                      ...liveOrder,
                      poNumber: { contains: params.q, mode: 'insensitive' as const },
                    },
                  },
                },
              },
            ],
          }
        : {}),
    }

    const totalRows = await tx.materialRequisitionLine.count({ where })
    const lines = await tx.materialRequisitionLine.findMany({
      where,
      take: rowCap,
      orderBy: [{ mr: { requestDate: 'asc' } }, { id: 'asc' }],
      select: {
        requestedQty: true,
        purchaseQty: true,
        item: { select: { code: true, name: true, uom: { select: { symbol: true } } } },
        warehouse: { select: { name: true } },
        mr: {
          select: {
            mrNumber: true,
            requestDate: true,
            requiredDate: true,
            department: { select: { name: true } },
            mo: { select: { moNumber: true } },
          },
        },
        poLines: {
          where: { po: liveOrder },
          select: {
            qty: true,
            po: { select: { poNumber: true, supplier: { select: { name: true } } } },
            grnLines: { select: { receivedQty: true, grn: { select: { status: true } } } },
          },
        },
      },
    })

    const today = new Date()
    const startOfToday = new Date(today.getFullYear(), today.getMonth(), today.getDate())

    const all = lines.map((l) => {
      // What the store decided to buy; the whole line where it was decided before a quantity could be set.
      const indentQty = l.purchaseQty !== null ? Number(l.purchaseQty) : Number(l.requestedQty)
      const orderedQty = round2(l.poLines.reduce((s, p) => s + Number(p.qty), 0))
      // Cancelled receipts booked nothing in.
      const receivedQty = round2(
        l.poLines.reduce(
          (s, p) =>
            s +
            p.grnLines
              .filter((g) => g.grn.status !== 'CANCELLED')
              .reduce((n, g) => n + Number(g.receivedQty), 0),
          0
        )
      )
      const toOrder = round2(Math.max(0, indentQty - orderedQty))
      const stage =
        orderedQty <= 0
          ? 'NOT_ORDERED'
          : orderedQty < indentQty
            ? 'PART_ORDERED'
            : receivedQty >= indentQty
              ? 'RECEIVED'
              : 'ORDERED'
      const asked = l.mr.requestDate
      const askedDay = new Date(asked.getFullYear(), asked.getMonth(), asked.getDate())

      return {
        requestDate: l.mr.requestDate,
        mrNumber: l.mr.mrNumber,
        department: l.mr.department?.name ?? '',
        moNumber: l.mr.mo?.moNumber ?? '',
        requiredDate: l.mr.requiredDate,
        itemCode: l.item.code,
        item: l.item.name,
        uom: l.item.uom?.symbol ?? '',
        indentQty,
        orderedQty,
        toOrder,
        receivedQty,
        poNumbers: [...new Set(l.poLines.map((p) => p.po.poNumber))].join(', '),
        suppliers: [...new Set(l.poLines.map((p) => p.po.supplier?.name ?? ''))]
          .filter(Boolean)
          .join(', '),
        store: l.warehouse?.name ?? '',
        stage,
        // Only for what is still the buyer's job. An indent fully ordered is
        // waiting on the supplier, and that is the Pending PO report's count.
        daysWaiting:
          toOrder > 0
            ? Math.max(0, Math.floor((startOfToday.getTime() - askedDay.getTime()) / DAY))
            : 0,
      }
    })

    // The stage filter is applied after the stage is worked out, because it is
    // not a column in the database.
    const rows = params.stage ? all.filter((r) => r.stage === params.stage) : all

    const count = (s: string) => rows.filter((r) => r.stage === s).length
    const waiting = rows.filter((r) => r.toOrder > 0)
    const late = waiting.filter((r) => r.requiredDate != null && r.requiredDate < startOfToday)
    const oldWaiting = waiting.filter((r) => r.stage === 'NOT_ORDERED' && r.daysWaiting > 7)
    const fullyOrdered = rows.filter((r) => r.stage === 'ORDERED' || r.stage === 'RECEIVED').length
    const indents = new Set(rows.map((r) => r.mrNumber)).size

    const waitingByItem = new Map<string, number>()
    for (const r of waiting) waitingByItem.set(r.item, (waitingByItem.get(r.item) ?? 0) + 1)
    const waitingByDept = new Map<string, number>()
    for (const r of waiting) {
      const d = r.department || 'No department'
      waitingByDept.set(d, (waitingByDept.get(d) ?? 0) + 1)
    }

    const insights: string[] = []
    if (rows.length) {
      insights.push(
        `${fullyOrdered} of ${rows.length} indent line${rows.length === 1 ? ' is' : 's are'} fully ordered; ${waiting.length} still ${waiting.length === 1 ? 'has' : 'have'} something to order.`
      )
    }
    const longest = [...waiting].sort((a, b) => b.daysWaiting - a.daysWaiting)[0]
    if (longest && longest.daysWaiting > 0) {
      insights.push(
        `The longest wait is ${longest.mrNumber} for ${longest.item} — ${longest.daysWaiting} days, ${longest.toOrder.toLocaleString('en-IN')} ${longest.uom} still to order.`
      )
    }
    if (late.length) {
      insights.push(
        `${late.length} line${late.length === 1 ? ' is' : 's are'} past the date production needed ${late.length === 1 ? 'it' : 'them'} and not fully ordered.`
      )
    }

    return {
      rows,
      totalRows: params.stage ? undefined : totalRows,
      analysis: {
        headline:
          rows.length === 0
            ? 'No approved purchase indents in this period.'
            : `${indents} indent${indents === 1 ? '' : 's'}, ${rows.length} line${rows.length === 1 ? '' : 's'} — ${waiting.length} still to order.`,
        exceptions: [
          {
            label: 'Past the needed-by date',
            value: late.length || null,
            format: 'integer',
            basis: 'indent lines production has already waited on, not fully ordered',
            tone: 'bad',
          },
          {
            label: 'Nothing ordered after a week',
            value: oldWaiting.length || null,
            format: 'integer',
            basis: 'indent lines raised more than 7 days ago with no order against them',
            tone: 'warn',
          },
        ],
        kpis: [
          {
            label: 'Indent lines',
            value: rows.length || null,
            format: 'integer',
            basis: `across ${indents} indents`,
          },
          {
            label: 'Fully ordered',
            value: ratio(fullyOrdered, rows.length),
            format: 'percent',
            basis: `${fullyOrdered} of ${rows.length} lines`,
            tone: rows.length && fullyOrdered === rows.length ? 'good' : undefined,
          },
          {
            label: 'Still to order',
            value: rows.length ? waiting.length : null,
            format: 'integer',
            basis: 'lines with some quantity not yet on an order',
            tone: waiting.length ? 'warn' : 'good',
          },
          {
            label: 'Received in full',
            value: rows.length ? count('RECEIVED') : null,
            format: 'integer',
            basis: 'lines whose goods have all arrived',
          },
        ],
        panels: (
          [
            {
              title: 'Where the indent lines have got to',
              question: 'funnel',
              format: 'integer',
              points: (['NOT_ORDERED', 'PART_ORDERED', 'ORDERED', 'RECEIVED'] as const).map(
                (s) => ({
                  label: STAGE_WORDS[s],
                  value: count(s),
                  tone: STAGE_TONE[s],
                })
              ),
            },
            {
              title: 'Items waiting to be ordered',
              question: 'ranking',
              format: 'integer',
              points: [...waitingByItem]
                .map(([label, value]) => ({ label, value }))
                .sort((a, b) => b.value - a.value)
                .slice(0, 8),
              note: 'Counted in indent lines, because the items are in different units.',
            },
            {
              title: 'Which departments are waiting',
              question: 'ranking',
              format: 'integer',
              points: [...waitingByDept]
                .map(([label, value]) => ({ label, value }))
                .sort((a, b) => b.value - a.value)
                .slice(0, 8),
              note: 'Indent lines with something still to order.',
            },
          ] as Panel[]
        ).filter((p) => p.points.some((x) => x.value > 0)),
        insights,
        caveats: [
          'Only approved indents marked for purchase. Indents still pending approval, rejected, or to be issued from stock are not listed.',
          'Cancelled orders and orders in the recycle bin count as nothing ordered. Cancelled receipts count as nothing received.',
          'Quantities are in each item’s own unit. The column totals add unlike units and are there for a filtered column, not the whole sheet.',
        ],
      },
    }
  },
}
