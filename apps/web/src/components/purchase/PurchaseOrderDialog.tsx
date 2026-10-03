'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  X,
  Loader2,
  AlertCircle,
  Plus,
  Trash2,
  ShoppingCart,
  Printer,
  Calculator,
  FileText,
  Package,
  Truck,
  Paperclip,
  ScrollText,
  Lock,
  MapPin,
  User,
  MessageSquare,
  UploadCloud,
  Save as SaveIcon,
  Mail,
  History,
  Pencil,
  MapPinned,
  Check,
  Percent,
  ClipboardList,
  ChevronUp,
  ChevronDown,
} from 'lucide-react'
import { Section } from '@/components/purchase/Section'
import type { EnquiryQuote, EnquiryRecord as EnquiryLite } from '@/components/purchase/enquiryTypes'
import { api, apiErrorMessage, ApiError, masterResource, type Paginated } from '@/lib/api'
import { IndentItemsDialog, type IndentPick } from '@/components/purchase/IndentItemsDialog'
import { NewItemDialog, type NewItem } from '@/components/purchase/NewItemDialog'

/**
 * Raising a purchase order.
 *
 * Opens over the order list rather than on a page of its own: the clerk is
 * looking at what has already been ordered when they decide to order more, and
 * taking that list away to ask for a supplier loses the context that prompted
 * it. The list stays behind, dimmed.
 *
 * The form is laid out as the job is done, not as the table is shaped — what
 * the order is, what is on it, who it is from, where it goes, what it says.
 * Only the middle section is real work; the rest is mostly already known.
 */

/**
 * Where a discount is allowed to sit on this order.
 *
 * The buyer picks it before typing any figures, because it decides which
 * discount boxes are live. Stored in `poType`, a column that has existed since
 * the first migration and that nothing has ever set until now.
 */
export type PoType = 'ITEM_LEVEL' | 'ORDER_LEVEL' | 'NONE'

export interface PoLine {
  /** The saved line's own id. Absent on a row the form is still building. */
  id?: string
  itemId: string
  description?: string | null
  /** The style number as it was typed. */
  styleNo?: string | null
  /** The master style that text turned out to be, when it matched one. */
  styleId?: string | null
  qty: number | string
  unitRate: number | string
  discount: number | string
  gstRate: number | string
  /** Priced by the API. Absent on a line the form is still building. */
  amount?: number | string
  /**
   * The requisition line this was lifted from, when it came off the indent
   * list rather than being typed.
   *
   * Carried so the indent knows how much of its request has been ordered, and
   * so a purchase can be traced back to the job that needed it. Null on every
   * line a buyer types themselves, which is most of them.
   */
  mrLineId?: string | null
  /** The indent's number, for the note under the row. Browser only. */
  mrNumber?: string | null
  /**
   * The enquiry line this rate came off, when the order was raised from an
   * enquiry rather than typed.
   *
   * Carried so the enquiry knows how much of what it quoted has actually been
   * placed — which is what lets a cancelled order hand its quantity straight
   * back, and what stops the same quote being ordered twice.
   */
  enquiryLineId?: string | null
  /**
   * Whether `discount` is a percentage or a number of rupees.
   *
   * Browser only. A stored line keeps a percentage, so a rupee figure is
   * converted on save — against the quantity and rate *as they are then*,
   * which is why what was typed is kept rather than converted on entry. Change
   * the quantity after typing ₹200 off and it is still ₹200.
   */
  discountUnit?: '%' | 'INR'
  /*
   * The four below never leave the browser. They are how one row remembers
   * what it is in the middle of choosing: which category is narrowing its item
   * dropdown, and what has been typed into its code box before it matches
   * anything. Stripped in `payload`.
   */
  categoryId?: string
  subcategoryId?: string
  codeText?: string
  /** Sent back by the API on a saved line, so the row can reopen showing it. */
  style?: { id: string; code: string; name: string } | null
  /** Set by the server when the line was raised off an indent. */
  mrLine?: {
    id: string
    requestedQty: string | number
    mr: { id: string; mrNumber: string } | null
  } | null
  /** How much of this line has actually arrived, and what is still due —
      sent by the list and the detail call, absent on a form's own draft. */
  receivedQty?: string | number
  pendingQty?: string | number
  /** Set once the balance of this line has been written off as not coming. */
  shortClosed?: boolean
  shortCloseReason?: string | null
  shortClosedAt?: string | null
  shortClosedBy?: { id: string; name: string } | null
  item?: {
    id: string
    code: string
    name: string
    hsnCode: string | null
    uom?: { symbol: string } | null
    category?: { id: string; name: string; parent?: { id: string; name: string } | null } | null
  }
}

export interface PurchaseOrder {
  id: string
  poNumber: string
  supplierId: string
  poDate: string
  poType?: string | null
  deliveryDate: string | null
  deliveryWarehouseId: string | null
  deliveryCustomerId: string | null
  enquiryNo: string | null
  enquiryDate: string | null
  reference: string | null
  /** What this order was billed to, as it read the day it was raised. */
  supplierAddress?: string | null
  remark: string | null
  status: string
  subtotal: string | number
  discountAmount: string | number
  taxableAmount: string | number
  cgst: string | number
  sgst: string | number
  igst: string | number
  roundOff: string | number
  totalAmount: string | number
  otherCharges?: string | number | null
  charges?: {
    chargeTypeId: string
    amount: string | number
    gstRate: string | number
    /** Sent by the list and the detail call, so a charge can be named rather
        than shown as an unexplained figure. Absent on a form's own draft. */
    chargeType?: { id: string; name: string } | null
  }[]
  notes: string | null
  terms: string | null
  supplier?: {
    id: string
    name: string
    code: string
    gstin: string | null
    stateCode: string | null
    /** Sent with the order so the terms can be read off it rather than looked
        up in the supplier master. */
    paymentTerms?: string | null
    creditDays?: number | null
  }
  lines?: PoLine[]

  /*
   * Read-only company the server sends back with an order.
   *
   * The form posts the ids above; the list and the detail call return these
   * alongside them so a screen can print where the goods are going and who
   * raised the order without a second request. Optional throughout, because
   * an order the form is still building has none of them.
   */
  deliveryWarehouse?: { id: string; name: string; address?: string | null } | null
  deliveryCustomer?: { id: string; name: string; code?: string | null } | null
  createdBy?: { id: string; name: string } | null
  approvedBy?: { id: string; name: string } | null
  /** How many files are attached, so a list can say so without fetching them. */
  _count?: { attachments: number } | null
}

/** One kind of charge the mill puts on a purchase — transport, freight, dyeing. */
/** One of the places a supplier bills from. */
export interface SupplierAddressRow {
  id: string
  label: string | null
  address: string
  city: string | null
  state: string | null
  stateCode: string | null
  pincode: string | null
  country: string | null
  gstin: string | null
  isDefault: boolean
}

/** One line of a supplier address, as the panel and the order both read it. */
export const addressLine = (a: SupplierAddressRow) =>
  [a.address, a.city, a.state, a.pincode, a.country]
    .map((p) => p?.trim())
    .filter(Boolean)
    .join(', ')

/** One time this item was bought, for the hint under Rate and the panel behind it. */
interface RateHistoryRow {
  id: string
  poNumber: string
  poDate: string | null
  status: string
  supplierName: string
  qty: string | number
  unitRate: string | number
  amount: string | number
}

interface ChargeTypeOption {
  id: string
  name: string
  /** The GST charged on this charge. The amount itself is always typed in. */
  defaultGstRate: string | number
  /**
   * What this charge usually comes to as a share of the order, if the mill has
   * set one under Masters -> Charges.
   *
   * Never applied on its own — it is only what the percentage helper opens
   * on, so a buyer who agrees the usual rate gets it in one press and a buyer
   * who agreed something else types over it. 0 means nobody has set one.
   */
  percentOfValue?: string | number | null
}

interface Option {
  id: string
  code?: string
  name: string
  gstin?: string | null
  stateCode?: string | null
  hsnCode?: string | null
  standardRate?: string | number | null
  taxRate?: { rate: string | number } | null
  uom?: { symbol: string } | null
  categoryId?: string | null
  category?: { id: string; name: string } | null
  parentId?: string | null
  address?: string | null
  city?: string | null
  state?: string | null
  pincode?: string | null
  phone?: string | null
  email?: string | null
  paymentTerms?: string | null
  creditDays?: number | null
  // A customer keeps two addresses. Goods are taxed where they land, so the
  // shipping one wins wherever both are set.
  shippingStateCode?: string | null
  billingStateCode?: string | null
  shippingGstin?: string | null
  shippingAddress?: string | null
  shippingCity?: string | null
  shippingPincode?: string | null
  billingAddress?: string | null
  billingCity?: string | null
  billingPincode?: string | null
}

interface Attachment {
  id: string
  fileName: string
  sizeBytes: number
  mimeType: string | null
  uploadedBy?: { id: string; name: string } | null
  createdAt: string
}

interface CompanyLite {
  name?: string | null
  address?: string | null
  city?: string | null
  state?: string | null
  pincode?: string | null
  stateCode?: string | null
  email?: string | null
}

/**
 * The biggest file that may be attached, and the most files on one order.
 *
 * Kept the same as the API and the storage bucket. This copy only exists so
 * the form can say no immediately rather than after the file has been sent;
 * the server and the bucket are what actually enforce it.
 */
const TERMS_MAX = 4000
const NOTES_MAX = 1000
const MAX_FILE_MB = 50
const MAX_FILES = 5

const num = (v: unknown) => {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}

const inr = (v: number) =>
  v.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

/** One boxed group. Every section is the same shape so the form reads as a list of steps. */
/**
 * One width per column of the item table, read by both the header and the rows.
 *
 * The table is `w-full table-fixed`, so it always fills the box it is in and
 * the header row's widths are what decide the layout. A row cell that quietly
 * disagreed with its header would be a trap for whoever edits this next, so
 * both sides read from here.
 *
 * Item and Description are blank on purpose. Under a fixed layout the columns
 * that declare no width of their own share out whatever is left over, so those
 * two stretch to fill a wide screen instead of leaving a band of white space
 * to the right of Amount. They are also the two that earn it: a free-typed
 * description and a full item name are the only cells holding a sentence, the
 * rest being a figure or a short code that gains nothing from being wider.
 *
 * The table's `min-w` below is the sum of the fixed widths plus a workable
 * share for those two, so a narrow screen scrolls sideways rather than
 * crushing thirteen columns into whatever it has.
 */
/*
 * The widths of the item table.
 *
 * Category and subcategory share one column, stacked. They are how a row finds
 * its item, not part of the order — neither is sent to the server — and as
 * two full columns they took 256px of the row to narrow a dropdown, which left
 * the item code cell too narrow to show an item code. Stacked they cost one
 * column, and the pair still reads as one thing, which is what it is.
 *
 * That, and trimming what the money columns hold, brings the table inside the
 * dialog on a 1366px laptop. It scrolled sideways before, and a table that
 * scrolls hides its own right-hand end: the buyer could not see the amount
 * while typing the rate.
 */
/**
 * A value the item dropdown carries that is not an item.
 *
 * Picking it opens the new-item window instead of setting the row. A row in
 * the dropdown is where somebody looks when the thing they want is not in the
 * dropdown — a button elsewhere on the panel is not, and they abandon the
 * form or pick a near-enough item instead. The second is worse: six months on,
 * the purchase history says the mill bought something it did not.
 */
const ADD_NEW = '__new__'

const COL = {
  num: 'w-8',
  remove: 'w-8',
  item: 'w-64',
  category: 'w-40',
  style: 'w-24',
  description: 'w-36',
  qty: 'w-20',
  rate: 'w-24',
  // Wide enough for the figure and the % / rupees switch beside it. At w-28
  // the two shared 112px and the figure was clipped to a single bracket.
  discount: 'w-36',
  tax: 'w-16',
  amount: 'w-32',
} as const

/*
 * `Section` moved to its own file so the payment form can wear the same
 * chrome without pulling this module in behind it. Re-exported because three
 * other forms already import it from here.
 */
export { Section }

/**
 * A control for something the ERP cannot do yet.
 *
 * Shown rather than hidden, because the field is part of the order the mill
 * knows and leaving it out reads as though it had been forgotten. Disabled
 * rather than accepting input, because a box that takes what you type and
 * throws it away is worse than no box — the same reason an unbuilt endpoint
 * here answers 501 instead of an empty list.
 */
function Faded({ children }: { children: React.ReactNode }) {
  // 70%, not 50%. Half opacity takes a 7:1 label down to roughly 3:1, which is
  // below the floor for text of any size — the control read as damaged rather
  // than switched off. This is still visibly inactive and still legible.
  return <div className="pointer-events-none select-none opacity-70">{children}</div>
}

/**
 * One line covering everything in a section that cannot work yet.
 *
 * Shared rather than repeated per field: four of these sat on one screen, and
 * four near-identical apologies read as a broken product instead of an
 * unfinished one.
 */
function NotBuiltNote({ children }: { children: React.ReactNode }) {
  return (
    <p className="text-muted-foreground flex items-start gap-1.5 text-xs">
      <Lock size={13} className="mt-0.5 shrink-0" />
      {children}
    </p>
  )
}

/** The percentage helper's key for the Other charges box, which has no id. */
const OTHER_PCT = '__other'

/**
 * Works a charge out as a share of the order, so nobody reaches for a phone.
 *
 * Every charge on a purchase is typed in by hand, and that is deliberate: it
 * is how the mill's old system worked, because what a transporter asks for is
 * a figure agreed on a call, not a formula. But it is very often a round
 * percentage of the goods, and working 5% of 4,241.60 out by hand forty times
 * a week is precisely where a wrong figure comes from.
 *
 * So this neither prefills a box nor calculates anything on its own. It opens
 * when it is asked for, shows the whole working — the percentage, what it is
 * a percentage of, and what that comes to — and writes the figure into the box
 * only when Use is pressed. What gets saved is still a plain amount; the
 * percentage is stored nowhere, because the supplier agreed to a number and an
 * order that quietly recalculated itself later would stop matching their copy.
 */
function PercentOfGross({
  name,
  base,
  value,
  onChange,
  onUse,
}: {
  name: string
  base: number
  value: string
  onChange: (next: string) => void
  onUse: (amount: number) => void
}) {
  const pct = num(value)
  const worked = base * (pct / 100)
  const ready = base > 0 && pct > 0

  return (
    <div className="border-border bg-secondary/40 mt-1.5 rounded-lg border px-2.5 py-2">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5 text-xs">
        <input
          type="number"
          step="any"
          min={0}
          max={100}
          autoFocus
          className="form-input h-7 w-16 text-right"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          aria-label={`Percentage to work ${name} out at`}
        />
        {/* Says what it is a percentage of, in figures. A helper that showed
          only its answer would be one more number to take on trust. */}
        <span className="text-muted-foreground">% of gross total ₹{inr(base)}</span>
        {/* The answer and the button wrap together and stay right, so on a
          phone Use does not end up stranded alone on the left. */}
        <span className="ml-auto flex items-center gap-2">
          <span className="text-foreground whitespace-nowrap font-semibold tabular-nums">
            ₹{inr(worked)}
          </span>
          <button
            type="button"
            className="btn-primary h-7 shrink-0 px-2.5 text-xs disabled:cursor-not-allowed disabled:opacity-50 disabled:shadow-none"
            disabled={!ready}
            onClick={() => onUse(Number(worked.toFixed(2)))}
          >
            Use
          </button>
        </span>
      </div>
      {base <= 0 && (
        <p className="text-muted-foreground mt-1.5 text-xs">
          Nothing to take a percentage of yet — put an item on the order first.
        </p>
      )}
    </div>
  )
}

function Row({ label, value }: { label: string; value: number }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-muted-foreground">{label}</span>
      <span className="text-foreground tabular-nums">{inr(value)}</span>
    </div>
  )
}

export function PurchaseOrderDialog({
  open,
  onClose,
  onSaved,
  record,
  fromEnquiry,
}: {
  open: boolean
  onClose: () => void
  onSaved: () => void
  record?: PurchaseOrder | null
  /**
   * The enquiry this order is being raised from.
   *
   * Prefills the supplier, the lines and the rates the supplier quoted, and
   * carries the link through to the server so the enquiry can say what has been
   * placed against it. Ignored when `record` is set: an order already saved has
   * its own enquiry and must not be re-pointed at another one from a stale link.
   *
   * The PI number is deliberately NOT sent from here. The server reads it off
   * the enquiry row, because the reference a price is defended with must come
   * from the recorded document rather than from a form.
   */
  fromEnquiry?: { enquiry: EnquiryLite; quote: EnquiryQuote } | null
}) {
  const isEdit = Boolean(record)
  /** Only for a new order — see the prop's note. */
  const source = isEdit ? null : (fromEnquiry ?? null)
  const enquiry = source?.enquiry ?? null
  /** Whose answer the order is being built on — the rates come off this. */
  const quote = source?.quote ?? null

  const [suppliers, setSuppliers] = useState<Option[]>([])
  const [items, setItems] = useState<Option[]>([])
  const [warehouses, setWarehouses] = useState<Option[]>([])
  const [customers, setCustomers] = useState<Option[]>([])
  const [categories, setCategories] = useState<Option[]>([])
  const [styles, setStyles] = useState<Option[]>([])
  const [chargeTypes, setChargeTypes] = useState<ChargeTypeOption[]>([])
  const [company, setCompany] = useState<CompanyLite | null>(null)

  // Header
  const [supplierId, setSupplierId] = useState('')
  const [poType, setPoType] = useState<PoType>('NONE')
  const [indentOpen, setIndentOpen] = useState(false)
  /**
   * Which row asked for an item the master does not hold yet.
   *
   * The index, not the line itself: the window is modal, so no row can be
   * added or removed while it is open and the index cannot go stale under it.
   */
  const [newItemFor, setNewItemFor] = useState<number | null>(null)
  const [warehouseId, setWarehouseId] = useState('')
  /// The date on the order. Asked for now, so a back-dated order lands in the
  /// right month rather than always taking today.
  const [poDate, setPoDate] = useState('')
  /// The next number, previewed. Read-only: it is allocated by the server when
  /// the order is written, because two people filling this form at once must
  /// not be shown the same number as though it were theirs.
  const [nextPoNumber, setNextPoNumber] = useState('')
  const [reference, setReference] = useState('')
  /// Internal. Unlike `notes` it is not printed on the supplier's copy, which
  /// is the whole reason the two are separate fields.
  const [remark, setRemark] = useState('')
  const [deliverTo, setDeliverTo] = useState<'ORGANIZATION' | 'CUSTOMER'>('ORGANIZATION')
  const [deliveryCustomerId, setDeliveryCustomerId] = useState('')
  const [discountAmount, setDiscountAmount] = useState('')
  const [notes, setNotes] = useState('')
  const [terms, setTerms] = useState('')

  /*
   * What has been typed against each kind of charge, keyed by charge type id.
   *
   * A map rather than a list because the rows are the charge master's rows —
   * the form does not decide which charges exist, Masters → Charges does.
   */
  const [charges, setCharges] = useState<Record<string, string>>({})
  const [otherCharges, setOtherCharges] = useState('')

  /**
   * Which charge's percentage helper is open, and what has been typed into it.
   *
   * Kept out of `charges` on purpose. This is scratch working, not part of the
   * order: it is thrown away when the form closes and none of it is sent.
   */
  const [pctOpen, setPctOpen] = useState<string | null>(null)
  const [pctOf, setPctOf] = useState<Record<string, string>>({})
  /*
   * What each item on the form has been bought at before, keyed by item.
   *
   * Fetched once per item and kept, because the same history feeds two things:
   * the "Last" figure under the Rate cell, and the panel behind View history.
   * Asking twice for the same item would be two round trips for one answer.
   */
  const [rateHistory, setRateHistory] = useState<Record<string, RateHistoryRow[]>>({})
  /* Which item's history is open in the panel, if any. */
  const [historyFor, setHistoryFor] = useState<string | null>(null)
  /*
   * The chosen supplier's addresses, and which one this order is billed to.
   *
   * Held separately from `suppliers` because they arrive per supplier: loading
   * every address of every supplier to fill one panel would be most of the
   * master for one line of text.
   */
  const [supplierAddresses, setSupplierAddresses] = useState<SupplierAddressRow[]>([])
  const [supplierAddressId, setSupplierAddressId] = useState('')
  const [addressPickerOpen, setAddressPickerOpen] = useState(false)
  const [addressFormFor, setAddressFormFor] = useState<'new' | string | null>(null)
  const [savingAddress, setSavingAddress] = useState(false)
  const [addressError, setAddressError] = useState<string | null>(null)
  const BLANK_ADDRESS = {
    label: '',
    address: '',
    city: '',
    state: '',
    stateCode: '',
    pincode: '',
    gstin: '',
    isDefault: false,
  }
  const [newAddress, setNewAddress] = useState(BLANK_ADDRESS)
  /*
   * Items already asked about. A ref rather than state so that the effect
   * below does not have to depend on it — depending on the answers while also
   * writing them is how a fetch loop starts.
   */
  const askedFor = useRef<Set<string>>(new Set())

  /*
   * The order's lines. Each carries its own item, its own category narrowing
   * and its own figures, because the table is where a line is both entered and
   * corrected now.
   */
  const [lines, setLines] = useState<PoLine[]>([])
  // Nothing about the item picker is held here any more — see `blankLine`.
  const [attachments, setAttachments] = useState<Attachment[]>([])
  // Files chosen on a new order, held here until it has a number to hang them
  // on. They go up the moment it is saved.
  const [pendingFiles, setPendingFiles] = useState<File[]>([])
  // The supplier's PI scan, on an order raised from his quote. Already in
  // storage against the enquiry; the server copies it onto the order on save.
  const [carriedFiles, setCarriedFiles] = useState<Attachment[]>([])
  const [uploading, setUploading] = useState(false)
  /* "or drag and drop" is printed on the drop zone, so it has to work, and a
     dragged file does not trigger :hover. Declared up here with the rest:
     below the `return null` that closes this form it would be called on an
     open form and skipped on a closed one, and React matches hooks up by the
     order they are called in. */
  const [dragOver, setDragOver] = useState(false)

  const [saving, setSaving] = useState<'draft' | 'send' | 'print' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [mounted, setMounted] = useState(false)
  const firstFieldRef = useRef<HTMLSelectElement | null>(null)

  // document does not exist while this page is rendered on the server, so the
  // portal can only be opened once the browser has it.
  useEffect(() => setMounted(true), [])

  useEffect(() => {
    if (!open) return
    setSupplierId(record?.supplierId ?? quote?.supplier.id ?? '')
    // A new order starts without a discount: most of this mill's carry none,
    // and a discount column that is live by default invites a figure nobody
    // agreed to.
    //
    // An order being reopened is a different question and keeps what it was
    // raised as. Orders raised before this form asked hold "STANDARD" in the
    // column — the database's own default, which is none of the three the
    // form offers — and those meant a discount per line, so they must still
    // reopen as that rather than quietly losing it.
    setPoType(
      !record
        ? 'NONE'
        : record.poType === 'ORDER_LEVEL' || record.poType === 'NONE'
          ? record.poType
          : 'ITEM_LEVEL'
    )
    setWarehouseId(record?.deliveryWarehouseId ?? '')
    setPoDate(record?.poDate?.slice(0, 10) ?? new Date().toISOString().slice(0, 10))
    setReference(record?.reference ?? '')
    setRemark(record?.remark ?? '')
    setDeliveryCustomerId(record?.deliveryCustomerId ?? '')
    setDeliverTo(record?.deliveryCustomerId ? 'CUSTOMER' : 'ORGANIZATION')
    // An order saved with no discount reopens with the box empty, not with a
    // zero in it — a zero sitting there is not a figure anyone typed.
    setDiscountAmount(num(record?.discountAmount) > 0 ? String(record?.discountAmount) : '')
    /*
     * Carried across from the enquiry, where there is one. The terms the mill
     * quoted with are the terms it is ordering on, and retyping them is how the
     * two documents come to disagree about what was agreed.
     */
    setNotes(record?.notes ?? enquiry?.notes ?? '')
    setTerms(record?.terms ?? enquiry?.terms ?? '')
    setLines(
      record?.lines?.length
        ? record.lines.map((l) => {
            const cat = categories.find((c) => c.id === l.item?.category?.id)
            return {
              itemId: l.itemId,
              codeText: l.item?.code ?? '',
              // Reopened at the level the item is actually filed under, so the
              // two dropdowns agree with the item beside them.
              categoryId: cat?.parentId ?? cat?.id ?? '',
              subcategoryId: cat?.parentId ? cat.id : '',
              description: l.description ?? '',
              // Falls back to the linked style's code for lines written before
              // this column existed, so an older order reopens showing its
              // style rather than an empty box.
              styleNo: l.styleNo ?? l.style?.code ?? '',
              styleId: l.styleId ?? '',
              qty: String(l.qty),
              unitRate: String(l.unitRate),
              // A stored line holds a percentage, so it reopens as one.
              discount: String(l.discount ?? 0),
              discountUnit: '%' as const,
              gstRate: String(l.gstRate ?? ''),
              // Kept on the way in, or editing an order would quietly cut every
              // line loose from the indent it was raised against and the
              // request would come back as unordered.
              mrLineId: l.mrLine?.id ?? null,
              mrNumber: l.mrLine?.mr?.mrNumber ?? null,
              // The scalar, not a relation: Prisma returns it on the row and
              // the edit path must keep it, or correcting an order would cut
              // every line loose from the enquiry it was quoted on.
              enquiryLineId: l.enquiryLineId ?? null,
            }
          })
        : enquiry?.lines?.length
          ? /*
             * Raised from an enquiry: the items, the quantities and the rates
             * the supplier quoted, already on the form.
             *
             * The rate falls back to zero rather than to our own expected rate
             * when he did not price the line. An estimate promoted into an
             * order's unit rate is a figure nobody agreed to arriving on a
             * document the supplier will be paid against — and a zero is
             * visibly unfinished, which is the honest state.
             *
             * `mrLineId` travels too, so a purchase that began as a production
             * request still traces back to the job through the enquiry.
             */
            enquiry.lines.map((l) => {
              const cat = categories.find(
                (c) => c.id === (l.item as { category?: { id: string } })?.category?.id
              )
              /*
               * What THIS supplier said about this line.
               *
               * Looked up per line rather than read off the line itself: three
               * suppliers answered the same enquiry and only the winner's rates
               * belong on this order.
               *
               * The quantity follows what he offered where he offered less than
               * was asked — a supplier who can manage 800 of the 1,240 has said
               * so, and ordering 1,240 from him puts a figure on the document he
               * never agreed to. The other 440 stays unplaced on the enquiry,
               * which is where the buyer goes to split it.
               */
              const ql = quote?.lines.find((x) => x.enquiryLineId === l.id) ?? null
              return {
                itemId: l.itemId,
                codeText: l.item.code ?? '',
                categoryId: cat?.parentId ?? cat?.id ?? '',
                subcategoryId: cat?.parentId ? cat.id : '',
                description: l.description ?? '',
                styleNo: '',
                styleId: '',
                qty: String(Number(ql?.offeredQty ?? l.qty)),
                unitRate: ql?.quotedRate == null ? '' : String(Number(ql.quotedRate)),
                discount: '0',
                discountUnit: '%' as const,
                gstRate: ql?.gstRate == null ? '' : String(Number(ql.gstRate)),
                mrLineId: l.mrLineId ?? null,
                mrNumber: l.mrLine?.mr?.mrNumber ?? null,
                enquiryLineId: l.id,
              }
            })
          : // Always one row to type into. An empty table has nowhere to start.
            [blankLine()]
    )
    setCharges(
      Object.fromEntries((record?.charges ?? []).map((c) => [c.chargeTypeId, String(c.amount)]))
    )
    setOtherCharges(num(record?.otherCharges) > 0 ? String(record?.otherCharges) : '')
    setPctOpen(null)
    setPctOf({})
    setAttachments([])
    setPendingFiles([])
    setCarriedFiles([])
    setRateHistory({})
    setHistoryFor(null)
    setSupplierAddresses([])
    setSupplierAddressId('')
    setAddressPickerOpen(false)
    setAddressFormFor(null)
    setAddressError(null)
    setNewAddress(BLANK_ADDRESS)
    askedFor.current = new Set()
    setError(null)
    setSaving(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- categories is
    // read for the category dropdowns and would re-run this reset every time
    // the master list loads, wiping what the buyer had typed.
  }, [open, record, enquiry, quote])

  // His PI scan comes with the order raised from it, so nobody uploads it twice.
  useEffect(() => {
    if (!open || record || !enquiry || !quote) return
    let alive = true
    api
      .get<{ success: boolean; data: Array<Attachment & { quoteId?: string | null }> }>(
        `/purchase/enquiries/${enquiry.id}/attachments`
      )
      .then((res) => {
        if (alive) setCarriedFiles(res.data.filter((a) => a.quoteId === quote.id).slice(0, MAX_FILES))
      })
      .catch(() => {
        // Not worth blocking the order over. The buyer can still attach it by hand.
      })
    return () => {
      alive = false
    }
  }, [open, record, enquiry, quote])

  /*
   * The chosen supplier's addresses.
   *
   * Reloaded whenever the supplier changes, and the default is selected unless
   * the order already names one — an order being edited keeps what it was
   * billed to, which is the whole reason the order stores it.
   *
   * A failure leaves the panel on the supplier's own fields, which is what it
   * showed before any of this existed.
   */
  useEffect(() => {
    if (!open || !supplierId) {
      setSupplierAddresses([])
      setSupplierAddressId('')
      return
    }
    let cancelled = false
    void api
      .get<{ data: SupplierAddressRow[] }>(`/masters/suppliers/${supplierId}/addresses`)
      .then((res) => {
        if (cancelled) return
        setSupplierAddresses(res.data)
        setSupplierAddressId((cur) => {
          if (cur && res.data.some((a) => a.id === cur)) return cur
          /*
           * An order being edited keeps what it was billed to.
           *
           * Matched back by its text, because the order stores the address as
           * words rather than as a link — deliberately, so that editing the
           * master cannot rewrite a document already sent. If nothing matches
           * the snapshot the supplier has since been changed, and the default
           * is the honest thing to offer.
           */
          const snapshot = record?.supplierAddress?.trim()
          if (snapshot) {
            const same = res.data.find((a) => addressLine(a) === snapshot)
            if (same) return same.id
          }
          return (res.data.find((a) => a.isDefault) ?? res.data[0])?.id ?? ''
        })
      })
      .catch(() => {
        if (!cancelled) setSupplierAddresses([])
      })
    return () => {
      cancelled = true
    }
  }, [open, supplierId])

  /*
   * Fetches the buying history of every item on the form, once each.
   *
   * Keyed on a sorted, joined list of item ids rather than on `lines`, which
   * changes on every keystroke in a quantity box. `askedFor` is a ref, so
   * writing the answers into state cannot re-trigger this.
   *
   * A failure costs the hint and nothing else: the Rate box is typed either
   * way, so there is no reason to stop the buyer over it.
   */
  useEffect(() => {
    if (!open) return
    const ids = [...new Set(lines.map((l) => l.itemId).filter(Boolean))]
    const missing = ids.filter((id) => !askedFor.current.has(id))
    if (missing.length === 0) return

    for (const id of missing) askedFor.current.add(id)

    for (const id of missing) {
      void api
        .get<{ data: RateHistoryRow[] }>(`/purchase/rate-history/${id}`)
        .then((res) => setRateHistory((prev) => ({ ...prev, [id]: res.data })))
        .catch(() => setRateHistory((prev) => ({ ...prev, [id]: [] })))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    open,
    lines
      .map((l) => l.itemId)
      .filter(Boolean)
      .sort()
      .join(','),
  ])

  useEffect(() => {
    if (!open) return
    let cancelled = false

    void Promise.all([
      masterResource<Option>('suppliers').list({ limit: 500, active: true }),
      masterResource<Option>('items').list({ limit: 500, active: true }),
      masterResource<Option>('warehouses').list({ limit: 100, active: true }),
      masterResource<Option>('customers').list({ limit: 500, active: true }),
      masterResource<Option>('item-categories')
        .list({ limit: 200, active: true })
        .catch(() => null),
      masterResource<Option>('styles')
        .list({ limit: 500, active: true })
        .catch(() => null),
      // The charge rows in the totals are these, one row each. Failing to load
      // them costs the charge boxes, not the form.
      masterResource<ChargeTypeOption>('charge-types')
        .list({ limit: 100, active: true })
        .catch(() => null),
      // The company block under "deliver to" is our own address. Settings is
      // the only place that serves it and a purchase clerk may not be allowed
      // in there, so the address is treated as a nicety, not a requirement.
      api.get<{ success: boolean; data: CompanyLite }>('/settings/company').catch(() => null),
      /*
       * What the next purchase order number will be, for the read-only box.
       *
       * Settings is the only place that knows, and a purchase clerk may not be
       * allowed in there — so a refusal costs the preview, not the form. The
       * real number is allocated by the server on save either way.
       */
      api
        .get<{ success: boolean; data: { docType: string; nextNumber: string }[] }>(
          '/settings/number-series'
        )
        .catch(() => null),
      /*
       * The mill's standard terms, so the box shows what the order will carry
       * instead of leaving the buyer to trust a placeholder. Read from the
       * purchase module rather than from settings, which a buyer may not be
       * allowed into. If it fails the box is simply left empty, and the server
       * still falls back to the same template when the sheet is printed — so
       * the terms reach the supplier either way.
       */
      api
        .get<{ success: boolean; data: { terms: string | null } }>('/purchase/order-defaults')
        .catch(() => null),
    ]).then(([s, i, w, cust, c, st, ct, co, ns, dflt]) => {
      if (cancelled) return
      setSuppliers((s as Paginated<Option>).data)
      setItems((i as Paginated<Option>).data)
      setWarehouses((w as Paginated<Option>).data)
      setCustomers((cust as Paginated<Option>).data)
      setCategories(c ? (c as Paginated<Option>).data : [])
      setStyles(st ? (st as Paginated<Option>).data : [])
      // Only the charges the mill actually puts on a purchase. The sales-only
      // ones are in the same master and would be noise here.
      setChargeTypes(
        ct
          ? (ct as Paginated<ChargeTypeOption & { applyOnPurchase?: boolean }>).data.filter(
              (t) => t.applyOnPurchase !== false
            )
          : []
      )
      setCompany(co?.data ?? null)
      setNextPoNumber(ns?.data.find((x) => x.docType === 'PO')?.nextNumber ?? '')
      /*
       * Only on a new order, and only into a box still empty.
       *
       * Not on an edit: an order already saved carries whatever terms it was
       * agreed on, and filling those in from today's template would rewrite
       * the agreement behind the buyer's back. Not over typed text either —
       * this arrives after the form has opened, and a buyer who started
       * typing in the meantime should not lose it.
       */
      if (!record) setTerms((cur) => cur || (dflt?.data.terms ?? ''))
    })

    return () => {
      cancelled = true
    }
  }, [open])

  // Only an order that exists can have files against it.
  useEffect(() => {
    if (!open || !record?.id) return
    let cancelled = false
    void api
      .get<{ success: boolean; data: Attachment[] }>(`/purchase/orders/${record.id}/attachments`)
      .then((res) => {
        if (!cancelled) setAttachments(res.data)
      })
      .catch(() => {
        // An order with no files and a server that would not answer look the
        // same here. The list stays empty; uploading will report the real
        // problem if there is one.
      })
    return () => {
      cancelled = true
    }
  }, [open, record?.id])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    // The page behind must not scroll while this is open, or closing the form
    // leaves the list somewhere the clerk did not put it.
    const previous = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    const focusTimer = setTimeout(() => firstFieldRef.current?.focus(), 50)
    return () => {
      document.removeEventListener('keydown', onKey)
      document.body.style.overflow = previous
      clearTimeout(focusTimer)
    }
  }, [open, onClose])

  const itemById = useMemo(() => new Map(items.map((i) => [i.id, i])), [items])
  const supplier = suppliers.find((s) => s.id === supplierId)

  /**
   * Everything about finding an item now lives on the row it belongs to.
   *
   * There used to be a form above the table holding a category, a subcategory,
   * a code box and an item dropdown, and then the same item appeared again as
   * a row below it. Two sets of controls for one line, and roughly 180px of
   * height spent saying the same thing twice. The row is the only place now.
   */
  const topCategories = useMemo(() => categories.filter((c) => !c.parentId), [categories])

  /** The children of one category, for that row's second dropdown. */
  const subCategoriesOf = (categoryId?: string | null) =>
    categoryId ? categories.filter((c) => c.parentId === categoryId) : []

  /**
   * The items one row may choose from, narrowed by whichever category level
   * that row has picked. Narrowing is per row on purpose: a fabric line and a
   * button line sit on the same order and were never looking at the same list.
   */
  const itemsFor = (line: PoLine) => {
    const childIds = new Set(subCategoriesOf(line.categoryId).map((c) => c.id))
    const inCategory = items.filter((it) => {
      if (line.subcategoryId) return it.categoryId === line.subcategoryId
      if (line.categoryId) {
        return it.categoryId === line.categoryId || childIds.has(it.categoryId ?? '')
      }
      return true
    })

    /*
     * A half-typed code narrows the list as well.
     *
     * Only while the row has no item yet. Once one is chosen the code box
     * holds that item's exact code, and narrowing by it would leave the Item
     * dropdown with a single option — so changing your mind about the item
     * would mean clearing the code box first.
     */
    const typed = (line.codeText ?? '').trim().toLowerCase()
    if (line.itemId || !typed) return inCategory

    return inCategory.filter(
      (it) => (it.code ?? '').toLowerCase().includes(typed) || it.name.toLowerCase().includes(typed)
    )
  }

  /** A fresh, empty row. The table always has at least one. */
  const blankLine = (): PoLine => ({
    itemId: '',
    codeText: '',
    categoryId: '',
    subcategoryId: '',
    description: '',
    styleNo: '',
    styleId: '',
    qty: '',
    unitRate: '',
    discount: '0',
    discountUnit: '%',
    gstRate: '',
    mrLineId: null,
    mrNumber: null,
    enquiryLineId: null,
  })

  /** Rows that have an item on them. A blank row is not part of the order. */
  const activeLines = lines.filter((l) => l.itemId)

  const deliveryCustomer =
    deliverTo === 'CUSTOMER' ? (customers.find((c) => c.id === deliveryCustomerId) ?? null) : null

  const customerStateCode =
    deliveryCustomer?.shippingStateCode ||
    deliveryCustomer?.billingStateCode ||
    deliveryCustomer?.shippingGstin?.slice(0, 2) ||
    deliveryCustomer?.gstin?.slice(0, 2) ||
    null

  const customerAddress =
    [
      deliveryCustomer?.shippingAddress,
      deliveryCustomer?.shippingCity,
      deliveryCustomer?.shippingPincode,
    ]
      .filter(Boolean)
      .join(', ') ||
    [
      deliveryCustomer?.billingAddress,
      deliveryCustomer?.billingCity,
      deliveryCustomer?.billingPincode,
    ]
      .filter(Boolean)
      .join(', ') ||
    null

  // Where the goods land. Our own address unless the order says a customer,
  // and it is this — not our state — that the supplier's state is compared
  // against, because goods are taxed where they are delivered.
  const placeOfSupply = customerStateCode || company?.stateCode

  const taxMode = !supplier
    ? null
    : !supplier.gstin
      ? 'NONE'
      : (supplier.stateCode ?? supplier.gstin?.slice(0, 2)) === placeOfSupply
        ? 'CGST_SGST'
        : 'IGST'

  /**
   * Which discounts this order is allowed to have.
   *
   * The dropdown at the top of the items box is not decoration — it decides
   * where a discount may sit, and the calculation has to agree with it or the
   * form shows one figure and saves another. Switching to "without discount"
   * with figures already typed must not leave them quietly in the total, so
   * they are ignored here as well as being greyed out.
   */
  const lineDiscountOf = (l: PoLine) => {
    if (poType !== 'ITEM_LEVEL') return 0
    const typed = num(l.discount)
    if ((l.discountUnit ?? '%') === '%') return Math.min(typed, 100)
    // Rupees. Capped at the line's own value, so a discount cannot take a line
    // below nothing.
    const gross = num(l.qty) * num(l.unitRate)
    return gross > 0 ? Math.min((typed / gross) * 100, 100) : 0
  }
  const orderDiscount = poType === 'ORDER_LEVEL' ? num(discountAmount) : 0

  const totals = useMemo(() => {
    const lineGross = lines.map((l) => num(l.qty) * num(l.unitRate))
    const lineAmounts = lines.map((l, i) => lineGross[i] * (1 - lineDiscountOf(l) / 100))
    const subtotal = lineAmounts.reduce((sum, n) => sum + n, 0)

    const discount = Math.min(orderDiscount, subtotal)
    const taxable = subtotal - discount
    const factor = subtotal > 0 ? taxable / subtotal : 1

    const lineTax =
      taxMode === 'NONE'
        ? 0
        : lines.reduce((sum, l, i) => sum + lineAmounts[i] * factor * (num(l.gstRate) / 100), 0)

    /*
     * Each charge is taxed at its own rate and is not discountable — the
     * mill's discount is negotiated on the goods, not on the transporter's
     * bill. Kept as rows so each one can be shown with its own GST.
     */
    const chargeRows = chargeTypes
      .map((t) => ({
        chargeTypeId: t.id,
        name: t.name,
        gstRate: num(t.defaultGstRate),
        percentOfValue: num(t.percentOfValue),
        amount: num(charges[t.id]),
      }))
      .map((c) => ({ ...c, tax: taxMode === 'NONE' ? 0 : c.amount * (c.gstRate / 100) }))

    const chargeTotal = chargeRows.reduce((sum, c) => sum + c.amount, 0)
    const chargeTax = chargeRows.reduce((sum, c) => sum + c.tax, 0)
    const tax = lineTax + chargeTax

    // No GST of its own, and added after tax — the way the old system had it.
    const other = num(otherCharges)

    const beforeRound = taxable + chargeTotal + tax + other
    const total = Math.round(beforeRound)

    /*
     * "Total discount" is every discount on the order added up, and "Gross
     * total" is what is left after them. Two rows that only make sense read in
     * that order, which is why the old form put them that way round.
     */
    const totalDiscount =
      lines.reduce((sum, l, i) => sum + lineGross[i] * (lineDiscountOf(l) / 100), 0) + discount

    return {
      lineAmounts,
      subtotal,
      discount,
      totalDiscount,
      grossTotal: taxable,
      taxable,
      chargeRows,
      chargeTotal,
      other,
      tax,
      roundOff: total - beforeRound,
      total,
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lines, discountAmount, taxMode, poType, chargeTypes, charges, otherCharges])

  /**
   * What a charge's percentage box opens on.
   *
   * Whatever was last typed for this charge while the form has been open;
   * failing that the share the charge master carries; failing that the rate
   * printed on the row, because that is the number in front of the buyer and
   * the one they mean when they say "five percent". A starting point only —
   * it is typed over freely and nothing is applied until Use is pressed.
   */
  const pctFor = (c: { chargeTypeId: string; gstRate: number; percentOfValue: number }) =>
    pctOf[c.chargeTypeId] ?? String(c.percentOfValue > 0 ? c.percentOfValue : c.gstRate)

  /** One row's own figures, worked out for the row it is shown in. */
  const priceOf = (l: PoLine) => {
    const qty = num(l.qty)
    const gross = qty * num(l.unitRate)
    const amount = gross * (1 - lineDiscountOf(l) / 100)
    return { gross, amount, netPrice: qty > 0 ? amount / qty : 0 }
  }

  /**
   * Rows that carry an item but are not finished.
   *
   * Checked at save rather than as you type, so a buyer can put every item on
   * the order first and work down the columns afterwards — which is how a
   * quotation is read. Each row is named and its empty cell is outlined, so on
   * a long order "which one" is never a hunt.
   */
  const supplierMissing = !supplierId

  /*
   * What the panel shows, in the order it can be trusted.
   *
   * The address chosen from the master first. Then, on an order being edited,
   * whatever that order was actually billed to — it may name a place the
   * supplier has since retired, and the order still says what it says. The
   * supplier's own fields last, for a supplier nobody has given addresses to.
   */
  const chosenAddress = supplierAddresses.find((a) => a.id === supplierAddressId)
  const billingLine =
    (chosenAddress && addressLine(chosenAddress)) ||
    record?.supplierAddress?.trim() ||
    [supplier?.address, supplier?.city, supplier?.state, supplier?.pincode]
      .map((p) => p?.trim())
      .filter(Boolean)
      .join(', ')

  /*
   * What the order is billed against, as label-and-value pairs.
   *
   * These four used to be a right-aligned stack of grey sentences — "GSTIN
   * 27...", "Phone 98...", "Terms 30 days" — each a different length, ragged
   * down the right edge of the box, with the label and the value in one
   * run of text. Laid out as pairs on a grid they line up, and the figure a
   * clerk is checking can be found without reading the words in front of it.
   *
   * Built here rather than in the markup so the empties can be dropped before
   * anything is laid out: three facts on a four-column grid leave one empty
   * cell, which is quieter than a cell reading "Phone —".
   */
  const supplierFacts: Array<{ label: string; value: string; mono?: boolean }> = supplier
    ? [
        { label: 'GSTIN', value: supplier.gstin ?? '', mono: true },
        { label: 'Phone', value: supplier.phone ?? '' },
        { label: 'Email', value: supplier.email ?? '' },
        {
          label: 'Payment terms',
          value:
            supplier.paymentTerms || (supplier.creditDays ? `${supplier.creditDays} days` : ''),
        },
      ].filter((f) => f.value.trim() !== '')
    : []

  const unfinished = activeLines
    .map((l) => ({
      name: itemById.get(l.itemId)?.name ?? 'A line',
      noQty: num(l.qty) <= 0,
      noRate: String(l.unitRate).trim() === '',
    }))
    .filter((r) => r.noQty || r.noRate)

  if (!open || !mounted) return null

  const setLine = (index: number, patch: Partial<PoLine>) =>
    setLines((prev) => prev.map((l, i) => (i === index ? { ...l, ...patch } : l)))

  /**
   * Puts an item on one row.
   *
   * The master's rate and GST are offered rather than imposed: the rate on
   * file is the one agreed last time and usually right, but a quoted price is
   * often not the standard one and an item never bought before has nothing on
   * file at all. Only filled when the cell is still empty, so a figure already
   * typed is never overwritten by changing the item.
   *
   * The category cells follow the item to wherever it is actually filed,
   * otherwise the row sits there contradicting itself — "Category: Fabric,
   * Item: BOPP Tape" when the tape is plainly under Packing Material.
   */
  const pickItemFor = (index: number, itemId: string) => {
    setError(null)

    if (itemId === ADD_NEW) {
      setNewItemFor(index)
      return
    }

    if (!itemId) {
      setLine(index, { itemId: '', codeText: '' })
      return
    }

    // The same item twice makes the order hard to check against the bill that
    // follows, and is nearly always a slip.
    if (lines.some((l, i) => i !== index && l.itemId === itemId)) {
      const clash = itemById.get(itemId)
      setError(
        `${clash?.name ?? 'That item'} is already on another row. Change the quantity there instead of adding it twice.`
      )
      return
    }

    const item = itemById.get(itemId)
    const cat = categories.find((c) => c.id === item?.categoryId)
    const line = lines[index]

    setLine(index, {
      itemId,
      codeText: item?.code ?? '',
      ...(cat
        ? cat.parentId
          ? { categoryId: cat.parentId, subcategoryId: cat.id }
          : { categoryId: cat.id, subcategoryId: '' }
        : {}),
      /*
       * The rate is left empty on purpose, and is not taken from the item
       * master.
       *
       * It used to be filled in from the master's standard rate when the cell
       * was blank, on the reasoning that the rate on file is usually right. It
       * is the wrong risk to take: a rate nobody looked at is a rate nobody
       * checked, and an order can go to a supplier at last year's price
       * without anybody noticing it was never typed. What the supplier quoted
       * is the only rate a purchase order should carry, so it is typed every
       * time. An order cannot be saved with the cell empty.
       *
       * The GST rate is still filled in, and that is not the same thing: the
       * tax on an item is a fact about the item and its HSN code, not
       * something negotiated with this supplier on this order.
       */
      ...(item?.taxRate && String(line.gstRate).trim() === ''
        ? { gstRate: String(item.taxRate.rate) }
        : {}),
    })
  }

  /**
   * The code cell resolves an item rather than merely narrowing the list.
   *
   * Every item has one unique code and that code is its identity — it is what
   * is quoted on the phone and written on the rack. Typing one in full picks
   * that item outright. Anything shorter is left alone, because it is a code
   * half remembered, not a mistake.
   */
  const typeCodeFor = (index: number, raw: string) => {
    setLine(index, { codeText: raw })
    setError(null)

    const typed = raw.trim().toLowerCase()
    if (!typed) return

    const exact = items.find((i) => (i.code ?? '').toLowerCase() === typed)
    if (exact) pickItemFor(index, exact.id)
  }

  /**
   * The style cell keeps what was typed and links it when it can.
   *
   * `styleNo` is always whatever is in the box. `styleId` is set only on an
   * exact match against a style's code, and cleared the moment the text stops
   * matching — a stale link to the style the text used to be would quietly
   * reconcile this material against the wrong garment.
   */
  const typeStyleFor = (index: number, raw: string) => {
    const typed = raw.trim().toLowerCase()
    const match = typed ? styles.find((st) => (st.code ?? '').toLowerCase() === typed) : undefined
    setLine(index, { styleNo: raw, styleId: match?.id ?? '' })
  }

  /** Opens the form on one existing address, filled in from it. */
  const startEditAddress = (a: SupplierAddressRow) => {
    setNewAddress({
      label: a.label ?? '',
      address: a.address,
      city: a.city ?? '',
      state: a.state ?? '',
      stateCode: a.stateCode ?? '',
      pincode: a.pincode ?? '',
      gstin: a.gstin ?? '',
      isDefault: a.isDefault,
    })
    setAddressFormFor(a.id)
    setAddressError(null)
  }

  /**
   * Saves the form — a new address, or a correction to one that exists.
   *
   * Either way it goes to the supplier, not onto this order. That is the whole
   * point: an address kept on one order would be typed again on the next, and
   * a correction made here would leave the master still wrong.
   *
   * The list is re-read from the server rather than patched by hand, because
   * marking one as the usual address demotes another and only the server knows
   * which that was.
   */
  const saveAddress = async () => {
    if (!addressFormFor || !supplierId) return
    setSavingAddress(true)
    setAddressError(null)
    const body = {
      label: newAddress.label.trim() || null,
      address: newAddress.address.trim(),
      city: newAddress.city.trim() || null,
      state: newAddress.state.trim() || null,
      stateCode: newAddress.stateCode.trim() || null,
      pincode: newAddress.pincode.trim() || null,
      gstin: newAddress.gstin.trim() || null,
      isDefault: newAddress.isDefault,
    }
    try {
      const saved =
        addressFormFor === 'new'
          ? await api.post<{ data: SupplierAddressRow }>(
              `/masters/suppliers/${supplierId}/addresses`,
              body
            )
          : await api.patch<{ data: SupplierAddressRow }>(
              `/masters/suppliers/${supplierId}/addresses/${addressFormFor}`,
              body
            )

      const list = await api
        .get<{ data: SupplierAddressRow[] }>(`/masters/suppliers/${supplierId}/addresses`)
        .catch(() => ({ data: [saved.data] }))

      setSupplierAddresses(list.data)
      setSupplierAddressId(saved.data.id)
      setAddressFormFor(null)
      setNewAddress(BLANK_ADDRESS)
    } catch (err) {
      setAddressError(
        err instanceof ApiError
          ? err.message
          : 'Could not save the address. It may need someone with rights to change masters.'
      )
    } finally {
      setSavingAddress(false)
    }
  }

  const addRow = () => {
    setLines((prev) => [...prev, blankLine()])
    setError(null)
  }

  /**
   * Drops the lines picked off the indent list onto the order.
   *
   * One row per request, even where two requests are for the same item. The
   * form stops a *buyer* putting the same item on twice, because that is
   * almost always a slip; two indents asking for the same thread for two
   * different jobs is not a slip, and merging them would throw away the link
   * from one of them — which is the whole reason for taking the line off an
   * indent rather than typing it.
   *
   * The rate is left blank, as it is for a typed line. What the supplier
   * quoted is the only rate a purchase order should carry, and production
   * asking for something says nothing about its price.
   *
   * Blank rows already on the form are cleared out first: a new order opens
   * with one empty row, and keeping it would leave a row with no item on an
   * order somebody is about to save.
   */
  const addFromIndent = (picks: IndentPick[]) => {
    setLines((prev) => {
      const kept = prev.filter((l) => l.itemId)
      const fresh = picks.map(({ row, qty }) => {
        const cat = categories.find((c) => c.id === itemById.get(row.item.id)?.categoryId)
        return {
          ...blankLine(),
          itemId: row.item.id,
          codeText: row.item.code,
          ...(cat
            ? cat.parentId
              ? { categoryId: cat.parentId, subcategoryId: cat.id }
              : { categoryId: cat.id, subcategoryId: '' }
            : {}),
          qty: String(qty),
          gstRate: row.item.taxRate ? String(Number(row.item.taxRate.rate)) : '',
          mrLineId: row.mrLineId,
          mrNumber: row.mrNumber,
        }
      })
      return [...kept, ...fresh]
    })
    setIndentOpen(false)
    setError(null)
  }

  /**
   * Removing the last row leaves a blank one behind rather than an empty
   * table: there is nowhere to start typing otherwise, and "add a row" would
   * be a second thing to discover before any work could be done.
   */
  const removeRow = (index: number) =>
    setLines((prev) => {
      const left = prev.filter((_, i) => i !== index)
      return left.length ? left : [blankLine()]
    })

  // poDate and deliveryDate are deliberately absent. The form no longer asks
  // for either, and omitting them rather than sending a value means a new
  // order takes today's date from the API, while editing an existing draft
  // leaves the date it already carries alone instead of overwriting it.
  /**
   * Sends files to storage, then tells the API they landed.
   *
   * The bytes go straight from this browser to the bucket on a one-use link
   * the API signs — they never pass through our server. One file at a time on
   * purpose: a mill connection that drops halfway should cost one file, and
   * the message should name it.
   */
  /** The three steps for one file against one order. */
  const uploadOne = async (file: File, orderId: string): Promise<Attachment> => {
    const signed = await api.post<{
      success: boolean
      data: { uploadUrl: string; storagePath: string }
    }>(`/purchase/orders/${orderId}/attachments/upload-url`, {
      fileName: file.name,
      sizeBytes: file.size,
    })

    // The token is in the URL's query string, which is the whole
    // authorisation. No header, and deliberately not our own API token.
    const put = await fetch(signed.data.uploadUrl, {
      method: 'PUT',
      headers: { 'Content-Type': file.type || 'application/octet-stream' },
      body: file,
    })
    if (!put.ok) {
      throw new Error(`${file.name} could not be sent. Check your connection and try again.`)
    }

    const saved = await api.post<{ success: boolean; data: Attachment }>(
      `/purchase/orders/${orderId}/attachments`,
      { fileName: file.name, storagePath: signed.data.storagePath }
    )
    return saved.data
  }

  /**
   * What the file box does.
   *
   * On an order that exists the file goes up straight away. On one being
   * written it is held instead, because a file needs something to belong to
   * and the order has no number yet — see `save`, which sends them the moment
   * it does.
   */
  const chooseFiles = (fileList: FileList | null) => {
    if (!fileList?.length) return
    const chosen = Array.from(fileList)

    const room = MAX_FILES - attachments.length - pendingFiles.length - carriedFiles.length
    if (chosen.length > room) {
      setError(
        room === 0
          ? `This order already has ${MAX_FILES} files. Remove one before adding another.`
          : `Only ${room} more file${room === 1 ? '' : 's'} can be attached to this order.`
      )
      return
    }

    const tooBig = chosen.find((f) => f.size > MAX_FILE_MB * 1024 * 1024)
    if (tooBig) {
      setError(
        `${tooBig.name} is ${(tooBig.size / 1024 / 1024).toFixed(1)}MB. The limit is ${MAX_FILE_MB}MB.`
      )
      return
    }

    setError(null)
    if (record?.id) void uploadFiles(fileList)
    else setPendingFiles((prev) => [...prev, ...chosen])
  }

  const uploadFiles = async (fileList: FileList | null) => {
    if (!fileList?.length || !record?.id) return

    const chosen = Array.from(fileList)
    const room = MAX_FILES - attachments.length
    if (chosen.length > room) {
      setError(
        room === 0
          ? `This order already has ${MAX_FILES} files. Remove one before adding another.`
          : `Only ${room} more file${room === 1 ? '' : 's'} can be attached to this order.`
      )
      return
    }

    setUploading(true)
    setError(null)

    try {
      for (const file of chosen) {
        if (file.size > MAX_FILE_MB * 1024 * 1024) {
          throw new Error(
            `${file.name} is ${(file.size / 1024 / 1024).toFixed(1)}MB. The limit is ${MAX_FILE_MB}MB.`
          )
        }

        const signed = await api.post<{
          success: boolean
          data: { uploadUrl: string; storagePath: string }
        }>(`/purchase/orders/${record.id}/attachments/upload-url`, {
          fileName: file.name,
          sizeBytes: file.size,
        })

        // Straight to storage. Not through lib/api, because this is not our
        // API and it must not carry our token.
        // The token is in the URL's query string, which is the whole
        // authorisation. No header, and deliberately not our own API token.
        const put = await fetch(signed.data.uploadUrl, {
          method: 'PUT',
          headers: { 'Content-Type': file.type || 'application/octet-stream' },
          body: file,
        })
        if (!put.ok) {
          throw new Error(`${file.name} could not be sent. Check your connection and try again.`)
        }

        const saved = await api.post<{ success: boolean; data: Attachment }>(
          `/purchase/orders/${record.id}/attachments`,
          { fileName: file.name, storagePath: signed.data.storagePath }
        )
        setAttachments((prev) => [...prev, saved.data])
      }
    } catch (err) {
      setError(
        err instanceof ApiError
          ? err.message
          : err instanceof Error
            ? err.message
            : 'Could not attach that file.'
      )
    } finally {
      setUploading(false)
    }
  }

  /** Links are signed on demand and expire, so one is fetched per click. */
  const openFile = async (id: string) => {
    try {
      const res = await api.get<{ success: boolean; data: { url: string } }>(
        `/purchase/attachments/${id}/link`
      )
      window.open(res.data.url, '_blank', 'noopener')
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not open that file.')
    }
  }

  const removeFile = async (file: Attachment) => {
    if (!confirm(`Remove ${file.fileName}?`)) return
    try {
      await api.delete(`/purchase/attachments/${file.id}`)
      setAttachments((prev) => prev.filter((f) => f.id !== file.id))
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not remove that file.')
    }
  }

  const payload = () => ({
    supplierId,
    poType,
    // The link, not the reference. The server fills `enquiryNo` and
    // `enquiryDate` from the enquiry's own PI row.
    enquiryId: enquiry?.id ?? null,
    enquiryQuoteId: quote?.id ?? null,
    quoteAttachmentIds: isEdit ? undefined : carriedFiles.map((f) => f.id),
    deliveryWarehouseId: deliverTo === 'CUSTOMER' ? null : warehouseId || null,
    deliveryCustomerId: deliverTo === 'CUSTOMER' ? deliveryCustomerId || null : null,
    poDate: poDate || undefined,
    // Which of the supplier's addresses. The server renders the text from the
    // row and keeps it on the order, so the words cannot come from here.
    supplierAddressId: supplierAddressId || null,
    reference: reference.trim() || null,
    remark: remark.trim() || null,
    // Only an order-level order has one. Sending whatever is in the box on an
    // item-level order would take the discount twice.
    discountAmount: poType === 'ORDER_LEVEL' ? num(discountAmount) : 0,
    // Only the kind and the amount. The GST rate is read off the charge type
    // on the server, so a rate corrected in the master since this form loaded
    // cannot be overridden from the browser.
    charges: totals.chargeRows
      .filter((c) => c.amount > 0)
      .map((c) => ({ chargeTypeId: c.chargeTypeId, amount: c.amount })),
    otherCharges: num(otherCharges),
    notes: notes.trim() || null,
    terms: terms.trim() || null,
    /*
     * Only rows that have an item, and only the fields the API knows about.
     * The category narrowing and the code box are how a row found its item;
     * they are not part of the order and are dropped here.
     */
    lines: activeLines.map((l) => ({
      itemId: l.itemId,
      description: (l.description as string)?.trim() || null,
      styleNo: (l.styleNo as string)?.trim() || null,
      styleId: (l.styleId as string) || null,
      mrLineId: l.mrLineId || null,
      enquiryLineId: l.enquiryLineId || null,
      qty: num(l.qty),
      unitRate: num(l.unitRate),
      // A percentage whichever unit it was typed in — see `lineDiscountOf`.
      discount: lineDiscountOf(l),
      gstRate: num(l.gstRate),
    })),
  })

  /**
   * `mode` decides what happens after the order is written.
   *
   * Saving a draft stops there. Saving the order marks it sent, which is a
   * second call on purpose — the order exists either way, so if marking it
   * sent fails the work is not lost, it is a draft waiting to be sent.
   */
  const save = async (mode: 'draft' | 'send' | 'print') => {
    setSaving(mode)
    setError(null)

    try {
      let id = record?.id
      // His PI scan is copied by the server; whatever did not make it comes back named.
      let carryFailed: Array<{ name: string; why: string }> = []
      if (isEdit && record) {
        await api.patch(`/purchase/orders/${record.id}`, payload())
      } else {
        const res = await api.post<{
          success: boolean
          data: { id: string }
          fileFailures?: Array<{ name: string; why: string }>
        }>('/purchase/orders', payload())
        id = res.data.id
        setCarriedFiles([])
        carryFailed = res.fileFailures ?? []
      }

      // Files chosen before the order existed. It has a number now, so they
      // have something to belong to.
      //
      // A failure here does not fail the save — the order is already written
      // and throwing it away over an attachment would be the worse outcome.
      // The names of whatever did not make it are reported instead, and they
      // can be added by reopening the order.
      if ((pendingFiles.length || carryFailed.length) && id) {
        // The reason is kept, not just the name. Naming a file that failed
        // without saying why leaves the person at the desk — and whoever they
        // ring about it — with nowhere at all to go.
        const failed: Array<{ name: string; why: string }> = [...carryFailed]
        for (const file of pendingFiles) {
          try {
            await uploadOne(file, id)
          } catch (err) {
            failed.push({
              name: file.name,
              why:
                err instanceof ApiError
                  ? err.message
                  : err instanceof Error
                    ? err.message
                    : 'no reason given',
            })
          }
        }
        setPendingFiles([])

        if (failed.length) {
          onSaved()
          setError(
            `The order was saved, but ${failed.length === 1 ? 'this file' : 'these files'} did not attach — ` +
              failed.map((f) => `${f.name}: ${f.why}`).join(' · ') +
              '. Reopen the order to try again.'
          )
          setSaving(null)
          return
        }
      }

      // Only a draft needs sending. An order that is already with the supplier
      // stays sent when it is corrected, and asking the server to send it a
      // second time fails — which would then tell the buyer, wrongly, that
      // their order is waiting as a draft.
      const alreadySent = isEdit && record?.status !== 'DRAFT'

      if (mode !== 'draft' && id && !alreadySent) {
        try {
          await api.patch(`/purchase/orders/${id}/send`, {})
        } catch (err) {
          onSaved()
          setError(
            err instanceof ApiError
              ? `The order was saved, but marking it sent failed: ${err.message} It is waiting as a draft.`
              : 'The order was saved as a draft, but marking it sent failed.'
          )
          setSaving(null)
          return
        }
      }

      /*
       * Printing opens the sheet in a second tab rather than printing from
       * here. The print page is a route of its own that fetches the saved
       * order, so it can only show what was actually written — printing from
       * the form's own state could put a sheet in the supplier's hands that
       * does not match the order on the system.
       *
       * Opened before the form closes, while this click is still the reason
       * anything is happening: a popup blocker refuses a window that no
       * longer traces back to a user action.
       */
      if (mode === 'print' && id) {
        window.open(`/print/purchase-order/${id}`, '_blank', 'noopener')
      }

      onSaved()
      onClose()
    } catch (err) {
      setError(apiErrorMessage(err, 'Could not save. Is the API running?'))
    } finally {
      setSaving(null)
    }
  }

  // Sent and still-to-send together: the limit is five files on the order,
  // not five of each.
  const fileCount = attachments.length + pendingFiles.length + carriedFiles.length

  const incomplete = !supplierId || activeLines.length === 0 || unfinished.length > 0
  const busy = saving !== null
  const orgAddress = [company?.address, company?.city, company?.pincode].filter(Boolean).join(', ')
  // Where the goods are actually going: the chosen warehouse, or our own
  // address when none is picked.
  const destination = warehouses.find((w) => w.id === warehouseId) ?? null

  /**
   * Rendered into `document.body` rather than where it sits in the page.
   *
   * `position: fixed` is only as good as its ancestors: a transform, a filter,
   * a backdrop-filter or a `contain` anywhere above it silently turns that
   * element into the containing block, and `inset-0` then means the corners of
   * *that* box rather than the corners of the screen. This form lives inside
   * the dashboard shell — sidebar, top bar, a padded main, an animated
   * wrapper — and any one of those acquiring such a property later would put a
   * band of undimmed page above the modal again, for a reason nobody would
   * think to look for.
   *
   * From the body there is nothing above it to get in the way.
   */
  /*
   * Save, written once and shown twice.
   *
   * The form is long enough to scroll, so there is one at the top as well as
   * at the bottom and finishing an order never means scrolling back to look
   * for it. Written once because the disabled state is the part that must
   * never disagree: a Save that looks live at the top and dead at the bottom
   * is worse than either.
   *
   * Only this one is repeated. All three sat in the header and all four in the
   * footer, which is seven buttons for four actions — and the two at the top
   * that were not Save had no reason to be there, since choosing between
   * draft, print and send is the last decision made about an order, not the
   * first. The header keeps Save; the footer keeps the choice.
   */
  const primarySave = (
    <button
      type="button"
      onClick={() => void save('send')}
      className="btn-primary"
      disabled={busy || incomplete}
    >
      {saving === 'send' ? <Loader2 size={15} className="animate-spin" /> : <SaveIcon size={15} />}
      Save
    </button>
  )

  const saveActions = (
    <>
      <button
        type="button"
        onClick={() => void save('draft')}
        className="btn-secondary"
        disabled={busy || incomplete}
      >
        {saving === 'draft' ? (
          <Loader2 size={15} className="animate-spin" />
        ) : (
          <SaveIcon size={15} />
        )}
        {/* Short on a phone, so the three choices share one row. */}
        <span className="sm:hidden">Draft</span>
        <span className="hidden sm:inline">Save as draft</span>
      </button>
      <button
        type="button"
        onClick={() => void save('print')}
        className="btn-secondary"
        disabled={busy || incomplete}
        title="Save and print"
      >
        {saving === 'print' ? (
          <Loader2 size={15} className="animate-spin" />
        ) : (
          <Printer size={15} />
        )}
        <span className="sm:hidden">Print</span>
        <span className="hidden sm:inline">Save and print</span>
      </button>
      {primarySave}
    </>
  )

  return createPortal(
    <>
      {/* The overlay stops where the sidebar ends, so the menu is neither dimmed nor covered and
          the app can still be navigated with the form open. Stopping short of it beats raising the
          sidebar above the overlay: on a narrower screen a sidebar sitting on top would clip the
          left edge of a centred form. On a phone the sidebar already takes most of the width, so
          there the overlay covers everything as before. */}
      <div className="fixed inset-0 z-50 flex items-stretch justify-center bg-black/60 p-2 backdrop-blur-sm sm:left-[var(--sidebar-current-width)] sm:p-3">
        {/* `h-full`, not `max-h-full` and not a vh figure.

          A cap only says how tall the card may not be. This form's content
          came out a little shorter than the screen, so the card hugged it and
          the leftover was split above and below as centring slack — about
          27px of dimmed page over the top, which is what kept coming back
          however the cap was tuned.

          Filling the height instead makes the margin the padding and nothing
          else, top and bottom, by construction rather than by arithmetic:
          8px on a phone, 12px on a desktop. The body scrolls inside, which it
          did already. */}
        <div
          className="glass-card po-form flex h-full max-h-full w-full flex-col overflow-hidden"
          role="dialog"
          aria-modal="true"
          aria-labelledby="po-dialog-title"
        >
          {/* Header — stays put while the body scrolls, so it is always clear what is being filled in */}
          <div className="border-border flex shrink-0 items-center justify-between gap-4 border-b px-5 py-3.5">
            <div className="flex min-w-0 items-center gap-3">
              <div className="bg-primary/10 border-primary/20 flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border">
                <ShoppingCart size={19} className="text-primary" />
              </div>
              <div>
                <h2
                  id="po-dialog-title"
                  className="text-foreground truncate text-xl font-semibold tracking-tight"
                >
                  Purchase Order
                </h2>
                {/* The number moves down here rather than into the heading. The
                  heading says what the form is; the line under it says which
                  one and what may be done to it. */}
                <p className="text-muted-foreground mt-0.5 text-[13px]">
                  {isEdit
                    ? `${record?.poNumber} — only a draft order can be changed`
                    : 'New order to a supplier'}
                </p>
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <div className="hidden md:block">{primarySave}</div>
              <button onClick={onClose} className="btn-ghost p-2" aria-label="Close">
                <X size={18} />
              </button>
            </div>
          </div>

          {/* Body — the only thing that scrolls */}
          <div className="flex-1 space-y-3 overflow-y-auto px-4 py-3">
            {error && (
              <div className="flex items-start gap-3 rounded-lg border border-red-500/40 bg-red-500/5 p-3">
                <AlertCircle size={16} className="mt-0.5 shrink-0 text-red-400" />
                <p className="text-sm text-red-400">{error}</p>
              </div>
            )}

            {/* 1 — What the order is and who it is to.

              Six fields, two rows of three, in the order the mill reads them:
              where it is going and which order this is, then who it is from
              and what to quote back. The supplier sits in here rather than in
              a box of its own — it is one dropdown, and a box to itself left a
              column of empty space beside it. */}
            {/* Where this order came from, when it came from an enquiry.

              Read-only on purpose. The PI number is what the printed order
              quotes back to the supplier, and it is taken off the recorded
              enquiry by the server rather than from anything typed here —
              so a price on an order always has a document behind it.

              The lapsed warning is a warning and not a block. The validity
              is the supplier's own statement about how long he will hold
              the rate, not a rule of ours, and he usually honours it anyway;
              refusing the order would mean retyping the whole thing by hand
              to place something he has already agreed to. */}
            {enquiry && quote && (
              <div className="border-border/70 bg-secondary/30 flex flex-wrap items-center gap-x-5 gap-y-1.5 rounded-lg border px-3 py-2">
                <span className="text-muted-foreground text-[11px]">
                  Raised from{' '}
                  <span className="text-foreground font-mono">{enquiry.enquiryNumber}</span>
                  {/* Which of them won, said out loud. An enquiry that went to
                    three suppliers gives three different prices, and an order
                    that named only the enquiry would not say whose it is on. */}
                  {enquiry.supplierCount > 1 && (
                    <>
                      {' · '}
                      <span className="text-foreground">{quote.supplier.name}</span>
                      {' of ' + enquiry.supplierCount}
                    </>
                  )}
                </span>
                {quote.piNumber && (
                  <span className="text-muted-foreground text-[11px]">
                    against PI <span className="text-foreground font-mono">{quote.piNumber}</span>
                    {quote.piDate && ' dated ' + new Date(quote.piDate).toLocaleDateString('en-IN')}
                  </span>
                )}
                {quote.piValidUntil &&
                  (new Date(quote.piValidUntil).getTime() < Date.now() ? (
                    <span className="text-[11px] font-medium text-amber-400">
                      his price lapsed on {new Date(quote.piValidUntil).toLocaleDateString('en-IN')}{' '}
                      — worth confirming before you send this
                    </span>
                  ) : (
                    <span className="text-muted-foreground text-[11px]">
                      price held to {new Date(quote.piValidUntil).toLocaleDateString('en-IN')}
                    </span>
                  ))}
                {/* Ordering the one that is not cheapest is a decision, not a
                  mistake — lead time and quality are not on that comparison —
                  but it should be a decision taken knowingly. */}
                {enquiry.best && enquiry.best.quoteId !== quote.id && (
                  <span className="text-[11px] font-medium text-amber-400">
                    {enquiry.best.supplierName} quoted less
                  </span>
                )}
              </div>
            )}
            <Section icon={FileText} title="Basic Details">
              {/* `auto-fit`, not a fixed two columns: fields pair up only
                while each box is 160px or more, and drop to one column
                below that. At 105px a phone paired them and clipped the
                location and supplier pickers to "Head offic" and "Choose
                su" — stacking is longer, but every box says what is in it.
                `order` moves them back into the desktop's three
                grouped rows (location/number/date, then supplier/
                reference/remark) without changing the DOM, so tab order
                still matches what is on screen at every width. */}
              <div className="grid grid-cols-[repeat(auto-fit,minmax(160px,1fr))] gap-x-4 gap-y-3 md:grid-cols-3">
                <div className="order-1 md:order-1">
                  <label className="form-label" htmlFor="po-location">
                    Location
                  </label>
                  {/* The icon is drawn over the control and the control padded to
                    clear it, rather than set beside it in a flex row. Outside
                    the border it would push each control a different distance
                    from its label and break the line the six fields make. */}
                  <div className="relative">
                    <MapPin
                      size={14}
                      className="text-muted-foreground pointer-events-none absolute left-3 top-1/2 z-10 -translate-y-1/2"
                    />
                    <select
                      id="po-location"
                      ref={firstFieldRef}
                      className="form-input pl-9"
                      value={warehouseId}
                      onChange={(e) => setWarehouseId(e.target.value)}
                    >
                      <option value="">Head office</option>
                      {warehouses.map((w) => (
                        <option key={w.id} value={w.id}>
                          {w.name}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>

                <div className="order-3 md:order-2">
                  <label className="form-label" htmlFor="po-number">
                    Purchase order<span className="ml-0.5 text-red-500">*</span>
                  </label>
                  {/* Read-only on purpose. The number comes from the counter in
                    Settings → Company when the order is written, so that two
                    clerks filling this form at the same moment cannot both be
                    handed the same one. What is shown on a new order is a
                    preview of what is next, not a reservation. */}
                  <input
                    id="po-number"
                    className="form-input font-mono"
                    value={isEdit ? (record?.poNumber ?? '') : nextPoNumber}
                    readOnly
                    placeholder="Allocated on save"
                    aria-describedby={isEdit ? undefined : 'po-number-note'}
                  />
                  {!isEdit && (
                    <p id="po-number-note" className="text-muted-foreground mt-1 text-xs">
                      Allocated when you save.
                    </p>
                  )}
                </div>

                <div className="order-4 md:order-3">
                  <label className="form-label" htmlFor="po-date">
                    Date
                  </label>
                  {/* No calendar glyph of our own on this one. A date input
                    already draws the browser's picker button at its right end,
                    and that is the one that opens the calendar — ours sat on
                    the left doing nothing, so the field carried two calendars
                    and only one of them worked. */}
                  <input
                    id="po-date"
                    type="date"
                    className="form-input"
                    value={poDate}
                    onChange={(e) => setPoDate(e.target.value)}
                  />
                </div>

                <div className="order-2 md:order-4">
                  <label className="form-label" htmlFor="po-supplier">
                    Supplier<span className="ml-0.5 text-red-500">*</span>
                  </label>
                  <div className="relative">
                    <User
                      size={14}
                      className="text-muted-foreground pointer-events-none absolute left-3 top-1/2 z-10 -translate-y-1/2"
                    />
                    <select
                      id="po-supplier"
                      className="form-input pl-9"
                      value={supplierId}
                      onChange={(e) => setSupplierId(e.target.value)}
                      aria-describedby={supplierMissing ? 'po-supplier-error' : undefined}
                    >
                      <option value="">Choose supplier</option>
                      {suppliers.map((s) => (
                        <option key={s.id} value={s.id}>
                          {s.code ? `${s.code} — ${s.name}` : s.name}
                        </option>
                      ))}
                    </select>
                  </div>
                  {/* A prompt, not an alarm. Every Save on this form is
                    disabled while the supplier is empty, so this still says
                    which field is holding them back — but in the same grey a
                    blank box on a form nobody has filled in yet gets
                    everywhere else on this screen. Red is for a mistake
                    already made, and choosing nothing on a form just opened
                    is not one. */}
                  {supplierMissing ? (
                    <p id="po-supplier-error" className="text-muted-foreground mt-1 text-xs">
                      Choose the supplier to save this order
                    </p>
                  ) : null}
                </div>

                <div className="order-5 md:order-5">
                  <label className="form-label" htmlFor="po-reference">
                    Reference
                  </label>
                  <div className="relative">
                    <FileText
                      size={14}
                      className="text-muted-foreground pointer-events-none absolute left-3 top-1/2 z-10 -translate-y-1/2"
                    />
                    <input
                      id="po-reference"
                      className="form-input pl-9"
                      placeholder="Job number, indent slip, anything to quote back"
                      value={reference}
                      onChange={(e) => setReference(e.target.value)}
                    />
                  </div>
                </div>

                <div className="order-6 md:order-6">
                  <label className="form-label" htmlFor="po-remark">
                    Remark
                  </label>
                  <div className="relative">
                    <MessageSquare
                      size={14}
                      className="text-muted-foreground pointer-events-none absolute left-3 top-1/2 z-10 -translate-y-1/2"
                    />
                    <input
                      id="po-remark"
                      className="form-input pl-9"
                      placeholder="Internal note, not printed on the order"
                      value={remark}
                      onChange={(e) => setRemark(e.target.value)}
                    />
                  </div>
                </div>
              </div>

              {/* Who the order is to, filled in from the supplier master.

                Full width under the six fields rather than tucked into the
                Supplier cell: an address is four lines and a dropdown is one,
                so inside the cell it would have stretched that row and left
                Reference and Remark sitting above a column of empty space.

                Not typed into. The master is the one place a supplier's
                address is kept, and a box here that could be edited would be a
                second version of it that nothing keeps in step — Change edits
                the master itself. */}
              {supplier && (
                <div className="border-border bg-secondary mt-3 rounded-lg border">
                  <div className="border-border/70 flex flex-wrap items-center gap-x-2 gap-y-1 border-b px-3 py-1.5">
                    <h4 className="text-muted-foreground text-[10px] font-semibold uppercase tracking-wider">
                      Billing address
                    </h4>
                    {chosenAddress?.label && (
                      <span className="text-muted-foreground text-[10px]">
                        · {chosenAddress.label}
                      </span>
                    )}
                    {/* The tax split follows the two GSTINs, and it decides what
                        the supplier may charge — so it is said here, beside the
                        number it is worked out from, rather than discovered on
                        the bill. A chip rather than a fifth grey sentence: it
                        is a conclusion, not a field off the master. */}
                    {supplier.gstin && taxMode && taxMode !== 'NONE' && (
                      <span className="border-primary/25 bg-primary/10 text-primary ml-1 rounded-full border px-2 py-0.5 text-[10px] font-medium">
                        {taxMode === 'CGST_SGST'
                          ? 'Within the state · CGST + SGST'
                          : 'Other state · IGST'}
                      </span>
                    )}
                    <button
                      type="button"
                      onClick={() => setAddressPickerOpen(true)}
                      className="text-primary ml-auto flex shrink-0 items-center gap-1 text-xs hover:underline"
                    >
                      <Pencil size={11} />
                      Change
                      {supplierAddresses.length > 1 && (
                        <span className="text-muted-foreground">({supplierAddresses.length})</span>
                      )}
                    </button>
                  </div>

                  <div className="px-3 py-2.5">
                    <p className="text-foreground text-sm font-semibold">{supplier.name}</p>
                    {billingLine ? (
                      <p className="text-muted-foreground mt-0.5 text-sm leading-relaxed">
                        {billingLine}
                      </p>
                    ) : (
                      <p className="text-muted-foreground mt-0.5 text-sm">
                        No address on this supplier — add it under{' '}
                        <a
                          href="/masters/suppliers"
                          target="_blank"
                          rel="noreferrer"
                          className="text-primary underline"
                        >
                          Masters → Suppliers
                        </a>
                        .
                      </p>
                    )}

                    {supplierFacts.length > 0 && (
                      <div className="border-border/70 mt-2.5 grid grid-cols-2 gap-x-4 gap-y-2 border-t pt-2.5 sm:grid-cols-4">
                        {supplierFacts.map((f) => (
                          <div key={f.label} className="min-w-0">
                            <p className="text-muted-foreground text-[10px] font-semibold uppercase tracking-wider">
                              {f.label}
                            </p>
                            <p
                              className={`text-foreground truncate text-xs ${f.mono ? 'font-mono' : ''}`}
                              title={f.value}
                            >
                              {f.value}
                            </p>
                          </div>
                        ))}
                      </div>
                    )}

                    {!supplier.gstin && (
                      <p className="warn-text mt-2 text-xs">
                        No GSTIN on file — this order will carry no GST.
                      </p>
                    )}
                  </div>
                </div>
              )}
            </Section>

            {/* 2 — The order's lines, entered where they are shown.

              One table, not a form above a table. Every field a line has is a
              column in it, and a row is typed left to right; "+ Add item row"
              puts a fresh one underneath. There used to be two sets of the
              same ten controls — one to enter a line, one to correct it — and
              about 180px of height spent saying everything twice.

              The row is filled in the order the question is actually asked:
              the category and its subcategory first, then the code and the
              item, which offer only what that category holds. The row number
              and its delete stay pinned to the left edge, so on a table
              scrolled sideways you can still tell row four from row five and
              still remove it. */}
            <Section
              icon={Package}
              title="Item Details"
              actions={
                <>
                  {/* Where the old ERP puts it: on the items bar, left of the
                    order type, so it is the first thing offered when there are
                    items to add rather than something found afterwards. */}
                  <button
                    type="button"
                    className="btn-secondary h-7 px-2.5 text-xs"
                    onClick={() => setIndentOpen(true)}
                  >
                    <ClipboardList size={14} /> Select from indent
                  </button>
                  <label htmlFor="po-type" className="text-muted-foreground text-xs">
                    Order type
                  </label>
                  <select
                    id="po-type"
                    className="form-input h-7 w-auto px-2 py-0 text-xs"
                    value={poType}
                    onChange={(e) => setPoType(e.target.value as PoType)}
                  >
                    <option value="ITEM_LEVEL">With discount at item level</option>
                    <option value="ORDER_LEVEL">With discount at order level</option>
                    <option value="NONE">Without discount</option>
                  </select>
                </>
              }
            >
              {/* Lost when this section was rebuilt as one table, which left the
                discount mode stuck on whatever the order opened with and no
                way to change it. It sits in the title bar above: it decides
                which discount cells are live, so it is read before any figure
                is typed into them, and in a row of its own it was a third size
                of text on a line nobody needed. This sentence stays down here,
                over the cells it is about. */}
              <p className="text-muted-foreground mb-2 text-xs">
                {poType === 'ITEM_LEVEL'
                  ? 'A discount per line, in the Discount column — percent or rupees.'
                  : poType === 'ORDER_LEVEL'
                    ? 'One discount off the whole order, entered as Total discount on the right. The per-line Discount cells are switched off.'
                    : 'No discount on this order. Both the per-line cells and the order-level box are switched off.'}
              </p>

              <div className="border-border bg-card hidden overflow-x-auto rounded-lg border sm:block">
                <table className="w-full min-w-[1180px] table-fixed border-collapse text-sm">
                  <thead>
                    <tr className="bg-secondary">
                      {[
                        ['#', `${COL.num} sticky left-0 z-20 bg-secondary`, 'left'],
                        ['', `${COL.remove} sticky left-8 z-20 bg-secondary`, 'left'],
                        ['Category', COL.category, 'left'],
                        ['Item', `${COL.item} border-border border-r`, 'left'],
                        ['Style no.', COL.style, 'left'],
                        ['Description', COL.description, 'left'],
                        ['Qty', COL.qty, 'right'],
                        ['Rate', COL.rate, 'right'],
                        ['Discount', COL.discount, 'right'],
                        ['Tax %', COL.tax, 'right'],
                        ['Amount', COL.amount, 'right'],
                      ].map(([label, width, align], i) => (
                        <th
                          key={`${label}-${i}`}
                          className={`${width} border-border text-muted-foreground border-b px-2 py-1.5 align-bottom text-[10px] font-semibold uppercase tracking-wider ${
                            align === 'right' ? 'text-right' : 'text-left'
                          }`}
                        >
                          {label}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {lines.map((line, i) => {
                      const item = itemById.get(line.itemId)

                      /*
                       * Where this row's item is actually filed, used when the
                       * row has not narrowed anything itself.
                       *
                       * Worked out here rather than stored on the line, because
                       * the category list arrives from the server after the form
                       * has already been filled from the record — an order
                       * opened for editing in that first moment would have shown
                       * "All / None" beside an item that is plainly under Fabric.
                       * Derived, it is right whenever the list arrives.
                       */
                      const filed = categories.find((c) => c.id === item?.categoryId)
                      const view = {
                        ...line,
                        categoryId: line.categoryId || filed?.parentId || filed?.id || '',
                        subcategoryId: line.subcategoryId || (filed?.parentId ? filed.id : ''),
                      }

                      const subs = subCategoriesOf(view.categoryId)
                      const choices = itemsFor(view)
                      const money = priceOf(line)
                      // Outlined only once the row has an item — a blank row is
                      // not unfinished, it is just empty.
                      const needsQty = Boolean(line.itemId) && num(line.qty) <= 0
                      const needsRate = Boolean(line.itemId) && String(line.unitRate).trim() === ''
                      const cell = 'form-input h-8 px-2 text-xs'
                      // Newest first from the server, so the first row is the
                      // last time this item was bought.
                      const lastRate = line.itemId ? rateHistory[line.itemId]?.[0] : undefined

                      return (
                        <tr
                          key={i}
                          className={`${
                            i % 2 === 1 ? 'zebra-row' : 'bg-card'
                          } border-border/50 border-b last:border-0 [&>td]:px-2 [&>td]:py-1.5 [&>td]:align-top`}
                        >
                          {/* Which row this is, and the one control that acts on
                            the whole of it. Both pinned at the left edge with
                            the item, so on a scrolled table you can still tell
                            row four from row five and still delete it. */}
                          <td className={`${COL.num} sticky left-0 z-10 bg-inherit`}>
                            <div className="text-muted-foreground flex h-8 items-center justify-center text-xs tabular-nums">
                              {i + 1}
                            </div>
                          </td>

                          <td className={`${COL.remove} sticky left-8 z-10 bg-inherit`}>
                            <div className="flex h-8 items-center">
                              <button
                                type="button"
                                onClick={() => removeRow(i)}
                                className="btn-ghost text-muted-foreground p-1 hover:text-red-400"
                                aria-label={`Remove row ${i + 1}`}
                              >
                                <Trash2 size={13} />
                              </button>
                            </div>
                          </td>

                          {/* First, because it is the first thing decided.
                            It was the fourth column, after the item it exists
                            to narrow, which read as a label on a choice already
                            made rather than the filter it is — a buyer scrolled
                            the whole master looking for a button because the
                            box that would have cut it to eleven rows was past
                            the thing they were hunting through. */}
                          <td className={COL.category}>
                            <div className="space-y-1">
                              <select
                                className={cell}
                                value={view.categoryId}
                                onChange={(e) =>
                                  // Clearing the subcategory with it: the one
                                  // chosen a moment ago belongs to the category
                                  // just replaced.
                                  setLine(i, { categoryId: e.target.value, subcategoryId: '' })
                                }
                                aria-label={`Row ${i + 1} category`}
                              >
                                <option value="">All categories</option>
                                {topCategories.map((c) => (
                                  <option key={c.id} value={c.id}>
                                    {c.name}
                                  </option>
                                ))}
                              </select>
                              {/* Always here, greyed where the category has no
                                subcategories rather than vanishing. Hiding it
                                made the row change shape as the category was
                                picked, and left the buyer wondering where the
                                box had gone — which is worse than a box that
                                is plainly not needed yet. */}
                              <select
                                className={cell}
                                value={view.subcategoryId}
                                disabled={subs.length === 0}
                                onChange={(e) => setLine(i, { subcategoryId: e.target.value })}
                                aria-label={`Row ${i + 1} subcategory`}
                              >
                                {/* Short, because this box is half the width of
                                  the words. It sits directly under the category
                                  it belongs to, so "All" is not ambiguous. */}
                                <option value="">{subs.length === 0 ? 'None' : 'All'}</option>
                                {subs.map((c) => (
                                  <option key={c.id} value={c.id}>
                                    {c.name}
                                  </option>
                                ))}
                              </select>
                            </div>
                          </td>

                          <td className={`${COL.item} border-border border-r`}>
                            {/* The code and the name are one cell, as they are
                              on the mill's old form.

                              They were two columns of 128px each, which is
                              enough for neither: an item code was cut off at
                              "PKG-TAPE-(" and the name at "Choose an it". They
                              name the same thing, so one wide cell shows both
                              whole and gives the table back a column. */}
                            <div className="space-y-1">
                              {/* A real combobox, using the browser's own: type
                                a code and the list narrows, or open it and pick
                                one. `datalist` rather than a hand-built dropdown
                                because it needs no package, it keeps the cell a
                                plain text box for anyone who already knows the
                                code by heart, and it cannot be scrolled out of
                                the table the way an absolutely positioned menu
                                inside a sideways-scrolling grid can.

                                One list per row, because each row narrows its
                                items by its own category. */}
                              <input
                                className={`${cell} font-mono`}
                                list={`po-codes-${i}`}
                                placeholder="Item code"
                                value={line.codeText ?? ''}
                                onChange={(e) => typeCodeFor(i, e.target.value)}
                                aria-label={`Row ${i + 1} item code`}
                              />
                              <datalist id={`po-codes-${i}`}>
                                {choices.map((it) => (
                                  <option key={it.id} value={it.code ?? ''} label={it.name} />
                                ))}
                              </datalist>
                              <select
                                className={cell}
                                value={line.itemId}
                                onChange={(e) => pickItemFor(i, e.target.value)}
                                aria-label={`Row ${i + 1} item`}
                              >
                                <option value="">
                                  {choices.length === 0 ? 'Nothing matches' : 'Choose an item...'}
                                </option>
                                <option value={ADD_NEW}>+ Add a new item…</option>
                                {choices.map((it) => (
                                  <option key={it.id} value={it.id}>
                                    {it.name}
                                  </option>
                                ))}
                              </select>
                            </div>
                            {/* What the row is, under what it is called: the
                              HSN the tax hangs off, and the indent it answers
                              where it came off one. Both belong beside the
                              name rather than in columns of their own — they
                              are read, never typed, and neither is worth 100px
                              of a row that already has eleven cells. */}
                            {(item?.hsnCode || line.mrNumber) && (
                              <p className="mt-0.5 flex flex-wrap items-center gap-x-2 font-mono text-[10px] leading-tight">
                                {item?.hsnCode && (
                                  <span className="text-muted-foreground">HSN {item.hsnCode}</span>
                                )}
                                {line.mrNumber && (
                                  <span
                                    className="text-primary"
                                    title={`Raised against ${line.mrNumber}`}
                                  >
                                    {line.mrNumber}
                                  </span>
                                )}
                              </p>
                            )}
                          </td>

                          <td className={COL.style}>
                            {/* A plain box. Material is often bought before the
                              style has been set up, so nothing this cell could
                              offer would hold what the buyer needs to write,
                              and a list dropping over the row while they typed
                              was in the way more often than it helped.

                              What is typed is still matched against the style
                              master behind the box: an exact code links the
                              line to that style so it reconciles against
                              production, and anything else is simply kept as
                              written. Nothing is lost by not showing the list.
                              */}
                            <input
                              className={cell}
                              placeholder="Style"
                              value={(line.styleNo as string) ?? ''}
                              onChange={(e) => typeStyleFor(i, e.target.value)}
                              aria-label={`Row ${i + 1} style number`}
                            />
                            {/* Shown only when the text matched nothing, so the
                              buyer knows this order will not tie back to a
                              style — not an error, just a fact about it. */}
                            {line.styleNo && !line.styleId && (
                              <p className="text-muted-foreground mt-0.5 text-[10px]">
                                Not in master
                              </p>
                            )}
                          </td>

                          <td className={COL.description}>
                            <input
                              className={cell}
                              placeholder="Optional"
                              value={(line.description as string) ?? ''}
                              onChange={(e) => setLine(i, { description: e.target.value })}
                              aria-label={`Row ${i + 1} description`}
                            />
                          </td>

                          <td className={COL.qty}>
                            {/* The wheel and the arrow keys move this by whole units.
                             Not 0.001, which moved it by a thousandth of a piece; and not 1,
                             which would refuse 1500.5 metres of fabric outright. "any" steps
                             by one while still accepting a decimal that is typed. */}
                            <input
                              type="number"
                              step="any"
                              min={0}
                              className={`${cell} text-right ${needsQty ? 'border-amber-500/70' : ''}`}
                              placeholder="0"
                              value={String(line.qty)}
                              onChange={(e) => setLine(i, { qty: e.target.value })}
                              aria-label={`Row ${i + 1} quantity`}
                            />
                            {item?.uom?.symbol && (
                              <p className="text-muted-foreground mt-0.5 text-right text-[10px]">
                                {item.uom.symbol}
                              </p>
                            )}
                          </td>

                          <td className={COL.rate}>
                            <input
                              type="number"
                              step="any"
                              min={0}
                              className={`${cell} text-right ${needsRate ? 'border-amber-500/70' : ''}`}
                              placeholder="0.00"
                              value={String(line.unitRate)}
                              onChange={(e) => setLine(i, { unitRate: e.target.value })}
                              aria-label={`Row ${i + 1} rate`}
                            />
                            {/* The last rate this item was bought at, shown but
                              never typed into the box. That is the whole point
                              of it: the buyer sees what it went for last time
                              and decides, rather than sending an order at a
                              price nobody looked at.

                              Only when there is a history. A first-time
                              purchase has nothing to say here, and "Last —"
                              would just be a row of noise. */}
                            {lastRate && (
                              <div className="mt-0.5 text-right">
                                <p className="text-muted-foreground whitespace-nowrap text-[10px]">
                                  Last {inr(num(lastRate.unitRate))}
                                </p>
                                <button
                                  type="button"
                                  onClick={() => setHistoryFor(line.itemId)}
                                  className="text-primary whitespace-nowrap text-[10px] hover:underline"
                                >
                                  View history
                                </button>
                              </div>
                            )}
                          </td>

                          <td className={COL.discount}>
                            {/* Percent or rupees, as the mill's old form
                              allowed. Both sit in the cell, so which one this
                              figure is can never be in doubt. */}
                            <div className="flex items-stretch gap-1">
                              <input
                                type="number"
                                step="any"
                                min={0}
                                max={(line.discountUnit ?? '%') === '%' ? 100 : undefined}
                                className={`${cell} min-w-0 flex-1 text-right`}
                                placeholder="0"
                                disabled={poType !== 'ITEM_LEVEL'}
                                value={poType === 'ITEM_LEVEL' ? String(line.discount) : ''}
                                onChange={(e) => setLine(i, { discount: e.target.value })}
                                aria-label={`Row ${i + 1} discount`}
                              />
                              <select
                                className={`${cell} w-14 shrink-0 px-1`}
                                disabled={poType !== 'ITEM_LEVEL'}
                                value={line.discountUnit ?? '%'}
                                onChange={(e) =>
                                  setLine(i, { discountUnit: e.target.value as '%' | 'INR' })
                                }
                                aria-label={`Row ${i + 1} discount in percent or rupees`}
                              >
                                <option value="%">%</option>
                                <option value="INR">₹</option>
                              </select>
                            </div>
                          </td>

                          <td className={COL.tax}>
                            <input
                              type="number"
                              step="any"
                              min={0}
                              max={100}
                              className={`${cell} text-right`}
                              placeholder="0"
                              disabled={taxMode === 'NONE'}
                              value={taxMode === 'NONE' ? '' : String(line.gstRate)}
                              onChange={(e) => setLine(i, { gstRate: e.target.value })}
                              aria-label={`Row ${i + 1} tax percent`}
                            />
                            {/* The old form's "Is tax exempt". It is the same
                              thing as a rate of nothing, so it sets the box
                              above rather than being a second field that can
                              disagree with it.

                              Shown once the row has an item, like the unit
                              under Qty and the HSN under Item. Rendered on
                              every row it put a second line under all of them,
                              including the blank one every new order opens
                              with — a whole form of rows made taller for a tick
                              that cannot mean anything until there is
                              something on the line to exempt. */}
                            {line.itemId && (
                              <label className="text-muted-foreground mt-0.5 flex cursor-pointer items-center justify-end gap-1 text-[10px]">
                                <input
                                  type="checkbox"
                                  className="scale-75"
                                  disabled={taxMode === 'NONE'}
                                  checked={num(line.gstRate) === 0}
                                  onChange={(e) =>
                                    setLine(i, {
                                      gstRate: e.target.checked
                                        ? '0'
                                        : item?.taxRate
                                          ? String(item.taxRate.rate)
                                          : '',
                                    })
                                  }
                                />
                                Exempt
                              </label>
                            )}
                          </td>

                          {/* The amount, and under it what one unit works out
                            at once the discount is off. They were two columns;
                            the net price is a reading of the same money and
                            belongs with it, not a column away from it. */}
                          <td className={COL.amount}>
                            <div className="flex h-8 items-center justify-end whitespace-nowrap font-medium tabular-nums">
                              {inr(totals.lineAmounts[i] ?? 0)}
                            </div>
                            {money.netPrice > 0 && (
                              <p className="text-muted-foreground text-right text-[10px] tabular-nums leading-tight">
                                {inr(money.netPrice)} each
                              </p>
                            )}
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>

              {/* Same rows, one card each, for a screen too narrow for
                thirteen columns. The sideways-scrolling table above stays
                for a desk; here every field for a line sits under the last
                so nothing is typed sight-unseen off the right edge. */}
              <div className="space-y-3 sm:hidden">
                {lines.map((line, i) => {
                  const item = itemById.get(line.itemId)
                  const filed = categories.find((c) => c.id === item?.categoryId)
                  const view = {
                    ...line,
                    categoryId: line.categoryId || filed?.parentId || filed?.id || '',
                    subcategoryId: line.subcategoryId || (filed?.parentId ? filed.id : ''),
                  }
                  const subs = subCategoriesOf(view.categoryId)
                  const choices = itemsFor(view)
                  const money = priceOf(line)
                  const needsQty = Boolean(line.itemId) && num(line.qty) <= 0
                  const needsRate = Boolean(line.itemId) && String(line.unitRate).trim() === ''
                  const cell = 'form-input h-9 px-2 text-xs w-full'
                  const lastRate = line.itemId ? rateHistory[line.itemId]?.[0] : undefined
                  const fieldLabel =
                    'text-muted-foreground text-[10px] font-semibold uppercase tracking-wider'

                  return (
                    <div key={i} className="border-border bg-card rounded-lg border p-3">
                      <div className="mb-2 flex items-center justify-between">
                        <span className="text-muted-foreground text-xs font-semibold tabular-nums">
                          Row {i + 1}
                        </span>
                        <button
                          type="button"
                          onClick={() => removeRow(i)}
                          className="btn-ghost text-muted-foreground p-1 hover:text-red-400"
                          aria-label={`Remove row ${i + 1}`}
                        >
                          <Trash2 size={14} />
                        </button>
                      </div>

                      <div className="grid grid-cols-2 gap-2">
                        <div className="space-y-1">
                          <label className={fieldLabel}>Category</label>
                          <select
                            className={cell}
                            value={view.categoryId}
                            onChange={(e) =>
                              setLine(i, { categoryId: e.target.value, subcategoryId: '' })
                            }
                            aria-label={`Row ${i + 1} category`}
                          >
                            <option value="">All categories</option>
                            {topCategories.map((c) => (
                              <option key={c.id} value={c.id}>
                                {c.name}
                              </option>
                            ))}
                          </select>
                        </div>
                        <div className="space-y-1">
                          <label className={fieldLabel}>Sub-category</label>
                          <select
                            className={cell}
                            value={view.subcategoryId}
                            disabled={subs.length === 0}
                            onChange={(e) => setLine(i, { subcategoryId: e.target.value })}
                            aria-label={`Row ${i + 1} subcategory`}
                          >
                            <option value="">{subs.length === 0 ? 'None' : 'All'}</option>
                            {subs.map((c) => (
                              <option key={c.id} value={c.id}>
                                {c.name}
                              </option>
                            ))}
                          </select>
                        </div>
                      </div>

                      <div className="mt-2 space-y-1">
                        <label className={fieldLabel}>Item</label>
                        {/* Code and name side by side rather than stacked — the
                          code is short enough that giving it a full row of its
                          own on a phone was one more screen of scrolling per
                          line for nothing the width needed. */}
                        <div className="flex gap-1.5">
                          {/* `cell` carries `w-full`, which would fight a
                            flex-basis override here — spelled out without it
                            so the fixed code column and the flexible name
                            column actually hold the widths they are given. */}
                          <input
                            className="form-input h-9 w-24 shrink-0 px-2 font-mono text-xs"
                            list={`po-codes-m-${i}`}
                            placeholder="Code"
                            value={line.codeText ?? ''}
                            onChange={(e) => typeCodeFor(i, e.target.value)}
                            aria-label={`Row ${i + 1} item code`}
                          />
                          <datalist id={`po-codes-m-${i}`}>
                            {choices.map((it) => (
                              <option key={it.id} value={it.code ?? ''} label={it.name} />
                            ))}
                          </datalist>
                          <select
                            className="form-input h-9 min-w-0 flex-1 px-2 text-xs"
                            value={line.itemId}
                            onChange={(e) => pickItemFor(i, e.target.value)}
                            aria-label={`Row ${i + 1} item`}
                          >
                            <option value="">
                              {choices.length === 0 ? 'Nothing matches' : 'Choose an item...'}
                            </option>
                            <option value={ADD_NEW}>+ Add a new item…</option>
                            {choices.map((it) => (
                              <option key={it.id} value={it.id}>
                                {it.name}
                              </option>
                            ))}
                          </select>
                        </div>
                        {(item?.hsnCode || line.mrNumber) && (
                          <p className="flex flex-wrap items-center gap-x-2 font-mono text-[10px] leading-tight">
                            {item?.hsnCode && (
                              <span className="text-muted-foreground">HSN {item.hsnCode}</span>
                            )}
                            {line.mrNumber && (
                              <span
                                className="text-primary"
                                title={`Raised against ${line.mrNumber}`}
                              >
                                {line.mrNumber}
                              </span>
                            )}
                          </p>
                        )}
                      </div>

                      <div className="mt-2 grid grid-cols-2 gap-2">
                        <div className="space-y-1">
                          <label className={fieldLabel}>Style no.</label>
                          <input
                            className={cell}
                            placeholder="Style"
                            value={(line.styleNo as string) ?? ''}
                            onChange={(e) => typeStyleFor(i, e.target.value)}
                            aria-label={`Row ${i + 1} style number`}
                          />
                          {line.styleNo && !line.styleId && (
                            <p className="text-muted-foreground text-[10px]">Not in master</p>
                          )}
                        </div>
                        <div className="space-y-1">
                          <label className={fieldLabel}>Description</label>
                          <input
                            className={cell}
                            placeholder="Optional"
                            value={(line.description as string) ?? ''}
                            onChange={(e) => setLine(i, { description: e.target.value })}
                            aria-label={`Row ${i + 1} description`}
                          />
                        </div>
                      </div>

                      <div className="mt-2 grid grid-cols-2 gap-2">
                        <div className="space-y-1">
                          <label className={fieldLabel}>Qty</label>
                          <input
                            type="number"
                            step="any"
                            min={0}
                            className={`${cell} ${needsQty ? 'border-amber-500/70' : ''}`}
                            placeholder="0"
                            value={String(line.qty)}
                            onChange={(e) => setLine(i, { qty: e.target.value })}
                            aria-label={`Row ${i + 1} quantity`}
                          />
                          {item?.uom?.symbol && (
                            <p className="text-muted-foreground text-[10px]">{item.uom.symbol}</p>
                          )}
                        </div>
                        <div className="space-y-1">
                          <label className={fieldLabel}>Rate</label>
                          <input
                            type="number"
                            step="any"
                            min={0}
                            className={`${cell} ${needsRate ? 'border-amber-500/70' : ''}`}
                            placeholder="0.00"
                            value={String(line.unitRate)}
                            onChange={(e) => setLine(i, { unitRate: e.target.value })}
                            aria-label={`Row ${i + 1} rate`}
                          />
                          {lastRate && (
                            <div>
                              <p className="text-muted-foreground whitespace-nowrap text-[10px]">
                                Last {inr(num(lastRate.unitRate))}
                              </p>
                              <button
                                type="button"
                                onClick={() => setHistoryFor(line.itemId)}
                                className="text-primary whitespace-nowrap text-[10px] hover:underline"
                              >
                                View history
                              </button>
                            </div>
                          )}
                        </div>
                      </div>

                      <div className="mt-2 grid grid-cols-2 gap-2">
                        <div className="space-y-1">
                          <label className={fieldLabel}>Discount</label>
                          {/* `cell` carries `w-full`, which fights a
                            fixed-width override the same way it did on the
                            item code cell — spelled out without it so the
                            unit select actually holds `w-14` instead of
                            stretching to match the number box and pushing
                            the row past the card's right edge. */}
                          <div className="flex items-stretch gap-1">
                            <input
                              type="number"
                              step="any"
                              min={0}
                              max={(line.discountUnit ?? '%') === '%' ? 100 : undefined}
                              className="form-input h-9 min-w-0 flex-1 px-2 text-xs"
                              placeholder="0"
                              disabled={poType !== 'ITEM_LEVEL'}
                              value={poType === 'ITEM_LEVEL' ? String(line.discount) : ''}
                              onChange={(e) => setLine(i, { discount: e.target.value })}
                              aria-label={`Row ${i + 1} discount`}
                            />
                            <select
                              className="form-input h-9 w-14 shrink-0 px-1 text-xs"
                              disabled={poType !== 'ITEM_LEVEL'}
                              value={line.discountUnit ?? '%'}
                              onChange={(e) =>
                                setLine(i, { discountUnit: e.target.value as '%' | 'INR' })
                              }
                              aria-label={`Row ${i + 1} discount in percent or rupees`}
                            >
                              <option value="%">%</option>
                              <option value="INR">₹</option>
                            </select>
                          </div>
                        </div>
                        <div className="space-y-1">
                          <label className={fieldLabel}>Tax %</label>
                          <input
                            type="number"
                            step="any"
                            min={0}
                            max={100}
                            className={cell}
                            placeholder="0"
                            disabled={taxMode === 'NONE'}
                            value={taxMode === 'NONE' ? '' : String(line.gstRate)}
                            onChange={(e) => setLine(i, { gstRate: e.target.value })}
                            aria-label={`Row ${i + 1} tax percent`}
                          />
                          {line.itemId && (
                            <label className="text-muted-foreground flex cursor-pointer items-center gap-1 text-[10px]">
                              <input
                                type="checkbox"
                                className="scale-75"
                                disabled={taxMode === 'NONE'}
                                checked={num(line.gstRate) === 0}
                                onChange={(e) =>
                                  setLine(i, {
                                    gstRate: e.target.checked
                                      ? '0'
                                      : item?.taxRate
                                        ? String(item.taxRate.rate)
                                        : '',
                                  })
                                }
                              />
                              Exempt
                            </label>
                          )}
                        </div>
                      </div>

                      <div className="border-border/70 mt-2.5 flex items-center justify-between border-t pt-2">
                        <span className={fieldLabel}>Amount</span>
                        <div className="text-right">
                          <div className="font-medium tabular-nums">
                            {inr(totals.lineAmounts[i] ?? 0)}
                          </div>
                          {money.netPrice > 0 && (
                            <p className="text-muted-foreground text-[10px] tabular-nums leading-tight">
                              {inr(money.netPrice)} each
                            </p>
                          )}
                        </div>
                      </div>
                    </div>
                  )
                })}
              </div>

              <div className="mt-2 flex flex-wrap items-center justify-between gap-3">
                <button
                  type="button"
                  onClick={addRow}
                  className="text-primary border-primary/40 hover:bg-primary/10 focus:ring-ring inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-semibold transition-colors duration-200 focus:outline-none focus:ring-2"
                >
                  <Plus size={14} /> Add item row
                </button>
                {/* True as of 19 Sep 2026. It used to say indents were not
                  built, which stopped being true the day the button above it
                  appeared — and a form that tells the buyer a feature is
                  missing while offering it is a form nobody trusts the rest
                  of. */}
                <p className="text-muted-foreground text-xs">
                  Type a row, or take what production has already asked for with{' '}
                  <span className="text-foreground font-medium">Select from indent</span>.
                </p>
              </div>
            </Section>

            {/* 4 — Where it goes, what is attached, and what it comes to.

              One row, two boxes: the delivery and its files on the left, the
              calculation on the right — the arrangement the form has always
              had, and the one the clerk checks left to right before saving. */}
            <div className="grid grid-cols-1 items-start gap-3 lg:grid-cols-[minmax(0,1fr)_460px]">
              {/* The left column is stacked rather than left half-empty.

                The calculation beside it runs to a dozen rows once the charge
                master has anything in it, while the delivery box is four
                lines. Side by side on their own that left roughly 350px of
                nothing under the delivery box, the terms pushed below the
                whole row, and the form scrolling for no reason. The terms and
                the note move up into that space instead. */}
              <div className="min-w-0 space-y-3">
                <Section icon={Truck} title="Attachments &amp; Deliver To">
                  <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
                    <div className="space-y-2">
                      <h4 className="text-foreground text-xs font-semibold">Attachments</h4>

                      {/* One box whether or not the order exists yet. On a new
                        order the files are held and go up the moment it is saved,
                        so nobody has to save, reopen and come back for them. */}
                      <div className="space-y-2">
                        <label
                          onDragOver={(e) => {
                            e.preventDefault()
                            if (!uploading && fileCount < MAX_FILES) setDragOver(true)
                          }}
                          onDragLeave={() => setDragOver(false)}
                          onDrop={(e) => {
                            e.preventDefault()
                            setDragOver(false)
                            if (!uploading && fileCount < MAX_FILES)
                              chooseFiles(e.dataTransfer.files)
                          }}
                          className={`flex items-center justify-between gap-3 rounded-lg border border-dashed px-3 py-3 ${
                            uploading || fileCount >= MAX_FILES
                              ? 'border-border bg-secondary cursor-not-allowed opacity-70'
                              : dragOver
                                ? 'border-primary bg-primary/10 cursor-pointer'
                                : 'border-border bg-secondary cursor-pointer hover:border-teal-500/40'
                          }`}
                        >
                          <span className="flex min-w-0 items-center gap-2.5">
                            {uploading ? (
                              <Loader2
                                size={18}
                                className="text-muted-foreground shrink-0 animate-spin"
                              />
                            ) : (
                              <UploadCloud size={18} className="text-muted-foreground shrink-0" />
                            )}
                            <span className="min-w-0">
                              <span className="text-foreground block truncate text-sm">
                                {uploading ? 'Sending...' : 'Choose files'}
                              </span>
                              <span className="text-muted-foreground block text-xs">
                                or drag and drop
                              </span>
                            </span>
                          </span>
                          <span className="text-muted-foreground shrink-0 text-xs">
                            {fileCount}/{MAX_FILES} · {MAX_FILE_MB}MB each
                          </span>
                          <input
                            type="file"
                            multiple
                            className="hidden"
                            disabled={uploading || fileCount >= MAX_FILES}
                            onChange={(e) => {
                              chooseFiles(e.target.files)
                              e.target.value = ''
                            }}
                          />
                        </label>

                        {fileCount === 0 ? (
                          <p className="text-muted-foreground text-xs">Nothing attached yet.</p>
                        ) : (
                          <ul className="space-y-1">
                            {attachments.map((f) => (
                              <li
                                key={f.id}
                                className="border-border bg-secondary flex items-center gap-2 rounded-lg border px-3 py-1.5"
                              >
                                <Paperclip size={13} className="text-muted-foreground shrink-0" />
                                <button
                                  type="button"
                                  className="text-primary min-w-0 flex-1 truncate text-left text-sm underline"
                                  onClick={() => void openFile(f.id)}
                                  title={`Open ${f.fileName}`}
                                >
                                  {f.fileName}
                                </button>
                                <span className="text-muted-foreground whitespace-nowrap text-[10px]">
                                  {(f.sizeBytes / 1024).toFixed(0)} KB
                                </span>
                                <button
                                  type="button"
                                  className="btn-ghost text-muted-foreground p-1 hover:text-red-400"
                                  onClick={() => void removeFile(f)}
                                  aria-label={`Remove ${f.fileName}`}
                                >
                                  <Trash2 size={13} />
                                </button>
                              </li>
                            ))}

                            {/* His PI scan, copied onto the order when it is saved.
                              Removable here, so it can be left off if wanted. */}
                            {carriedFiles.map((f) => (
                              <li
                                key={`carried-${f.id}`}
                                className="border-border bg-secondary flex items-center gap-2 rounded-lg border border-dashed px-3 py-1.5"
                              >
                                <Paperclip size={13} className="text-muted-foreground shrink-0" />
                                <span className="text-foreground min-w-0 flex-1 truncate text-sm">
                                  {f.fileName}
                                </span>
                                <span className="text-muted-foreground whitespace-nowrap text-[10px]">
                                  {(f.sizeBytes / 1024).toFixed(0)} KB · from his PI · on save
                                </span>
                                <button
                                  type="button"
                                  className="btn-ghost text-muted-foreground p-1 hover:text-red-400"
                                  onClick={() =>
                                    setCarriedFiles((prev) => prev.filter((x) => x.id !== f.id))
                                  }
                                  aria-label={`Leave ${f.fileName} off this order`}
                                >
                                  <Trash2 size={13} />
                                </button>
                              </li>
                            ))}

                            {/* Chosen but not yet sent. Marked so nobody believes a
                              file is safely filed before the order is saved. */}
                            {pendingFiles.map((f, i) => (
                              <li
                                key={`pending-${f.name}-${i}`}
                                className="border-border bg-secondary flex items-center gap-2 rounded-lg border border-dashed px-3 py-1.5"
                              >
                                <Paperclip size={13} className="text-muted-foreground shrink-0" />
                                <span className="text-foreground min-w-0 flex-1 truncate text-sm">
                                  {f.name}
                                </span>
                                <span className="text-muted-foreground whitespace-nowrap text-[10px]">
                                  {(f.size / 1024).toFixed(0)} KB · on save
                                </span>
                                <button
                                  type="button"
                                  className="btn-ghost text-muted-foreground p-1 hover:text-red-400"
                                  onClick={() =>
                                    setPendingFiles((prev) => prev.filter((_, x) => x !== i))
                                  }
                                  aria-label={`Remove ${f.name}`}
                                >
                                  <Trash2 size={13} />
                                </button>
                              </li>
                            ))}
                          </ul>
                        )}
                      </div>
                    </div>

                    <div className="space-y-2">
                      <h4 className="text-foreground text-xs font-semibold">Deliver to</h4>
                      <div className="flex flex-wrap items-center gap-4">
                        <label className="text-foreground flex cursor-pointer items-center gap-2 text-sm">
                          <input
                            type="radio"
                            name="po-deliver-to"
                            checked={deliverTo === 'ORGANIZATION'}
                            onChange={() => setDeliverTo('ORGANIZATION')}
                          />
                          Organization
                        </label>
                        <label className="text-foreground flex cursor-pointer items-center gap-2 text-sm">
                          <input
                            type="radio"
                            name="po-deliver-to"
                            checked={deliverTo === 'CUSTOMER'}
                            onChange={() => setDeliverTo('CUSTOMER')}
                          />
                          Customer
                        </label>
                      </div>

                      {deliverTo === 'CUSTOMER' ? (
                        <>
                          <select
                            className="form-input"
                            value={deliveryCustomerId}
                            onChange={(e) => setDeliveryCustomerId(e.target.value)}
                            aria-label="Deliver to customer"
                          >
                            <option value="">Choose customer</option>
                            {customers.map((c) => (
                              <option key={c.id} value={c.id}>
                                {c.code ? `${c.code} — ${c.name}` : c.name}
                              </option>
                            ))}
                          </select>

                          {deliveryCustomer && (
                            <div className="border-border bg-secondary rounded-lg border px-3 py-2">
                              <p className="text-foreground text-sm font-medium">
                                {deliveryCustomer.name}
                              </p>
                              <p className="text-muted-foreground text-xs">
                                {customerAddress || 'No address on this customer.'}
                              </p>
                              {/* The tax follows the goods, so a customer in another
                                state changes what the supplier may charge. Said
                                here rather than discovered on their bill. */}
                              {customerStateCode && (
                                <p className="text-muted-foreground mt-1 text-xs">
                                  Delivered in state {customerStateCode} —{' '}
                                  {supplier
                                    ? taxMode === 'CGST_SGST'
                                      ? 'same state as the supplier, so CGST + SGST'
                                      : 'a different state from the supplier, so IGST'
                                    : 'choose a supplier to see the tax split'}
                                </p>
                              )}
                            </div>
                          )}
                        </>
                      ) : (
                        /* Shown, not repeated. An order has one destination, so a
                         second dropdown for it here would only mirror the Location
                         field above — change one and the other moves, which reads
                         as two settings that disagree. */
                        <div className="border-border bg-secondary rounded-lg border px-3 py-2">
                          <p className="text-foreground text-sm font-medium">
                            {destination?.name ?? company?.name ?? 'Your company'}
                          </p>
                          <p className="text-muted-foreground text-xs">
                            {destination?.address ||
                              orgAddress ||
                              'Address not set — add it in Settings → Company.'}
                          </p>
                          <button
                            type="button"
                            className="text-primary mt-1.5 flex items-center gap-1.5 text-xs hover:underline"
                            onClick={() => document.getElementById('po-location')?.focus()}
                            title="Delivering somewhere else? Change the Location field above."
                          >
                            <MapPin size={12} className="shrink-0" />
                            Location
                          </button>
                        </div>
                      )}
                    </div>
                  </div>
                </Section>

                {/* 5 — What the order says. Two boxes side by side, as the mockup
                has them: the terms the supplier is held to, and the note printed
                under them. A counter on each, because both are capped by the
                server and finding that out on save costs you the typing. */}
                <div className="grid grid-cols-1 items-start gap-3 lg:grid-cols-2">
                  <Section
                    icon={ScrollText}
                    title="Terms &amp; Conditions"
                    foldable
                    openByDefault={false}
                    summary={
                      terms.trim()
                        ? `Printed on the order — ${terms.trim().length} characters`
                        : 'None — nothing will be printed'
                    }
                  >
                    <textarea
                      rows={3}
                      maxLength={TERMS_MAX}
                      className="form-input"
                      placeholder="Leave blank to use the terms set in Settings → Documents"
                      value={terms}
                      onChange={(e) => setTerms(e.target.value)}
                      aria-label="Terms and conditions"
                    />
                    <p className="text-muted-foreground mt-1 text-right text-[11px] tabular-nums">
                      {terms.length}/{TERMS_MAX}
                    </p>
                  </Section>

                  <Section
                    icon={FileText}
                    title="Notes"
                    foldable
                    openByDefault={false}
                    summary={notes.trim() || 'Nothing written'}
                  >
                    <textarea
                      rows={3}
                      maxLength={NOTES_MAX}
                      className="form-input"
                      placeholder="Printed on the order the supplier receives"
                      value={notes}
                      onChange={(e) => setNotes(e.target.value)}
                      aria-label="Notes"
                    />
                    <p className="text-muted-foreground mt-1 text-right text-[11px] tabular-nums">
                      {notes.length}/{NOTES_MAX}
                    </p>
                  </Section>
                </div>

                {/* How it goes out, tucked under the terms rather than given a row
                of its own across the bottom of the form.

                Neither control does anything yet, so a box each would be height
                spent on two switched-off things. And the calculation beside this
                column is taller than everything stacked against it, so this is
                space the form was already paying for either way. */}
                <Section
                  icon={Mail}
                  title="Template &amp; Email"
                  foldable
                  openByDefault={false}
                  summary="One template per document type; emailing is not built yet"
                >
                  <div className="space-y-2">
                    <div className="grid grid-cols-1 items-center gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,1.6fr)]">
                      {/* A real link, not a greyed box. The wording, the title and
                    which blocks print are all editable — under Settings →
                    Documents, per document type. Showing this as "not built"
                    was wrong: it is built, it just does not live here. */}
                      <div className="border-border bg-secondary flex items-center justify-between gap-2 rounded-lg border px-3 py-2">
                        <span className="text-foreground flex min-w-0 items-center gap-2 text-sm">
                          <FileText size={14} className="text-muted-foreground shrink-0" />
                          <span className="truncate">Template: Standard</span>
                        </span>
                        <a
                          href="/settings/documents"
                          target="_blank"
                          rel="noreferrer"
                          className="text-primary shrink-0 text-xs underline"
                        >
                          Edit
                        </a>
                      </div>

                      {/* The supplier, not us. This showed `company.email` — our
                      own accounts address — which is the wrong way round for a
                      purchase order: the order goes to the supplier, so they
                      are the recipient. The address comes off the supplier
                      master, which the form already has loaded for the billing
                      block above. */}
                      <Faded>
                        {/* Both addresses, because once emailing is built both
                          are wanted: the order goes to the supplier, and
                          accounts needs to know an order was raised.

                          The mill's old form showed only the second of these
                          and labelled it "Email To", which is what nobody
                          could explain — an address that looks like the
                          recipient but is your own office. Naming the two
                          separately is the whole fix.

                          Switched off until emailing exists, and then these
                          are the two lines it sends to. */}
                        <div className="min-w-0 space-y-1">
                          <div className="flex min-w-0 items-center gap-2">
                            <Mail size={14} className="text-muted-foreground shrink-0" />
                            <span className="text-muted-foreground w-14 shrink-0 text-xs">To</span>
                            <input
                              type="checkbox"
                              checked={Boolean(supplier?.email)}
                              readOnly
                              className="shrink-0"
                            />
                            {supplier?.email ? (
                              <span className="text-foreground truncate text-sm">
                                {supplier.email}
                              </span>
                            ) : (
                              <span className="text-muted-foreground truncate text-sm">
                                {supplier
                                  ? `No email on ${supplier.name}`
                                  : 'Choose a supplier to see where it would go'}
                              </span>
                            )}
                          </div>

                          <div className="flex min-w-0 items-center gap-2">
                            {/* Kept clear rather than given an icon of its own,
                              so the two addresses line up under one heading
                              instead of reading as two unrelated rows. */}
                            <span className="w-[14px] shrink-0" aria-hidden />
                            <span className="text-muted-foreground w-14 shrink-0 text-xs">
                              Copy to
                            </span>
                            <input
                              type="checkbox"
                              checked={Boolean(company?.email)}
                              readOnly
                              className="shrink-0"
                            />
                            {company?.email ? (
                              <span className="text-foreground truncate text-sm">
                                {company.email}
                              </span>
                            ) : (
                              <span className="text-muted-foreground truncate text-sm">
                                No company email in Settings
                              </span>
                            )}
                          </div>
                        </div>
                      </Faded>
                    </div>

                    <NotBuiltNote>
                      Emailing the order is not built yet — print it and send it yourself. There is
                      one template per document type, so there is nothing to choose here; Edit opens
                      the wording and the printed blocks in Settings.
                    </NotBuiltNote>
                  </div>
                </Section>
              </div>

              {/* The calculation, beside the delivery box as the old ERP had it.

                Every row it had, in its order: the discount, the gross, one
                row per charge the mill uses on purchases, the tax split, other
                charges, and what the order comes to. The charge rows are read
                from the charge master rather than written into this form, so
                adding one there adds a row here. */}
              <Section icon={Calculator} title="Totals">
                <div className="space-y-1.5 text-sm">
                  {/* Where the discount sits follows the dropdown at the top of
                    the items box. On an item-level order this is the sum of
                    the per-line discounts and cannot be typed into; on an
                    order-level order it is the one figure taken off the whole
                    order, and the per-line boxes are the ones switched off. */}
                  {poType === 'ORDER_LEVEL' ? (
                    <div className="flex items-center justify-between gap-3">
                      <label htmlFor="po-discount" className="text-muted-foreground">
                        Total discount
                      </label>
                      <input
                        id="po-discount"
                        type="number"
                        step="any"
                        min={0}
                        className="form-input h-8 w-28 text-right"
                        placeholder="0.00"
                        value={discountAmount}
                        onChange={(e) => setDiscountAmount(e.target.value)}
                      />
                    </div>
                  ) : (
                    <Row label="Total discount" value={totals.totalDiscount} />
                  )}

                  <Row label="Gross total" value={totals.grossTotal} />

                  {/* One row per charge the mill uses on purchases, taken from
                    the charge master rather than written into this form. Add a
                    charge there and a row appears here; change its GST rate
                    there and this follows. */}
                  {chargeTypes.length === 0 ? (
                    <p className="text-muted-foreground py-1 text-xs">
                      No purchase charges are set up yet — add them under{' '}
                      <a
                        href="/masters/charges"
                        target="_blank"
                        rel="noreferrer"
                        className="text-primary underline"
                      >
                        Masters → Charges
                      </a>
                      .
                    </p>
                  ) : (
                    <div className="space-y-1.5 pt-0.5">
                      {totals.chargeRows.map((c) => {
                        const helperOpen = pctOpen === c.chargeTypeId
                        return (
                          <div key={c.chargeTypeId}>
                            {/* `flex-wrap`, with the name given a floor it
                              will not shrink under — a name like "Dyeing
                              Charges (Processing)" broke mid-word onto a
                              second line while the button and the box sat
                              centred beside whichever half of it fit, which
                              read as broken rather than as a long name. Past
                              that floor the whole button-and-box group wraps
                              to its own line under the name instead, which
                              is the same shape every field on this form
                              already takes on a phone. */}
                            <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1">
                              <span className="text-muted-foreground min-w-[9rem] flex-1">
                                {c.name}
                              </span>
                              {/* The amount box stays where the other boxes are
                                and the helper button goes to its left, so the
                                right edge of every figure on this panel still
                                lines up down one column. */}
                              <div className="ml-auto flex shrink-0 items-center gap-1.5">
                                <button
                                  type="button"
                                  onClick={() => setPctOpen(helperOpen ? null : c.chargeTypeId)}
                                  className={`inline-flex h-8 w-8 items-center justify-center rounded-lg border transition-colors ${
                                    helperOpen
                                      ? 'border-primary/30 bg-primary/10 text-primary'
                                      : 'btn-ghost border-border'
                                  }`}
                                  title={`Work ${c.name} out as a percentage of the gross total`}
                                  aria-expanded={helperOpen}
                                  aria-label={`Work out ${c.name} as a percentage`}
                                >
                                  <Percent size={14} />
                                </button>
                                <input
                                  type="number"
                                  step="any"
                                  min={0}
                                  className="form-input h-8 w-28 text-right"
                                  placeholder="0.00"
                                  value={charges[c.chargeTypeId] ?? ''}
                                  onChange={(e) =>
                                    setCharges((prev) => ({
                                      ...prev,
                                      [c.chargeTypeId]: e.target.value,
                                    }))
                                  }
                                  aria-label={`${c.name} amount`}
                                />
                              </div>
                            </div>

                            {helperOpen && (
                              <PercentOfGross
                                name={c.name}
                                base={totals.grossTotal}
                                value={pctFor(c)}
                                onChange={(next) =>
                                  setPctOf((prev) => ({ ...prev, [c.chargeTypeId]: next }))
                                }
                                onUse={(amount) => {
                                  setCharges((prev) => ({
                                    ...prev,
                                    [c.chargeTypeId]: String(amount),
                                  }))
                                  setPctOpen(null)
                                }}
                              />
                            )}
                          </div>
                        )
                      })}
                    </div>
                  )}

                  {taxMode === 'CGST_SGST' && (
                    <>
                      <Row label="SGST" value={totals.tax / 2} />
                      <Row label="CGST" value={totals.tax / 2} />
                    </>
                  )}
                  {/* Not SGST + CGST when the goods cross a state line. The
                    split follows the place of supply, and showing two halves
                    of a tax the supplier cannot charge would misstate the
                    order, so this row says what it really is. */}
                  {taxMode === 'IGST' && <Row label="IGST" value={totals.tax} />}
                  {taxMode === 'NONE' && (
                    <p className="text-muted-foreground py-1 text-xs">
                      No GST — this supplier is not registered.
                    </p>
                  )}
                  {taxMode === null && (
                    <>
                      <Row label="SGST" value={0} />
                      <Row label="CGST" value={0} />
                    </>
                  )}

                  <Row label="Total tax" value={totals.tax} />

                  {/* Carries no GST of its own and is added after tax, which is
                    how the mill's old system had it. */}
                  <div>
                    <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1">
                      <label
                        htmlFor="po-other-charges"
                        className="text-muted-foreground min-w-[9rem] flex-1"
                      >
                        Other charges
                      </label>
                      <div className="ml-auto flex shrink-0 items-center gap-1.5">
                        {/* No rate of its own, so this helper opens empty. It
                          is here because the sum is the same one — a
                          percentage of the goods — and a helper on every box
                          but this one is the sort of gap that sends somebody
                          back to their phone. */}
                        <button
                          type="button"
                          onClick={() => setPctOpen(pctOpen === OTHER_PCT ? null : OTHER_PCT)}
                          className={`inline-flex h-8 w-8 items-center justify-center rounded-lg border transition-colors ${
                            pctOpen === OTHER_PCT
                              ? 'border-primary/30 bg-primary/10 text-primary'
                              : 'btn-ghost border-border'
                          }`}
                          title="Work other charges out as a percentage of the gross total"
                          aria-expanded={pctOpen === OTHER_PCT}
                          aria-label="Work out other charges as a percentage"
                        >
                          <Percent size={14} />
                        </button>
                        <input
                          id="po-other-charges"
                          type="number"
                          step="any"
                          min={0}
                          className="form-input h-8 w-28 text-right"
                          placeholder="0.00"
                          value={otherCharges}
                          onChange={(e) => setOtherCharges(e.target.value)}
                        />
                      </div>
                    </div>

                    {pctOpen === OTHER_PCT && (
                      <PercentOfGross
                        name="other charges"
                        base={totals.grossTotal}
                        value={pctOf[OTHER_PCT] ?? ''}
                        onChange={(next) => setPctOf((prev) => ({ ...prev, [OTHER_PCT]: next }))}
                        onUse={(amount) => {
                          setOtherCharges(String(amount))
                          setPctOpen(null)
                        }}
                      />
                    )}
                  </div>

                  {/* Shown whenever the total was rounded, and only then.
                    The grand total is taken to the nearest rupee, which is how
                    an Indian document is normally settled — but without this
                    row the figures above it add up to something else and
                    nothing on the screen says why. The printed sheet has
                    carried this line all along; the form had not. */}
                  {Math.abs(totals.roundOff) >= 0.005 && (
                    <Row label="Rounding" value={totals.roundOff} />
                  )}

                  <div className="border-primary/20 bg-primary/5 mt-2 flex items-center justify-between gap-3 rounded-lg border px-3 py-2.5">
                    <span className="text-foreground font-semibold">Grand total</span>
                    <span className="text-foreground whitespace-nowrap text-lg font-semibold tabular-nums">
                      ₹{inr(totals.total)}
                    </span>
                  </div>

                  {taxMode === null && (
                    <p className="text-muted-foreground pt-1 text-xs">
                      Choose a supplier to see whether the tax splits into SGST + CGST or is IGST.
                    </p>
                  )}
                </div>
              </Section>
            </div>
          </div>

          {/* Footer — stays put, so Save never has to be hunted for at the bottom of a long form */}
          <div className="border-border flex shrink-0 flex-wrap items-center justify-end gap-2 border-t px-3 py-2.5 sm:gap-3 sm:px-5 sm:py-3.5">
            {incomplete && (
              <p className="warn-text mr-auto flex max-w-xl basis-full items-start gap-1.5 text-xs sm:basis-auto">
                <AlertCircle size={13} className="mt-px shrink-0" />
                <span>
                  {!supplierId
                    ? 'Choose a supplier to save this order.'
                    : activeLines.length === 0
                      ? 'Add at least one item to save this order.'
                      : /* Named, with the empty cell outlined in the table, so a
                       long order does not have to be read twice to find it. */
                        `Still to fill in: ${unfinished
                          .slice(0, 3)
                          .map(
                            (r) =>
                              `${r.name} (${[r.noQty && 'quantity', r.noRate && 'rate']
                                .filter(Boolean)
                                .join(' and ')})`
                          )
                          .join(', ')}${
                          unfinished.length > 3 ? ` and ${unfinished.length - 3} more` : ''
                        }.`}
                </span>
              </p>
            )}
            {/* Not on a phone: the ✕ in the header closes the form, and the
              row is kept for the three ways to save. */}
            <button
              type="button"
              onClick={onClose}
              className="btn-secondary hidden sm:inline-flex"
              disabled={busy}
            >
              Cancel
            </button>
            {saveActions}
          </div>
        </div>
      </div>
      {/* Which of the supplier's places this order is billed to — and keeping
          that list right.

          A panel rather than a menu hanging off the Change link: the form
          scrolls and its sections clip, so a menu cut off by the edge of a box
          is worse than no menu. It also has room for the form, which a menu
          would not.

          Everything saved here is saved on the supplier. An address kept
          against one order would be typed again on the next one, and a
          correction made here would leave the master still wrong. */}
      {addressPickerOpen && supplier && (
        <div
          className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm"
          role="dialog"
          aria-modal="true"
          aria-labelledby="po-address-title"
          onClick={() => setAddressPickerOpen(false)}
        >
          <div
            className="glass-card flex max-h-[85vh] w-full max-w-lg flex-col overflow-hidden"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="border-border flex shrink-0 items-start justify-between gap-3 border-b px-4 py-3">
              <div className="min-w-0">
                <h3 id="po-address-title" className="text-foreground text-sm font-semibold">
                  {addressFormFor === 'new'
                    ? 'New address'
                    : addressFormFor
                      ? 'Edit address'
                      : 'Billing address'}
                </h3>
                <p className="text-muted-foreground mt-0.5 truncate text-xs">{supplier.name}</p>
              </div>
              <button
                onClick={() => setAddressPickerOpen(false)}
                className="btn-ghost shrink-0 p-1.5"
                aria-label="Close"
              >
                <X size={16} />
              </button>
            </div>

            <div className="flex-1 overflow-y-auto">
              {addressError && (
                <div className="m-3 mb-0 flex items-start gap-2 rounded-lg border border-red-500/40 bg-red-500/5 p-2.5">
                  <AlertCircle size={14} className="mt-0.5 shrink-0 text-red-400" />
                  <p className="text-xs text-red-400">{addressError}</p>
                </div>
              )}

              {/* The form replaces the list rather than appearing under it. On
                  a panel this size, a list and a form together is a scroll in
                  a box, and you cannot see what you are editing anyway. */}
              {addressFormFor ? (
                <div className="space-y-3 p-4">
                  <div>
                    <label className="form-label" htmlFor="po-new-addr-line">
                      Address<span className="ml-0.5 text-red-500">*</span>
                    </label>
                    <textarea
                      id="po-new-addr-line"
                      rows={2}
                      className="form-input"
                      placeholder="Building, street, area"
                      value={newAddress.address}
                      onChange={(e) => setNewAddress((p) => ({ ...p, address: e.target.value }))}
                    />
                  </div>

                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                    <div>
                      <label className="form-label" htmlFor="po-new-addr-city">
                        City
                      </label>
                      <input
                        id="po-new-addr-city"
                        className="form-input h-9"
                        value={newAddress.city}
                        onChange={(e) => setNewAddress((p) => ({ ...p, city: e.target.value }))}
                      />
                    </div>
                    <div>
                      <label className="form-label" htmlFor="po-new-addr-pincode">
                        Pincode
                      </label>
                      <input
                        id="po-new-addr-pincode"
                        className="form-input h-9"
                        value={newAddress.pincode}
                        onChange={(e) => setNewAddress((p) => ({ ...p, pincode: e.target.value }))}
                      />
                    </div>
                    <div>
                      <label className="form-label" htmlFor="po-new-addr-state">
                        State
                      </label>
                      <input
                        id="po-new-addr-state"
                        className="form-input h-9"
                        value={newAddress.state}
                        onChange={(e) => setNewAddress((p) => ({ ...p, state: e.target.value }))}
                      />
                    </div>
                    <div>
                      <label className="form-label" htmlFor="po-new-addr-statecode">
                        State code
                      </label>
                      {/* Two digits, and it decides the tax split — 27 is
                          Maharashtra, 07 is Delhi. A wrong one means the
                          supplier charges the wrong kind of GST, so it is
                          asked for rather than guessed from the state name. */}
                      <input
                        id="po-new-addr-statecode"
                        className="form-input h-9"
                        maxLength={2}
                        placeholder="27"
                        value={newAddress.stateCode}
                        onChange={(e) =>
                          setNewAddress((p) => ({ ...p, stateCode: e.target.value }))
                        }
                      />
                    </div>
                  </div>

                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                    <div>
                      <label className="form-label" htmlFor="po-new-addr-label">
                        Name it
                      </label>
                      <input
                        id="po-new-addr-label"
                        className="form-input h-9"
                        placeholder="Works, godown"
                        value={newAddress.label}
                        onChange={(e) => setNewAddress((p) => ({ ...p, label: e.target.value }))}
                      />
                    </div>
                    <div>
                      <label className="form-label" htmlFor="po-new-addr-gstin">
                        GSTIN here
                      </label>
                      <input
                        id="po-new-addr-gstin"
                        className="form-input h-9 font-mono"
                        maxLength={15}
                        placeholder="Optional"
                        value={newAddress.gstin}
                        onChange={(e) => setNewAddress((p) => ({ ...p, gstin: e.target.value }))}
                      />
                    </div>
                  </div>

                  <label className="border-border bg-secondary flex cursor-pointer items-center gap-2 rounded-lg border p-2.5">
                    <input
                      type="checkbox"
                      checked={newAddress.isDefault}
                      onChange={(e) =>
                        setNewAddress((p) => ({ ...p, isDefault: e.target.checked }))
                      }
                    />
                    <span className="text-foreground text-xs">
                      Use this as {supplier.name}&apos;s usual address
                    </span>
                  </label>
                </div>
              ) : (
                <div className="space-y-2 p-3">
                  {supplierAddresses.length === 0 && (
                    <p className="text-muted-foreground px-1 py-6 text-center text-sm">
                      No addresses on this supplier yet.
                    </p>
                  )}

                  {supplierAddresses.map((a) => {
                    const picked = a.id === supplierAddressId
                    return (
                      <div
                        key={a.id}
                        className={`flex items-start gap-2.5 rounded-lg border p-2.5 ${
                          picked ? 'border-primary/50 bg-primary/5' : 'border-border bg-card'
                        }`}
                      >
                        {/* Choosing and editing are separate targets. One row
                            that both billed the order to an address and opened
                            it for editing would do the wrong one half the
                            time. */}
                        <button
                          type="button"
                          onClick={() => {
                            setSupplierAddressId(a.id)
                            setAddressPickerOpen(false)
                          }}
                          className="flex min-w-0 flex-1 items-start gap-2.5 text-left"
                          aria-label={`Bill this order to ${a.label || a.address}`}
                        >
                          <span
                            className={`mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full border ${
                              picked ? 'border-primary bg-primary text-white' : 'border-border'
                            }`}
                          >
                            {picked && <Check size={11} />}
                          </span>
                          <span className="min-w-0">
                            <span className="flex flex-wrap items-center gap-1.5">
                              <span className="text-foreground text-sm font-medium">
                                {a.label || 'Address'}
                              </span>
                              {a.isDefault && (
                                <span className="text-muted-foreground text-[10px]">usual</span>
                              )}
                            </span>
                            <span className="text-muted-foreground mt-0.5 block text-xs leading-relaxed">
                              {addressLine(a)}
                            </span>
                            {a.gstin && (
                              <span className="text-muted-foreground mt-0.5 block font-mono text-[10px]">
                                GSTIN {a.gstin}
                              </span>
                            )}
                          </span>
                        </button>
                        <button
                          type="button"
                          onClick={() => startEditAddress(a)}
                          className="btn-ghost shrink-0 p-1.5"
                          title="Edit this address on the supplier"
                          aria-label={`Edit ${a.label || a.address}`}
                        >
                          <Pencil size={13} />
                        </button>
                      </div>
                    )
                  })}

                  <button
                    type="button"
                    onClick={() => {
                      setNewAddress(BLANK_ADDRESS)
                      setAddressFormFor('new')
                      setAddressError(null)
                    }}
                    className="text-primary border-primary/40 hover:bg-primary/10 flex w-full items-center justify-center gap-1.5 rounded-lg border border-dashed py-2 text-xs font-medium"
                  >
                    <Plus size={13} />
                    Add new address
                  </button>
                </div>
              )}
            </div>

            {addressFormFor ? (
              <div className="border-border flex shrink-0 items-center justify-end gap-2 border-t px-4 py-3">
                <button
                  type="button"
                  onClick={() => {
                    setAddressFormFor(null)
                    setAddressError(null)
                  }}
                  className="btn-secondary"
                  disabled={savingAddress}
                >
                  Back
                </button>
                <button
                  type="button"
                  onClick={() => void saveAddress()}
                  className="btn-primary"
                  disabled={savingAddress || !newAddress.address.trim()}
                >
                  {savingAddress && <Loader2 size={15} className="animate-spin" />}
                  Save on supplier
                </button>
              </div>
            ) : (
              <div className="border-border text-muted-foreground shrink-0 border-t px-4 py-2.5 text-xs">
                Anything added or changed here is saved on the supplier.
              </div>
            )}
          </div>
        </div>
      )}
      {/* Everything this item has been bought at.

          Inside the same portal as the form and centred over it, because this
          is a lookup the buyer opens, reads and closes — nothing about the
          order is changed from here. Clicking the backdrop closes it: there is
          nothing to lose, and a panel you can only leave by finding the X is a
          panel people stop opening.

          Narrower than the form on purpose. Seven short columns spread across
          the full width read as a strip of scattered figures rather than a
          table, and with one past purchase in it there is very little to
          spread. */}
      {historyFor &&
        (() => {
          const rows = rateHistory[historyFor] ?? []
          const rates = rows.map((r) => num(r.unitRate))
          return (
            <div
              className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm"
              role="dialog"
              aria-modal="true"
              aria-labelledby="po-history-title"
              onClick={() => setHistoryFor(null)}
            >
              <div
                className="glass-card flex max-h-[85vh] w-full max-w-2xl flex-col overflow-hidden"
                onClick={(e) => e.stopPropagation()}
              >
                <div className="border-border flex shrink-0 items-start justify-between gap-4 border-b px-4 py-3">
                  <div className="flex items-start gap-3">
                    <div className="bg-primary/10 border-primary/20 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border">
                      <History size={17} className="text-primary" />
                    </div>
                    <div>
                      <h3 id="po-history-title" className="text-foreground text-base font-semibold">
                        Previous purchases
                      </h3>
                      <p className="text-muted-foreground mt-0.5 text-[13px]">
                        {itemById.get(historyFor)?.name ?? 'This item'}
                      </p>
                    </div>
                  </div>
                  <button
                    onClick={() => setHistoryFor(null)}
                    className="btn-ghost shrink-0 p-2"
                    aria-label="Close the history"
                  >
                    <X size={16} />
                  </button>
                </div>

                {/* Only once there is a spread to describe. With a single past
                    purchase, last, lowest and highest are all the same figure,
                    and three boxes repeating it is padding. */}
                {rows.length > 1 && (
                  <div className="border-border grid shrink-0 grid-cols-1 border-b sm:grid-cols-3">
                    {[
                      ['Last rate', rates[0]],
                      ['Lowest', Math.min(...rates)],
                      ['Highest', Math.max(...rates)],
                    ].map(([label, value], n) => (
                      <div
                        key={String(label)}
                        className={`px-4 py-2.5 ${n > 0 ? 'border-border border-l' : ''}`}
                      >
                        <p className="text-muted-foreground text-[10px] font-semibold uppercase tracking-wider">
                          {label}
                        </p>
                        <p className="text-foreground mt-0.5 text-base font-semibold tabular-nums">
                          {inr(value as number)}
                        </p>
                      </div>
                    ))}
                  </div>
                )}

                <div className="flex-1 overflow-y-auto p-3">
                  {rows.length === 0 ? (
                    <p className="text-muted-foreground py-10 text-center text-sm">
                      This item has not been bought before.
                    </p>
                  ) : (
                    <div className="border-border overflow-hidden rounded-lg border">
                      <table className="w-full text-sm">
                        <thead>
                          <tr className="bg-secondary border-border border-b">
                            {[
                              ['#', 'left'],
                              ['Purchase order', 'left'],
                              ['Supplier', 'left'],
                              ['Rate', 'right'],
                              ['Qty', 'right'],
                              ['Amount', 'right'],
                              ['Date', 'right'],
                            ].map(([h, align]) => (
                              <th
                                key={h}
                                className={`text-muted-foreground px-3 py-2 text-[10px] font-semibold uppercase tracking-wider ${
                                  align === 'right' ? 'text-right' : 'text-left'
                                }`}
                              >
                                {h}
                              </th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {rows.map((h, n) => (
                            <tr
                              key={h.id}
                              className={`border-border/50 border-b last:border-0 ${
                                n % 2 === 1 ? 'zebra-row' : 'bg-card'
                              }`}
                            >
                              <td className="text-muted-foreground px-3 py-2 tabular-nums">
                                {n + 1}
                              </td>
                              <td className="px-3 py-2">
                                <span className="font-mono text-xs">{h.poNumber}</span>
                                {/* Said, not hidden. A cancelled order's rate
                                    was still quoted and is worth seeing, but
                                    presenting it as though the order stood
                                    would mislead. */}
                                {h.status === 'CANCELLED' && (
                                  <span className="text-muted-foreground ml-1.5 text-[10px]">
                                    cancelled
                                  </span>
                                )}
                              </td>
                              <td className="text-foreground truncate px-3 py-2">
                                {h.supplierName}
                              </td>
                              <td className="px-3 py-2 text-right font-medium tabular-nums">
                                {inr(num(h.unitRate))}
                              </td>
                              <td className="text-muted-foreground px-3 py-2 text-right tabular-nums">
                                {num(h.qty)}
                              </td>
                              <td className="px-3 py-2 text-right tabular-nums">
                                {inr(num(h.amount))}
                              </td>
                              <td className="text-muted-foreground whitespace-nowrap px-3 py-2 text-right text-xs">
                                {h.poDate
                                  ? new Date(h.poDate).toLocaleDateString('en-IN', {
                                      day: '2-digit',
                                      month: 'short',
                                      year: 'numeric',
                                    })
                                  : '—'}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>

                <div className="border-border text-muted-foreground shrink-0 border-t px-4 py-2.5 text-xs">
                  {rows.length === 1
                    ? 'One previous purchase.'
                    : `${rows.length} previous purchases, newest first.`}{' '}
                  Nothing here changes the order — the rate is always typed in.
                </div>
              </div>
            </div>
          )
        })()}

      {indentOpen && (
        <IndentItemsDialog
          onClose={() => setIndentOpen(false)}
          onAdd={addFromIndent}
          alreadyPicked={new Set(lines.map((l) => l.mrLineId).filter(Boolean) as string[])}
        />
      )}

      {newItemFor !== null && (
        <NewItemDialog
          categories={categories.map((c) => ({
            id: c.id,
            name: c.name,
            parentId: c.parentId ?? null,
          }))}
          categoryId={lines[newItemFor]?.categoryId}
          subcategoryId={lines[newItemFor]?.subcategoryId}
          onClose={() => setNewItemFor(null)}
          onCreated={(created: NewItem) => {
            const index = newItemFor
            setNewItemFor(null)

            /*
             * Added to the list this form is holding as well as to the master.
             * Without it the item exists on the server and not in the dropdown,
             * and the row that asked for it still cannot pick it — the master
             * list is fetched once, when the form opens.
             *
             * `categoryId` is spelled out because this form's items carry the
             * id flat while the master returns the category nested, and
             * `itemsFor` narrows on the flat one. Without it the new item
             * would sit outside every category and vanish the moment the row
             * it was made for narrowed to the category it was filed under.
             */
            const option: Option = {
              id: created.id,
              code: created.code,
              name: created.name,
              hsnCode: created.hsnCode,
              uom: created.uom,
              category: created.category
                ? { id: created.category.id, name: created.category.name }
                : null,
              categoryId: created.category?.id ?? null,
            }
            setItems((prev) => [...prev, option])

            /*
             * Set on the row directly rather than through `pickItemFor`, which
             * reads the item out of `itemById` — a map built from `items` by
             * the render that has not happened yet.
             *
             * The rate is left empty, as it is for every other item on this
             * form: what the supplier quoted is the only rate a purchase order
             * carries, and a figure typed into the master an instant ago is
             * not that. The enquiry form does offer it, and that is not the
             * same thing — an expected rate is the mill's own guess.
             */
            const cat = categories.find((c) => c.id === option.categoryId)
            setLine(index, {
              itemId: option.id,
              codeText: option.code ?? '',
              ...(cat
                ? cat.parentId
                  ? { categoryId: cat.parentId, subcategoryId: cat.id }
                  : { categoryId: cat.id, subcategoryId: '' }
                : {}),
            })
          }}
        />
      )}
    </>,
    document.body
  )
}
