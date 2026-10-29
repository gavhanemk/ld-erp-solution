'use client'

import { useEffect, useState } from 'react'
import { FileSpreadsheet } from 'lucide-react'
import { ActiveBadge, MasterTable, type Column, type FilterDef } from '@/components/masters/MasterTable'
import type { FormField } from '@/components/masters/MasterFormDialog'
import { ImportWorkstationsDialog } from '@/components/masters/ImportWorkstationsDialog'
import { RoutingMastersTabs } from '@/components/masters/RoutingMastersTabs'
import { masterResource, type Paginated } from '@/lib/api'

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
  operationId?: string | null
  operation?: { id: string; name: string } | null
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
  { key: 'name', header: 'Line or table', sortable: true, className: 'font-medium' },
  {
    key: 'department',
    header: 'Process',
    render: (w) =>
      w.operation ? (
        w.operation.name
      ) : w.department ? (
        <span title={`Any process of ${w.department.name}`}>{w.department.name}</span>
      ) : (
        <span className="text-muted-foreground">—</span>
      ),
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
  { name: 'name', label: 'Name', required: true, placeholder: 'Cutting Table 3', section: 'Workstation', span: 2 },
  {
    name: 'departmentId',
    label: 'Department',
    type: 'select',
    required: true,
    section: 'Workstation',
    optionsFrom: { resource: 'departments' },
    placeholder: 'Which department runs it…',
    resets: ['operationId'],
  },
  {
    name: 'operationId',
    label: 'Process',
    type: 'select',
    section: 'Workstation',
    optionsFrom: { resource: 'operations', filter: (row, values) => row.departmentId === values.departmentId },
    placeholder: 'Any of its department’s',
    help: 'The one process it does: Final QC and Packing share a department, each with its own lines',
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

/** How many lines each process has: Cutting 4 tables, Stitching 3 lines, Washing an outside unit. */
function LinesPerProcess({ refreshKey }: { refreshKey: number }) {
  const [rows, setRows] = useState<Array<{ name: string; ours: number; outside: number }> | null>(null)
  useEffect(() => {
    let live = true
    void masterResource<Workstation>('workstations')
      .list({ limit: 500, active: true })
      .then((r) => {
        if (!live) return
        const by = new Map<string, { name: string; ours: number; outside: number }>()
        for (const w of (r as Paginated<Workstation>).data) {
          const name = w.operation?.name ?? w.department?.name ?? 'No process'
          const g = by.get(name) ?? { name, ours: 0, outside: 0 }
          if (w.type === 'JOB_WORK') g.outside++
          else g.ours++
          by.set(name, g)
        }
        setRows([...by.values()].sort((a, b) => a.name.localeCompare(b.name)))
      })
      .catch(() => live && setRows([]))
    return () => {
      live = false
    }
  }, [refreshKey])
  if (!rows?.length) return null
  return (
    <div className="glass-card mb-3 flex flex-wrap items-center gap-2 px-4 py-3">
      <span className="text-muted-foreground mr-1 text-xs font-semibold uppercase tracking-wide">Lines per process</span>
      {rows.map((g) => (
        <span key={g.name} className="badge-neutral">
          <b className="text-foreground">{g.name}</b>
          {g.ours > 0 && ` · ${g.ours} on our floor`}
          {g.outside > 0 && ` · ${g.outside} outside`}
        </span>
      ))}
    </div>
  )
}

export default function WorkstationsPage() {
  const [importing, setImporting] = useState(false)
  // Bumped after an import, so the list and its filter counts reload.
  const [refreshKey, setRefreshKey] = useState(0)
  // Bumped after a save here, so the lines-per-process strip reads again.
  const [saved, setSaved] = useState(0)

  return (
    <>
      <RoutingMastersTabs />
      <LinesPerProcess refreshKey={refreshKey + saved} />
      <MasterTable<Workstation>
        title="Lines & tables"
        entityName="Line"
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
        onChanged={() => setSaved((n) => n + 1)}
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
