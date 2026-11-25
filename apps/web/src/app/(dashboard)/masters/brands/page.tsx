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

/** A count, or a quiet dash for none, so the eye goes to what is in use. */
const used = (n: number | undefined) =>
  n ? <span className="tabular-nums">{n}</span> : <span className="text-muted-foreground">—</span>

const columns: Column<Brand>[] = [
  { key: 'name', header: 'Brand', sortable: true, className: 'font-medium' },
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
    // Only customers' brands here: the mill's own are under In House Brands.
    options: [{ value: 'CUSTOM', label: "Customer's brand" }],
    valueForNew: 'CUSTOM',
    help: "A customer's own brand, made to their order. Your own brands are under In House Brands.",
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
      filters={{ type: 'CUSTOM' }}
      columns={columns}
      formFields={formFields}
      defaultSort="name"
      searchPlaceholder="Search brand name..."
      emptyMessage="No customer brands yet. Add each brand a customer has you make to order. Your own brands are under In House Brands."
    />
  )
}
