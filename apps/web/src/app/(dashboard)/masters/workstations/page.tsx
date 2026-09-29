'use client'

import { useState } from 'react'
import { FileSpreadsheet } from 'lucide-react'
import { ActiveBadge, MasterTable, type Column, type FilterDef } from '@/components/masters/MasterTable'
import type { FormField } from '@/components/masters/MasterFormDialog'
import { ImportWorkstationsDialog } from '@/components/masters/ImportWorkstationsDialog'

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
  _count?: { routingSteps: number }
}

const columns: Column<Workstation>[] = [
  { key: 'code', header: 'Code', sortable: true, className: 'font-mono text-xs text-teal-400 whitespace-nowrap' },
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
        <span className="badge-purple whitespace-nowrap">Outside unit</span>
      ) : (
        <span className="badge-neutral whitespace-nowrap">Our floor</span>
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
    sortable: true,
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
  {
    key: 'routings',
    header: 'In routings',
    align: 'right',
    render: (w) =>
      w._count?.routingSteps ? (
        <span title="Routing steps that send work here">{w._count.routingSteps}</span>
      ) : (
        <span className="text-muted-foreground">—</span>
      ),
  },
  { key: 'isActive', header: 'Status', render: (w) => <ActiveBadge isActive={w.isActive} /> },
]

/*
 * Four across on the wider card: the station, its process and who runs it,
 * then the supplier paid beside its capacity; then who to call and where.
 * Hints sit in the boxes, so it fits without scrolling.
 */
const formFields: FormField[] = [
  { name: 'code', label: 'Code', generated: true, section: 'Workstation' },
  { name: 'name', label: 'Name', required: true, placeholder: 'Stitching Unit 1', section: 'Workstation', span: 2 },
  {
    name: 'departmentId',
    label: 'Process',
    type: 'select',
    required: true,
    section: 'Workstation',
    optionsFrom: { resource: 'departments' },
    placeholder: 'Which step of the line…',
  },
  {
    name: 'type',
    label: 'Run by',
    type: 'select',
    required: true,
    section: 'Workstation',
    options: [
      { value: 'IN_HOUSE', label: 'Our own floor' },
      { value: 'JOB_WORK', label: 'An outside unit' },
    ],
  },
  {
    name: 'supplierId',
    label: 'Supplier paid for this work',
    type: 'select',
    section: 'Workstation',
    span: 2,
    optionsFrom: { resource: 'suppliers' },
    placeholder: 'Needed for an outside unit',
    help: 'Without it an outside unit’s job-work bill cannot be totalled',
  },
  {
    name: 'capacityPerDay',
    label: 'Pieces per day',
    type: 'number',
    section: 'Workstation',
    placeholder: '500 (blank if it varies)',
  },
  { name: 'contactPerson', label: 'Contact Person', section: 'Contact' },
  { name: 'phone', label: 'Phone', section: 'Contact', placeholder: '+91 98765 43210' },
  { name: 'address', label: 'Address', type: 'textarea', section: 'Contact', span: 2, rows: 1 },
  { name: 'isActive', label: 'Active', type: 'checkbox', placeholder: 'Available for production', section: 'Contact' },
]

/*
 * The process, who runs it, who is paid, whether its capacity is known, and
 * whether any routing sends work to it. Each counts what it would leave.
 */
const filterDefs: FilterDef[] = [
  { key: 'departmentId', label: 'Process', facet: 'departmentId', optionsFrom: { resource: 'departments' } },
  {
    key: 'type',
    label: 'Run by',
    facet: 'type',
    options: [
      { value: 'IN_HOUSE', label: 'Our floor' },
      { value: 'JOB_WORK', label: 'Outside unit' },
    ],
  },
  {
    key: 'supplierId',
    label: 'Paid to',
    facet: 'supplierId',
    optionsFrom: { resource: 'suppliers' },
    noneLabel: 'Nobody (our floor)',
  },
  {
    key: 'capacity',
    label: 'Capacity',
    facet: 'capacity',
    options: [
      { value: 'set', label: 'Pieces per day set' },
      { value: 'unset', label: 'Not set' },
    ],
  },
  {
    key: 'routings',
    label: 'Routings',
    facet: 'routings',
    options: [
      { value: 'used', label: 'Used in a routing' },
      { value: 'unused', label: 'Not used yet' },
    ],
  },
]

export default function WorkstationsPage() {
  const [importing, setImporting] = useState(false)
  // Bumped after an import, so the list and its filter counts reload.
  const [refreshKey, setRefreshKey] = useState(0)

  return (
    <>
      <MasterTable<Workstation>
        title="Workstations"
        entityName="Workstation"
        resource="workstations"
        columns={columns}
        formFields={formFields}
        formColumns={4}
        formWide
        filterDefs={filterDefs}
        defaultSort="code"
        searchPlaceholder="Search name, code, process, supplier, contact..."
        emptyMessage="No workstations yet. Add your lines and your outside job-work units."
        refreshKey={refreshKey}
        exportable
        actions={
          <button type="button" className="btn-secondary" onClick={() => setImporting(true)}>
            <FileSpreadsheet size={16} /> Import
          </button>
        }
      />
      {importing && (
        <ImportWorkstationsDialog onClose={() => setImporting(false)} onImported={() => setRefreshKey((k) => k + 1)} />
      )}
    </>
  )
}
