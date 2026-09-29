'use client'

import { ActiveBadge, MasterTable, type Column } from '@/components/masters/MasterTable'
import type { FormField } from '@/components/masters/MasterFormDialog'

interface Department {
  id: string
  code: string
  name: string
  isActive: boolean
  _count?: { items: number; workstations: number; operations: number; requisitions: number }
}

/** A count, or a quiet dash for none, so the eye goes to what is in use. */
const used = (n: number | undefined) =>
  n ? <span className="tabular-nums">{n}</span> : <span className="text-muted-foreground">—</span>

const columns: Column<Department>[] = [
  {
    key: 'code',
    header: 'Code',
    sortable: true,
    className: 'whitespace-nowrap font-mono text-xs text-teal-400',
  },
  { key: 'name', header: 'Department', sortable: true, className: 'font-medium' },
  // What each department is holding up, so nobody deactivates Cutting without
  // seeing that nine requisitions and two workstations sit under it.
  { key: 'items', header: 'Items', align: 'right', render: (d) => used(d._count?.items) },
  {
    key: 'workstations',
    header: 'Workstations',
    align: 'right',
    render: (d) => used(d._count?.workstations),
  },
  {
    key: 'operations',
    header: 'Operations',
    align: 'right',
    render: (d) => used(d._count?.operations),
  },
  {
    key: 'requisitions',
    header: 'Requisitions',
    align: 'right',
    render: (d) => used(d._count?.requisitions),
  },
  { key: 'isActive', header: 'Status', render: (d) => <ActiveBadge isActive={d.isActive} /> },
]

// The code is made from the name when the department is saved ("Printing QC"
// becomes PRIQC), and companyId is filled in by the API.
const formFields: FormField[] = [
  { name: 'code', label: 'Department Code', generated: true },
  {
    name: 'name',
    label: 'Department Name',
    required: true,
    placeholder: 'Printing',
    help: 'Renaming changes it everywhere it is used, past documents included',
  },
  {
    name: 'isActive',
    label: 'Active',
    type: 'checkbox',
    placeholder: 'Offered on items, requisitions and routings',
  },
]

export default function DepartmentsPage() {
  return (
    <MasterTable<Department>
      title="Departments"
      entityName="Department"
      resource="departments"
      columns={columns}
      formFields={formFields}
      defaultSort="name"
      searchPlaceholder="Search department name or code..."
      emptyMessage="No departments yet. Add Cutting, Stitching, Finishing and the rest of the floor."
    />
  )
}
