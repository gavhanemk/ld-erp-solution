import ExcelJS from 'exceljs'
import { prisma } from '@ld-erp/database'
import { AppError } from '../middleware/errorHandler'
import { addDropdowns, addHowToSheet, addTemplateSheet, readSheetRows, type SheetColumn } from '../lib/sheet'
import { GST_STATES } from '../lib/gstStates'
import { createBrokerSchema } from '../schemas/master.schemas'

/**
 * Agents from a spreadsheet, and the same sheet as the export, exactly as
 * customers and suppliers are: checked first and shown row by row, then all
 * or nothing.
 *
 * An agent already in the system (the same name, ignoring capitals and
 * spaces) is left as it is and the row skipped. Every row goes through the
 * form's own checks, GSTIN against state code and PAN included, and a new
 * one is numbered on from the highest BRK- code, as the form numbers it.
 */

export const MAX_ROWS = 1000

export type BrokerKey =
  | 'code'
  | 'name'
  | 'phone'
  | 'email'
  | 'gstin'
  | 'stateCode'
  | 'pan'
  | 'address'
  | 'city'
  | 'state'
  | 'brokeragePercent'
  | 'tdsSection'
  | 'tdsRate'
  | 'notes'
type Raw = Partial<Record<BrokerKey, string>>

export const BROKER_COLUMNS: SheetColumn<BrokerKey>[] = [
  { key: 'code', head: 'Agent Code', width: 12, note: 'Leave empty for a new agent: the code is given when it is saved.' },
  { key: 'name', head: 'Agent Name *', width: 30 },
  { key: 'phone', head: 'Phone', width: 16 },
  { key: 'email', head: 'Email', width: 26 },
  { key: 'gstin', head: 'GSTIN', width: 18, note: '15 characters. Empty if unregistered.' },
  { key: 'stateCode', head: 'GST State Code', width: 10, note: 'Two digits. Empty: taken from the GSTIN, or from State.' },
  { key: 'pan', head: 'PAN', width: 12, note: 'Empty: taken from the GSTIN. TDS is deducted against it.' },
  { key: 'address', head: 'Address', width: 34 },
  { key: 'city', head: 'City', width: 14 },
  { key: 'state', head: 'State', width: 18, list: 'states' },
  { key: 'brokeragePercent', head: 'Brokerage % *', width: 12, note: 'On the order value, e.g. 2 or 1.5.' },
  { key: 'tdsSection', head: 'TDS Section', width: 11, list: 'tdsSections', note: 'Commission to an agent is normally 194H.' },
  { key: 'tdsRate', head: 'TDS %', width: 8 },
  { key: 'notes', head: 'Notes', width: 30 },
]

const low = (s?: string | null) => (s ?? '').trim().toLowerCase()
/** A name as the duplicate check sees it: no capitals, no spaces. */
const nameKey = (s?: string | null) => low(s).replace(/\s+/g, '')
const STATE_CODE = new Map(Object.entries(GST_STATES).map(([code, name]) => [low(name), code]))

/** An agent as a sheet row, the same columns the import reads. */
export function brokerRow(b: Record<string, unknown>): Record<BrokerKey, string | number> {
  const text = (v: unknown) => (v === null || v === undefined ? '' : String(v))
  const num = (v: unknown) => (v === null || v === undefined ? '' : Number(v))
  return {
    code: text(b.code),
    name: text(b.name),
    phone: text(b.phone),
    email: text(b.email),
    gstin: text(b.gstin),
    stateCode: text(b.stateCode),
    pan: text(b.pan),
    address: text(b.address),
    city: text(b.city),
    state: text(b.state),
    brokeragePercent: num(b.brokeragePercent),
    tdsSection: text(b.tdsSection),
    tdsRate: num(b.tdsRate),
    notes: text(b.notes),
  }
}

/** A workbook of agents in the import's columns: template and export alike. */
export async function brokerWorkbook(rows: Array<Record<string, unknown>>, withHelp: boolean): Promise<Buffer> {
  const wb = new ExcelJS.Workbook()
  wb.creator = 'LD ERP'
  const sheet = addTemplateSheet(wb, 'Agents', BROKER_COLUMNS)
  for (const b of rows) sheet.addRow(brokerRow(b))
  if (withHelp) {
    addDropdowns(
      wb,
      sheet,
      BROKER_COLUMNS,
      { states: [...new Set(Object.values(GST_STATES))].sort(), tdsSections: ['194H', '194C', '194J'] },
      MAX_ROWS,
    )
    addHowToSheet(wb, [
      'One row per agent. Required: Agent Name and Brokerage %.',
      'GSTIN, GST State Code and PAN must agree. Give the GSTIN and the other two are filled in from it; with no GSTIN, pick the State and its code is used.',
      'An agent already in the system (the same name, ignoring capitals and spaces) is left as it is and the row is skipped. Change an agent on its own form.',
      'A new agent gets its code (BRK-…) when it is saved. Leave Agent Code empty.',
      'Brokerage % and TDS % are plain numbers: 2, 1.5, 5.',
      'Nothing is saved until you have seen what each row will do and pressed Import. If any row has a problem, nothing is imported.',
    ])
  }
  return Buffer.from(await wb.xlsx.writeBuffer())
}

export async function buildTemplate(withCurrent: boolean): Promise<Buffer> {
  const rows = withCurrent
    ? await prisma.broker.findMany({ where: { isActive: true }, orderBy: { name: 'asc' } })
    : []
  return brokerWorkbook(rows as unknown as Array<Record<string, unknown>>, true)
}

export function readSheet(file: Buffer, fileName: string) {
  return readSheetRows(file, fileName, {
    columns: BROKER_COLUMNS,
    sheetName: 'Agents',
    mustHave: 'name',
    mustHaveLabel: 'Agent Name',
    maxRows: MAX_ROWS,
  })
}

export interface BrokerRowPlan {
  row: number
  name: string
  code: string | null
  broker: 'new' | 'existing' | 'none'
  brokerage: number | null
  skipped: boolean
  problems: string[]
}

interface Resolved {
  plan: BrokerRowPlan
  create?: Record<string, unknown>
}

/** Checks every row against the agents and against each other. Writes nothing. */
export async function planImport(rows: Array<{ row: number; raw: Raw }>): Promise<Resolved[]> {
  const existing = await prisma.broker.findMany({ select: { code: true, name: true, gstin: true } })
  const byName = new Map(existing.map((b) => [nameKey(b.name), b]))
  const byGstin = new Map(existing.filter((b) => b.gstin).map((b) => [low(b.gstin), b]))
  const seenName = new Map<string, number>()
  const seenGstin = new Map<string, number>()
  const out: Resolved[] = []

  for (const { row, raw } of rows) {
    const problems: string[] = []
    const name = (raw.name ?? '').trim()
    const plan: BrokerRowPlan = { row, name, code: null, broker: 'none', brokerage: null, skipped: false, problems }
    const res: Resolved = { plan }
    out.push(res)

    if (!name) {
      problems.push('Agent Name is empty.')
      continue
    }
    const already = byName.get(nameKey(name))
    if (already) {
      plan.broker = 'existing'
      plan.code = already.code
      plan.skipped = true
      continue
    }
    const earlier = seenName.get(nameKey(name))
    if (earlier) {
      problems.push(`Row ${earlier} has the same agent.`)
      continue
    }
    seenName.set(nameKey(name), row)
    plan.broker = 'new'

    if (raw.code) problems.push(`No agent has the code ${raw.code}. Leave Agent Code empty for a new one.`)

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

    const percent = (label: string, v?: string) => {
      if (!v) return undefined
      const n = Number(v.replace(/[%\s]/g, ''))
      if (!Number.isFinite(n) || n < 0 || n > 100) {
        problems.push(`${label} "${v}" is not a percentage from 0 to 100.`)
        return undefined
      }
      return n
    }
    const brokeragePercent = percent('Brokerage %', raw.brokeragePercent)
    if (!raw.brokeragePercent) problems.push('Brokerage % is empty. Put 0 for an agent paid no commission.')
    plan.brokerage = brokeragePercent ?? null
    const tdsRate = percent('TDS %', raw.tdsRate)
    if (problems.length) continue

    const text = (v?: string) => v?.trim() || null
    const checked = createBrokerSchema.safeParse({
      name,
      phone: text(raw.phone),
      email: text(raw.email),
      gstin,
      stateCode,
      pan: text(raw.pan)?.toUpperCase() ?? null,
      address: text(raw.address),
      city: text(raw.city),
      state: text(raw.state),
      brokeragePercent,
      tdsSection: text(raw.tdsSection)?.toUpperCase() ?? null,
      tdsRate: tdsRate ?? null,
      notes: text(raw.notes),
    })
    if (!checked.success) problems.push(...checked.error.issues.map((i) => i.message))
    else res.create = checked.data as Record<string, unknown>
  }
  return out
}

/** Makes the new agents, numbered on from the highest BRK- code, in one transaction. */
export async function runImport(plans: Resolved[]) {
  if (plans.some((p) => p.plan.problems.length > 0)) {
    throw new AppError('Some rows have problems. Fix them and upload the sheet again.', 400, 'IMPORT_HAS_PROBLEMS')
  }
  return prisma.$transaction(
    async (tx) => {
      const codes = await tx.broker.findMany({ where: { code: { startsWith: 'BRK-' } }, select: { code: true } })
      let next = codes.reduce((max, c) => {
        const n = Number.parseInt(c.code.slice(c.code.lastIndexOf('-') + 1), 10)
        return Number.isFinite(n) && n > max ? n : max
      }, 0)
      const created: Array<{ code: string; name: string }> = []
      for (const p of plans) {
        if (!p.create) continue
        next += 1
        const b = await tx.broker.create({
          data: { ...(p.create as object), code: `BRK-${String(next).padStart(3, '0')}` } as Parameters<
            typeof tx.broker.create
          >[0]['data'],
          select: { code: true, name: true },
        })
        created.push(b)
      }
      return created
    },
    { timeout: 120_000, maxWait: 20_000 },
  )
}
