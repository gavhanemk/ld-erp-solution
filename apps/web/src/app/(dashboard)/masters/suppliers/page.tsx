'use client'

import { Star } from 'lucide-react'
import { ActiveBadge, MasterTable, type Column } from '@/components/masters/MasterTable'

interface Supplier {
  id: string
  code: string
  name: string
  category: string
  gstin: string | null
  phone: string | null
  email: string | null
  city: string | null
  state: string | null
  creditDays: number
  leadTimeDays: number
  rating: number | null
  isPreferred: boolean
  isActive: boolean
}

const CATEGORY_LABEL: Record<string, string> = {
  FABRIC: 'Fabric',
  THREAD: 'Thread',
  BUTTON: 'Button',
  LINING: 'Lining',
  LABEL: 'Label',
  PACKAGING: 'Packaging',
  TRIM: 'Trim',
  TRANSPORT: 'Transport',
  SERVICE: 'Service',
  OTHER: 'Other',
}

const columns: Column<Supplier>[] = [
  { key: 'code', header: 'Code', sortable: true, className: 'font-mono text-xs text-teal-400' },
  {
    key: 'name',
    header: 'Supplier',
    sortable: true,
    className: 'font-medium',
    render: (s) => (
      <div className="flex items-center gap-2">
        <span>{s.name}</span>
        {s.isPreferred && (
          <span title="Preferred supplier">
            <Star size={13} className="text-amber-400 fill-amber-400" />
          </span>
        )}
      </div>
    ),
  },
  {
    key: 'category',
    header: 'Category',
    render: (s) => <span className="badge-neutral">{CATEGORY_LABEL[s.category] ?? s.category}</span>,
  },
  { key: 'gstin', header: 'GSTIN', className: 'font-mono text-xs text-muted-foreground' },
  {
    key: 'location',
    header: 'Location',
    render: (s) =>
      [s.city, s.state].filter(Boolean).join(', ') || <span className="text-muted-foreground">—</span>,
  },
  {
    key: 'contact',
    header: 'Contact',
    render: (s) => (
      <div className="text-xs">
        {s.phone && <div>{s.phone}</div>}
        {s.email && <div className="text-muted-foreground">{s.email}</div>}
        {!s.phone && !s.email && <span className="text-muted-foreground">—</span>}
      </div>
    ),
  },
  {
    key: 'leadTimeDays',
    header: 'Lead Time',
    align: 'right',
    sortable: true,
    render: (s) => <span className="text-xs">{s.leadTimeDays} days</span>,
  },
  {
    key: 'creditDays',
    header: 'Terms',
    align: 'right',
    render: (s) => <span className="text-xs text-muted-foreground">{s.creditDays} days</span>,
  },
  {
    key: 'rating',
    header: 'Rating',
    align: 'center',
    sortable: true,
    render: (s) =>
      s.rating ? (
        <span className="text-amber-400 text-xs" title={`${s.rating} out of 5`}>
          {'★'.repeat(s.rating)}
          <span className="text-muted-foreground">{'★'.repeat(5 - s.rating)}</span>
        </span>
      ) : (
        <span className="text-muted-foreground">—</span>
      ),
  },
  { key: 'isActive', header: 'Status', render: (s) => <ActiveBadge isActive={s.isActive} /> },
]

export default function SuppliersPage() {
  return (
    <MasterTable<Supplier>
      title="Suppliers"
      resource="suppliers"
      columns={columns}
      defaultSort="name"
      searchPlaceholder="Search name, code, GSTIN, phone, email..."
      emptyMessage="No suppliers yet. Add your fabric and trim vendors here."
    />
  )
}
