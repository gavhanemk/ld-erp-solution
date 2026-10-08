'use client'

import { useState } from 'react'
import { FileSpreadsheet, Star } from 'lucide-react'
import { ActiveBadge, MasterTable, type Column, type FilterDef } from '@/components/masters/MasterTable'
import {
  SUPPLIER_CATEGORY_LABEL as CATEGORY_LABEL,
  supplierFormFields as formFields,
} from '@/components/masters/supplierFormFields'
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
