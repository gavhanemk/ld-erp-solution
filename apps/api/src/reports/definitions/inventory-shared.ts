import type { Prisma } from '@prisma/client'
import type { ReportFilter, ReportParams, Tone } from '../types'

/*
 * What the inventory reports share: their filters, how a ledger row is named,
 * and the document number a row came from.
 *
 * Every inventory report reads the stock ledger, and every one values stock
 * the way the stores screens do — the sum of (in − out) × the rate each
 * movement carried — so a figure in a report and on the Inventory dashboard
 * never disagree.
 */

export const asOnFilter: ReportFilter = {
  key: 'asOn',
  label: 'As on',
  type: 'date',
  help: 'Stock at the end of this day. Leave blank for today',
}

export const warehouseFilter: ReportFilter = {
  key: 'warehouseId',
  label: 'Store',
  type: 'select',
  optionsFrom: 'warehouses',
}

export const categoryFilter: ReportFilter = {
  key: 'categoryId',
  label: 'Category',
  type: 'select',
  optionsFrom: 'itemCategories',
  help: 'A main category takes in its sub-categories',
}

/** Our stock unless asked otherwise: a customer's cloth is not the mill's money. */
export const ownershipFilter: ReportFilter = {
  key: 'ownership',
  label: 'Whose stock',
  type: 'select',
  options: [
    { value: 'OWNED', label: 'Our own stock' },
    { value: 'CUSTOMER_OWNED', label: "Customers' material" },
    { value: 'ALL', label: 'Both' },
  ],
  help: 'Leave blank for our own stock only',
}

/** The ownership values a report should read, from the filter. */
export function ownershipsOf(params: ReportParams): Array<'OWNED' | 'CUSTOMER_OWNED'> {
  if (params.ownership === 'ALL') return ['OWNED', 'CUSTOMER_OWNED']
  if (params.ownership === 'CUSTOMER_OWNED') return ['CUSTOMER_OWNED']
  return ['OWNED']
}

/** The last instant of the "as on" day, or now. */
export function asOnEnd(params: ReportParams): Date {
  return params.asOn ? new Date(`${params.asOn}T23:59:59.999`) : new Date()
}

const DAY = new Intl.DateTimeFormat('en-IN', { dateStyle: 'medium' })
export const asOnLabel = (params: ReportParams) =>
  params.asOn ? DAY.format(new Date(`${params.asOn}T00:00:00`)) : 'today'

export const daysBetween = (a: Date, b: Date) =>
  Math.max(0, Math.floor((b.getTime() - a.getTime()) / 86_400_000))

/**
 * Each category with its main category, and the ids under a category.
 *
 * Items hang off a sub-category ("Buttons" under "Trims"). A report reads
 * better grouped by the main one, and a filter on "Trims" has to take in
 * every sub-category under it.
 */
export async function loadCategories(tx: Prisma.TransactionClient) {
  const all = await tx.itemCategory.findMany({ select: { id: true, name: true, parentId: true } })
  const byId = new Map(all.map((c) => [c.id, c]))
  const mainOf = (id: string) => {
    let c = byId.get(id)
    for (let i = 0; c?.parentId && i < 10; i++) c = byId.get(c.parentId)
    return c?.name ?? ''
  }
  const names = (id: string) => {
    const own = byId.get(id)
    const main = mainOf(id)
    return { category: main, subCategory: own && own.name !== main ? own.name : '' }
  }
  /** The category and everything under it, or null for no filter. */
  const under = (id: string | undefined): string[] | null => {
    if (!id) return null
    const out = new Set([id])
    let grew = true
    while (grew) {
      grew = false
      for (const c of all) {
        if (c.parentId && out.has(c.parentId) && !out.has(c.id)) {
          out.add(c.id)
          grew = true
        }
      }
    }
    return [...out]
  }
  return { names, under }
}

/**
 * What kind of movement a ledger row is, in the words the stores use.
 *
 * Decided from the transaction type and the document it came from. A return
 * is either goods going back to a supplier or a customer's material going
 * home; a transfer is either between our stores or out to a job worker.
 */
export type Bucket =
  | 'opening'
  | 'purchase'
  | 'customer'
  | 'issue'
  | 'jobwork'
  | 'transfer'
  | 'adjustment'
  | 'sale'

export function bucketOf(type: string, ref: string | null): Bucket {
  switch (type) {
    case 'OPENING':
      return 'opening'
    case 'PURCHASE':
      return 'purchase'
    case 'CUSTOMER_MATERIAL':
      return 'customer'
    case 'ISSUE':
      return 'issue'
    case 'PRODUCTION':
      return 'jobwork'
    case 'ADJUSTMENT':
      return 'adjustment'
    case 'SALE':
      return 'sale'
    case 'TRANSFER':
      return ref?.startsWith('JOB_WORK') ? 'jobwork' : 'transfer'
    case 'RETURN':
      return ref?.startsWith('CUSTOMER') ? 'customer' : 'purchase'
    default:
      return 'adjustment'
  }
}

export const BUCKET_LABEL: Record<Bucket, string> = {
  opening: 'Opening stock',
  purchase: 'Purchase / return',
  customer: 'Customer material',
  issue: 'Issued to production',
  jobwork: 'Job work',
  transfer: 'Store transfer',
  adjustment: 'Stock adjustment',
  sale: 'Despatched',
}

export const BUCKET_TONE: Record<Bucket, Tone> = {
  opening: 'neutral',
  purchase: 'good',
  customer: 'info',
  issue: 'normal',
  jobwork: 'info',
  transfer: 'neutral',
  adjustment: 'warn',
  sale: 'normal',
}

/**
 * The number of the document behind each ledger row: GRN-…, MR-…, JW-….
 *
 * A ledger row only carries the document's id. Printed raw it tells nobody
 * anything, so each kind is looked up in one query and the row shows the
 * number people quote.
 */
export async function documentNumbers(
  tx: Prisma.TransactionClient,
  refs: Array<{ referenceType: string | null; referenceId: string | null }>,
): Promise<Map<string, string>> {
  const ids = (match: (t: string) => boolean) => [
    ...new Set(
      refs
        .filter((r) => r.referenceId && r.referenceType && match(r.referenceType))
        .map((r) => r.referenceId as string),
    ),
  ]
  const out = new Map<string, string>()
  const put = (rows: Array<{ id: string; n: string }>) => rows.forEach((r) => out.set(r.id, r.n))

  const grn = ids((t) => t.startsWith('GRN') && !t.startsWith('GRN_QC'))
  const adj = ids((t) => t === 'STOCK_ADJUSTMENT')
  const trf = ids((t) => t.startsWith('STOCK_TRANSFER'))
  const mr = ids((t) => t === 'MATERIAL_REQUISITION')
  const cgrn = ids((t) => t.startsWith('CUSTOMER_GRN'))
  const cret = ids((t) => t.startsWith('CUSTOMER_RETURN'))
  const jwc = ids((t) => t.startsWith('JOB_WORK_CHALLAN'))
  const jwr = ids((t) => t === 'JOB_WORK_RETURN')
  const pret = ids((t) => t === 'PurchaseReturn')
  const note = ids((t) => t === 'PurchaseNote')

  const [a, b, c, d, e, f, g, h, i, j] = await Promise.all([
    grn.length ? tx.gRN.findMany({ where: { id: { in: grn } }, select: { id: true, grnNumber: true } }) : [],
    adj.length
      ? tx.stockAdjustment.findMany({ where: { id: { in: adj } }, select: { id: true, adjustmentNumber: true } })
      : [],
    trf.length
      ? tx.stockTransfer.findMany({ where: { id: { in: trf } }, select: { id: true, transferNumber: true } })
      : [],
    mr.length
      ? tx.materialRequisition.findMany({ where: { id: { in: mr } }, select: { id: true, mrNumber: true } })
      : [],
    cgrn.length
      ? tx.customerGRN.findMany({ where: { id: { in: cgrn } }, select: { id: true, grnNumber: true } })
      : [],
    cret.length
      ? tx.customerMaterialReturn.findMany({ where: { id: { in: cret } }, select: { id: true, returnNumber: true } })
      : [],
    jwc.length
      ? tx.jobWorkChallan.findMany({ where: { id: { in: jwc } }, select: { id: true, challanNumber: true } })
      : [],
    jwr.length
      ? tx.jobWorkReturn.findMany({ where: { id: { in: jwr } }, select: { id: true, returnNumber: true } })
      : [],
    pret.length
      ? tx.purchaseReturn.findMany({ where: { id: { in: pret } }, select: { id: true, returnNumber: true } })
      : [],
    note.length
      ? tx.purchaseNote.findMany({ where: { id: { in: note } }, select: { id: true, noteNumber: true } })
      : [],
  ])
  put(a.map((r) => ({ id: r.id, n: r.grnNumber })))
  put(b.map((r) => ({ id: r.id, n: r.adjustmentNumber })))
  put(c.map((r) => ({ id: r.id, n: r.transferNumber })))
  put(d.map((r) => ({ id: r.id, n: r.mrNumber })))
  put(e.map((r) => ({ id: r.id, n: r.grnNumber })))
  put(f.map((r) => ({ id: r.id, n: r.returnNumber })))
  put(g.map((r) => ({ id: r.id, n: r.challanNumber })))
  put(h.map((r) => ({ id: r.id, n: r.returnNumber })))
  put(i.map((r) => ({ id: r.id, n: r.returnNumber })))
  put(j.map((r) => ({ id: r.id, n: r.noteNumber })))
  return out
}

/** "₹12,34,567" for an insight sentence. */
export const rupees = (n: number) => `₹${Math.round(n).toLocaleString('en-IN')}`

/** A share as "42%", or a dash with nothing to divide by. */
export const pctOf = (part: number, whole: number) =>
  whole ? `${Math.round((part / whole) * 100)}%` : '—'
