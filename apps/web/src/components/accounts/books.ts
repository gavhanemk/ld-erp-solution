/**
 * What the Accounts screens share: the shapes the API sends, the voucher
 * types, and how a balance is written — "1,25,000.00 Dr".
 */

export type Nature = 'ASSET' | 'LIABILITY' | 'INCOME' | 'EXPENSE'
export type VoucherKind = 'PAYMENT' | 'RECEIPT' | 'CONTRA' | 'JOURNAL' | 'SALES' | 'PURCHASE' | 'CREDIT_NOTE' | 'DEBIT_NOTE'
export type ManualKind = 'PAYMENT' | 'RECEIPT' | 'CONTRA' | 'JOURNAL'
export type BillKind = 'NEW_REF' | 'AGAINST_REF' | 'ADVANCE' | 'ON_ACCOUNT'

export interface Ledger {
  id: string
  name: string
  groupId: string
  group: { id: string; name: string; nature: Nature; systemKey: string | null }
  nature: Nature
  openingBalance: number
  billWise: boolean
  systemKey: string | null
  partyType: 'CUSTOMER' | 'SUPPLIER' | 'BROKER' | 'CONTRACTOR' | 'BANK' | null
  partyLabel: string | null
  partyCode: string | null
  isMoney: boolean
  pan: string | null
  gstin: string | null
  notes: string | null
  isActive: boolean
  balance?: number
}

export interface Group {
  id: string
  name: string
  parentId: string | null
  nature: Nature
  affectsGrossProfit: boolean
  systemKey: string | null
  sortOrder: number
  _count: { ledgers: number; children: number }
}

export interface CostCentre {
  id: string
  name: string
  isActive: boolean
  brand: { id: string; name: string } | null
}

export interface BooksSummary {
  booksStart: string | null
  lockedUpTo: string | null
  fyStartMonth: number
  today: string
  fyStart: string
  counts: { ledgers: number; groups: number; vouchers: number; costCentres: number }
}

export interface OpenBill {
  billNo: string
  billDate: string
  dueDate: string | null
  /** Signed: what is owed to us is positive. */
  pending: number
  raised: boolean
  /** A customer's invoice or a supplier's bill: settled only from Sales or Purchase. */
  fromDocument?: boolean
}

/** The Sales and Purchase documents that post to the books, as Accounts names them. */
export const SOURCE_LABEL: Record<string, string> = {
  SALES_INVOICE: 'Sales invoice',
  BROKERAGE: 'Brokerage on invoice',
  SALES_RECEIPT: 'Payment received',
  CREDIT_NOTE: 'Credit note',
  PURCHASE_BILL: 'Purchase bill',
  SUPPLIER_PAYMENT: 'Supplier payment',
  PURCHASE_NOTE: 'Purchase note',
}

/** Where a document that wrote a voucher is opened. */
export function sourceLink(sourceType: string, number: string): string {
  const q = encodeURIComponent(number)
  switch (sourceType) {
    case 'SALES_INVOICE':
    case 'BROKERAGE':
      return `/sales/invoices?q=${q}`
    case 'SALES_RECEIPT':
      return `/sales/payments?tab=receipts&q=${q}`
    case 'CREDIT_NOTE':
      return '/sales/returns'
    case 'PURCHASE_BILL':
      return `/purchase/bills?q=${q}`
    case 'SUPPLIER_PAYMENT':
      return '/purchase/payments'
    default:
      return '/purchase/debit-notes'
  }
}

/** The four typed here, in the order Tally's keys put them, with the key each answers to. */
export const MANUAL_KINDS: Array<{ kind: ManualKind; label: string; key: string; hint: string }> = [
  { kind: 'CONTRA', label: 'Contra', key: 'F4', hint: 'Cash to bank, bank to cash, bank to bank' },
  { kind: 'PAYMENT', label: 'Payment', key: 'F5', hint: 'Money out of cash or a bank' },
  { kind: 'RECEIPT', label: 'Receipt', key: 'F6', hint: 'Money into cash or a bank' },
  { kind: 'JOURNAL', label: 'Journal', key: 'F7', hint: 'Adjustments, with no cash or bank' },
]

export const KIND_LABEL: Record<VoucherKind, string> = {
  PAYMENT: 'Payment',
  RECEIPT: 'Receipt',
  CONTRA: 'Contra',
  JOURNAL: 'Journal',
  SALES: 'Sales',
  PURCHASE: 'Purchase',
  CREDIT_NOTE: 'Credit Note',
  DEBIT_NOTE: 'Debit Note',
}

/** The badge each voucher type wears in a list. */
export const KIND_BADGE: Record<VoucherKind, string> = {
  PAYMENT: 'badge-warning',
  RECEIPT: 'badge-success',
  CONTRA: 'badge-neutral',
  JOURNAL: 'badge-info',
  SALES: 'badge-success',
  PURCHASE: 'badge-warning',
  CREDIT_NOTE: 'badge-purple',
  DEBIT_NOTE: 'badge-purple',
}

export const BILL_KIND_LABEL: Record<BillKind, string> = {
  NEW_REF: 'New bill',
  AGAINST_REF: 'Against bill',
  ADVANCE: 'Advance',
  ON_ACCOUNT: 'On account',
}

export const NATURE_LABEL: Record<Nature, string> = {
  ASSET: 'Asset',
  LIABILITY: 'Liability',
  INCOME: 'Income',
  EXPENSE: 'Expense',
}

export const r2 = (n: number) => Math.round(n * 100) / 100

/** 125000 → "1,25,000.00". */
export const inr = (n: number) => Math.abs(n).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

/** A signed balance as an accountant writes it: "1,25,000.00 Dr", "0.00". */
export function drCr(n: number): string {
  const v = r2(n)
  if (v === 0) return '0.00'
  return `${inr(v)} ${v > 0 ? 'Dr' : 'Cr'}`
}

/** An amount, or nothing — for debit and credit columns where an empty cell reads better than 0.00. */
export const amountOrBlank = (n: number) => (r2(n) === 0 ? '' : inr(n))

/** Today in India, as YYYY-MM-DD. */
export const todayIst = () => new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10)

/** "2026-11-02" → "02 Nov 2026". */
export function day(ymd: string | null | undefined): string {
  if (!ymd) return '—'
  const d = new Date(`${ymd.slice(0, 10)}T00:00:00Z`)
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' })
}

/** The first day of the financial year a day falls in. */
export function fyStartOf(ymd: string, startMonth = 4): string {
  const y = Number(ymd.slice(0, 4))
  const m = Number(ymd.slice(5, 7))
  return `${m >= startMonth ? y : y - 1}-${String(startMonth).padStart(2, '0')}-01`
}

/** Where a report opens: the day the books start, once it has come and falls in this year; otherwise the year's first day. */
export function reportStart(s: BooksSummary): string {
  return s.booksStart && s.booksStart > s.fyStart && s.booksStart <= s.today ? s.booksStart : s.fyStart
}
