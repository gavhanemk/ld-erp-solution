'use client'

import { ActiveBadge, MasterTable, type Column } from '@/components/masters/MasterTable'
import { QTY_PLACES_LABEL, uomFormFields } from '@/components/masters/uomFormFields'

interface Uom {
  id: string
  name: string
  symbol: string
  isActive: boolean
  /** Places after the point a quantity in this unit may carry: 0 = whole numbers only. */
  decimalPlaces: number
  /** How many items are counted in this unit. */
  _count?: { items?: number }
}

const columns: Column<Uom>[] = [
  { key: 'name', header: 'Unit', sortable: true, className: 'font-medium' },
  {
    key: 'symbol',
    header: 'Symbol',
    sortable: true,
    className: 'whitespace-nowrap font-mono text-xs text-teal-400',
  },
  // Whether 2.5 of it can be asked for, issued or bought.
  {
    key: 'decimalPlaces',
    header: 'Quantities',
    render: (u) => (
      <span className={u.decimalPlaces === 0 ? 'text-foreground' : 'text-muted-foreground'}>{QTY_PLACES_LABEL[u.decimalPlaces] ?? '—'}</span>
    ),
  },
  // Before a unit is switched off, how many items would be left counted in it.
  {
    key: 'items',
    header: 'Items',
    align: 'right',
    render: (u) =>
      u._count?.items ? (
        <span className="tabular-nums">{u._count.items}</span>
      ) : (
        <span className="text-muted-foreground">—</span>
      ),
  },
  { key: 'isActive', header: 'Status', render: (u) => <ActiveBadge isActive={u.isActive} /> },
]

export default function UnitsPage() {
  return (
    <MasterTable<Uom>
      title="Units of Measure"
      entityName="Unit of measure"
      resource="uoms"
      columns={columns}
      formFields={uomFormFields}
      allowDelete
      defaultSort="name"
      searchPlaceholder="Search unit or symbol..."
      emptyMessage="No units yet. Add Meter, Kilogram, Piece and the others items are counted in."
    />
  )
}
