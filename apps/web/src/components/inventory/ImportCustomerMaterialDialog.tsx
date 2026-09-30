'use client'

import { PackageOpen } from 'lucide-react'
import { SheetImportDialog, type SheetImportConfig } from '@/components/masters/SheetImportDialog'

interface RowPlan {
  row: number
  receipt: string | null
  customer: string
  store: string
  challanNo: string | null
  item: string
  itemCode: string
  challanQty: number | null
  arrivedQty: number | null
  uom: string
  already: string | null
  skipped: boolean
  problems: string[]
}

interface Summary {
  rows: number
  receipts: number
  lines: number
  skipped: number
  problems: number
}

const count = (k: number, one: string, many: string) => `${k} ${k === 1 ? one : many}`
const qty = (v: number | null) =>
  v === null ? '—' : v.toLocaleString('en-IN', { minimumFractionDigits: 0, maximumFractionDigits: 3 })

/** Customer receipts from a spreadsheet: one row per item, rows of one challan are one receipt. */
const config: SheetImportConfig<RowPlan, Summary> = {
  icon: PackageOpen,
  title: 'Import customer material',
  subtitle: "From a spreadsheet: what customers have sent in. It goes into stock under their name, never into our stock value.",
  importPath: '/inventory/customer-grn/import',
  templatePath: (current) => `/inventory/customer-grn/import-template?withCurrent=${current}`,
  templates: {
    blank: {
      title: 'Blank template',
      text: 'One row per item. Dropdowns for customer, store and item code.',
    },
    current: {
      title: 'With your receipts so far',
      text: 'Every receipt already booked. Add new rows at the bottom; challans already booked are skipped.',
    },
  },
  columns: [
    {
      head: 'Receipt',
      width: 190,
      cell: (r) => (
        <>
          <div className="text-foreground text-xs font-medium">{r.already ? `Already ${r.already}` : (r.receipt ?? '—')}</div>
          <div className="text-muted-foreground truncate text-[11px]">
            {[r.customer, r.challanNo].filter(Boolean).join(' · ')}
          </div>
        </>
      ),
    },
    {
      head: 'Item',
      cell: (r) => (
        <>
          <div className="text-foreground text-sm">{r.item || '—'}</div>
          {r.itemCode && <div className="font-mono text-[11px] text-teal-500">{r.itemCode}</div>}
        </>
      ),
    },
    {
      head: 'Challan · arrived',
      width: 150,
      cell: (r) => {
        const diff = r.arrivedQty !== null && r.challanQty !== null ? r.arrivedQty - r.challanQty : 0
        return (
          <span className="text-xs tabular-nums">
            {qty(r.challanQty)} · <span className="font-semibold">{qty(r.arrivedQty)}</span> {r.uom}
            {diff !== 0 && <span className={diff < 0 ? 'text-red-400' : 'text-amber-400'}> ({diff > 0 ? '+' : ''}{qty(diff)})</span>}
          </span>
        )
      },
    },
  ],
  chips: (s) => (
    <>
      <span className="badge-success">{count(s.receipts, 'receipt', 'receipts')}</span>
      <span className="badge-info">{count(s.lines, 'item', 'items')}</span>
    </>
  ),
  toDo: (s) => (s.receipts ? [`${count(s.receipts, 'receipt', 'receipts')} with ${count(s.lines, 'item', 'items')}`] : []),
  created: (data) => (data as { created: Array<{ code: string; name: string }> }).created,
}

export function ImportCustomerMaterialDialog({ onClose, onImported }: { onClose: () => void; onImported: () => void }) {
  return <SheetImportDialog config={config} onClose={onClose} onImported={onImported} />
}
