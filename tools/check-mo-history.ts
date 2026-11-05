// What a manufacturing order's history says changed between two saves: dates,
// notes, routing, a size's pieces, a line added or removed, the total. Plain
// snapshots, no database. Run from apps/api:
//
//   cd apps/api
//   npx tsx ../../tools/check-mo-history.ts
import { moChanges } from '../apps/api/src/services/moHistory.service'

let pass = 0
let fail = 0
const check = (label: string, ok: boolean, extra = '') => {
  ok ? pass++ : fail++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${extra ? ' — ' + extra : ''}`)
}

const line = (color: string, sizes: Array<[string, number, number]>, bom = '1.0') => ({
  color,
  totalQty: sizes.reduce((s, [, q]) => s + q, 0),
  style: { code: 'LD-SH-2601' },
  bom: { version: bom },
  sizes: sizes.map(([code, qty, sequence]) => ({ qty, size: { code, sequence } })),
})
const before = {
  moNumber: 'MO-T-1',
  plannedStartDate: '2026-11-05T00:00:00.000Z',
  plannedEndDate: null,
  notes: 'Rush',
  routing: { code: 'RT-1' },
  totalPlannedQty: 70,
  lines: [line('Sky Blue', [['38', 20, 1], ['40', 30, 2]]), line('Grey', [['38', 20, 1]])],
}
const after = {
  ...before,
  plannedEndDate: '2026-11-20T00:00:00.000Z',
  notes: '',
  routing: null,
  totalPlannedQty: 75,
  lines: [line('Sky Blue', [['38', 25, 1], ['40', 30, 2]], '1.1'), line('White', [['38', 20, 1]])],
}

const changes = moChanges(before, after)
const want = [
  'Planned finish: — → 20 Nov 2026',
  'Notes cleared (they said “Rush”)',
  'Routing RT-1 taken off',
  'LD-SH-2601 Sky Blue · size 38: 20 → 25 pcs',
  'LD-SH-2601 Sky Blue · BOM v1.0 → v1.1',
  'LD-SH-2601 White added: 38 × 20',
  'LD-SH-2601 Grey removed (it was 20 pcs)',
  'Total: 70 pcs → 75 pcs',
]
for (const w of want) check(`says: ${w}`, changes.includes(w), changes.join(' | '))
check('and nothing else', changes.length === want.length, `${changes.length} lines`)
check('a save with nothing changed says nothing changed', moChanges(before, { ...before }).length === 0)
check(
  'dates as the database returns them (Date) compare with the saved ones (text)',
  moChanges({ ...before, plannedStartDate: new Date('2026-11-05T00:00:00.000Z') }, before).length === 0,
)

console.log(`\n${pass} passed, ${fail} failed`)
process.exitCode = fail ? 1 : 0
