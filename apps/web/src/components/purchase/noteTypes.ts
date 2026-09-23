/**
 * The shape of a purchase note on the wire, and the words the screens print
 * for its coded fields.
 *
 * In its own file because the list, the form, the detail panel and the print
 * sheet all need it, and three of those would otherwise import the fourth for
 * a type alone — which is how a dialog ends up pulling a print stylesheet into
 * the dashboard bundle.
 */

export type NoteType = 'DEBIT' | 'CREDIT'

export type NoteStatus = 'DRAFT' | 'SUBMITTED' | 'APPROVED' | 'POSTED' | 'REJECTED' | 'CANCELLED'

export type NoteEffect = 'REDUCES_PAYABLE' | 'INCREASES_PAYABLE'

export interface NoteLine {
  id: string
  description: string | null
  hsnCode: string | null
  originalQty: string | number | null
  originalRate: string | number | null
  qty: string | number
  unitPrice: string | number
  taxableValue: string | number
  gstRate: string | number
  cgst: string | number
  sgst: string | number
  igst: string | number
  amount: string | number
  remarks: string | null
  billLineId: string | null
  item: { id: string; code: string; name: string; uom: { symbol: string } | null }
}

export interface NoteFile {
  id: string
  fileName: string
  mimeType: string | null
  sizeBytes: number
  createdAt: string
  uploadedBy?: { id: string; name: string } | null
}

export interface PurchaseNote {
  id: string
  noteNumber: string
  noteType: NoteType
  status: NoteStatus
  reason: string
  reasonNote: string | null
  effect: NoteEffect

  supplier: {
    id: string
    code: string
    name: string
    gstin: string | null
    stateCode: string | null
  }
  bill: {
    id: string
    billNumber: string
    supplierInvoiceNo: string | null
    supplierInvoiceDate: string | null
    billDate: string
    totalAmount: string | number
    balanceAmount: string | number
    noteAdjustment: string | number
    status: string
  } | null
  withoutBillReason: string | null
  po: { id: string; poNumber: string; poDate: string } | null
  grn: { id: string; grnNumber: string; grnDate: string } | null

  noteDate: string
  supplierDocNo: string | null
  supplierDocDate: string | null

  warehouse: { id: string; code: string; name: string } | null
  lrNumber: string | null
  vehicleNo: string | null
  otherRef: string | null

  isIntraState: boolean
  taxableAmount: string | number
  discountAmount: string | number
  cgst: string | number
  sgst: string | number
  igst: string | number
  otherCharges: string | number
  roundOff: string | number
  totalAmount: string | number

  notes: string | null

  createdBy: { id: string; name: string } | null
  createdAt: string
  updatedAt: string
  submittedBy: { id: string; name: string } | null
  submittedAt: string | null
  approvedBy: { id: string; name: string } | null
  approvedAt: string | null
  postedBy: { id: string; name: string } | null
  postedAt: string | null
  closedBy: { id: string; name: string } | null
  closedAt: string | null
  closedReason: string | null

  lines: NoteLine[]
  attachments: NoteFile[]
}

/**
 * What each state is called on screen, and how it is tinted.
 *
 * Declared rather than inferred from the word. "Rejected" is bad on a note and
 * ordinary on a QC sample, and a renderer guessing from the text would be
 * right until the day it silently was not — the same rule the reports engine
 * already follows for its badges.
 */
export const NOTE_STATUS: Record<NoteStatus, { label: string; cls: string; hint: string }> = {
  DRAFT: {
    label: 'Draft',
    cls: 'badge-neutral',
    hint: 'Being written. Nothing has moved.',
  },
  SUBMITTED: {
    label: 'Awaiting approval',
    cls: 'badge-info',
    hint: 'Waiting for somebody else to agree it.',
  },
  APPROVED: {
    label: 'Approved',
    cls: 'badge-info',
    hint: 'Agreed, but the payable has not changed yet.',
  },
  POSTED: {
    label: 'Posted',
    cls: 'badge-success',
    hint: 'Off the bill, and out of stock where goods moved.',
  },
  REJECTED: {
    label: 'Sent back',
    cls: 'badge-warning',
    hint: 'The approver refused it. It can be reopened as a draft.',
  },
  CANCELLED: {
    label: 'Cancelled',
    cls: 'badge-neutral',
    hint: 'Withdrawn. Anything it had done has been undone.',
  },
}

export const REASON_WORDS: Record<string, string> = {
  PURCHASE_RETURN: 'Material returned',
  SHORT_QUANTITY: 'Short quantity',
  DAMAGED_MATERIAL: 'Damaged material',
  QUALITY_REJECTION: 'Quality rejection',
  WRONG_MATERIAL: 'Wrong material',
  EXCESS_QUANTITY_BILLED: 'Excess quantity billed',
  RATE_DIFFERENCE: 'Wrong rate charged',
  EXCESS_BILLING: 'Excess billing',
  POST_PURCHASE_DISCOUNT: 'Discount after the bill',
  OTHER: 'Something else',
}

/** The words for a document type, in the module each one belongs to. */
export const MODULE_WORDS: Record<
  NoteType,
  { title: string; one: string; subtitle: string; newLabel: string }
> = {
  DEBIT: {
    title: 'Debit Notes',
    one: 'debit note',
    subtitle: 'What you are claiming back from your suppliers',
    newLabel: 'New debit note',
  },
  CREDIT: {
    title: 'Credit Notes',
    one: 'credit note',
    subtitle: 'Reductions your suppliers have granted you',
    newLabel: 'Record a credit note',
  },
}

export const money = (v: string | number | null | undefined) =>
  Number(v ?? 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

export const qtyText = (v: string | number | null | undefined) =>
  Number(v ?? 0).toLocaleString('en-IN', { maximumFractionDigits: 3 })
