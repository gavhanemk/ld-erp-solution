'use client'

import { ActiveBadge, MasterTable, type Column } from '@/components/masters/MasterTable'
import type { FormField } from '@/components/masters/MasterFormDialog'

interface Warehouse {
  id: string
  code: string
  name: string
  address: string | null
  isActive: boolean
  /** GENERAL: bulk stock. SAMPLING: material bought for samples, kept apart from it. */
  purpose?: 'GENERAL' | 'SAMPLING'
  /** What kind of place it is, so its stock can be told apart by status. */
  kind?: string
  /** Set on a process's own floor. */
  departmentId?: string | null
}

/** What kind of place a store is: its stock is counted under this status. */
const KIND_LABEL: Record<string, string> = {
  GENERAL: 'General store',
  RAW_MATERIAL: 'Raw material',
  WIP: 'Work in progress (process floor)',
  FINISHED_GOODS: 'Finished goods',
  QC_HOLD: 'Held for QC',
  REJECTED: 'Rejected',
  SCRAP: 'Scrap',
  JOB_WORK: 'At a job worker',
  TRANSIT: 'In transit',
  SAMPLE: 'Samples',
}


/** A sample store is offered only where sampling is switched on. */
const samplingOn = process.env.NEXT_PUBLIC_SAMPLING_ENABLED === 'true'

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
  ...(samplingOn
    ? [
        {
          key: 'purpose',
          header: 'Holds',
          render: (w: Warehouse) =>
            w.purpose === 'SAMPLING' ? (
              <span className="badge-info">Sample material</span>
            ) : (
              <span className="text-xs text-muted-foreground">Bulk stock</span>
            ),
        } as Column<Warehouse>,
      ]
    : []),
  {
    key: 'kind',
    header: 'Kind',
    render: (w) => <span className="text-xs">{KIND_LABEL[w.kind ?? 'GENERAL'] ?? w.kind}</span>,
  },
  { key: 'isActive', header: 'Status', render: (w) => <ActiveBadge isActive={w.isActive} /> },
]

// companyId is filled in by the API — there is only one company per install.
const formFields: FormField[] = [
  { name: 'code', label: 'Warehouse Code', generated: true },
  { name: 'name', label: 'Warehouse Name', required: true, placeholder: 'Fabric Store' },
  { name: 'address', label: 'Address', type: 'textarea', span: 2 },
  {
    name: 'kind',
    label: 'Kind of store',
    type: 'select',
    // A sample store is set by what it holds; a process floor is always work in progress.
    options: Object.entries(KIND_LABEL)
      .filter(([value]) => value !== 'SAMPLE' && value !== 'WIP')
      .map(([value, label]) => ({ value, label })),
    valueForNew: 'GENERAL',
    showIf: (v) => !v.departmentId && v.purpose !== 'SAMPLING',
    help: 'What its stock counts as in the stock reports: rejected and scrap stock is never offered as available. The store stays one place for every brand.',
  },
  ...(samplingOn
    ? [
        {
          name: 'purpose',
          label: 'What it holds',
          type: 'select',
          options: [
            { value: 'GENERAL', label: 'Bulk stock' },
            { value: 'SAMPLING', label: 'Sample material (a sample store)' },
          ],
          help: 'A sample store keeps what is bought for samples apart: only sample purchases are received into it and only Sampling issues from it. A store can change over only while it is empty.',
        } as FormField,
      ]
    : []),
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
      allowDelete
      deleteRefusedHint="Its stock history has to keep saying where goods were. Deactivate it instead: it stays on past documents but is no longer offered."
      searchPlaceholder="Search warehouse name or code..."
      emptyMessage="No warehouses yet. Add your fabric store, trim store and finished goods store."
    />
  )
}
