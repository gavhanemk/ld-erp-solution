'use client'

import { Truck } from 'lucide-react'
import { SheetImportDialog, type SheetImportConfig } from './SheetImportDialog'

interface RowPlan {
  row: number
  name: string
  code: string | null
  supplier: 'new' | 'existing' | 'none'
  place: string | null
  skipped: boolean
  problems: string[]
}

interface Summary {
  rows: number
  newSuppliers: number
  existing: number
  skipped: number
  problems: number
}

const count = (k: number, one: string, many: string) => `${k} ${k === 1 ? one : many}`

/** Suppliers from a spreadsheet. New suppliers only; one already there is skipped. */
const config: SheetImportConfig<RowPlan, Summary> = {
  icon: Truck,
  title: 'Import suppliers',
  subtitle: 'From a spreadsheet: new suppliers, checked the same way as the form, GSTIN included.',
  importPath: '/masters/suppliers/import',
  templatePath: (current) => `/masters/suppliers/import-template?withCurrent=${current}`,
  templates: {
    blank: {
      title: 'Blank template',
      text: 'For new suppliers. Dropdowns for category, state, MSME and rating; the state code and PAN come from the GSTIN.',
    },
    current: {
      title: 'With your current suppliers',
      text: 'Every supplier already listed. Add new ones at the bottom; suppliers already there are skipped, not changed.',
    },
  },
  columns: [
    {
      head: 'Supplier',
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
        <span className="text-xs">{r.supplier === 'new' ? 'New supplier' : r.supplier === 'existing' ? 'Already there' : '—'}</span>
      ),
    },
    { head: 'Place', width: 200, cell: (r) => <span className="text-xs">{r.place ?? '—'}</span> },
  ],
  chips: (s) => <span className="badge-success">{count(s.newSuppliers, 'new supplier', 'new suppliers')}</span>,
  toDo: (s) => (s.newSuppliers ? [count(s.newSuppliers, 'new supplier', 'new suppliers')] : []),
  created: (data) => (data as { created: Array<{ code: string; name: string }> }).created,
}

export function ImportSuppliersDialog({ onClose, onImported }: { onClose: () => void; onImported: () => void }) {
  return <SheetImportDialog config={config} onClose={onClose} onImported={onImported} />
}
