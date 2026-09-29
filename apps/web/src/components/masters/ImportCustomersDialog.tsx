'use client'

import { Users } from 'lucide-react'
import { SheetImportDialog, type SheetImportConfig } from './SheetImportDialog'

interface RowPlan {
  row: number
  name: string
  code: string | null
  customer: 'new' | 'existing' | 'none'
  place: string | null
  skipped: boolean
  problems: string[]
}

interface Summary {
  rows: number
  newCustomers: number
  existing: number
  skipped: number
  problems: number
}

const count = (k: number, one: string, many: string) => `${k} ${k === 1 ? one : many}`

/** Customers from a spreadsheet. New customers only; one already there is skipped. */
const config: SheetImportConfig<RowPlan, Summary> = {
  icon: Users,
  title: 'Import customers',
  subtitle: 'From a spreadsheet: new customers, checked the same way as the form, GSTIN included.',
  importPath: '/masters/customers/import',
  templatePath: (current) => `/masters/customers/import-template?withCurrent=${current}`,
  templates: {
    blank: {
      title: 'Blank template',
      text: 'For new customers. Dropdowns for type and state; the state code and PAN come from the GSTIN.',
    },
    current: {
      title: 'With your current customers',
      text: 'Every customer already listed. Add new ones at the bottom; customers already there are skipped, not changed.',
    },
  },
  columns: [
    {
      head: 'Customer',
      cell: (r) => (
        <>
          <div className="text-foreground font-medium">{r.name || '—'}</div>
          {r.code && <div className="font-mono text-[11px] text-teal-500">{r.code}</div>}
        </>
      ),
    },
    {
      head: 'What happens',
      width: 150,
      cell: (r) => (
        <span className="text-xs">{r.customer === 'new' ? 'New customer' : r.customer === 'existing' ? 'Already there' : '—'}</span>
      ),
    },
    { head: 'Place', width: 200, cell: (r) => <span className="text-xs">{r.place ?? '—'}</span> },
  ],
  chips: (s) => <span className="badge-success">{count(s.newCustomers, 'new customer', 'new customers')}</span>,
  toDo: (s) => (s.newCustomers ? [count(s.newCustomers, 'new customer', 'new customers')] : []),
  created: (data) => (data as { created: Array<{ code: string; name: string }> }).created,
}

export function ImportCustomersDialog({ onClose, onImported }: { onClose: () => void; onImported: () => void }) {
  return <SheetImportDialog config={config} onClose={onClose} onImported={onImported} />
}
