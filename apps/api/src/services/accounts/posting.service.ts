import type { BillRefKind, LedgerParty, Prisma, PrismaClient, VoucherKind } from '@prisma/client'
import { purchaseShareOf } from '../brandStock.service'
import { AppError } from '../../middleware/errorHandler'
import { financialYearOf } from '../../lib/docNumber'
import { logger } from '../../utils/logger'
import { keyedLedgerId, partyLedgerId } from './chart.service'
import { allocationJournal, runDay } from './allocation.service'
import { bankDatesOf, bankKey, booksSettings, checkBalancedNow, dayText, dayValue, istDay, r2, type BooksSettings } from './books.service'

/**
 * Sales and Purchase documents into the books.
 *
 * Every money document writes one voucher, inside the same save, and rewrites
 * it whenever the document changes: a sales invoice a Sales voucher, a
 * receipt a Receipt, a supplier's bill a Purchase, and so on. A cancelled or
 * reversed document cancels its voucher; the voucher keeps its number and
 * lines and stops counting. The document is the record — its voucher follows
 * it and is never typed or altered in Accounts.
 *
 *   Sales invoice   Dr customer (the bill)        Cr Sales / Job Work Income,
 *                                                 charges, output GST, round off
 *   Brokerage       Dr Brokerage on Sales         Cr broker (a journal per invoice)
 *   Receipt         Dr bank / cash, TDS receivable Cr customer, against the invoices
 *   Credit note     Dr Sales Returns, output GST  Cr customer
 *   Purchase bill   Dr Purchase – <category> or the expense head, charges,
 *                   input GST, round off          Cr supplier (the bill), TDS payable,
 *                                                 GST payable on reverse charge
 *   Supplier payment Dr supplier, against the bill Cr bank / cash, TDS payable
 *   Purchase note   Dr / Cr supplier              Purchase Returns & Adjustments,
 *                                                 input GST where the GST counts
 *
 * Documents dated before the books start do not post. Once the books are
 * closed up to a day, nothing dated on or before it may change its voucher —
 * so the document cannot be saved, changed or cancelled either.
 *
 * Posting never stops a document being saved for any other reason: if a rule
 * fails, the document saves without its voucher, the failure is logged, and
 * Accounts lists it as not yet in the books until it is posted again.
 *
 * Income and expense lines carry two tags, in the one set of books: the
 * brand (profit centre) and the department (cost centre). Each comes from the
 * document where it says — the order's brand, the indent's department, what
 * was picked on a bill line — else from the ledger's own default, else (for
 * the department) the standard one for sales and job work. A bank, party, tax
 * or other balance-sheet line never carries either.
 */

type Tx = Prisma.TransactionClient

export type SourceType =
  | 'SALES_INVOICE'
  | 'BROKERAGE'
  | 'SALES_RECEIPT'
  | 'CREDIT_NOTE'
  | 'PURCHASE_BILL'
  | 'SUPPLIER_PAYMENT'
  | 'PURCHASE_NOTE'
  | 'EXPENSE_ALLOCATION'
  | 'EXPENSE_ALLOCATION_REVERSAL'

/** What each source is called when Accounts names it. */
export const SOURCE_LABEL: Record<SourceType, string> = {
  SALES_INVOICE: 'Sales invoice',
  BROKERAGE: 'Brokerage on invoice',
  SALES_RECEIPT: 'Payment received',
  CREDIT_NOTE: 'Credit note',
  PURCHASE_BILL: 'Purchase bill',
  SUPPLIER_PAYMENT: 'Supplier payment',
  PURCHASE_NOTE: 'Purchase note',
  EXPENSE_ALLOCATION: 'Expense allocation',
  EXPENSE_ALLOCATION_REVERSAL: 'Expense allocation reversal',
}

interface PlanRef {
  kind: BillRefKind
  billNo: string
  billDate: string
  dueDate: string | null
  /** Signed like its line: debit positive. */
  amount: number
}

interface Plan {
  kind: VoucherKind
  voucherNo: string
  date: string
  narration: string | null
  mode?: string | null
  referenceNo?: string | null
  chequeNo?: string | null
  chequeDate?: string | null
  cancelled: boolean
  cancelReason?: string | null
  lines: PlanLine[]
}

type PlanLine = { ledgerId: string; amount: number; costCentreId: string | null; departmentId: string | null; refs: PlanRef[] }

/** A line's tags as its document gives them: a brand's profit centre, a department. */
type Tags = { costCentreId?: string | null; departmentId?: string | null }

/**
 * Lines added as signed amounts (debit positive) and merged by ledger, brand
 * and department, so a five-line invoice at one GST rate credits Sales once.
 * The third argument is the brand's profit centre, or both tags.
 */
class Lines {
  private map = new Map<string, PlanLine>()
  add(ledgerId: string, amount: number, tags: string | null | Tags = null, refs: PlanRef[] = []) {
    const a = r2(amount)
    if (a === 0 && !refs.length) return
    const t: Tags = typeof tags === 'object' && tags !== null ? tags : { costCentreId: tags }
    const costCentreId = t.costCentreId ?? null
    const departmentId = t.departmentId ?? null
    const key = `${ledgerId}|${costCentreId ?? ''}|${departmentId ?? ''}`
    const have = this.map.get(key) ?? { ledgerId, amount: 0, costCentreId, departmentId, refs: [] }
    have.amount = r2(have.amount + a)
    have.refs.push(...refs)
    this.map.set(key, have)
  }
  /**
   * An amount spread over shares by their weight, each part carrying its
   * share's tags; the last takes what rounding leaves, so the parts add up.
   */
  spread(ledgerId: string, amount: number, shares: Array<{ weight: number; tags: Tags }>) {
    const total = shares.reduce((t, sh) => t + Math.max(0, sh.weight), 0)
    const a = r2(amount)
    if (a === 0) return
    if (!(total > 0)) return this.add(ledgerId, a)
    let left = a
    const live = shares.filter((sh) => sh.weight > 0)
    live.forEach((sh, i) => {
      const part = i === live.length - 1 ? left : r2((a * sh.weight) / total)
      left = r2(left - part)
      this.add(ledgerId, part, sh.tags)
    })
  }
  /** Out of balance by this much: debit positive. */
  difference() {
    return r2([...this.map.values()].reduce((t, l) => t + l.amount, 0))
  }
  list() {
    return [...this.map.values()].filter((l) => l.amount !== 0)
  }
}

const n = (v: Prisma.Decimal | number | null | undefined) => Number(v ?? 0)

/** The cost centre of a brand, made if the brand has none yet. */
async function centreFor(tx: Tx, brandId: string | null | undefined): Promise<string | null> {
  if (!brandId) return null
  const have = await tx.costCentre.findUnique({ where: { brandId }, select: { id: true } })
  if (have) return have.id
  const brand = await tx.brand.findUnique({ where: { id: brandId }, select: { name: true, isActive: true } })
  if (!brand) return null
  const clash = await tx.costCentre.findFirst({ where: { name: { equals: brand.name, mode: 'insensitive' } }, select: { id: true } })
  const made = await tx.costCentre.create({ data: { name: clash ? `${brand.name} (brand)` : brand.name, brandId, isActive: brand.isActive }, select: { id: true } })
  return made.id
}

/**
 * The standard department for a system ledger with no default of its own:
 * sales, their charges, returns and brokerage sit with Sales & Marketing; job
 * work with Production. Found by name among the departments (Masters →
 * Departments → Cost centres adds them); when there is none, nothing.
 */
const STANDARD_DEPARTMENT: Array<[RegExp, string]> = [
  [/^SALES_JOB_WORK$/, 'Production'],
  [/^(SALES|SALES_OTHER_CHARGES|SALES_RETURNS|BROKERAGE)$|^SALES_CHARGE:/, 'Sales & Marketing'],
]

/** A department by its name, ignoring case: the standard ones the rules name. */
export async function departmentNamed(tx: Tx, name: string): Promise<string | null> {
  const d = await tx.department.findFirst({ where: { name: { equals: name, mode: 'insensitive' }, isActive: true }, select: { id: true } })
  return d?.id ?? null
}

/**
 * Every line's tags made final. Only income and expense lines carry them: a
 * bank, party, tax or other balance-sheet line never does, whatever was
 * passed. A line takes its document's tags; where the document says nothing,
 * its ledger's defaults; for the department, then the standard one for sales
 * and job work. Lines that end up alike are put back together.
 */
async function finishTags(tx: Tx, lines: PlanLine[]): Promise<PlanLine[]> {
  if (!lines.length) return lines
  const ledgers = await tx.ledger.findMany({
    where: { id: { in: [...new Set(lines.map((l) => l.ledgerId))] } },
    select: { id: true, systemKey: true, costCentreId: true, departmentId: true, group: { select: { nature: true } } },
  })
  const byId = new Map(ledgers.map((l) => [l.id, l]))
  const named = new Map<string, string | null>()
  const standard = async (key: string | null) => {
    const hit = key ? STANDARD_DEPARTMENT.find(([re]) => re.test(key)) : undefined
    if (!hit) return null
    if (!named.has(hit[1])) named.set(hit[1], await departmentNamed(tx, hit[1]))
    return named.get(hit[1]) ?? null
  }
  const out = new Map<string, PlanLine>()
  for (const l of lines) {
    const led = byId.get(l.ledgerId)
    const pl = led?.group.nature === 'INCOME' || led?.group.nature === 'EXPENSE'
    const costCentreId = pl ? (l.costCentreId ?? led?.costCentreId ?? null) : null
    const departmentId = pl ? (l.departmentId ?? led?.departmentId ?? (await standard(led?.systemKey ?? null))) : null
    const key = `${l.ledgerId}|${costCentreId ?? ''}|${departmentId ?? ''}`
    const have = out.get(key) ?? { ledgerId: l.ledgerId, amount: 0, costCentreId, departmentId, refs: [] }
    have.amount = r2(have.amount + l.amount)
    have.refs.push(...l.refs)
    out.set(key, have)
  }
  return [...out.values()].filter((l) => l.amount !== 0 || l.refs.length)
}

const party = (tx: Tx, type: LedgerParty, id: string) => partyLedgerId(tx, type, id)

/** Where money came in or went out: the bank named, else cash, else a cheque not yet banked. */
async function moneyLedger(tx: Tx, bankAccountId: string | null, mode: string) {
  if (bankAccountId) return party(tx, 'BANK', bankAccountId)
  return keyedLedgerId(tx, mode === 'CASH' ? 'CASH' : 'CHEQUES_IN_HAND')
}

/** A charge type's own ledger, on the sales side or the purchase side. */
function chargeLedger(tx: Tx, side: 'SALES' | 'PURCHASE', ct: { id: string; name: string }) {
  return keyedLedgerId(tx, `${side}_CHARGE:${ct.id}`, {
    name: `${ct.name} – ${side === 'SALES' ? 'Sales' : 'Purchase'}`,
    group: side === 'SALES' ? 'DIRECT_INCOMES' : 'DIRECT_EXPENSES',
  })
}

/** TDS payable under a section — "TDS Payable – 194C" — or the general one when none is known. */
async function tdsPayable(tx: Tx, section: { id: string; section: string } | null) {
  if (!section) return keyedLedgerId(tx, 'TDS_PAYABLE')
  return keyedLedgerId(tx, `TDS_PAYABLE:${section.id}`, { name: `TDS Payable – ${section.section}`, group: 'DUTIES_TAXES' })
}

// ── Purchases by category and expense head ───────────────────

type Category = { id: string; name: string; parentId: string | null; itemGroup?: string | null }

/** Spending done to make the goods, filed above gross profit; the rest is overhead. */
const DIRECT_WORDS = /job ?work|stitch|tailor|print|wash|embroider|dye|dyeing|fabricat|labou?r|wages|freight in|carriage in|cartage|packing charge/i

/** The ledger a bill line goes to, and whether it is an expense head rather than goods. */
async function purchaseHeadFor(
  tx: Tx,
  cats: Map<string, Category>,
  line: { grnLineId: string | null; item: { id: string; name: string; categoryId: string } },
): Promise<{ ledgerId: string; expense: boolean }> {
  // Up the tree from the item's own category to the top.
  const chain: Category[] = []
  for (let c = cats.get(line.item.categoryId); c && chain.length < 10; c = c.parentId ? cats.get(c.parentId) : undefined) chain.push(c)
  const top = chain[chain.length - 1]
  // A fixed asset bought is capital, not a purchase: its own ledger under Fixed Assets, by its sub-category.
  if (top?.itemGroup === 'FIXED_ASSETS') {
    const sub = chain.length > 1 ? chain[chain.length - 2] : top
    return { ledgerId: await keyedLedgerId(tx, `FIXED_ASSET_CAT:${sub.id}`, { name: sub.id === top.id ? 'Fixed Assets' : sub.name, group: 'FIXED_ASSETS' }), expense: false }
  }
  const isExpense = !line.grnLineId && chain.some((c) => /expense/i.test(c.name))
  if (isExpense) {
    return { ledgerId: await keyedLedgerId(tx, `EXPENSE:${line.item.id}`, { name: line.item.name, group: DIRECT_WORDS.test(line.item.name) ? 'DIRECT_EXPENSES' : 'INDIRECT_EXPENSES' }), expense: true }
  }
  if (!top) return { ledgerId: await keyedLedgerId(tx, 'PURCHASE'), expense: false }
  return { ledgerId: await keyedLedgerId(tx, `PURCHASE_CAT:${top.id}`, { name: `Purchase – ${top.name}`, group: 'PURCHASE_ACCOUNTS' }), expense: false }
}

/**
 * A bill's expense-head lines that no source gives a department: not picked
 * on the line, no usual department on the expense head, none on its ledger.
 * A new bill may not have any (the department is its cost centre); a legacy
 * import may, marked as such.
 */
export async function expenseLinesWithoutDepartment(
  tx: Tx,
  lines: Array<{ itemId: string; grnLineId?: string | null; departmentId?: string | null }>,
): Promise<Array<{ line: number; head: string }>> {
  const ids = [...new Set(lines.map((l) => l.itemId))]
  if (!ids.length) return []
  const [items, cats, ledgers] = await Promise.all([
    tx.item.findMany({ where: { id: { in: ids } }, select: { id: true, name: true, categoryId: true, departmentId: true } }),
    tx.itemCategory.findMany({ select: { id: true, name: true, parentId: true, itemGroup: true } }),
    tx.ledger.findMany({ where: { systemKey: { in: ids.map((id) => `EXPENSE:${id}`) } }, select: { systemKey: true, departmentId: true } }),
  ])
  const byCat = new Map(cats.map((c) => [c.id, c]))
  const out: Array<{ line: number; head: string }> = []
  lines.forEach((l, i) => {
    if (l.grnLineId || l.departmentId) return
    const item = items.find((x) => x.id === l.itemId)
    if (!item) return
    const chain: Category[] = []
    for (let c = byCat.get(item.categoryId); c && chain.length < 10; c = c.parentId ? byCat.get(c.parentId) : undefined) chain.push(c)
    if (chain[chain.length - 1]?.itemGroup === 'FIXED_ASSETS' || !chain.some((c) => /expense/i.test(c.name))) return
    const ledgerDept = ledgers.find((x) => x.systemKey === `EXPENSE:${item.id}`)?.departmentId
    if (!item.departmentId && !ledgerDept) out.push({ line: i + 1, head: item.name })
  })
  return out
}

/** The order line a bill line goes back to, by itself or through its receipt. */
const orderTrace = {
  select: {
    style: { select: { brandId: true } },
    // The indent behind it: its department, and the brand of the MO it was raised for.
    mrLine: { select: { mr: { select: { departmentId: true, mo: { select: { brandId: true } } } } } },
  },
} as const

/**
 * A bill's lines as they go into the books: each line's ledger, its value and
 * its tags. The brand is what was picked on the line, else the brand of the
 * MO its indent was raised for, else its order line's style's brand; none is
 * central stock. The department is what was picked, else the indent's, else —
 * for an expense head only — the head's own department.
 */
async function billLines(tx: Tx, billId: string) {
  const lines = await tx.purchaseInvoiceLine.findMany({
    where: { billId },
    orderBy: { sortOrder: 'asc' },
    select: {
      taxableValue: true,
      grnLineId: true,
      costCentreId: true,
      departmentId: true,
      item: { select: { id: true, name: true, categoryId: true, departmentId: true } },
      poLineId: true,
      poLine: orderTrace,
      grnLine: { select: { brandId: true, poLine: orderTrace } },
    },
  })
  const cats = new Map((await tx.itemCategory.findMany({ select: { id: true, name: true, parentId: true, itemGroup: true } })).map((c) => [c.id, c]))
  const out: Array<{ ledgerId: string; value: number; expense: boolean; tags: Tags }> = []
  for (const line of lines) {
    const head = await purchaseHeadFor(tx, cats, line)
    const po = line.poLine ?? line.grnLine?.poLine ?? null
    const indent = po?.mrLine?.mr ?? null
    // The brand whose share its goods went into (multi-brand phase 5): the GRN
    // line's; billed without a receipt, the same purchase rule a GRN follows
    // (the PO's brand, else its indent's MO, else its style's own brand).
    // Stock and purchases then agree by brand; anything else is central.
    const brandId = line.grnLineId ? (line.grnLine?.brandId ?? null) : await purchaseShareOf(tx, line.poLineId ?? null)
    out.push({
      ledgerId: head.ledgerId,
      value: n(line.taxableValue),
      expense: head.expense,
      tags: {
        costCentreId: line.costCentreId ?? (await centreFor(tx, brandId)),
        departmentId: line.departmentId ?? indent?.departmentId ?? (head.expense ? line.item.departmentId : null) ?? null,
      },
    })
  }
  return out
}

// ═══════════════════════════════════════════
// THE RULES
// ═══════════════════════════════════════════

async function planSalesInvoice(tx: Tx, id: string): Promise<Plan | null> {
  const inv = await tx.salesInvoice.findUnique({
    where: { id },
    include: {
      so: { select: { soNumber: true, isJobWork: true, brandId: true } },
      customer: { select: { name: true } },
      charges: { include: { chargeType: { select: { id: true, name: true } } } },
    },
  })
  if (!inv) return null
  // Job work is the mill's own, and its income Production's.
  const tags: Tags = { costCentreId: await centreFor(tx, inv.so?.brandId), departmentId: inv.so?.isJobWork ? await departmentNamed(tx, 'Production') : null }
  const L = new Lines()
  const date = istDay(inv.invoiceDate)
  L.add(await party(tx, 'CUSTOMER', inv.customerId), n(inv.totalAmount), null, [
    { kind: 'NEW_REF', billNo: inv.invoiceNumber, billDate: date, dueDate: inv.dueDate ? istDay(inv.dueDate) : null, amount: n(inv.totalAmount) },
  ])
  L.add(await keyedLedgerId(tx, inv.so?.isJobWork ? 'SALES_JOB_WORK' : 'SALES'), -n(inv.taxableAmount), tags)
  for (const c of inv.charges) {
    // The mill's own trims billed on a job-work order are a sale of goods.
    const ledger = c.ownMaterial ? await keyedLedgerId(tx, 'SALES') : await chargeLedger(tx, 'SALES', c.chargeType)
    // Its value without GST: for a charge typed with GST included, the GST
    // inside it goes to the output GST ledgers with the rest, not here. One
    // saved before charges had a treatment had GST added on top: its amount.
    L.add(ledger, -n(c.netAmount ?? c.amount), tags)
  }
  L.add(await keyedLedgerId(tx, 'SALES_OTHER_CHARGES'), -n(inv.otherCharges), tags)
  L.add(await keyedLedgerId(tx, 'OUTPUT_CGST'), -n(inv.cgst))
  L.add(await keyedLedgerId(tx, 'OUTPUT_SGST'), -n(inv.sgst))
  L.add(await keyedLedgerId(tx, 'OUTPUT_IGST'), -n(inv.igst))
  // A round-off added to the bill is income; one taken off is an expense.
  L.add(await keyedLedgerId(tx, 'ROUND_OFF'), -n(inv.roundOff))
  return {
    kind: 'SALES',
    voucherNo: inv.invoiceNumber,
    date,
    narration: `Sales to ${inv.customer.name}${inv.so ? ` against ${inv.so.soNumber}` : ''}`,
    cancelled: inv.status === 'CANCELLED',
    cancelReason: inv.cancelReason,
    lines: await finishTags(tx, L.list()),
  }
}

/** The broker's commission on an invoice, owed from the day it is raised. */
async function planBrokerage(tx: Tx, id: string): Promise<Plan | null> {
  const inv = await tx.salesInvoice.findUnique({
    where: { id },
    select: {
      invoiceNumber: true,
      invoiceDate: true,
      status: true,
      cancelReason: true,
      brokerId: true,
      brokerageAmount: true,
      brokeragePercent: true,
      broker: { select: { name: true } },
      so: { select: { brandId: true } },
    },
  })
  if (!inv || !inv.brokerId || n(inv.brokerageAmount) <= 0) return null
  const amount = n(inv.brokerageAmount)
  const date = istDay(inv.invoiceDate)
  const L = new Lines()
  L.add(await keyedLedgerId(tx, 'BROKERAGE'), amount, await centreFor(tx, inv.so?.brandId))
  L.add(await party(tx, 'BROKER', inv.brokerId), -amount, null, [{ kind: 'NEW_REF', billNo: inv.invoiceNumber, billDate: date, dueDate: null, amount: -amount }])
  return {
    kind: 'JOURNAL',
    voucherNo: inv.invoiceNumber,
    date,
    narration: `Brokerage${inv.brokeragePercent ? ` at ${n(inv.brokeragePercent)}%` : ''} to ${inv.broker?.name ?? 'the broker'} on ${inv.invoiceNumber}`,
    cancelled: inv.status === 'CANCELLED',
    cancelReason: inv.cancelReason,
    lines: await finishTags(tx, L.list()),
  }
}

async function planReceipt(tx: Tx, id: string): Promise<Plan | null> {
  const r = await tx.paymentReceipt.findUnique({
    where: { id },
    include: {
      customer: { select: { name: true } },
      allocations: { include: { invoice: { select: { invoiceNumber: true, invoiceDate: true, dueDate: true } } }, orderBy: { createdAt: 'asc' } },
    },
  })
  if (!r) return null
  const received = istDay(r.receiptDate)
  // A post-dated cheque is money only from the date written on it.
  const onCheque = (r.mode === 'CHEQUE' || r.mode === 'PDC') && r.chequeDate ? istDay(r.chequeDate) : null
  const date = onCheque && onCheque > received ? onCheque : received
  const amount = n(r.amount)
  const tds = r2(r.allocations.reduce((t, a) => t + n(a.tdsAmount), 0))
  const refs: PlanRef[] = r.allocations.map((a) => ({
    kind: 'AGAINST_REF',
    billNo: a.invoice.invoiceNumber,
    billDate: istDay(a.invoice.invoiceDate),
    dueDate: a.invoice.dueDate ? istDay(a.invoice.dueDate) : null,
    amount: -r2(n(a.amount) + n(a.tdsAmount)),
  }))
  const advance = r2(amount - r.allocations.reduce((t, a) => t + n(a.amount), 0))
  if (advance > 0) refs.push({ kind: 'ADVANCE', billNo: r.receiptNumber, billDate: date, dueDate: null, amount: -advance })
  const L = new Lines()
  L.add(await moneyLedger(tx, r.bankAccountId, r.mode), amount)
  L.add(await keyedLedgerId(tx, 'TDS_RECEIVABLE'), tds)
  L.add(await party(tx, 'CUSTOMER', r.customerId), -r2(amount + tds), null, refs)
  return {
    kind: 'RECEIPT',
    voucherNo: r.receiptNumber,
    date,
    narration: `Received from ${r.customer.name}${r.allocations.length ? ` against ${r.allocations.map((a) => a.invoice.invoiceNumber).join(', ')}` : ' on account'}`,
    mode: r.mode,
    referenceNo: r.referenceNo,
    chequeNo: r.chequeNo,
    chequeDate: r.chequeDate ? istDay(r.chequeDate) : null,
    cancelled: r.status === 'REVERSED',
    cancelReason: r.reversalReason,
    lines: await finishTags(tx, L.list()),
  }
}

async function planCreditNote(tx: Tx, id: string): Promise<Plan | null> {
  const note = await tx.creditNote.findUnique({
    where: { id },
    include: {
      customer: { select: { name: true } },
      invoice: { select: { invoiceNumber: true, invoiceDate: true, so: { select: { brandId: true } } } },
      allocations: { include: { invoice: { select: { invoiceNumber: true, invoiceDate: true } } }, orderBy: { createdAt: 'asc' } },
    },
  })
  if (!note || (note.status !== 'ISSUED' && note.status !== 'CANCELLED')) return null
  const total = n(note.totalAmount)
  const date = istDay(note.noteDate)
  const moved = r2(note.allocations.reduce((t, a) => t + n(a.amount), 0))
  const held = note.status === 'CANCELLED' ? 0 : n(note.onAccount)
  const own = r2(total - held - moved)
  const refs: PlanRef[] = []
  if (own > 0) {
    refs.push(
      note.invoice
        ? { kind: 'AGAINST_REF', billNo: note.invoice.invoiceNumber, billDate: istDay(note.invoice.invoiceDate), dueDate: null, amount: -own }
        : { kind: 'ON_ACCOUNT', billNo: note.noteNumber, billDate: date, dueDate: null, amount: -own },
    )
  }
  for (const a of note.allocations) {
    refs.push({ kind: 'AGAINST_REF', billNo: a.invoice.invoiceNumber, billDate: istDay(a.invoice.invoiceDate), dueDate: null, amount: -n(a.amount) })
  }
  if (held > 0) refs.push({ kind: 'ADVANCE', billNo: note.noteNumber, billDate: date, dueDate: null, amount: -held })
  const L = new Lines()
  // Every note is against an invoice: its order's brand.
  L.add(await keyedLedgerId(tx, 'SALES_RETURNS'), n(note.taxableAmount), await centreFor(tx, note.invoice?.so?.brandId))
  L.add(await keyedLedgerId(tx, 'OUTPUT_CGST'), n(note.cgst))
  L.add(await keyedLedgerId(tx, 'OUTPUT_SGST'), n(note.sgst))
  L.add(await keyedLedgerId(tx, 'OUTPUT_IGST'), n(note.igst))
  L.add(await keyedLedgerId(tx, 'ROUND_OFF'), n(note.roundOff))
  L.add(await party(tx, 'CUSTOMER', note.customerId), -total, null, refs)
  return {
    kind: 'CREDIT_NOTE',
    voucherNo: note.noteNumber,
    date,
    narration: `${note.type === 'RETURN' ? 'Goods returned by' : 'Credit allowed to'} ${note.customer.name}${note.invoice ? ` on ${note.invoice.invoiceNumber}` : ''}${note.reason ? ` — ${note.reason}` : ''}`,
    cancelled: note.status === 'CANCELLED',
    cancelReason: note.cancelReason,
    lines: await finishTags(tx, L.list()),
  }
}

/** The bill number a supplier knows: their own, else ours. */
const supplierBillNo = (b: { supplierInvoiceNo: string | null; billNumber: string }) => b.supplierInvoiceNo?.trim() || b.billNumber

async function planPurchaseBill(tx: Tx, id: string): Promise<Plan | null> {
  const b = await tx.purchaseInvoice.findUnique({
    where: { id },
    include: {
      supplier: { select: { name: true } },
      tdsSectionRef: { select: { id: true, section: true } },
      charges: { include: { chargeType: { select: { id: true, name: true } } } },
    },
  })
  if (!b) return null
  const date = istDay(b.billDate)
  const total = n(b.totalAmount)
  const tds = n(b.tdsAmount)
  const L = new Lines()
  const lines = await billLines(tx, b.id)
  for (const line of lines) L.add(line.ledgerId, line.value, line.tags)
  // Freight and the like are spread over the goods by value, each part with its line's tags.
  const shares = lines.map((l) => ({ weight: l.value, tags: l.tags }))
  for (const c of b.charges) L.spread(await chargeLedger(tx, 'PURCHASE', c.chargeType), n(c.amount), shares)
  L.add(await keyedLedgerId(tx, 'INPUT_CGST'), n(b.cgst))
  L.add(await keyedLedgerId(tx, 'INPUT_SGST'), n(b.sgst))
  L.add(await keyedLedgerId(tx, 'INPUT_IGST'), n(b.igst))
  if (b.isReverseCharge) {
    // We pay the supplier's GST to the government ourselves, and claim it back as input.
    L.add(await keyedLedgerId(tx, 'RCM_CGST'), -n(b.cgst))
    L.add(await keyedLedgerId(tx, 'RCM_SGST'), -n(b.sgst))
    L.add(await keyedLedgerId(tx, 'RCM_IGST'), -n(b.igst))
  }
  L.add(await keyedLedgerId(tx, 'ROUND_OFF'), n(b.roundOff))
  if (tds > 0) L.add(await tdsPayable(tx, b.tdsSectionRef), -tds)
  const owed = r2(total - tds)
  L.add(await party(tx, 'SUPPLIER', b.supplierId), -owed, null, [
    {
      kind: 'NEW_REF',
      billNo: supplierBillNo(b),
      billDate: b.supplierInvoiceDate ? istDay(b.supplierInvoiceDate) : date,
      dueDate: b.dueDate ? istDay(b.dueDate) : null,
      amount: -owed,
    },
  ])
  // Line taxable values are rounded one by one and can miss the bill's own
  // figure by a few paise; that much goes to round off, anything more is a fault.
  const drift = L.difference()
  if (drift !== 0 && Math.abs(drift) <= 1) L.add(await keyedLedgerId(tx, 'ROUND_OFF'), -drift)
  return {
    kind: 'PURCHASE',
    voucherNo: b.billNumber,
    date,
    narration: `Bill ${supplierBillNo(b)} of ${b.supplier.name}`,
    cancelled: b.status === 'CANCELLED',
    lines: await finishTags(tx, L.list()),
  }
}

async function planSupplierPayment(tx: Tx, id: string): Promise<Plan | null> {
  const p = await tx.supplierPayment.findUnique({
    where: { id },
    include: {
      supplier: { select: { name: true, tdsSection: { select: { id: true, section: true } } } },
      invoice: { select: { billNumber: true, supplierInvoiceNo: true, billDate: true, supplierInvoiceDate: true, tdsSectionRef: { select: { id: true, section: true } } } },
    },
  })
  if (!p) return null
  const date = istDay(p.paymentDate)
  const amount = n(p.amount)
  const tds = n(p.tdsAmount)
  const ref: PlanRef = p.invoice
    ? {
        kind: 'AGAINST_REF',
        billNo: supplierBillNo(p.invoice),
        billDate: istDay(p.invoice.supplierInvoiceDate ?? p.invoice.billDate),
        dueDate: null,
        amount: r2(amount + tds),
      }
    : { kind: 'ADVANCE', billNo: p.paymentNumber, billDate: date, dueDate: null, amount: r2(amount + tds) }
  const L = new Lines()
  L.add(await party(tx, 'SUPPLIER', p.supplierId), r2(amount + tds), null, [ref])
  L.add(await moneyLedger(tx, p.bankAccountId, p.bankAccountId ? p.mode : 'CASH'), -amount)
  if (tds > 0) L.add(await tdsPayable(tx, p.invoice?.tdsSectionRef ?? p.supplier.tdsSection ?? null), -tds)
  return {
    kind: 'PAYMENT',
    voucherNo: p.paymentNumber,
    date,
    narration: `Paid to ${p.supplier.name}${p.invoice ? ` against bill ${supplierBillNo(p.invoice)}` : ' on account'}`,
    mode: p.mode,
    referenceNo: p.referenceNo,
    chequeNo: p.chequeNo,
    chequeDate: p.chequeDate ? istDay(p.chequeDate) : null,
    cancelled: p.status === 'REVERSED',
    cancelReason: p.reversalReason,
    lines: await finishTags(tx, L.list()),
  }
}

/** The GST treatments under which the note's GST moves our input credit. */
const GST_COUNTS = new Set(['GST_CREDIT_NOTE', 'GST_DEBIT_NOTE', 'ITC_REVERSAL_ONLY'])

async function planPurchaseNote(tx: Tx, id: string): Promise<Plan | null> {
  const note = await tx.purchaseNote.findUnique({
    where: { id },
    include: {
      supplier: { select: { name: true } },
      bill: { select: { id: true, billNumber: true, supplierInvoiceNo: true, billDate: true, supplierInvoiceDate: true } },
    },
  })
  // Only a posted note moves money; one cancelled after posting takes it back.
  if (!note || !(note.status === 'POSTED' || (note.status === 'CANCELLED' && note.postedAt))) return null
  const date = istDay(note.noteDate)
  const total = n(note.totalAmount)
  const gst = r2(n(note.cgst) + n(note.sgst) + n(note.igst))
  const counts = GST_COUNTS.has(note.gstTreatment)
  // Debit positive on the supplier when the note cuts what we owe.
  const sign = note.effect === 'REDUCES_PAYABLE' ? 1 : -1
  const ref: PlanRef = note.bill
    ? { kind: 'AGAINST_REF', billNo: supplierBillNo(note.bill), billDate: istDay(note.bill.supplierInvoiceDate ?? note.bill.billDate), dueDate: null, amount: sign * total }
    : { kind: 'ON_ACCOUNT', billNo: note.noteNumber, billDate: date, dueDate: null, amount: sign * total }
  const L = new Lines()
  L.add(await party(tx, 'SUPPLIER', note.supplierId), sign * total, null, [ref])
  // Against a bill it takes the bill lines' brands and departments, spread as the bill's value was.
  const returned = -sign * r2(n(note.taxableAmount) + n(note.otherCharges) - n(note.discountAmount) + (counts ? 0 : gst))
  const billShares = note.bill ? (await billLines(tx, note.bill.id)).map((l) => ({ weight: l.value, tags: l.tags })) : []
  L.spread(await keyedLedgerId(tx, 'PURCHASE_RETURNS'), returned, billShares)
  if (counts) {
    L.add(await keyedLedgerId(tx, 'INPUT_CGST'), -sign * n(note.cgst))
    L.add(await keyedLedgerId(tx, 'INPUT_SGST'), -sign * n(note.sgst))
    L.add(await keyedLedgerId(tx, 'INPUT_IGST'), -sign * n(note.igst))
  }
  L.add(await keyedLedgerId(tx, 'ROUND_OFF'), -sign * n(note.roundOff))
  const drift = L.difference()
  if (drift !== 0 && Math.abs(drift) <= 1) L.add(await keyedLedgerId(tx, 'ROUND_OFF'), -drift)
  return {
    kind: note.effect === 'REDUCES_PAYABLE' ? 'DEBIT_NOTE' : 'CREDIT_NOTE',
    voucherNo: note.noteNumber,
    date,
    narration: `${note.effect === 'REDUCES_PAYABLE' ? 'Claim on' : 'Further charge from'} ${note.supplier.name}${note.bill ? ` on bill ${supplierBillNo(note.bill)}` : ''}${note.supplierDocNo ? ` (their ${note.supplierDocNo})` : ''}`,
    cancelled: note.status === 'CANCELLED',
    cancelReason: note.closedReason,
    lines: await finishTags(tx, L.list()),
  }
}

/**
 * A month's shared expenses split between the brands, from its allocation
 * run: each brand's share debited, the whole credited back with no brand, on
 * the same ledger and department. The lines say exactly what they carry, so
 * no default brand or department is filled in.
 */
async function planAllocation(tx: Tx, id: string, reversal: boolean): Promise<Plan | null> {
  const j = await allocationJournal(tx, id, reversal)
  if (!j) return null
  return { kind: 'JOURNAL', voucherNo: j.voucherNo, date: j.date, narration: j.narration, cancelled: false, lines: j.lines.map((l) => ({ ...l, refs: [] })) }
}

const PLANNERS: Record<SourceType, (tx: Tx, id: string) => Promise<Plan | null>> = {
  SALES_INVOICE: planSalesInvoice,
  BROKERAGE: planBrokerage,
  SALES_RECEIPT: planReceipt,
  CREDIT_NOTE: planCreditNote,
  PURCHASE_BILL: planPurchaseBill,
  SUPPLIER_PAYMENT: planSupplierPayment,
  PURCHASE_NOTE: planPurchaseNote,
  EXPENSE_ALLOCATION: (tx, id) => planAllocation(tx, id, false),
  EXPENSE_ALLOCATION_REVERSAL: (tx, id) => planAllocation(tx, id, true),
}

// ═══════════════════════════════════════════
// WRITING THE VOUCHER
// ═══════════════════════════════════════════

const lockedError = (s: BooksSettings, what: string, day: string) =>
  new AppError(
    `The books are closed up to ${dayText(s.lockedUpTo!)}, so ${what} dated ${dayText(day)} cannot be saved, changed or cancelled. Ask Accounts to reopen the period if it must change.`,
    409,
    'PERIOD_LOCKED',
  )

/** What a voucher says in money, line by line, with its tags, to tell whether it changed. */
const moneyPrint = (lines: Array<{ ledgerId: string; amount: number; costCentreId: string | null; departmentId: string | null }>) =>
  lines
    .map((l) => `${l.ledgerId}|${l.costCentreId ?? ''}|${l.departmentId ?? ''}|${r2(l.amount).toFixed(2)}`)
    .sort()
    .join(';')

/** The bills it raises and settles as well. */
const billPrint = (lines: Array<{ ledgerId: string; refs: PlanRef[] }>) =>
  lines
    .flatMap((l) => l.refs.map((r) => `${l.ledgerId}|${r.kind}|${r.billNo}|${r.billDate}|${r.dueDate ?? ''}|${r2(r.amount).toFixed(2)}`))
    .sort()
    .join(';')

export type PostResult = 'created' | 'updated' | 'cancelled' | 'removed' | 'unchanged' | 'none'

async function applyPlan(tx: Tx, sourceType: SourceType, sourceId: string, plan: Plan | null, userId?: string | null): Promise<PostResult> {
  const s = await booksSettings(tx)
  const existing = await tx.voucher.findUnique({
    where: { sourceType_sourceId: { sourceType, sourceId } },
    include: { lines: { include: { billRefs: true } } },
  })
  const locked = (day: string) => !!s.lockedUpTo && day <= s.lockedUpTo
  const what = `${SOURCE_LABEL[sourceType].toLowerCase()} ${plan?.voucherNo ?? existing?.voucherNo ?? ''}`.trim()
  const oldDay = existing ? istDay(existing.date) : null

  // Not in the books: before they start, or nothing to post.
  if (!plan || !s.booksStart || plan.date < s.booksStart) {
    if (!existing) return 'none'
    if (existing.status === 'POSTED' && locked(oldDay!)) throw lockedError(s, what, oldDay!)
    await tx.voucher.delete({ where: { id: existing.id } })
    return 'removed'
  }

  if (plan.cancelled) {
    if (!existing || existing.status === 'CANCELLED') return existing ? 'unchanged' : 'none'
    if (locked(oldDay!)) throw lockedError(s, what, oldDay!)
    await tx.voucher.update({
      where: { id: existing.id },
      data: { status: 'CANCELLED', cancelledAt: new Date(), cancelledById: userId ?? null, cancelReason: plan.cancelReason ?? 'Cancelled with its document' },
    })
    return 'cancelled'
  }

  const amount = r2(plan.lines.filter((l) => l.amount > 0).reduce((t, l) => t + l.amount, 0))
  if (plan.lines.length < 2 || amount <= 0) return existing ? 'unchanged' : 'none'
  const diff = r2(plan.lines.reduce((t, l) => t + l.amount, 0))
  if (diff !== 0) throw new Error(`${what} does not balance: out by ${diff.toFixed(2)}`)

  const header = {
    kind: plan.kind,
    voucherNo: plan.voucherNo,
    date: dayValue(plan.date),
    financialYear: financialYearOf(dayValue(plan.date), s.fyStartMonth),
    narration: plan.narration,
    amount,
    mode: (plan.mode as Prisma.VoucherCreateInput['mode']) ?? null,
    referenceNo: plan.referenceNo ?? null,
    chequeNo: plan.chequeNo ?? null,
    chequeDate: plan.chequeDate ? dayValue(plan.chequeDate) : null,
  }

  if (existing) {
    const had = existing.lines.map((l) => ({
      ledgerId: l.ledgerId,
      amount: r2(Number(l.debit) - Number(l.credit)),
      costCentreId: l.costCentreId,
      departmentId: l.departmentId,
      refs: l.billRefs.map((r) => ({
        kind: r.kind,
        billNo: r.billNo,
        billDate: istDay(r.billDate),
        dueDate: r.dueDate ? istDay(r.dueDate) : null,
        amount: Number(r.amount),
      })),
    }))
    const sameMoney = existing.status === 'POSTED' && oldDay === plan.date && moneyPrint(had) === moneyPrint(plan.lines)
    // Which bills an amount settles may change in a closed period; the amounts may not.
    if (!sameMoney && (locked(oldDay!) || locked(plan.date))) throw lockedError(s, what, locked(oldDay!) ? oldDay! : plan.date)
    const sameHeader =
      existing.kind === header.kind &&
      existing.voucherNo === header.voucherNo &&
      existing.narration === header.narration &&
      existing.mode === header.mode &&
      existing.referenceNo === header.referenceNo &&
      existing.chequeNo === header.chequeNo &&
      (existing.chequeDate ? istDay(existing.chequeDate) : null) === (plan.chequeDate ?? null)
    if (sameMoney && sameHeader && billPrint(had) === billPrint(plan.lines)) return 'unchanged'
    await tx.voucher.update({
      where: { id: existing.id },
      data: { ...header, status: 'POSTED', cancelledAt: null, cancelledById: null, cancelReason: null, updatedById: userId ?? null },
    })
    const banked = await bankDatesOf(tx, existing.id)
    await tx.voucherLine.deleteMany({ where: { voucherId: existing.id } })
    await writeLines(tx, existing.id, plan, banked)
    return 'updated'
  }

  // A new document's number is given back when its save is refused, so it is not named.
  if (locked(plan.date)) throw lockedError(s, `this ${SOURCE_LABEL[sourceType].toLowerCase()}`, plan.date)
  const made = await tx.voucher.create({ data: { ...header, sourceType, sourceId, createdById: userId ?? null }, select: { id: true } })
  await writeLines(tx, made.id, plan)
  return 'created'
}

async function writeLines(tx: Tx, voucherId: string, plan: Plan, banked = new Map<string, Date>()) {
  // Debits first, then credits, as a voucher reads.
  const ordered = [...plan.lines].sort((a, b) => (b.amount > 0 ? 1 : 0) - (a.amount > 0 ? 1 : 0))
  for (const [i, l] of ordered.entries()) {
    await tx.voucherLine.create({
      data: {
        voucherId,
        ledgerId: l.ledgerId,
        debit: l.amount > 0 ? l.amount : 0,
        credit: l.amount < 0 ? -l.amount : 0,
        costCentreId: l.costCentreId,
        departmentId: l.departmentId,
        bankDate: banked.get(bankKey(l.ledgerId, l.amount)) ?? null,
        sortOrder: i,
        billRefs: {
          create: l.refs
            .filter((r) => r2(r.amount) !== 0)
            .map((r) => ({
              ledgerId: l.ledgerId,
              kind: r.kind,
              billNo: r.billNo,
              billDate: dayValue(r.billDate),
              dueDate: r.dueDate ? dayValue(r.dueDate) : null,
              amount: r2(r.amount),
            })),
        },
      },
    })
  }
  // The database's own balance check, run now so a refusal is not lost at commit.
  await checkBalancedNow(tx)
}

/**
 * Writes, rewrites or cancels a document's voucher to match the document as
 * it stands. An invoice brings its brokerage journal with it.
 */
export async function postDocument(tx: Tx, sourceType: SourceType, sourceId: string, userId?: string | null): Promise<PostResult> {
  const result = await applyPlan(tx, sourceType, sourceId, await PLANNERS[sourceType](tx, sourceId), userId)
  if (sourceType === 'SALES_INVOICE') await applyPlan(tx, 'BROKERAGE', sourceId, await planBrokerage(tx, sourceId), userId)
  return result
}

let savepoints = 0

/**
 * Posts a document from inside the save that changed it.
 *
 * A closed period stops the save: that is its job. Anything else that goes
 * wrong is rolled back to just before posting began and logged, and the
 * document saves without its voucher; Accounts then shows it as not yet in
 * the books, to be posted again once the fault is put right.
 */
export async function postWithin(tx: Tx, sourceType: SourceType, sourceId: string, userId?: string | null): Promise<void> {
  const name = `acc_post_${++savepoints}`
  await tx.$executeRawUnsafe(`SAVEPOINT ${name}`)
  try {
    await postDocument(tx, sourceType, sourceId, userId)
    await tx.$executeRawUnsafe(`RELEASE SAVEPOINT ${name}`)
  } catch (err) {
    if (err instanceof AppError && err.code === 'PERIOD_LOCKED') throw err
    await tx.$executeRawUnsafe(`ROLLBACK TO SAVEPOINT ${name}`)
    await tx.$executeRawUnsafe(`RELEASE SAVEPOINT ${name}`)
    logger.error(`Could not post ${sourceType} ${sourceId} to the books: ${(err as Error).message}`)
  }
}

// ═══════════════════════════════════════════
// BRINGING EVERY DOCUMENT INTO THE BOOKS
// ═══════════════════════════════════════════

interface Pending {
  sourceType: SourceType
  sourceId: string
  number: string
  date: string
  party: string
  amount: number
  /** Why it needs posting. */
  reason: 'missing' | 'cancel' | 'reopen' | 'before-start'
}

/**
 * Documents whose voucher does not match them: in the books' period with no
 * voucher, cancelled with their voucher still standing, live with it
 * cancelled, or posted before the day the books now start.
 */
export async function pendingDocuments(db: PrismaClient | Tx): Promise<{ booksStart: string | null; pending: Pending[] }> {
  const s = await booksSettings(db as Tx)
  if (!s.booksStart) return { booksStart: null, pending: [] }
  const from = dayValue(s.booksStart)
  const from0 = new Date(`${s.booksStart}T00:00:00+05:30`)
  const vouchers = await db.voucher.findMany({
    where: { sourceType: { not: null } },
    select: { sourceType: true, sourceId: true, status: true, date: true, voucherNo: true, amount: true },
  })
  const has = new Map(vouchers.map((v) => [`${v.sourceType}:${v.sourceId}`, v]))
  const pending: Pending[] = []
  const check = (sourceType: SourceType, d: { id: string; number: string; date: Date; party: string; amount: number; live: boolean }) => {
    const v = has.get(`${sourceType}:${d.id}`)
    const base = { sourceType, sourceId: d.id, number: d.number, date: istDay(d.date), party: d.party, amount: d.amount }
    if (d.live && !v) pending.push({ ...base, reason: 'missing' })
    else if (!d.live && v?.status === 'POSTED') pending.push({ ...base, reason: 'cancel' })
    else if (d.live && v?.status === 'CANCELLED') pending.push({ ...base, reason: 'reopen' })
  }

  const [invoices, receipts, notes, bills, payments, pnotes, runs] = await Promise.all([
    db.salesInvoice.findMany({ where: { invoiceDate: { gte: from0 } }, select: { id: true, invoiceNumber: true, invoiceDate: true, totalAmount: true, status: true, customer: { select: { name: true } } } }),
    db.paymentReceipt.findMany({ where: { receiptDate: { gte: from0 } }, select: { id: true, receiptNumber: true, receiptDate: true, amount: true, status: true, customer: { select: { name: true } } } }),
    db.creditNote.findMany({ where: { noteDate: { gte: from0 }, status: { in: ['ISSUED', 'CANCELLED'] } }, select: { id: true, noteNumber: true, noteDate: true, totalAmount: true, status: true, customer: { select: { name: true } } } }),
    db.purchaseInvoice.findMany({ where: { billDate: { gte: from0 } }, select: { id: true, billNumber: true, billDate: true, totalAmount: true, status: true, supplier: { select: { name: true } } } }),
    db.supplierPayment.findMany({ where: { paymentDate: { gte: from0 } }, select: { id: true, paymentNumber: true, paymentDate: true, amount: true, status: true, supplier: { select: { name: true } } } }),
    db.purchaseNote.findMany({
      where: { noteDate: { gte: from0 }, OR: [{ status: 'POSTED' }, { status: 'CANCELLED', postedAt: { not: null } }] },
      select: { id: true, noteNumber: true, noteDate: true, totalAmount: true, status: true, supplier: { select: { name: true } } },
    }),
    db.allocationRun.findMany({ where: { status: { in: ['POSTED', 'REVERSED'] } }, select: { id: true, runNumber: true, period: true, status: true, lines: { select: { amount: true } } } }),
  ])
  for (const d of invoices) check('SALES_INVOICE', { id: d.id, number: d.invoiceNumber, date: d.invoiceDate, party: d.customer.name, amount: n(d.totalAmount), live: d.status !== 'CANCELLED' })
  for (const d of receipts) check('SALES_RECEIPT', { id: d.id, number: d.receiptNumber, date: d.receiptDate, party: d.customer.name, amount: n(d.amount), live: d.status === 'POSTED' })
  for (const d of notes) check('CREDIT_NOTE', { id: d.id, number: d.noteNumber, date: d.noteDate, party: d.customer.name, amount: n(d.totalAmount), live: d.status === 'ISSUED' })
  for (const d of bills) check('PURCHASE_BILL', { id: d.id, number: d.billNumber, date: d.billDate, party: d.supplier.name, amount: n(d.totalAmount), live: d.status !== 'CANCELLED' })
  for (const d of payments) check('SUPPLIER_PAYMENT', { id: d.id, number: d.paymentNumber, date: d.paymentDate, party: d.supplier.name, amount: n(d.amount), live: d.status === 'POSTED' })
  for (const d of pnotes) check('PURCHASE_NOTE', { id: d.id, number: d.noteNumber, date: d.noteDate, party: d.supplier.name, amount: n(d.totalAmount), live: d.status === 'POSTED' })
  // A posted allocation run has its journal; a reversed one its reversal too.
  for (const r of runs) {
    const day = runDay(r.period)
    if (day < s.booksStart) continue
    const amount = r2(r.lines.reduce((t, l) => t + n(l.amount), 0))
    check('EXPENSE_ALLOCATION', { id: r.id, number: r.runNumber, date: dayValue(day), party: '', amount, live: true })
    check('EXPENSE_ALLOCATION_REVERSAL', { id: r.id, number: `${r.runNumber}-R`, date: dayValue(day), party: '', amount, live: r.status === 'REVERSED' })
  }

  // Vouchers of documents dated before the books now start.
  for (const v of vouchers) {
    if (v.date < from && v.sourceType !== 'BROKERAGE') {
      pending.push({ sourceType: v.sourceType as SourceType, sourceId: v.sourceId!, number: v.voucherNo, date: istDay(v.date), party: '', amount: Number(v.amount), reason: 'before-start' })
    }
  }
  pending.sort((a, b) => a.date.localeCompare(b.date) || a.number.localeCompare(b.number))
  return { booksStart: s.booksStart, pending }
}

/**
 * Posts every document that needs it, each in its own transaction, so one
 * that cannot post does not hold back the rest. With `all`, every document in
 * the books' period is posted again — for after a rule changes.
 */
export async function postPending(db: PrismaClient, userId: string | null, all = false) {
  const { pending } = await pendingDocuments(db)
  let work: Array<{ sourceType: SourceType; sourceId: string; number: string }> = pending
  if (all) {
    const s = await booksSettings(db as unknown as Tx)
    if (s.booksStart) {
      const from0 = new Date(`${s.booksStart}T00:00:00+05:30`)
      const [i, r, c, b, p, pn] = await Promise.all([
        db.salesInvoice.findMany({ where: { invoiceDate: { gte: from0 } }, select: { id: true, invoiceNumber: true } }),
        db.paymentReceipt.findMany({ where: { receiptDate: { gte: from0 } }, select: { id: true, receiptNumber: true } }),
        db.creditNote.findMany({ where: { noteDate: { gte: from0 } }, select: { id: true, noteNumber: true } }),
        db.purchaseInvoice.findMany({ where: { billDate: { gte: from0 } }, select: { id: true, billNumber: true } }),
        db.supplierPayment.findMany({ where: { paymentDate: { gte: from0 } }, select: { id: true, paymentNumber: true } }),
        db.purchaseNote.findMany({ where: { noteDate: { gte: from0 } }, select: { id: true, noteNumber: true } }),
      ])
      const seen = new Set(work.map((w) => `${w.sourceType}:${w.sourceId}`))
      const more = [
        ...i.map((d) => ({ sourceType: 'SALES_INVOICE' as const, sourceId: d.id, number: d.invoiceNumber })),
        ...r.map((d) => ({ sourceType: 'SALES_RECEIPT' as const, sourceId: d.id, number: d.receiptNumber })),
        ...c.map((d) => ({ sourceType: 'CREDIT_NOTE' as const, sourceId: d.id, number: d.noteNumber })),
        ...b.map((d) => ({ sourceType: 'PURCHASE_BILL' as const, sourceId: d.id, number: d.billNumber })),
        ...p.map((d) => ({ sourceType: 'SUPPLIER_PAYMENT' as const, sourceId: d.id, number: d.paymentNumber })),
        ...pn.map((d) => ({ sourceType: 'PURCHASE_NOTE' as const, sourceId: d.id, number: d.noteNumber })),
      ]
      work = [...work, ...more.filter((m) => !seen.has(`${m.sourceType}:${m.sourceId}`))]
    }
  }
  const results = { posted: 0, unchanged: 0, failed: [] as Array<{ sourceType: SourceType; number: string; reason: string }> }
  // Invoices before the receipts and notes that settle them, bills before payments.
  const ORDER: SourceType[] = ['SALES_INVOICE', 'PURCHASE_BILL', 'CREDIT_NOTE', 'PURCHASE_NOTE', 'SALES_RECEIPT', 'SUPPLIER_PAYMENT', 'BROKERAGE', 'EXPENSE_ALLOCATION', 'EXPENSE_ALLOCATION_REVERSAL']
  work.sort((a, b) => ORDER.indexOf(a.sourceType) - ORDER.indexOf(b.sourceType))
  for (const w of work) {
    try {
      const r = await db.$transaction((tx) => postDocument(tx, w.sourceType, w.sourceId, userId), { timeout: 30_000 })
      if (r === 'unchanged' || r === 'none') results.unchanged++
      else results.posted++
    } catch (err) {
      results.failed.push({ sourceType: w.sourceType, number: w.number, reason: (err as Error).message })
    }
  }
  return results
}

