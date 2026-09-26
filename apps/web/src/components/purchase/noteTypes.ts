/**
 * The shape of a purchase note on the wire, and the words the screens print
 * for its coded fields.
 *
 * In its own file because the list, the form, the detail panel and the print
 * sheet all need it, and three of those would otherwise import the fourth for
 * a type alone — which is how a dialog ends up pulling a print stylesheet into
 * the dashboard bundle.
 */

/**
 * Three separate facts, where there used to be one flag.
 *
 * `NoteType` was 'DEBIT' | 'CREDIT' and was standing in for all three of
 * these at once, so it could describe two of the eight combinations that
 * occur. A supplier's debit note is theirs, is a debit note, and INCREASES
 * what we owe — and no single flag says all three, which is why the form now
 * asks three questions instead of implying two answers from one.
 */

/** Who raised it. */
export type NoteIssuer = 'OUR_COMPANY' | 'SUPPLIER'

/** What kind of document it is. This is what decides the direction. */
export type NoteDoc = 'OUR_DEBIT_NOTE' | 'SUPPLIER_CREDIT_NOTE' | 'SUPPLIER_DEBIT_NOTE' | 'OTHER'

/** Which way it moves the money. Never read off a document's name. */
export type NoteEffect = 'REDUCES_PAYABLE' | 'INCREASES_PAYABLE'

/** What the accounts desk has made of it. The purchase office only reads this. */
export type NoteGst =
  'NOT_REVIEWED' | 'GST_CREDIT_NOTE' | 'GST_DEBIT_NOTE' | 'ITC_REVERSAL_ONLY' | 'NO_GST_IMPACT'

export type NoteStatus = 'DRAFT' | 'SUBMITTED' | 'APPROVED' | 'POSTED' | 'REJECTED' | 'CANCELLED'

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
  grnLineId: string | null
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
  status: NoteStatus
  reason: string
  reasonNote: string | null
  issuedBy: NoteIssuer
  docType: NoteDoc
  effect: NoteEffect

  gstTreatment: NoteGst
  gstNote: string | null
  gstTreatedBy?: { id: string; name: string } | null
  gstTreatedAt?: string | null

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
  /* The three below are left over from the approval workflow. No new note
     reaches them; rows written before it was removed still sit in them and
     can still be posted, so they are labelled by what is true of them now
     rather than by a queue that no longer exists. */
  SUBMITTED: {
    label: 'Not posted',
    cls: 'badge-neutral',
    hint: 'Raised before approvals were removed. It can be posted as it stands.',
  },
  APPROVED: {
    label: 'Not posted',
    cls: 'badge-neutral',
    hint: 'Raised before approvals were removed. It can be posted as it stands.',
  },
  POSTED: {
    label: 'Posted',
    cls: 'badge-success',
    hint: 'Off the bill, and out of stock where goods moved.',
  },
  REJECTED: {
    label: 'Not posted',
    cls: 'badge-neutral',
    hint: 'Was sent back before approvals were removed. It can be edited and posted.',
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
  WRONG_RATE: 'Wrong rate charged',
  EXCESS_BILLING: 'Excess billing',
  POST_PURCHASE_DISCOUNT: 'Discount after the bill',
  OTHER: 'Something else',
}

/**
 * What each kind of document is called, and what it does to the money.
 *
 * `effect: null` on OTHER is not an oversight — it is the one kind whose
 * direction is a decision rather than a definition, so the form asks and the
 * screens read the answer off the note rather than off this table.
 */
export const DOC_WORDS: Record<
  NoteDoc,
  {
    label: string
    short: string
    /** The plain word for it — what the dialog titles itself "New ___" with. */
    plain: string
    hint: string
    effect: NoteEffect | null
    issuedBy: NoteIssuer
  }
> = {
  OUR_DEBIT_NOTE: {
    label: 'Our debit note / claim',
    short: 'Our claim',
    plain: 'debit note',
    hint: 'We are claiming money back. A commercial claim — not by itself a GST document.',
    effect: 'REDUCES_PAYABLE',
    issuedBy: 'OUR_COMPANY',
  },
  SUPPLIER_CREDIT_NOTE: {
    label: "Supplier's credit note",
    short: 'Their credit note',
    plain: 'credit note',
    hint: 'They sent a document reducing their own invoice. We are recording it.',
    effect: 'REDUCES_PAYABLE',
    issuedBy: 'SUPPLIER',
  },
  SUPPLIER_DEBIT_NOTE: {
    label: "Supplier's debit note",
    short: 'Their debit note',
    plain: 'debit note',
    hint: 'They sent a document increasing their own invoice. We will owe MORE, not less.',
    effect: 'INCREASES_PAYABLE',
    issuedBy: 'SUPPLIER',
  },
  OTHER: {
    label: 'Other adjustment',
    short: 'Other',
    plain: 'adjustment',
    hint: 'As configured by Accounts. Whoever raises it says which way it moves.',
    effect: null,
    issuedBy: 'OUR_COMPANY',
  },
}

export const ISSUER_WORDS: Record<NoteIssuer, string> = {
  OUR_COMPANY: 'Our company',
  SUPPLIER: 'The supplier',
}

/**
 * Which way the money goes, said in words a buyer uses rather than in
 * accounting terms.
 *
 * "Reduces payable" is the column name. "We pay them less" is the sentence,
 * and it is the one that stops somebody filing an increase as a reduction.
 */
export const EFFECT_WORDS: Record<NoteEffect, { label: string; hint: string; cls: string }> = {
  REDUCES_PAYABLE: {
    label: 'We pay them less',
    hint: 'This amount comes off the bill.',
    cls: 'badge-success',
  },
  INCREASES_PAYABLE: {
    label: 'We pay them more',
    hint: 'This amount goes on to the bill.',
    cls: 'badge-warning',
  },
}

/**
 * The accounts desk's classification, as the purchase office sees it.
 *
 * Shown read-only on every note so a buyer can tell whether it is cleared to
 * post, and never offered as an editable field on the note form — a dropdown
 * a clerk can fill in is a dropdown a clerk will fill in.
 */
export const GST_WORDS: Record<NoteGst, { label: string; hint: string; cls: string }> = {
  NOT_REVIEWED: {
    label: 'Awaiting Accounts',
    hint: 'Accounts has not classified this yet. It cannot be posted until they have.',
    cls: 'badge-warning',
  },
  GST_CREDIT_NOTE: {
    label: 'GST credit note — s.34(1)',
    hint: 'Supplier issued a credit note. Our input credit reduces.',
    cls: 'badge-info',
  },
  GST_DEBIT_NOTE: {
    label: 'GST debit note — s.34(3)',
    hint: 'Supplier issued a debit note. Further input credit is available.',
    cls: 'badge-info',
  },
  ITC_REVERSAL_ONLY: {
    label: 'Input credit reversal',
    hint: 'No supplier document. We reverse the credit ourselves.',
    cls: 'badge-info',
  },
  NO_GST_IMPACT: {
    label: 'No GST effect',
    hint: 'Commercial only. The invoice and the input credit both stand.',
    cls: 'badge-neutral',
  },
}

/**
 * The two screens, and what each one lists.
 *
 * Two, not one per document type. A debit note is a debit note whether we
 * raised it or the supplier did, and asking somebody to know whose paper it
 * is before they can find the menu entry is the wrong way round — finding it
 * is how they discover whose it is. Both kinds sit on one screen with an
 * "Issued by" column and a badge saying which way the money moves.
 *
 * `kinds` is what the screen asks the server for. `raises` is what the New
 * button starts the form on; the form can still be switched to any kind,
 * because who issued a document is a question the form asks rather than one
 * the menu answers.
 */
export type NoteScreen = 'DEBIT' | 'CREDIT'

export const MODULE_WORDS: Record<
  NoteScreen,
  {
    title: string
    one: string
    subtitle: string
    newLabel: string
    kinds: NoteDoc[]
    raises: NoteDoc
  }
> = {
  DEBIT: {
    title: 'Debit Notes',
    one: 'debit note',
    subtitle: 'Claims you have raised, and extra charges suppliers have raised on you',
    newLabel: 'New debit note',
    /* OTHER lives here rather than on its own screen. It is the rare
       accounts-configured case, and a third menu entry for it would cost more
       attention than it is worth. */
    kinds: ['OUR_DEBIT_NOTE', 'SUPPLIER_DEBIT_NOTE', 'OTHER'],
    raises: 'OUR_DEBIT_NOTE',
  },
  CREDIT: {
    title: 'Credit Notes',
    one: 'credit note',
    subtitle: 'Reductions your suppliers have granted you',
    newLabel: 'Record a credit note',
    kinds: ['SUPPLIER_CREDIT_NOTE'],
    raises: 'SUPPLIER_CREDIT_NOTE',
  },
}

export const money = (v: string | number | null | undefined) =>
  Number(v ?? 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

export const qtyText = (v: string | number | null | undefined) =>
  Number(v ?? 0).toLocaleString('en-IN', { maximumFractionDigits: 3 })
