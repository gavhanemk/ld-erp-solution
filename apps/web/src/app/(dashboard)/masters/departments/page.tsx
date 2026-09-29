'use client'

import { ActiveBadge, MasterTable, type Column } from '@/components/masters/MasterTable'
import type { FormField } from '@/components/masters/MasterFormDialog'

interface Department {
  id: string
  code: string
  name: string
  isActive: boolean
  /** How many of each thing point at this department. */
  _count?: Record<string, number>
}

/** Every use the API counts, as said in a sentence. */
const USES: Record<string, [string, string]> = {
  items: ['item', 'items'],
  workstations: ['workstation', 'workstations'],
  operations: ['operation', 'operations'],
  requisitions: ['requisition', 'requisitions'],
  employees: ['employee', 'employees'],
  machines: ['machine', 'machines'],
  routingSteps: ['routing step', 'routing steps'],
  bomLines: ['BOM line', 'BOM lines'],
  productionEntries: ['production entry', 'production entries'],
}

/**
 * Null when nothing uses the department and it can be deleted outright;
 * otherwise what uses it, so the greyed-out button can say why not.
 */
const deleteBlockedBy = (d: Department): string | null => {
  const uses = Object.entries(USES)
    .filter(([key]) => (d._count?.[key] ?? 0) > 0)
    .map(([key, [one, many]]) => {
      const n = d._count![key]
      return `${n} ${n === 1 ? one : many}`
    })
  if (!uses.length) return null
  const list = uses.length === 1 ? uses[0] : `${uses.slice(0, -1).join(', ')} and ${uses.at(-1)}`
  return `${d.name} is used by ${list}, so it cannot be deleted. Deactivate it instead.`
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
      deleteBlockedBy={deleteBlockedBy}
      defaultSort="name"
      searchPlaceholder="Search department name or code..."
      emptyMessage="No departments yet. Add Cutting, Stitching, Finishing and the rest of the floor."
    />
  )
}
