import type { Prisma } from '@prisma/client'
import type { ReportDefinition, ReportFilter } from '../types'
import { byMonth, dateRangeFilters, dayRange, mean, round2, searchFilter, topWithRest } from './shared'

/**
 * The Sales reports. Each is one register a person would otherwise add up by
 * hand, with the totals and the few figures worth reading first.
 */

const customerFilter: ReportFilter = { key: 'customerId', label: 'Customer', type: 'select', optionsFrom: 'customers' }
const contains = (v: string) => ({ contains: v, mode: 'insensitive' as const })
const rupees = (n: number) => `₹${round2(n).toLocaleString('en-IN')}`
const gstOf = (l: { cgst: Prisma.Decimal | number; sgst: Prisma.Decimal | number; igst: Prisma.Decimal | number }) =>
  round2(Number(l.cgst) + Number(l.sgst) + Number(l.igst))

function rank<T>(rows: T[], key: (r: T) => string, value: (r: T) => number) {
  const m = new Map<string, number>()
  for (const r of rows) m.set(key(r) || '—', (m.get(key(r) || '—') ?? 0) + value(r))
  return [...m].map(([label, v]) => ({ label, value: round2(v) }))
}

// ── Sales register ─────────────────────────────────────────────────────────

export const salesRegister: ReportDefinition = {
  id: 'sales-register',
  module: 'sales',
  title: 'Sales Register',
  description: 'Every invoice line in the period — customer, garment, pieces, rate, taxable value and GST — for the accountant and for reading sales by customer, style or brand.',
  filters: [...dateRangeFilters, customerFilter, { ...searchFilter, help: 'Invoice, order or customer' }],
  columns: [
    { key: 'invoiceDate', label: 'Date', type: 'date', width: 12 },
    { key: 'invoiceNumber', label: 'Invoice', type: 'text', width: 16 },
    { key: 'customer', label: 'Customer', type: 'text', width: 28 },
    { key: 'gstin', label: 'GSTIN', type: 'text', width: 17 },
    { key: 'placeOfSupply', label: 'Place of supply', type: 'text', width: 8 },
    { key: 'soNumber', label: 'Order', type: 'text', width: 15 },
    { key: 'brand', label: 'Brand', type: 'text', width: 14 },
    { key: 'itemCode', label: 'Item code', type: 'text', width: 14 },
    { key: 'item', label: 'Item', type: 'text', width: 28 },
    { key: 'style', label: 'Style', type: 'text', width: 12 },
    { key: 'hsnCode', label: 'HSN', type: 'text', width: 9 },
    { key: 'qty', label: 'Pieces', type: 'qty', total: 'sum' },
    { key: 'rate', label: 'Rate', type: 'money', total: 'none' },
    { key: 'taxable', label: 'Taxable', type: 'money', total: 'sum' },
    { key: 'gstRate', label: 'GST %', type: 'percent', total: 'none' },
    { key: 'cgst', label: 'CGST', type: 'money', total: 'sum' },
    { key: 'sgst', label: 'SGST', type: 'money', total: 'sum' },
    { key: 'igst', label: 'IGST', type: 'money', total: 'sum' },
    { key: 'amount', label: 'Line total', type: 'money', total: 'sum' },
  ],
  summary: { title: 'Biggest invoice lines', columns: ['invoiceDate', 'invoiceNumber', 'customer', 'item', 'qty', 'taxable'], by: 'taxable', limit: 12 },
  pivot: { rows: ['customer', 'item'], values: ['qty', 'taxable', 'amount'], slicers: ['brand', 'style'], note: 'Open a customer to see what they bought.' },

  async run({ tx, params, rowCap }) {
    const range = dayRange(params)
    const invoice: Prisma.SalesInvoiceWhereInput = {
      status: { not: 'CANCELLED' },
      ...(params.customerId ? { customerId: params.customerId } : {}),
      ...(range ? { invoiceDate: range } : {}),
      ...(params.q ? { OR: [{ invoiceNumber: contains(params.q) }, { so: { soNumber: contains(params.q) } }, { customer: { name: contains(params.q) } }] } : {}),
    }
    const where: Prisma.SalesInvoiceLineWhereInput = { invoice }
    const totalRows = await tx.salesInvoiceLine.count({ where })
    const lines = await tx.salesInvoiceLine.findMany({
      where,
      take: rowCap,
      orderBy: [{ invoice: { invoiceDate: 'asc' } }, { invoice: { invoiceNumber: 'asc' } }, { sortOrder: 'asc' }],
      select: {
        qty: true,
        unitPrice: true,
        taxableValue: true,
        gstRate: true,
        cgst: true,
        sgst: true,
        igst: true,
        amount: true,
        hsnCode: true,
        item: { select: { code: true, name: true } },
        soLine: { select: { styleCode: true } },
        invoice: {
          select: {
            invoiceNumber: true,
            invoiceDate: true,
            placeOfSupplyCode: true,
            customer: { select: { name: true, gstin: true } },
            so: { select: { soNumber: true, brand: { select: { name: true } } } },
          },
        },
      },
    })
    const rows = lines.map((l) => ({
      invoiceDate: l.invoice.invoiceDate,
      invoiceNumber: l.invoice.invoiceNumber,
      customer: l.invoice.customer.name,
      gstin: l.invoice.customer.gstin ?? 'Unregistered',
      placeOfSupply: l.invoice.placeOfSupplyCode ?? '',
      soNumber: l.invoice.so?.soNumber ?? '',
      brand: l.invoice.so?.brand.name ?? '',
      itemCode: l.item.code,
      item: l.item.name,
      style: l.soLine?.styleCode ?? '',
      hsnCode: l.hsnCode ?? '',
      qty: Number(l.qty),
      rate: Number(l.unitPrice),
      taxable: Number(l.taxableValue),
      gstRate: Number(l.gstRate) / 100,
      cgst: Number(l.cgst),
      sgst: Number(l.sgst),
      igst: Number(l.igst),
      amount: Number(l.amount),
    }))
    const taxable = round2(rows.reduce((s, r) => s + r.taxable, 0))
    const pieces = rows.reduce((s, r) => s + r.qty, 0)
    const invoices = new Set(rows.map((r) => r.invoiceNumber)).size
    const byCustomer = rank(rows, (r) => r.customer, (r) => r.taxable).sort((a, b) => b.value - a.value)
    const insights: string[] = []
    if (byCustomer.length && taxable > 0) insights.push(`${byCustomer[0].label} is the biggest buyer — ${rupees(byCustomer[0].value)}, ${((byCustomer[0].value / taxable) * 100).toFixed(1)}% of sales.`)
    const top3 = byCustomer.slice(0, 3).reduce((s, c) => s + c.value, 0)
    if (byCustomer.length > 3 && taxable > 0) insights.push(`The top three customers make ${((top3 / taxable) * 100).toFixed(0)}% of the period's sales.`)
    return {
      rows,
      totalRows,
      analysis: {
        headline: rows.length ? `${invoices} invoices, ${pieces.toLocaleString('en-IN')} pieces, ${rupees(taxable)} before GST.` : 'No invoices were raised in this period.',
        kpis: [
          { label: 'Sales before GST', value: rows.length ? taxable : null, format: 'money', basis: `${invoices} invoices` },
          { label: 'Pieces invoiced', value: rows.length ? pieces : null, format: 'qty', basis: 'across all garments' },
          { label: 'GST charged', value: rows.length ? round2(rows.reduce((s, r) => s + r.cgst + r.sgst + r.igst, 0)) : null, format: 'money', basis: 'output tax on the goods' },
          { label: 'Average per piece', value: mean(taxable, pieces), format: 'money', basis: 'taxable value ÷ pieces' },
        ],
        trend: { title: 'Sales by month', valueLabel: 'Taxable', format: 'money', points: byMonth(rows, (r) => r.invoiceDate, (r) => r.taxable) },
        panels: [
          { title: 'Top customers', question: 'ranking', format: 'money', points: topWithRest(byCustomer, 8) },
          { title: 'By brand', question: 'composition', format: 'money', points: rank(rows, (r) => r.brand, (r) => r.taxable) },
        ],
        insights,
        caveats: ['Goods only: charges, other charges and credit notes are not on these lines. Returns are in the Sales Returns register.'],
      },
    }
  },
}

// ── Order book: what is still to send ──────────────────────────────────────

export const orderBook: ReportDefinition = {
  id: 'sales-order-book',
  module: 'sales',
  title: 'Order Book (Pending Orders)',
  description: 'Every confirmed order line with pieces still to send — ordered, sent, pending, its value and how late it is — the list production and dispatch work from.',
  filters: [customerFilter, { ...searchFilter, help: 'Order, buyer PO or customer' }],
  columns: [
    { key: 'soNumber', label: 'Order', type: 'text', width: 15 },
    { key: 'orderDate', label: 'Ordered', type: 'date', width: 12 },
    { key: 'deliveryDate', label: 'Delivery due', type: 'date', width: 12 },
    { key: 'daysLate', label: 'Days late', type: 'integer', total: 'none' },
    { key: 'customer', label: 'Customer', type: 'text', width: 28 },
    { key: 'buyerPo', label: 'Buyer PO', type: 'text', width: 14 },
    { key: 'status', label: 'Status', type: 'text', width: 14 },
    { key: 'item', label: 'Item', type: 'text', width: 28 },
    { key: 'style', label: 'Style', type: 'text', width: 12 },
    { key: 'ordered', label: 'Ordered', type: 'qty', total: 'sum' },
    { key: 'sent', label: 'Sent', type: 'qty', total: 'sum' },
    { key: 'pending', label: 'Pending', type: 'qty', total: 'sum' },
    { key: 'rate', label: 'Rate', type: 'money', total: 'none' },
    { key: 'pendingValue', label: 'Pending value', type: 'money', total: 'sum' },
  ],
  summary: { title: 'Latest orders', columns: ['soNumber', 'customer', 'item', 'pending', 'daysLate'], by: 'daysLate', limit: 12 },
  pivot: { rows: ['customer', 'soNumber'], values: ['pending', 'pendingValue'], slicers: ['status'] },

  async run({ tx, params, rowCap }) {
    const today = new Date()
    today.setHours(0, 0, 0, 0)
    const where: Prisma.SalesOrderLineWhereInput = {
      pendingQty: { gt: 0 },
      so: {
        status: { in: ['CONFIRMED', 'IN_PRODUCTION', 'PARTIALLY_DISPATCHED'] },
        ...(params.customerId ? { customerId: params.customerId } : {}),
        ...(params.q ? { OR: [{ soNumber: contains(params.q) }, { customerPORef: contains(params.q) }, { customer: { name: contains(params.q) } }] } : {}),
      },
    }
    const totalRows = await tx.salesOrderLine.count({ where })
    const lines = await tx.salesOrderLine.findMany({
      where,
      take: rowCap,
      orderBy: [{ so: { deliveryDate: { sort: 'asc', nulls: 'last' } } }, { so: { soNumber: 'asc' } }, { sortOrder: 'asc' }],
      select: {
        totalQty: true,
        deliveredQty: true,
        pendingQty: true,
        unitPrice: true,
        discount: true,
        styleCode: true,
        item: { select: { name: true } },
        so: { select: { soNumber: true, orderDate: true, deliveryDate: true, status: true, customerPORef: true, customer: { select: { name: true } } } },
      },
    })
    const rows = lines.map((l) => {
      const due = l.so.deliveryDate
      const late = due ? Math.floor((today.getTime() - new Date(due).setHours(0, 0, 0, 0)) / 86_400_000) : null
      return {
        soNumber: l.so.soNumber,
        orderDate: l.so.orderDate,
        deliveryDate: due,
        daysLate: late != null && late > 0 ? late : 0,
        customer: l.so.customer.name,
        buyerPo: l.so.customerPORef ?? '',
        status: l.so.status.replace(/_/g, ' ').toLowerCase(),
        item: l.item.name,
        style: l.styleCode ?? '',
        ordered: Number(l.totalQty),
        sent: Number(l.deliveredQty),
        pending: Number(l.pendingQty),
        rate: Number(l.unitPrice),
        pendingValue: round2(Number(l.pendingQty) * Number(l.unitPrice) * (1 - Number(l.discount) / 100)),
      }
    })
    const pending = rows.reduce((s, r) => s + r.pending, 0)
    const value = round2(rows.reduce((s, r) => s + r.pendingValue, 0))
    const late = rows.filter((r) => r.daysLate > 0)
    const lateValue = round2(late.reduce((s, r) => s + r.pendingValue, 0))
    return {
      rows,
      totalRows,
      analysis: {
        headline: rows.length ? `${pending.toLocaleString('en-IN')} pieces worth ${rupees(value)} still to send on ${new Set(rows.map((r) => r.soNumber)).size} orders.` : 'Nothing is pending: every confirmed order is sent.',
        kpis: [
          { label: 'Pieces pending', value: rows.length ? pending : null, format: 'qty', basis: 'confirmed, not yet sent' },
          { label: 'Pending value', value: rows.length ? value : null, format: 'money', basis: 'before GST' },
          { label: 'Late', value: rows.length ? lateValue : null, format: 'money', basis: `${late.length} lines past their delivery date`, tone: lateValue > 0 ? 'bad' : 'good' },
        ],
        panels: [
          {
            title: 'Pending by lateness',
            question: 'ageing',
            format: 'money',
            points: [
              { label: 'Not yet due', value: round2(rows.filter((r) => r.daysLate === 0).reduce((s, r) => s + r.pendingValue, 0)), tone: 'good' },
              { label: '1–7 days late', value: round2(rows.filter((r) => r.daysLate >= 1 && r.daysLate <= 7).reduce((s, r) => s + r.pendingValue, 0)), tone: 'warn' },
              { label: '8–30 days late', value: round2(rows.filter((r) => r.daysLate > 7 && r.daysLate <= 30).reduce((s, r) => s + r.pendingValue, 0)), tone: 'bad' },
              { label: 'Over 30 days late', value: round2(rows.filter((r) => r.daysLate > 30).reduce((s, r) => s + r.pendingValue, 0)), tone: 'bad' },
            ],
          },
          { title: 'Pending by customer', question: 'ranking', format: 'money', points: topWithRest(rank(rows, (r) => r.customer, (r) => r.pendingValue), 8) },
        ],
        insights: late.length ? [`${late.length} lines are past their delivery date; the latest is ${Math.max(...late.map((r) => r.daysLate))} days late.`] : [],
        caveats: ['Value is at the order rate before GST and before any discount on the whole order.'],
      },
    }
  },
}

// ── Dispatch register ──────────────────────────────────────────────────────

export const dispatchRegister: ReportDefinition = {
  id: 'sales-dispatch-register',
  module: 'sales',
  title: 'Dispatch Register',
  description: 'Every challan line sent in the period — customer, order, garment, pieces, transport and whether it is billed.',
  filters: [...dateRangeFilters, customerFilter, { ...searchFilter, help: 'Challan, order, LR or vehicle' }],
  columns: [
    { key: 'dcDate', label: 'Date', type: 'date', width: 12 },
    { key: 'dcNumber', label: 'Challan', type: 'text', width: 15 },
    { key: 'customer', label: 'Customer', type: 'text', width: 28 },
    { key: 'soNumber', label: 'Order', type: 'text', width: 15 },
    { key: 'item', label: 'Item', type: 'text', width: 28 },
    { key: 'sizes', label: 'Sizes', type: 'text', width: 26 },
    { key: 'qty', label: 'Pieces', type: 'qty', total: 'sum' },
    { key: 'store', label: 'From store', type: 'text', width: 16 },
    { key: 'transporter', label: 'Transporter', type: 'text', width: 16 },
    { key: 'lrNumber', label: 'LR', type: 'text', width: 12 },
    { key: 'eWayBill', label: 'E-way bill', type: 'text', width: 14 },
    { key: 'invoice', label: 'Invoice', type: 'text', width: 15 },
    { key: 'status', label: 'Status', type: 'text', width: 11 },
  ],
  pivot: { rows: ['customer', 'item'], values: ['qty'], slicers: ['status', 'store'] },

  async run({ tx, params, rowCap }) {
    const range = dayRange(params)
    const where: Prisma.DeliveryChallanLineWhereInput = {
      dc: {
        status: { in: ['DISPATCHED', 'DELIVERED'] },
        ...(params.customerId ? { customerId: params.customerId } : {}),
        ...(range ? { dcDate: range } : {}),
        ...(params.q ? { OR: [{ dcNumber: contains(params.q) }, { so: { soNumber: contains(params.q) } }, { lrNumber: contains(params.q) }, { vehicleNumber: contains(params.q) }] } : {}),
      },
    }
    const totalRows = await tx.deliveryChallanLine.count({ where })
    const lines = await tx.deliveryChallanLine.findMany({
      where,
      take: rowCap,
      orderBy: [{ dc: { dcDate: 'asc' } }, { dc: { dcNumber: 'asc' } }],
      select: {
        qty: true,
        item: { select: { name: true } },
        sizes: { select: { qty: true, size: { select: { code: true, sequence: true } } }, orderBy: { size: { sequence: 'asc' } } },
        dc: {
          select: {
            dcNumber: true,
            dcDate: true,
            status: true,
            transporter: true,
            lrNumber: true,
            eWayBillNumber: true,
            customer: { select: { name: true } },
            so: { select: { soNumber: true } },
            warehouse: { select: { name: true } },
            invoices: { where: { status: { not: 'CANCELLED' } }, select: { invoiceNumber: true } },
          },
        },
      },
    })
    const rows = lines.map((l) => ({
      dcDate: l.dc.dcDate,
      dcNumber: l.dc.dcNumber,
      customer: l.dc.customer?.name ?? '',
      soNumber: l.dc.so.soNumber,
      item: l.item?.name ?? '',
      sizes: l.sizes.map((s) => `${s.size.code} ${Number(s.qty)}`).join(', '),
      qty: Number(l.qty),
      store: l.dc.warehouse?.name ?? '',
      transporter: l.dc.transporter ?? '',
      lrNumber: l.dc.lrNumber ?? '',
      eWayBill: l.dc.eWayBillNumber ?? '',
      invoice: l.dc.invoices[0]?.invoiceNumber ?? 'Not billed',
      status: l.dc.status.toLowerCase(),
    }))
    const pieces = rows.reduce((s, r) => s + r.qty, 0)
    const unbilled = new Set(rows.filter((r) => r.invoice === 'Not billed').map((r) => r.dcNumber)).size
    return {
      rows,
      totalRows,
      analysis: {
        headline: rows.length ? `${pieces.toLocaleString('en-IN')} pieces sent on ${new Set(rows.map((r) => r.dcNumber)).size} challans.` : 'Nothing was dispatched in this period.',
        kpis: [
          { label: 'Pieces sent', value: rows.length ? pieces : null, format: 'qty', basis: 'dispatched or delivered' },
          { label: 'Challans not billed', value: rows.length ? unbilled : null, format: 'integer', basis: 'waiting for their invoice', tone: unbilled > 0 ? 'warn' : 'good' },
        ],
        trend: { title: 'Pieces sent by month', valueLabel: 'Pieces', format: 'qty', points: byMonth(rows, (r) => r.dcDate, (r) => r.qty) },
        panels: [{ title: 'Pieces by customer', question: 'ranking', format: 'qty', points: topWithRest(rank(rows, (r) => r.customer, (r) => r.qty), 8) }],
        insights: unbilled ? [`${unbilled} challans have gone without an invoice — see Sales → Invoices → Waiting to invoice.`] : [],
        caveats: [],
      },
    }
  },
}

// ── Customer outstanding, aged ─────────────────────────────────────────────

export const customerOutstanding: ReportDefinition = {
  id: 'sales-customer-outstanding',
  module: 'sales',
  title: 'Customer Outstanding (Ageing)',
  description: 'Every unpaid or part-paid invoice, aged from its due date: not yet due, 1–30, 31–60, 61–90 and over 90 days — what is owed and by whom.',
  filters: [customerFilter],
  columns: [
    { key: 'customer', label: 'Customer', type: 'text', width: 28 },
    { key: 'invoiceNumber', label: 'Invoice', type: 'text', width: 16 },
    { key: 'invoiceDate', label: 'Invoice date', type: 'date', width: 12 },
    { key: 'dueDate', label: 'Due', type: 'date', width: 12 },
    { key: 'daysOverdue', label: 'Days overdue', type: 'integer', total: 'none' },
    { key: 'bucket', label: 'Age', type: 'text', width: 14 },
    { key: 'total', label: 'Invoice total', type: 'money', total: 'sum' },
    { key: 'received', label: 'Received', type: 'money', total: 'sum' },
    { key: 'balance', label: 'Balance', type: 'money', total: 'sum' },
  ],
  pivot: { rows: ['customer', 'bucket'], values: ['balance'] },

  async run({ tx, params, rowCap }) {
    const today = new Date()
    today.setHours(0, 0, 0, 0)
    const where: Prisma.SalesInvoiceWhereInput = { status: { in: ['UNPAID', 'PARTIAL'] }, ...(params.customerId ? { customerId: params.customerId } : {}) }
    const totalRows = await tx.salesInvoice.count({ where })
    const invoices = await tx.salesInvoice.findMany({
      where,
      take: rowCap,
      orderBy: [{ dueDate: 'asc' }, { invoiceDate: 'asc' }],
      select: { invoiceNumber: true, invoiceDate: true, dueDate: true, totalAmount: true, paidAmount: true, tdsAmount: true, creditedAmount: true, balanceAmount: true, customer: { select: { name: true } } },
    })
    const rows = invoices.map((i) => {
      const ref = new Date(i.dueDate ?? i.invoiceDate)
      ref.setHours(0, 0, 0, 0)
      const days = Math.floor((today.getTime() - ref.getTime()) / 86_400_000)
      return {
        customer: i.customer.name,
        invoiceNumber: i.invoiceNumber,
        invoiceDate: i.invoiceDate,
        dueDate: i.dueDate,
        daysOverdue: Math.max(0, days),
        bucket: days <= 0 ? 'Not yet due' : days <= 30 ? '1–30 days' : days <= 60 ? '31–60 days' : days <= 90 ? '61–90 days' : 'Over 90 days',
        total: Number(i.totalAmount),
        received: round2(Number(i.paidAmount) + Number(i.tdsAmount) + Number(i.creditedAmount)),
        balance: Number(i.balanceAmount),
      }
    })
    const owed = round2(rows.reduce((s, r) => s + r.balance, 0))
    const overdue = round2(rows.filter((r) => r.daysOverdue > 0).reduce((s, r) => s + r.balance, 0))
    const buckets = ['Not yet due', '1–30 days', '31–60 days', '61–90 days', 'Over 90 days']
    return {
      rows,
      totalRows,
      analysis: {
        headline: rows.length ? `${rupees(owed)} owed on ${rows.length} invoices, ${rupees(overdue)} of it overdue.` : 'Nothing is owed on invoices raised here.',
        kpis: [
          { label: 'Owed', value: rows.length ? owed : null, format: 'money', basis: `${rows.length} open invoices` },
          { label: 'Overdue', value: rows.length ? overdue : null, format: 'money', basis: 'past the due date', tone: overdue > 0 ? 'bad' : 'good' },
          { label: 'Customers owing', value: rows.length ? new Set(rows.map((r) => r.customer)).size : null, format: 'integer', basis: 'with an open invoice' },
        ],
        panels: [
          {
            title: 'Owed by age',
            question: 'ageing',
            format: 'money',
            points: buckets.map((b, i) => ({ label: b, value: round2(rows.filter((r) => r.bucket === b).reduce((s, r) => s + r.balance, 0)), tone: i === 0 ? 'good' : i === 1 ? 'warn' : 'bad' })),
          },
          { title: 'Owed by customer', question: 'ranking', format: 'money', points: topWithRest(rank(rows, (r) => r.customer, (r) => r.balance), 8) },
        ],
        insights: [],
        caveats: ['Dues from the old system before this ERP are not here. Advances and credit held by a customer are on Payments Received → Outstanding.'],
      },
    }
  },
}

// ── Brokerage ──────────────────────────────────────────────────────────────

export const brokerageReport: ReportDefinition = {
  id: 'sales-brokerage',
  module: 'sales',
  title: 'Brokerage',
  description: 'Brokerage earned by each agent on the invoices in the period, at the order rate, on the taxable value — with whether the invoice is paid yet.',
  filters: [...dateRangeFilters, customerFilter],
  columns: [
    { key: 'broker', label: 'Broker', type: 'text', width: 24 },
    { key: 'invoiceDate', label: 'Date', type: 'date', width: 12 },
    { key: 'invoiceNumber', label: 'Invoice', type: 'text', width: 16 },
    { key: 'customer', label: 'Customer', type: 'text', width: 28 },
    { key: 'taxable', label: 'Taxable value', type: 'money', total: 'sum' },
    { key: 'percent', label: 'Brokerage %', type: 'percent', total: 'none' },
    { key: 'brokerage', label: 'Brokerage', type: 'money', total: 'sum' },
    { key: 'paid', label: 'Invoice status', type: 'text', width: 12 },
  ],
  pivot: { rows: ['broker', 'customer'], values: ['taxable', 'brokerage'] },

  async run({ tx, params, rowCap }) {
    const range = dayRange(params)
    const where: Prisma.SalesInvoiceWhereInput = {
      status: { not: 'CANCELLED' },
      brokerId: { not: null },
      ...(params.customerId ? { customerId: params.customerId } : {}),
      ...(range ? { invoiceDate: range } : {}),
    }
    const totalRows = await tx.salesInvoice.count({ where })
    const invoices = await tx.salesInvoice.findMany({
      where,
      take: rowCap,
      orderBy: [{ invoiceDate: 'asc' }],
      select: { invoiceNumber: true, invoiceDate: true, taxableAmount: true, brokeragePercent: true, brokerageAmount: true, status: true, broker: { select: { name: true } }, customer: { select: { name: true } } },
    })
    const rows = invoices.map((i) => ({
      broker: i.broker?.name ?? '',
      invoiceDate: i.invoiceDate,
      invoiceNumber: i.invoiceNumber,
      customer: i.customer.name,
      taxable: Number(i.taxableAmount),
      percent: Number(i.brokeragePercent ?? 0) / 100,
      brokerage: Number(i.brokerageAmount),
      paid: i.status === 'PAID' ? 'Paid' : i.status === 'PARTIAL' ? 'Part paid' : 'Unpaid',
    }))
    const total = round2(rows.reduce((s, r) => s + r.brokerage, 0))
    const onPaid = round2(rows.filter((r) => r.paid === 'Paid').reduce((s, r) => s + r.brokerage, 0))
    return {
      rows,
      totalRows,
      analysis: {
        headline: rows.length ? `${rupees(total)} brokerage on ${rows.length} invoices, ${rupees(onPaid)} of it on invoices already paid.` : 'No brokered invoices in this period.',
        kpis: [
          { label: 'Brokerage', value: rows.length ? total : null, format: 'money', basis: 'at each order’s rate' },
          { label: 'On paid invoices', value: rows.length ? onPaid : null, format: 'money', basis: 'the customer has paid' },
        ],
        panels: [{ title: 'By broker', question: 'ranking', format: 'money', points: rank(rows, (r) => r.broker, (r) => r.brokerage).sort((a, b) => b.value - a.value) }],
        insights: [],
        caveats: ['Worked on the taxable value before GST — to confirm with the accountant. TDS under section 194H is deducted when the broker is paid, not shown here.'],
      },
    }
  },
}

// ── Sales returns ──────────────────────────────────────────────────────────

export const salesReturnsRegister: ReportDefinition = {
  id: 'sales-returns-register',
  module: 'sales',
  title: 'Sales Returns & Credit Notes',
  description: 'Every credit note in the period — goods returned and amounts credited — with the invoice it reduces and why.',
  filters: [...dateRangeFilters, customerFilter],
  columns: [
    { key: 'noteDate', label: 'Date', type: 'date', width: 12 },
    { key: 'noteNumber', label: 'Credit note', type: 'text', width: 15 },
    { key: 'kind', label: 'Kind', type: 'text', width: 12 },
    { key: 'customer', label: 'Customer', type: 'text', width: 28 },
    { key: 'invoice', label: 'Against invoice', type: 'text', width: 15 },
    { key: 'item', label: 'Item', type: 'text', width: 26 },
    { key: 'hsnCode', label: 'HSN', type: 'text', width: 9 },
    { key: 'qty', label: 'Pieces back', type: 'qty', total: 'sum' },
    { key: 'taxable', label: 'Taxable', type: 'money', total: 'sum' },
    { key: 'gst', label: 'GST', type: 'money', total: 'sum' },
    { key: 'amount', label: 'Total', type: 'money', total: 'sum' },
    { key: 'reason', label: 'Reason', type: 'text', width: 30 },
  ],
  pivot: { rows: ['customer', 'item'], values: ['qty', 'taxable'], slicers: ['kind'] },

  async run({ tx, params, rowCap }) {
    const range = dayRange(params)
    const where: Prisma.CreditNoteLineWhereInput = {
      note: { status: 'ISSUED', ...(params.customerId ? { customerId: params.customerId } : {}), ...(range ? { noteDate: range } : {}) },
    }
    const totalRows = await tx.creditNoteLine.count({ where })
    const lines = await tx.creditNoteLine.findMany({
      where,
      take: rowCap,
      orderBy: [{ note: { noteDate: 'asc' } }, { sortOrder: 'asc' }],
      select: {
        qty: true,
        hsnCode: true,
        taxableValue: true,
        cgst: true,
        sgst: true,
        igst: true,
        amount: true,
        item: { select: { name: true } },
        note: { select: { noteNumber: true, noteDate: true, type: true, reason: true, customer: { select: { name: true } }, invoice: { select: { invoiceNumber: true } } } },
      },
    })
    const rows = lines.map((l) => ({
      noteDate: l.note.noteDate,
      noteNumber: l.note.noteNumber,
      kind: l.note.type === 'RETURN' ? 'Return' : 'Amount only',
      customer: l.note.customer.name,
      invoice: l.note.invoice?.invoiceNumber ?? '',
      item: l.item.name,
      hsnCode: l.hsnCode ?? '',
      qty: Number(l.qty),
      taxable: Number(l.taxableValue),
      gst: gstOf(l),
      amount: Number(l.amount),
      reason: l.note.reason ?? '',
    }))
    const value = round2(rows.reduce((s, r) => s + r.taxable, 0))
    return {
      rows,
      totalRows,
      analysis: {
        headline: rows.length ? `${rupees(value)} credited before GST, ${rows.reduce((s, r) => s + r.qty, 0).toLocaleString('en-IN')} pieces back.` : 'No credit notes in this period.',
        kpis: [
          { label: 'Credited before GST', value: rows.length ? value : null, format: 'money', basis: `${new Set(rows.map((r) => r.noteNumber)).size} credit notes` },
          { label: 'Pieces returned', value: rows.length ? rows.reduce((s, r) => s + r.qty, 0) : null, format: 'qty', basis: 'back into stock' },
        ],
        panels: [{ title: 'Returns by reason', question: 'ranking', format: 'money', points: topWithRest(rank(rows, (r) => r.reason, (r) => r.taxable), 8) }],
        insights: [],
        caveats: [],
      },
    }
  },
}

// ── GSTR-1 HSN summary ─────────────────────────────────────────────────────

export const outwardHsnSummary: ReportDefinition = {
  id: 'sales-hsn-summary',
  module: 'sales',
  title: 'Outward Supplies by HSN (GSTR-1)',
  description: 'Sales in the period by HSN code and GST rate — pieces, taxable value and tax — less credit notes, as the HSN summary of GSTR-1 asks for it.',
  filters: [...dateRangeFilters],
  columns: [
    { key: 'hsnCode', label: 'HSN', type: 'text', width: 10 },
    { key: 'rate', label: 'Rate', type: 'percent', total: 'none' },
    { key: 'qty', label: 'Pieces (net)', type: 'qty', total: 'sum' },
    { key: 'taxable', label: 'Taxable (net)', type: 'money', total: 'sum' },
    { key: 'cgst', label: 'CGST', type: 'money', total: 'sum' },
    { key: 'sgst', label: 'SGST', type: 'money', total: 'sum' },
    { key: 'igst', label: 'IGST', type: 'money', total: 'sum' },
    { key: 'credited', label: 'Of which credit notes', type: 'money', total: 'sum' },
  ],

  async run({ tx, params }) {
    const range = dayRange(params)
    const [lines, credits] = await Promise.all([
      tx.salesInvoiceLine.findMany({
        where: { invoice: { status: { not: 'CANCELLED' }, ...(range ? { invoiceDate: range } : {}) } },
        select: { hsnCode: true, gstRate: true, qty: true, taxableValue: true, cgst: true, sgst: true, igst: true },
      }),
      tx.creditNoteLine.findMany({
        where: { note: { status: 'ISSUED', ...(range ? { noteDate: range } : {}) } },
        select: { hsnCode: true, gstRate: true, qty: true, taxableValue: true, cgst: true, sgst: true, igst: true },
      }),
    ])
    const m = new Map<string, { hsnCode: string; rate: number; qty: number; taxable: number; cgst: number; sgst: number; igst: number; credited: number }>()
    const add = (l: (typeof lines)[number], sign: 1 | -1) => {
      const key = `${l.hsnCode ?? '—'}|${Number(l.gstRate)}`
      const e = m.get(key) ?? { hsnCode: l.hsnCode ?? '—', rate: Number(l.gstRate) / 100, qty: 0, taxable: 0, cgst: 0, sgst: 0, igst: 0, credited: 0 }
      e.qty += sign * Number(l.qty)
      e.taxable += sign * Number(l.taxableValue)
      e.cgst += sign * Number(l.cgst)
      e.sgst += sign * Number(l.sgst)
      e.igst += sign * Number(l.igst)
      if (sign < 0) e.credited += Number(l.taxableValue)
      m.set(key, e)
    }
    lines.forEach((l) => add(l, 1))
    credits.forEach((l) => add(l, -1))
    const rows = [...m.values()].map((e) => ({ ...e, qty: round2(e.qty), taxable: round2(e.taxable), cgst: round2(e.cgst), sgst: round2(e.sgst), igst: round2(e.igst), credited: round2(e.credited) }))
    const taxable = round2(rows.reduce((s, r) => s + r.taxable, 0))
    const tax = round2(rows.reduce((s, r) => s + r.cgst + r.sgst + r.igst, 0))
    return {
      rows,
      analysis: {
        headline: rows.length ? `${rupees(taxable)} taxable and ${rupees(tax)} GST across ${rows.length} HSN-rate rows.` : 'No outward supplies in this period.',
        kpis: [
          { label: 'Taxable value', value: rows.length ? taxable : null, format: 'money', basis: 'invoices less credit notes' },
          { label: 'Output GST', value: rows.length ? tax : null, format: 'money', basis: 'CGST + SGST + IGST' },
        ],
        panels: [{ title: 'Taxable by HSN', question: 'composition', format: 'money', points: rank(rows, (r) => r.hsnCode, (r) => r.taxable) }],
        insights: [],
        caveats: ['Goods only: charges on invoices (transport, packing) are services with their own SAC codes and are not included here.'],
      },
    }
  },
}

export const SALES_REPORTS: ReportDefinition[] = [
  salesRegister,
  orderBook,
  dispatchRegister,
  customerOutstanding,
  brokerageReport,
  salesReturnsRegister,
  outwardHsnSummary,
]
