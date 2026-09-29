import ExcelJS from 'exceljs'
import { prisma } from '@ld-erp/database'
import { AppError } from '../middleware/errorHandler'
import { addDropdowns, addHowToSheet, addTemplateSheet, readSheetRows, type SheetColumn } from '../lib/sheet'
import { createWorkstationSchema } from '../schemas/master.schemas'

/**
 * Workstations from a spreadsheet, and the same sheet as the export: checked
 * first and shown row by row, then all or nothing, as the other masters are.
 *
 * A row names the station, the process (department) it does, whether it is
 * our own floor or an outside unit, and for an outside unit the supplier we
 * pay. One already in the system (the same name, ignoring capitals and
 * spaces) is left as it is and the row skipped.
 */

export const MAX_ROWS = 1000

export type WorkstationKey =
  | 'code'
  | 'name'
  | 'department'
  | 'type'
  | 'supplier'
  | 'capacityPerDay'
  | 'contactPerson'
  | 'phone'
  | 'address'
type Raw = Partial<Record<WorkstationKey, string>>

export const WORKSTATION_COLUMNS: SheetColumn<WorkstationKey>[] = [
  { key: 'code', head: 'Code', width: 12, note: 'Leave empty for a new workstation: the code is given when it is saved.' },
  { key: 'name', head: 'Name *', width: 30 },
  { key: 'department', head: 'Process *', width: 16, list: 'departments', note: 'The department whose step of the line this station does.' },
  { key: 'type', head: 'Run by *', width: 14, list: 'types' },
  { key: 'supplier', head: 'Supplier Paid', width: 28, list: 'suppliers', note: 'Needed for an outside unit: the supplier whose job-work bill it is.' },
  { key: 'capacityPerDay', head: 'Pieces per Day', width: 12, note: 'For planning. Empty if it varies.' },
  { key: 'contactPerson', head: 'Contact Person', width: 20 },
  { key: 'phone', head: 'Phone', width: 16 },
  { key: 'address', head: 'Address', width: 34 },
]

const TYPE_LABEL = { IN_HOUSE: 'Our floor', JOB_WORK: 'Outside unit' } as const
const TYPES = new Map<string, 'IN_HOUSE' | 'JOB_WORK'>([
  ['our floor', 'IN_HOUSE'],
  ['our own floor', 'IN_HOUSE'],
  ['in house', 'IN_HOUSE'],
  ['in-house', 'IN_HOUSE'],
  ['in_house', 'IN_HOUSE'],
  ['outside unit', 'JOB_WORK'],
  ['an outside unit', 'JOB_WORK'],
  ['job work', 'JOB_WORK'],
  ['job-work', 'JOB_WORK'],
  ['job_work', 'JOB_WORK'],
])

const low = (s?: string | null) => (s ?? '').trim().toLowerCase()
/** A name as the duplicate check sees it: no capitals, no spaces. */
const nameKey = (s?: string | null) => low(s).replace(/\s+/g, '')

/** A workstation as a sheet row, the same columns the import reads. */
export function workstationRow(w: Record<string, unknown>): Record<WorkstationKey, string | number> {
  const text = (v: unknown) => (v === null || v === undefined ? '' : String(v))
  const nameOf = (v: unknown) => text((v as { name?: string } | null)?.name)
  return {
    code: text(w.code),
    name: text(w.name),
    department: nameOf(w.department),
    type: TYPE_LABEL[w.type as keyof typeof TYPE_LABEL] ?? text(w.type),
    supplier: nameOf(w.supplier),
    capacityPerDay: typeof w.capacityPerDay === 'number' ? w.capacityPerDay : '',
    contactPerson: text(w.contactPerson),
    phone: text(w.phone),
    address: text(w.address),
  }
}

/** A workbook of workstations in the import's columns: template and export alike. */
export async function workstationWorkbook(rows: Array<Record<string, unknown>>, withHelp: boolean): Promise<Buffer> {
  const wb = new ExcelJS.Workbook()
  wb.creator = 'LD ERP'
  const sheet = addTemplateSheet(wb, 'Workstations', WORKSTATION_COLUMNS)
  for (const w of rows) sheet.addRow(workstationRow(w))
  if (withHelp) {
    const [departments, suppliers] = await Promise.all([
      prisma.department.findMany({ where: { isActive: true }, select: { name: true }, orderBy: { name: 'asc' } }),
      prisma.supplier.findMany({ where: { isActive: true }, select: { name: true }, orderBy: { name: 'asc' } }),
    ])
    addDropdowns(
      wb,
      sheet,
      WORKSTATION_COLUMNS,
      {
        departments: departments.map((d) => d.name),
        types: Object.values(TYPE_LABEL),
        suppliers: suppliers.map((s) => s.name),
      },
      MAX_ROWS,
    )
    addHowToSheet(wb, [
      'One row per workstation: a table, a line or a machine on our floor, or an outside unit we send work to.',
      'Required: Name, Process and Run by. Pick Process, Run by and Supplier Paid from the dropdowns.',
      'An outside unit needs its Supplier Paid: without it their job-work bill cannot be totalled.',
      'A workstation already in the system (the same name, ignoring capitals and spaces) is left as it is and the row is skipped. Change one on its own form.',
      'A new workstation gets its code (WS-…) when it is saved. Leave Code empty.',
      'Nothing is saved until you have seen what each row will do and pressed Import. If any row has a problem, nothing is imported.',
    ])
  }
  return Buffer.from(await wb.xlsx.writeBuffer())
}

export async function buildTemplate(withCurrent: boolean): Promise<Buffer> {
  const rows = withCurrent
    ? await prisma.workstation.findMany({
        where: { isActive: true },
        orderBy: { code: 'asc' },
        include: { department: { select: { name: true } }, supplier: { select: { name: true } } },
      })
    : []
  return workstationWorkbook(rows as unknown as Array<Record<string, unknown>>, true)
}

export function readSheet(file: Buffer, fileName: string) {
  return readSheetRows(file, fileName, {
    columns: WORKSTATION_COLUMNS,
    sheetName: 'Workstations',
    mustHave: 'name',
    mustHaveLabel: 'Name',
    maxRows: MAX_ROWS,
  })
}

export interface WorkstationRowPlan {
  row: number
  name: string
  code: string | null
  workstation: 'new' | 'existing' | 'none'
  process: string | null
  runBy: string | null
  skipped: boolean
  problems: string[]
}

interface Resolved {
  plan: WorkstationRowPlan
  create?: Record<string, unknown>
}

/** Checks every row against the workstations, departments and suppliers. Writes nothing. */
export async function planImport(rows: Array<{ row: number; raw: Raw }>): Promise<Resolved[]> {
  const [existing, departments, suppliers] = await Promise.all([
    prisma.workstation.findMany({ select: { code: true, name: true } }),
    prisma.department.findMany({ where: { isActive: true }, select: { id: true, name: true, code: true } }),
    prisma.supplier.findMany({ where: { isActive: true }, select: { id: true, name: true, code: true } }),
  ])
  const byName = new Map(existing.map((w) => [nameKey(w.name), w]))
  const dept = new Map(departments.flatMap((d) => [[low(d.name), d], [low(d.code), d]] as const))
  const supplier = new Map(suppliers.flatMap((s) => [[nameKey(s.name), s], [nameKey(s.code), s]] as const))
  const seenName = new Map<string, number>()
  const out: Resolved[] = []

  for (const { row, raw } of rows) {
    const problems: string[] = []
    const name = (raw.name ?? '').trim()
    const plan: WorkstationRowPlan = {
      row,
      name,
      code: null,
      workstation: 'none',
      process: raw.department?.trim() || null,
      runBy: raw.type?.trim() || null,
      skipped: false,
      problems,
    }
    const res: Resolved = { plan }
    out.push(res)

    if (!name) {
      problems.push('Name is empty.')
      continue
    }
    const already = byName.get(nameKey(name))
    if (already) {
      plan.workstation = 'existing'
      plan.code = already.code
      plan.skipped = true
      continue
    }
    const earlier = seenName.get(nameKey(name))
    if (earlier) {
      problems.push(`Row ${earlier} has the same workstation.`)
      continue
    }
    seenName.set(nameKey(name), row)
    plan.workstation = 'new'

    if (raw.code) problems.push(`No workstation has the code ${raw.code}. Leave Code empty for a new one.`)

    const d = raw.department ? dept.get(low(raw.department)) : undefined
    if (!raw.department) problems.push('Process is empty.')
    else if (!d) problems.push(`No department "${raw.department}".`)
    else plan.process = d.name

    const type = TYPES.get(low(raw.type))
    if (!raw.type) problems.push('Run by is empty. Pick Our floor or Outside unit.')
    else if (!type) problems.push(`Run by is Our floor or Outside unit, not "${raw.type}".`)
    else plan.runBy = TYPE_LABEL[type]

    const s = raw.supplier ? supplier.get(nameKey(raw.supplier)) : undefined
    if (raw.supplier && !s) problems.push(`No supplier "${raw.supplier}".`)

    let capacityPerDay: number | null = null
    if (raw.capacityPerDay) {
      capacityPerDay = Number(raw.capacityPerDay.replace(/[,\s]/g, ''))
      if (!Number.isInteger(capacityPerDay) || capacityPerDay < 0) {
        problems.push(`Pieces per Day "${raw.capacityPerDay}" is not a whole number.`)
      }
    }
    if (problems.length) continue

    const text = (v?: string) => v?.trim() || null
    const checked = createWorkstationSchema.safeParse({
      name,
      departmentId: d!.id,
      type,
      supplierId: s?.id ?? null,
      capacityPerDay,
      contactPerson: text(raw.contactPerson),
      phone: text(raw.phone),
      address: text(raw.address),
    })
    if (!checked.success) problems.push(...checked.error.issues.map((i) => i.message))
    else res.create = checked.data as Record<string, unknown>
  }
  return out
}

/** Makes the new workstations, numbered on from the highest WS- code, in one transaction. */
export async function runImport(plans: Resolved[]) {
  if (plans.some((p) => p.plan.problems.length > 0)) {
    throw new AppError('Some rows have problems. Fix them and upload the sheet again.', 400, 'IMPORT_HAS_PROBLEMS')
  }
  return prisma.$transaction(
    async (tx) => {
      const codes = await tx.workstation.findMany({ where: { code: { startsWith: 'WS-' } }, select: { code: true } })
      let next = codes.reduce((max, c) => {
        const n = Number.parseInt(c.code.slice(c.code.lastIndexOf('-') + 1), 10)
        return Number.isFinite(n) && n > max ? n : max
      }, 0)
      const created: Array<{ code: string; name: string }> = []
      for (const p of plans) {
        if (!p.create) continue
        next += 1
        const w = await tx.workstation.create({
          data: { ...(p.create as object), code: `WS-${String(next).padStart(3, '0')}` } as Parameters<
            typeof tx.workstation.create
          >[0]['data'],
          select: { code: true, name: true },
        })
        created.push(w)
      }
      return created
    },
    { timeout: 120_000, maxWait: 20_000 },
  )
}
