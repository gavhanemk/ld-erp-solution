// No database access. Run: pnpm --filter api exec tsx ../../tools/check-requisition-search.ts
import assert from 'node:assert/strict'
import { indexRequisitions, searchRequisitions } from '../apps/web/src/lib/requisitionSearch'

const line = (code: string, name: string) => ({
  item: { code, name, category: { name: 'Interlining', parent: { name: 'Trims' } } },
  warehouse: { name: 'Main store' }, purpose: 'Collar reinforcement', styleNo: 'SH-2601',
  ownerCustomer: { name: 'Material owner' },
})
const rows = Array.from({ length: 11 }, (_, i) => {
  const n = i + 1
  return {
    id: String(n), mrNumber: `MR-2627-${String(n).padStart(4, '0')}`,
    mo: { moNumber: n <= 6 ? 'MO-2627-0001' : 'MO-2627-0002' },
    so: { soNumber: n <= 6 ? 'SO-2627-0001' : 'SO-2627-0002', customer: { name: 'Donear Industries Ltd' } },
    department: { name: n === 2 || n === 8 ? 'Fusing' : 'Cutting', code: n === 2 || n === 8 ? 'FUS' : 'CUT' },
    status: 'APPROVED', label: n === 8 ? 'Waiting for purchase' : 'Issued',
    notes: n === 1 ? 'Rush delivery' : null, raisedBy: { name: 'Mahesh' },
    approvedBy: null, issuedBy: null, closedBy: null,
    lines: n === 2 || n === 8 ? [line('TRM-INT-001', 'Fusible Interlining 40 gsm')] : [line('FAB-001', 'Linen')],
  }
})
const index = indexRequisitions(rows, (r) => r.label)
let passed = 0
function check(query: string, expected: string[], source = index) {
  assert.deepEqual([...searchRequisitions(source, query)], expected, query)
  passed++
}
const all = rows.map((r) => r.id)
const mo2 = ['7', '8', '9', '10', '11']
check('2627-0002', ['2', ...mo2]) // A bare number: MO-2627-0002's requisitions and MR-2627-0002 (on MO-0001) both.
check('mo-2627-0002', mo2)
check('SO-2627-0002', mo2)
check('MR-2627-0002', ['2'])
check('MR-2627-001', ['10', '11'])
check('MO-2627-9999', [])
check('2627-0011', ['11']) // No matching order: fall back to the MR suffix.
check('  FUSIBLE   interLIN  ', ['2', '8'])
check('trm-int', ['2', '8'])
check('fusing', ['2', '8'])
check('fus', ['2', '8'])
check('Donear Industries', all)
check('waiting for purchase', ['8'])
check('approved', all)
check('rush', ['1'])
check('mahesh', all)
check('SH-2601', all)
check('material owner', all)
check('main store', all)
check('', all)
check('   ', all)
check('2627-0002 linen', []) // No synthetic match across order and item fields.
check('rush linen', []) // No synthetic match across notes and item fields.
const split = indexRequisitions([{ ...rows[0], lines: [line('A', 'Fusible fabric'), line('B', 'Cotton Interlining')] }], (r) => r.label)
check('Fusible Interlining', [], split) // Two different items cannot create a fake item match.
const nullable = indexRequisitions([{ ...rows[0], mo: null, so: null, lines: [] }], (r) => r.label)
check('MO-2627-0001', [], nullable)
check('MR-2627-0001', ['1'], nullable)
const soOnly = indexRequisitions(rows.map((r) => ({ ...r, mo: null })), (r) => r.label)
check('2627-0002', ['2', ...mo2], soOnly) // SO-2627-0002 and MR-2627-0002, with no MO at all.
check('2627-0001', ['1', '2', '3', '4', '5', '6']) // MO/SO-2627-0001's six, MR-2627-0001 among them.
check('2627', all) // Every number holds the year.
console.log(`PASS ${passed} requisition search regressions`)
