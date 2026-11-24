'use client'

import { Fragment, useCallback, useEffect, useMemo, useState } from 'react'
import { AlertCircle, ChevronDown, ChevronRight, FileSpreadsheet, RefreshCw, Upload } from 'lucide-react'
import { api, ApiError, can } from '@/lib/api'
import { cn } from '@/lib/utils'
import { ImportOpeningStockDialog } from '@/components/inventory/ImportOpeningStockDialog'

/*
 * Inventory → Stock → Opening Stock: every upload of the 19-column sheet, and
 * each one's lines as they were brought in — where they went, by process and
 * location, with order, lot, bundle and size.
 */

interface Upload {
  id: string
  number: string
  fileName: string | null
  createdAt: string
  createdBy: { name: string } | null
  lines: number
  value: number
  openingDate: string | null
}

interface Line {
  id: string
  rowNo: number
  openingDate: string
  processText: string | null
  department: { name: string } | null
  warehouse: { name: string }
  orderNo: string | null
  styleText: string | null
  item: { code: string; name: string; type: string; uom: { symbol: string } | null }
  colour: string | null
  size: { code: string } | null
  lotNo: string | null
  bundleNo: string | null
  qty: string | number
  unitRate: string | number
  value: string | number
  status: string
  remarks: string | null
}

const money = (v: number) => `₹${v.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
const num = (v: number) => v.toLocaleString('en-IN', { maximumFractionDigits: 3 })
const day = (d: string | null) => (d ? new Date(d).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) : '—')
const STATUS: Record<string, { label: string; cls: string }> = {
  OK: { label: 'OK', cls: 'badge-success' },
  HOLD: { label: 'Hold', cls: 'badge-warning' },
  REJECTED: { label: 'Rejected', cls: 'badge-danger' },
  B_GRADE: { label: 'B-Grade', cls: 'badge-purple' },
}
const muted = <span className="text-muted-foreground">—</span>

export default function OpeningStockPage() {
  const [uploads, setUploads] = useState<Upload[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [importing, setImporting] = useState(false)
  const [open, setOpen] = useState<string | null>(null)
  const [lines, setLines] = useState<Record<string, Line[]>>({})
  const mayImport = can('inventory', 'create')

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const res = await api.get<{ data: Upload[] }>('/inventory/opening-stock')
      setUploads(res.data)
      setError(null)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load the opening stock. Is the API running?')
    } finally {
      setLoading(false)
    }
  }, [])
  useEffect(() => {
    void load()
  }, [load])

  const toggle = async (id: string) => {
    if (open === id) return setOpen(null)
    setOpen(id)
    if (!lines[id]) {
      try {
        const res = await api.get<{ data: { lines: Line[] } }>(`/inventory/opening-stock/${id}`)
        setLines((m) => ({ ...m, [id]: res.data.lines }))
      } catch (err) {
        setError(err instanceof ApiError ? err.message : 'Could not load the lines.')
      }
    }
  }

  const totals = useMemo(
    () => ({ lines: (uploads ?? []).reduce((n, u) => n + u.lines, 0), value: (uploads ?? []).reduce((n, u) => n + u.value, 0) }),
    [uploads],
  )

  return (
    <div className="space-y-6">
      <div className="page-header">
        <div>
          <h1 className="page-title">Opening Stock</h1>
          <p className="page-subtitle">
            {loading && !uploads
              ? 'Loading...'
              : `${uploads?.length ?? 0} ${uploads?.length === 1 ? 'upload' : 'uploads'} · ${totals.lines} lines · ${money(totals.value)}`}
          </p>
        </div>
        <div className="flex items-center gap-3">
          <button onClick={() => void load()} className="btn-secondary" title="Refresh">
            <RefreshCw size={16} className={loading ? 'animate-spin' : ''} /> Refresh
          </button>
          {mayImport && (
            <button type="button" className="btn-primary" onClick={() => setImporting(true)} data-hotkey="new" aria-keyshortcuts="Alt+N">
              <Upload size={16} /> Import opening stock
            </button>
          )}
        </div>
      </div>

      {error && (
        <div className="flex items-center gap-2 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-400">
          <AlertCircle size={15} /> {error}
        </div>
      )}

      <div className="glass-card overflow-x-auto p-0">
        {uploads && uploads.length === 0 ? (
          <div className="text-muted-foreground flex flex-col items-center gap-2 p-10 text-center text-sm">
            <FileSpreadsheet size={28} />
            <p>No opening stock yet.</p>
            <p className="text-xs">Import opening stock: download the template, fill in your 19 columns, upload it, check, import.</p>
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="text-muted-foreground bg-secondary/40 text-left text-[11px] font-semibold uppercase tracking-wide">
                <th className="w-10 px-2 py-2" />
                <th className="px-2 py-2">Number</th>
                <th className="px-2 py-2">Opening date</th>
                <th className="px-2 py-2">File</th>
                <th className="px-2 py-2 text-right">Lines</th>
                <th className="px-2 py-2 text-right">Value</th>
                <th className="px-4 py-2">Brought in</th>
              </tr>
            </thead>
            <tbody>
              {(uploads ?? []).map((u) => (
                <Fragment key={u.id}>
                  <tr className={cn('border-border hover:bg-secondary/30 cursor-pointer border-t', open === u.id && 'bg-secondary/30')} onClick={() => void toggle(u.id)}>
                    <td className="px-2 py-2 text-center">
                      <button type="button" className="btn-ghost p-1" aria-expanded={open === u.id} aria-label={`${open === u.id ? 'Hide' : 'Show'} the lines of ${u.number}`}>
                        {open === u.id ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
                      </button>
                    </td>
                    <td className="px-2 py-2 font-mono text-xs font-semibold text-teal-400">{u.number}</td>
                    <td className="px-2 py-2">{day(u.openingDate)}</td>
                    <td className="text-muted-foreground px-2 py-2 text-xs">{u.fileName ?? '—'}</td>
                    <td className="px-2 py-2 text-right tabular-nums">{u.lines}</td>
                    <td className="px-2 py-2 text-right font-semibold tabular-nums">{money(u.value)}</td>
                    <td className="text-muted-foreground px-4 py-2 text-xs">
                      {day(u.createdAt)}
                      {u.createdBy && ` · ${u.createdBy.name}`}
                    </td>
                  </tr>
                  {open === u.id && (
                    <tr>
                      <td />
                      <td colSpan={6} className="pb-4 pr-4">
                        <UploadLines lines={lines[u.id]} />
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {importing && (
        <ImportOpeningStockDialog
          onClose={() => setImporting(false)}
          onImported={() => {
            setLines({})
            void load()
          }}
        />
      )}
    </div>
  )
}

/** One upload's lines: by process and location first, then row by row. */
function UploadLines({ lines }: { lines: Line[] | undefined }) {
  if (!lines) return <p className="text-muted-foreground py-2 text-xs">Loading the lines…</p>
  const places = new Map<string, { label: string; lines: number; value: number }>()
  for (const l of lines) {
    const label = `${l.department?.name ?? l.processText ?? 'Store'} · ${l.warehouse.name}`
    const p = places.get(label) ?? { label, lines: 0, value: 0 }
    p.lines += 1
    p.value += Number(l.value)
    places.set(label, p)
  }
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2">
        {[...places.values()].map((p) => (
          <span key={p.label} className="badge-neutral">
            {p.label}: {p.lines} · {money(p.value)}
          </span>
        ))}
      </div>
      <div className="border-border overflow-x-auto rounded-lg border">
        <table className="w-full text-xs">
          <thead>
            <tr className="text-muted-foreground border-border border-b text-left text-[10px] font-semibold uppercase tracking-wide">
              <th className="px-2 py-1.5">Row</th>
              <th className="px-2 py-1.5">Process · Location</th>
              <th className="px-2 py-1.5">Order</th>
              <th className="px-2 py-1.5">Item</th>
              <th className="px-2 py-1.5">Size</th>
              <th className="px-2 py-1.5">Lot · Bundle</th>
              <th className="px-2 py-1.5 text-right">Qty</th>
              <th className="px-2 py-1.5 text-right">Rate</th>
              <th className="px-2 py-1.5 text-right">Value</th>
              <th className="px-2 py-1.5">Status</th>
              <th className="px-2 py-1.5">Remarks</th>
            </tr>
          </thead>
          <tbody>
            {lines.map((l) => {
              const s = STATUS[l.status] ?? { label: l.status, cls: 'badge-neutral' }
              return (
                <tr key={l.id} className="border-border border-t first:border-t-0">
                  <td className="text-muted-foreground px-2 py-1.5 tabular-nums">{l.rowNo}</td>
                  <td className="px-2 py-1.5">
                    <span className="text-foreground">{l.department?.name ?? l.processText ?? 'Store'}</span>
                    <span className="text-muted-foreground"> · {l.warehouse.name}</span>
                  </td>
                  <td className="px-2 py-1.5">{l.orderNo ?? muted}</td>
                  <td className="px-2 py-1.5">
                    <span className="font-mono text-teal-400">{l.item.code}</span> <span className="text-foreground">{l.item.name}</span>
                    {(l.styleText || l.colour) && <span className="text-muted-foreground"> · {[l.styleText, l.colour].filter(Boolean).join(' · ')}</span>}
                  </td>
                  <td className="px-2 py-1.5 font-semibold">{l.size?.code ?? muted}</td>
                  <td className="px-2 py-1.5">{[l.lotNo, l.bundleNo].filter(Boolean).join(' · ') || muted}</td>
                  <td className="whitespace-nowrap px-2 py-1.5 text-right tabular-nums">
                    {num(Number(l.qty))} {l.item.uom?.symbol ?? ''}
                  </td>
                  <td className="whitespace-nowrap px-2 py-1.5 text-right tabular-nums">{money(Number(l.unitRate))}</td>
                  <td className="whitespace-nowrap px-2 py-1.5 text-right font-semibold tabular-nums">{money(Number(l.value))}</td>
                  <td className="px-2 py-1.5">
                    <span className={s.cls}>{s.label}</span>
                  </td>
                  <td className="text-muted-foreground px-2 py-1.5">{l.remarks ?? ''}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}
