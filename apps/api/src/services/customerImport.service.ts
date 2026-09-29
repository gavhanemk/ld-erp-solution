import ExcelJS from 'exceljs'
import { prisma } from '@ld-erp/database'
import { AppError } from '../middleware/errorHandler'
import { addDropdowns, addHowToSheet, addTemplateSheet, readSheetRows, type SheetColumn } from '../lib/sheet'
import { GST_STATES } from '../lib/gstStates'
import { createCustomerSchema } from '../schemas/master.schemas'

/**
 * Customers from a spreadsheet, and the same sheet as the export: checked
 * first and shown row by row, then all or nothing.
 *
 * A row is one customer. One already in the system (the same name, ignoring
 * capitals and spaces) is left as it is and the row skipped, so an exported
 * list can be topped up with new rows and brought back in. Every row goes
 * through the same checks as the form, GSTIN against state code and PAN
 * included, and a new one gets its CUS- code when it is saved.
 */

export const MAX_ROWS = 2000

export type CustomerKey =
  | 'code'
  | 'name'
  | 'type'
  | 'gstin'
  | 'billingStateCode'
  | 'pan'
  | 'phone'
  | 'email'
  | 'billingAddress'
  | 'billingCity'
  | 'billingState'
  | 'billingPincode'
  | 'shippingAddress'
  | 'shippingStateCode'
  | 'creditLimit'
  | 'creditDays'
  | 'paymentTerms'
  | 'bankName'
  | 'bankAccount'
  | 'bankIFSC'
  | 'isBlacklisted'
  | 'notes'
type Raw = Partial<Record<CustomerKey, string>>

export const CUSTOMER_COLUMNS: SheetColumn<CustomerKey>[] = [
  { key: 'code', head: 'Customer Code', width: 12, note: 'Leave empty for a new customer: the code is given when it is saved.' },
  { key: 'name', head: 'Customer Name *', width: 30 },
  { key: 'type', head: 'Type *', width: 16, list: 'types' },
  { key: 'gstin', head: 'GSTIN', width: 18, note: '15 characters. Empty if unregistered.' },
  { key: 'billingStateCode', head: 'GST State Code', width: 10, note: 'Two digits. Empty: taken from the GSTIN, or from State.' },
  { key: 'pan', head: 'PAN', width: 12, note: 'Empty: taken from the GSTIN.' },
  { key: 'phone', head: 'Phone', width: 16 },
  { key: 'email', head: 'Email', width: 26 },
  { key: 'billingAddress', head: 'Billing Address', width: 34 },
  { key: 'billingCity', head: 'City', width: 14 },
  { key: 'billingState', head: 'State', width: 18, list: 'states' },
  { key: 'billingPincode', head: 'PIN Code', width: 10 },
  { key: 'shippingAddress', head: 'Shipping Address', width: 34 },
  { key: 'shippingStateCode', head: 'Delivery State Code', width: 10, note: 'Only if goods go to a different state.' },
  { key: 'creditLimit', head: 'Credit Limit', width: 12, note: 'In rupees.' },
  { key: 'creditDays', head: 'Credit Days', width: 10, note: 'Empty: 30.' },
  { key: 'paymentTerms', head: 'Payment Terms', width: 22 },
  { key: 'bankName', head: 'Bank Name', width: 18 },
  { key: 'bankAccount', head: 'Account Number', width: 18 },
  { key: 'bankIFSC', head: 'IFSC Code', width: 13 },
  { key: 'isBlacklisted', head: 'Blacklisted', width: 10, list: 'yesNo' },
  { key: 'notes', head: 'Notes', width: 30 },
]

export const CUSTOMER_TYPE_LABEL = {
  DOMESTIC: 'Domestic',
  EXPORT: 'Export',
  JOB_WORK: 'Job Work',
  VHAGAR_DEALER: 'VHAGAR Dealer',
} as const
type CustomerType = keyof typeof CUSTOMER_TYPE_LABEL
const TYPES = new Map<string, CustomerType>(
  Object.entries(CUSTOMER_TYPE_LABEL).flatMap(([k, label]) => [
    [label.toLowerCase(), k as CustomerType],
    [k.toLowerCase(), k as CustomerType],
  ]),
)

const low = (s?: string | null) => (s ?? '').trim().toLowerCase()
/** A name as the duplicate check sees it: no capitals, no spaces. */
const nameKey = (s?: string | null) => low(s).replace(/\s+/g, '')
const STATE_CODE = new Map(Object.entries(GST_STATES).map(([code, name]) => [low(name), code]))

/** A customer as a sheet row, the same columns the import reads. */
export function customerRow(c: Record<string, unknown>): Record<CustomerKey, string | number> {
  const text = (v: unknown) => (v === null || v === undefined ? '' : String(v))
  return {
    code: text(c.code),
    name: text(c.name),
    type: CUSTOMER_TYPE_LABEL[c.type as CustomerType] ?? text(c.type),
    gstin: text(c.gstin),
    billingStateCode: text(c.billingStateCode),
    pan: text(c.pan),
    phone: text(c.phone),
    email: text(c.email),
    billingAddress: text(c.billingAddress),
    billingCity: text(c.billingCity),
    billingState: text(c.billingState),
    billingPincode: text(c.billingPincode),
    shippingAddress: text(c.shippingAddress),
    shippingStateCode: text(c.shippingStateCode),
    creditLimit: c.creditLimit === null || c.creditLimit === undefined ? '' : Number(c.creditLimit),
    creditDays: typeof c.creditDays === 'number' ? c.creditDays : '',
    paymentTerms: text(c.paymentTerms),
    bankName: text(c.bankName),
    bankAccount: text(c.bankAccount),
    bankIFSC: text(c.bankIFSC),
    isBlacklisted: c.isBlacklisted ? 'Yes' : 'No',
    notes: text(c.notes),
  }
}

/**
 * A workbook of customers in the import's columns: the template (with or
 * without the customers already there) and the export are the same sheet.
 */
export async function customerWorkbook(rows: Array<Record<string, unknown>>, withHelp: boolean): Promise<Buffer> {
  const wb = new ExcelJS.Workbook()
  wb.creator = 'LD ERP'
  const sheet = addTemplateSheet(wb, 'Customers', CUSTOMER_COLUMNS)
  for (const c of rows) sheet.addRow(customerRow(c))
  if (withHelp) {
    addDropdowns(
      wb,
      sheet,
      CUSTOMER_COLUMNS,
      {
        types: Object.values(CUSTOMER_TYPE_LABEL),
        states: Object.values(GST_STATES).filter((v, i, a) => a.indexOf(v) === i).sort(),
        yesNo: ['No', 'Yes'],
      },
      MAX_ROWS,
    )
    addHowToSheet(wb, [
      'One row per customer. Required: Customer Name and Type.',
      'GSTIN, GST State Code and PAN must agree. Give the GSTIN and the other two are filled in from it; with no GSTIN, pick the State and its code is used.',
      'A customer already in the system (the same name, ignoring capitals and spaces) is left as it is and the row is skipped. Change a customer on its own form.',
      'A new customer gets its code (CUS-…) when it is saved. Leave Customer Code empty.',
      'Credit Days empty means 30. Blacklisted is Yes or No.',
      'Nothing is saved until you have seen what each row will do and pressed Import. If any row has a problem, nothing is imported.',
    ])
  }
  return Buffer.from(await wb.xlsx.writeBuffer())
}

export async function buildTemplate(withCurrent: boolean): Promise<Buffer> {
  const rows = withCurrent
    ? await prisma.customer.findMany({ where: { isActive: true }, orderBy: { name: 'asc' } })
    : []
  return customerWorkbook(rows as unknown as Array<Record<string, unknown>>, true)
}

export function readSheet(file: Buffer, fileName: string) {
  return readSheetRows(file, fileName, {
    columns: CUSTOMER_COLUMNS,
    sheetName: 'Customers',
    mustHave: 'name',
    mustHaveLabel: 'Customer Name',
    maxRows: MAX_ROWS,
  })
}

export interface CustomerRowPlan {
  row: number
  name: string
  code: string | null
  customer: 'new' | 'existing' | 'none'
  place: string | null
  skipped: boolean
  problems: string[]
}

interface Resolved {
  plan: CustomerRowPlan
  create?: Record<string, unknown>
}

/** Checks every row against the customers and against each other. Writes nothing. */
export async function planImport(rows: Array<{ row: number; raw: Raw }>): Promise<Resolved[]> {
  const existing = await prisma.customer.findMany({ select: { code: true, name: true, gstin: true } })
  const byName = new Map(existing.map((c) => [nameKey(c.name), c]))
  const byGstin = new Map(existing.filter((c) => c.gstin).map((c) => [low(c.gstin), c]))
  const seenName = new Map<string, number>()
  const seenGstin = new Map<string, number>()
  const out: Resolved[] = []

  for (const { row, raw } of rows) {
    const problems: string[] = []
    const name = (raw.name ?? '').trim()
    const plan: CustomerRowPlan = {
      row,
      name,
      code: null,
      customer: 'none',
      place: [raw.billingCity, raw.billingState].filter(Boolean).join(', ') || null,
      skipped: false,
      problems,
    }
    const res: Resolved = { plan }
    out.push(res)

    if (!name) {
      problems.push('Customer Name is empty.')
      continue
    }
    const already = byName.get(nameKey(name))
    if (already) {
      plan.customer = 'existing'
      plan.code = already.code
      plan.skipped = true
      continue
    }
    const earlier = seenName.get(nameKey(name))
    if (earlier) {
      problems.push(`Row ${earlier} has the same customer.`)
      continue
    }
    seenName.set(nameKey(name), row)
    plan.customer = 'new'

    if (raw.code) problems.push(`No customer has the code ${raw.code}. Leave Customer Code empty for a new one.`)

    const type = TYPES.get(low(raw.type))
    if (!raw.type) problems.push('Type is empty.')
    else if (!type) problems.push(`No type "${raw.type}". Pick Domestic, Export, Job Work or VHAGAR Dealer.`)

    const gstin = raw.gstin?.trim().toUpperCase() || null
    if (gstin) {
      const holder = byGstin.get(low(gstin))
      if (holder) problems.push(`GSTIN ${gstin} is already on ${holder.name} (${holder.code}).`)
      const twice = seenGstin.get(low(gstin))
      if (twice) problems.push(`Row ${twice} has the same GSTIN.`)
      seenGstin.set(low(gstin), row)
    }

    // A state named without its code: the code is what decides the tax.
    let stateCode = raw.billingStateCode?.trim() || null
    if (stateCode && /^\d$/.test(stateCode)) stateCode = `0${stateCode}`
    if (!stateCode && !gstin && raw.billingState) {
      stateCode = STATE_CODE.get(low(raw.billingState)) ?? null
      if (!stateCode) problems.push(`No GST state "${raw.billingState}". Pick it from the list.`)
    }
    let shippingStateCode = raw.shippingStateCode?.trim() || null
    if (shippingStateCode && /^\d$/.test(shippingStateCode)) shippingStateCode = `0${shippingStateCode}`

    const number = (label: string, v?: string) => {
      if (!v) return undefined
      const n = Number(v.replace(/[,₹\s]/g, ''))
      if (!Number.isFinite(n)) {
        problems.push(`${label} "${v}" is not a number.`)
        return undefined
      }
      return n
    }
    const creditLimit = number('Credit Limit', raw.creditLimit)
    const creditDays = number('Credit Days', raw.creditDays)
    const blacklisted = low(raw.isBlacklisted)
    if (blacklisted && !['yes', 'no', 'y', 'n', 'true', 'false'].includes(blacklisted)) {
      problems.push(`Blacklisted is Yes or No, not "${raw.isBlacklisted}".`)
    }
    if (problems.length) continue

    const text = (v?: string) => v?.trim() || null
    const checked = createCustomerSchema.safeParse({
      name,
      type,
      gstin,
      billingStateCode: stateCode,
      pan: text(raw.pan)?.toUpperCase() ?? null,
      phone: text(raw.phone),
      email: text(raw.email),
      billingAddress: text(raw.billingAddress),
      billingCity: text(raw.billingCity),
      billingState: text(raw.billingState),
      billingPincode: text(raw.billingPincode),
      shippingAddress: text(raw.shippingAddress),
      shippingStateCode,
      creditLimit: creditLimit ?? null,
      ...(creditDays !== undefined ? { creditDays } : {}),
      paymentTerms: text(raw.paymentTerms),
      bankName: text(raw.bankName),
      bankAccount: text(raw.bankAccount),
      bankIFSC: text(raw.bankIFSC)?.toUpperCase() ?? null,
      isBlacklisted: ['yes', 'y', 'true'].includes(blacklisted),
      notes: text(raw.notes),
    })
    if (!checked.success) problems.push(...checked.error.issues.map((i) => i.message))
    else res.create = checked.data as Record<string, unknown>
  }
  return out
}

/** Makes the new customers, numbered on from the highest CUS- code, in one transaction. */
export async function runImport(plans: Resolved[]) {
  if (plans.some((p) => p.plan.problems.length > 0)) {
    throw new AppError('Some rows have problems. Fix them and upload the sheet again.', 400, 'IMPORT_HAS_PROBLEMS')
  }
  return prisma.$transaction(
    async (tx) => {
      const codes = await tx.customer.findMany({ where: { code: { startsWith: 'CUS-' } }, select: { code: true } })
      let next = codes.reduce((max, c) => {
        const n = Number.parseInt(c.code.slice(c.code.lastIndexOf('-') + 1), 10)
        return Number.isFinite(n) && n > max ? n : max
      }, 0)
      const created: Array<{ code: string; name: string }> = []
      for (const p of plans) {
        if (!p.create) continue
        next += 1
        const c = await tx.customer.create({
          data: { ...(p.create as object), code: `CUS-${String(next).padStart(3, '0')}` } as Parameters<
            typeof tx.customer.create
          >[0]['data'],
          select: { code: true, name: true },
        })
        created.push(c)
      }
      return created
    },
    { timeout: 300_000, maxWait: 20_000 },
  )
}
