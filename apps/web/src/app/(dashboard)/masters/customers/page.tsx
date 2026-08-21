'use client'

import { ActiveBadge, MasterTable, type Column } from '@/components/masters/MasterTable'
import { formatCurrency } from '@/lib/utils'

interface Customer {
  id: string
  code: string
  name: string
  type: 'DOMESTIC' | 'EXPORT' | 'JOB_WORK' | 'VHAGAR_DEALER'
  gstin: string | null
  phone: string | null
  email: string | null
  billingCity: string | null
  billingState: string | null
  creditLimit: string | number | null
  creditDays: number
  isBlacklisted: boolean
  isActive: boolean
}

const TYPE_LABEL: Record<Customer['type'], { label: string; cls: string }> = {
  DOMESTIC: { label: 'Domestic', cls: 'badge-neutral' },
  EXPORT: { label: 'Export', cls: 'badge-info' },
  JOB_WORK: { label: 'Job Work', cls: 'badge-purple' },
  VHAGAR_DEALER: { label: 'VHAGAR Dealer', cls: 'badge-warning' },
}

const columns: Column<Customer>[] = [
  {
    key: 'code',
    header: 'Code',
    sortable: true,
    className: 'font-mono text-xs text-teal-400',
  },
  {
    key: 'name',
    header: 'Customer',
    sortable: true,
    className: 'font-medium',
    render: (c) => (
      <div>
        <span>{c.name}</span>
        {c.isBlacklisted && <span className="badge-danger ml-2">Blacklisted</span>}
      </div>
    ),
  },
  {
    key: 'type',
    header: 'Type',
    render: (c) => {
      const t = TYPE_LABEL[c.type] ?? { label: c.type, cls: 'badge-neutral' }
      return <span className={t.cls}>{t.label}</span>
    },
  },
  {
    key: 'gstin',
    header: 'GSTIN',
    className: 'font-mono text-xs text-muted-foreground',
  },
  {
    key: 'location',
    header: 'Location',
    render: (c) =>
      [c.billingCity, c.billingState].filter(Boolean).join(', ') || (
        <span className="text-muted-foreground">—</span>
      ),
  },
  {
    key: 'contact',
    header: 'Contact',
    render: (c) => (
      <div className="text-xs">
        {c.phone && <div>{c.phone}</div>}
        {c.email && <div className="text-muted-foreground">{c.email}</div>}
        {!c.phone && !c.email && <span className="text-muted-foreground">—</span>}
      </div>
    ),
  },
  {
    key: 'creditLimit',
    header: 'Credit Limit',
    align: 'right',
    sortable: true,
    render: (c) =>
      c.creditLimit ? (
        <span className="font-semibold">{formatCurrency(Number(c.creditLimit))}</span>
      ) : (
        <span className="text-muted-foreground">—</span>
      ),
  },
  {
    key: 'creditDays',
    header: 'Terms',
    align: 'right',
    render: (c) => <span className="text-xs text-muted-foreground">{c.creditDays} days</span>,
  },
  {
    key: 'isActive',
    header: 'Status',
    render: (c) => <ActiveBadge isActive={c.isActive} />,
  },
]

export default function CustomersPage() {
  return (
    <MasterTable<Customer>
      title="Customers"
      resource="customers"
      columns={columns}
      defaultSort="name"
      searchPlaceholder="Search name, code, GSTIN, phone, email..."
      emptyMessage="No customers yet. Add your first customer to get started."
    />
  )
}
