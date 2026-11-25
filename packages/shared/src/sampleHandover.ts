/**
 * What a sample hands over to bulk (phase 8). For each colour the buyer
 * approved, a draft production BOM made from the round it was approved in:
 * that round's sample BOM lines at what they were planned a piece, priced at
 * what the request paid for them (the finalised cost sheet), with what the
 * sample really used a piece beside them; and that round's labour and other
 * charges, a piece, as the BOM's labour and overhead. Masters approves the BOM
 * as it approves any other: nothing here approves one.
 *
 * One function for the server, which makes the BOMs, and the screen, which
 * says what will be made before anyone prepares the handover.
 */
import { colourKey, requestColours, type SampleReviewRound } from './sampleReview'
import type { SampleCostRound, SampleRateBasis } from './sampleCost'

const num = (v: unknown) => {
  const x = Number(v ?? 0)
  return Number.isFinite(x) ? x : 0
}
const round2 = (v: number) => Number(v.toFixed(2))
const round4 = (v: number) => Number(v.toFixed(4))

/** A sample BOM line as a round keeps it. */
export interface HandoverMaterial {
  id: string
  itemId: string | null
  component: string
  colour: string | null
  departmentId: string | null
  qtyPerPiece: unknown
  wastagePct: unknown
  plannedQty: unknown
  source: string
  waivedAt?: unknown
  item?: { code: string; name: string; uom?: { symbol: string } | null } | null
}
export interface HandoverRound extends SampleReviewRound {
  id: string
  revision: number
  materials: HandoverMaterial[]
}

/**
 * Each colour the buyer approved, with the round it was approved in: the
 * latest round that made it. Rounds latest first, as the request lists them.
 */
export function approvedFrom<R extends HandoverRound>(rounds: R[]): Array<{ colour: string; round: R }> {
  return requestColours(rounds)
    .filter((c) => c.status === 'APPROVED')
    .map((c) => ({ colour: c.colour, round: rounds.find((r) => r.revision === c.revision)! }))
}

/** One line of the draft BOM, before Masters prices it (priceBomLines). */
export interface HandoverBomLine {
  materialId: string
  componentItemId: string
  component: string | null
  departmentId: string | null
  /** As the sample was planned a piece, before wastage. */
  qtyPerUnit: number
  wastagePercent: number
  /** What the request paid a unit; none for the buyer's own, which Masters prices. */
  unitCost: number | null
  basis: SampleRateBasis | null
  customerSupplied: boolean
  /** What the sample really used and wasted a piece, when its pieces are known. */
  usedPerPiece: number | null
  unit: string
  notes: string
  sortOrder: number
}

/** Pieces the round planned in a colour, or in every colour. */
function plannedPieces(round: HandoverRound, colour: string | null) {
  const colours = (round.specification.colours ?? []) as Array<{ colour: string; sizes: Array<{ qty: unknown }> }>
  return colours
    .filter((c) => !colour || colourKey(c.colour) === colourKey(colour))
    .reduce((t, c) => t + c.sizes.reduce((s, z) => s + num(z.qty), 0), 0)
}

/**
 * The draft BOM's lines for one approved colour: the round's lines for every
 * colour and for that colour, waived ones left out. A line planned as a fixed
 * quantity rather than a piece's is spread over the pieces it was planned for.
 * `skipped` names a line that gives no quantity a piece either way.
 */
export function handoverBomLines(
  round: HandoverRound,
  colour: string,
  sheet: Pick<SampleCostRound, 'materials' | 'colours' | 'pieces'> | null
): { lines: HandoverBomLine[]; skipped: string[] } {
  const key = colourKey(colour)
  const skipped: string[] = []
  const lines: HandoverBomLine[] = []
  for (const m of round.materials) {
    if (m.waivedAt || !m.itemId) continue
    const own = m.colour?.trim() ? colourKey(m.colour) === key : true
    if (!own) continue
    const forColour = m.colour?.trim() ? m.colour : null
    const name = `${m.item?.name ?? 'Material'}${m.component ? ` (${m.component})` : ''}`
    const planned = plannedPieces(round, forColour)
    // A fixed quantity already holds what the cutting wastes: spread, it carries no wastage again.
    const perPiece = num(m.qtyPerPiece) > 0
    const qtyPerUnit = perPiece ? round4(num(m.qtyPerPiece)) : planned > 0 ? round4(num(m.plannedQty) / planned) : 0
    if (!(qtyPerUnit > 0)) {
      skipped.push(name)
      continue
    }
    const costed = sheet?.materials.find((x) => x.materialId === m.id) ?? null
    const buyers = m.source === 'BUYER_SUPPLIED' || costed?.basis === 'BUYER'
    const paid = costed && (costed.basis === 'PURCHASE' || costed.basis === 'STORE') && costed.rate > 0 ? costed.rate : null
    const pieces = !sheet
      ? 0
      : forColour
        ? (sheet.colours.find((c) => colourKey(c.colour) === colourKey(forColour))?.pieces ?? 0)
        : sheet.pieces
    const usedPerPiece = costed && pieces > 0 ? round4(costed.consumed / pieces) : null
    const unit = m.item?.uom?.symbol ?? ''
    lines.push({
      materialId: m.id,
      componentItemId: m.itemId,
      component: m.component || null,
      departmentId: m.departmentId || null,
      qtyPerUnit,
      wastagePercent: perPiece ? round2(num(m.wastagePct)) : 0,
      unitCost: buyers ? null : paid,
      basis: costed?.basis ?? null,
      customerSupplied: buyers,
      usedPerPiece,
      unit,
      notes: [
        usedPerPiece !== null ? `The sample used ${usedPerPiece} ${unit} a piece, waste included` : '',
        buyers ? 'supplied by the buyer for the sample: price it here' : '',
        !buyers && paid === null ? 'no rate was paid on the sample' : '',
      ]
        .filter(Boolean)
        .join('; '),
      sortOrder: lines.length,
    })
  }
  return { lines, skipped }
}

/**
 * The round's labour and other charges, a piece, as the draft BOM's labour
 * and overhead: what the sample took, named so, for Masters to judge.
 */
export function handoverCostLines(
  sheet: Pick<SampleCostRound, 'labour' | 'misc' | 'pieces'> | null,
  revision: number
): Array<{ kind: 'LABOUR' | 'OVERHEAD'; name: string; basis: 'PER_PIECE'; value: number }> {
  if (!sheet || !(sheet.pieces > 0)) return []
  const labour = round2(sheet.labour / sheet.pieces)
  const misc = round2(sheet.misc / sheet.pieces)
  return [
    ...(labour > 0
      ? [{ kind: 'LABOUR' as const, name: `Sample labour, round ${revision}`, basis: 'PER_PIECE' as const, value: labour }]
      : []),
    ...(misc > 0
      ? [{ kind: 'OVERHEAD' as const, name: `Sample charges, round ${revision}`, basis: 'PER_PIECE' as const, value: misc }]
      : []),
  ]
}

/** What a handover keeps of one colour's BOM, as the request shows it. */
export interface SampleHandoverBom {
  colour: string
  bomId: string
  version: string
  /** Made from the sample now, as a draft; otherwise one Masters had approved. */
  made: boolean
  /** The round it was made from. */
  revision: number | null
  lines: Array<{
    itemId: string
    item: string
    component: string | null
    qtyPerUnit: number
    wastagePercent: number
    unitCost?: number | null
    usedPerPiece?: number | null
    unit?: string
    customerSupplied?: boolean
    /** A linked BOM's own quantities size by size. */
    sizes?: Array<{ sizeId: string; qtyPerUnit: number }>
  }>
  /** A draft's labour and charges a piece; a linked BOM's are Masters' own. */
  costLines?: Array<{ kind: string; name: string; value: number }>
  totalCost?: number | null
  costPerPiece?: number | null
  baseSizeId?: string | null
  approvedAt?: string | Date | null
}
export interface SampleHandoverRouting {
  id: string
  code: string
  name: string
  version: number
  made: boolean
  revision: number | null
  steps: Array<{
    sequence: number
    operationId: string
    departmentId: string
    workstationId?: string | null
    contractorId: string | null
    execution: string
    instructions?: string | null
  }>
}
