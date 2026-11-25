/** Shared, ID-based routing comparison. Repeated processes are separate occurrences. */
export interface ComparableRoutingStep {
  sequence: number
  operationId: string
  departmentId?: string | null
  workstationId?: string | null
  contractorId?: string | null
  execution?: string
  skip?: string
  smv?: number | string | null
  ratePerPiece?: number | string | null
  isQcStep?: boolean
  instructions?: string | null
}
export interface ComparableRouting {
  styleId?: string | null
  category?: string | null
  fabricItemId?: string | null
  steps: ComparableRoutingStep[]
}
const number = (v: unknown) => (v == null || v === '' ? null : Number(v))
const values = (s: ComparableRoutingStep) => ({
  Department: s.departmentId || null,
  'Line / unit': s.workstationId || null,
  Contractor: s.contractorId || null,
  'Done at': s.execution ?? 'IN_HOUSE',
  Skipping: s.skip ?? 'NEVER',
  'Minutes / pc': number(s.smv),
  'Rate / pc': number(s.ratePerPiece),
  'Quality check': !!s.isQcStep,
  Instructions: s.instructions?.trim() || null,
})
const changes = (a: ComparableRoutingStep, b: ComparableRoutingStep) => {
  const av = values(a),
    bv = values(b)
  return (Object.keys(av) as Array<keyof typeof av>).filter(
    (key) => av[key] !== bv[key]
  ) as string[]
}
export interface RoutingDifference {
  current?: ComparableRoutingStep
  existing?: ComparableRoutingStep
  kind: 'added' | 'removed' | 'modified' | 'unchanged'
  changes: string[]
}
export function compareRoutings(current: ComparableRouting, existing: ComparableRouting) {
  const a = [...current.steps].sort((a, b) => a.sequence - b.sequence)
  const b = [...existing.steps].sort((a, b) => a.sequence - b.sequence)
  const remaining = new Set(b.map((_, i) => i))
  const pairs = new Map<number, number>()
  // Reserve exact configurations first, so one modified repeated process cannot steal another's match.
  for (const [i, step] of a.entries()) {
    const j = [...remaining].find(
      (j) => b[j].operationId === step.operationId && !changes(step, b[j]).length
    )
    if (j !== undefined) {
      pairs.set(i, j)
      remaining.delete(j)
    }
  }
  for (const [i, step] of a.entries()) {
    if (pairs.has(i)) continue
    const j = [...remaining]
      .filter((j) => b[j].operationId === step.operationId)
      .sort(
        (x, y) =>
          changes(step, b[x]).length - changes(step, b[y]).length ||
          Math.abs(x - i) - Math.abs(y - i)
      )[0]
    if (j !== undefined) {
      pairs.set(i, j)
      remaining.delete(j)
    }
  }
  const rows: RoutingDifference[] = a.map((step, i) => {
    const j = pairs.get(i)
    if (j === undefined) return { current: step, kind: 'added', changes: ['Added process'] }
    const diff = changes(step, b[j])
    if (i !== j) diff.unshift('Sequence')
    return {
      current: step,
      existing: b[j],
      kind: diff.length ? 'modified' : 'unchanged',
      changes: diff,
    }
  })
  for (const j of remaining)
    rows.push({ existing: b[j], kind: 'removed', changes: ['Removed process'] })
  const target = (r: ComparableRouting) =>
    r.styleId
      ? `style:${r.styleId}`
      : r.category?.trim()
        ? `category:${r.category.trim().toLowerCase()}`
        : 'any'
  const sameTarget = target(current) === target(existing)
  const headerChanges = [
    !sameTarget ? 'Applicability' : null,
    (current.fabricItemId || null) !== (existing.fabricItemId || null) ? 'Fabric' : null,
  ].filter(Boolean) as string[]
  const matched = pairs.size
  const unchanged = rows.filter((r) => r.kind === 'unchanged').length
  const total = Math.max(a.length, b.length)
  const overlap = total ? matched / total : 0
  const exact = !!total && !headerChanges.length && unchanged === total
  // A ubiquitous cutting/packing pair alone should not suggest unrelated routes.
  const configurationScore = matched
    ? rows
        .filter((r) => r.existing && r.current)
        .reduce((score, r) => score + (1 - changes(r.current!, r.existing!).length / 9), 0) /
      matched
    : 0
  const similar =
    exact ||
    (overlap >= 0.7 &&
      configurationScore >= 0.65 &&
      (matched >= 3 || (sameTarget && matched === total)))
  const kind = exact ? 'EXACT' : matched === total ? 'SIMILAR' : 'PARTIAL'
  const differences = [...headerChanges, ...new Set(rows.flatMap((r) => r.changes))]
  return { exact, similar, kind, matched, unchanged, total, overlap, differences, rows }
}
