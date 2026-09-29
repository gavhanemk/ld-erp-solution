/**
 * The shape of a purchase enquiry as the API sends it, and the words the screens
 * agree to call things.
 *
 * In its own file rather than on the dialog that first drew it, so the list, the
 * comparison, the print sheet and the order form can all read the same document
 * without importing three thousand lines of form to get at a type.
 */

export type EnquiryStatus = 'DRAFT' | 'SENT' | 'QUOTED' | 'ORDERED' | 'CLOSED'

export interface EnquiryItem {
  id: string
  code: string
  name: string
  hsnCode: string | null
  uom: { symbol: string } | null
}

/** What one supplier said about one line. Absent means he did not price it. */
export interface QuoteLine {
  id: string
  quoteId: string
  enquiryLineId: string
  quotedRate: string | null
  gstRate: string | null
  offeredQty: string | null
  remark: string | null
}

export interface EnquiryLine {
  id: string
  itemId: string
  description: string | null
  hsnCode: string | null
  qty: string
  expectedRate: string | null
  sortOrder: number
  mrLineId: string | null
  item: EnquiryItem
  mrLine: { id: string; mr: { id: string; mrNumber: string } } | null
  poLines: Array<{
    id: string
    qty: string
    po: { id: string; poNumber: string; status: string; poDate: string; deletedAt: string | null }
  }>
  /** Only on the detail call: how much of this line is already on a live order. */
  orderedQty?: number
  pendingQty?: number
  /** Only on the detail call: each supplier's answer, keyed by quote id. */
  quotedBy?: Record<string, QuoteLine | null>
}

export interface EnquiryAttachment {
  id: string
  quoteId: string | null
  fileName: string
  mimeType: string | null
  sizeBytes: number
  createdAt: string
  uploadedBy: { id: string; name: string } | null
}

/** One supplier's answer to the enquiry. */
export interface EnquiryQuote {
  id: string
  enquiryId: string
  supplierId: string
  sentAt: string | null
  piNumber: string | null
  piDate: string | null
  piAmount: string | null
  piValidUntil: string | null
  piReceivedAt: string | null
  placeOfSupplyCode: string | null
  remark: string | null
  declinedReason: string | null
  declinedAt: string | null
  supplier: {
    id: string
    code: string
    name: string
    gstin: string | null
    stateCode: string | null
    email: string | null
  }
  lines: QuoteLine[]
  attachments: EnquiryAttachment[]
  purchaseOrders: Array<{ id: string; poNumber: string; status: string }>
  /** Computed by the server — what his rates come to, as against his stated PI total. */
  value: number
  pricedLines: number
  expired: boolean
  answered: boolean
  ordered: boolean
}

export interface EnquiryRecord {
  id: string
  enquiryNumber: string
  enquiryDate: string
  requiredDate: string | null
  status: EnquiryStatus
  locationId: string | null
  location: { id: string; name: string } | null
  reference: string | null
  notes: string | null
  terms: string | null
  remark: string | null
  closeReason: string | null
  closedAt: string | null
  deletedAt: string | null
  createdBy: { id: string; name: string } | null
  lines: EnquiryLine[]
  quotes: EnquiryQuote[]
  attachments: EnquiryAttachment[]
  purchaseOrders: Array<{
    id: string
    poNumber: string
    poDate: string
    status: string
    totalAmount: string
    enquiryQuoteId: string | null
  }>
  /** Computed by the server, so no two screens can rank the suppliers differently. */
  supplierCount: number
  answeredCount: number
  expired: boolean
  comparable: boolean
  best: {
    quoteId: string
    supplierId: string
    supplierName: string
    amount: number
    pricedLines: number
  } | null
}

/**
 * How each status is said and coloured.
 *
 * The same badge classes the order, receipt and bill lists use. A module whose
 * five screens each invent their own pill does not read as one application.
 */
export const ENQUIRY_STATUS: Record<EnquiryStatus, { label: string; cls: string }> = {
  DRAFT: { label: 'Draft', cls: 'badge-neutral' },
  SENT: { label: 'Sent', cls: 'badge-info' },
  QUOTED: { label: 'Quoted', cls: 'badge-warning' },
  ORDERED: { label: 'Ordered', cls: 'badge-success' },
  CLOSED: { label: 'Closed', cls: 'badge-neutral' },
}

export const money = (v: unknown) =>
  Number(v ?? 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

export const qty = (v: unknown) =>
  Number(v ?? 0).toLocaleString('en-IN', { maximumFractionDigits: 3 })

/**
 * How long a supplier has had it, in the words a buyer would use.
 *
 * "18 days" is read; "since 8 September" has to be worked out. The question a
 * buyer has about a sent enquiry is how long he has been waiting, not the date
 * it went.
 */
export function waitingFor(sentAt: string | null): string | null {
  if (!sentAt) return null
  const days = Math.floor((Date.now() - new Date(sentAt).getTime()) / 86_400_000)
  if (days <= 0) return 'today'
  if (days === 1) return '1 day'
  if (days < 14) return days + ' days'
  if (days < 60) return Math.floor(days / 7) + ' weeks'
  return Math.floor(days / 30) + ' months'
}

/** What a supplier's answer is worth, by his own total where he gave one. */
export const quoteTotal = (q: EnquiryQuote) => Number(q.piAmount ?? q.value)

/**
 * Where one supplier's answer sits against the cheapest.
 *
 * Returned as a fraction rather than a formatted string so the caller decides
 * how to say it. Null when there is nothing to compare against.
 */
export function overBest(q: EnquiryQuote, best: number | null): number | null {
  const mine = quoteTotal(q)
  if (best == null || best <= 0 || mine <= 0 || mine === best) return null
  return (mine - best) / best
}
