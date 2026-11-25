import type { Prisma, PrismaClient } from '@prisma/client'
import { AppError } from '../middleware/errorHandler'

/**
 * A BOM's arithmetic and its version guard, shared by Masters → BOMs and by a
 * sample's handover, which makes draft BOMs from the approved round inside its
 * own transaction. Moved here unchanged from master.routes (Phase 8); each
 * caller passes the database it is working in.
 */
type Db = PrismaClient | Prisma.TransactionClient

/**
 * The next free version for a style's colour: one up from the highest whole
 * version it has (1.0, 2.0 …), 1.0 when it has none.
 */
export async function nextBomVersion(db: Db, styleId: string, color: string | null) {
  const rows = await db.bOM.findMany({ where: { styleId, color }, select: { version: true } })
  return nextVersionAfter(rows.map((r) => r.version))
}
export function nextVersionAfter(versions: string[]) {
  const numbers = versions.map((v) => Number.parseFloat(v)).filter((v) => Number.isFinite(v))
  return numbers.length ? `${Math.floor(Math.max(...numbers)) + 1}.0` : '1.0'
}

/**
 * Money is rounded at every step rather than only at the end, so that a clerk
 * checking the screen against a calculator gets the same answer. Quantities
 * keep four places — cloth per garment is measured that finely.
 */
export const round = (value: number, places: number) => Number(value.toFixed(places))

export type IncomingBomLineSize = { sizeId: string; qtyPerUnit: number | string }

export type IncomingBomLine = {
  componentItemId: string
  component?: string | null
  departmentId?: string | null
  qtyPerUnit: number | string
  wastagePercent?: number
  unitCost?: number | string | null
  notes?: string | null
  sortOrder?: number
  sizes?: IncomingBomLineSize[]
}

/**
 * Wastage inflates the quantity actually consumed: cutting 1.65 m of fabric per
 * shirt at 5% wastage really draws 1.7325 m. Rates fall back to the item's
 * standard rate so a BOM can be costed before anyone types a price.
 *
 * An item with no rate anywhere now raises a warning instead of costing at
 * zero. A total that quietly leaves a component out looks exactly like a total
 * that is right, which is the worse of the two failures.
 *
 * Sizes are a sparse override: a size with no row of its own consumes what the
 * line consumes. That fallback is what keeps a BOM with no size run behaving
 * exactly as it did before sizes existed.
 */
export async function priceBomLines(db: Db, lines: IncomingBomLine[]) {
  const itemIds = [...new Set(lines.map((l) => l.componentItemId))]
  const items = await db.item.findMany({
    where: { id: { in: itemIds } },
    select: { id: true, code: true, name: true, standardRate: true },
  })

  const missing = itemIds.filter((id) => !items.some((i) => i.id === id))
  if (missing.length > 0) {
    throw new AppError(`Unknown component item(s): ${missing.join(', ')}`, 400, 'INVALID_ITEM')
  }

  const byId = new Map(items.map((i) => [i.id, i]))
  const warnings: Array<{ itemId: string; code: string; name: string }> = []

  const priced = lines.map((line, index) => {
    const item = byId.get(line.componentItemId)!
    const qty = Number(line.qtyPerUnit)
    const wastage = Number(line.wastagePercent ?? 0)
    const factor = 1 + wastage / 100

    const typed =
      line.unitCost !== null && line.unitCost !== undefined && line.unitCost !== ''
        ? Number(line.unitCost)
        : null
    const standard = item.standardRate !== null ? Number(item.standardRate) : null
    const rate = typed ?? standard

    if (rate === null) {
      warnings.push({ itemId: item.id, code: item.code, name: item.name })
    }

    const unitCost = round(rate ?? 0, 4)
    const effectiveQty = round(qty * factor, 4)

    // The line's wastage, not a per-size one: size changes how much cloth a
    // garment takes, it does not change how badly the cutter wastes it.
    const sizes = (line.sizes ?? []).map((s) => {
      const sizeQty = Number(s.qtyPerUnit)
      const sizeEffective = round(sizeQty * factor, 4)
      return {
        sizeId: s.sizeId,
        qtyPerUnit: sizeQty,
        effectiveQty: sizeEffective,
        totalCost: round(sizeEffective * unitCost, 2),
      }
    })

    return {
      componentItemId: line.componentItemId,
      component: line.component ?? null,
      departmentId: line.departmentId || null,
      qtyPerUnit: qty,
      wastagePercent: wastage,
      effectiveQty,
      unitCost,
      // Worked out from the rounded quantity and the rounded rate, so that
      // Effective x Rate really does come to Cost on the screen.
      totalCost: round(effectiveQty * unitCost, 2),
      notes: line.notes ?? null,
      sortOrder: line.sortOrder ?? index,
      sizes,
    }
  })

  const totalCost = round(
    priced.reduce((sum, l) => sum + l.totalCost, 0),
    2,
  )

  return { priced, totalCost, warnings }
}

export type IncomingCostLine = {
  kind: 'LABOUR' | 'OVERHEAD'
  name: string
  departmentId?: string | null
  basis: 'PER_PIECE' | 'PERCENT'
  value: number
}

/**
 * The cost of one garment, built up the way a costing sheet is: material, then
 * labour, then overhead — which may be a percentage of the two before it, as
 * "factory overhead 10%" usually is. Rounded to the paisa at every step, so the
 * build-up on screen adds up on a calculator.
 */
export function costBom(material: number, rows: IncomingCostLine[]) {
  const labourRows = rows
    .filter((r) => r.kind === 'LABOUR')
    .map((r) => ({ ...r, amount: round(r.value, 2) }))
  const labourCost = round(
    labourRows.reduce((sum, r) => sum + r.amount, 0),
    2,
  )

  const base = round(material + labourCost, 2)
  const overheadRows = rows
    .filter((r) => r.kind === 'OVERHEAD')
    .map((r) => ({
      ...r,
      amount: r.basis === 'PERCENT' ? round((base * r.value) / 100, 2) : round(r.value, 2),
    }))
  const overheadCost = round(
    overheadRows.reduce((sum, r) => sum + r.amount, 0),
    2,
  )

  // Kept in the order they were typed, labour first, so the list reads the
  // same way the form does.
  const priced = [...labourRows, ...overheadRows].map((r, index) => ({
    kind: r.kind,
    name: r.name,
    departmentId: r.departmentId || null,
    basis: r.basis,
    value: round(r.value, 2),
    amount: r.amount,
    sortOrder: index,
  }))

  return {
    rows: priced,
    labourCost,
    overheadCost,
    costPerPiece: round(material + labourCost + overheadCost, 2),
  }
}


export type PricedLine = Awaited<ReturnType<typeof priceBomLines>>['priced'][number]


/** Nests the size rows under their line so both are written in one statement. */
export function toLineCreate(line: PricedLine) {
  const { sizes, ...rest } = line
  return { ...rest, ...(sizes.length > 0 ? { sizes: { create: sizes } } : {}) }
}


/** "LD-SH-2601 in Dusty Blue", or just the code for a BOM with no colour. */
export const bomName = (styleCode: string, color: string | null | undefined) =>
  color ? `${styleCode} in ${color}` : styleCode

/**
 * `typed` is false when no version was sent and 1.0 was assumed. The BOM form
 * no longer asks for a version, so "give this one a different version" would be
 * advice with nowhere to act on it — and a second BOM for one colour is meant
 * to start as a copy anyway.
 */
export const versionClash = (
  styleCode: string,
  color: string | null | undefined,
  version: string,
  typed = true,
) =>
  new AppError(
    typed
      ? `${bomName(styleCode, color)} already has a BOM at version ${version}. Give this one a different version, or copy the existing one.`
      : `${bomName(styleCode, color)} already has a BOM. To start a new version, copy that one from the BOM list.`,
    409,
    'BOM_VERSION_EXISTS',
  )

/**
 * Prisma's own message for a repeated version is "styleId,color,version already
 * exists", which is the database talking to itself. This says what to do.
 */
export function rethrowVersionClash(
  err: unknown,
  styleCode: string,
  color: string | null | undefined,
  version: string,
  typed = true,
): never {
  const code = (err as { code?: string }).code
  const target = (err as { meta?: { target?: unknown } }).meta?.target
  const hitVersion = Array.isArray(target)
    ? target.includes('version')
    : String(target ?? '').includes('version')

  if (code === 'P2002' && hitVersion) throw versionClash(styleCode, color, version, typed)
  throw err
}

/**
 * The unique constraint catches a repeated colour and version, but Postgres
 * counts two blank colours as different, so two colourless BOMs at one version
 * would both save. Checking first closes that gap, and gives the plain message
 * every time rather than only when the database happens to be the one to catch it.
 */
export async function assertVersionFree(
  db: Db,
  styleId: string,
  color: string | null | undefined,
  version: string,
  styleCode: string,
  excludeId?: string,
  typed = true,
): Promise<void> {
  const clash = await db.bOM.findFirst({
    where: {
      styleId,
      color: color || null,
      version,
      ...(excludeId ? { id: { not: excludeId } } : {}),
    },
    select: { id: true },
  })
  if (clash) throw versionClash(styleCode, color, version, typed)
}

