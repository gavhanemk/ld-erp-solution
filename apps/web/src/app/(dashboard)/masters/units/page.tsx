'use client'

import { ActiveBadge, MasterTable, type Column } from '@/components/masters/MasterTable'
import { uomFormFields } from '@/components/masters/uomFormFields'

interface Uom {
  id: string
  name: string
  symbol: string
  isActive: boolean
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
