'use client'

import { useState } from 'react'
import { FileSpreadsheet, Star } from 'lucide-react'
import { ActiveBadge, MasterTable, type Column, type FilterDef } from '@/components/masters/MasterTable'
import type { FormField } from '@/components/masters/MasterFormDialog'
import { ImportSuppliersDialog } from '@/components/masters/ImportSuppliersDialog'

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
  isMsme: boolean
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
  { key: 'code', header: 'Code', sortable: true, className: 'font-mono text-xs text-teal-400 whitespace-nowrap' },
  {
    key: 'name',
    header: 'Supplier',
    sortable: true,
    className: 'font-medium',
    render: (s) => (
      <div className="flex items-center gap-2">
        <span>{s.name}</span>
        {s.isMsme && (
          <span
            className="rounded border border-sky-500/30 bg-sky-500/10 px-1 text-[10px] font-semibold text-sky-600"
            title="MSME / Udyam registered: pay within 45 days"
          >
            MSME
          </span>
        )}
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
    render: (s) => <span className="text-xs whitespace-nowrap">{s.leadTimeDays} days</span>,
  },
  {
    key: 'creditDays',
    header: 'Terms',
    align: 'right',
    render: (s) => <span className="text-xs text-muted-foreground whitespace-nowrap">{s.creditDays} days</span>,
  },
  {
    key: 'rating',
    header: 'Rating',
    align: 'center',
    sortable: true,
    render: (s) =>
      s.rating ? (
        <span className="text-amber-400 text-xs whitespace-nowrap" title={`${s.rating} out of 5`}>
          {'★'.repeat(s.rating)}
          <span className="text-muted-foreground">{'★'.repeat(5 - s.rating)}</span>
        </span>
      ) : (
        <span className="text-muted-foreground">—</span>
      ),
  },
  { key: 'isActive', header: 'Status', render: (s) => <ActiveBadge isActive={s.isActive} /> },
]

/*
 * Four across on a wider card, so a supplier fits on one screen: who they
 * are and how to reach them; where they are and how they supply; bank, MSME
 * and notes, with the preferred tick beside the notes. Hints sit in the
 * boxes rather than under them.
 */
const formFields: FormField[] = [
  { name: 'code', label: 'Supplier Code', generated: true, section: 'Identity & Contact' },
  {
    name: 'name',
    label: 'Supplier Name',
    required: true,
    placeholder: 'Shree Fabrics',
    section: 'Identity & Contact',
    span: 2,
  },
  {
    name: 'category',
    label: 'Category',
    type: 'select',
    required: true,
    section: 'Identity & Contact',
    options: Object.entries(CATEGORY_LABEL).map(([value, label]) => ({ value, label })),
  },
  {
    name: 'gstin',
    label: 'GSTIN',
    section: 'Identity & Contact',
    placeholder: '27AAACL1234M1Z5',
    uppercase: true,
    // The first two digits are the state, and the state is what decides whether
    // they bill CGST+SGST or IGST.
    derives: { field: 'stateCode', from: (v) => (/^\d{2}/.test(v) ? v.slice(0, 2) : null) },
  },
  { name: 'stateCode', label: 'GST State Code', section: 'Identity & Contact', placeholder: '27 (from the GSTIN)' },
  { name: 'pan', label: 'PAN', section: 'Identity & Contact', placeholder: 'AAACL1234M', uppercase: true },
  { name: 'phone', label: 'Phone', section: 'Identity & Contact', placeholder: '+91 98765 43210' },
  { name: 'email', label: 'Email', section: 'Identity & Contact', placeholder: 'sales@example.com' },
  { name: 'address', label: 'Address', type: 'textarea', section: 'Address & Terms', span: 2, rows: 1 },
  { name: 'city', label: 'City', section: 'Address & Terms', placeholder: 'Bhiwandi' },
  { name: 'state', label: 'State', section: 'Address & Terms', placeholder: 'Maharashtra' },
  { name: 'pincode', label: 'PIN Code', section: 'Address & Terms', placeholder: '421302' },
  {
    name: 'leadTimeDays',
    label: 'Lead Time (days)',
    type: 'number',
    section: 'Address & Terms',
    placeholder: '7 (order to delivery)',
  },
  { name: 'creditDays', label: 'Credit Days', type: 'number', section: 'Address & Terms', placeholder: '30' },
  { name: 'paymentTerms', label: 'Payment Terms', section: 'Address & Terms', placeholder: '30 days from bill' },
  { name: 'bankName', label: 'Bank Name', section: 'Bank, MSME & Notes' },
  { name: 'bankAccount', label: 'Account Number', section: 'Bank, MSME & Notes' },
  { name: 'bankIFSC', label: 'IFSC Code', section: 'Bank, MSME & Notes', placeholder: 'HDFC0001234', uppercase: true },
  { name: 'rating', label: 'Rating', type: 'number', section: 'Bank, MSME & Notes', placeholder: '1 to 5' },
  {
    name: 'isMsme',
    label: 'MSME',
    type: 'checkbox',
    placeholder: 'Udyam registered',
    section: 'Bank, MSME & Notes',
  },
  {
    name: 'msmeNumber',
    label: 'Udyam Number',
    section: 'Bank, MSME & Notes',
    placeholder: 'UDYAM-MH-00-0000000',
    uppercase: true,
  },
  { name: 'notes', label: 'Notes', type: 'textarea', section: 'Bank, MSME & Notes', span: 1, rows: 1 },
  {
    name: 'isPreferred',
    label: 'Preferred',
    type: 'checkbox',
    placeholder: 'Prioritise in vendor lists',
    section: 'Bank, MSME & Notes',
  },
  { name: 'isActive', label: 'Active', type: 'checkbox', placeholder: 'Available for new orders', section: 'Bank, MSME & Notes' },
]

/*
 * The ways a supplier list gets narrowed: what they supply, where, on what
 * terms, how well, GST, preferred, MSME. Each counts what it would leave.
 */
const filterDefs: FilterDef[] = [
  {
    key: 'category',
    label: 'Category',
    facet: 'category',
    options: Object.entries(CATEGORY_LABEL).map(([value, label]) => ({ value, label })),
  },
  { key: 'state', label: 'State', facet: 'state', valuesFromFacet: true, noneLabel: 'Not set' },
  { key: 'city', label: 'City', facet: 'city', valuesFromFacet: true, noneLabel: 'Not set' },
  {
    key: 'creditDays',
    label: 'Terms',
    facet: 'creditDays',
    valuesFromFacet: true,
    sortValues: (a, b) => Number(a) - Number(b),
    valueLabel: (v) => `${v} days`,
  },
  {
    key: 'rating',
    label: 'Rating',
    facet: 'rating',
    valuesFromFacet: true,
    sortValues: (a, b) => Number(b) - Number(a),
    valueLabel: (v) => `${'★'.repeat(Number(v))} ${v}`,
    noneLabel: 'Not rated',
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
  {
    key: 'isPreferred',
    label: 'Preferred',
    facet: 'isPreferred',
    options: [
      { value: 'true', label: 'Preferred' },
      { value: 'false', label: 'Not preferred' },
    ],
  },
  {
    key: 'isMsme',
    label: 'MSME',
    facet: 'isMsme',
    options: [
      { value: 'true', label: 'MSME' },
      { value: 'false', label: 'Not MSME' },
    ],
  },
]

export default function SuppliersPage() {
  const [importing, setImporting] = useState(false)
  // Bumped after an import, so the list and its filter counts reload.
  const [refreshKey, setRefreshKey] = useState(0)

  return (
    <>
      <MasterTable<Supplier>
        title="Suppliers"
        entityName="Supplier"
        resource="suppliers"
        columns={columns}
        formFields={formFields}
        formColumns={4}
        formWide
        filterDefs={filterDefs}
        defaultSort="name"
        searchPlaceholder="Search name, code, GSTIN, city..."
        emptyMessage="No suppliers yet. Add your fabric and trim vendors here."
        refreshKey={refreshKey}
        exportable
        actions={
          <button type="button" className="btn-secondary" onClick={() => setImporting(true)}>
            <FileSpreadsheet size={16} /> Import
          </button>
        }
      />
      {importing && (
        <ImportSuppliersDialog onClose={() => setImporting(false)} onImported={() => setRefreshKey((k) => k + 1)} />
      )}
    </>
  )
}
