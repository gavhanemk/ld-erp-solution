'use client'

import { ActiveBadge, MasterTable, type Column } from '@/components/masters/MasterTable'
import type { FormField } from '@/components/masters/MasterFormDialog'

type OwnKind = 'LD_COTTON_MILLS' | 'VHAGAR'

interface Brand {
  id: string
  name: string
  type: OwnKind
  description?: string | null
  isActive: boolean
  /** How many orders carry this brand. */
  _count?: { salesOrders?: number; manufacturingOrders?: number }
}

// The mill's own brands, under the company or under VHAGAR — the same words the Styles master uses.
const KIND_LABEL: Record<OwnKind, string> = {
  LD_COTTON_MILLS: 'LD Cotton Mills',
  VHAGAR: 'VHAGAR',
}

/** A count, or a quiet dash for none, so the eye goes to what is in use. */
const used = (n: number | undefined) =>
  n ? <span className="tabular-nums">{n}</span> : <span className="text-muted-foreground">—</span>

const columns: Column<Brand>[] = [
  { key: 'name', header: 'Brand', sortable: true, className: 'font-medium' },
  {
    key: 'type',
    header: 'Comes under',
    render: (b) => (
      <span className={b.type === 'VHAGAR' ? 'vhagar-accent text-xs font-bold' : 'text-muted-foreground text-xs'}>{KIND_LABEL[b.type] ?? b.type}</span>
    ),
  },
  {
    key: 'description',
    header: 'Description',
    render: (b) => <span className="text-muted-foreground">{b.description || '—'}</span>,
  },
  // What each brand is holding up, so nobody switches off a brand that live orders still print under.
  { key: 'salesOrders', header: 'Sales orders', align: 'right', render: (b) => used(b._count?.salesOrders) },
  { key: 'manufacturingOrders', header: 'Production orders', align: 'right', render: (b) => used(b._count?.manufacturingOrders) },
  { key: 'isActive', header: 'Status', render: (b) => <ActiveBadge isActive={b.isActive} /> },
]

// The company is filled in by the API: there is only ever one.
const formFields: FormField[] = [
  {
    name: 'name',
    label: 'Brand Name',
    required: true,
    placeholder: 'VHAGAR',
    help: 'As it prints on labels and orders',
  },
  {
    name: 'type',
    label: 'Comes under',
    type: 'select',
    required: true,
    options: Object.entries(KIND_LABEL).map(([value, label]) => ({ value, label })),
    valueForNew: 'LD_COTTON_MILLS',
    help: "Its styles and orders, and its profit, go under this one's",
  },
  { name: 'description', label: 'Description', type: 'textarea', span: 2 },
  {
    name: 'isActive',
    label: 'Active',
    type: 'checkbox',
    checkedForNew: true,
    placeholder: 'Offered on new styles, sales and production orders',
  },
]

/** The mill's own brands. Customers' brands made to their order are under Brands. */
export default function InHouseBrandsPage() {
  return (
    <MasterTable<Brand>
      title="In House Brands"
      entityName="In House Brand"
      resource="brands"
      filters={{ type: 'LD_COTTON_MILLS,VHAGAR' }}
      columns={columns}
      formFields={formFields}
      defaultSort="name"
      searchPlaceholder="Search brand name..."
      emptyMessage="No in-house brands yet. Add LD Cotton Mills and VHAGAR, and any brand of your own."
    />
  )
}
