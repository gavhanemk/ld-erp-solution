import { fitsPlaces, placesMessage, qtyPlaces, typeFitsGroup } from '@ld-erp/shared'
import { typeMismatchMessage } from './itemGroups.service'
import ExcelJS from 'exceljs'
import { prisma } from '@ld-erp/database'
import { AppError } from '../middleware/errorHandler'
import type { PackType } from '@prisma/client'
import { addDropdowns, addHowToSheet, addTemplateSheet, readSheetRows, type SheetColumn } from '../lib/sheet'
import { createItemSchema } from '../schemas/master.schemas'
import { itemPrefix } from '../lib/masterCode'
import { cleanColour, cleanDesignNo, isFabricCategory, isThreadCategory, ITEM_SHADE, itemShadeText } from '../lib/fabric'
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
 * its code or its name and is not changed, but for how it comes packed when
 * the row fills that in; its stock is added. The same item on several rows is
 * one item with stock in several stores.
 *
 * Fabric is set up one design and colour per item, and thread one colour per
 * item (lib/fabric), so several items may share a name: "Cotton Twill" in
 * 1164 Navy and in 1165 Black. Their rows carry a Design No. and a Colour, and
 * an item is then the name together with those two, never the name alone.
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
  { key: 'packType', head: 'Sticker Package', width: 16, list: 'packTypes', note: 'What one sticker goes on: Packet, Box, Roll and so on. Empty: as the category says.' },
  { key: 'packQty', head: 'Qty per Sticker', width: 14, note: 'How much one package holds: 50 for a packet of 50 buttons. Empty: one sticker for the lot.' },
  { key: 'description', head: 'Description', width: 30 },
  { key: 'store', head: 'Store', width: 22, list: 'stores', note: 'For stock on hand today. Leave the three stock columns empty for an item with none.' },
  { key: 'qty', head: 'Stock Qty', width: 12 },
  { key: 'rate', head: 'Stock Rate', width: 12, note: 'What one unit of the stock cost. Empty takes the Standard Rate.' },
  // Added on 27 Nov 2026, at the end so a sheet filled in before still reads.
  { key: 'designNo', head: 'Design No.', width: 14, note: 'Fabric only: its design number, exactly as it is known (120, 1164). Another design is another item, even with the same name.' },
  { key: 'color', head: 'Colour', width: 16, note: 'Fabric and thread: the colour of this item. Another colour is another item, even with the same name. Empty for anything else.' },
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
  'fixed asset': 'FIXED_ASSET',
  'fixed assets': 'FIXED_ASSET',
  asset: 'FIXED_ASSET',
}
/** How each type is shown, the same words the item list uses. */
const TYPE_LABEL: Record<string, string> = {
  RAW_MATERIAL: 'Raw Material',
  SEMI_FINISHED: 'Semi Finished',
  FINISHED_GOOD: 'Finished Good',
  CONSUMABLE: 'Consumable',
  PACKING_MATERIAL: 'Packing',
  TRIM: 'Trim',
  FIXED_ASSET: 'Fixed Asset',
}
const TYPE_LABELS = Object.values(TYPE_LABEL)

/** What one sticker goes on, as the item form names them. */
const PACK_LABEL: Record<PackType, string> = {
  PACKET: 'Packet',
  BOX: 'Box',
  ROLL: 'Roll',
  CARTON: 'Carton',
  BAG: 'Bag',
  BUNDLE: 'Bundle',
  OTHER: 'Other',
}
const PACK_LABELS = Object.values(PACK_LABEL)
const packOf = (s: string | undefined) => {
  const t = low(s)
  return (Object.keys(PACK_LABEL) as PackType[]).find((k) => low(k) === t || low(PACK_LABEL[k]) === t)
}

const low = (s: string | undefined | null) => (s ?? '').trim().toLowerCase()

/** The masters a sheet is matched against, loaded once. */
async function loadMasters() {
  const [categories, departments, units, stores, items] = await Promise.all([
    prisma.itemCategory.findMany({
      where: { isActive: true },
      select: { id: true, name: true, parentId: true, departmentId: true, itemGroup: true },
    }),
    // With one of its processes, if it has any: the sheet's dropdown offers
    // only the departments that are processes, as every Process box does.
    prisma.department.findMany({
      where: { isActive: true },
      select: { id: true, name: true, code: true, operations: { where: { isActive: true }, select: { id: true }, take: 1 } },
    }),
    prisma.uOM.findMany({ where: { isActive: true }, select: { id: true, name: true, symbol: true, decimalPlaces: true } }),
    prisma.warehouse.findMany({ where: { isActive: true }, select: { id: true, name: true, code: true } }),
    prisma.item.findMany({
      select: {
        id: true,
        code: true,
        name: true,
        isActive: true,
        type: true,
        standardRate: true,
        packType: true,
        packQty: true,
        decimalPlaces: true,
        ...ITEM_SHADE,
        category: { select: { name: true, parent: { select: { name: true } } } },
        department: { select: { name: true } },
        uom: { select: { name: true, decimalPlaces: true } },
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

  const sheet = addTemplateSheet(wb, 'Items', COLUMNS as unknown as SheetColumn[])
  // Text, so a design number typed as 0120 stays 0120 rather than becoming 120.
  sheet.getColumn('designNo').numFmt = '@'

  if (withItems) {
    for (const it of m.items.filter((i) => i.isActive).sort((a, b) => a.name.localeCompare(b.name) || a.code.localeCompare(b.code))) {
      const parent = it.category.parent?.name
      sheet.addRow({
        code: it.code,
        name: it.name,
        type: TYPE_LABEL[it.type] ?? it.type,
        category: parent ?? it.category.name,
        subCategory: parent ? it.category.name : '',
        department: it.department?.name ?? '',
        unit: it.uom.name,
        packType: it.packType ? PACK_LABEL[it.packType] : '',
        packQty: it.packQty != null && Number(it.packQty) > 0 ? Number(it.packQty) : '',
        // A finished good's colour is its style's, already in its name.
        designNo: it.styleId ? '' : (it.designNo ?? ''),
        color: it.styleId ? '' : (it.color ?? ''),
      })
    }
  }

  // Dropdowns on the first 2000 rows, so a pasted list still gets them.
  const mains = m.categories.filter((c) => !c.parentId)
  const subs = m.categories.filter((c) => c.parentId)
  addDropdowns(
    wb,
    sheet,
    COLUMNS as unknown as SheetColumn[],
    {
      types: TYPE_LABELS,
      categories: mains.map((c) => c.name).sort(),
      subCategories: [...new Set(subs.map((c) => c.name))].sort(),
      // Processes only (not Accounts, HR & Admin or Store); a name typed in is still read.
      departments: m.departments.filter((d) => d.operations.length > 0).map((d) => d.name).sort(),
      units: m.units.map((u) => u.name).sort(),
      stores: m.stores.map((s) => s.name).sort(),
      packTypes: PACK_LABELS,
    },
    MAX_ROWS,
  )

  addHowToSheet(wb, [
    'One row per item. Required: Item Name, Item Type, Category, Unit, Department; Sub Category when the category has sub-categories.',
    'Pick Type, Category, Sub Category, Department, Unit and Store from the dropdowns, so they match what is in the system.',
    "Department can be left empty: the item then takes its sub-category's department.",
    'A new item gets its code when it is saved. Put a code in Item Code only to point at an item already in the system.',
    'An item already in the system (same code; or same name, Design No. and Colour) is not changed. Only its stock is added, and its Sticker Package and Qty per Sticker when the row fills them in.',
    'Fabric: one row, and one item, for each design and colour, with its Design No. and Colour exactly as they are known. Thread: its Colour only. Leave both empty for anything else.',
    'Several items with one name (Cotton Twill in 1164 Navy and in 1165 Black): fill Design No. and Colour, or the Item Code, to say which one a row is for.',
    'Sticker Package and Qty per Sticker say how an item comes packed: a packet of 50 buttons is Packet and 50. When it comes in, it then gets one sticker a packet.',
    'Stock on hand today: fill Store, Stock Qty and Stock Rate. Empty Stock Rate takes the Standard Rate. Leave all three empty for no stock.',
    'The same item in two stores: two rows with the same name, Design No. and Colour, one per store.',
    'Opening stock can only be entered once for an item in a store. After that, correct it with a stock count.',
    'Nothing is saved until you have seen what each row will do and pressed Import. If any row has a problem, nothing is imported.',
  ])

  return Buffer.from(await wb.xlsx.writeBuffer())
}

// ─────────────────────────────────────────────────────────────
// Reading a filled sheet
// ─────────────────────────────────────────────────────────────

/** The rows of the Items sheet, keyed by the template's columns. */
export function readSheet(file: Buffer, fileName: string): Promise<Array<{ row: number; raw: Raw }>> {
  return readSheetRows(file, fileName, {
    columns: COLUMNS as unknown as SheetColumn<Key>[],
    sheetName: 'Items',
    mustHave: 'name',
    mustHaveLabel: 'Item Name',
    maxRows: MAX_ROWS,
  })
}

// ─────────────────────────────────────────────────────────────
// Working out what each row will do
// ─────────────────────────────────────────────────────────────

export interface RowPlan {
  row: number
  name: string
  /** A fabric's design and colour, a thread's colour: what tells same-name items apart. */
  designNo: string | null
  color: string | null
  /** Set on a finished good, whose colour is its style's. */
  styleId: string | null
  /** What happens to the item: made new, found already there, or nothing (a problem). */
  item: 'new' | 'existing' | 'none'
  code: string | null
  stock: { store: string; qty: number; rate: number } | null
  /** How it comes packed, set on the item by this row: "Packet of 50". */
  pack: string | null
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
  /** An item already in the system: how it comes packed, from this row. */
  packUpdate?: { packType?: PackType; packQty?: number }
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
  const catById = new Map(m.categories.map((c) => [c.id, c]))
  // An item is its name together with its design no. and colour: several
  // fabric items share a name (lib/fabric). A finished good's colour is its
  // style's, so it goes by its name alone.
  const keyOf = (name: string, designNo: string | null | undefined, color: string | null | undefined) =>
    `${low(name)}|${low(designNo)}|${low(color)}`
  const itemKeyOf = (i: (typeof m.items)[number]) => (i.styleId ? keyOf(i.name, null, null) : keyOf(i.name, i.designNo, i.color))
  const byKey = new Map(m.items.map((i) => [itemKeyOf(i), i]))
  const byName = new Map<string, typeof m.items>()
  for (const i of m.items) byName.set(low(i.name), [...(byName.get(low(i.name)) ?? []), i])

  // The first row naming an item defines it; later rows naming the same item
  // (name, design no. and colour) only add stock in another store.
  const seen = new Map<string, Resolved>()
  const seenByName = new Map<string, Resolved[]>()
  const stockKeys = new Set<string>()
  const out: Resolved[] = []

  for (const { row, raw } of rows) {
    const problems: string[] = []
    const name = (raw.name ?? '').trim()
    // A fabric's design number and colour, a thread's colour, exactly as typed.
    const designNo = cleanDesignNo(raw.designNo)
    const color = cleanColour(raw.color)
    const shaded = Boolean(designNo || color)
    const plan: RowPlan = {
      row,
      name,
      designNo,
      color,
      styleId: null,
      item: 'none',
      code: null,
      stock: null,
      pack: null,
      skipped: false,
      problems,
    }
    const res: Resolved = { plan, itemKey: keyOf(name, designNo, color) }

    // How it comes packed, when the row says.
    const packType = raw.packType ? packOf(raw.packType) : undefined
    if (raw.packType && !packType) problems.push(`Sticker Package "${raw.packType}" is not one of: ${PACK_LABELS.join(', ')}.`)
    const packQty = num(raw.packQty)
    if (packQty !== undefined && (Number.isNaN(packQty) || !(packQty > 0))) problems.push(`Qty per Sticker "${raw.packQty}" has to be a number more than nought.`)
    const pack = {
      ...(packType ? { packType } : {}),
      ...(packQty !== undefined && packQty > 0 ? { packQty } : {}),
    }
    const packBad = Boolean(raw.packType && !packType) || (packQty !== undefined && (Number.isNaN(packQty) || !(packQty > 0)))
    const packText = (t?: PackType, q?: number) => [t ? PACK_LABEL[t] : 'Sticker', q ? `of ${q}` : null].filter(Boolean).join(' ')

    // Which item this row is about: by its code; else by its name, design no.
    // and colour — in the system, or made by a row above; else, on a row with
    // neither (a sheet from before them), by its name when only one item has it.
    let existing = raw.code ? byCode.get(low(raw.code)) : undefined
    if (raw.code && !existing) problems.push(`No item with code ${raw.code} in the system. Leave Item Code empty for a new item.`)
    let first: Resolved | undefined
    let unsure = false
    if (!existing && name) {
      existing = byKey.get(keyOf(name, designNo, color))
      if (!existing) first = seen.get(keyOf(name, designNo, color))
      if (!existing && !first && !shaded) {
        const inSystem = byName.get(low(name)) ?? []
        const onSheet = seenByName.get(low(name)) ?? []
        if (inSystem.length + onSheet.length === 1) {
          existing = inSystem[0]
          first = onSheet[0]
        } else if (inSystem.length + onSheet.length > 1) {
          unsure = true
          const which = [
            ...inSystem.map((i) => `${i.code}: ${itemShadeText(i) || 'no design no. or colour'}`),
            ...onSheet.map((r) => `row ${r.plan.row}: ${itemShadeText(r.plan) || 'no design no. or colour'}`),
          ]
          problems.push(
            `${which.length} items are called ${name} (${which.slice(0, 4).join('; ')}${which.length > 4 ? '; …' : ''}). Fill in Design No. and Colour, or the Item Code, to say which one.`,
          )
        }
      }
    }
    if (!name && !existing) problems.push('Item Name is empty.')

    // An item already in the system keeps its design and colour: a row giving
    // others is not quietly passed over.
    const shadeBad = Boolean(
      existing &&
        ((designNo && low(designNo) !== low(existing.designNo)) || (color && low(color) !== low(existing.color))),
    )
    if (existing && shadeBad) {
      problems.push(
        `${existing.code} is ${itemShadeText({ designNo: existing.designNo, color: existing.color }) || 'set up with no design no. or colour'} in Masters → Items, and this row says ${itemShadeText({ designNo, color })}. An item already in the system is not changed here: change it in Masters → Items, or clear the Item Code to add a new item.`,
      )
    }

    if (existing) {
      res.itemKey = `id:${existing.id}`
      res.existingId = existing.id
      plan.item = 'existing'
      plan.code = existing.code
      plan.name = existing.name
      plan.designNo = existing.designNo
      plan.color = existing.color
      plan.styleId = existing.styleId
      if (!existing.isActive) problems.push(`${existing.code} is deactivated. Reactivate it first to add stock.`)
      // Only what differs from the item is set.
      const change = {
        ...(pack.packType && pack.packType !== existing.packType ? { packType: pack.packType } : {}),
        ...(pack.packQty && pack.packQty !== Number(existing.packQty ?? 0) ? { packQty: pack.packQty } : {}),
      }
      if (Object.keys(change).length) {
        res.packUpdate = change
        plan.pack = packText(pack.packType ?? existing.packType ?? undefined, pack.packQty ?? (existing.packQty != null ? Number(existing.packQty) : undefined))
      }
    } else if (first) {
      res.itemKey = first.itemKey
      plan.item = first.plan.item
      plan.code = first.plan.code
      plan.designNo = first.plan.designNo
      plan.color = first.plan.color
    } else if (name && !unsure) {
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
        // The type has to fit the category's tab, as on the item form.
        if (type && categoryId && !typeFitsGroup(type, main.itemGroup)) {
          problems.push(typeMismatchMessage(type, main.name, main.itemGroup))
        }
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

      // Design No. and Colour as the item form takes them (itemBeforeSave in
      // lib/itemMaster, in its words): a design number only under a Fabric
      // category, a colour under Fabric or Thread. Checked here against the
      // categories already loaded, so a long sheet is not a query a row.
      const filed = categoryId ? catById.get(categoryId) : undefined
      const above = filed?.parentId ? catById.get(filed.parentId) : undefined
      const cat = filed ? { name: filed.name, parent: above ? { name: above.name } : null } : null
      const notFinished = type !== 'FINISHED_GOOD'
      const fabric = notFinished && isFabricCategory(cat)
      const thread = notFinished && !fabric && isThreadCategory(cat)
      if (filed && designNo && !fabric) {
        problems.push('Design No. is for fabric. File the item under a Fabric category, or clear the Design No.')
      }
      if (filed && notFinished && color && !fabric && !thread) {
        problems.push('Colour is for fabric, thread and finished goods. File the item under a Fabric or Thread category, or clear the Colour.')
      }

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
          ...(fabric && designNo ? { designNo } : {}),
          ...((fabric || thread) && color ? { color } : {}),
          ...pack,
          ...Object.fromEntries(Object.entries(numbers).filter(([, v]) => v !== undefined)),
        }
        if (pack.packType || pack.packQty) plan.pack = packText(pack.packType, pack.packQty)
        const checked = createItemSchema.safeParse(candidate)
        if (!checked.success) problems.push(...checked.error.issues.map((i) => i.message))
        else res.create = { ...(checked.data as Record<string, unknown>), categoryId }
      }
      seen.set(res.itemKey, res)
      seenByName.set(low(name), [...(seenByName.get(low(name)) ?? []), res])
    }

    // Stock on hand today, if the row gives any.
    if (raw.store || raw.qty || raw.rate) {
      const s = store.get(low(raw.store))
      const qty = num(raw.qty)
      const standard = existing ? Number(existing.standardRate ?? 0) : ((first ?? res).create?.standardRate as number | undefined)
      const rate = num(raw.rate) ?? (standard && standard > 0 ? standard : undefined)
      if (!raw.store) problems.push('Stock Qty is given but Store is empty.')
      else if (!s) problems.push(`No store "${raw.store}".`)
      if (qty === undefined || Number.isNaN(qty) || !(qty > 0)) problems.push('Stock Qty has to be a number more than nought.')
      // 2.5 cartons is not stock: the item's own places, else its unit's (the row's for a new item).
      else {
        const places = existing ? qtyPlaces(existing) : qtyPlaces({ uom: unit.get(low(raw.unit)) ?? null })
        if (!fitsPlaces(qty, places)) problems.push(`Stock Qty ${qty}: ${placesMessage(places)}`)
      }
      if (rate === undefined || Number.isNaN(rate) || !(rate > 0)) {
        problems.push('Stock Rate is needed (or a Standard Rate on the item): stock at ₹0 would be worth nothing.')
      }
      if (s && qty && qty > 0 && rate && rate > 0) {
        const key = `${res.itemKey}|${s.id}`
        if (stockKeys.has(key)) {
          const shade = itemShadeText(plan)
          problems.push(`${plan.name || name}${shade ? ` (${shade})` : ''} is in ${s.name} twice on this sheet. Enter it once, with the total.`)
        }
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

    if (plan.item === 'existing' && !plan.stock && !raw.store && !raw.qty && !raw.rate && !res.packUpdate && !packBad && !shadeBad) {
      // Nothing asked of an item that is already there: not a problem, just
      // nothing to do, and any complaint about it being deactivated is moot.
      // A design no. or colour changed against it is said, not skipped past.
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
      const created: Array<{ code: string; name: string; designNo: string | null; color: string | null; styleId: string | null }> = []
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
          select: { id: true, code: true, name: true, ...ITEM_SHADE },
        })
        idByKey.set(p.itemKey, item.id)
        created.push({ code: item.code, name: item.name, designNo: item.designNo, color: item.color, styleId: item.styleId })
      }

      // How items already in the system come packed, where the sheet says.
      let packsSet = 0
      for (const p of plans) {
        if (!p.packUpdate || !p.existingId) continue
        await tx.item.update({ where: { id: p.existingId }, data: p.packUpdate })
        packsSet += 1
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

      return { reference, created, stockLines, packsSet }
    },
    // A few hundred rows over a pooler an ocean away take a while.
    { timeout: 300_000, maxWait: 20_000 },
  )
}
