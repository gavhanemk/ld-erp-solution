import type { ReportColumn, ReportDefinition, RegisterSpec } from './types'
import { asDate, istDay, type RegisterTotal, type UnitTotal } from './register'

/**
 * A report's figures added up by what it is about — the supplier, the
 * customer, the item — worked out once, here.
 *
 * The Summary tab prints these tables and so does the workbook's Summary
 * sheet, so the two cannot disagree. Each total row is the detailed report's
 * own grand total, so neither can disagree with the Data sheet either.
 */

/** A figure in a summary table: a sum, or a quantity unit by unit. */
export type SummaryValue = number | UnitTotal[] | null

export interface SummaryGrid {
  /** The column the rows are grouped by. */
  key: string
  /** "Supplier". */
  label: string
  /** What the count column counts: "Bills". */
  counted: string
  figures: Array<{ key: string; label: string; type: string }>
  /** Biggest first. */
  rows: Array<{ name: string; documents: number; values: SummaryValue[]; share: number | null }>
  total: { documents: number; values: SummaryValue[] }
  /** Whether the share column means anything — it does not of a figure that goes negative. */
  shared: boolean
}

const round2 = (n: number) => Math.round(n * 100) / 100
const round3 = (n: number) => Math.round(n * 1000) / 1000

const DAY = new Intl.DateTimeFormat('en-GB', {
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
  timeZone: 'UTC',
})

/** A group's name as the register prints it: a status in words, a date as a date. */
function groupName(c: ReportColumn | undefined, v: unknown): string {
  if (v == null || v === '') return '—'
  if (c?.type === 'badge') return c.badges?.[String(v)] ?? String(v)
  if (c?.type === 'date') {
    const d = asDate(v)
    if (!d) return String(v)
    const [y, m, day] = istDay(d).split('-').map(Number)
    return DAY.format(new Date(Date.UTC(y, m - 1, day)))
  }
  return String(v)
}

const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)

export function summaryGrids(
  def: ReportDefinition,
  rows: Array<Record<string, unknown>>,
  columns: ReportColumn[],
  spec: RegisterSpec,
  grand: RegisterTotal
): SummaryGrid[] {
  const byKey = new Map(columns.map((c) => [c.key, c]))

  // What to group by: the report's own choice, in its order. A report that
  // names none is grouped by its first column of words.
  const named = def.pivot ? (Array.isArray(def.pivot.rows) ? def.pivot.rows : [def.pivot.rows]) : []
  let keys = named.filter((k) => byKey.has(k))
  if (!keys.length) {
    const words = columns.find((c) => c.type === 'text' || c.type === 'badge')
    keys = words ? [words.key] : []
  }

  // What to total: the report's own choice, or every figure that adds up.
  const chosen = (def.pivot?.values ?? [])
    .map((k) => byKey.get(k))
    .filter((c): c is ReportColumn => c?.total === 'sum')
  const figures = chosen.length ? chosen : columns.filter((c) => c.total === 'sum')
  const money = figures.find((c) => c.type === 'money')

  const isVoid = (r: Record<string, unknown>) =>
    spec.void != null && r[spec.void.key] === spec.void.value

  const valueOf = (c: ReportColumn, sums: Map<string, number>, units: Map<string, Map<string, number>>) => {
    if (c.type === 'qty' && c.unitKey) {
      const per = units.get(c.key)
      return per
        ? [...per.entries()]
            .map(([unit, value]) => ({ unit, value: round3(value) }))
            .sort((a, b) => a.unit.localeCompare(b.unit))
        : []
    }
    const n = sums.get(c.key) ?? 0
    return c.type === 'qty' ? round3(n) : round2(n)
  }

  return keys.map((key) => {
    const groups = new Map<
      string,
      { documents: Set<unknown>; sums: Map<string, number>; units: Map<string, Map<string, number>> }
    >()
    rows.forEach((r, i) => {
      const name = groupName(byKey.get(key), r[key])
      let g = groups.get(name)
      if (!g) {
        g = { documents: new Set(), sums: new Map(), units: new Map() }
        groups.set(name, g)
      }
      if (!isVoid(r)) g.documents.add(spec.documentKey ? r[spec.documentKey] : i)
      for (const c of figures) {
        const v = r[c.key]
        if (v == null || v === '') continue
        const n = Number(v)
        if (!Number.isFinite(n)) continue
        if (c.type === 'qty' && c.unitKey) {
          // Metres with metres, pieces with pieces — never one total of both.
          const unit = String(r[c.unitKey] ?? '') || 'units'
          const per = g.units.get(c.key) ?? new Map<string, number>()
          per.set(unit, (per.get(unit) ?? 0) + n)
          g.units.set(c.key, per)
        } else {
          g.sums.set(c.key, (g.sums.get(c.key) ?? 0) + n)
        }
      }
    })

    const list = [...groups.entries()].map(([name, g]) => ({
      name,
      documents: g.documents.size,
      size: money ? (g.sums.get(money.key) ?? 0) : g.documents.size,
      values: figures.map((c) => valueOf(c, g.sums, g.units)),
    }))
    list.sort((a, b) => b.size - a.size)

    const whole = money ? (grand.sums[money.key] ?? 0) : 0
    const shared = money != null && whole > 0 && list.every((g) => g.size >= 0)

    return {
      key,
      label: byKey.get(key)?.label ?? key,
      counted: capital(spec.noun.many),
      figures: figures.map((c) => ({ key: c.key, label: c.label, type: c.type })),
      rows: list.map((g) => ({
        name: g.name,
        documents: g.documents,
        values: g.values,
        share: shared ? g.size / whole : null,
      })),
      total: {
        documents: grand.documents,
        values: figures.map((c) =>
          c.type === 'qty' && c.unitKey ? (grand.byUnit[c.key] ?? []) : (grand.sums[c.key] ?? 0)
        ),
      },
      shared,
    }
  })
}
