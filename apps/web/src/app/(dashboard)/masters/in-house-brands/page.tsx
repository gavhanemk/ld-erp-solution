'use client'

import { useEffect, useMemo, useState } from 'react'
import { api } from '@/lib/api'
import { ActiveBadge, MasterTable, type Column } from '@/components/masters/MasterTable'
import type { FormField } from '@/components/masters/MasterFormDialog'

type OwnKind = 'LD_COTTON_MILLS' | 'VHAGAR'

interface Brand {
  id: string
  name: string
  /** Short and unique: LD, ST, VH. New style codes of the brand start with it. */
  code?: string | null
  type: OwnKind
  description?: string | null
  isActive: boolean
  /** The brand B2B and job work are booked under, and the one an order falls back to. */
  isDefault?: boolean
  /** Its profit centre in Accounts, made and kept in step with it. */
  costCentre?: { id: string; name: string; code: string | null } | null
  /** Where its finished goods come in by default. */
  defaultWarehouse?: { id: string; name: string } | null
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
  { key: 'code', header: 'Code', sortable: true, className: 'whitespace-nowrap font-mono text-xs text-teal-400' },
  {
    key: 'name',
    header: 'Brand',
    sortable: true,
    className: 'font-medium',
    render: (b) => (
      <span className="inline-flex items-center gap-2">
        {b.name}
        {b.isDefault && (
          <span className="badge-info whitespace-nowrap text-[10px]" title="B2B and job work are booked under it, and an order falls back to it">
            Default
          </span>
        )}
      </span>
    ),
  },
  {
    key: 'costCentre',
    header: 'Profit centre',
    render: (b) => <span className="text-xs">{b.costCentre?.name ?? <span className="text-muted-foreground">—</span>}</span>,
  },
  {
    key: 'type',
    header: 'Comes under',
    render: (b) => (
      <span className={b.type === 'VHAGAR' ? 'vhagar-accent text-xs font-bold' : 'text-muted-foreground text-xs'}>{KIND_LABEL[b.type] ?? b.type}</span>
    ),
  },
  {
    key: 'defaultWarehouse',
    header: 'FG store',
    render: (b) => <span className="text-xs">{b.defaultWarehouse?.name ?? <span className="text-muted-foreground">—</span>}</span>,
  },
  // What each brand is holding up, so nobody switches off a brand that live orders still print under.
  { key: 'salesOrders', header: 'Sales orders', align: 'right', render: (b) => used(b._count?.salesOrders) },
  { key: 'manufacturingOrders', header: 'Production orders', align: 'right', render: (b) => used(b._count?.manufacturingOrders) },
  { key: 'isActive', header: 'Status', render: (b) => <ActiveBadge isActive={b.isActive} /> },
]

/** The mill's own brands. Customers' brands made to their order are under Brands. */
export default function InHouseBrandsPage() {
  // The parent company: the one legal company every brand is under.
  const [company, setCompany] = useState('')
  useEffect(() => {
    api
      .get<{ data: { name?: string | null; legalName?: string | null } }>('/masters/company')
      .then((r) => setCompany(r.data?.legalName || r.data?.name || ''))
      .catch(() => setCompany(''))
  }, [])

  // The company is filled in by the API: there is only ever one.
  const formFields: FormField[] = useMemo(
    () => [
      {
        name: 'name',
        label: 'Brand Name',
        required: true,
        placeholder: 'Stich Code',
        help: 'As it prints on labels and orders',
      },
      {
        name: 'code',
        label: 'Brand Code',
        placeholder: 'ST',
        help: 'Up to 8 letters or digits, made from the name when left blank. New style codes of the brand start with it.',
      },
      {
        name: 'company',
        label: 'Parent company',
        type: 'readout',
        readout: () => company || 'The company in Settings',
        help: 'Every brand is under the one company: one GSTIN, one set of books, one stock ledger',
      },
      {
        name: 'type',
        label: 'Comes under',
        type: 'select',
        required: true,
        options: Object.entries(KIND_LABEL).map(([value, label]) => ({ value, label })),
        valueForNew: 'LD_COTTON_MILLS',
        help: "VHAGAR's own lines go under VHAGAR, every other brand under LD Cotton Mills. Each brand keeps its own profit centre either way.",
      },
      {
        name: 'profitCentreName',
        label: 'Profit centre',
        placeholder: 'LD Cotton Mills — B2B & Job Work',
        initial: (r) => (r.costCentre as { name?: string } | null | undefined)?.name ?? '',
        help: 'What its profit is called in Accounts. Left blank, the brand name. Its code is the brand code.',
      },
      {
        name: 'defaultWarehouseId',
        label: 'Default FG store',
        type: 'select',
        optionsFrom: {
          resource: 'warehouses',
          // A store finished goods are kept in: not a process floor, not a sample store.
          filter: (row) => !row.departmentId && row.purpose !== 'SAMPLING' && row.isActive !== false,
        },
        emptyLabel: 'No default store',
        help: 'Where its finished goods come in, unless the receipt says otherwise',
      },
      {
        name: 'isDefault',
        label: 'Default brand',
        type: 'checkbox',
        placeholder: 'B2B and job work are booked under it, and an order whose styles do not say falls back to it',
        help: 'Only one brand is the default. Ticking it here moves it from the brand that has it.',
      },
      { name: 'description', label: 'Description', type: 'textarea', span: 2 },
      {
        name: 'isActive',
        label: 'Active',
        type: 'checkbox',
        checkedForNew: true,
        placeholder: 'Offered on new styles, sales and production orders',
      },
    ],
    [company],
  )

  return (
    <MasterTable<Brand>
      title="In House Brands"
      entityName="In House Brand"
      resource="brands"
      filters={{ type: 'LD_COTTON_MILLS,VHAGAR' }}
      columns={columns}
      formFields={formFields}
      defaultSort="name"
      searchPlaceholder="Search brand name or code..."
      emptyMessage="No in-house brands yet. Add LD Cotton Mills, Stich Code and VHAGAR, and any brand of your own."
    />
  )
}
