'use client'

import { useState } from 'react'
import { FileSpreadsheet } from 'lucide-react'
import { ActiveBadge, MasterTable, type Column, type FilterDef } from '@/components/masters/MasterTable'
import type { FormField } from '@/components/masters/MasterFormDialog'
import { ImportCustomersDialog } from '@/components/masters/ImportCustomersDialog'
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
    className: 'font-mono text-xs text-teal-400 whitespace-nowrap',
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
    render: (c) => <span className="text-xs text-muted-foreground whitespace-nowrap">{c.creditDays} days</span>,
  },
  {
    key: 'isActive',
    header: 'Status',
    render: (c) => <ActiveBadge isActive={c.isActive} />,
  },
]

/*
 * Four across, so a customer fits on one screen: who they are and how to
 * reach them, then both addresses side by side with city, state, PIN and the
 * delivery state on one row, then credit and bank on two full rows ending
 * with notes beside the blacklist tick. Hints sit in the boxes rather than
 * under them.
 */
const formFields: FormField[] = [
  { name: 'code', label: 'Customer Code', generated: true, section: 'Identity & Contact' },
  {
    name: 'name',
    label: 'Customer Name',
    required: true,
    placeholder: 'Rajan Traders',
    section: 'Identity & Contact',
    span: 2,
  },
  {
    name: 'type',
    label: 'Type',
    type: 'select',
    required: true,
    section: 'Identity & Contact',
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
    section: 'Identity & Contact',
    placeholder: '27AAACL1234M1Z5',
    uppercase: true,
    derives: { field: 'billingStateCode', from: (v) => (/^\d{2}/.test(v) ? v.slice(0, 2) : null) },
  },
  {
    name: 'billingStateCode',
    label: 'GST State Code',
    section: 'Identity & Contact',
    placeholder: '27 (from the GSTIN)',
  },
  { name: 'pan', label: 'PAN', section: 'Identity & Contact', placeholder: 'AAACL1234M', uppercase: true },
  { name: 'phone', label: 'Phone', section: 'Identity & Contact', placeholder: '+91 98765 43210' },
  { name: 'email', label: 'Email', section: 'Identity & Contact', placeholder: 'accounts@example.com' },
  { name: 'billingAddress', label: 'Billing Address', type: 'textarea', section: 'Address', span: 2, rows: 1 },
  { name: 'shippingAddress', label: 'Shipping Address', type: 'textarea', section: 'Address', span: 2, rows: 1 },
  { name: 'billingCity', label: 'City', section: 'Address', placeholder: 'Surat' },
  { name: 'billingState', label: 'State', section: 'Address', placeholder: 'Gujarat' },
  { name: 'billingPincode', label: 'PIN Code', section: 'Address', placeholder: '395010' },
  {
    name: 'shippingStateCode',
    label: 'Delivery State Code',
    section: 'Address',
    placeholder: 'Only if another state',
  },
  {
    name: 'creditLimit',
    label: 'Credit Limit (₹)',
    type: 'number',
    section: 'Credit, Bank & Notes',
    placeholder: '500000',
  },
  { name: 'creditDays', label: 'Credit Days', type: 'number', max: 365, section: 'Credit, Bank & Notes', placeholder: '30' },
  {
    name: 'paymentTerms',
    label: 'Payment Terms',
    section: 'Credit, Bank & Notes',
    placeholder: '30 days from invoice',
  },
  { name: 'bankName', label: 'Bank Name', section: 'Credit, Bank & Notes' },
  { name: 'bankAccount', label: 'Account Number', section: 'Credit, Bank & Notes' },
  { name: 'bankIFSC', label: 'IFSC Code', section: 'Credit, Bank & Notes', placeholder: 'HDFC0001234', uppercase: true },
  { name: 'notes', label: 'Notes', type: 'textarea', section: 'Credit, Bank & Notes', span: 1, rows: 1 },
  {
    name: 'isBlacklisted',
    label: 'Blacklisted',
    type: 'checkbox',
    placeholder: 'Block new orders',
    section: 'Credit, Bank & Notes',
  },
  { name: 'isActive', label: 'Active', type: 'checkbox', placeholder: 'Available for new orders', section: 'Credit, Bank & Notes' },
]

/*
 * The ways a customer list gets narrowed: kind, place, terms, GST, broker,
 * blacklist. State, city and terms offer the values in use; each counts
 * what it would leave.
 */
const filterDefs: FilterDef[] = [
  {
    key: 'type',
    label: 'Type',
    facet: 'type',
    options: Object.entries(TYPE_LABEL).map(([value, t]) => ({ value, label: t.label })),
  },
  { key: 'billingState', label: 'State', facet: 'billingState', valuesFromFacet: true, noneLabel: 'Not set' },
  { key: 'billingCity', label: 'City', facet: 'billingCity', valuesFromFacet: true, noneLabel: 'Not set' },
  {
    key: 'creditDays',
    label: 'Terms',
    facet: 'creditDays',
    valuesFromFacet: true,
    sortValues: (a, b) => Number(a) - Number(b),
    valueLabel: (v) => `${v} days`,
  },
  {
    key: 'gst',
    label: 'GST',
    facet: 'gst',
    options: [
      { value: 'registered', label: 'Registered' },
      { value: 'unregistered', label: 'Unregistered' },
    ],
  },
  { key: 'brokerId', label: 'Broker', facet: 'brokerId', optionsFrom: { resource: 'brokers' }, noneLabel: 'No broker' },
  {
    key: 'isBlacklisted',
    label: 'Blacklist',
    facet: 'isBlacklisted',
    options: [
      { value: 'false', label: 'Not blacklisted' },
      { value: 'true', label: 'Blacklisted' },
    ],
  },
]

export default function CustomersPage() {
  const [importing, setImporting] = useState(false)
  // Bumped after an import, so the list and its filter counts reload.
  const [refreshKey, setRefreshKey] = useState(0)

  return (
    <>
      <MasterTable<Customer>
        title="Customers"
        entityName="Customer"
        resource="customers"
        columns={columns}
        formFields={formFields}
        formColumns={4}
        filterDefs={filterDefs}
        defaultSort="name"
        searchPlaceholder="Search name, code, GSTIN, phone, email, city..."
        emptyMessage="No customers yet. Add your first customer to get started."
        refreshKey={refreshKey}
        exportable
        actions={
          <button type="button" className="btn-secondary" onClick={() => setImporting(true)}>
            <FileSpreadsheet size={16} /> Import
          </button>
        }
      />
      {importing && (
        <ImportCustomersDialog onClose={() => setImporting(false)} onImported={() => setRefreshKey((k) => k + 1)} />
      )}
    </>
  )
}
