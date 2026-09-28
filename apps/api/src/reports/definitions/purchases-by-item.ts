import type { Prisma } from '@prisma/client'
import type { Panel, ReportDefinition } from '../types'
import {
  byMonth,
  dateRangeFilters,
  dayRange,
  itemFilter,
  mean,
  round2,
  searchFilter,
  supplierFilter,
  topWithRest,
} from './shared'

/**
 * What was bought, item by item, at what rate and from whom.
 *
 * One row per bill line, so the pivot can fold it by item, by supplier or by
 * both. Built off the bills rather than the receipts: this is what the mill
 * was charged, which is what a buyer comparing rates needs, and a receipt
 * only knows what the order said the rate would be.
 */
export const purchasesByItem: ReportDefinition = {
  id: 'purchases-by-item',
  module: 'purchase',
  title: 'Purchases by Item',
  description:
    'Every item on a supplier bill in the period — quantity, rate, taxable value and GST — so purchases can be read item by item and rate against rate.',
  filters: [
    ...dateRangeFilters,
    supplierFilter,
    itemFilter,
    { ...searchFilter, help: 'Our bill ref, their bill number or supplier name' },
  ],
  columns: [
    { key: 'billDate', label: 'Booked On', type: 'date', width: 14 },
    { key: 'billNumber', label: 'Our Ref', type: 'text', width: 16 },
    { key: 'supplierInvoiceNo', label: 'Their Bill No.', type: 'text', width: 18 },
    { key: 'supplier', label: 'Supplier', type: 'text', width: 28 },
    { key: 'category', label: 'Category', type: 'text', width: 18 },
    { key: 'itemCode', label: 'Item Code', type: 'text', width: 16 },
    { key: 'item', label: 'Item', type: 'text', width: 30 },
    { key: 'hsnCode', label: 'HSN', type: 'text', width: 10 },
    { key: 'uom', label: 'UOM', type: 'text', width: 8 },
    { key: 'qty', label: 'Qty', type: 'qty', total: 'sum' },
    { key: 'rate', label: 'Rate', type: 'money', total: 'none' },
    { key: 'discount', label: 'Disc %', type: 'percent', total: 'none' },
    { key: 'taxable', label: 'Taxable', type: 'money', total: 'sum' },
    { key: 'gstRate', label: 'GST %', type: 'percent', total: 'none' },
    { key: 'gst', label: 'GST', type: 'money', total: 'sum' },
    { key: 'amount', label: 'Line Total', type: 'money', total: 'sum' },
    { key: 'grnNumber', label: 'GRN No.', type: 'text', width: 16 },
  ],

  summary: {
    title: 'Biggest purchase lines in this period',
    columns: ['billDate', 'billNumber', 'supplier', 'item', 'qty', 'rate', 'taxable'],
    by: 'taxable',
    limit: 12,
  },

  pivot: {
    rows: ['item', 'supplier'],
    values: ['qty', 'taxable', 'gst', 'amount'],
    slicers: ['category', 'uom'],
    note: 'Open an item to see which suppliers it was bought from. Pick a UOM before reading a quantity total.',
  },

  async run({ tx, params, rowCap }) {
    const range = dayRange(params)
    const contains = (v: string) => ({ contains: v, mode: 'insensitive' as const })

    // A cancelled bill charged the mill nothing.
    const billWhere: Prisma.PurchaseInvoiceWhereInput = {
      status: { not: 'CANCELLED' },
      ...(params.supplierId ? { supplierId: params.supplierId } : {}),
      ...(range ? { billDate: range } : {}),
      ...(params.q
        ? {
            OR: [
              { billNumber: contains(params.q) },
              { supplierInvoiceNo: contains(params.q) },
              { supplier: { name: contains(params.q) } },
            ],
          }
        : {}),
    }
    const where: Prisma.PurchaseInvoiceLineWhereInput = {
      bill: billWhere,
      ...(params.itemId ? { itemId: params.itemId } : {}),
    }

    const cancelled = await tx.purchaseInvoice.count({
      where: {
        status: 'CANCELLED',
        ...(range ? { billDate: range } : {}),
        ...(params.supplierId ? { supplierId: params.supplierId } : {}),
      },
    })
    const totalRows = await tx.purchaseInvoiceLine.count({ where })
    const lines = await tx.purchaseInvoiceLine.findMany({
      where,
      take: rowCap,
      orderBy: [
        { bill: { billDate: 'asc' } },
        { bill: { billNumber: 'asc' } },
        { sortOrder: 'asc' },
      ],
      select: {
        qty: true,
        unitPrice: true,
        discount: true,
        taxableValue: true,
        gstRate: true,
        cgst: true,
        sgst: true,
        igst: true,
        amount: true,
        hsnCode: true,
        item: {
          select: {
            code: true,
            name: true,
            hsnCode: true,
            uom: { select: { symbol: true } },
            category: { select: { name: true } },
          },
        },
        grnLine: { select: { grn: { select: { grnNumber: true } } } },
        bill: {
          select: {
            billNumber: true,
            billDate: true,
            supplierInvoiceNo: true,
            supplier: { select: { name: true } },
          },
        },
      },
    })

    const rows = lines.map((l) => {
      const gst = round2(Number(l.cgst) + Number(l.sgst) + Number(l.igst))
      return {
        billDate: l.bill.billDate,
        billNumber: l.bill.billNumber,
        supplierInvoiceNo: l.bill.supplierInvoiceNo ?? '',
        supplier: l.bill.supplier?.name ?? '',
        category: l.item.category?.name ?? '',
        itemCode: l.item.code,
        item: l.item.name,
        hsnCode: l.hsnCode ?? l.item.hsnCode ?? '',
        uom: l.item.uom?.symbol ?? '',
        qty: Number(l.qty),
        rate: Number(l.unitPrice),
        // Stored as a whole-number percentage; the workbook's percent columns
        // take a fraction.
        discount: Number(l.discount) / 100,
        taxable: Number(l.taxableValue),
        gstRate: Number(l.gstRate) / 100,
        gst,
        amount: Number(l.amount),
        grnNumber: l.grnLine?.grn?.grnNumber ?? '',
      }
    })

    const taxable = round2(rows.reduce((s, r) => s + r.taxable, 0))
    const gst = round2(rows.reduce((s, r) => s + r.gst, 0))
    const bills = new Set(rows.map((r) => r.billNumber)).size

    const byItem = new Map<
      string,
      { value: number; qty: number; uom: string; rates: number[]; suppliers: Set<string> }
    >()
    for (const r of rows) {
      const e = byItem.get(r.item) ?? {
        value: 0,
        qty: 0,
        uom: r.uom,
        rates: [],
        suppliers: new Set<string>(),
      }
      e.value += r.taxable
      e.qty += r.qty
      e.rates.push(r.rate)
      e.suppliers.add(r.supplier)
      byItem.set(r.item, e)
    }
    const byCategory = new Map<string, number>()
    for (const r of rows) {
      const c = r.category || 'No category'
      byCategory.set(c, (byCategory.get(c) ?? 0) + r.taxable)
    }
    const bySupplier = new Map<string, number>()
    for (const r of rows) bySupplier.set(r.supplier, (bySupplier.get(r.supplier) ?? 0) + r.taxable)

    const ranked = [...byItem].sort((a, b) => b[1].value - a[1].value)
    const insights: string[] = []
    if (ranked.length) {
      const [name, top] = ranked[0]
      insights.push(
        `${name} is the biggest purchase — ₹${round2(top.value).toLocaleString('en-IN')} for ${round2(top.qty).toLocaleString('en-IN')} ${top.uom}, ${taxable ? ((top.value / taxable) * 100).toFixed(1) : '0'}% of the period.`
      )
    }
    // Where the same item was bought at more than one rate — the thing a buyer
    // wants to know before placing the next order.
    const spread = ranked
      .map(([name, e]) => ({
        name,
        lo: Math.min(...e.rates),
        hi: Math.max(...e.rates),
        n: e.suppliers.size,
        uom: e.uom,
      }))
      .filter((e) => e.hi > e.lo)
      .slice(0, 3)
    for (const s of spread) {
      insights.push(
        `${s.name} was bought at ₹${s.lo.toLocaleString('en-IN')} to ₹${s.hi.toLocaleString('en-IN')} per ${s.uom || 'unit'} from ${s.n} supplier${s.n === 1 ? '' : 's'}.`
      )
    }

    const monthly = byMonth(
      rows,
      (r) => r.billDate,
      (r) => r.taxable
    )

    return {
      rows,
      totalRows,
      analysis: {
        headline:
          rows.length === 0
            ? 'No supplier bills were booked in this period.'
            : `${byItem.size} items bought on ${bills} bills, ₹${taxable.toLocaleString('en-IN')} before tax.`,
        kpis: [
          {
            label: 'Items bought',
            value: rows.length ? byItem.size : null,
            format: 'integer',
            basis: `on ${rows.length} bill lines`,
          },
          {
            label: 'Taxable value',
            value: rows.length ? taxable : null,
            format: 'money',
            basis: `across ${bills} bills`,
          },
          {
            label: 'GST charged',
            value: rows.length ? gst : null,
            format: 'money',
            basis: 'input tax on these lines',
          },
          {
            label: 'Average per item',
            value: mean(taxable, byItem.size),
            format: 'money',
            basis: 'taxable value per distinct item',
          },
        ],
        trend:
          monthly.length > 1
            ? {
                title: 'Taxable value bought, by month',
                valueLabel: 'Taxable',
                format: 'money',
                points: monthly,
              }
            : undefined,
        panels: (
          [
            {
              title: 'Biggest items by value',
              question: 'ranking',
              format: 'money',
              points: topWithRest(
                ranked.map(([label, e]) => ({ label, value: round2(e.value) })),
                8
              ),
            },
            {
              title: 'Spend by category',
              question: 'composition',
              format: 'money',
              points: topWithRest(
                [...byCategory].map(([label, value]) => ({ label, value: round2(value) })),
                4
              ),
            },
            {
              title: 'Biggest suppliers for these items',
              question: 'ranking',
              format: 'money',
              points: topWithRest(
                [...bySupplier].map(([label, value]) => ({ label, value: round2(value) })),
                8
              ),
            },
          ] as Panel[]
        ).filter((p) => p.points.some((x) => x.value > 0)),
        insights,
        caveats: [
          cancelled > 0
            ? `${cancelled} cancelled bill${cancelled === 1 ? '' : 's'} in this period ${cancelled === 1 ? 'is' : 'are'} left out.`
            : 'No cancelled bills fell in this period.',
          'Values are as billed. Debit and credit notes against these bills are not netted off — see the Purchase Adjustment Register.',
          'Charges on a bill (freight, packing) and bill-level discounts are not spread across its items.',
          'Quantities are in each item’s own unit. Read a quantity total per item, not down the whole sheet.',
        ],
      },
    }
  },
}
