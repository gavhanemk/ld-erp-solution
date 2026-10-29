'use client'

import { ActiveBadge, MasterTable, type Column } from '@/components/masters/MasterTable'
import type { FormField } from '@/components/masters/MasterFormDialog'
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

const PROCESS_KINDS: Array<{ value: Process['kind']; label: string; help: string }> = [
  { value: 'CUTTING', label: 'Cutting', help: 'Makes the pieces and ties them into bundles. Every route starts here.' },
  { value: 'STITCHING', label: 'Stitching', help: 'Counted as stitched on the order.' },
  { value: 'FINISHING', label: 'Finishing', help: 'Thread cutting, pressing, tagging.' },
  { value: 'QC', label: 'Check', help: 'Passes or fails pieces; failed ones go to rework, B-grade or write-off.' },
  { value: 'PACKING', label: 'Packing', help: 'Usually the last step before finished goods.' },
  { value: 'OTHER', label: 'Other process', help: 'Fusing, embroidery, washing, printing, kaj button…' },
]
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

const formFields: FormField[] = [
  { name: 'code', label: 'Code', required: true, placeholder: 'OP-WSH', section: 'Process' },
  { name: 'name', label: 'Name', required: true, placeholder: 'Washing', section: 'Process', span: 2 },
  {
    name: 'departmentId',
    label: 'Department',
    type: 'select',
    required: true,
    section: 'Process',
    optionsFrom: { resource: 'departments' },
    help: 'The department whose people do it, or who send it out',
  },
  {
    name: 'kind',
    label: 'Kind',
    type: 'select',
    required: true,
    section: 'How it is recorded',
    options: PROCESS_KINDS.map((k) => ({ value: k.value, label: k.label })),
    liveHelp: (v) => PROCESS_KINDS.find((k) => k.value === v)?.help ?? 'Decides how its work is recorded on the floor',
  },
  {
    name: 'defaultExecution',
    label: 'Usually done',
    type: 'select',
    required: true,
    section: 'How it is recorded',
    options: [
      { value: 'IN_HOUSE', label: 'On our own floor' },
      { value: 'OUTSOURCED', label: 'At an outside unit' },
    ],
    help: 'A routing step can say otherwise',
  },
  { name: 'smv', label: 'Standard minutes (SMV)', type: 'number', section: 'How it is recorded', placeholder: '12.5', min: 0, max: 999 },
  { name: 'jobWorkRate', label: 'Outside rate per piece (₹)', type: 'number', section: 'How it is recorded', placeholder: '6', min: 0, help: 'What a unit is usually paid; a job work order can agree another' },
  { name: 'sortOrder', label: 'Position in pickers', type: 'number', section: 'How it is recorded', placeholder: '10', min: 0, max: 999 },
  { name: 'instructions', label: 'Standing instructions', type: 'textarea', section: 'Instructions', rows: 2, placeholder: 'Check shade against the approved swatch before washing' },
  { name: 'isActive', label: 'Active', type: 'checkbox', placeholder: 'Offered on routings', section: 'Instructions' },
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
        formFields={formFields}
        formColumns={3}
        defaultSort="sortOrder"
        searchPlaceholder="Search process name or code..."
        emptyMessage="No processes yet. Add cutting, stitching, the checks and the rest of what a garment goes through."
      />
    </>
  )
}
