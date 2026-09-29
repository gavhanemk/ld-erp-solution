'use client'

import { SheetImportDialog, type SheetImportConfig } from './SheetImportDialog'

interface RowPlan {
  row: number
  name: string
  item: 'new' | 'existing' | 'none'
  code: string | null
  stock: { store: string; qty: number; rate: number } | null
  skipped: boolean
  problems: string[]
}

interface Summary {
  rows: number
  newItems: number
  existingItems: number
  skipped: number
  stockLines: number
  problems: number
}

const n = (v: number) => v.toLocaleString('en-IN', { maximumFractionDigits: 3 })
const count = (k: number, one: string, many: string) => `${k} ${k === 1 ? one : many}`

/** Items, and the stock of them, from a spreadsheet. */
const config: SheetImportConfig<RowPlan, Summary> = {
  title: 'Import items and stock',
  subtitle: 'From a spreadsheet: new items, and the stock of any item on hand today.',
  importPath: '/masters/items/import',
  templatePath: (current) => `/masters/items/import-template?withItems=${current}`,
  templates: {
    blank: {
      title: 'Blank template',
      text: 'For new items. Dropdowns for type, category, sub-category, department, unit and store.',
    },
    current: {
      title: 'With your current items',
      text: 'Every item already listed. Type the store, quantity and rate against the ones you have in stock; rows left empty are skipped. New items can be added at the bottom.',
    },
  },
  columns: [
    {
      head: 'Item',
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
        <span className="text-xs">{r.item === 'new' ? 'New item' : r.item === 'existing' ? 'Already there' : '—'}</span>
      ),
    },
    {
      head: 'Stock',
      cell: (r) => (
        <span className="text-xs tabular-nums">
          {r.stock ? `${n(r.stock.qty)} @ ₹${n(r.stock.rate)} in ${r.stock.store}` : '—'}
        </span>
      ),
    },
  ],
  chips: (s) => (
    <>
      <span className="badge-success">{count(s.newItems, 'new item', 'new items')}</span>
      <span className="badge-info">{count(s.stockLines, 'stock line', 'stock lines')}</span>
      {s.existingItems > 0 && (
        <span className="badge-neutral">{count(s.existingItems, 'item', 'items')} already there, stock only</span>
      )}
    </>
  ),
  toDo: (s) =>
    [
      s.newItems ? count(s.newItems, 'new item', 'new items') : '',
      s.stockLines ? count(s.stockLines, 'stock line', 'stock lines') : '',
    ].filter(Boolean),
  created: (data) => (data as { created: Array<{ code: string; name: string }> }).created,
}

export function ImportItemsDialog({ onClose, onImported }: { onClose: () => void; onImported: () => void }) {
  return <SheetImportDialog config={config} onClose={onClose} onImported={onImported} />
}
