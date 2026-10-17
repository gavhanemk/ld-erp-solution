/**
 * "1 bills" becomes "1 bill".
 *
 * Report sentences are written as `${n} bills` in dozens of places, and when n
 * is 1 the plural reads wrong — "₹62,223 billed across 1 bills from 1
 * suppliers". Fixed once here, over every string of a report's analysis,
 * before it reaches the screen or the workbook, so a new report cannot bring
 * the slip back. Only the words the reports count are touched, and only after
 * a lone 1 — never 21, 0.1 or 1,200.
 */
const SINGULAR: Record<string, string> = {
  bills: 'bill',
  bundles: 'bundle',
  boxes: 'box',
  cartons: 'carton',
  categories: 'category',
  challans: 'challan',
  colours: 'colour',
  contractors: 'contractor',
  customers: 'customer',
  days: 'day',
  deliveries: 'delivery',
  documents: 'document',
  enquiries: 'enquiry',
  entries: 'entry',
  groups: 'group',
  indents: 'indent',
  invoices: 'invoice',
  items: 'item',
  jobs: 'job',
  lines: 'line',
  months: 'month',
  movements: 'movement',
  notes: 'note',
  orders: 'order',
  payments: 'payment',
  pieces: 'piece',
  quotations: 'quotation',
  receipts: 'receipt',
  requisitions: 'requisition',
  returns: 'return',
  rolls: 'roll',
  rows: 'row',
  sheets: 'sheet',
  sizes: 'size',
  stores: 'store',
  styles: 'style',
  suppliers: 'supplier',
  transfers: 'transfer',
  units: 'unit',
  weeks: 'week',
  workers: 'worker',
  DCs: 'DC',
  GRNs: 'GRN',
  MOs: 'MO',
  MRs: 'MR',
  POs: 'PO',
  SOs: 'SO',
}

const ONE = new RegExp(`(^|[^\\d.,₹])1 (${Object.keys(SINGULAR).join('|')})\\b`, 'g')

export const oneNotMany = (s: string) => s.replace(ONE, (_m, before: string, noun: string) => `${before}1 ${SINGULAR[noun]}`)

/** Every string in a report's analysis, read through `oneNotMany`; numbers, dates and the rest untouched. */
export function countsInWords<T>(v: T): T {
  if (typeof v === 'string') return oneNotMany(v) as T
  if (Array.isArray(v)) return v.map((x) => countsInWords(x)) as T
  if (v && typeof v === 'object' && Object.getPrototypeOf(v) === Object.prototype) {
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, countsInWords(x)])) as T
  }
  return v
}
