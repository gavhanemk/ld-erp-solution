import ExcelJS from 'exceljs'
import type { Prisma } from '@prisma/client'
import { prisma } from '@ld-erp/database'
import { fitsPlaces, groupOfType, ITEM_GROUP_LABEL, placesMessage, qtyPlaces, type ItemGroup } from '@ld-erp/shared'
import { AppError } from '../middleware/errorHandler'
import { addDropdowns, addHowToSheet, addTemplateSheet, readSheetRows, type SheetColumn } from '../lib/sheet'
import { nextDocumentNumber } from '../lib/docNumber'
import { recordMovement } from './stock.service'
import { createPackages, packageRules, stickerDefaultsFrom } from './package.service'
import { floorFor } from './processFloor.service'

/*
 * Opening stock from the mill's own 19-column sheet, process by process.
 *
 * Raw materials go into the store named in Department / Location, each row
 * (a roll, a lot, a box) labelled as one package with its lot or roll number
 * when its category is labelled by package. Work in progress goes onto its
 * process's own floor (Cutting Floor, Stitching Floor…) — or the outside unit
 * named — size by size. Finished goods go into their store, size by size.
 * Order, style, colour, lot and bundle are kept on every line.
 *
 * Checked first, all or nothing: every row's item, category, unit, size,
 * quantity, rate and status, and nothing brought in twice — on the sheet,
 * across uploads, or on top of stock the ERP is already trading.
 */

export const MAX_ROWS = 3000
const REFERENCE = 'OPENING_IMPORT'

export type OsKey =
  | 'date' | 'process' | 'location' | 'order' | 'style' | 'code' | 'description' | 'category' | 'fabric'
  | 'colour' | 'size' | 'lot' | 'bundle' | 'uom' | 'qty' | 'rate' | 'value' | 'status' | 'remarks'

/** The sheet, exactly: these names, in this order (A to S). */
export const OS_COLUMNS: SheetColumn<OsKey>[] = [
  { key: 'date', head: 'Opening Date', width: 14, note: 'The day the stock was counted: 31-03-2026 or 2026-03-31. Not later than today.' },
  { key: 'process', head: 'Process', width: 16, list: 'processes', note: 'Store for stock in a store; the process (Cutting, Stitching…) for work in progress; Finished Goods for finished garments in a store.' },
  { key: 'location', head: 'Department / Location', width: 24, list: 'locations', note: "The store or outside unit holding it. For work in progress, empty (or the process) puts it on that process's own floor." },
  { key: 'order', head: 'Order No.', width: 16, note: 'The order the pieces belong to: SO or MO number, or the old order number.' },
  { key: 'style', head: 'Style / Article No.', width: 18, note: 'Finished goods: the style, which with Colour finds the item when Item Code is empty.' },
  { key: 'code', head: 'Item Code', width: 16, note: 'The item code in Items & Products.' },
  { key: 'description', head: 'Item Description', width: 30 },
  { key: 'category', head: 'Item Category', width: 18, note: "Checked against the item's category or subcategory." },
  { key: 'fabric', head: 'Fabric / Material', width: 18 },
  { key: 'colour', head: 'Colour', width: 12 },
  { key: 'size', head: 'Size', width: 8, note: 'Semi-finished and finished goods: the size, from the style\'s size run. Empty for raw materials.' },
  { key: 'lot', head: 'Lot / Batch / Roll No.', width: 18 },
  { key: 'bundle', head: 'Bundle / Barcode No.', width: 18 },
  { key: 'uom', head: 'UOM', width: 8, list: 'units', note: "The item's own unit: checked, never converted." },
  { key: 'qty', head: 'Opening Qty', width: 12 },
  { key: 'rate', head: 'Unit Rate', width: 12 },
  { key: 'value', head: 'Opening Value', width: 14, note: 'Opening Qty × Unit Rate. Either may be left out: the other is worked out.' },
  { key: 'status', head: 'Stock Status', width: 12, list: 'statuses', note: 'OK, Hold, Rejected or B-Grade. Empty is OK.' },
  { key: 'remarks', head: 'Remarks', width: 28 },
]

type Raw = Partial<Record<OsKey, string>>
export type OsStatus = 'OK' | 'HOLD' | 'REJECTED' | 'B_GRADE'
const STATUS_LABEL: Record<OsStatus, string> = { OK: 'OK', HOLD: 'Hold', REJECTED: 'Rejected', B_GRADE: 'B-Grade' }
/** What the stock goes in as: A usable, R held (not issued until released), B second quality. */
const STATUS_GRADE: Record<OsStatus, string> = { OK: 'A', HOLD: 'R', REJECTED: 'R', B_GRADE: 'B' }

const low = (s?: string | null) => (s ?? '').trim().toLowerCase()
/** Letters and digits only: "Kaj-Button" and "kaj button" are the same. */
const squash = (s?: string | null) => low(s).replace(/[^a-z0-9]/g, '')
/** …and a plural's s dropped: "Raw Materials" and "Raw Material" are the same. */
const stem = (s?: string | null) => squash(s).replace(/s$/, '')

const STATUS_WORDS: Record<OsStatus, string[]> = {
  OK: ['', 'ok', 'okay', 'good', 'fresh', 'available', 'usable', 'a', 'fine'],
  HOLD: ['hold', 'qchold', 'onhold', 'quarantine', 'held'],
  REJECTED: ['rejected', 'reject', 'rej', 'damaged', 'damage', 'defective', 'r'],
  B_GRADE: ['b', 'bgrade', 'second', 'seconds', '2nd'],
}
const STORE_WORDS = ['', 'store', 'stores', 'mainstore', 'rawmaterial', 'rawmaterials', 'rm', 'rmstore', 'rawmaterialstore', 'godown', 'warehouse', 'stock']
const FG_WORDS = ['finishedgoods', 'finishedgood', 'finished', 'fg', 'fgstore', 'finishedgoodsstore', 'packedstock', 'readystock']
const WIP_CATEGORY_WORDS = ['semifinished', 'semifinishedgood', 'wip', 'workinprogres', 'inproces']

/** Common ways of writing a unit, so "Pcs" on the sheet is the item's "pcs". */
const UNIT_ALIASES = [
  ['pcs', 'pc', 'piece', 'pieces', 'nos', 'no', 'number', 'numbers'],
  ['mtr', 'mtrs', 'm', 'meter', 'meters', 'metre', 'metres'],
  ['kg', 'kgs', 'kilogram', 'kilograms', 'kilo', 'kilos'],
  ['gm', 'gms', 'g', 'gram', 'grams'],
  ['box', 'boxes', 'bx'],
  ['roll', 'rolls'],
  ['set', 'sets'],
  ['pair', 'pairs', 'pr'],
  ['doz', 'dozen', 'dozens'],
  ['ctn', 'carton', 'cartons'],
  ['pkt', 'packet', 'packets'],
  ['ltr', 'litre', 'liter', 'litres', 'liters', 'l'],
  ['cone', 'cones'],
  ['yd', 'yard', 'yards'],
]
const unitWords = (u: string) => {
  const s = squash(u)
  return new Set([s, ...(UNIT_ALIASES.find((g) => g.includes(s)) ?? [])])
}

/** 2026-03-31, 31-03-2026 or 31/03/2026 — a day, or 'bad'. */
function parseDay(v?: string): Date | null | 'bad' {
  const t = (v ?? '').trim()
  if (!t) return null
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(t)
  let y: number, mo: number, d: number
  if (m) [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])]
  else if ((m = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/.exec(t))) [d, mo, y] = [Number(m[1]), Number(m[2]), Number(m[3])]
  else return 'bad'
  const out = new Date(Date.UTC(y, mo - 1, d, 6, 30))
  return out.getUTCMonth() === mo - 1 && out.getUTCDate() === d ? out : 'bad'
}
/** "1,250.5" as 1250.5; null when empty, NaN when not a number. */
function parseNum(v?: string): number | null {
  const t = (v ?? '').replace(/[,₹\s]/g, '').trim()
  if (!t) return null
  return /^-?\d+(\.\d+)?$/.test(t) ? Number(t) : NaN
}
const round2 = (n: number) => Math.round(n * 100) / 100
const round3 = (n: number) => Math.round(n * 1000) / 1000
const dmy = (d: Date) => d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' })

/** One row as the check found it: what goes where, or why it cannot. */
export interface OsRowPlan {
  row: number
  skipped: boolean
  problems: string[]
  /** The item's own group: what the rules go by. */
  group: ItemGroup | null
  /**
   * Where it stands for the summary: a garment or part at a process is
   * semi-finished (work in progress) whatever it will become; raw material
   * stays raw material wherever it lies.
   */
  stage: ItemGroup | null
  process: string
  location: string
  /** The process's floor is made on import: it has none yet. */
  newFloor: boolean
  item: { code: string; name: string } | null
  size: string | null
  order: string | null
  lot: string | null
  bundle: string | null
  qty: number | null
  unit: string | null
  rate: number | null
  value: number | null
  status: string
}

/** What posting needs for a row the check passed. */
interface Ready {
  date: Date
  departmentId: string | null
  warehouseId: string | null
  floorOf: string | null
  itemId: string
  categoryId: string
  sizeId: string | null
  grade: string
  status: OsStatus
  qty: number
  rate: number
  value: number
  orderNo: string | null
  lotNo: string | null
  bundleNo: string | null
  sticker: boolean
  raw: Raw
}
type Resolved = { plan: OsRowPlan; ready?: Ready }

async function loadMasters() {
  const [items, warehouses, departments, styles, sizes, units] = await Promise.all([
    prisma.item.findMany({
      where: { isActive: true },
      select: {
        id: true, code: true, name: true, type: true, color: true, styleId: true, decimalPlaces: true,
        categoryId: true, packType: true, packQty: true,
        category: { select: { name: true, itemGroup: true, isActive: true, parent: { select: { name: true, itemGroup: true } } } },
        uom: { select: { name: true, symbol: true, decimalPlaces: true } },
        style: { select: { code: true, name: true, sizeGroupId: true } },
      },
    }),
    prisma.warehouse.findMany({ where: { isActive: true }, select: { id: true, name: true, code: true, departmentId: true } }),
    prisma.department.findMany({
      where: { isActive: true },
      select: { id: true, name: true, code: true, operations: { where: { isActive: true }, select: { id: true }, take: 1 } },
    }),
    prisma.style.findMany({ select: { id: true, code: true, name: true, sizeGroupId: true } }),
    prisma.size.findMany({ select: { id: true, code: true, label: true, sizeGroupId: true } }),
    prisma.uOM.findMany({ where: { isActive: true }, select: { symbol: true } }),
  ])
  return { items, warehouses, departments, styles, sizes, units }
}

/** The template: the 19 columns in their order, dropdowns from the masters, and how to fill it. */
export async function buildTemplate(): Promise<Buffer> {
  const m = await loadMasters()
  const processes = m.departments.filter((d) => d.operations.length > 0).map((d) => d.name).sort()
  const wb = new ExcelJS.Workbook()
  const sheet = addTemplateSheet(wb, 'Opening Stock', OS_COLUMNS)
  addDropdowns(
    wb,
    sheet,
    OS_COLUMNS,
    {
      processes: ['Store', 'Finished Goods', ...processes],
      locations: m.warehouses.map((w) => w.name).sort(),
      units: m.units.map((u) => u.symbol).sort(),
      statuses: Object.values(STATUS_LABEL),
    },
    MAX_ROWS,
  )
  addHowToSheet(wb, [
    'One row per lot, roll, bundle or size: the same item may come in many rows.',
    'Process: Store for stock in a store, Finished Goods for finished garments in a store, or the process (' + processes.join(', ') + ') for work in progress.',
    "Department / Location: the store or outside unit holding it, as in Masters → Warehouses. For work in progress it may be left empty: it then goes on that process's own floor (made if it has none yet).",
    'Item Code must be in Items & Products. A finished garment can instead be found by Style / Article No. and Colour.',
    "Item Category and UOM are checked against the item; the quantity is never converted, so give it in the item's own unit.",
    "Size: for semi-finished and finished goods, from the style's size run (S, M, L…). Raw materials have no size.",
    'Opening Qty is required. Give Unit Rate or Opening Value, or both: they must agree (Qty × Rate).',
    'Stock Status: OK (usable), Hold (held until released), Rejected (held as rejected) or B-Grade (second-quality finished goods). Empty is OK.',
    'Opening Date: the day of the count, not later than today.',
    'Nothing is brought in twice: a row matching an earlier upload, or stock already moving in the ERP at that location, is refused. Correct those with a stock count.',
    `Up to ${MAX_ROWS} rows per upload; a bigger stock can go in several uploads.`,
  ])
  return Buffer.from(await wb.xlsx.writeBuffer())
}

export function readSheet(file: Buffer, fileName: string) {
  return readSheetRows<OsKey>(file, fileName, {
    columns: OS_COLUMNS,
    sheetName: 'Opening Stock',
    mustHave: 'qty',
    mustHaveLabel: 'Opening Qty',
    maxRows: MAX_ROWS,
  })
}

/** Every row checked; nothing written. */
export async function planImport(rows: Array<{ row: number; raw: Raw }>): Promise<Resolved[]> {
  const m = await loadMasters()
  const processByName = new Map<string, (typeof m.departments)[number]>()
  for (const d of m.departments) {
    processByName.set(squash(d.name), d)
    processByName.set(squash(d.code), d)
  }
  const warehouseByName = new Map<string, (typeof m.warehouses)[number]>()
  for (const w of m.warehouses) {
    warehouseByName.set(squash(w.code), w)
    warehouseByName.set(squash(w.name), w)
  }
  const floorByProcess = new Map(m.warehouses.filter((w) => w.departmentId).map((w) => [w.departmentId!, w]))
  const itemByCode = new Map(m.items.map((i) => [low(i.code), i]))
  const itemsByName = new Map<string, typeof m.items>()
  for (const i of m.items) itemsByName.set(low(i.name), [...(itemsByName.get(low(i.name)) ?? []), i])
  const styleByKey = new Map<string, (typeof m.styles)[number]>()
  for (const s of m.styles) {
    styleByKey.set(squash(s.code), s)
    if (!styleByKey.has(squash(s.name))) styleByKey.set(squash(s.name), s)
  }
  const fgByStyleColour = new Map(m.items.filter((i) => i.styleId && i.color).map((i) => [`${i.styleId}|${squash(i.color)}`, i]))
  const sizesOfGroup = new Map<string, Map<string, (typeof m.sizes)[number]>>()
  const sizesByCode = new Map<string, typeof m.sizes>()
  for (const s of m.sizes) {
    const g = sizesOfGroup.get(s.sizeGroupId) ?? new Map()
    g.set(squash(s.code), s)
    if (!g.has(squash(s.label))) g.set(squash(s.label), s)
    sizesOfGroup.set(s.sizeGroupId, g)
    sizesByCode.set(squash(s.code), [...(sizesByCode.get(squash(s.code)) ?? []), s])
  }
  // The end of today in India: a sheet dated today is never "later than
  // today", whatever the hour (a day is read as noon, India time).
  const india = new Date(Date.now() + 330 * 60 * 1000)
  const endOfToday = Date.UTC(india.getUTCFullYear(), india.getUTCMonth(), india.getUTCDate() + 1) - 330 * 60 * 1000

  const out: Resolved[] = []
  for (const { row, raw } of rows) {
    const problems: string[] = []
    const plan: OsRowPlan = {
      row, skipped: false, problems, group: null, stage: null, process: (raw.process ?? '').trim() || 'Store', location: (raw.location ?? '').trim(),
      newFloor: false, item: null, size: (raw.size ?? '').trim() || null, order: (raw.order ?? '').trim() || null,
      lot: (raw.lot ?? '').trim() || null, bundle: (raw.bundle ?? '').trim() || null, qty: null, unit: null,
      rate: null, value: null, status: STATUS_LABEL.OK,
    }
    if (Object.values(raw).every((v) => !(v ?? '').trim())) {
      plan.skipped = true
      out.push({ plan })
      continue
    }

    // Opening Date.
    const date = parseDay(raw.date)
    if (date === null) problems.push('Opening Date is empty.')
    else if (date === 'bad') problems.push(`Opening Date "${raw.date}" is not a date: write it as 31-03-2026.`)
    else if (date.getTime() >= endOfToday) problems.push(`Opening Date ${dmy(date)} is later than today.`)

    // Process: a store, finished goods in a store, or one of the processes.
    const procText = squash(raw.process)
    let kind: 'STORE' | 'FG' | 'PROCESS' | null = null
    let process: (typeof m.departments)[number] | null = null
    if (STORE_WORDS.includes(procText)) kind = 'STORE'
    else if (FG_WORDS.includes(procText)) {
      kind = 'FG'
      plan.process = 'Finished Goods'
    } else {
      const d = processByName.get(procText)
      if (!d) problems.push(`Process "${raw.process}" is not one: Store, Finished Goods, or a process in Routing Masters.`)
      else if (!d.operations.length) problems.push(`${d.name} is a department, not a process. Use Store for stock in a store, or a process such as Cutting.`)
      else {
        kind = 'PROCESS'
        process = d
        plan.process = d.name
      }
    }

    // Department / Location: where it lies.
    let warehouseId: string | null = null
    let floorOf: string | null = null
    const locText = squash(raw.location)
    if (kind === 'PROCESS' && process) {
      const floor = floorByProcess.get(process.id)
      const isFloor =
        !locText ||
        locText === squash(process.name) ||
        locText === squash(process.code) ||
        locText === squash(`${process.name} floor`) ||
        (floor && (locText === squash(floor.name) || locText === squash(floor.code)))
      if (isFloor) {
        if (floor) {
          warehouseId = floor.id
          plan.location = floor.name
        } else {
          floorOf = process.id
          plan.location = `${process.name} Floor`
          plan.newFloor = true
        }
      } else {
        const w = warehouseByName.get(locText)
        if (w) {
          warehouseId = w.id
          plan.location = w.name
        } else {
          problems.push(`No location named "${raw.location}". Leave it empty for ${process.name}'s own floor, or add the location in Masters → Warehouses.`)
        }
      }
    } else if (kind) {
      if (!locText) problems.push('Department / Location is empty: name the store it is in.')
      else {
        const w = warehouseByName.get(locText)
        if (w) {
          warehouseId = w.id
          plan.location = w.name
        } else problems.push(`No store named "${raw.location}". Use one in Masters → Warehouses.`)
      }
    }

    // The item: by code, else a finished garment by style and colour, else by name.
    let item: (typeof m.items)[number] | null = null
    const style = (raw.style ?? '').trim() ? styleByKey.get(squash(raw.style)) ?? null : null
    if ((raw.code ?? '').trim()) {
      item = itemByCode.get(low(raw.code)) ?? null
      if (!item) problems.push(`No item with code ${raw.code} in Items & Products.`)
    } else if (style && (raw.colour ?? '').trim()) {
      item = fgByStyleColour.get(`${style.id}|${squash(raw.colour)}`) ?? null
      if (!item) problems.push(`No finished item for ${style.code} in ${raw.colour}. Add it in Items & Products, or give its Item Code.`)
    } else if ((raw.description ?? '').trim()) {
      const named = itemsByName.get(low(raw.description)) ?? []
      if (named.length === 1) item = named[0]
      else if (named.length > 1) problems.push(`"${raw.description}" is the name of ${named.length} items: give the Item Code.`)
      else problems.push(`No item named "${raw.description}": give the Item Code.`)
    } else problems.push('Item Code is empty.')

    let sizeId: string | null = null
    if (item) {
      plan.item = { code: item.code, name: item.name }
      const group = groupOfType(item.type)
      plan.group = group
      plan.stage = kind === 'PROCESS' && group !== 'RAW_MATERIALS' ? 'SEMI_FINISHED' : group
      plan.unit = item.uom?.symbol ?? null
      if (!item.category?.isActive) problems.push(`${item.code} is filed under ${item.category?.name}, which is switched off.`)

      // Finished Goods rows hold finished goods.
      if (kind === 'FG' && group !== 'FINISHED_GOODS') problems.push(`A Finished Goods row, but ${item.code} is ${ITEM_GROUP_LABEL[group].toLowerCase()}.`)

      // Category, as the sheet says it.
      const cat = stem(raw.category)
      if (cat) {
        const names = [item.category?.name, item.category?.parent?.name, ITEM_GROUP_LABEL[(item.category?.parent?.itemGroup ?? item.category?.itemGroup ?? 'RAW_MATERIALS') as ItemGroup]].map(stem)
        if (!names.includes(cat) && !(kind === 'PROCESS' && WIP_CATEGORY_WORDS.includes(cat))) {
          problems.push(`${item.code} is filed under ${[item.category?.parent?.name, item.category?.name].filter(Boolean).join(' › ')}, not "${raw.category}".`)
        }
      }

      // Unit: checked, never converted.
      if ((raw.uom ?? '').trim() && item.uom) {
        const own = new Set([...unitWords(item.uom.symbol), ...unitWords(item.uom.name ?? '')])
        if (![...unitWords(raw.uom!)].some((u) => own.has(u))) problems.push(`${item.code} is counted in ${item.uom.symbol}, not ${raw.uom}. Give the quantity in ${item.uom.symbol}.`)
      }

      // A finished garment's style and colour must be its own.
      if (item.styleId && item.style) {
        if (style && style.id !== item.styleId) problems.push(`${item.code} is style ${item.style.code}, not ${raw.style}.`)
        if ((raw.colour ?? '').trim() && item.color && squash(raw.colour) !== squash(item.color)) problems.push(`${item.code} is ${item.color}, not ${raw.colour}.`)
      }

      // Size: garments and parts by size; raw materials have none.
      const sizeText = squash(raw.size)
      const run = item.style?.sizeGroupId ?? (style?.sizeGroupId ?? null)
      if (group === 'RAW_MATERIALS') {
        if (sizeText) problems.push(`${item.code} is a raw material, which is kept without sizes. Leave Size empty, or put it in Remarks.`)
      } else if (sizeText) {
        if (run) {
          const s = sizesOfGroup.get(run)?.get(sizeText)
          if (s) {
            sizeId = s.id
            plan.size = s.code
          } else problems.push(`Size ${raw.size} is not in the size run of ${item.style?.code ?? style?.code}.`)
        } else {
          const candidates = sizesByCode.get(sizeText) ?? []
          if (candidates.length === 1) {
            sizeId = candidates[0].id
            plan.size = candidates[0].code
          } else if (candidates.length > 1) problems.push(`Size ${raw.size} is in ${candidates.length} size runs: give the Style / Article No. to say which.`)
          else problems.push(`No size ${raw.size} in any size run.`)
        }
      } else if (group === 'FINISHED_GOODS' && item.style?.sizeGroupId) {
        problems.push(`${item.code} comes in sizes: give the Size.`)
      }

      // Quantity, in the places the item allows.
      const qty = parseNum(raw.qty)
      if (qty === null) problems.push('Opening Qty is empty.')
      else if (Number.isNaN(qty)) problems.push(`Opening Qty "${raw.qty}" is not a number.`)
      else if (!(qty > 0)) problems.push('Opening Qty has to be more than nought.')
      else {
        plan.qty = round3(qty)
        const places = qtyPlaces(item)
        if (!fitsPlaces(qty, places)) problems.push(`Opening Qty ${qty}: ${placesMessage(places)}`)
      }
    } else {
      const qty = parseNum(raw.qty)
      if (qty !== null && !Number.isNaN(qty)) plan.qty = round3(qty)
    }

    // Rate and value: either may be left out; given both, they must agree.
    const rate = parseNum(raw.rate)
    const value = parseNum(raw.value)
    if (rate !== null && (Number.isNaN(rate) || rate < 0)) problems.push(`Unit Rate "${raw.rate}" is not a rate.`)
    if (value !== null && (Number.isNaN(value) || value < 0)) problems.push(`Opening Value "${raw.value}" is not an amount.`)
    if (plan.qty && plan.qty > 0) {
      if (rate !== null && !Number.isNaN(rate) && rate >= 0) {
        plan.rate = round2(rate)
        plan.value = round2(plan.qty * rate)
        if (value !== null && !Number.isNaN(value) && Math.abs(plan.qty * rate - value) > Math.max(1, value * 0.005)) {
          problems.push(`${plan.qty} × ₹${rate} is ₹${round2(plan.qty * rate)}, but Opening Value says ₹${value}.`)
        }
      } else if (value !== null && !Number.isNaN(value) && value >= 0) {
        plan.rate = round2(value / plan.qty)
        plan.value = round2(value)
      } else if (rate === null && value === null) problems.push('Give the Unit Rate or the Opening Value.')
    }

    // Stock Status.
    const statusText = squash(raw.status)
    const status = (Object.keys(STATUS_WORDS) as OsStatus[]).find((s) => STATUS_WORDS[s].includes(statusText)) ?? null
    if (!status) problems.push(`Stock Status "${raw.status}" is not one of: OK, Hold, Rejected, B-Grade.`)
    else {
      plan.status = STATUS_LABEL[status]
      if (status === 'B_GRADE' && plan.group === 'RAW_MATERIALS') problems.push('B-Grade is for semi-finished and finished goods, not raw materials.')
      if (status === 'OK' && plan.rate === 0) problems.push('Unit Rate is nought: give the rate the stock is valued at.')
    }

    const ready =
      !problems.length && item && date instanceof Date && status && plan.qty !== null && plan.rate !== null && (warehouseId || floorOf)
        ? ({
            date,
            departmentId: process?.id ?? null,
            warehouseId,
            floorOf,
            itemId: item.id,
            categoryId: item.categoryId,
            sizeId,
            grade: STATUS_GRADE[status],
            status,
            qty: plan.qty,
            rate: plan.rate,
            value: plan.value ?? round2(plan.qty * plan.rate),
            orderNo: plan.order,
            lotNo: plan.lot,
            bundleNo: plan.bundle,
            sticker: false,
            raw,
          } satisfies Ready)
        : undefined
    out.push({ plan, ready })
  }

  await checkDuplicates(out)
  return out
}

/** Where a row's stock sits, for telling one row from another: a floor not made yet goes by its process. */
const placeOf = (r: Ready) => r.warehouseId ?? `floor:${r.floorOf}`
const dedupeKey = (r: Ready, warehouseId: string) =>
  [r.itemId, warehouseId, r.sizeId ?? '', r.grade, squash(r.orderNo), squash(r.lotNo), squash(r.bundleNo)].join('|')

/**
 * Nothing in twice: the same item, place, size, status, order, lot and bundle
 * on two rows; a row already brought in by an earlier upload; or stock that
 * is already moving in the ERP at that place, which a count corrects instead.
 */
async function checkDuplicates(resolved: Resolved[]) {
  const seen = new Map<string, number>()
  for (const r of resolved) {
    if (!r.ready) continue
    const key = dedupeKey(r.ready, placeOf(r.ready))
    const earlier = seen.get(key)
    if (earlier) {
      r.plan.problems.push(`Same as row ${earlier}: item, location, size, status, order, lot and bundle all match. Put them on one row with the total.`)
      r.ready = undefined
    } else seen.set(key, r.plan.row)
  }

  const ready = resolved.filter((r) => r.ready?.warehouseId)
  if (!ready.length) return
  const keys = ready.map((r) => dedupeKey(r.ready!, r.ready!.warehouseId!))
  const already = await prisma.openingStockLine.findMany({
    where: { dedupeKey: { in: keys } },
    select: { dedupeKey: true, rowNo: true, openingStock: { select: { number: true } } },
  })
  const alreadyByKey = new Map(already.map((a) => [a.dedupeKey, a]))

  const itemIds = [...new Set(ready.map((r) => r.ready!.itemId))]
  const warehouseIds = [...new Set(ready.map((r) => r.ready!.warehouseId!))]
  const [trading, openings, floors] = await Promise.all([
    prisma.stockLedger.groupBy({
      by: ['itemId', 'warehouseId', 'sizeId', 'grade', 'orderNo'],
      where: { itemId: { in: itemIds }, warehouseId: { in: warehouseIds }, NOT: { referenceType: REFERENCE } },
      _min: { transactionDate: true },
    }),
    prisma.stockLedger.groupBy({
      by: ['itemId', 'warehouseId', 'sizeId', 'grade'],
      where: { itemId: { in: itemIds }, warehouseId: { in: warehouseIds }, referenceType: REFERENCE },
      _max: { transactionDate: true },
    }),
    prisma.warehouse.findMany({ where: { id: { in: warehouseIds }, departmentId: { not: null } }, select: { id: true } }),
  ])
  const spot = (x: { itemId: string; warehouseId: string; sizeId: string | null; grade: string }) => `${x.itemId}|${x.warehouseId}|${x.sizeId ?? ''}|${x.grade}`
  // Movement since, at each spot and for each order there. On a process floor
  // every piece carries its order, so a row for an order is held back only by
  // that order's movement: another order's pieces found later can still come
  // in. In a store, receipts carry no order, so any movement holds a row back.
  const tradingSince = new Map<string, Date>()
  for (const t of trading) {
    const at = t._min.transactionDate
    if (!at) continue
    for (const k of [spot(t), `${spot(t)}|${squash(t.orderNo)}`]) {
      const was = tradingSince.get(k)
      if (!was || at < was) tradingSince.set(k, at)
    }
  }
  const onFloor = new Set(floors.map((w) => w.id))
  const openedUpTo = new Map(openings.map((t) => [spot(t), t._max.transactionDate]))

  for (const r of ready) {
    const d = r.ready!
    const key = dedupeKey(d, d.warehouseId!)
    const a = alreadyByKey.get(key)
    if (a) {
      r.plan.problems.push(`Already brought in on ${a.openingStock.number}, row ${a.rowNo}.`)
      r.ready = undefined
      continue
    }
    const s = spot({ itemId: d.itemId, warehouseId: d.warehouseId!, sizeId: d.sizeId, grade: d.grade })
    const byOrder = Boolean(d.orderNo) && onFloor.has(d.warehouseId!)
    const since = tradingSince.get(byOrder ? `${s}|${squash(d.orderNo)}` : s)
    if (since) {
      r.plan.problems.push(
        `${r.plan.item?.code}${byOrder ? ` for order ${d.orderNo}` : ''} already has stock moving at ${r.plan.location}${r.plan.size ? `, size ${r.plan.size}` : ''} since ${dmy(since)}. Opening stock is brought in once; put a difference right with a stock count.`,
      )
      r.ready = undefined
      continue
    }
    const upTo = openedUpTo.get(s)
    if (upTo && d.date.getTime() < new Date(upTo).setUTCHours(0, 0, 0, 0)) {
      r.plan.problems.push(`Opening Date ${dmy(d.date)} is before the opening already brought in here on ${dmy(upTo)}: give that date or later.`)
      r.ready = undefined
    }
  }
}

export function summarise(resolved: Resolved[]) {
  const lines = resolved.filter((r) => r.ready)
  const byPlace = new Map<string, { process: string; location: string; group: string; lines: number; qty: number; value: number }>()
  const byGroup = new Map<string, { lines: number; value: number }>()
  for (const r of lines) {
    const k = `${r.plan.process}|${r.plan.location}`
    const p = byPlace.get(k) ?? { process: r.plan.process, location: r.plan.location, group: r.plan.stage ?? '', lines: 0, qty: 0, value: 0 }
    p.lines += 1
    p.qty = round3(p.qty + (r.plan.qty ?? 0))
    p.value = round2(p.value + (r.plan.value ?? 0))
    byPlace.set(k, p)
    const g = byGroup.get(r.plan.stage ?? '') ?? { lines: 0, value: 0 }
    g.lines += 1
    g.value = round2(g.value + (r.plan.value ?? 0))
    byGroup.set(r.plan.stage ?? '', g)
  }
  return {
    rows: resolved.filter((r) => !r.plan.skipped).length,
    lines: lines.length,
    skipped: resolved.filter((r) => r.plan.skipped).length,
    problems: resolved.filter((r) => r.plan.problems.length).length,
    value: round2(lines.reduce((s, r) => s + (r.plan.value ?? 0), 0)),
    floorsToMake: [...new Set(lines.filter((r) => r.plan.newFloor).map((r) => r.plan.location))],
    byGroup: [...byGroup].map(([group, g]) => ({ group, label: ITEM_GROUP_LABEL[group as ItemGroup] ?? group, ...g })),
    byPlace: [...byPlace.values()],
  }
}

/** Posts every row, in one transaction: stock in, floors made, stickers made, the sheet kept. */
export async function runImport(resolved: Resolved[], opts: { fileName: string; userId: string | null }) {
  if (resolved.some((r) => r.plan.problems.length > 0)) {
    throw new AppError('Some rows have problems. Fix them and upload the sheet again.', 400, 'IMPORT_HAS_PROBLEMS')
  }
  const rows = resolved.filter((r) => r.ready)
  if (!rows.length) throw new AppError('The sheet has no rows to bring in.', 400, 'NOTHING_TO_IMPORT')

  return prisma.$transaction(
    async (tx) => {
      const latest = rows.reduce((d, r) => (r.ready!.date > d ? r.ready!.date : d), rows[0].ready!.date)
      const number = await nextDocumentNumber(tx, 'OPS', latest)
      const doc = await tx.openingStock.create({ data: { number, fileName: opts.fileName, createdById: opts.userId } })

      // Floors for the processes that have none yet.
      const floors = new Map<string, string>()
      const made: string[] = []
      for (const r of rows) {
        const d = r.ready!
        if (d.warehouseId || !d.floorOf) continue
        if (!floors.has(d.floorOf)) {
          const before = await tx.warehouse.findUnique({ where: { departmentId: d.floorOf }, select: { id: true } })
          const floor = await floorFor(tx, d.floorOf)
          if (!before) made.push(floor.name)
          floors.set(d.floorOf, floor.id)
        }
        d.warehouseId = floors.get(d.floorOf)!
      }

      const items = await tx.item.findMany({
        where: { id: { in: [...new Set(rows.map((r) => r.ready!.itemId))] } },
        select: { id: true, name: true, categoryId: true, packType: true, packQty: true, uom: { select: { symbol: true, name: true } } },
      })
      const itemById = new Map(items.map((i) => [i.id, i]))
      const ruleOf = await packageRules(tx)

      // Earliest first, so each place's stock is dated in order.
      const ordered = [...rows].sort((a, b) => a.ready!.date.getTime() - b.ready!.date.getTime() || a.plan.row - b.plan.row)
      let stickers = 0
      for (const r of ordered) {
        const d = r.ready!
        const note = [`${number} row ${r.plan.row}`, d.bundleNo ? `bundle ${d.bundleNo}` : null, (d.raw.remarks ?? '').trim() || null].filter(Boolean).join(' · ')
        await recordMovement(tx, {
          itemId: d.itemId,
          warehouseId: d.warehouseId!,
          transactionType: 'OPENING',
          direction: 'IN',
          qty: d.qty,
          unitRate: d.rate,
          referenceType: REFERENCE,
          referenceId: doc.id,
          batchNumber: d.lotNo,
          orderNo: d.orderNo,
          sizeId: d.sizeId,
          grade: d.grade,
          transactionDate: d.date,
          notes: note.slice(0, 500),
          stickers: 'caller',
        })

        // One labelled package per row (a roll, a lot, a box), where the
        // category is labelled by package. Garments by size are not.
        let packageId: string | null = null
        const item = itemById.get(d.itemId)!
        const defaults = stickerDefaultsFrom(item, ruleOf(item.categoryId))
        if (defaults.tracked && !d.sizeId && d.grade !== 'B') {
          const [pkg] = await createPackages(tx, {
            spot: { itemId: d.itemId, warehouseId: d.warehouseId!, ownership: 'OWNED', ownerCustomerId: null },
            packType: defaults.packType,
            qtys: [d.qty],
            lotNo: d.lotNo,
            notes: d.bundleNo ? `Barcode ${d.bundleNo}`.slice(0, 120) : null,
            sourceType: 'OPENING',
            sourceId: doc.id,
            sourceRef: number,
            userId: opts.userId,
            unit: item.uom?.symbol ?? '',
            itemName: item.name,
            grade: d.grade,
          })
          packageId = pkg?.id ?? null
          if (packageId) stickers += 1
        }

        const raw = d.raw
        await tx.openingStockLine.create({
          data: {
            openingStockId: doc.id,
            rowNo: r.plan.row,
            openingDate: d.date,
            processText: (raw.process ?? '').trim() || null,
            departmentId: d.departmentId,
            locationText: (raw.location ?? '').trim() || null,
            warehouseId: d.warehouseId!,
            orderNo: d.orderNo,
            styleText: (raw.style ?? '').trim() || null,
            itemId: d.itemId,
            itemCodeText: (raw.code ?? '').trim() || null,
            description: (raw.description ?? '').trim() || null,
            categoryText: (raw.category ?? '').trim() || null,
            fabricText: (raw.fabric ?? '').trim() || null,
            colour: (raw.colour ?? '').trim() || null,
            sizeId: d.sizeId,
            sizeText: (raw.size ?? '').trim() || null,
            lotNo: d.lotNo,
            bundleNo: d.bundleNo,
            uomText: (raw.uom ?? '').trim() || null,
            qty: d.qty,
            unitRate: d.rate,
            value: d.value,
            status: d.status,
            grade: d.grade,
            remarks: (raw.remarks ?? '').trim() || null,
            packageId,
            dedupeKey: dedupeKey(d, d.warehouseId!),
          },
        })
      }
      return { id: doc.id, number, lines: rows.length, stickers, floorsMade: made }
    },
    { timeout: 300_000, maxWait: 20_000 },
  )
}
