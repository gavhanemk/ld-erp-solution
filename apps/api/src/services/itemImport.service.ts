import ExcelJS from 'exceljs'
import { Readable } from 'stream'
import { prisma } from '@ld-erp/database'
import { AppError } from '../middleware/errorHandler'
import { createItemSchema } from '../schemas/master.schemas'
import { itemPrefix } from '../lib/masterCode'
import { balanceOf, lockedBalanceOf, recordMovement } from './stock.service'

/**
 * Bringing items, and the stock of them, in from a spreadsheet.
 *
 * The mill starts with hundreds of items and a store full of stock, and typing
 * them one at a time through the item form would take days. So a template is
 * handed out with dropdowns for everything that has to match a master, the
 * filled sheet is read back and every row is checked, and the person sees what
 * each row will do before anything is written. Then it is all or nothing: one
 * transaction, so a sheet half imported never has to be untangled.
 *
 * A row names an item and, if it gives a store and a quantity, the stock of it
 * on hand today (opening stock). An item already in the system is matched by
 * its code or its name and is not changed; only its stock is added. The same
 * item on several rows is one item with stock in several stores.
 */

export const MAX_ROWS = 2000

/** What the sheet's columns are called, in order. A trailing * means required. */
const COLUMNS = [
  { key: 'code', head: 'Item Code', width: 14, note: 'Only to match an item already in the system. Leave empty for a new item: the code is given when it is saved.' },
  { key: 'name', head: 'Item Name *', width: 34 },
  { key: 'type', head: 'Item Type *', width: 16, list: 'types' },
  { key: 'category', head: 'Category *', width: 22, list: 'categories' },
  { key: 'subCategory', head: 'Sub Category', width: 22, list: 'subCategories', note: 'Needed when the category has sub-categories.' },
  { key: 'department', head: 'Department *', width: 18, list: 'departments', note: "Empty takes the sub-category's department." },
  { key: 'unit', head: 'Unit *', width: 12, list: 'units' },
  { key: 'hsn', head: 'HSN Code', width: 12 },
  { key: 'standardRate', head: 'Standard Rate', width: 14 },
  { key: 'reorderLevel', head: 'Reorder Level', width: 14 },
  { key: 'minStock', head: 'Minimum Stock', width: 14 },
  { key: 'maxStock', head: 'Maximum Stock', width: 14 },
  { key: 'description', head: 'Description', width: 30 },
  { key: 'store', head: 'Store', width: 22, list: 'stores', note: 'For stock on hand today. Leave the three stock columns empty for an item with none.' },
  { key: 'qty', head: 'Stock Qty', width: 12 },
  { key: 'rate', head: 'Stock Rate', width: 12, note: 'What one unit of the stock cost. Empty takes the Standard Rate.' },
] as const

type Key = (typeof COLUMNS)[number]['key']
type Raw = Partial<Record<Key, string>>

const TYPES: Record<string, string> = {
  'raw material': 'RAW_MATERIAL',
  'semi finished': 'SEMI_FINISHED',
  'finished good': 'FINISHED_GOOD',
  'finished goods': 'FINISHED_GOOD',
  consumable: 'CONSUMABLE',
  packing: 'PACKING_MATERIAL',
  'packing material': 'PACKING_MATERIAL',
  trim: 'TRIM',
}
/** How each type is shown, the same words the item list uses. */
const TYPE_LABEL: Record<string, string> = {
  RAW_MATERIAL: 'Raw Material',
  SEMI_FINISHED: 'Semi Finished',
  FINISHED_GOOD: 'Finished Good',
  CONSUMABLE: 'Consumable',
  PACKING_MATERIAL: 'Packing',
  TRIM: 'Trim',
}
const TYPE_LABELS = Object.values(TYPE_LABEL)

const low = (s: string | undefined | null) => (s ?? '').trim().toLowerCase()

/** The masters a sheet is matched against, loaded once. */
async function loadMasters() {
  const [categories, departments, units, stores, items] = await Promise.all([
    prisma.itemCategory.findMany({
      where: { isActive: true },
      select: { id: true, name: true, parentId: true, departmentId: true },
    }),
    prisma.department.findMany({ where: { isActive: true }, select: { id: true, name: true, code: true } }),
    prisma.uOM.findMany({ where: { isActive: true }, select: { id: true, name: true, symbol: true } }),
    prisma.warehouse.findMany({ where: { isActive: true }, select: { id: true, name: true, code: true } }),
    prisma.item.findMany({
      select: {
        id: true,
        code: true,
        name: true,
        isActive: true,
        type: true,
        standardRate: true,
        category: { select: { name: true, parent: { select: { name: true } } } },
        department: { select: { name: true } },
        uom: { select: { name: true } },
      },
    }),
  ])
  return { categories, departments, units, stores, items }
}

// ─────────────────────────────────────────────────────────────
// The template
// ─────────────────────────────────────────────────────────────

/**
 * The sheet to fill in. `withItems` fills it with every active item already in
 * the system, so loading today's stock is a matter of typing the store and the
 * quantity against each.
 */
export async function buildTemplate(withItems: boolean): Promise<Buffer> {
  const m = await loadMasters()
  const wb = new ExcelJS.Workbook()
  wb.creator = 'LD ERP'

  const sheet = wb.addWorksheet('Items', { views: [{ state: 'frozen', ySplit: 1 }] })
  sheet.columns = COLUMNS.map((c) => ({ header: c.head, key: c.key, width: c.width }))
  const head = sheet.getRow(1)
  head.font = { bold: true, color: { argb: 'FFFFFFFF' } }
  head.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF173A6C' } }
  head.height = 20
  COLUMNS.forEach((c, i) => {
    if ('note' in c && c.note) sheet.getCell(1, i + 1).note = c.note
  })

  if (withItems) {
    for (const it of m.items.filter((i) => i.isActive).sort((a, b) => a.name.localeCompare(b.name))) {
      const parent = it.category.parent?.name
      sheet.addRow({
        code: it.code,
        name: it.name,
        type: TYPE_LABEL[it.type] ?? it.type,
        category: parent ?? it.category.name,
        subCategory: parent ? it.category.name : '',
        department: it.department?.name ?? '',
        unit: it.uom.name,
      })
    }
  }

  // Lists for the dropdowns, on a sheet of their own.
  const lists = wb.addWorksheet('Lists')
  const mains = m.categories.filter((c) => !c.parentId)
  const subs = m.categories.filter((c) => c.parentId)
  const columns: Record<string, string[]> = {
    types: TYPE_LABELS,
    categories: mains.map((c) => c.name).sort(),
    subCategories: [...new Set(subs.map((c) => c.name))].sort(),
    departments: m.departments.map((d) => d.name).sort(),
    units: m.units.map((u) => u.name).sort(),
    stores: m.stores.map((s) => s.name).sort(),
  }
  const where: Record<string, string> = {}
  Object.entries(columns).forEach(([key, values], i) => {
    const col = lists.getColumn(i + 1)
    col.width = 26
    lists.getCell(1, i + 1).value = key
    lists.getCell(1, i + 1).font = { bold: true }
    values.forEach((v, r) => (lists.getCell(r + 2, i + 1).value = v))
    const letter = col.letter
    where[key] = `Lists!$${letter}$2:$${letter}$${Math.max(2, values.length + 1)}`
  })

  // Dropdowns on the first 2000 rows, so a pasted list still gets them.
  COLUMNS.forEach((c, i) => {
    if (!('list' in c) || !c.list) return
    const letter = sheet.getColumn(i + 1).letter
    for (let r = 2; r <= MAX_ROWS + 1; r++) {
      sheet.getCell(`${letter}${r}`).dataValidation = {
        type: 'list',
        allowBlank: true,
        formulae: [where[c.list]],
        showErrorMessage: false,
      }
    }
  })

  // How to fill it, for whoever opens it cold.
  const how = wb.addWorksheet('How to fill')
  how.getColumn(1).width = 110
  ;[
    'One row per item. Required: Item Name, Item Type, Category, Unit, Department; Sub Category when the category has sub-categories.',
    'Pick Type, Category, Sub Category, Department, Unit and Store from the dropdowns, so they match what is in the system.',
    'A new item gets its code when it is saved. Put a code in Item Code only to point at an item already in the system.',
    'An item already in the system (same code, or same name) is not changed. Only its stock is added.',
    'Stock on hand today: fill Store, Stock Qty and Stock Rate. Empty Stock Rate takes the Standard Rate. Leave all three empty for no stock.',
    'The same item in two stores: two rows with the same name, one per store.',
    'Opening stock can only be entered once for an item in a store. After that, correct it with a stock count.',
    'Nothing is saved until you have seen what each row will do and pressed Import. If any row has a problem, nothing is imported.',
  ].forEach((t, i) => (how.getCell(i + 1, 1).value = `${i + 1}. ${t}`))

  return Buffer.from(await wb.xlsx.writeBuffer())
}

// ─────────────────────────────────────────────────────────────
// Reading a filled sheet
// ─────────────────────────────────────────────────────────────

/** A cell as text, whatever Excel stored: a number, rich text, a formula's result. */
function cellText(v: ExcelJS.CellValue): string {
  if (v === null || v === undefined) return ''
  if (typeof v === 'number') return String(v)
  if (typeof v === 'string') return v.trim()
  if (typeof v === 'boolean') return v ? 'true' : 'false'
  if (v instanceof Date) return v.toISOString().slice(0, 10)
  if (typeof v === 'object') {
    if ('richText' in v) return v.richText.map((r) => r.text).join('').trim()
    if ('result' in v) return cellText(v.result as ExcelJS.CellValue)
    if ('text' in v) return String(v.text).trim()
  }
  return String(v).trim()
}

/** The rows of the first sheet, keyed by the template's columns, matched on header text. */
export async function readSheet(file: Buffer, fileName: string): Promise<Array<{ row: number; raw: Raw }>> {
  const wb = new ExcelJS.Workbook()
  try {
    if (/\.csv$/i.test(fileName)) await wb.csv.read(Readable.from(file))
    // exceljs types its own Buffer; Node's is the same bytes.
    else await wb.xlsx.load(file as unknown as ExcelJS.Buffer)
  } catch {
    throw new AppError('That file could not be read. Save it as .xlsx (or .csv) and try again.', 400, 'BAD_FILE')
  }
  const sheet = wb.getWorksheet('Items') ?? wb.worksheets[0]
  if (!sheet) throw new AppError('That file has no sheet in it.', 400, 'BAD_FILE')

  const norm = (s: string) => s.replace(/\*/g, '').trim().toLowerCase()
  const byHead = new Map(COLUMNS.map((c) => [norm(c.head), c.key]))
  const colKey = new Map<number, Key>()
  sheet.getRow(1).eachCell((cell, col) => {
    const key = byHead.get(norm(cellText(cell.value)))
    if (key) colKey.set(col, key)
  })
  if (![...colKey.values()].includes('name')) {
    throw new AppError('The first row has no "Item Name" column. Start from the template.', 400, 'BAD_FILE')
  }

  const rows: Array<{ row: number; raw: Raw }> = []
  sheet.eachRow((r, n) => {
    if (n === 1) return
    const raw: Raw = {}
    r.eachCell((cell, col) => {
      const key = colKey.get(col)
      if (key) raw[key] = cellText(cell.value)
    })
    if (Object.values(raw).some((v) => v)) rows.push({ row: n, raw })
  })
  if (rows.length === 0) throw new AppError('The sheet has no rows filled in.', 400, 'EMPTY_FILE')
  if (rows.length > MAX_ROWS) {
    throw new AppError(`That is ${rows.length} rows. Import at most ${MAX_ROWS} at a time.`, 400, 'TOO_MANY_ROWS')
  }
  return rows
}

// ─────────────────────────────────────────────────────────────
// Working out what each row will do
// ─────────────────────────────────────────────────────────────

export interface RowPlan {
  row: number
  name: string
  /** What happens to the item: made new, found already there, or nothing (a problem). */
  item: 'new' | 'existing' | 'none'
  code: string | null
  stock: { store: string; qty: number; rate: number } | null
  /**
   * An item already in the system with no stock on its row: left alone. The
   * sheet of current items lists every item, and most rows of it are only
   * there to be skipped past.
   */
  skipped: boolean
  problems: string[]
}

interface Resolved {
  plan: RowPlan
  create?: Record<string, unknown> & { categoryId: string }
  itemKey: string
  existingId?: string
  stock?: { warehouseId: string; qty: number; rate: number }
}

const num = (s: string | undefined) => {
  if (s === undefined || s === '') return undefined
  const n = Number(String(s).replace(/,/g, ''))
  return Number.isFinite(n) ? n : NaN
}

/** Checks every row against the masters and against each other. Writes nothing. */
export async function planImport(rows: Array<{ row: number; raw: Raw }>): Promise<Resolved[]> {
  const m = await loadMasters()
  const mains = new Map(m.categories.filter((c) => !c.parentId).map((c) => [low(c.name), c]))
  const dept = new Map(m.departments.flatMap((d) => [[low(d.name), d], [low(d.code), d]] as const))
  const unit = new Map(m.units.flatMap((u) => [[low(u.name), u], [low(u.symbol), u]] as const))
  const store = new Map(m.stores.flatMap((s) => [[low(s.name), s], [low(s.code), s]] as const))
  const byCode = new Map(m.items.map((i) => [low(i.code), i]))
  const byName = new Map(m.items.map((i) => [low(i.name), i]))

  // The first row naming an item defines it; later rows with the same name only
  // add stock in another store.
  const seen = new Map<string, Resolved>()
  const stockKeys = new Set<string>()
  const out: Resolved[] = []

  for (const { row, raw } of rows) {
    const problems: string[] = []
    const name = (raw.name ?? '').trim()
    const plan: RowPlan = { row, name, item: 'none', code: null, stock: null, skipped: false, problems }
    const res: Resolved = { plan, itemKey: low(name) }

    // Which item this row is about.
    let existing = raw.code ? byCode.get(low(raw.code)) : undefined
    if (raw.code && !existing) problems.push(`No item with code ${raw.code} in the system. Leave Item Code empty for a new item.`)
    if (!existing && name) existing = byName.get(low(name))
    if (!name && !existing) problems.push('Item Name is empty.')

    if (existing) {
      res.itemKey = `id:${existing.id}`
      res.existingId = existing.id
      plan.item = 'existing'
      plan.code = existing.code
      plan.name = existing.name
      if (!existing.isActive) problems.push(`${existing.code} is deactivated. Reactivate it first to add stock.`)
    } else if (name && seen.has(low(name))) {
      const first = seen.get(low(name))!
      res.itemKey = first.itemKey
      plan.item = first.plan.item
      plan.code = first.plan.code
    } else if (name) {
      // A new item: every field that has to match a master is looked up.
      plan.item = 'new'
      const type = TYPES[low(raw.type)] ?? (Object.values(TYPES).includes((raw.type ?? '').toUpperCase()) ? (raw.type ?? '').toUpperCase() : undefined)
      if (!raw.type) problems.push('Item Type is empty.')
      else if (!type) problems.push(`Item Type "${raw.type}" is not one of: ${TYPE_LABELS.join(', ')}.`)

      const main = mains.get(low(raw.category))
      let categoryId: string | undefined
      if (!raw.category) problems.push('Category is empty.')
      else if (!main) problems.push(`No category "${raw.category}". Pick one from the dropdown.`)
      else {
        const children = m.categories.filter((c) => c.parentId === main.id)
        if (raw.subCategory) {
          const sub = children.find((c) => low(c.name) === low(raw.subCategory))
          if (!sub) problems.push(`"${raw.subCategory}" is not a sub-category of ${main.name}.`)
          else categoryId = sub.id
        } else if (children.length > 0) {
          problems.push(`Pick a sub-category of ${main.name}: ${children.map((c) => c.name).join(', ')}.`)
        } else categoryId = main.id
      }

      // Empty takes the category's own department, as the item form does.
      const fromCategory = categoryId
        ? m.departments.find((x) => x.id === m.categories.find((c) => c.id === categoryId)?.departmentId)
        : undefined
      const d = raw.department ? dept.get(low(raw.department)) : fromCategory
      if (!raw.department && !d) problems.push('Department is empty, and the category has none to take.')
      else if (!d) problems.push(`No department "${raw.department}".`)

      const u = unit.get(low(raw.unit))
      if (!raw.unit) problems.push('Unit is empty.')
      else if (!u) problems.push(`No unit "${raw.unit}".`)

      const numbers = {
        standardRate: num(raw.standardRate),
        reorderLevel: num(raw.reorderLevel),
        minStock: num(raw.minStock),
        maxStock: num(raw.maxStock),
      }
      for (const [k, v] of Object.entries(numbers)) {
        if (Number.isNaN(v)) problems.push(`${COLUMNS.find((c) => c.key === k)!.head} "${raw[k as Key]}" is not a number.`)
      }

      if (type && categoryId && d && u && !Object.values(numbers).some(Number.isNaN)) {
        const candidate = {
          name,
          type,
          categoryId,
          departmentId: d.id,
          uomId: u.id,
          hsnCode: raw.hsn ? raw.hsn.replace(/\s+/g, '') : undefined,
          description: raw.description || undefined,
          ...Object.fromEntries(Object.entries(numbers).filter(([, v]) => v !== undefined)),
        }
        const checked = createItemSchema.safeParse(candidate)
        if (!checked.success) problems.push(...checked.error.issues.map((i) => i.message))
        else res.create = { ...(checked.data as Record<string, unknown>), categoryId }
      }
      seen.set(low(name), res)
    }

    // Stock on hand today, if the row gives any.
    if (raw.store || raw.qty || raw.rate) {
      const s = store.get(low(raw.store))
      const qty = num(raw.qty)
      const standard = existing ? Number(existing.standardRate ?? 0) : (seen.get(low(name))?.create?.standardRate as number | undefined)
      const rate = num(raw.rate) ?? (standard && standard > 0 ? standard : undefined)
      if (!raw.store) problems.push('Stock Qty is given but Store is empty.')
      else if (!s) problems.push(`No store "${raw.store}".`)
      if (qty === undefined || Number.isNaN(qty) || !(qty > 0)) problems.push('Stock Qty has to be a number more than nought.')
      if (rate === undefined || Number.isNaN(rate) || !(rate > 0)) {
        problems.push('Stock Rate is needed (or a Standard Rate on the item): stock at ₹0 would be worth nothing.')
      }
      if (s && qty && qty > 0 && rate && rate > 0) {
        const key = `${res.itemKey}|${s.id}`
        if (stockKeys.has(key)) problems.push(`${plan.name || name} is in ${s.name} twice on this sheet. Enter it once, with the total.`)
        stockKeys.add(key)
        if (res.existingId) {
          const bal = await balanceOf(prisma, { itemId: res.existingId, warehouseId: s.id })
          if (bal.qty !== 0) {
            problems.push(`${plan.code} already has ${bal.qty} in ${s.name}. Opening stock is entered once; correct it with a stock count.`)
          }
        }
        res.stock = { warehouseId: s.id, qty, rate }
        plan.stock = { store: s.name, qty, rate }
      }
    }

    if (plan.item === 'existing' && !plan.stock && !raw.store && !raw.qty && !raw.rate) {
      // Nothing asked of an item that is already there: not a problem, just
      // nothing to do, and any complaint about it being deactivated is moot.
      plan.skipped = true
      problems.length = 0
    }
    out.push(res)
  }
  return out
}

// ─────────────────────────────────────────────────────────────
// Doing it
// ─────────────────────────────────────────────────────────────

/**
 * Writes the new items and the opening stock, all in one transaction.
 *
 * Codes are handed out here the way the item form hands them out, from the
 * category, counting on from the highest already used, so a sheet of forty
 * fabrics becomes FAB-012 to FAB-051 in order.
 */
export async function runImport(plans: Resolved[]) {
  if (plans.some((p) => p.plan.problems.length > 0)) {
    throw new AppError('Some rows have problems. Fix them and upload the sheet again.', 400, 'IMPORT_HAS_PROBLEMS')
  }
  const reference = `IMPORT-${Date.now()}`

  return prisma.$transaction(
    async (tx) => {
      const idByKey = new Map<string, string>()
      for (const p of plans) if (p.existingId) idByKey.set(p.itemKey, p.existingId)

      // Next number for each code prefix, read once and counted on from.
      const next = new Map<string, number>()
      const created: Array<{ code: string; name: string }> = []
      for (const p of plans) {
        if (!p.create || idByKey.has(p.itemKey)) continue
        const prefix = await itemPrefix(p.create.categoryId)
        if (!next.has(prefix)) {
          const rows = await tx.item.findMany({ where: { code: { startsWith: `${prefix}-` } }, select: { code: true } })
          const highest = rows.reduce((max, r) => {
            const n = Number.parseInt(r.code.slice(r.code.lastIndexOf('-') + 1), 10)
            return Number.isFinite(n) && n > max ? n : max
          }, 0)
          next.set(prefix, highest + 1)
        }
        const n = next.get(prefix)!
        next.set(prefix, n + 1)
        const code = `${prefix}-${String(n).padStart(3, '0')}`
        const item = await tx.item.create({
          data: { ...(p.create as Record<string, unknown>), code } as never,
          select: { id: true, code: true, name: true },
        })
        idByKey.set(p.itemKey, item.id)
        created.push({ code: item.code, name: item.name })
      }

      let stockLines = 0
      for (const p of plans) {
        if (!p.stock) continue
        const itemId = idByKey.get(p.itemKey)!
        const bal = await lockedBalanceOf(tx, { itemId, warehouseId: p.stock.warehouseId })
        if (bal.qty !== 0) {
          throw new AppError(
            `Row ${p.plan.row}: that item already has stock in this store. Opening stock is entered once.`,
            409,
            'OPENING_ALREADY_SET',
          )
        }
        await recordMovement(tx, {
          itemId,
          warehouseId: p.stock.warehouseId,
          transactionType: 'OPENING',
          direction: 'IN',
          qty: p.stock.qty,
          unitRate: p.stock.rate,
          referenceType: 'OPENING_STOCK',
          referenceId: reference,
          notes: 'Opening stock, imported from a sheet',
        })
        stockLines += 1
      }

      return { reference, created, stockLines }
    },
    // A few hundred rows over a pooler an ocean away take a while.
    { timeout: 300_000, maxWait: 20_000 },
  )
}
