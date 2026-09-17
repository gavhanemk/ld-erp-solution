'use client'

import { ActiveBadge, MasterTable, type Column } from '@/components/masters/MasterTable'
import type { FormField } from '@/components/masters/MasterFormDialog'

/**
 * Chargeable extras.
 *
 * Transport, freight and dyeing are billed on top of the goods and each carries
 * its own GST rate, so none of them can be folded into the garment value.
 */
interface ChargeType {
  id: string
  name: string
  defaultGstRate: string | number
  applyOnSale: boolean
  applyOnPurchase: boolean
  isActive: boolean
}

const columns: Column<ChargeType>[] = [
  { key: 'name', header: 'Charge', sortable: true, className: 'font-medium' },
  {
    key: 'defaultGstRate',
    header: 'GST',
    align: 'right',
    sortable: true,
    render: (c) => <span className="font-semibold">{Number(c.defaultGstRate)}%</span>,
  },
  {
    key: 'where',
    header: 'Appears on',
    render: (c) => {
      const on = [c.applyOnSale && 'Sales', c.applyOnPurchase && 'Purchases'].filter(Boolean)
      return on.length ? (
        <div className="flex gap-1">
          {on.map((label) => (
            <span key={String(label)} className="badge-info">
              {label}
            </span>
          ))}
        </div>
      ) : (
        <span className="text-muted-foreground">Nowhere — tick one below</span>
      )
    },
  },
  { key: 'isActive', header: 'Status', render: (c) => <ActiveBadge isActive={c.isActive} /> },
]

const formFields: FormField[] = [
  {
    name: 'name',
    label: 'Charge',
    required: true,
    placeholder: 'Freight / Courier',
    span: 2,
    help: 'One entry per kind of charge — the rate is set below, not in the name',
  },
  {
    name: 'defaultGstRate',
    label: 'GST %',
    type: 'number',
    required: true,
    placeholder: '18',
    help: 'Freight often carries a different rate from the garment itself',
  },
  { name: 'applyOnSale', label: 'On sales', type: 'checkbox', placeholder: 'Offer on invoices' },
  {
    name: 'applyOnPurchase',
    label: 'On purchases',
    type: 'checkbox',
    placeholder: 'Offer on supplier bills',
  },
  {
    name: 'isActive',
    label: 'Active',
    type: 'checkbox',
    placeholder: 'Available on new documents',
  },
]

export default function ChargeTypesPage() {
  return (
    <MasterTable<ChargeType>
      title="Extra Charges"
      entityName="Charge"
      resource="charge-types"
      columns={columns}
      formFields={formFields}
      defaultSort="name"
      searchPlaceholder="Search charges..."
      emptyMessage="No extra charges yet."
    />
  )
}
