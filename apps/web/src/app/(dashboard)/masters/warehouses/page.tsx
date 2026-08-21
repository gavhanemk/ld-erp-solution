'use client'

import { ActiveBadge, MasterTable, type Column } from '@/components/masters/MasterTable'

interface Warehouse {
  id: string
  code: string
  name: string
  address: string | null
  isActive: boolean
}

const columns: Column<Warehouse>[] = [
  { key: 'code', header: 'Code', sortable: true, className: 'font-mono text-xs text-teal-400' },
  { key: 'name', header: 'Warehouse', sortable: true, className: 'font-medium' },
  {
    key: 'address',
    header: 'Address',
    render: (w) => (
      <span className="text-xs text-muted-foreground">
        {w.address || '—'}
      </span>
    ),
  },
  { key: 'isActive', header: 'Status', render: (w) => <ActiveBadge isActive={w.isActive} /> },
]

export default function WarehousesPage() {
  return (
    <MasterTable<Warehouse>
      title="Warehouses & Stores"
      resource="warehouses"
      columns={columns}
      defaultSort="name"
      searchPlaceholder="Search warehouse name or code..."
      emptyMessage="No warehouses yet. Add your fabric store, trim store and finished goods store."
    />
  )
}
