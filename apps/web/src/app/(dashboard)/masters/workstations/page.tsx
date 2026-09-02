'use client'

import { ActiveBadge, MasterTable, type Column } from '@/components/masters/MasterTable'
import type { FormField } from '@/components/masters/MasterFormDialog'

/**
 * Workstations.
 *
 * Most of LD's stitching and finishing is done by outside units rather than on
 * their own floor, so a workstation is often an outside business, not a
 * machine. Linking one to the supplier we pay is what makes their job-work
 * bill addable at the end of the month.
 */
interface Workstation {
  id: string
  code: string
  name: string
  type: 'IN_HOUSE' | 'JOB_WORK'
  departmentId: string
  department: { id: string; name: string } | null
  supplierId: string | null
  supplier: { id: string; name: string } | null
  capacityPerDay: number | null
  contactPerson: string | null
  phone: string | null
  isActive: boolean
}

const columns: Column<Workstation>[] = [
  { key: 'code', header: 'Code', sortable: true, className: 'font-mono text-xs text-teal-400' },
  { key: 'name', header: 'Workstation', sortable: true, className: 'font-medium' },
  {
    key: 'department',
    header: 'Process',
    render: (w) => w.department?.name ?? <span className="text-muted-foreground">—</span>,
  },
  {
    key: 'type',
    header: 'Run by',
    render: (w) =>
      w.type === 'JOB_WORK' ? (
        <span className="badge-purple">Outside unit</span>
      ) : (
        <span className="badge-neutral">Our floor</span>
      ),
  },
  {
    key: 'supplier',
    header: 'Paid to',
    render: (w) =>
      w.supplier ? (
        <span className="text-xs">{w.supplier.name}</span>
      ) : (
        <span className="text-muted-foreground">—</span>
      ),
  },
  {
    key: 'capacityPerDay',
    header: 'Pieces / day',
    align: 'right',
    render: (w) =>
      w.capacityPerDay ? (
        <span className="font-semibold">{w.capacityPerDay.toLocaleString('en-IN')}</span>
      ) : (
        <span className="text-muted-foreground">—</span>
      ),
  },
  {
    key: 'contact',
    header: 'Contact',
    render: (w) => (
      <div className="text-xs">
        {w.contactPerson && <div>{w.contactPerson}</div>}
        {w.phone && <div className="text-muted-foreground">{w.phone}</div>}
        {!w.contactPerson && !w.phone && <span className="text-muted-foreground">—</span>}
      </div>
    ),
  },
  { key: 'isActive', header: 'Status', render: (w) => <ActiveBadge isActive={w.isActive} /> },
]

const formFields: FormField[] = [
  { name: 'code', label: 'Code', generated: true, section: 'Identity' },
  { name: 'name', label: 'Name', required: true, placeholder: 'Stitching Unit 1', section: 'Identity' },
  {
    name: 'departmentId',
    label: 'Process',
    type: 'select',
    required: true,
    section: 'Identity',
    optionsFrom: { resource: 'departments' },
    help: 'Which step of the line this station performs',
  },
  {
    name: 'type',
    label: 'Run by',
    type: 'select',
    required: true,
    section: 'Identity',
    options: [
      { value: 'IN_HOUSE', label: 'Our own floor' },
      { value: 'JOB_WORK', label: 'An outside unit' },
    ],
  },
  {
    name: 'supplierId',
    label: 'Supplier paid for this work',
    type: 'select',
    section: 'Identity',
    optionsFrom: { resource: 'suppliers' },
    help: 'Required for an outside unit — without it their job-work bill cannot be totalled',
  },
  {
    name: 'capacityPerDay',
    label: 'Pieces per day',
    type: 'number',
    section: 'Capacity',
    placeholder: '500',
    help: 'Used for planning; leave blank if it varies',
  },
  { name: 'contactPerson', label: 'Contact Person', section: 'Contact' },
  { name: 'phone', label: 'Phone', section: 'Contact', placeholder: '+91 98765 43210' },
  { name: 'address', label: 'Address', type: 'textarea', section: 'Contact' },
  { name: 'isActive', label: 'Active', type: 'checkbox', placeholder: 'Available for production', section: 'Contact' },
]

export default function WorkstationsPage() {
  return (
    <MasterTable<Workstation>
      title="Workstations"
      entityName="Workstation"
      resource="workstations"
      columns={columns}
      formFields={formFields}
      defaultSort="code"
      searchPlaceholder="Search name, code or contact..."
      emptyMessage="No workstations yet. Add your lines and your outside job-work units."
    />
  )
}
