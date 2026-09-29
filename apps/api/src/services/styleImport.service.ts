import ExcelJS from 'exceljs'
import { prisma } from '@ld-erp/database'
import { AppError } from '../middleware/errorHandler'
import { addDropdowns, addHowToSheet, addTemplateSheet, readSheetRows, type SheetColumn } from '../lib/sheet'
import { createStyleSchema } from '../schemas/master.schemas'

/**
 * Styles from a spreadsheet: checked first and shown row by row, then all or
 * nothing, like items and categories.
 *
 * A row is one style. A style already in the system (the same code) is left
 * as it is: its BOMs are made per colour and its orders per size run, so
 * changing those from a sheet could quietly pull the ground from under them.
 * Changes to a style are made on its own form.
 */

export const MAX_ROWS = 1000

type Key =
  | 'code'
  | 'name'
  | 'brand'
  | 'category'
  | 'season'
  | 'fabricType'
  | 'gsm'
  | 'collarType'
  | 'sleeveType'
  | 'fit'
  | 'sizeGroup'
  | 'colors'
type Raw = Partial<Record<Key, string>>

const COLUMNS: SheetColumn<Key>[] = [
  { key: 'code', head: 'Style Code *', width: 16, note: 'Letters, numbers, dot, dash and slash; no spaces. LD-SH-2701' },
  { key: 'name', head: 'Style Name *', width: 34 },
  { key: 'brand', head: 'Brand *', width: 18, list: 'brands' },
  { key: 'category', head: 'Garment Type', width: 16, list: 'garments', note: 'Shirt, Trouser… Pick one already used, or type a new one.' },
  { key: 'season', head: 'Season', width: 10, list: 'seasons', note: 'SS-26, AW-26…' },
  { key: 'fabricType', head: 'Fabric', width: 22, list: 'fabrics' },
  { key: 'gsm', head: 'GSM', width: 8, note: 'A whole number, 1 to 2000.' },
  { key: 'collarType', head: 'Collar Type', width: 14, list: 'collars' },
  { key: 'sleeveType', head: 'Sleeve Type', width: 14, list: 'sleeves' },
  { key: 'fit', head: 'Fit', width: 12, list: 'fits' },
  { key: 'sizeGroup', head: 'Size Run', width: 22, list: 'sizeRuns' },
  { key: 'colors', head: 'Colours', width: 30, note: 'Separated by commas: White, Sky Blue, Navy' },
]

const BRANDS: Record<string, 'LD_COTTON_MILLS' | 'VHAGAR' | 'CUSTOM'> = {
  'ld cotton mills': 'LD_COTTON_MILLS',
  ld: 'LD_COTTON_MILLS',
  ld_cotton_mills: 'LD_COTTON_MILLS',
  vhagar: 'VHAGAR',
  custom: 'CUSTOM',
}
const BRAND_LABEL = { LD_COTTON_MILLS: 'LD Cotton Mills', VHAGAR: 'VHAGAR', CUSTOM: 'Custom' } as const

const low = (s?: string | null) => (s ?? '').trim().toLowerCase()
const distinct = (values: Array<string | null>) =>
  [...new Map(values.filter((v): v is string => Boolean(v?.trim())).map((v) => [low(v), v.trim()])).values()].sort()

async function loadMasters() {
  const [styles, sizeGroups] = await Promise.all([
    prisma.style.findMany({
      orderBy: { code: 'asc' },
      include: { sizeGroup: { select: { name: true } } },
    }),
    prisma.sizeGroup.findMany({ where: { isActive: true }, select: { id: true, name: true } }),
  ])
  return { styles, sizeGroups }
}

/** The template, optionally listing every style already in the system. */
export async function buildTemplate(withCurrent: boolean): Promise<Buffer> {
  const m = await loadMasters()
  const wb = new ExcelJS.Workbook()
  wb.creator = 'LD ERP'
  const sheet = addTemplateSheet(wb, 'Styles', COLUMNS)

  if (withCurrent) {
    for (const s of m.styles.filter((x) => x.isActive)) {
      sheet.addRow({
        code: s.code,
        name: s.name,
        brand: BRAND_LABEL[s.brandType],
        category: s.category ?? '',
        season: s.season ?? '',
        fabricType: s.fabricType ?? '',
        gsm: s.gsm ?? '',
        collarType: s.collarType ?? '',
        sleeveType: s.sleeveType ?? '',
        fit: s.fit ?? '',
        sizeGroup: s.sizeGroup?.name ?? '',
        colors: s.colors.join(', '),
      })
    }
  }

  // What the styles already use, so a sheet spells them the same way; a new
  // one can still be typed.
  addDropdowns(
    wb,
    sheet,
    COLUMNS,
    {
      brands: Object.values(BRAND_LABEL),
      garments: distinct(m.styles.map((s) => s.category)),
      seasons: distinct(m.styles.map((s) => s.season)),
      fabrics: distinct(m.styles.map((s) => s.fabricType)),
      collars: distinct(m.styles.map((s) => s.collarType)),
      sleeves: distinct(m.styles.map((s) => s.sleeveType)),
      fits: distinct(m.styles.map((s) => s.fit)),
      sizeRuns: m.sizeGroups.map((g) => g.name).sort(),
    },
    MAX_ROWS,
  )
  addHowToSheet(wb, [
    'One row per style. Required: Style Code, Style Name and Brand.',
    'Pick Brand and Size Run from the dropdowns. Garment Type, Season, Fabric, Collar, Sleeve and Fit offer what your styles already use; a new one can be typed.',
    'Colours go in one cell, separated by commas: White, Sky Blue, Navy.',
    'A style whose code is already in the system is left as it is, and the row is skipped. Change a style on its own form.',
    'Nothing is saved until you have seen what each row will do and pressed Import. If any row has a problem, nothing is imported.',
  ])
  return Buffer.from(await wb.xlsx.writeBuffer())
}

export function readSheet(file: Buffer, fileName: string) {
  return readSheetRows(file, fileName, {
    columns: COLUMNS,
    sheetName: 'Styles',
    mustHave: 'code',
    mustHaveLabel: 'Style Code',
    maxRows: MAX_ROWS,
  })
}

export interface StyleRowPlan {
  row: number
  code: string
  name: string
  style: 'new' | 'existing' | 'none'
  sizeRun: string | null
  colours: number
  skipped: boolean
  problems: string[]
}

interface Resolved {
  plan: StyleRowPlan
  create?: Record<string, unknown>
}

/** Checks every row against the styles and against each other. Writes nothing. */
export async function planImport(rows: Array<{ row: number; raw: Raw }>): Promise<Resolved[]> {
  const m = await loadMasters()
  const byCode = new Map(m.styles.map((s) => [low(s.code), s]))
  const sizeRun = new Map(m.sizeGroups.map((g) => [low(g.name), g]))
  const seen = new Map<string, number>()
  const out: Resolved[] = []

  for (const { row, raw } of rows) {
    const problems: string[] = []
    const code = (raw.code ?? '').trim().toUpperCase()
    // In the order typed, without repeats: the first spelling of each stays.
    const colours: string[] = []
    for (const c of (raw.colors ?? '').split(/[,;]/).map((x) => x.trim())) {
      if (c && !colours.some((k) => low(k) === low(c))) colours.push(c)
    }
    const plan: StyleRowPlan = {
      row,
      code,
      name: (raw.name ?? '').trim(),
      style: 'none',
      sizeRun: raw.sizeGroup?.trim() || null,
      colours: colours.length,
      skipped: false,
      problems,
    }
    const res: Resolved = { plan }
    out.push(res)

    if (!code) {
      problems.push('Style Code is empty.')
      continue
    }
    const existing = byCode.get(low(code))
    if (existing) {
      plan.style = 'existing'
      plan.name = plan.name || existing.name
      plan.skipped = true
      continue
    }
    const earlier = seen.get(low(code))
    if (earlier) {
      problems.push(`Row ${earlier} has the same code.`)
      continue
    }
    seen.set(low(code), row)
    plan.style = 'new'

    const brandType = BRANDS[low(raw.brand)]
    if (!raw.brand) problems.push('Brand is empty.')
    else if (!brandType) problems.push(`No brand "${raw.brand}". Pick LD Cotton Mills, VHAGAR or Custom.`)

    const group = raw.sizeGroup ? sizeRun.get(low(raw.sizeGroup)) : undefined
    if (raw.sizeGroup && !group) problems.push(`No size run "${raw.sizeGroup}".`)

    let gsm: number | null = null
    if (raw.gsm) {
      gsm = Number(raw.gsm)
      if (!Number.isInteger(gsm)) problems.push(`GSM "${raw.gsm}" is not a whole number.`)
    }

    if (problems.length) continue
    const text = (v?: string) => v?.trim() || null
    const checked = createStyleSchema.safeParse({
      code,
      name: plan.name,
      brandType,
      category: text(raw.category),
      season: text(raw.season),
      fabricType: text(raw.fabricType),
      gsm,
      collarType: text(raw.collarType),
      sleeveType: text(raw.sleeveType),
      fit: text(raw.fit),
      sizeGroupId: group?.id ?? null,
      colors: colours,
    })
    if (!checked.success) problems.push(...checked.error.issues.map((i) => i.message))
    else res.create = checked.data as Record<string, unknown>
  }
  return out
}

/** Makes the new styles, in one transaction. */
export async function runImport(plans: Resolved[]) {
  if (plans.some((p) => p.plan.problems.length > 0)) {
    throw new AppError('Some rows have problems. Fix them and upload the sheet again.', 400, 'IMPORT_HAS_PROBLEMS')
  }
  return prisma.$transaction(
    async (tx) => {
      const created: Array<{ code: string; name: string }> = []
      for (const p of plans) {
        if (!p.create) continue
        const s = await tx.style.create({
          data: p.create as Parameters<typeof tx.style.create>[0]['data'],
          select: { code: true, name: true },
        })
        created.push(s)
      }
      return created
    },
    { timeout: 120_000, maxWait: 20_000 },
  )
}
