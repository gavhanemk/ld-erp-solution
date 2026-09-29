'use client'

import { useState } from 'react'
import { FileSpreadsheet } from 'lucide-react'
import { ActiveBadge, MasterTable, type Column, type FilterDef } from '@/components/masters/MasterTable'
import type { FormField } from '@/components/masters/MasterFormDialog'
import { ImportBrokersDialog } from '@/components/masters/ImportBrokersDialog'
import { stateName } from '@/lib/gstStates'

/**
 * Commission agents.
 *
 * LD runs eleven of them plus "SELF" for direct sales, pays brokerage on the
 * invoice value and deducts TDS under section 194H. That is real money leaving
 * the business, so it needs a record rather than a note in somebody's diary.
 */
interface Broker {
  id: string
  code: string
  name: string
  phone: string | null
  email: string | null
  gstin: string | null
  pan: string | null
  city: string | null
  state: string | null
  stateCode: string | null
  brokeragePercent: string | number
  tdsSection: string | null
  tdsRate: string | number | null
  isActive: boolean
  _count?: { customers: number }
}

const columns: Column<Broker>[] = [
  { key: 'code', header: 'Code', sortable: true, className: 'font-mono text-xs text-teal-400 whitespace-nowrap' },
  { key: 'name', header: 'Agent', sortable: true, className: 'font-medium' },
  {
    key: 'brokeragePercent',
    header: 'Brokerage',
    align: 'right',
    sortable: true,
    render: (b) => <span className="font-semibold">{Number(b.brokeragePercent)}%</span>,
  },
  {
    key: 'tds',
    header: 'TDS',
    render: (b) =>
      b.tdsSection ? (
        <span className="text-xs whitespace-nowrap">
          {b.tdsSection}
          {b.tdsRate != null && ` @ ${Number(b.tdsRate)}%`}
        </span>
      ) : (
        <span className="text-muted-foreground">—</span>
      ),
  },
  {
    key: 'contact',
    header: 'Contact',
    render: (b) => (
      <div className="text-xs">
        {b.phone && <div>{b.phone}</div>}
        {b.email && <div className="text-muted-foreground">{b.email}</div>}
        {!b.phone && !b.email && <span className="text-muted-foreground">—</span>}
      </div>
    ),
  },
  {
    key: 'location',
    header: 'Location',
    render: (b) =>
      [b.city, b.state ?? (b.stateCode ? stateName(b.stateCode) : null)].filter(Boolean).join(', ') || (
        <span className="text-muted-foreground">—</span>
      ),
  },
  { key: 'gstin', header: 'GSTIN', className: 'font-mono text-xs text-muted-foreground' },
  {
    key: 'customers',
    header: 'Customers',
    align: 'right',
    render: (b) =>
      b._count?.customers ? (
        <span>{b._count.customers}</span>
      ) : (
        <span className="text-muted-foreground">—</span>
      ),
  },
  { key: 'isActive', header: 'Status', render: (b) => <ActiveBadge isActive={b.isActive} /> },
]

/*
 * Four across on a wider card: who they are and their registration, where
 * they are, then the commission and TDS with the notes beside them. Hints
 * sit in the boxes rather than under them, so it fits without scrolling.
 */
const formFields: FormField[] = [
  { name: 'code', label: 'Code', generated: true, section: 'Identity & Contact' },
  {
    name: 'name',
    label: 'Agent Name',
    required: true,
    placeholder: 'Shree Shyam Textile Agency',
    section: 'Identity & Contact',
    span: 2,
  },
  { name: 'phone', label: 'Phone', section: 'Identity & Contact', placeholder: '+91 98765 43210' },
  { name: 'email', label: 'Email', section: 'Identity & Contact', placeholder: 'agent@example.com' },
  {
    name: 'gstin',
    label: 'GSTIN',
    section: 'Identity & Contact',
    placeholder: '27AAACL1234M1Z5',
    uppercase: true,
    derives: { field: 'stateCode', from: (v) => (/^\d{2}/.test(v) ? v.slice(0, 2) : null) },
  },
  { name: 'stateCode', label: 'GST State Code', section: 'Identity & Contact', placeholder: '27 (from the GSTIN)' },
  { name: 'pan', label: 'PAN', section: 'Identity & Contact', placeholder: 'AAACL1234M (for TDS)', uppercase: true },
  { name: 'address', label: 'Address', type: 'textarea', section: 'Address', span: 2, rows: 1 },
  { name: 'city', label: 'City', section: 'Address', placeholder: 'Surat' },
  { name: 'state', label: 'State', section: 'Address', placeholder: 'Maharashtra' },
  {
    name: 'brokeragePercent',
    label: 'Brokerage %',
    type: 'number',
    required: true,
    section: 'Commission & Notes',
    placeholder: '2 (on order value)',
  },
  { name: 'tdsSection', label: 'TDS Section', section: 'Commission & Notes', placeholder: '194H', uppercase: true },
  { name: 'tdsRate', label: 'TDS %', type: 'number', section: 'Commission & Notes', placeholder: '5' },
  { name: 'notes', label: 'Notes', type: 'textarea', section: 'Commission & Notes', span: 1, rows: 1 },
  { name: 'isActive', label: 'Active', type: 'checkbox', placeholder: 'Available on new orders', section: 'Commission & Notes' },
]

/*
 * Where the agent is, what they are paid, their TDS, GST, and whether any
 * customer comes through them. Each counts what it would leave.
 */
const filterDefs: FilterDef[] = [
  {
    key: 'stateCode',
    label: 'State',
    facet: 'stateCode',
    valuesFromFacet: true,
    valueLabel: stateName,
    sortValues: (a, b) => stateName(a).localeCompare(stateName(b)),
    noneLabel: 'Not set',
  },
  { key: 'city', label: 'City', facet: 'city', valuesFromFacet: true, noneLabel: 'Not set' },
  {
    key: 'brokeragePercent',
    label: 'Brokerage',
    facet: 'brokeragePercent',
    valuesFromFacet: true,
    sortValues: (a, b) => Number(a) - Number(b),
    valueLabel: (v) => `${Number(v)}%`,
  },
  { key: 'tdsSection', label: 'TDS', facet: 'tdsSection', valuesFromFacet: true, noneLabel: 'No TDS' },
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
    key: 'customers',
    label: 'Customers',
    facet: 'customers',
    options: [
      { value: 'with', label: 'Bring customers' },
      { value: 'without', label: 'No customers yet' },
    ],
  },
]

export default function BrokersPage() {
  const [importing, setImporting] = useState(false)
  // Bumped after an import, so the list and its filter counts reload.
  const [refreshKey, setRefreshKey] = useState(0)

  return (
    <>
      <MasterTable<Broker>
        title="Agents & Brokers"
        entityName="Agent"
        resource="brokers"
        columns={columns}
        formFields={formFields}
        formColumns={4}
        formWide
        filterDefs={filterDefs}
        defaultSort="name"
        searchPlaceholder="Search name, code, phone, email, city..."
        emptyMessage="No agents yet. Add the people who bring you orders."
        refreshKey={refreshKey}
        exportable
        actions={
          <button type="button" className="btn-secondary" onClick={() => setImporting(true)}>
            <FileSpreadsheet size={16} /> Import
          </button>
        }
      />
      {importing && (
        <ImportBrokersDialog onClose={() => setImporting(false)} onImported={() => setRefreshKey((k) => k + 1)} />
      )}
    </>
  )
}
