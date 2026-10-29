'use client'

import { ActiveBadge, MasterTable, type Column } from '@/components/masters/MasterTable'
import { PROCESS_KINDS, processFormFields } from '@/components/masters/processFormFields'
import { RoutingMastersTabs } from '@/components/masters/RoutingMastersTabs'

/**
 * Processes: the things a garment can go through — cutting, stitching,
 * embroidery, washing, a check, packing. Routings are built from these, and
 * what kind of process each is decides how its work is recorded on the
 * floor: cutting makes the pieces, a check passes or fails them.
 */
interface Process {
  id: string
  code: string
  name: string
  departmentId: string
  department: { id: string; name: string } | null
  kind: 'CUTTING' | 'STITCHING' | 'FINISHING' | 'QC' | 'PACKING' | 'OTHER'
  defaultExecution: 'IN_HOUSE' | 'OUTSOURCED'
  smv: string | number | null
  jobWorkRate: string | number | null
  sortOrder: number
  instructions: string | null
  isActive: boolean
  _count?: { routingSteps: number; moSteps: number }
}

const kindLabel = Object.fromEntries(PROCESS_KINDS.map((k) => [k.value, k.label]))

const dash = <span className="text-muted-foreground">—</span>
const money = (v: string | number | null) => (v == null || v === '' ? dash : `₹${Number(v).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`)

const columns: Column<Process>[] = [
  { key: 'code', header: 'Code', sortable: true, className: 'whitespace-nowrap font-mono text-xs text-primary' },
  { key: 'name', header: 'Process', sortable: true, className: 'font-medium' },
  { key: 'department', header: 'Department', render: (p) => p.department?.name ?? dash },
  {
    key: 'kind',
    header: 'Kind',
    sortable: true,
    render: (p) => <span className={p.kind === 'QC' ? 'badge-info' : p.kind === 'CUTTING' ? 'badge-warning' : 'badge-neutral'}>{kindLabel[p.kind] ?? p.kind}</span>,
  },
  {
    key: 'defaultExecution',
    header: 'Usually done',
    render: (p) => (p.defaultExecution === 'OUTSOURCED' ? <span className="badge-purple whitespace-nowrap">Outside</span> : <span className="badge-neutral whitespace-nowrap">Our floor</span>),
  },
  { key: 'smv', header: 'SMV', align: 'right', sortable: true, render: (p) => (p.smv == null ? dash : Number(p.smv)) },
  { key: 'jobWorkRate', header: 'Outside rate / pc', align: 'right', render: (p) => money(p.jobWorkRate) },
  {
    key: 'used',
    header: 'In use',
    align: 'right',
    render: (p) =>
      p._count?.routingSteps || p._count?.moSteps ? (
        <span className="text-xs tabular-nums" title="Routing steps, and steps on orders, that use it">
          {p._count.routingSteps} routing{p._count.routingSteps === 1 ? '' : 's'} · {p._count.moSteps} on orders
        </span>
      ) : (
        dash
      ),
  },
  { key: 'isActive', header: 'Status', render: (p) => <ActiveBadge isActive={p.isActive} /> },
]

export default function ProcessesPage() {
  return (
    <>
      <RoutingMastersTabs />
      <MasterTable<Process>
        title="Processes"
        entityName="Process"
        resource="operations"
        columns={columns}
        formFields={processFormFields}
        formColumns={3}
        defaultSort="sortOrder"
        searchPlaceholder="Search process name or code..."
        emptyMessage="No processes yet. Add cutting, stitching, the checks and the rest of what a garment goes through."
      />
    </>
  )
}
