'use client'

import { Boxes } from 'lucide-react'
import { SheetImportDialog, type SheetImportConfig } from '@/components/masters/SheetImportDialog'

/*
 * Opening stock from the mill's own 19-column sheet. Checked first, row by
 * row — item, category, unit, size, quantity, rate, status, and nothing in
 * twice — then brought in all at once: raw materials into their stores (a
 * sticker per roll or lot), work in progress onto each process's floor and
 * finished goods into their stores, size by size.
 */

interface RowPlan {
  row: number
  skipped: boolean
  problems: string[]
  stage: string | null
  process: string
  location: string
  newFloor: boolean
  item: { code: string; name: string } | null
  size: string | null
  order: string | null
  lot: string | null
  bundle: string | null
  qty: number | null
  unit: string | null
  rate: number | null
  value: number | null
  status: string
}

interface Summary {
  rows: number
  lines: number
  skipped: number
  problems: number
  value: number
  floorsToMake: string[]
  byGroup: Array<{ group: string; label: string; lines: number; value: number }>
}

const count = (k: number, one: string, many: string) => `${k} ${k === 1 ? one : many}`
const num = (v: number | null) => (v === null ? '—' : v.toLocaleString('en-IN', { maximumFractionDigits: 3 }))
const money = (v: number | null) => (v === null ? '—' : `₹${v.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`)

const STATUS_BADGE: Record<string, string> = { OK: 'badge-success', Hold: 'badge-warning', Rejected: 'badge-danger', 'B-Grade': 'badge-purple' }

const config: SheetImportConfig<RowPlan, Summary> = {
  icon: Boxes,
  title: 'Import opening stock',
  subtitle:
    "From your 19-column stock sheet: raw materials into their stores, work in progress onto each process's floor, finished goods into their stores — size by size, with order, lot and bundle kept on every line.",
  importPath: '/inventory/opening-stock/import',
  templatePath: () => '/inventory/opening-stock/import-template',
  templates: {
    blank: {
      title: 'Opening stock template',
      text: 'The 19 columns, Opening Date to Remarks, with dropdowns for process, location, unit and status, and how to fill it.',
    },
  },
  columns: [
    {
      head: 'Where',
      width: 170,
      cell: (r) => (
        <>
          <div className="text-foreground text-xs font-medium">{r.process}</div>
          <div className="text-muted-foreground truncate text-[11px]">
            {r.location || '—'}
            {r.newFloor && <span className="text-primary"> · new</span>}
          </div>
        </>
      ),
    },
    {
      head: 'Item',
      cell: (r) => (
        <>
          <div className="text-foreground text-sm">{r.item?.name ?? '—'}</div>
          <div className="text-muted-foreground truncate text-[11px]">
            {[r.item?.code, r.order && `Order ${r.order}`, r.lot && `Lot ${r.lot}`, r.bundle && `Bundle ${r.bundle}`].filter(Boolean).join(' · ')}
          </div>
        </>
      ),
    },
    {
      head: 'Size · Qty',
      width: 110,
      cell: (r) => (
        <span className="text-xs tabular-nums">
          {r.size && <span className="text-foreground font-semibold">{r.size} · </span>}
          {num(r.qty)} {r.unit ?? ''}
        </span>
      ),
    },
    {
      head: 'Rate · Value',
      width: 130,
      cell: (r) => (
        <span className="text-xs tabular-nums">
          {money(r.rate)}
          <span className="text-muted-foreground"> · </span>
          <span className="text-foreground font-semibold">{money(r.value)}</span>
        </span>
      ),
    },
    {
      head: 'Status',
      width: 80,
      cell: (r) => <span className={STATUS_BADGE[r.status] ?? 'badge-neutral'}>{r.status}</span>,
    },
  ],
  chips: (s) => (
    <>
      <span className="badge-success">{count(s.lines, 'line', 'lines')}</span>
      <span className="badge-info">{money(s.value)}</span>
      {s.byGroup.map((g) => (
        <span key={g.group} className="badge-neutral">
          {g.label}: {g.lines}
        </span>
      ))}
      {s.floorsToMake.length > 0 && <span className="badge-warning">New: {s.floorsToMake.join(', ')}</span>}
    </>
  ),
  toDo: (s) => (s.lines ? [`${count(s.lines, 'line', 'lines')} of opening stock (${money(s.value)})`] : []),
  created: (data) => {
    const d = data as { number: string; lines: number; stickers: number; floorsMade: string[] }
    return [
      { code: d.number, name: `${count(d.lines, 'line', 'lines')} of opening stock` },
      ...(d.stickers ? [{ name: `${count(d.stickers, 'sticker', 'stickers')} ready to print in Stickers` }] : []),
      ...d.floorsMade.map((f) => ({ name: `${f} made` })),
    ]
  },
}

export function ImportOpeningStockDialog({ onClose, onImported }: { onClose: () => void; onImported: () => void }) {
  return <SheetImportDialog config={config} onClose={onClose} onImported={() => onImported()} />
}
