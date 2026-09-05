'use client'

import { ActiveBadge, MasterTable, type Column } from '@/components/masters/MasterTable'
import type { FormField } from '@/components/masters/MasterFormDialog'

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
  brokeragePercent: string | number
  tdsSection: string | null
  tdsRate: string | number | null
  isActive: boolean
}

const columns: Column<Broker>[] = [
  { key: 'code', header: 'Code', sortable: true, className: 'font-mono text-xs text-teal-400' },
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
        <span className="text-xs">
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
      [b.city, b.state].filter(Boolean).join(', ') || <span className="text-muted-foreground">—</span>,
  },
  { key: 'gstin', header: 'GSTIN', className: 'font-mono text-xs text-muted-foreground' },
  { key: 'isActive', header: 'Status', render: (b) => <ActiveBadge isActive={b.isActive} /> },
]

const formFields: FormField[] = [
  { name: 'code', label: 'Code', generated: true, section: 'Identity' },
  {
    name: 'name',
    label: 'Agent Name',
    required: true,
    placeholder: 'Shree Shyam Textile Agency',
    section: 'Identity',
  },
  { name: 'phone', label: 'Phone', section: 'Contact', placeholder: '+91 98765 43210' },
  { name: 'email', label: 'Email', section: 'Contact' },
  { name: 'city', label: 'City', section: 'Contact' },
  { name: 'state', label: 'State', section: 'Contact', placeholder: 'Maharashtra' },
  {
    name: 'stateCode',
    label: 'GST State Code',
    section: 'Contact',
    placeholder: '27',
    help: 'The two digits their GSTIN starts with',
  },
  { name: 'gstin', label: 'GSTIN', section: 'Tax', placeholder: '27AAACL1234M1Z5' },
  { name: 'pan', label: 'PAN', section: 'Tax', placeholder: 'AAACL1234M' },
  {
    name: 'brokeragePercent',
    label: 'Brokerage %',
    type: 'number',
    required: true,
    section: 'Commission',
    placeholder: '2',
    help: 'Applied to the order value. Can be overridden on an individual order.',
  },
  {
    name: 'tdsSection',
    label: 'TDS Section',
    section: 'Commission',
    placeholder: '194H',
    help: 'Commission to an agent is normally 194H',
  },
  { name: 'tdsRate', label: 'TDS %', type: 'number', section: 'Commission', placeholder: '5' },
  { name: 'notes', label: 'Notes', type: 'textarea', section: 'Other' },
  { name: 'isActive', label: 'Active', type: 'checkbox', placeholder: 'Available on new orders', section: 'Other' },
]

export default function BrokersPage() {
  return (
    <MasterTable<Broker>
      title="Agents & Brokers"
      entityName="Agent"
      resource="brokers"
      columns={columns}
      formFields={formFields}
      defaultSort="name"
      searchPlaceholder="Search name, code, phone or email..."
      emptyMessage="No agents yet. Add the people who bring you orders."
    />
  )
}
