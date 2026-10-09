'use client'

import { ActiveBadge, MasterTable, type Column } from '@/components/masters/MasterTable'
import type { FormField } from '@/components/masters/MasterFormDialog'

type BrandType = 'LD_COTTON_MILLS' | 'VHAGAR' | 'CUSTOM'

interface Brand {
  id: string
  name: string
  type: BrandType
  description?: string | null
  isActive: boolean
  /** How many orders carry this brand. */
  _count?: { salesOrders?: number; manufacturingOrders?: number }
}

// The same words the Styles master uses for the same three kinds.
const BRAND_LABEL: Record<BrandType, string> = {
  LD_COTTON_MILLS: 'LD Cotton Mills',
  VHAGAR: 'VHAGAR',
  CUSTOM: 'Custom',
}

/** A count, or a quiet dash for none, so the eye goes to what is in use. */
const used = (n: number | undefined) =>
  n ? <span className="tabular-nums">{n}</span> : <span className="text-muted-foreground">—</span>

const columns: Column<Brand>[] = [
  { key: 'name', header: 'Brand', sortable: true, className: 'font-medium' },
  {
    key: 'type',
    header: 'Kind',
    render: (b) => (
      <span className={b.type === 'VHAGAR' ? 'vhagar-accent font-bold text-xs' : 'text-muted-foreground text-xs'}>
        {BRAND_LABEL[b.type] ?? b.type}
      </span>
    ),
  },
  {
    key: 'description',
    header: 'Description',
    render: (b) => <span className="text-muted-foreground">{b.description || '—'}</span>,
  },
  // What each brand is holding up, so nobody switches off a brand that live
  // orders still print under.
  { key: 'salesOrders', header: 'Sales orders', align: 'right', render: (b) => used(b._count?.salesOrders) },
  {
    key: 'manufacturingOrders',
    header: 'Production orders',
    align: 'right',
    render: (b) => used(b._count?.manufacturingOrders),
  },
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
    label: 'Kind',
    type: 'select',
    required: true,
    options: Object.entries(BRAND_LABEL).map(([value, label]) => ({ value, label })),
    help: "Custom is a customer's own brand, made to their order",
  },
  { name: 'description', label: 'Description', type: 'textarea', span: 2 },
  {
    name: 'isActive',
    label: 'Active',
    type: 'checkbox',
    placeholder: 'Offered on new sales and production orders',
  },
]

export default function BrandsPage() {
  return (
    <MasterTable<Brand>
      title="Brands"
      entityName="Brand"
      resource="brands"
      columns={columns}
      formFields={formFields}
      defaultSort="name"
      searchPlaceholder="Search brand name..."
      emptyMessage="No brands yet. Add LD Cotton Mills and VHAGAR, and any customer brand you make to order."
    />
  )
}
