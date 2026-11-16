export interface BomComparableLine {
  componentItemId: string
  departmentId?: string | null
  component?: string | null
  qtyPerUnit: number
  wastagePercent?: number
  unitCost: number | null
  sizes?: { sizeId: string; qtyPerUnit: number }[]
}
export interface BomLineDifference {
  kind: 'added' | 'removed' | 'modified' | 'unchanged'
  current?: BomComparableLine
  existing?: BomComparableLine
  changes: string[]
}
const equal = (a: number, b: number) => Math.abs(a - b) < 0.00005
const sizeKey = (l: BomComparableLine) =>
  JSON.stringify((l.sizes ?? []).map((s) => [s.sizeId, s.qtyPerUnit]).sort())
function changes(a: BomComparableLine, b: BomComparableLine) {
  const result: string[] = []
  if ((a.departmentId ?? '') !== (b.departmentId ?? '')) result.push('Process')
  if ((a.component ?? '') !== (b.component ?? '')) result.push('Garment part')
  if (!equal(a.qtyPerUnit, b.qtyPerUnit)) result.push('Quantity')
  if (!equal(a.wastagePercent ?? 0, b.wastagePercent ?? 0)) result.push('Wastage')
  if (
    a.unitCost === null || b.unitCost === null
      ? a.unitCost !== b.unitCost
      : !equal(a.unitCost, b.unitCost)
  )
    result.push('Rate')
  if (sizeKey(a) !== sizeKey(b)) result.push('Size quantities')
  return result
}
/** Match repeated items one-to-one, preferring identical rows before modified rows. */
export function compareBomLines(current: BomComparableLine[], existing: BomComparableLine[]) {
  const unused = new Set(existing.map((_, i) => i))
  const rows: BomLineDifference[] = []
  const pending: BomComparableLine[] = []
  for (const line of current) {
    const exact = [...unused].find(
      (i) =>
        existing[i].componentItemId === line.componentItemId &&
        changes(line, existing[i]).length === 0
    )
    if (exact === undefined) pending.push(line)
    else {
      unused.delete(exact)
      rows.push({ kind: 'unchanged', current: line, existing: existing[exact], changes: [] })
    }
  }
  for (const line of pending) {
    const candidates = [...unused]
      .filter((i) => existing[i].componentItemId === line.componentItemId)
      .sort(
        (a, b) => changes(line, existing[a]).length - changes(line, existing[b]).length || a - b
      )
    const index = candidates[0]
    if (index === undefined) rows.push({ kind: 'added', current: line, changes: ['Added'] })
    else {
      unused.delete(index)
      rows.push({
        kind: 'modified',
        current: line,
        existing: existing[index],
        changes: changes(line, existing[index]),
      })
    }
  }
  for (const i of unused)
    rows.push({ kind: 'removed', existing: existing[i], changes: ['Removed'] })
  const matched = rows.filter((r) => r.current && r.existing).length
  const identical = rows.filter((r) => r.kind === 'unchanged').length
  const score = matched / Math.max(current.length, existing.length, 1)
  const exact = current.length > 0 && identical === current.length && identical === existing.length
  // One common button must not flag two otherwise different garments.
  const near = rows.filter(
    (r) =>
      r.current &&
      r.existing &&
      (r.current.departmentId ?? '') === (r.existing.departmentId ?? '') &&
      Math.abs(r.current.qtyPerUnit - r.existing.qtyPerUnit) <=
        Math.max(r.current.qtyPerUnit, r.existing.qtyPerUnit) * 0.15
  ).length
  const similar = exact || (matched >= 2 && score >= 0.7 && near / matched >= 0.7)
  return { rows, matched, identical, score, exact, similar }
}
