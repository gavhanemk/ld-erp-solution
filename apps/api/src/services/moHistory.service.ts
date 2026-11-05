import type { Prisma, PrismaClient } from '@prisma/client'

/**
 * A manufacturing order's history: who changed what on it, and when, in plain
 * words, read from the audit trail. Every save of an order keeps the whole of
 * it as it was and as it became; here the two are compared, so "Edited"
 * says what: a date moved, a size's pieces changed, a line added, the routing
 * swapped. Raising, releasing, holds, stages, closing and completing are told
 * as such.
 */

type Db = PrismaClient | Prisma.TransactionClient
// A saved snapshot: the order as the audit row kept it (JSON), or as Prisma returned it.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Snap = Record<string, any>

const asObj = (v: unknown): Snap | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Snap) : null)
const isOrder = (s: Snap | null): s is Snap => !!s && typeof s.moNumber === 'string'

const day = (v: unknown) => {
  if (!v) return '—'
  const d = v instanceof Date ? v : new Date(String(v))
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' })
}
const sameDay = (a: unknown, b: unknown) => day(a) === day(b)
const pcs = (n: unknown) => `${Number(n ?? 0).toLocaleString('en-IN')} pcs`
const word = (s: unknown) => String(s ?? '').toLowerCase().replace(/_/g, ' ')

const lineName = (l: Snap) => `${l?.style?.code ?? 'Style'}${l?.color ? ` ${l.color}` : ''}`
const lineKey = (l: Snap) => `${l?.style?.code ?? ''}|${l?.color ?? ''}`
const sizesOf = (l: Snap) =>
  new Map<string, { qty: number; seq: number }>(
    ((l?.sizes ?? []) as Snap[]).map((s) => [String(s?.size?.code ?? '—'), { qty: Number(s?.qty ?? 0), seq: Number(s?.size?.sequence ?? 0) }]),
  )
const sizeList = (l: Snap) =>
  [...sizesOf(l).entries()]
    .sort((a, b) => a[1].seq - b[1].seq)
    .map(([code, v]) => `${code} × ${v.qty}`)
    .join(', ')

/** What changed between two snapshots of one order, in plain words; empty when nothing did. */
export function moChanges(before: Snap, after: Snap): string[] {
  const out: string[] = []
  if (!sameDay(before.plannedStartDate, after.plannedStartDate)) out.push(`Planned start: ${day(before.plannedStartDate)} → ${day(after.plannedStartDate)}`)
  if (!sameDay(before.plannedEndDate, after.plannedEndDate)) out.push(`Planned finish: ${day(before.plannedEndDate)} → ${day(after.plannedEndDate)}`)
  const nb = String(before.notes ?? '').trim()
  const na = String(after.notes ?? '').trim()
  if (nb !== na) out.push(!nb ? `Notes added: “${na}”` : !na ? `Notes cleared (they said “${nb}”)` : `Notes: “${nb}” → “${na}”`)
  const rb = before.routing?.code ?? null
  const ra = after.routing?.code ?? null
  if (rb !== ra) out.push(!ra ? `Routing ${rb} taken off` : !rb ? `Routing set: ${ra}` : `Routing: ${rb} → ${ra}`)

  // Lines, by style and colour: a save writes them afresh, so their own ids change.
  const was = new Map<string, Snap>(((before.lines ?? []) as Snap[]).map((l) => [lineKey(l), l]))
  const now = new Map<string, Snap>(((after.lines ?? []) as Snap[]).map((l) => [lineKey(l), l]))
  for (const [k, l] of now) {
    const old = was.get(k)
    if (!old) {
      out.push(`${lineName(l)} added: ${sizeList(l) || pcs(l.totalQty)}`)
      continue
    }
    const sb = sizesOf(old)
    const sa = sizesOf(l)
    const codes = [...new Set([...sb.keys(), ...sa.keys()])].sort(
      (x, y) => (sa.get(x)?.seq ?? sb.get(x)?.seq ?? 0) - (sa.get(y)?.seq ?? sb.get(y)?.seq ?? 0),
    )
    for (const code of codes) {
      const q0 = sb.get(code)?.qty ?? 0
      const q1 = sa.get(code)?.qty ?? 0
      if (q0 !== q1) out.push(`${lineName(l)} · size ${code}: ${q0} → ${q1} pcs`)
    }
    if (!sb.size && !sa.size && Number(old.totalQty) !== Number(l.totalQty)) out.push(`${lineName(l)}: ${pcs(old.totalQty)} → ${pcs(l.totalQty)}`)
    const vb = old.bom?.version ?? null
    const va = l.bom?.version ?? null
    if (vb !== va) out.push(`${lineName(l)} · BOM ${vb ? `v${vb}` : 'none'} → ${va ? `v${va}` : 'none'}`)
  }
  for (const [k, l] of was) if (!now.has(k)) out.push(`${lineName(l)} removed (it was ${pcs(l.totalQty)})`)
  if (Number(before.totalPlannedQty) !== Number(after.totalPlannedQty)) {
    out.push(`Total: ${pcs(before.totalPlannedQty)} → ${pcs(after.totalPlannedQty)}`)
  }
  return out
}

/** One save, in a few words: what happened, and the details under it. */
function describe(action: string, beforeRaw: unknown, afterRaw: unknown): { what: string; changes: string[] } {
  const b = asObj(beforeRaw)
  const a = asObj(afterRaw)

  if (action === 'CREATE' && isOrder(a)) {
    const changes = ((a.lines ?? []) as Snap[]).map((l) => `${lineName(l)}: ${sizeList(l) || pcs(l.totalQty)}`)
    changes.push(`Total ${pcs(a.totalPlannedQty)}`)
    if (a.plannedStartDate || a.plannedEndDate) changes.push(`Planned ${day(a.plannedStartDate)} → ${day(a.plannedEndDate)}`)
    if (a.routing?.code) changes.push(`Routing ${a.routing.code}`)
    if (a.notes) changes.push(`Notes: “${a.notes}”`)
    return { what: a.status === 'DRAFT' ? 'Raised as a draft' : 'Raised and released to the floor', changes }
  }
  if (isOrder(b) && isOrder(a)) {
    if (b.status !== a.status) {
      if (a.status === 'CLOSED') return { what: 'Closed', changes: a.closeReason ? [a.closeReason] : [] }
      if (a.status === 'COMPLETED') {
        return { what: `Completed with ${pcs(a.totalPackedQty)} of ${pcs(a.totalPlannedQty)}`, changes: a.closeReason ? [a.closeReason] : [] }
      }
      return { what: `Status: ${word(b.status)} → ${word(a.status)}`, changes: [] }
    }
    const changes = moChanges(b, a)
    return { what: 'Edited', changes: changes.length ? changes : ['Saved, nothing changed'] }
  }
  if (!b && isOrder(a)) return { what: a.status === 'RELEASED' ? 'Released to the floor' : 'Updated', changes: [] }
  if (a && 'heldAt' in a) {
    return a.heldAt
      ? { what: 'Put on hold', changes: a.holdReason ? [String(a.holdReason)] : [] }
      : { what: 'Taken off hold', changes: a.resumedBecause ? [String(a.resumedBecause)] : [] }
  }
  if (a && 'tagGarments' in a) return { what: a.tagGarments ? 'Garment tags switched on' : 'Garment tags switched off', changes: [] }
  if (a && Array.isArray(a.route)) {
    const route = (a.route as string[]).join(' → ') || 'none'
    if (b && Array.isArray(b.route)) {
      return { what: 'Stages changed', changes: [`${(b.route as string[]).join(' → ') || 'none'} → ${route}`, ...(a.reason ? [String(a.reason)] : [])] }
    }
    return { what: `Stages set up${a.routing ? ` from ${a.routing}` : ''}`, changes: [route] }
  }
  return { what: action === 'CREATE' ? 'Created' : 'Updated', changes: [] }
}

/** The order's history, newest first. */
export async function moHistory(db: Db, moId: string) {
  const logs = await db.auditLog.findMany({
    where: { entityType: 'ManufacturingOrder', entityId: moId },
    select: { id: true, action: true, before: true, after: true, createdAt: true, user: { select: { name: true } } },
    orderBy: { createdAt: 'desc' },
    take: 100,
  })
  return logs.map((l) => ({ id: l.id, at: l.createdAt, by: l.user?.name ?? null, ...describe(l.action, l.before, l.after) }))
}
