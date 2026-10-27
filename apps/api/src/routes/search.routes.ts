import { Router } from 'express'
import { prisma } from '@ld-erp/database'
import { userCan, type AuthRequest } from '../middleware/auth'

/*
 * One search for the Ctrl+K palette: a few letters of a document number, a
 * party, an item or a style, and the records that have them, newest first.
 *
 * Reads only. Each kind is searched only for somebody who may see its list,
 * so the palette never offers a record its list would refuse to show. A hit
 * names the list it is on and what to type in that list's search to find it
 * there; the list opens it, with its own checks.
 */

const router = Router()

interface Hit {
  kind: string
  number: string
  title: string
  sub?: string | null
  path: string
  term: string
}

const TAKE = 4
const day = (d: Date | null | undefined) => (d ? d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }) : null)
const has = (q: string) => ({ contains: q, mode: 'insensitive' as const })
const newest = { createdAt: 'desc' as const }
/** PARTIALLY_RECEIVED -> "Partially received". */
const said = (status: string) => status.charAt(0) + status.slice(1).toLowerCase().replace(/_/g, ' ')

router.get('/', async (req: AuthRequest, res) => {
  const q = typeof req.query.q === 'string' ? req.query.q.trim().slice(0, 60) : ''
  if (q.length < 2) return res.json({ success: true, data: [] })
  const may = (module: string) => userCan(req.user, module, 'view')

  const jobs: Array<Promise<Hit[]>> = []

  if (may('sales')) {
    jobs.push(
      prisma.salesOrder
        .findMany({
          where: { OR: [{ soNumber: has(q) }, { customer: { name: has(q) } }] },
          select: { soNumber: true, status: true, orderDate: true, customer: { select: { name: true } } },
          orderBy: newest,
          take: TAKE,
        })
        .then((rows) => rows.map((r) => ({ kind: 'Sales order', number: r.soNumber, title: r.customer.name, sub: `${said(r.status)} · ${day(r.orderDate)}`, path: '/sales/orders', term: r.soNumber }))),
      prisma.salesQuotation
        .findMany({
          where: { OR: [{ quoteNumber: has(q) }, { customer: { name: has(q) } }] },
          select: { quoteNumber: true, status: true, customer: { select: { name: true } } },
          orderBy: newest,
          take: TAKE,
        })
        .then((rows) => rows.map((r) => ({ kind: 'Quotation', number: r.quoteNumber, title: r.customer.name, sub: said(r.status), path: '/sales/quotations', term: r.quoteNumber }))),
      prisma.salesInvoice
        .findMany({
          where: { OR: [{ invoiceNumber: has(q) }, { customer: { name: has(q) } }] },
          select: { invoiceNumber: true, status: true, invoiceDate: true, customer: { select: { name: true } } },
          orderBy: newest,
          take: TAKE,
        })
        .then((rows) => rows.map((r) => ({ kind: 'Sales invoice', number: r.invoiceNumber, title: r.customer.name, sub: `${said(r.status)} · ${day(r.invoiceDate)}`, path: '/sales/invoices', term: r.invoiceNumber }))),
      prisma.deliveryChallan
        .findMany({
          where: { OR: [{ dcNumber: has(q) }, { customer: { name: has(q) } }] },
          select: { dcNumber: true, status: true, dcDate: true, customer: { select: { name: true } } },
          orderBy: newest,
          take: TAKE,
        })
        .then((rows) => rows.map((r) => ({ kind: 'Delivery challan', number: r.dcNumber, title: r.customer?.name ?? 'Challan', sub: `${said(r.status)} · ${day(r.dcDate)}`, path: '/sales/challan', term: r.dcNumber }))),
    )
  }

  if (may('purchase')) {
    jobs.push(
      prisma.purchaseEnquiry
        .findMany({
          where: { deletedAt: null, enquiryNumber: has(q) },
          select: { enquiryNumber: true, status: true, enquiryDate: true },
          orderBy: newest,
          take: TAKE,
        })
        .then((rows) => rows.map((r) => ({ kind: 'Purchase enquiry', number: r.enquiryNumber, title: 'Enquiry', sub: `${said(r.status)} · ${day(r.enquiryDate)}`, path: '/purchase/enquiries', term: r.enquiryNumber }))),
      prisma.purchaseOrder
        .findMany({
          where: { deletedAt: null, OR: [{ poNumber: has(q) }, { supplier: { name: has(q) } }] },
          select: { poNumber: true, status: true, poDate: true, supplier: { select: { name: true } } },
          orderBy: newest,
          take: TAKE,
        })
        .then((rows) => rows.map((r) => ({ kind: 'Purchase order', number: r.poNumber, title: r.supplier.name, sub: `${said(r.status)} · ${day(r.poDate)}`, path: '/purchase/orders', term: r.poNumber }))),
      prisma.gRN
        .findMany({
          where: { OR: [{ grnNumber: has(q) }, { challanNo: has(q) }, { po: { supplier: { name: has(q) } } }] },
          select: { grnNumber: true, status: true, grnDate: true, po: { select: { poNumber: true, supplier: { select: { name: true } } } } },
          orderBy: newest,
          take: TAKE,
        })
        .then((rows) =>
          rows.map((r) => ({ kind: 'Goods receipt', number: r.grnNumber, title: r.po.supplier.name, sub: `${said(r.status)} · ${r.po.poNumber} · ${day(r.grnDate)}`, path: '/purchase/grn', term: r.grnNumber })),
        ),
      prisma.purchaseInvoice
        .findMany({
          where: { OR: [{ billNumber: has(q) }, { supplierInvoiceNo: has(q) }, { supplier: { name: has(q) } }] },
          select: { billNumber: true, supplierInvoiceNo: true, status: true, billDate: true, supplier: { select: { name: true } } },
          orderBy: newest,
          take: TAKE,
        })
        .then((rows) =>
          rows.map((r) => ({
            kind: 'Purchase bill',
            number: r.billNumber,
            title: r.supplier.name,
            sub: [said(r.status), r.supplierInvoiceNo ? `their no. ${r.supplierInvoiceNo}` : null, day(r.billDate)].filter(Boolean).join(' · '),
            path: '/purchase/bills',
            term: r.billNumber,
          })),
        ),
      prisma.purchaseReturn
        .findMany({
          where: { OR: [{ returnNumber: has(q) }, { supplier: { name: has(q) } }] },
          select: { returnNumber: true, status: true, returnDate: true, supplier: { select: { name: true } } },
          orderBy: newest,
          take: TAKE,
        })
        .then((rows) => rows.map((r) => ({ kind: 'Purchase return', number: r.returnNumber, title: r.supplier.name, sub: `${said(r.status)} · ${day(r.returnDate)}`, path: '/purchase/returns', term: r.returnNumber }))),
    )
  }

  if (may('inventory')) {
    jobs.push(
      prisma.materialRequisition
        .findMany({
          where: { OR: [{ mrNumber: has(q) }, { department: { name: has(q) } }] },
          select: { mrNumber: true, status: true, requestDate: true, department: { select: { name: true } } },
          orderBy: newest,
          take: TAKE,
        })
        .then((rows) => rows.map((r) => ({ kind: 'Material requisition', number: r.mrNumber, title: r.department.name, sub: `${said(r.status)} · ${day(r.requestDate)}`, path: '/inventory/requisitions', term: r.mrNumber }))),
      prisma.customerGRN
        .findMany({
          where: { OR: [{ grnNumber: has(q) }, { challanNumber: has(q) }, { customer: { name: has(q) } }] },
          select: { grnNumber: true, status: true, receiptDate: true, customer: { select: { name: true } } },
          orderBy: newest,
          take: TAKE,
        })
        .then((rows) => rows.map((r) => ({ kind: 'Customer material in', number: r.grnNumber, title: r.customer.name, sub: `${said(r.status)} · ${day(r.receiptDate)}`, path: '/inventory/customer-material', term: r.grnNumber }))),
      prisma.jobWorkChallan
        .findMany({
          where: { OR: [{ challanNumber: has(q) }, { jobWorker: { name: has(q) } }] },
          select: { challanNumber: true, status: true, challanDate: true, jobWorker: { select: { name: true } } },
          orderBy: newest,
          take: TAKE,
        })
        .then((rows) => rows.map((r) => ({ kind: 'Job work challan', number: r.challanNumber, title: r.jobWorker.name, sub: `${said(r.status)} · ${day(r.challanDate)}`, path: '/inventory/job-work', term: r.challanNumber }))),
      prisma.stockPackage
        .findMany({
          where: { OR: [{ code: has(q) }, { lotNo: has(q) }] },
          select: { code: true, status: true, lotNo: true, item: { select: { name: true } }, warehouse: { select: { name: true } } },
          orderBy: newest,
          take: TAKE,
        })
        .then((rows) =>
          rows.map((r) => ({
            kind: 'Packet',
            number: r.code,
            title: r.item.name,
            sub: [said(r.status), r.warehouse.name, r.lotNo ? `lot ${r.lotNo}` : null].filter(Boolean).join(' · '),
            // Opened as a scan: the packet's card, with what can be done with it.
            path: `/inventory/scan?code=${encodeURIComponent(r.code)}`,
            term: r.code,
          })),
        ),
    )
  }

  if (may('production')) {
    jobs.push(
      prisma.manufacturingOrder
        .findMany({
          where: { OR: [{ moNumber: has(q) }, { so: { soNumber: has(q) } }] },
          select: { moNumber: true, status: true, so: { select: { soNumber: true, customer: { select: { name: true } } } } },
          orderBy: newest,
          take: TAKE,
        })
        .then((rows) =>
          rows.map((r) => ({
            kind: 'Manufacturing order',
            number: r.moNumber,
            title: r.so?.customer.name ?? 'Manufacturing order',
            sub: [said(r.status), r.so?.soNumber].filter(Boolean).join(' · '),
            path: '/production/orders',
            term: r.moNumber,
          })),
        ),
      prisma.processTransfer
        .findMany({
          where: { transferNumber: has(q) },
          select: { transferNumber: true, status: true, dispatchDate: true },
          orderBy: newest,
          take: TAKE,
        })
        .then((rows) => rows.map((r) => ({ kind: 'Process transfer', number: r.transferNumber, title: 'Transfer', sub: `${said(r.status)} · ${day(r.dispatchDate)}`, path: '/production/transfers', term: r.transferNumber }))),
      prisma.jobCard
        .findMany({
          where: { OR: [{ jobCardNumber: has(q) }, { lotNo: has(q) }, { designNo: has(q) }] },
          select: { jobCardNumber: true, designNo: true, lotNo: true },
          orderBy: newest,
          take: TAKE,
        })
        .then((rows) =>
          rows.map((r) => ({
            kind: 'Job card',
            number: r.jobCardNumber,
            title: r.designNo ? `Design ${r.designNo}` : 'Job card',
            sub: r.lotNo ? `lot ${r.lotNo}` : null,
            path: '/production/job-cards',
            term: r.jobCardNumber,
          })),
        ),
    )
  }

  if (may('masters')) {
    const party = { OR: [{ name: has(q) }, { code: has(q) }] }
    jobs.push(
      prisma.customer
        .findMany({ where: party, select: { code: true, name: true, isActive: true }, orderBy: { name: 'asc' }, take: TAKE })
        .then((rows) => rows.map((r) => ({ kind: 'Customer', number: r.code, title: r.name, sub: r.isActive ? null : 'inactive', path: '/masters/customers', term: r.code }))),
      prisma.supplier
        .findMany({ where: party, select: { code: true, name: true, isActive: true }, orderBy: { name: 'asc' }, take: TAKE })
        .then((rows) => rows.map((r) => ({ kind: 'Supplier', number: r.code, title: r.name, sub: r.isActive ? null : 'inactive', path: '/masters/suppliers', term: r.code }))),
      prisma.item
        .findMany({ where: party, select: { code: true, name: true, isActive: true }, orderBy: { name: 'asc' }, take: TAKE })
        .then((rows) => rows.map((r) => ({ kind: 'Item', number: r.code, title: r.name, sub: r.isActive ? null : 'inactive', path: '/masters/items', term: r.code }))),
      prisma.style
        .findMany({ where: party, select: { code: true, name: true, isActive: true }, orderBy: { name: 'asc' }, take: TAKE })
        .then((rows) => rows.map((r) => ({ kind: 'Style', number: r.code, title: r.name, sub: r.isActive ? null : 'inactive', path: '/masters/styles', term: r.code }))),
    )
  }

  const found = (await Promise.all(jobs)).flat()
  // What starts with the letters typed comes before what only has them inside.
  const lq = q.toLowerCase()
  const rank = (h: Hit) => (h.number.toLowerCase() === lq ? 0 : h.number.toLowerCase().startsWith(lq) ? 1 : h.number.toLowerCase().includes(lq) ? 2 : 3)
  found.sort((a, b) => rank(a) - rank(b))
  res.json({ success: true, data: found.slice(0, 24) })
})

export default router
