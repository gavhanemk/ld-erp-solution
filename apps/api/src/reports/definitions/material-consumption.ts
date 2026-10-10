import type { Prisma } from '@prisma/client'
import type { Panel, ReportDefinition } from '../types'
import { byMonth, dateRangeFilters, itemFilter, periodLabel, round2, topWithRest } from './shared'
import { categoryFilter, loadCategories, pctOf, rupees, warehouseFilter } from './inventory-shared'

/**
 * What the floor used: material issued against requisitions.
 *
 * One row per issue, with the department that asked, the order and style it
 * was for, and the value at the rate the stock was carried at. Where the
 * material money goes, department by department and style by style.
 */
export const materialConsumption: ReportDefinition = {
  id: 'material-consumption',
  module: 'inventory',
  title: 'Material Issues & Consumption',
  description:
    'Every issue of material against a requisition — which department used it, for which order and style, how much and at what value — to see where material money goes.',
  filters: [
    ...dateRangeFilters,
    {
      key: 'department',
      label: 'Department',
      type: 'text',
      help: 'Part of a department name, e.g. Cutting',
    },
    warehouseFilter,
    categoryFilter,
    itemFilter,
  ],
  columns: [
    { key: 'date', label: 'Issued On', type: 'date', width: 14 },
    { key: 'mrNumber', label: 'Requisition', type: 'text', width: 16 },
    { key: 'department', label: 'Department', type: 'text', width: 18 },
    { key: 'customer', label: 'For Customer', type: 'text', width: 22 },
    { key: 'soNumber', label: 'Sales Order', type: 'text', width: 16 },
    { key: 'styleNo', label: 'Style No.', type: 'text', width: 14 },
    { key: 'category', label: 'Category', type: 'text', width: 18 },
    { key: 'itemCode', label: 'Item Code', type: 'text', width: 16 },
    { key: 'item', label: 'Item', type: 'text', width: 30 },
    { key: 'store', label: 'From Store', type: 'text', width: 18 },
    { key: 'uom', label: 'UOM', type: 'text', width: 8 },
    { key: 'qty', label: 'Qty', type: 'qty', total: 'sum' },
    { key: 'rate', label: 'Rate', type: 'money', total: 'none' },
    { key: 'value', label: 'Value', type: 'money', total: 'sum' },
  ],
  summary: {
    title: 'Biggest issues in this period',
    columns: ['date', 'mrNumber', 'department', 'item', 'qty', 'value'],
    by: 'value',
    limit: 12,
  },
  pivot: {
    rows: ['department', 'item'],
    values: ['qty', 'value'],
    slicers: ['category', 'customer', 'store'],
    note: 'Open a department to see what it used. Read quantities per item.',
  },

  async run({ tx, params, rowCap }) {
    const from = params.from ? new Date(`${params.from}T00:00:00`) : undefined
    const to = params.to ? new Date(`${params.to}T23:59:59.999`) : undefined
    const cats = await loadCategories(tx)
    const catIds = cats.under(params.categoryId)

    let mrIds: string[] | undefined
    if (params.department) {
      const mrs = await tx.materialRequisition.findMany({
        where: { department: { name: { contains: params.department, mode: 'insensitive' } } },
        select: { id: true },
      })
      mrIds = mrs.map((m) => m.id)
    }

    const where: Prisma.StockLedgerWhereInput = {
      transactionType: 'ISSUE',
      ...(from || to ? { transactionDate: { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) } } : {}),
      ...(params.warehouseId ? { warehouseId: params.warehouseId } : {}),
      ...(params.itemId ? { itemId: params.itemId } : {}),
      ...(catIds ? { item: { categoryId: { in: catIds } } } : {}),
      ...(mrIds ? { referenceId: { in: mrIds } } : {}),
    }
    const totalRows = await tx.stockLedger.count({ where })
    const issues = await tx.stockLedger.findMany({
      where,
      take: rowCap,
      orderBy: { transactionDate: 'asc' },
      select: {
        itemId: true,
        referenceId: true,
        inQty: true,
        outQty: true,
        unitRate: true,
        ownership: true,
        transactionDate: true,
        item: { select: { code: true, name: true, categoryId: true, uom: { select: { symbol: true } } } },
        warehouse: { select: { name: true } },
      },
    })

    const ids = [...new Set(issues.map((i) => i.referenceId).filter((x): x is string => Boolean(x)))]
    const mrs = await tx.materialRequisition.findMany({
      where: { id: { in: ids } },
      select: {
        id: true,
        mrNumber: true,
        department: { select: { name: true } },
        so: { select: { soNumber: true, customer: { select: { name: true } } } },
        lines: { select: { itemId: true, styleNo: true, ownerCustomer: { select: { name: true } } } },
      },
    })
    const mrById = new Map(mrs.map((m) => [m.id, m]))

    const rows = issues.map((i) => {
      const mr = i.referenceId ? mrById.get(i.referenceId) : undefined
      const line = mr?.lines.find((l) => l.itemId === i.itemId)
      const qty = Math.round((Number(i.outQty) - Number(i.inQty)) * 1000) / 1000
      const rate = Number(i.unitRate ?? 0)
      return {
        date: i.transactionDate,
        mrNumber: mr?.mrNumber ?? '',
        department: mr?.department?.name ?? '',
        customer: mr?.so?.customer?.name ?? line?.ownerCustomer?.name ?? '',
        soNumber: mr?.so?.soNumber ?? '',
        styleNo: line?.styleNo ?? '',
        category: cats.names(i.item.categoryId).category,
        itemCode: i.item.code,
        item: i.item.name,
        store: i.warehouse.name,
        uom: i.item.uom?.symbol ?? '',
        qty,
        rate,
        // A customer's own material costs the mill nothing.
        value: i.ownership === 'OWNED' ? round2(qty * rate) : 0,
      }
    })

    const total = round2(rows.reduce((s, r) => s + r.value, 0))
    const by = (key: (r: (typeof rows)[number]) => string) => {
      const m = new Map<string, number>()
      for (const r of rows) m.set(key(r) || 'Not given', (m.get(key(r) || 'Not given') ?? 0) + r.value)
      return [...m].map(([label, value]) => ({ label, value: round2(value) })).sort((a, b) => b.value - a.value)
    }
    const byDept = by((r) => r.department)
    const byCustomer = by((r) => r.customer)
    const byItem = by((r) => r.item)
    const requisitions = new Set(rows.map((r) => r.mrNumber)).size
    const monthly = byMonth(rows, (r) => r.date, (r) => r.value)
    const forOrders = round2(rows.filter((r) => r.soNumber).reduce((s, r) => s + r.value, 0))

    const insights: string[] = []
    if (byDept.length) insights.push(`${byDept[0].label} used the most: ${rupees(byDept[0].value)}, ${pctOf(byDept[0].value, total)} of all issues.`)
    if (byItem.length) insights.push(`${byItem[0].label} is the biggest item used, at ${rupees(byItem[0].value)}.`)
    if (total)
      insights.push(
        forOrders
          ? `${pctOf(forOrders, total)} of the material issued was against a named sales order; the rest was general use.`
          : 'None of the material issued was against a named sales order — link requisitions to orders to see cost per order.',
      )

    return {
      rows,
      totalRows: totalRows > rows.length ? totalRows : undefined,
      analysis: {
        headline: rows.length
          ? `${rupees(total)} of material issued on ${requisitions} requisitions, ${periodLabel(params).toLowerCase()}.`
          : 'No material was issued in this period.',
        kpis: [
          { label: 'Value issued', value: rows.length ? total : null, format: 'money', basis: `${rows.length} issues` },
          { label: 'Requisitions served', value: rows.length ? requisitions : null, format: 'integer', basis: `by ${byDept.length} departments` },
          { label: 'Items used', value: rows.length ? new Set(rows.map((r) => r.itemCode)).size : null, format: 'integer', basis: 'distinct items' },
          { label: 'Average per requisition', value: requisitions ? round2(total / requisitions) : null, format: 'money', basis: 'value issued per requisition' },
        ],
        trend: monthly.length > 1 ? { title: 'Value issued, by month', valueLabel: 'Issued', format: 'money', points: monthly } : undefined,
        panels: (
          [
            { title: 'Material used, by department', question: 'ranking', format: 'money', points: topWithRest(byDept, 8) },
            { title: 'Material used, by category', question: 'composition', format: 'money', points: topWithRest(by((r) => r.category), 4) },
            { title: 'Biggest items used', question: 'pareto', format: 'money', points: byItem.slice(0, 12) },
            { title: 'Material used, by customer order', question: 'ranking', format: 'money', points: topWithRest(byCustomer, 8) },
          ] as Panel[]
        ).filter((p) => p.points.some((x) => x.value > 0)),
        insights,
        caveats: [
          'Only material issued against a requisition. Material sent to job workers is in the Job Work report.',
          "A customer's own material is listed by quantity at no value — it did not cost the mill anything.",
          'Value is at the rate the stock was carried at when it was issued.',
          'Style is as typed on the requisition line; lines without one show blank.',
        ],
      },
    }
  },
}
