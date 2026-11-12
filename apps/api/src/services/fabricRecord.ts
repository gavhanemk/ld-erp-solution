/**
 * A job card's fabric through cutting: what was given to the cutting
 * contractors, what they used and wasted as each lay came back cut, and what
 * is left over — the fabric given on a lay received, less what it used and
 * wasted. Left over stays on record with whoever has it; nothing moves in
 * stock. After cutting the cloth is pieces, so this is the cutting stage's
 * record only. Counted unit by unit, so metres and kilos never add together.
 */
export interface FabricRecord {
  /** The fabric's unit — m, kg… — or '' when the item has none. */
  unit: string
  /** Given to cutting contractors, on every lay that recorded it. */
  given: number
  /** Of that, given on lays still with their contractors. */
  withCutters: number
  /** Used and wasted, on the lays received back cut. */
  used: number
  waste: number
  /** On received lays: given, less used and waste, where that is above 0 — fabric still with the contractor. */
  leftOver: number
  /** On received lays: used and waste above what was given. */
  overUsed: number
  /** Who has the left over, contractor by contractor. */
  leftWith: Array<{ name: string; qty: number }>
  /** Who used more than they were given, contractor by contractor. */
  overBy: Array<{ name: string; qty: number }>
  /** Lays received with no fabric given recorded, so what is left over on them is not known. */
  notRecorded: number
}

/** A lay as the record reads it; the figures as Prisma gives them (Decimal) or plain numbers. */
export interface LayFabric {
  status: string
  cutterName: string | null
  fabricIssued: unknown
  fabricUsed: unknown
  wastage: unknown
  fabricItem: { uom: { symbol: string } | null } | null
}

const r3 = (n: number) => Math.round(n * 1000) / 1000
const num = (v: unknown) => (v == null ? null : Number(v))
/** Below half a gram or half a millimetre, nothing is left over. */
const NIL = 0.0005

export function fabricRecord(lays: LayFabric[]): FabricRecord[] {
  const byUnit = new Map<string, FabricRecord & { left: Map<string, number>; over: Map<string, number> }>()
  for (const c of lays) {
    if (c.status === 'CANCELLED') continue
    const received = c.status === 'COMPLETED'
    const given = num(c.fabricIssued)
    const used = received ? (num(c.fabricUsed) ?? 0) : 0
    const waste = received ? (num(c.wastage) ?? 0) : 0
    // A lay that says nothing about fabric adds nothing to the record.
    if (given == null && !used && !waste) continue
    const unit = c.fabricItem?.uom?.symbol ?? ''
    const r = byUnit.get(unit) ?? {
      unit,
      given: 0,
      withCutters: 0,
      used: 0,
      waste: 0,
      leftOver: 0,
      overUsed: 0,
      leftWith: [],
      overBy: [],
      notRecorded: 0,
      left: new Map<string, number>(),
      over: new Map<string, number>(),
    }
    if (given != null) r.given += given
    if (!received) {
      if (given != null) r.withCutters += given
    } else {
      r.used += used
      r.waste += waste
      if (given == null) r.notRecorded += 1
      else {
        const who = c.cutterName?.trim() || 'the contractor'
        const left = given - used - waste
        if (left > NIL) r.left.set(who, (r.left.get(who) ?? 0) + left)
        else if (left < -NIL) r.over.set(who, (r.over.get(who) ?? 0) - left)
      }
    }
    byUnit.set(unit, r)
  }
  const list = (m: Map<string, number>) => [...m].map(([name, qty]) => ({ name, qty: r3(qty) })).sort((a, b) => b.qty - a.qty)
  return [...byUnit.values()].map(({ left, over, ...r }) => ({
    ...r,
    given: r3(r.given),
    withCutters: r3(r.withCutters),
    used: r3(r.used),
    waste: r3(r.waste),
    leftOver: r3([...left.values()].reduce((s, n) => s + n, 0)),
    overUsed: r3([...over.values()].reduce((s, n) => s + n, 0)),
    leftWith: list(left),
    overBy: list(over),
  }))
}
