'use client'

import { ActiveBadge, MasterTable, type Column, type FilterDef } from '@/components/masters/MasterTable'
import { contractorFormFields as formFields } from '@/components/masters/contractorFormFields'
import { RoutingMastersTabs } from '@/components/masters/RoutingMastersTabs'

/**
 * Contractors: who does a process on the floor — a cutting master, a
 * stitching contractor and their team, a kaj-button man — paid by the piece.
 * Each does one process, and a routing step offers only that process's
 * contractors, beside its line.
 */
interface Contractor {
  id: string
  code: string
  name: string
  operationId: string
  operation: { id: string; name: string } | null
  phone: string | null
  ratePerPiece: string | number | null
  notes: string | null
  isActive: boolean
  _count?: { routingSteps: number }
}

const dash = <span className="text-muted-foreground">—</span>

const columns: Column<Contractor>[] = [
  { key: 'code', header: 'Code', sortable: true, className: 'whitespace-nowrap font-mono text-xs text-primary' },
  { key: 'name', header: 'Contractor', sortable: true, className: 'font-medium' },
  { key: 'operation', header: 'Process', render: (c) => c.operation?.name ?? dash },
  { key: 'phone', header: 'Phone', render: (c) => c.phone ?? dash },
  {
    key: 'ratePerPiece',
    header: 'Rate / pc',
    align: 'right',
    render: (c) => (c.ratePerPiece == null || c.ratePerPiece === '' ? dash : `₹${Number(c.ratePerPiece).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`),
  },
  {
    key: 'routings',
    header: 'In routings',
    align: 'right',
    render: (c) => (c._count?.routingSteps ? <span title="Routing steps that name them">{c._count.routingSteps}</span> : dash),
  },
  { key: 'isActive', header: 'Status', render: (c) => <ActiveBadge isActive={c.isActive} /> },
]

const filterDefs: FilterDef[] = [{ key: 'operationId', label: 'Process', facet: 'operationId', optionsFrom: { resource: 'operations' } }]

export default function ContractorsPage() {
  return (
    <>
      <RoutingMastersTabs />
      <MasterTable<Contractor>
        title="Contractors"
        entityName="Contractor"
        resource="contractors"
        columns={columns}
        formFields={formFields}
        formColumns={3}
        filterDefs={filterDefs}
        defaultSort="name"
        searchPlaceholder="Search name, code, phone or process..."
        emptyMessage="No contractors yet. Add the cutting master, your stitching contractors and anyone else paid by the piece for a process."
      />
    </>
  )
}
