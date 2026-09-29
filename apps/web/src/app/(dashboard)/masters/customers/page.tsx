'use client'

import { ActiveBadge, MasterTable, type Column } from '@/components/masters/MasterTable'
import type { FormField } from '@/components/masters/MasterFormDialog'
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

const formFields: FormField[] = [
  { name: 'code', label: 'Customer Code', generated: true, section: 'Identity' },
  { name: 'name', label: 'Customer Name', required: true, placeholder: 'Rajan Traders', section: 'Identity' },
  {
    name: 'type',
    label: 'Type',
    type: 'select',
    required: true,
    section: 'Identity',
    options: [
      { value: 'DOMESTIC', label: 'Domestic' },
      { value: 'EXPORT', label: 'Export' },
      { value: 'JOB_WORK', label: 'Job Work' },
      { value: 'VHAGAR_DEALER', label: 'VHAGAR Dealer' },
    ],
  },
  {
    name: 'gstin',
    label: 'GSTIN',
    section: 'Identity',
    placeholder: '27AAACL1234M1Z5',
    uppercase: true,
    help: '15 characters. Leave blank if unregistered.',
    derives: { field: 'billingStateCode', from: (v) => (/^\d{2}/.test(v) ? v.slice(0, 2) : null) },
  },
  {
    name: 'billingStateCode',
    label: 'GST State Code',
    section: 'Identity',
    placeholder: '27',
    help: 'Filled in from the GSTIN. Decides CGST+SGST or IGST on every invoice.',
  },
  { name: 'pan', label: 'PAN', section: 'Identity', placeholder: 'AAACL1234M', uppercase: true },
  { name: 'phone', label: 'Phone', section: 'Contact', placeholder: '+91 98765 43210' },
  { name: 'email', label: 'Email', section: 'Contact', placeholder: 'accounts@example.com' },
  { name: 'billingAddress', label: 'Billing Address', type: 'textarea', section: 'Address' },
  { name: 'billingCity', label: 'City', section: 'Address', placeholder: 'Surat' },
  { name: 'billingState', label: 'State', section: 'Address', placeholder: 'Gujarat' },
  { name: 'billingPincode', label: 'PIN Code', section: 'Address', placeholder: '395010' },
  { name: 'shippingAddress', label: 'Shipping Address', type: 'textarea', section: 'Address' },
  {
    name: 'shippingStateCode',
    label: 'Delivery State Code',
    section: 'Address',
    placeholder: '27',
    help: 'Only if goods go to a different state from the billing address — that is where the tax follows',
  },
  {
    name: 'creditLimit',
    label: 'Credit Limit',
    type: 'number',
    section: 'Payment Terms',
    placeholder: '500000',
    help: 'In rupees',
  },
  {
    name: 'creditDays',
    label: 'Credit Days',
    type: 'number',
    section: 'Payment Terms',
    placeholder: '30',
  },
  { name: 'paymentTerms', label: 'Payment Terms', section: 'Payment Terms', placeholder: '30 days from invoice' },
  { name: 'bankName', label: 'Bank Name', section: 'Bank Details' },
  { name: 'bankAccount', label: 'Account Number', section: 'Bank Details' },
  { name: 'bankIFSC', label: 'IFSC Code', section: 'Bank Details', placeholder: 'HDFC0001234', uppercase: true },
  { name: 'notes', label: 'Notes', type: 'textarea', section: 'Other' },
  { name: 'isBlacklisted', label: 'Blacklisted', type: 'checkbox', placeholder: 'Block new orders', section: 'Other' },
  { name: 'isActive', label: 'Active', type: 'checkbox', placeholder: 'Available for new orders', section: 'Other' },
]

export default function CustomersPage() {
  return (
    <MasterTable<Customer>
      title="Customers"
      entityName="Customer"
      resource="customers"
      columns={columns}
      formFields={formFields}
      defaultSort="name"
      searchPlaceholder="Search name, code, GSTIN, phone, email..."
      emptyMessage="No customers yet. Add your first customer to get started."
    />
  )
}
