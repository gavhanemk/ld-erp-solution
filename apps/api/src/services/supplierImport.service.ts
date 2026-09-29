import ExcelJS from 'exceljs'
import { prisma } from '@ld-erp/database'
import { AppError } from '../middleware/errorHandler'
import { addDropdowns, addHowToSheet, addTemplateSheet, readSheetRows, type SheetColumn } from '../lib/sheet'
import { GST_STATES } from '../lib/gstStates'
import { createSupplierSchema } from '../schemas/master.schemas'

/**
 * Suppliers from a spreadsheet, and the same sheet as the export, exactly as
 * customers are: checked first and shown row by row, then all or nothing.
 *
 * A supplier already in the system (the same name, ignoring capitals and
 * spaces) is left as it is and the row skipped. Every row goes through the
 * form's own checks, GSTIN against state code and PAN included, and a new
 * one is numbered on from the highest SUP- code, as the form numbers it.
 */

export const MAX_ROWS = 2000

export type SupplierKey =
  | 'code'
  | 'name'
  | 'category'
  | 'gstin'
  | 'stateCode'
  | 'pan'
  | 'phone'
  | 'email'
  | 'address'
  | 'city'
  | 'state'
  | 'pincode'
  | 'leadTimeDays'
  | 'creditDays'
  | 'paymentTerms'
  | 'bankName'
  | 'bankAccount'
  | 'bankIFSC'
  | 'isMsme'
  | 'msmeNumber'
  | 'rating'
  | 'isPreferred'
  | 'notes'
type Raw = Partial<Record<SupplierKey, string>>

export const SUPPLIER_COLUMNS: SheetColumn<SupplierKey>[] = [
  { key: 'code', head: 'Supplier Code', width: 13, note: 'Leave empty for a new supplier: the code is given when it is saved.' },
  { key: 'name', head: 'Supplier Name *', width: 30 },
  { key: 'category', head: 'Category *', width: 13, list: 'categories' },
  { key: 'gstin', head: 'GSTIN', width: 18, note: '15 characters. Empty if unregistered: the order then carries no GST.' },
  { key: 'stateCode', head: 'GST State Code', width: 10, note: 'Two digits. Empty: taken from the GSTIN, or from State.' },
  { key: 'pan', head: 'PAN', width: 12, note: 'Empty: taken from the GSTIN.' },
  { key: 'phone', head: 'Phone', width: 16 },
  { key: 'email', head: 'Email', width: 26 },
  { key: 'address', head: 'Address', width: 34 },
  { key: 'city', head: 'City', width: 14 },
  { key: 'state', head: 'State', width: 18, list: 'states' },
  { key: 'pincode', head: 'PIN Code', width: 10 },
  { key: 'leadTimeDays', head: 'Lead Time (days)', width: 10, note: 'Typical days from order to delivery. Empty: 7.' },
  { key: 'creditDays', head: 'Credit Days', width: 10, note: 'Empty: 30.' },
  { key: 'paymentTerms', head: 'Payment Terms', width: 22 },
  { key: 'bankName', head: 'Bank Name', width: 18 },
  { key: 'bankAccount', head: 'Account Number', width: 18 },
  { key: 'bankIFSC', head: 'IFSC Code', width: 13 },
  { key: 'isMsme', head: 'MSME', width: 8, list: 'yesNo', note: 'Registered under MSME/Udyam: payment is due within 45 days by law.' },
  { key: 'msmeNumber', head: 'Udyam Number', width: 22 },
  { key: 'rating', head: 'Rating', width: 8, list: 'ratings', note: '1 to 5.' },
  { key: 'isPreferred', head: 'Preferred', width: 10, list: 'yesNo' },
  { key: 'notes', head: 'Notes', width: 30 },
]

export const SUPPLIER_CATEGORY_LABEL = {
  FABRIC: 'Fabric',
  THREAD: 'Thread',
  BUTTON: 'Button',
  LINING: 'Lining',
  LABEL: 'Label',
  PACKAGING: 'Packaging',
  TRIM: 'Trim',
  TRANSPORT: 'Transport',
  SERVICE: 'Service',
  OTHER: 'Other',
} as const
type SupplierCategory = keyof typeof SUPPLIER_CATEGORY_LABEL
const CATEGORIES = new Map<string, SupplierCategory>(
  Object.keys(SUPPLIER_CATEGORY_LABEL).map((k) => [k.toLowerCase(), k as SupplierCategory]),
)

const low = (s?: string | null) => (s ?? '').trim().toLowerCase()
/** A name as the duplicate check sees it: no capitals, no spaces. */
const nameKey = (s?: string | null) => low(s).replace(/\s+/g, '')
const STATE_CODE = new Map(Object.entries(GST_STATES).map(([code, name]) => [low(name), code]))
const YES = ['yes', 'y', 'true']
const NO = ['no', 'n', 'false']

/** A supplier as a sheet row, the same columns the import reads. */
export function supplierRow(s: Record<string, unknown>): Record<SupplierKey, string | number> {
  const text = (v: unknown) => (v === null || v === undefined ? '' : String(v))
  return {
    code: text(s.code),
    name: text(s.name),
    category: SUPPLIER_CATEGORY_LABEL[s.category as SupplierCategory] ?? text(s.category),
    gstin: text(s.gstin),
    stateCode: text(s.stateCode),
    pan: text(s.pan),
    phone: text(s.phone),
    email: text(s.email),
    address: text(s.address),
    city: text(s.city),
    state: text(s.state),
    pincode: text(s.pincode),
    leadTimeDays: typeof s.leadTimeDays === 'number' ? s.leadTimeDays : '',
    creditDays: typeof s.creditDays === 'number' ? s.creditDays : '',
    paymentTerms: text(s.paymentTerms),
    bankName: text(s.bankName),
    bankAccount: text(s.bankAccount),
    bankIFSC: text(s.bankIFSC),
    isMsme: s.isMsme ? 'Yes' : 'No',
    msmeNumber: text(s.msmeNumber),
    rating: typeof s.rating === 'number' ? s.rating : '',
    isPreferred: s.isPreferred ? 'Yes' : 'No',
    notes: text(s.notes),
  }
}

/** A workbook of suppliers in the import's columns: template and export alike. */
export async function supplierWorkbook(rows: Array<Record<string, unknown>>, withHelp: boolean): Promise<Buffer> {
  const wb = new ExcelJS.Workbook()
  wb.creator = 'LD ERP'
  const sheet = addTemplateSheet(wb, 'Suppliers', SUPPLIER_COLUMNS)
  for (const s of rows) sheet.addRow(supplierRow(s))
  if (withHelp) {
    addDropdowns(
      wb,
      sheet,
      SUPPLIER_COLUMNS,
      {
        categories: Object.values(SUPPLIER_CATEGORY_LABEL),
        states: [...new Set(Object.values(GST_STATES))].sort(),
        yesNo: ['No', 'Yes'],
        ratings: ['1', '2', '3', '4', '5'],
      },
      MAX_ROWS,
    )
    addHowToSheet(wb, [
      'One row per supplier. Required: Supplier Name and Category.',
      'GSTIN, GST State Code and PAN must agree. Give the GSTIN and the other two are filled in from it; with no GSTIN, pick the State and its code is used.',
      'A supplier already in the system (the same name, ignoring capitals and spaces) is left as it is and the row is skipped. Change a supplier on its own form.',
      'A new supplier gets its code (SUP-…) when it is saved. Leave Supplier Code empty.',
      'Lead Time empty means 7 days, Credit Days empty means 30. MSME and Preferred are Yes or No; Rating is 1 to 5.',
      'Nothing is saved until you have seen what each row will do and pressed Import. If any row has a problem, nothing is imported.',
    ])
  }
  return Buffer.from(await wb.xlsx.writeBuffer())
}

export async function buildTemplate(withCurrent: boolean): Promise<Buffer> {
  const rows = withCurrent
    ? await prisma.supplier.findMany({ where: { isActive: true }, orderBy: { name: 'asc' } })
    : []
  return supplierWorkbook(rows as unknown as Array<Record<string, unknown>>, true)
}

export function readSheet(file: Buffer, fileName: string) {
  return readSheetRows(file, fileName, {
    columns: SUPPLIER_COLUMNS,
    sheetName: 'Suppliers',
    mustHave: 'name',
    mustHaveLabel: 'Supplier Name',
    maxRows: MAX_ROWS,
  })
}

export interface SupplierRowPlan {
  row: number
  name: string
  code: string | null
  supplier: 'new' | 'existing' | 'none'
  place: string | null
  skipped: boolean
  problems: string[]
}

interface Resolved {
  plan: SupplierRowPlan
  create?: Record<string, unknown>
}

/** Checks every row against the suppliers and against each other. Writes nothing. */
export async function planImport(rows: Array<{ row: number; raw: Raw }>): Promise<Resolved[]> {
  const existing = await prisma.supplier.findMany({ select: { code: true, name: true, gstin: true } })
  const byName = new Map(existing.map((s) => [nameKey(s.name), s]))
  const byGstin = new Map(existing.filter((s) => s.gstin).map((s) => [low(s.gstin), s]))
  const seenName = new Map<string, number>()
  const seenGstin = new Map<string, number>()
  const out: Resolved[] = []

  for (const { row, raw } of rows) {
    const problems: string[] = []
    const name = (raw.name ?? '').trim()
    const plan: SupplierRowPlan = {
      row,
      name,
      code: null,
      supplier: 'none',
      place: [raw.city, raw.state].filter(Boolean).join(', ') || null,
      skipped: false,
      problems,
    }
    const res: Resolved = { plan }
    out.push(res)

    if (!name) {
      problems.push('Supplier Name is empty.')
      continue
    }
    const already = byName.get(nameKey(name))
    if (already) {
      plan.supplier = 'existing'
      plan.code = already.code
      plan.skipped = true
      continue
    }
    const earlier = seenName.get(nameKey(name))
    if (earlier) {
      problems.push(`Row ${earlier} has the same supplier.`)
      continue
    }
    seenName.set(nameKey(name), row)
    plan.supplier = 'new'

    if (raw.code) problems.push(`No supplier has the code ${raw.code}. Leave Supplier Code empty for a new one.`)

    const category = CATEGORIES.get(low(raw.category))
    if (!raw.category) problems.push('Category is empty.')
    else if (!category) {
      problems.push(`No category "${raw.category}". Pick one of: ${Object.values(SUPPLIER_CATEGORY_LABEL).join(', ')}.`)
    }

    const gstin = raw.gstin?.trim().toUpperCase() || null
    if (gstin) {
      const holder = byGstin.get(low(gstin))
      if (holder) problems.push(`GSTIN ${gstin} is already on ${holder.name} (${holder.code}).`)
      const twice = seenGstin.get(low(gstin))
      if (twice) problems.push(`Row ${twice} has the same GSTIN.`)
      seenGstin.set(low(gstin), row)
    }

    // A state named without its code: the code is what decides the tax.
    let stateCode = raw.stateCode?.trim() || null
    if (stateCode && /^\d$/.test(stateCode)) stateCode = `0${stateCode}`
    if (!stateCode && !gstin && raw.state) {
      stateCode = STATE_CODE.get(low(raw.state)) ?? null
      if (!stateCode) problems.push(`No GST state "${raw.state}". Pick it from the list.`)
    }

    const number = (label: string, v?: string) => {
      if (!v) return undefined
      const n = Number(v.replace(/[,\s]/g, ''))
      if (!Number.isFinite(n)) {
        problems.push(`${label} "${v}" is not a number.`)
        return undefined
      }
      return n
    }
    const leadTimeDays = number('Lead Time', raw.leadTimeDays)
    const creditDays = number('Credit Days', raw.creditDays)
    const rating = number('Rating', raw.rating)
    if (rating !== undefined && !(Number.isInteger(rating) && rating >= 1 && rating <= 5)) {
      problems.push(`Rating is 1 to 5, not ${raw.rating}.`)
    }
    const flag = (label: string, v?: string) => {
      const x = low(v)
      if (!x) return false
      if (YES.includes(x)) return true
      if (!NO.includes(x)) problems.push(`${label} is Yes or No, not "${v}".`)
      return false
    }
    const isMsme = flag('MSME', raw.isMsme)
    const isPreferred = flag('Preferred', raw.isPreferred)
    if (raw.msmeNumber && !isMsme) problems.push('An Udyam Number is given but MSME is not Yes.')
    if (problems.length) continue

    const text = (v?: string) => v?.trim() || null
    const checked = createSupplierSchema.safeParse({
      name,
      category,
      gstin,
      stateCode,
      pan: text(raw.pan)?.toUpperCase() ?? null,
      phone: text(raw.phone),
      email: text(raw.email),
      address: text(raw.address),
      city: text(raw.city),
      state: text(raw.state),
      pincode: text(raw.pincode),
      ...(leadTimeDays !== undefined ? { leadTimeDays } : {}),
      ...(creditDays !== undefined ? { creditDays } : {}),
      paymentTerms: text(raw.paymentTerms),
      bankName: text(raw.bankName),
      bankAccount: text(raw.bankAccount),
      bankIFSC: text(raw.bankIFSC)?.toUpperCase() ?? null,
      isMsme,
      msmeNumber: text(raw.msmeNumber)?.toUpperCase() ?? null,
      rating: rating ?? null,
      isPreferred,
      notes: text(raw.notes),
    })
    if (!checked.success) problems.push(...checked.error.issues.map((i) => i.message))
    else res.create = checked.data as Record<string, unknown>
  }
  return out
}

/** Makes the new suppliers, numbered on from the highest SUP- code, in one transaction. */
export async function runImport(plans: Resolved[]) {
  if (plans.some((p) => p.plan.problems.length > 0)) {
    throw new AppError('Some rows have problems. Fix them and upload the sheet again.', 400, 'IMPORT_HAS_PROBLEMS')
  }
  return prisma.$transaction(
    async (tx) => {
      // As the form numbers them: one past the highest number on any SUP- code,
      // SUP-FAB-004 included, so an import never reuses one.
      const codes = await tx.supplier.findMany({ where: { code: { startsWith: 'SUP-' } }, select: { code: true } })
      let next = codes.reduce((max, c) => {
        const n = Number.parseInt(c.code.slice(c.code.lastIndexOf('-') + 1), 10)
        return Number.isFinite(n) && n > max ? n : max
      }, 0)
      const created: Array<{ code: string; name: string }> = []
      for (const p of plans) {
        if (!p.create) continue
        next += 1
        const s = await tx.supplier.create({
          data: { ...(p.create as object), code: `SUP-${String(next).padStart(3, '0')}` } as Parameters<
            typeof tx.supplier.create
          >[0]['data'],
          select: { code: true, name: true },
        })
        created.push(s)
      }
      return created
    },
    { timeout: 300_000, maxWait: 20_000 },
  )
}
