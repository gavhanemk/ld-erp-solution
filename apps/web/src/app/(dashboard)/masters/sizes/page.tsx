'use client'

import { MasterTable, type Column } from '@/components/masters/MasterTable'
import type { FormField } from '@/components/masters/MasterFormDialog'

/** The individual sizes inside a run, in the order they appear on a cutting sheet. */
interface Size {
  id: string
  sizeGroupId: string
  sizeGroup: { id: string; name: string } | null
  code: string
  label: string
  sequence: number
}

const columns: Column<Size>[] = [
  {
    key: 'sizeGroup',
    header: 'Size Run',
    render: (s) => s.sizeGroup?.name ?? <span className="text-muted-foreground">—</span>,
  },
  { key: 'code', header: 'Code', sortable: true, className: 'font-mono text-xs text-teal-400' },
  { key: 'label', header: 'Shown as', className: 'font-medium' },
  {
    key: 'sequence',
    header: 'Order',
    align: 'right',
    sortable: true,
    render: (s) => <span className="text-muted-foreground">{s.sequence}</span>,
  },
]

const formFields: FormField[] = [
  {
    name: 'sizeGroupId',
    label: 'Size Run',
    type: 'select',
    required: true,
    span: 2,
    optionsFrom: { resource: 'size-groups' },
  },
  { name: 'code', label: 'Code', required: true, placeholder: '40', help: 'Used in documents and reports' },
  { name: 'label', label: 'Shown as', required: true, placeholder: '40', help: 'What people see on screen' },
  {
    name: 'sequence',
    label: 'Position',
    type: 'number',
    placeholder: '0',
    help: 'Smallest first — this is the order sizes appear across a cutting sheet',
  },
]

export default function SizesPage() {
  return (
    <MasterTable<Size>
      title="Sizes"
      entityName="Size"
      resource="sizes"
      columns={columns}
      formFields={formFields}
      defaultSort="sequence"
      searchPlaceholder="Search sizes..."
      emptyMessage="No sizes yet. Create a size run first, then add its sizes here."
      actions={
        <a href="/masters/size-runs" className="btn-secondary text-xs">
          Back to size runs
        </a>
      }
    />
  )
}
