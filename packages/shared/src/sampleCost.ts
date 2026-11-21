/**
 * What a sample cost to make (phase 7), round by round and for the request:
 * the material it consumed, the labour of its steps and its outside units'
 * charges, and its other charges (testing, pattern, setup, couriers).
 *
 * Material is what was used and wasted, at what the request paid for it: the
 * weighted rate of its own purchase order lines, after their line discount
 * and before GST (input tax is recovered). Never the store's average, which
 * carries freight and other buyers' prices. The buyer's own material is
 * free. A line issued from a store before samples were bought for falls back
 * to what the store carried it at.
 *
 * Rounded as a costing sheet is: a rate to 4 places, every amount and total
 * to the paisa at each step, so the figures add up on a calculator. One
 * function, used by the server for the sheet, the finalised snapshot and the
 * prints, and by the screens.
 */
import { makingLedger, type MakingInput } from './sampleMaking'
import type { SampleSpecification } from './sampling'

export const SAMPLE_CHARGE_KINDS = ['COURIER', 'TESTING', 'PATTERN', 'SETUP', 'OTHER'] as const
export type SampleChargeKind = (typeof SAMPLE_CHARGE_KINDS)[number]
export const SAMPLE_CHARGE_LABEL: Record<SampleChargeKind, string> = {
  COURIER: 'Courier',
  TESTING: 'Testing',
  PATTERN: 'Pattern / CAD',
  SETUP: 'Embroidery / print setup',
  OTHER: 'Other',
}

const num = (v: unknown) => {
  const x = Number(v)
  return Number.isFinite(x) ? x : 0
}
const round2 = (v: number) => Math.round(v * 100) / 100
const round3 = (v: number) => Math.round(v * 1000) / 1000
const round4 = (v: number) => Math.round(v * 10000) / 10000
type When = string | Date | null | undefined

/** How a material line's rate was found. */
export type SampleRateBasis = 'PURCHASE' | 'STORE' | 'BUYER' | 'NONE'
export const SAMPLE_RATE_BASIS_LABEL: Record<SampleRateBasis, string> = {
  PURCHASE: 'Bought for this request',
  STORE: 'Store rate (issued before it was bought for the sample)',
  BUYER: 'Supplied by the buyer',
  NONE: 'No rate found',
}
export interface SampleCostMaterial {
  /** The BOM line; none for leftovers closed out as used in the sample. */
  materialId: string | null
  component: string
  item: { code: string; name: string; unit: string }
  colour: string | null
  consumed: number
  rate: number
  basis: SampleRateBasis
  amount: number
}
export interface SampleCostLabour {
  stageId: string
  sequence: number
  name: string
  /** The step's own labour, or an outside unit's charges at it. */
  kind: 'LABOUR' | 'OUTSIDE'
  who: string
  amount: number
}
export interface SampleCostMisc {
  /** The charge, or the challan it came on. */
  id: string
  kind: SampleChargeKind
  description: string
  billRef: string | null
  amount: number
  /** A courier charge from a Sample Delivery Challan. */
  fromChallan: boolean
}
export interface SampleCostTotals {
  material: number
  labour: number
  misc: number
  total: number
  /** Pieces the making route finished. */
  pieces: number
  /** None while nothing finished. */
  perPiece: number | null
}
export interface SampleCostRound extends SampleCostTotals {
  roundId: string
  revision: number
  milestone: string
  state: string
  colours: Array<{ colour: string; pieces: number }>
  materials: SampleCostMaterial[]
  labourLines: SampleCostLabour[]
  miscLines: SampleCostMisc[]
}
export interface SampleCostSheet extends SampleCostTotals {
  requestId: string
  number: string
  title: string
  buyer: string | null
  buyerStyleRef: string | null
  style: { code: string; name: string } | null
  rounds: SampleCostRound[]
  /** Charges for the request as a whole, not one round. */
  requestCharges: SampleCostMisc[]
  /** Bought for the request and still in the sample store: not a cost until it is closed out as used. */
  notCosted: Array<{ item: string; qty: number; unit: string }>
  computedAt: string
}

/** A purchase order line bought for one of the request's lines (no other buyer's). */
export interface SampleCostOrderLine {
  itemId: string
  qty: unknown
  receivedQty: unknown
  /** After the line's own discount, before the order discount and tax. */
  amount: unknown
}
export interface SampleCostInput {
  id: string
  number: string
  title: string
  customer: { name: string } | null
  buyerStyleRef: string | null
  style: { code: string; name: string } | null
  rounds: Array<{
    id: string
    revision: number
    state: string
    specification: Pick<SampleSpecification, 'colours' | 'milestone'>
    stages: Array<
      MakingInput['stages'][number] & {
        labourAmount?: unknown
        contractorId?: string | null
      }
    >
    works?: MakingInput['works']
    transfers?: MakingInput['transfers']
    jobWorks?: Array<
      NonNullable<MakingInput['jobWorks']>[number] & {
        vendor?: { name: string } | null
        returns: Array<NonNullable<MakingInput['jobWorks']>[number]['returns'][number] & { chargeAmount?: unknown }>
      }
    >
    dispatches?: Array<{ id: string; number: string; courierCharge?: unknown; cancelledAt?: When; courier?: string | null }>
    materials: Array<{
      id: string
      itemId: string | null
      component: string
      colour: string | null
      source: string
      usedQty: unknown
      wasteQty: unknown
      issuedQty: unknown
      issuedValue?: unknown
      item: { code: string; name: string; uom?: { symbol: string } | null } | null
    }>
  }>
  charges?: Array<{
    id: string
    roundId: string | null
    kind: string
    description: string
    amount: unknown
    billRef: string | null
    removedAt?: When
  }>
  closeOuts?: Array<{
    roundId: string
    itemId: string
    kind: string
    qty: unknown
    value?: unknown
    item: { code: string; name: string; uom?: { symbol: string } | null }
  }>
  /** The purchase order lines bought for the request's lines, every round's. */
  orders: SampleCostOrderLine[]
  /** What the request still holds in the sample stores (samplePool). */
  pool?: { stores: Array<{ itemId: string; available: number }> } | null
}

/**
 * What the request paid for one unit of an item: its lines' value over
 * their quantity, weighted by what arrived. Null while nothing bought for it
 * has arrived: what was used then came from somewhere else.
 */
export function purchaseRate(orders: SampleCostOrderLine[], itemId: string): number | null {
  const lines = orders.filter((o) => o.itemId === itemId && num(o.qty) > 0)
  const received = lines.reduce((t, o) => t + num(o.receivedQty), 0)
  return received > 0
    ? round4(lines.reduce((t, o) => t + (num(o.amount) / num(o.qty)) * num(o.receivedQty), 0) / received)
    : null
}

const totalsOf = (material: number, labour: number, misc: number, pieces: number): SampleCostTotals => {
  const total = round2(material + labour + misc)
  return {
    material: round2(material),
    labour: round2(labour),
    misc: round2(misc),
    total,
    pieces,
    perPiece: pieces > 0 ? round2(total / pieces) : null,
  }
}
const kindOf = (k: string): SampleChargeKind =>
  (SAMPLE_CHARGE_KINDS as readonly string[]).includes(k) ? (k as SampleChargeKind) : 'OTHER'

/** The request's cost sheet as its records stand now. */
export function sampleCostSheet(input: SampleCostInput, now: Date = new Date()): SampleCostSheet {
  const charges = (input.charges ?? []).filter((c) => !c.removedAt)
  const misc = (c: NonNullable<SampleCostInput['charges']>[number]): SampleCostMisc => ({
    id: c.id,
    kind: kindOf(c.kind),
    description: c.description,
    billRef: c.billRef,
    amount: round2(num(c.amount)),
    fromChallan: false,
  })
  const made = [...input.rounds].filter((r) => r.state !== 'DRAFT').sort((a, b) => a.revision - b.revision)
  const rounds = made.map((r): SampleCostRound => {
      const unitOf = (i: { uom?: { symbol: string } | null } | null) => i?.uom?.symbol ?? ''
      const materials: SampleCostMaterial[] = []
      for (const m of r.materials) {
        if (!m.itemId) continue
        const consumed = round3(num(m.usedQty) + num(m.wasteQty))
        if (consumed <= 0) continue
        const bought = purchaseRate(input.orders, m.itemId)
        const store = num(m.issuedQty) > 0 ? round4(num(m.issuedValue) / num(m.issuedQty)) : null
        const [rate, basis]: [number, SampleRateBasis] =
          m.source === 'BUYER_SUPPLIED'
            ? [0, 'BUYER']
            : bought !== null
              ? [bought, 'PURCHASE']
              : store !== null && m.issuedValue !== undefined
                ? [store, 'STORE']
                : [0, 'NONE']
        materials.push({
          materialId: m.id,
          component: m.component,
          item: { code: m.item?.code ?? '', name: m.item?.name ?? '', unit: unitOf(m.item) },
          colour: m.colour,
          consumed,
          rate,
          basis,
          amount: round2(consumed * rate),
        })
      }
      // Leftovers closed out as used in the sample: the request's material too.
      // One booked against a round not costed (still being prepared) goes with the latest made.
      const costed = new Set(made.map((x) => x.id))
      const latestMade = made.at(-1)?.id
      const ownCloseOuts = (input.closeOuts ?? []).filter(
        (x) => x.kind === 'USED' && (x.roundId === r.id || (!costed.has(x.roundId) && r.id === latestMade))
      )
      for (const c of ownCloseOuts) {
        const qty = round3(num(c.qty))
        const bought = purchaseRate(input.orders, c.itemId)
        const [rate, basis]: [number, SampleRateBasis] =
          bought !== null
            ? [bought, 'PURCHASE']
            : c.value !== undefined && qty > 0
              ? [round4(num(c.value) / qty), 'STORE']
              : [0, 'NONE']
        materials.push({
          materialId: null,
          component: 'Leftover used in the sample',
          item: { code: c.item.code, name: c.item.name, unit: unitOf(c.item) },
          colour: null,
          consumed: qty,
          rate,
          basis,
          amount: round2(qty * rate),
        })
      }
      const labourLines: SampleCostLabour[] = []
      for (const s of [...r.stages].sort((a, b) => a.sequence - b.sequence)) {
        const own = round2(num(s.labourAmount))
        if (own > 0)
          labourLines.push({ stageId: s.id, sequence: s.sequence, name: s.name, kind: 'LABOUR', who: '', amount: own })
        const jobs = (r.jobWorks ?? []).filter((j) => j.stageId === s.id && !j.cancelledAt)
        const units = [...new Set(jobs.map((j) => j.vendor?.name ?? 'Outside unit'))]
        const outside = round2(
          jobs.reduce(
            (t, j) =>
              t +
              j.returns
                .filter((x) => !x.undoneAt)
                .reduce((u, x) => u + num((x as { chargeAmount?: unknown }).chargeAmount), 0),
            0
          )
        )
        if (outside > 0)
          labourLines.push({
            stageId: s.id,
            sequence: s.sequence,
            name: s.name,
            kind: 'OUTSIDE',
            who: units.join(', '),
            amount: outside,
          })
      }
      const miscLines: SampleCostMisc[] = [
        ...charges.filter((c) => c.roundId === r.id).map(misc),
        ...(r.dispatches ?? [])
          .filter((d) => !d.cancelledAt && num(d.courierCharge) > 0)
          .map((d) => ({
            id: d.id,
            kind: 'COURIER' as const,
            description: `Courier on ${d.number}${d.courier ? ` (${d.courier})` : ''}`,
            billRef: d.number,
            amount: round2(num(d.courierCharge)),
            fromChallan: true,
          })),
      ]
      // What the route finished, colour by colour.
      const last = makingLedger({
        specification: r.specification,
        stages: r.stages,
        works: r.works ?? [],
        transfers: r.transfers ?? [],
        jobWorks: r.jobWorks ?? [],
      }).at(-1)
      const colours = [...new Set((last?.cells ?? []).map((c) => c.colour))].map((colour) => ({
        colour,
        pieces: (last?.cells ?? []).filter((c) => c.colour === colour).reduce((t, c) => t + c.done, 0),
      }))
      const pieces = last?.total.done ?? 0
      return {
        roundId: r.id,
        revision: r.revision,
        milestone: r.specification.milestone,
        state: r.state,
        colours,
        materials,
        labourLines,
        miscLines,
        ...totalsOf(
          materials.reduce((t, m) => t + m.amount, 0),
          labourLines.reduce((t, l) => t + l.amount, 0),
          miscLines.reduce((t, l) => t + l.amount, 0),
          pieces
        ),
      }
    })
  const requestCharges = charges.filter((c) => !c.roundId).map(misc)
  // What the request bought and still holds: a note, not a cost.
  const names = new Map<string, { name: string; unit: string }>()
  for (const r of input.rounds)
    for (const m of r.materials)
      if (m.itemId && m.item) names.set(m.itemId, { name: m.item.name, unit: m.item.uom?.symbol ?? '' })
  const notCosted = (input.pool?.stores ?? [])
    .filter((s) => s.available > 0 && names.has(s.itemId))
    .map((s) => ({ item: names.get(s.itemId)!.name, qty: round3(s.available), unit: names.get(s.itemId)!.unit }))
  return {
    requestId: input.id,
    number: input.number,
    title: input.title,
    buyer: input.customer?.name ?? null,
    buyerStyleRef: input.buyerStyleRef,
    style: input.style ? { code: input.style.code, name: input.style.name } : null,
    rounds,
    requestCharges,
    notCosted,
    computedAt: now.toISOString(),
    ...totalsOf(
      rounds.reduce((t, r) => t + r.material, 0),
      rounds.reduce((t, r) => t + r.labour, 0),
      rounds.reduce((t, r) => t + r.misc, 0) + requestCharges.reduce((t, c) => t + c.amount, 0),
      rounds.reduce((t, r) => t + r.pieces, 0)
    ),
  }
}
