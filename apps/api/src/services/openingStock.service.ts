import ExcelJS from 'exceljs'
import type { PackType, Prisma } from '@prisma/client'
import { prisma } from '@ld-erp/database'
import { fitsPlaces, groupOfType, ITEM_GROUP_LABEL, placesMessage, qtyPlaces, type ItemGroup } from '@ld-erp/shared'
import { AppError } from '../middleware/errorHandler'
import { addDropdowns, addHowToSheet, addTemplateSheet, readSheetRows, type SheetColumn } from '../lib/sheet'
import { nextDocumentNumber } from '../lib/docNumber'
import { recordMovement } from './stock.service'
import { createPackages, packageRules, positionsOf, stickerDefaultsFrom, suggestQtys } from './package.service'
import { floorFor } from './processFloor.service'
import { withGeneratedCode } from '../lib/masterCode'
import { trackedRoutings } from './styleTrack.service'

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
  /** Only on the Semi Finished Goods template: checked against the process. */
  | 'department'
  /** Raw Materials template, optional: how the row's stock is packed. */
  | 'packType' | 'packCount' | 'packEach' | 'packQtys' | 'packRefs'

/**
 * The three kinds opening stock is entered as, each with its own screen and
 * template: finished garments in a store, semi-finished pieces at a process
 * on their style's route, raw materials in a store. The 19-column sheet holds
 * all three.
 */
export type OsKind = 'FG' | 'SFG' | 'RM'
export const KIND_LABEL: Record<OsKind, string> = { FG: 'Finished Goods', SFG: 'Semi Finished Goods', RM: 'Raw Materials' }

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
  { key: 'rate', head: 'Unit Rate', width: 12, note: 'Optional. Empty with no Opening Value: valued at nought.' },
  { key: 'value', head: 'Opening Value', width: 14, note: 'Opening Qty × Unit Rate. Either may be left out: the other is worked out.' },
  { key: 'status', head: 'Stock Status', width: 12, list: 'statuses', note: 'OK, Hold, Rejected or B-Grade. Empty is OK.' },
  { key: 'remarks', head: 'Remarks', width: 28 },
]

/** Each kind's template: only its own columns, in this order. */
export const TYPE_COLUMNS: Record<OsKind, SheetColumn<OsKey>[]> = {
  FG: [
    { key: 'style', head: 'Style / Article No.', width: 18, list: 'styles', note: 'The style, as in Masters → Styles.' },
    { key: 'code', head: 'Item Code', width: 16, note: 'May be left empty: the style and colour find the item.' },
    { key: 'colour', head: 'Colour', width: 14, note: "One of the style's colours." },
    { key: 'size', head: 'Size', width: 8, note: "From the style's size run." },
    { key: 'qty', head: 'Opening Quantity', width: 15, note: 'Pieces.' },
    { key: 'rate', head: 'Rate Per Piece', width: 14, note: 'Optional. Empty: valued at nought.' },
    { key: 'location', head: 'Location', width: 22, list: 'stores', note: 'The finished goods store.' },
    { key: 'status', head: 'Stock Status', width: 12, list: 'statuses', note: 'OK, Hold, Rejected or B-Grade. Empty is OK.' },
    { key: 'remarks', head: 'Remarks', width: 24 },
  ],
  SFG: [
    { key: 'style', head: 'Style / Article No.', width: 18, list: 'styles', note: 'The style, as in Masters → Styles.' },
    { key: 'process', head: 'Process', width: 16, list: 'processes', note: "Where the pieces are now: a process on the style's route." },
    { key: 'colour', head: 'Colour', width: 14, note: "One of the style's colours." },
    { key: 'size', head: 'Size', width: 8, note: "From the style's size run." },
    { key: 'qty', head: 'Opening Quantity', width: 15, note: 'Pieces.' },
    { key: 'rate', head: 'Rate / Valuation', width: 15, note: 'Optional: what one piece is valued at, at this stage. Empty: nought.' },
    { key: 'department', head: 'Department', width: 16, list: 'processes', note: 'May be left empty: the process says it.' },
    { key: 'location', head: 'Location', width: 22, list: 'locations', note: "Empty puts the pieces on the process's own floor; name an outside unit when they are there." },
    { key: 'order', head: 'Order Reference', width: 16, note: 'Optional: SO, MO or old order number.' },
    { key: 'bundle', head: 'Batch / Bundle Reference', width: 20, note: 'Optional.' },
    { key: 'status', head: 'Stock Status', width: 12, list: 'statuses', note: 'OK, Hold, Rejected or B-Grade. Empty is OK.' },
    { key: 'remarks', head: 'Remarks', width: 24 },
  ],
  RM: [
    { key: 'category', head: 'Material Category', width: 18, list: 'materials', note: "Checked against the item's category." },
    { key: 'code', head: 'Item Code', width: 16, note: 'The item code in Items & Products.' },
    { key: 'description', head: 'Item Name', width: 28, note: 'May be left empty when the code is given.' },
    { key: 'lot', head: 'Lot / Batch / Roll Number', width: 20 },
    { key: 'bundle', head: 'Bundle / Barcode Number', width: 20 },
    { key: 'uom', head: 'UOM', width: 8, list: 'units', note: "The item's own unit: checked, never converted." },
    { key: 'qty', head: 'Opening Quantity', width: 15 },
    { key: 'rate', head: 'Unit Rate', width: 12, note: 'Optional. Empty: valued at nought.' },
    { key: 'location', head: 'Location', width: 22, list: 'stores', note: 'The store it is in.' },
    { key: 'packType', head: 'Package Type', width: 12, list: 'packTypes', note: 'Optional: Roll, Box, Carton, Bag, Bundle, Packet or Other. Empty: the item’s usual.' },
    { key: 'packCount', head: 'Package Count', width: 12, note: 'Optional: how many packages. With no sizes, the stock comes in and the stickers wait until the sizes are known — equal sizes are never assumed.' },
    { key: 'packEach', head: 'Qty per Package', width: 13, note: 'Optional: what one full package holds. 1,200 at 500 is 500 + 500 + 200.' },
    { key: 'packQtys', head: 'Package Quantities', width: 24, note: 'Optional: each package, separated by commas: 200, 250, 150, 180, 220. Less than the row leaves the rest without stickers.' },
    { key: 'packRefs', head: 'Package References', width: 22, note: "Optional: each package's own number (the supplier's roll no.), in the same order, separated by commas." },
    { key: 'status', head: 'Stock Status', width: 12, list: 'statuses', note: 'OK, Hold or Rejected. Empty is OK.' },
    { key: 'remarks', head: 'Remarks', width: 24 },
  ],
}

/**
 * How a row's stock goes on stickers, as given on the screen or the sheet:
 * each package's quantity, or what one full package holds, or only how many
 * there are (their sizes to give later) — or that it waits. Nothing given
 * follows the row's own barcode (one package), else the item's own qty per
 * sticker; with neither, the stock waits without stickers rather than one
 * made-up sticker for the lot.
 */
export interface PackInput {
  type?: PackType | null
  qtys?: number[] | null
  each?: number | null
  count?: number | null
  later?: boolean | null
  refs?: Array<string | null> | null
}
/** What will be made for a row: its stickers' quantities, or none yet. */
interface PackPlan {
  packType: PackType
  qtys: number[]
  /** Each package's own reference (the supplier's roll no.), in the order of `qtys`. */
  refs: Array<string | null>
  later: boolean
  /** How many packages there are, when their sizes are to be given later. */
  count: number | null
  /** The lot's own barcode, kept as its one package's identity: already labelled, nothing to print. */
  barcode: string | null
  said: string
}
const PACK_WORDS: Array<[RegExp, PackType]> = [
  [/^(roll|rolls|than|thaan|thaans|reel|reels)$/, 'ROLL'],
  [/^(box|boxes|bx)$/, 'BOX'],
  [/^(carton|cartons|ctn|ctns)$/, 'CARTON'],
  [/^(bag|bags|sack|sacks)$/, 'BAG'],
  [/^(bundle|bundles|bdl|bdls)$/, 'BUNDLE'],
  [/^(packet|packets|pkt|pkts|pack|packs)$/, 'PACKET'],
  [/^(other|cone|cones|bale|bales|spool|spools|drum|drums)$/, 'OTHER'],
]
const PACK_PLURAL: Record<PackType, [string, string]> = {
  ROLL: ['roll', 'rolls'],
  BOX: ['box', 'boxes'],
  CARTON: ['carton', 'cartons'],
  BAG: ['bag', 'bags'],
  BUNDLE: ['bundle', 'bundles'],
  PACKET: ['packet', 'packets'],
  OTHER: ['package', 'packages'],
}
const packs = (n: number, t: PackType) => `${n} ${PACK_PLURAL[t][n === 1 ? 0 : 1]}`

/** The sheet's packing columns as a plan's input; problems for what cannot be read. */
function packFromRow(raw: Raw, problems: string[], L: (k: OsKey) => string): PackInput | null {
  const text = (k: OsKey) => (raw[k] ?? '').trim()
  if (!['packType', 'packCount', 'packEach', 'packQtys', 'packRefs'].some((k) => text(k as OsKey))) return null
  const out: PackInput = {}
  if (text('packType')) {
    const word = low(text('packType')).replace(/[^a-z]/g, '')
    const hit = PACK_WORDS.find(([re]) => re.test(word))?.[1] ?? (['ROLL', 'BOX', 'CARTON', 'BAG', 'BUNDLE', 'PACKET', 'OTHER'] as PackType[]).find((t) => t.toLowerCase() === word)
    if (hit) out.type = hit
    else problems.push(`${L('packType')} "${text('packType')}" is not one of: Roll, Box, Carton, Bag, Bundle, Packet, Other.`)
  }
  if (text('packCount')) {
    const n = parseNum(text('packCount'))
    if (n === null || Number.isNaN(n) || !(n >= 1) || !Number.isInteger(n)) problems.push(`${L('packCount')} "${text('packCount')}" is not a whole number of packages.`)
    else out.count = n
  }
  if (text('packEach')) {
    const n = parseNum(text('packEach'))
    if (n === null || Number.isNaN(n) || !(n > 0)) problems.push(`${L('packEach')} "${text('packEach')}" is not a quantity.`)
    else out.each = n
  }
  if (text('packQtys')) {
    const parts = text('packQtys').split(/[,;+\s]+/).filter(Boolean)
    const nums = parts.map((t) => parseNum(t))
    if (nums.some((n) => n === null || Number.isNaN(n) || !(n! > 0))) problems.push(`${L('packQtys')} "${text('packQtys')}": give each package's quantity, separated by commas.`)
    else out.qtys = nums as number[]
  }
  if (text('packRefs')) out.refs = text('packRefs').split(/[,;]+/).map((t) => t.trim() || null)
  return out
}

/** A row's stickers worked out: what the input says, else the row's barcode, else the item's qty per sticker, else none yet. */
function planPacks(
  input: PackInput | null,
  ctx: { qty: number; unit: string; places: number; packType: PackType; perPack: number | null; bundle: string | null; L: (k: OsKey) => string },
  problems: string[],
): PackPlan {
  const type = input?.type ?? ctx.packType
  const fits = (q: number) => fitsPlaces(q, ctx.places)
  const later = (count: number | null, why: string): PackPlan => ({ packType: type, qtys: [], refs: [], later: true, count, barcode: null, said: why })
  const made = (qtys: number[], refs: Array<string | null>): PackPlan => {
    const left = round3(ctx.qty - qtys.reduce((t, q) => t + q, 0))
    const same = qtys.every((q) => Math.abs(q - qtys[0]) < 0.0005)
    // A lot with its own barcode kept as one package: that barcode is the package.
    const barcode = qtys.length === 1 && ctx.bundle ? ctx.bundle : null
    const each = qtys.length === 1 ? `${packs(1, type)} of ${qtys[0]} ${ctx.unit}` : same ? `${packs(qtys.length, type)} × ${qtys[0]} ${ctx.unit}` : `${packs(qtys.length, type)}: ${qtys.join(' + ')} ${ctx.unit}`
    const own = barcode ? `${each}, its own barcode ${barcode} kept` : each
    return { packType: type, qtys, refs, later: false, count: qtys.length, barcode, said: left > 0.0005 ? `${own}; ${left} ${ctx.unit} packaging pending` : own }
  }
  const refsFor = (n: number) => {
    const refs = input?.refs ?? []
    if (refs.length && refs.length !== n) problems.push(`${ctx.L('packRefs')}: ${refs.length} given for ${packs(n, type)}.`)
    return Array.from({ length: n }, (_, i) => refs[i] ?? null)
  }
  if (input?.later) return later(input.count ?? null, input.count ? `Packaging pending: ${packs(input.count, type)}, sizes to give later` : 'Packaging pending')
  if (input?.qtys?.length) {
    const qtys = input.qtys.map(round3)
    const sum = round3(qtys.reduce((t, q) => t + q, 0))
    if (sum > ctx.qty + 0.0005) problems.push(`${ctx.L('packQtys')} add up to ${sum} ${ctx.unit}, more than the ${ctx.qty} ${ctx.unit} on the row.`)
    if (input.count && input.count !== qtys.length) problems.push(`${ctx.L('packCount')} says ${input.count}, but ${qtys.length} quantities are given.`)
    const bad = qtys.find((q) => !fits(q))
    if (bad !== undefined) problems.push(`A package of ${bad} ${ctx.unit}: ${placesMessage(ctx.places)}`)
    return made(qtys, refsFor(qtys.length))
  }
  if (input?.each) {
    const qtys = suggestQtys(ctx.qty, input.each)
    if (input.count && input.count !== qtys.length) problems.push(`${ctx.qty} ${ctx.unit} at ${input.each} a package is ${packs(qtys.length, type)}, not ${input.count}.`)
    return made(qtys, refsFor(qtys.length))
  }
  if (input?.count) {
    if (input.count === 1) return made([ctx.qty], refsFor(1))
    return later(input.count, `Packaging pending: ${packs(input.count, type)}, sizes to give later`)
  }
  if (ctx.bundle) return made([ctx.qty], [null])
  if (ctx.perPack) return made(suggestQtys(ctx.qty, ctx.perPack), Array.from({ length: suggestQtys(ctx.qty, ctx.perPack).length }, () => null))
  return later(null, 'Packaging pending: give its packages when you know them')
}
const TYPE_SHEET: Record<OsKind, string> = { FG: 'Finished Goods', SFG: 'Semi Finished Goods', RM: 'Raw Materials' }

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
  /** How its stock goes on stickers, in words; null for a category not labelled by package. */
  packing: string | null
  /** The same, for the screen to start an edit from. */
  pack?: { type: PackType; qtys: number[]; later: boolean; count: number | null; barcode: string | null } | null
  /** Stickers to be made for it now. */
  stickers: number
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
  /** Its stickers: null for stock not labelled by package (garments by size, untracked categories). */
  pack: PackPlan | null
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
    prisma.style.findMany({ select: { id: true, code: true, name: true, sizeGroupId: true, category: true, isActive: true } }),
    prisma.size.findMany({ select: { id: true, code: true, label: true, sizeGroupId: true } }),
    prisma.uOM.findMany({ where: { isActive: true }, select: { symbol: true } }),
  ])
  return { items, warehouses, departments, styles, sizes, units }
}

const HOW_TO: Record<OsKind, string[]> = {
  FG: [
    'One row per style, colour and size. Style / Article No. and Colour find the finished item; Item Code may be left empty.',
    "Only the style's own colours and sizes are taken (Masters → Styles).",
    'Opening Quantity is in pieces; Rate Per Piece is what one piece is valued at.',
    'Location: the finished goods store, as in Masters → Warehouses. Pieces still at a process are semi-finished: use the Semi Finished Goods template.',
    'Stock Status: OK, Hold, Rejected or B-Grade (second quality). Empty is OK.',
  ],
  SFG: [
    'One row per style, process, colour and size.',
    "Process: where the pieces are now — one of the processes on the style's route (Masters → Routings).",
    'Department may be left empty: the process says where the work is done.',
    "Location may be left empty: the pieces go on the process's own floor. Name an outside unit when they are there.",
    'Order Reference and Batch / Bundle Reference are optional and kept on every line.',
    'Pieces of an order already on the Production Floor are counted there, so they are not opening stock.',
    'Stock Status: OK, Hold, Rejected or B-Grade. Empty is OK.',
  ],
  RM: [
    'One row per item and lot or roll: the same item may come in many rows.',
    "Material Category is checked against the item's category (Fabric, Thread, Buttons…).",
    'Item Code must be in Items & Products; Item Name may be left empty.',
    "UOM is the item's own unit: checked, never converted, so give the quantity in it.",
    'Location: the store it is in, as in Masters → Warehouses.',
    'Stickers (where the category is tracked): the five Package columns say how the row is packed — all optional.',
    'Package Quantities lists each package: 200, 250, 150 makes three stickers. Less than the row leaves the rest without stickers for now.',
    'Qty per Package makes full packages and one for the rest: 1,200 at 500 is 500 + 500 + 200.',
    'Package Count alone: the stock comes in and its stickers wait until the sizes are known (Stickers → Make stickers on the line). Equal sizes are never assumed.',
    "Nothing given: a row with its own Bundle / Barcode Number is one package; otherwise the item's usual package size, if it has one; else the stickers wait.",
    'Stock Status: OK, Hold or Rejected. Empty is OK.',
  ],
}

/**
 * A kind's template: its own columns, dropdowns from the masters, and how to
 * fill it. The opening date is picked on the screen for the whole sheet.
 */
async function buildKindTemplate(kind: OsKind): Promise<Buffer> {
  const m = await loadMasters()
  const columns = TYPE_COLUMNS[kind]
  const wb = new ExcelJS.Workbook()
  const sheet = addTemplateSheet(wb, TYPE_SHEET[kind], columns)
  const materials = await prisma.itemCategory.findMany({
    where: { isActive: true, itemGroup: 'RAW_MATERIALS', parentId: { not: null } },
    select: { name: true },
    orderBy: { name: 'asc' },
  })
  const all: Record<string, string[]> = {
    styles: m.styles.filter((st) => st.isActive).map((st) => st.code).sort(),
    processes: m.departments.filter((d) => d.operations.length > 0).map((d) => d.name).sort(),
    stores: m.warehouses.filter((w) => !w.departmentId).map((w) => w.name).sort(),
    locations: m.warehouses.map((w) => w.name).sort(),
    materials: materials.map((c) => c.name),
    units: m.units.map((u) => u.symbol).sort(),
    statuses: kind === 'RM' ? ['OK', 'Hold', 'Rejected'] : Object.values(STATUS_LABEL),
    packTypes: ['Roll', 'Box', 'Carton', 'Bag', 'Bundle', 'Packet', 'Other'],
  }
  const used = new Set(columns.map((c) => c.list).filter(Boolean) as string[])
  addDropdowns(wb, sheet, columns, Object.fromEntries(Object.entries(all).filter(([k]) => used.has(k))), MAX_ROWS)
  addHowToSheet(wb, [
    ...HOW_TO[kind],
    'The opening date is picked on the screen when the sheet is uploaded: one date for the whole sheet.',
    'Nothing is brought in twice: a row matching an earlier entry, or stock already moving in the ERP at that place, is refused. Correct those with a stock count.',
    `Up to ${MAX_ROWS} rows per upload; a bigger stock can go in several uploads.`,
  ])
  return Buffer.from(await wb.xlsx.writeBuffer())
}

/** The template: a kind's own, or the 19 columns in their order with dropdowns from the masters, and how to fill it. */
export async function buildTemplate(kind?: OsKind): Promise<Buffer> {
  if (kind) return buildKindTemplate(kind)
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
    'Opening Qty is required. Unit Rate and Opening Value are optional: give either, or both (they must agree, Qty × Rate); with neither the stock comes in at nought.',
    'Stock Status: OK (usable), Hold (held until released), Rejected (held as rejected) or B-Grade (second-quality finished goods). Empty is OK.',
    'Opening Date: the day of the count, not later than today.',
    'Nothing is brought in twice: a row matching an earlier upload, or stock already moving in the ERP at that location, is refused. Correct those with a stock count.',
    `Up to ${MAX_ROWS} rows per upload; a bigger stock can go in several uploads.`,
  ])
  return Buffer.from(await wb.xlsx.writeBuffer())
}

export function readSheet(file: Buffer, fileName: string, kind?: OsKind) {
  return readSheetRows<OsKey>(file, fileName, {
    columns: kind ? TYPE_COLUMNS[kind] : OS_COLUMNS,
    sheetName: kind ? TYPE_SHEET[kind] : 'Opening Stock',
    mustHave: 'qty',
    mustHaveLabel: kind ? 'Opening Quantity' : 'Opening Qty',
    maxRows: MAX_ROWS,
  })
}

/**
 * A kind's sheet as the 19 columns: the date picked on the screen on every
 * row, and the process its kind means — finished goods are in a store, raw
 * materials in a store; semi-finished rows say their process themselves.
 */
export function asNineteen(rows: Array<{ row: number; raw: Raw }>, kind: OsKind, openingDate: string) {
  for (const r of rows) {
    if (Object.values(r.raw).every((v) => !(v ?? '').trim())) continue
    r.raw.date = openingDate
    if (kind === 'FG') r.raw.process = 'Finished Goods'
    if (kind === 'RM') r.raw.process = 'Store'
  }
  return rows
}

/** The column names problems are told in: the kind's own template, or the 19 columns. */
export const labelsOf = (kind?: OsKind): Partial<Record<OsKey, string>> =>
  Object.fromEntries((kind ? TYPE_COLUMNS[kind] : OS_COLUMNS).map((c) => [c.key, c.head]))

/**
 * Lines entered by hand on the screen, as sheet rows: the same columns, so
 * they are checked and brought in exactly as an uploaded sheet is.
 */
export function rowsFromEntry(lines: Array<Record<string, unknown>>): Array<{ row: number; raw: Raw; pack?: PackInput | null }> {
  const keys: OsKey[] = [...OS_COLUMNS.map((c) => c.key), 'department']
  return lines.map((l, i) => ({
    row: i + 1,
    raw: Object.fromEntries(
      keys.map((k) => [k, l[k] === null || l[k] === undefined ? '' : String(l[k]).trim()]),
    ) as Raw,
    pack: (l.pack as PackInput | null | undefined) ?? null,
  }))
}

/**
 * Every row checked; nothing written. Lines entered by hand are called lines,
 * not rows. Given a kind, its own rules too: finished goods only in a store,
 * semi-finished pieces only at a process on their style's route, raw
 * materials only in a store. Problems name the columns as the kind's
 * template (or the screen) does.
 */
export async function planImport(
  rows: Array<{ row: number; raw: Raw; pack?: PackInput | null }>,
  opts: { rowWord?: 'row' | 'line'; kind?: OsKind; labels?: Partial<Record<OsKey, string>> } = {},
): Promise<Resolved[]> {
  const m = await loadMasters()
  const L = (k: OsKey) => opts.labels?.[k] ?? OS_COLUMNS.find((c) => c.key === k)?.head ?? k
  const ruleOf = await packageRules(prisma)
  // Only the 19-column sheet has an Opening Value column.
  const departmentById = new Map(m.departments.map((d) => [d.id, d]))
  const styleById = new Map(m.styles.map((st) => [st.id, st]))
  // Each style's route, as an order's stages are offered: its own, its category's, any style's.
  const tracked = await trackedRoutings(prisma, m.styles.map((st) => ({ id: st.id, category: st.category })))
  const routeOf = (styleId: string) => {
    const t = tracked.get(styleId)
    if (!t) return null
    const seen = new Map<string, string>()
    for (const step of t.routing.steps) if (!seen.has(step.departmentId)) seen.set(step.departmentId, step.department.name)
    return [...seen.entries()].map(([id, name]) => ({ id, name }))
  }
  // Orders whose pieces are already on the Production Floor: counted there, not as opening stock.
  const orders = [...new Set(rows.map((r) => (r.raw.order ?? '').trim()).filter(Boolean))]
  const onFloor = new Map<string, string>()
  if (orders.length) {
    const mos = await prisma.manufacturingOrder.findMany({
      where: {
        bundles: { some: {} },
        OR: orders.flatMap((o) => [
          { moNumber: { equals: o, mode: 'insensitive' as const } },
          { so: { soNumber: { equals: o, mode: 'insensitive' as const } } },
        ]),
      },
      select: { moNumber: true, so: { select: { soNumber: true } } },
    })
    for (const mo of mos) {
      onFloor.set(squash(mo.moNumber), mo.moNumber)
      if (mo.so) onFloor.set(squash(mo.so.soNumber), onFloor.has(squash(mo.so.soNumber)) ? `${onFloor.get(squash(mo.so.soNumber))}, ${mo.moNumber}` : mo.moNumber)
    }
  }
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
  for (const { row, raw, pack: packGiven } of rows) {
    const problems: string[] = []
    const plan: OsRowPlan = {
      row, skipped: false, problems, group: null, stage: null, process: (raw.process ?? '').trim() || 'Store', location: (raw.location ?? '').trim(),
      newFloor: false, item: null, size: (raw.size ?? '').trim() || null, order: (raw.order ?? '').trim() || null,
      lot: (raw.lot ?? '').trim() || null, bundle: (raw.bundle ?? '').trim() || null, qty: null, unit: null,
      rate: null, value: null, status: STATUS_LABEL.OK, packing: null, stickers: 0,
    }
    if (Object.values(raw).every((v) => !(v ?? '').trim())) {
      plan.skipped = true
      out.push({ plan })
      continue
    }

    // Opening Date.
    const date = parseDay(raw.date)
    if (date === null) problems.push(`${L('date')} is empty.`)
    else if (date === 'bad') problems.push(`${L('date')} "${raw.date}" is not a date: write it as 31-03-2026.`)
    else if (date.getTime() >= endOfToday) problems.push(`${L('date')} ${dmy(date)} is later than today.`)

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
    // Semi-finished pieces are at a process; the Department column, if given, is that process.
    if (opts.kind === 'SFG' && kind && kind !== 'PROCESS') problems.push(`Semi-finished pieces are at a process: give the ${L('process')} (Cutting, Stitching…).`)
    if ((raw.department ?? '').trim() && process && ![squash(process.name), squash(process.code)].includes(squash(raw.department))) {
      problems.push(`${L('department')} "${raw.department}" is not where ${process.name} is done: leave it empty or give ${process.name}.`)
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
        if (w && w.departmentId && w.departmentId !== process.id) {
          problems.push(`${w.name} is ${departmentById.get(w.departmentId)?.name ?? 'another process'}'s floor, not ${process.name}'s. Leave ${L('location')} empty for ${process.name}'s own floor.`)
        } else if (w) {
          warehouseId = w.id
          plan.location = w.name
        } else {
          problems.push(`No location named "${raw.location}". Leave it empty for ${process.name}'s own floor, or add the location in Masters → Warehouses.`)
        }
      }
    } else if (kind) {
      if (!locText) problems.push(`${L('location')} is empty: name the store it is in.`)
      else {
        const w = warehouseByName.get(locText)
        if (w && w.departmentId) {
          problems.push(`${w.name} is a process's floor, not a store. Pieces still at a process are semi-finished goods; give the store the stock is in.`)
        } else if (w) {
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
    } else problems.push(`${L('code')} is empty.`)
    if (opts.kind === 'SFG' && !style && !item?.styleId) problems.push(`Give the ${L('style')}: semi-finished pieces are entered style by style.`)

    let sizeId: string | null = null
    if (item) {
      plan.item = { code: item.code, name: item.name }
      const group = groupOfType(item.type)
      plan.group = group
      plan.stage = kind === 'PROCESS' && group !== 'RAW_MATERIALS' ? 'SEMI_FINISHED' : group
      plan.unit = item.uom?.symbol ?? null
      if (!item.category?.isActive) problems.push(`${item.code} is filed under ${item.category?.name}, which is switched off.`)

      // Finished Goods rows hold finished goods; each kind holds its own.
      if (kind === 'FG' && group !== 'FINISHED_GOODS') problems.push(`A Finished Goods row, but ${item.code} is ${ITEM_GROUP_LABEL[group].toLowerCase()}.`)
      if (opts.kind === 'RM' && group !== 'RAW_MATERIALS') {
        problems.push(`${item.code} is ${ITEM_GROUP_LABEL[group].toLowerCase()}, not a raw material: enter it under ${group === 'FINISHED_GOODS' ? 'Finished Goods' : 'Semi Finished Goods'}.`)
      }
      if (opts.kind === 'SFG' && group === 'RAW_MATERIALS') problems.push(`${item.code} is a raw material: enter it under Raw Materials.`)

      // A garment at a process: on its style's route, and not an order already on the Production Floor.
      const routeStyle = item.styleId ? styleById.get(item.styleId) : style
      if (kind === 'PROCESS' && process && group !== 'RAW_MATERIALS') {
        if (routeStyle) {
          const route = routeOf(routeStyle.id)
          if (!route) problems.push(`${routeStyle.code} has no route yet, so where its pieces can be is not known. Set one in Masters → Routings, then enter its semi-finished stock.`)
          else if (!route.some((d) => d.id === process!.id)) problems.push(`${process.name} is not on ${routeStyle.code}'s route (${route.map((d) => d.name).join(' → ')}).`)
        }
        const mo = plan.order ? onFloor.get(squash(plan.order)) : undefined
        if (mo) problems.push(`${plan.order} is already on the Production Floor (${mo}): its pieces are counted there, not as opening stock.`)
      }

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
      if (qty === null) problems.push(`${L('qty')} is empty.`)
      else if (Number.isNaN(qty)) problems.push(`${L('qty')} "${raw.qty}" is not a number.`)
      else if (!(qty > 0)) problems.push(`${L('qty')} has to be more than nought.`)
      else {
        plan.qty = round3(qty)
        const places = qtyPlaces(item)
        if (!fitsPlaces(qty, places)) problems.push(`${L('qty')} ${qty}: ${placesMessage(places)}`)
      }
    } else {
      const qty = parseNum(raw.qty)
      if (qty !== null && !Number.isNaN(qty)) plan.qty = round3(qty)
    }

    // Rate and value: optional — with neither, the stock comes in valued at
    // nought, to be valued later; given both, they must agree.
    const rate = parseNum(raw.rate)
    const value = parseNum(raw.value)
    if (rate !== null && (Number.isNaN(rate) || rate < 0)) problems.push(`${L('rate')} "${raw.rate}" is not a rate.`)
    if (value !== null && (Number.isNaN(value) || value < 0)) problems.push(`${L('value')} "${raw.value}" is not an amount.`)
    if (plan.qty && plan.qty > 0) {
      if (rate !== null && !Number.isNaN(rate) && rate >= 0) {
        plan.rate = round2(rate)
        plan.value = round2(plan.qty * rate)
        if (value !== null && !Number.isNaN(value) && Math.abs(plan.qty * rate - value) > Math.max(1, value * 0.005)) {
          problems.push(`${plan.qty} × ₹${rate} is ₹${round2(plan.qty * rate)}, but ${L('value')} says ₹${value}.`)
        }
      } else if (value !== null && !Number.isNaN(value) && value >= 0) {
        plan.rate = round2(value / plan.qty)
        plan.value = round2(value)
      } else if (rate === null && value === null) {
        plan.rate = 0
        plan.value = 0
      }
    }

    // Stock Status.
    const statusText = squash(raw.status)
    const status = (Object.keys(STATUS_WORDS) as OsStatus[]).find((s) => STATUS_WORDS[s].includes(statusText)) ?? null
    if (!status) problems.push(`${L('status')} "${raw.status}" is not one of: OK, Hold, Rejected, B-Grade.`)
    else {
      plan.status = STATUS_LABEL[status]
      if (status === 'B_GRADE' && plan.group === 'RAW_MATERIALS') problems.push('B-Grade is for semi-finished and finished goods, not raw materials.')
    }

    // Its stickers: raw materials of a category labelled by package, kept without sizes.
    let pack: PackPlan | null = null
    const packInput = packGiven ?? packFromRow(raw, problems, L)
    if (item && plan.qty && plan.qty > 0 && !sizeId && status !== 'B_GRADE') {
      const defaults = stickerDefaultsFrom(item, ruleOf(item.categoryId))
      if (defaults.tracked) {
        pack = planPacks(
          packInput,
          { qty: plan.qty, unit: item.uom?.symbol ?? '', places: qtyPlaces(item), packType: defaults.packType, perPack: defaults.perPack, bundle: plan.bundle, L },
          problems,
        )
        plan.packing = pack.said
        // Stickers to print: a package keeping its own barcode needs none.
        plan.stickers = pack.qtys.length - (pack.barcode ? 1 : 0)
        plan.pack = { type: pack.packType, qtys: pack.qtys, later: pack.later, count: pack.count, barcode: pack.barcode }
        // A lot's own barcode, not one of the ERP's sticker numbers (checked against other packages after the repeats).
        if (pack.barcode && /^PK-\d+$/i.test(pack.barcode)) problems.push(`${L('bundle')} ${pack.barcode} is an ERP sticker number, not the lot's own barcode.`)
      } else if (packInput) problems.push(`${item.code} is filed under ${item.category?.name}, which is not labelled by package: leave its package columns empty.`)
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
            pack,
            raw,
          } satisfies Ready)
        : undefined
    out.push({ plan, ready })
  }

  await checkDuplicates(out, opts.rowWord ?? 'row', L('bundle'))
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
async function checkDuplicates(resolved: Resolved[], rowWord: 'row' | 'line', bundleLabel: string) {
  const seen = new Map<string, number>()
  for (const r of resolved) {
    if (!r.ready) continue
    const key = dedupeKey(r.ready, placeOf(r.ready))
    const earlier = seen.get(key)
    if (earlier) {
      r.plan.problems.push(`Same as ${rowWord} ${earlier}: item, location, size, status, order, lot and bundle all match. Put them on one ${rowWord} with the total.`)
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

  // One barcode, one package: a lot's own barcode is not already on a
  // package, nor on two rows here. After the repeats, which say it plainer.
  const barcoded = resolved.filter((r) => r.ready?.pack?.barcode)
  if (!barcoded.length) return
  const wanted = [...new Set(barcoded.map((r) => r.ready!.pack!.barcode!.toLowerCase()))]
  const taken = await prisma.$queryRaw<Array<{ barcode: string; code: string }>>`SELECT lower(barcode) AS barcode, code FROM ld_erp.stock_packages WHERE lower(barcode) = ANY(${wanted})`
  const onPackage = new Map(taken.map((b) => [b.barcode, b.code]))
  const firstRow = new Map<string, number>()
  for (const r of barcoded) {
    const barcode = r.ready!.pack!.barcode!
    const k = barcode.toLowerCase()
    const problem = onPackage.has(k)
      ? `${bundleLabel} ${barcode} is already on package ${onPackage.get(k)}: one barcode is one package.`
      : firstRow.has(k)
        ? `${bundleLabel} ${barcode} is also on ${rowWord} ${firstRow.get(k)}: one barcode is one package.`
        : null
    if (problem) {
      r.plan.problems.push(problem)
      r.ready = undefined
    } else firstRow.set(k, r.plan.row)
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
    /** Stickers to print; packages keeping their own barcode; rows whose packaging is pending. */
    stickers: lines.reduce((t, r) => t + (r.ready?.pack ? r.ready.pack.qtys.length - (r.ready.pack.barcode ? 1 : 0) : 0), 0),
    kept: lines.filter((r) => r.ready?.pack?.barcode).length,
    waiting: lines.filter((r) => r.ready?.pack?.later).length,
    byGroup: [...byGroup].map(([group, g]) => ({ group, label: ITEM_GROUP_LABEL[group as ItemGroup] ?? group, ...g })),
    byPlace: [...byPlace.values()],
  }
}

/** Posts every row, in one transaction: stock in, floors made, stickers made, the sheet kept. */
/**
 * The entry a save was sent with, when it has already gone in: a retry, a
 * second click or a refresh finds it instead of posting the stock twice.
 */
export async function savedFor(requestKey: string | null | undefined) {
  if (!requestKey) return null
  const doc = await prisma.openingStock.findUnique({ where: { requestKey }, select: { id: true, number: true, _count: { select: { lines: true } } } })
  if (!doc) return null
  const stickers = await prisma.stockPackage.count({ where: { sourceId: doc.id } })
  return { id: doc.id, number: doc.number, lines: doc._count.lines, stickers, floorsMade: [] as string[], again: true }
}

/** Brought in, all or nothing. No file name: entered by hand on the screen. */
export async function runImport(
  resolved: Resolved[],
  opts: { fileName: string | null; notes?: string | null; userId: string | null; kind?: OsKind | null; requestKey?: string | null },
) {
  const byHand = !opts.fileName
  if (resolved.some((r) => r.plan.problems.length > 0)) {
    throw new AppError(
      byHand ? 'Some lines have problems. Put them right and save again.' : 'Some rows have problems. Fix them and upload the sheet again.',
      400,
      'IMPORT_HAS_PROBLEMS',
    )
  }
  const rows = resolved.filter((r) => r.ready)
  if (!rows.length) throw new AppError(byHand ? 'Nothing to save: enter a quantity on at least one line.' : 'The sheet has no rows to bring in.', 400, 'NOTHING_TO_IMPORT')

  try {
    return await postImport(rows, opts, byHand)
  } catch (err) {
    // Sent twice at once: the other one went in first.
    const again = (err as { code?: string }).code === 'P2002' ? await savedFor(opts.requestKey) : null
    if (again) return again
    throw err
  }
}

async function postImport(rows: Resolved[], opts: Parameters<typeof runImport>[1], byHand: boolean) {
  return prisma.$transaction(
    async (tx) => {
      const latest = rows.reduce((d, r) => (r.ready!.date > d ? r.ready!.date : d), rows[0].ready!.date)
      const number = await nextDocumentNumber(tx, 'OPS', latest)
      const doc = await tx.openingStock.create({
        data: { number, fileName: opts.fileName, notes: opts.notes?.trim() || null, kind: opts.kind ?? null, requestKey: opts.requestKey ?? null, createdById: opts.userId },
      })

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
      // Packages keeping a lot's own barcode: labelled already.
      let kept = 0
      for (const r of ordered) {
        const d = r.ready!
        const note = [`${number} ${byHand ? 'line' : 'row'} ${r.plan.row}`, d.bundleNo ? `bundle ${d.bundleNo}` : null, (d.raw.remarks ?? '').trim() || null].filter(Boolean).join(' · ')
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

        const item = itemById.get(d.itemId)!
        const raw = d.raw
        const line = await tx.openingStockLine.create({
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
            packType: d.pack?.packType ?? null,
            packCount: d.pack?.count ?? null,
            dedupeKey: dedupeKey(d, d.warehouseId!),
          },
        })

        // Its stickers, as planned, each naming the line it was made for; a
        // line waiting for its sizes has none yet and its stock stays loose.
        if (d.pack && d.pack.qtys.length) {
          const pkgs = await createPackages(tx, {
            spot: { itemId: d.itemId, warehouseId: d.warehouseId!, ownership: 'OWNED', ownerCustomerId: null },
            packType: d.pack.packType,
            qtys: d.pack.qtys,
            notesEach: d.pack.refs.map((ref) => (ref ? `Ref ${ref}`.slice(0, 120) : null)),
            barcodesEach: [d.pack.barcode],
            lotNo: d.lotNo,
            notes: d.bundleNo ? `Barcode ${d.bundleNo}`.slice(0, 120) : null,
            sourceType: 'OPENING',
            sourceId: doc.id,
            sourceRef: number,
            sourceLineId: line.id,
            userId: opts.userId,
            unit: item.uom?.symbol ?? '',
            itemName: item.name,
            grade: d.grade,
          })
          // Stickers to print: a package keeping its own barcode is labelled already.
          stickers += pkgs.length - (d.pack.barcode ? 1 : 0)
          if (d.pack.barcode) kept += 1
          if (pkgs[0]) await tx.openingStockLine.update({ where: { id: line.id }, data: { packageId: pkgs[0].id } })
        }
      }
      return { id: doc.id, number, lines: rows.length, stickers, kept, floorsMade: made }
    },
    { timeout: 300_000, maxWait: 20_000 },
  )
}

/**
 * The finished item for a style in one colour: found, or made when missing —
 * on the person's click in the entry window, never on its own. Made like the
 * style's other colours (category, unit, HSN, GST, rate). With none, under the
 * finished-goods category that is plainly the style's (or the one chosen),
 * like the other items there; when none is plain, the categories to choose
 * from are given back instead.
 */
export async function colourItem(input: { styleId: string; colour: string; categoryId?: string | null; preview?: boolean; name?: string | null }) {
  const style = await prisma.style.findUnique({ where: { id: input.styleId }, select: { id: true, code: true, name: true, colors: true, category: true } })
  if (!style) throw new AppError('That style does not exist.', 404, 'NOT_FOUND')
  const colour = style.colors.find((c) => low(c) === low(input.colour))
  if (!colour) throw new AppError(`${style.code} does not come in ${input.colour}. Its colours: ${style.colors.join(', ')}.`, 400, 'INVALID_COLOUR')

  const pick = { id: true, code: true, name: true, color: true } as const
  const existing = await prisma.item.findFirst({ where: { styleId: style.id, color: { equals: colour, mode: 'insensitive' } }, select: pick })
  if (existing) return { item: existing, made: false as const }

  const sibling = await prisma.item.findFirst({
    where: { styleId: style.id, type: 'FINISHED_GOOD' },
    orderBy: { createdAt: 'asc' },
    select: { code: true, categoryId: true, uomId: true, hsnCode: true, taxRateId: true, standardRate: true },
  })
  let template: { categoryId: string; uomId: string; hsnCode: string | null; taxRateId: string | null; standardRate: unknown } | null = sibling
  // The item its details are copied from, said in the preview.
  let copiedFrom: string | null = sibling?.code ?? null
  if (!template) {
    let categoryId = input.categoryId ?? null
    const finished = await prisma.itemCategory.findMany({
      where: { isActive: true, itemGroup: 'FINISHED_GOODS', parentId: { not: null } },
      select: { id: true, name: true },
      orderBy: { name: 'asc' },
    })
    if (!categoryId) {
      // Plainly the style's: its category word, or its name, names exactly one.
      const said = [stem(style.category), ...low(style.name).split(/[^a-z0-9]+/).map((w) => stem(w))].filter(Boolean)
      const hits = finished.filter((c) => said.includes(stem(c.name)))
      if (hits.length === 1) categoryId = hits[0].id
    }
    if (!categoryId || !finished.some((c) => c.id === categoryId)) {
      return { needCategory: true as const, categories: finished }
    }
    const like = await prisma.item.findFirst({
      where: { categoryId, type: 'FINISHED_GOOD' },
      orderBy: { createdAt: 'desc' },
      select: { code: true, uomId: true, hsnCode: true, taxRateId: true },
    })
    copiedFrom = like?.code ?? null
    const pcs = like?.uomId ?? (await prisma.uOM.findFirst({ where: { symbol: { equals: 'pcs', mode: 'insensitive' } }, select: { id: true } }))?.id
    if (!pcs) throw new AppError('There is no "pcs" unit to count garments in. Add it in Masters → Units.', 400, 'NO_PCS_UNIT')
    template = { categoryId, uomId: pcs, hsnCode: like?.hsnCode ?? null, taxRateId: like?.taxRateId ?? null, standardRate: null }
  }
  const name = input.name?.trim() || `${style.name} — ${colour}`

  // Shown first, created only when asked: everything the new item gets, and where it comes from.
  if (input.preview) {
    const [category, unit, tax] = await Promise.all([
      prisma.itemCategory.findUnique({ where: { id: template.categoryId }, select: { name: true, parent: { select: { name: true } } } }),
      prisma.uOM.findUnique({ where: { id: template.uomId }, select: { symbol: true, name: true } }),
      template.taxRateId ? prisma.taxRate.findUnique({ where: { id: template.taxRateId }, select: { name: true, rate: true } }) : null,
    ])
    return {
      preview: {
        name,
        type: 'Finished Good',
        style: style.code,
        colour,
        category: category?.parent?.name ?? null,
        subCategory: category?.name ?? null,
        unit: unit ? `${unit.name} (${unit.symbol})` : null,
        hsnCode: template.hsnCode,
        gst: tax ? `${tax.name} (${Number(tax.rate)}%)` : null,
        standardRate: template.standardRate != null ? Number(template.standardRate) : null,
        copiedFrom,
        categoryId: template.categoryId,
      },
    }
  }

  const item = await withGeneratedCode(
    'item',
    {
      name,
      type: 'FINISHED_GOOD',
      categoryId: template.categoryId,
      uomId: template.uomId,
      hsnCode: template.hsnCode,
      taxRateId: template.taxRateId,
      standardRate: template.standardRate,
      styleId: style.id,
      color: colour,
    },
    (data) => prisma.item.create({ data: data as never, select: pick }),
  )
  return { item, made: true as const }
}

/**
 * Which template a workbook is, by its sheet's name: a kind's own, the
 * 19-column sheet ('ALL'), or not known (a .csv, a sheet renamed).
 */
export async function templateOf(file: Buffer, fileName: string): Promise<OsKind | 'ALL' | null> {
  if (/\.csv$/i.test(fileName)) return null
  const wb = new ExcelJS.Workbook()
  try {
    await wb.xlsx.load(file as unknown as ExcelJS.Buffer)
  } catch {
    return null
  }
  const names = wb.worksheets.map((w) => w.name)
  const kind = (Object.keys(TYPE_SHEET) as OsKind[]).find((k) => names.includes(TYPE_SHEET[k]))
  return kind ?? (names.includes('Opening Stock') ? 'ALL' : null)
}

/**
 * The sheet as it was uploaded, with a Problems column: each row's problems
 * beside it and those rows shaded, on the same row numbers. Put right, it
 * goes back up as it is — the Problems column is passed over.
 */
export async function errorReport(rows: Array<{ row: number; raw: Raw }>, resolved: Resolved[], kind?: OsKind): Promise<Buffer> {
  const columns = kind ? TYPE_COLUMNS[kind] : OS_COLUMNS
  const wb = new ExcelJS.Workbook()
  const sheet = addTemplateSheet(wb, kind ? TYPE_SHEET[kind] : 'Opening Stock', [...columns, { key: 'problems', head: 'Problems', width: 80 }])
  const problemsAt = new Map(resolved.map((r) => [r.plan.row, r.plan.problems]))
  const shade = { type: 'pattern' as const, pattern: 'solid' as const, fgColor: { argb: 'FFFDE2E1' } }
  for (const r of rows) {
    const line = sheet.getRow(r.row)
    columns.forEach((c, i) => {
      const v = r.raw[c.key]
      if (v !== undefined && v !== '') line.getCell(i + 1).value = v
    })
    const problems = problemsAt.get(r.row) ?? []
    if (problems.length) {
      line.getCell(columns.length + 1).value = problems.join(' · ')
      for (let i = 1; i <= columns.length + 1; i++) line.getCell(i).fill = shade
    }
  }
  const bad = resolved.filter((r) => r.plan.problems.length).length
  addHowToSheet(wb, [
    `${bad} ${bad === 1 ? 'row has' : 'rows have'} problems, shaded, with what is wrong in the Problems column.`,
    'Put each one right in this sheet (or take the row out), save it, and upload it again: the Problems column is passed over.',
    'Nothing is brought in until every row is right.',
  ])
  return Buffer.from(await wb.xlsx.writeBuffer())
}

/** The names the stickers window gives its boxes, for a line's problems. */
const PACK_LABELS: Partial<Record<OsKey, string>> = { packQtys: 'The packages', packCount: 'How many', packRefs: 'The references', packEach: 'Each holds' }

/**
 * Stickers made for an opening line later — its sizes known now, or more of
 * its stock packed. Never more than the line brought in and is not yet on its
 * stickers, nor more than the store holds without one (stickered stock is
 * never stickered twice), so making them later never adds stock.
 */
export async function packLine(lineId: string, input: PackInput, userId: string | null) {
  return prisma.$transaction(async (tx) => {
    const line = await tx.openingStockLine.findUnique({
      where: { id: lineId },
      include: {
        openingStock: { select: { id: true, number: true } },
        item: {
          select: {
            id: true, code: true, name: true, categoryId: true, packType: true, packQty: true, decimalPlaces: true,
            uom: { select: { symbol: true, name: true, decimalPlaces: true } },
          },
        },
      },
    })
    if (!line) throw new AppError('That opening stock line does not exist.', 404, 'NOT_FOUND')
    if (line.sizeId) throw new AppError('Stock kept size by size is not put on package stickers.', 400, 'SIZED')
    const defaults = stickerDefaultsFrom(line.item, (await packageRules(tx))(line.item.categoryId))
    if (!defaults.tracked) throw new AppError(`${line.item.code} is not labelled by package.`, 400, 'NOT_TRACKED')
    const done = await tx.stockPackage.aggregate({ where: stickeredFrom([line.id]), _sum: { initialQty: true } })
    const unit = line.item.uom?.symbol ?? ''
    const left = round3(Number(line.qty) - Number(done._sum.initialQty ?? 0))
    if (!(left > 0.0005)) throw new AppError(`All ${Number(line.qty)} ${unit} of this line is already on stickers.`, 400, 'ALL_PACKED')
    const problems: string[] = []
    const plan = planPacks(
      { ...input, later: false },
      { qty: left, unit, places: qtyPlaces(line.item), packType: defaults.packType, perPack: defaults.perPack, bundle: null, L: (k) => PACK_LABELS[k] ?? k },
      problems,
    )
    if (problems.length) throw new AppError(problems.join(' '), 400, 'BAD_PACKAGES')
    if (!plan.qtys.length) throw new AppError(`Give the packages for the ${left} ${unit} not yet on stickers.`, 400, 'NO_PACKAGES')
    const pkgs = await createPackages(tx, {
      spot: { itemId: line.itemId, warehouseId: line.warehouseId, ownership: 'OWNED', ownerCustomerId: null },
      packType: plan.packType,
      qtys: plan.qtys,
      notesEach: plan.refs.map((ref) => (ref ? `Ref ${ref}`.slice(0, 120) : null)),
      lotNo: line.lotNo,
      notes: line.bundleNo ? `Barcode ${line.bundleNo}`.slice(0, 120) : null,
      sourceType: 'OPENING',
      sourceId: line.openingStock.id,
      sourceRef: line.openingStock.number,
      sourceLineId: line.id,
      userId,
      unit,
      itemName: line.item.name,
      grade: line.grade,
    })
    await tx.openingStockLine.update({ where: { id: line.id }, data: { packageId: line.packageId ?? pkgs[0].id, packType: plan.packType } })
    const after = round3(left - plan.qtys.reduce((t, q) => t + q, 0))
    return { ids: pkgs.map((p) => p.id), said: plan.said, number: line.openingStock.number, left: after, unit }
  })
}

/**
 * Each opening line's stickers: how many, what they hold, and what of it
 * still waits — its packaging pending. Never more than is really without a
 * sticker in its store: stock labelled from Stickers → Packaging pending, or
 * issued meanwhile, no longer waits.
 */
export async function linesPacking(
  lines: Array<{ id: string; qty: unknown; sizeId: string | null; itemId: string; warehouseId: string; item: { categoryId: string; packType: PackType | null; packQty: unknown; uom: { symbol: string; name?: string | null } | null } }>,
) {
  if (!lines.length) return new Map<string, { tracked: boolean; made: number; qty: number; waiting: number }>()
  const ids = lines.map((l) => l.id)
  const spotOf = (l: (typeof lines)[number]) => ({ itemId: l.itemId, warehouseId: l.warehouseId, ownership: 'OWNED' as const, ownerCustomerId: null })
  const [packed, inUse, ruleOf, positionOf] = await Promise.all([
    prisma.stockPackage.groupBy({ by: ['sourceLineId'], where: stickeredFrom(ids), _sum: { initialQty: true } }),
    prisma.stockPackage.groupBy({ by: ['sourceLineId'], where: { sourceLineId: { in: ids }, parentId: null, status: { notIn: ['VOID', 'MERGED'] } }, _count: { _all: true } }),
    packageRules(prisma),
    positionsOf(prisma, lines.filter((l) => !l.sizeId).map(spotOf)),
  ])
  const qtyOf = new Map(packed.map((p) => [p.sourceLineId as string, Number(p._sum.initialQty ?? 0)]))
  const madeOf = new Map(inUse.map((p) => [p.sourceLineId as string, p._count._all]))
  return new Map(
    lines.map((l) => {
      const tracked = !l.sizeId && stickerDefaultsFrom({ ...l.item, packQty: l.item.packQty as number | null }, ruleOf(l.item.categoryId)).tracked
      const qty = round3(qtyOf.get(l.id) ?? 0)
      const loose = tracked ? Math.max(0, positionOf(spotOf(l)).loose) : 0
      return [l.id, { tracked, made: madeOf.get(l.id) ?? 0, qty, waiting: tracked ? Math.max(0, round3(Math.min(Number(l.qty) - qty, loose))) : 0 }]
    }),
  )
}

/**
 * The stickers a line's stock first went on: withdrawn ones left out, and
 * one made by putting others together too — the ones it replaced still
 * count, so its stock is counted once.
 */
const stickeredFrom = (lineIds: string[]): Prisma.StockPackageWhereInput => ({
  sourceLineId: { in: lineIds },
  parentId: null,
  status: { not: 'VOID' },
  mergedFrom: { none: {} },
})
