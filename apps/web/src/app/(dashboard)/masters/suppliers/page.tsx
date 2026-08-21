'use client'

import { Star } from 'lucide-react'
import { ActiveBadge, MasterTable, type Column } from '@/components/masters/MasterTable'
import type { FormField } from '@/components/masters/MasterFormDialog'

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

const formFields: FormField[] = [
  { name: 'code', label: 'Supplier Code', required: true, placeholder: 'SUP-001', section: 'Identity' },
  { name: 'name', label: 'Supplier Name', required: true, placeholder: 'Shree Fabrics', section: 'Identity' },
  {
    name: 'category',
    label: 'Category',
    type: 'select',
    required: true,
    section: 'Identity',
    options: Object.entries(CATEGORY_LABEL).map(([value, label]) => ({ value, label })),
  },
  { name: 'gstin', label: 'GSTIN', section: 'Identity', placeholder: '24AAACL1234M1Z5' },
  { name: 'pan', label: 'PAN', section: 'Identity', placeholder: 'AAACL1234M' },
  { name: 'phone', label: 'Phone', section: 'Contact', placeholder: '+91 98765 43210' },
  { name: 'email', label: 'Email', section: 'Contact', placeholder: 'sales@example.com' },
  { name: 'address', label: 'Address', type: 'textarea', section: 'Address' },
  { name: 'city', label: 'City', section: 'Address' },
  { name: 'state', label: 'State', section: 'Address' },
  { name: 'pincode', label: 'PIN Code', section: 'Address', placeholder: '395010' },
  {
    name: 'leadTimeDays',
    label: 'Lead Time (days)',
    type: 'number',
    section: 'Terms',
    placeholder: '7',
    help: 'Typical days from PO to delivery',
  },
  { name: 'creditDays', label: 'Credit Days', type: 'number', section: 'Terms', placeholder: '30' },
  { name: 'paymentTerms', label: 'Payment Terms', section: 'Terms' },
  { name: 'bankName', label: 'Bank Name', section: 'Bank Details' },
  { name: 'bankAccount', label: 'Account Number', section: 'Bank Details' },
  { name: 'bankIFSC', label: 'IFSC Code', section: 'Bank Details', placeholder: 'HDFC0001234' },
  { name: 'rating', label: 'Rating', type: 'number', section: 'Other', placeholder: '4', help: '1 to 5' },
  { name: 'notes', label: 'Notes', type: 'textarea', section: 'Other' },
  { name: 'isPreferred', label: 'Preferred', type: 'checkbox', placeholder: 'Prioritise in vendor lists', section: 'Other' },
  { name: 'isActive', label: 'Active', type: 'checkbox', placeholder: 'Available for new orders', section: 'Other' },
]

export default function SuppliersPage() {
  return (
    <MasterTable<Supplier>
      title="Suppliers"
      entityName="Supplier"
      resource="suppliers"
      columns={columns}
      formFields={formFields}
      defaultSort="name"
      searchPlaceholder="Search name, code, GSTIN, phone, email..."
      emptyMessage="No suppliers yet. Add your fabric and trim vendors here."
    />
  )
}
