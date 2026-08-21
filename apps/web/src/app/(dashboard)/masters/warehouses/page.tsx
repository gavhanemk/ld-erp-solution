'use client'

import { ActiveBadge, MasterTable, type Column } from '@/components/masters/MasterTable'
import type { FormField } from '@/components/masters/MasterFormDialog'

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

// companyId is filled in by the API — there is only one company per install.
const formFields: FormField[] = [
  { name: 'code', label: 'Warehouse Code', required: true, placeholder: 'WH-FABRIC' },
  { name: 'name', label: 'Warehouse Name', required: true, placeholder: 'Fabric Store' },
  { name: 'address', label: 'Address', type: 'textarea', span: 2 },
  { name: 'isActive', label: 'Active', type: 'checkbox', placeholder: 'Available for stock movements' },
]

export default function WarehousesPage() {
  return (
    <MasterTable<Warehouse>
      title="Warehouses & Stores"
      entityName="Warehouse"
      resource="warehouses"
      columns={columns}
      formFields={formFields}
      defaultSort="name"
      searchPlaceholder="Search warehouse name or code..."
      emptyMessage="No warehouses yet. Add your fabric store, trim store and finished goods store."
    />
  )
}
