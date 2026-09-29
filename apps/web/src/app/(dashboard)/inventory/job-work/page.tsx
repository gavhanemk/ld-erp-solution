'use client'

import { Fragment, useCallback, useEffect, useState } from 'react'
import {
  Plus,
  Search,
  RefreshCw,
  AlertCircle,
  Ban,
  ChevronDown,
  ChevronRight,
  PackageCheck,
  ArrowRight,
} from 'lucide-react'
import { api, ApiError, type Paginated } from '@/lib/api'
import { SendJobWorkDialog, ReceiveJobWorkDialog } from '@/components/inventory/JobWorkDialogs'
import { formatDate } from '@/lib/utils'

/**
 * Our own fabric out at an outside unit.
 *
 * It never stops being ours — it has moved to a store standing for their floor,
 * so the stock screen still shows it. This screen answers the two questions
 * nobody could answer before: what is out, and how long has it been out.
 */

interface ChallanLine {
  id: string
  qty: string | number
  hsnCode: string | null
  unitRate: string | number | null
  item: { id: string; code: string; name: string; uom: { symbol: string } | null }
}

interface ReturnLine {
  id: string
  challanLineId: string
  consumedQty: string | number
  receivedQty: string | number
  wastedQty: string | number
  item: { id: string; name: string; uom: { symbol: string } | null }
  warehouse: { id: string; name: string }
}

interface JobWorkReturn {
  id: string
  returnNumber: string
  returnDate: string
  theirChallanNo: string | null
  receivedBy: { id: string; name: string } | null
  lines: ReturnLine[]
}

interface Challan {
  id: string
  challanNumber: string
  challanDate: string
  process: string
  expectedBackOn: string | null
  vehicleNo: string | null
  lrNumber: string | null
  notes: string | null
  status: 'SENT' | 'PARTLY_BACK' | 'CLOSED' | 'CANCELLED'
  cancelReason: string | null
  jobWorker: { id: string; name: string }
  fromWarehouse: { id: string; name: string }
  toWarehouse: { id: string; name: string }
  sentBy: { id: string; name: string } | null
  lines: ChallanLine[]
  returns: JobWorkReturn[]
}

const qty = (v: string | number) =>
  Number(v).toLocaleString('en-IN', { minimumFractionDigits: 0, maximumFractionDigits: 3 })

/** How much of a line is still sitting at the unit. */
function outstandingOf(challan: Challan, line: ChallanLine): number {
  const consumed = challan.returns
    .flatMap((r) => r.lines)
    .filter((rl) => rl.challanLineId === line.id)
    .reduce((s, rl) => s + Number(rl.consumedQty), 0)
  return Math.round((Number(line.qty) - consumed) * 1000) / 1000
}

function stage(c: Challan): { label: string; cls: string } {
  switch (c.status) {
    case 'CLOSED':
      return { label: 'All back', cls: 'badge-success' }
    case 'PARTLY_BACK':
      return { label: 'Part back', cls: 'badge-warning' }
    case 'CANCELLED':
      return { label: 'Cancelled', cls: 'badge-neutral' }
    default:
      return { label: 'Out', cls: 'badge-info' }
  }
}

export default function JobWorkPage() {
  const [rows, setRows] = useState<Challan[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)

  const [search, setSearch] = useState('')
  const [debounced, setDebounced] = useState('')
  const [status, setStatus] = useState('')
  const [open, setOpen] = useState<string | null>(null)
  const [sending, setSending] = useState(false)
  const [receiving, setReceiving] = useState<Challan | null>(null)

  useEffect(() => {
    const t = setTimeout(() => setDebounced(search), 350)
    return () => clearTimeout(t)
  }, [search])

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const qs = new URLSearchParams({ limit: '50' })
      if (debounced) qs.set('q', debounced)
      if (status) qs.set('status', status)
      const res = await api.get<Paginated<Challan>>(`/inventory/job-work?${qs}`)
      setRows(res.data)
      setTotal(res.pagination.total)
    } catch (err) {
      setError(
        err instanceof ApiError
          ? err.status === 403
            ? 'Your role does not allow viewing job work.'
            : err.message
          : 'Could not reach the server. Is the API running?'
      )
      setRows([])
    } finally {
      setLoading(false)
    }
  }, [debounced, status])

  useEffect(() => {
    void load()
  }, [load])

  const cancel = async (c: Challan) => {
    const reason = prompt(
      `Why is ${c.challanNumber} being cancelled?\n\nThe goods will be brought back to ${c.fromWarehouse.name}.`
    )
    if (!reason || reason.trim().length < 5) return

    setBusy(c.id)
    setError(null)
    setMessage(null)
    try {
      const res = await api.patch<{ message?: string }>(`/inventory/job-work/${c.id}/cancel`, {
        reason: reason.trim(),
      })
      await load()
      if (res.message) setMessage(res.message)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not cancel it.')
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="space-y-5">
      <div className="page-header">
        <div>
          <h1 className="page-title">Job Work</h1>
          <p className="page-subtitle">Our fabric out at an outside unit, and what has come back</p>
        </div>
        <div className="flex items-center gap-2">
          <button className="btn-ghost" onClick={() => void load()} disabled={loading}>
            <RefreshCw size={15} className={loading ? 'animate-spin' : undefined} />
          </button>
          <button className="btn-primary" onClick={() => setSending(true)}>
            <Plus size={15} /> Send out
          </button>
        </div>
      </div>

      {error && (
        <div className="flex items-start gap-3 rounded-lg border border-red-500/40 bg-red-500/5 p-3">
          <AlertCircle size={16} className="mt-0.5 shrink-0 text-red-400" />
          <p className="text-sm text-red-400">{error}</p>
        </div>
      )}
      {message && (
        <div className="rounded-lg border border-emerald-500/40 bg-emerald-500/5 p-3">
          <p className="text-sm text-emerald-400">{message}</p>
        </div>
      )}

      <div className="glass-card overflow-hidden p-0">
        <div className="border-border flex flex-wrap items-center gap-3 border-b px-4 py-3">
          <div className="border-border bg-secondary flex min-w-[220px] max-w-sm flex-1 items-center gap-2 rounded-lg border px-3 py-2">
            <Search size={14} className="text-muted-foreground" />
            <input
              className="text-foreground placeholder:text-muted-foreground flex-1 border-0 bg-transparent text-sm outline-none"
              placeholder="Search challan, unit or process..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              aria-label="Search job work"
            />
          </div>
          <select
            className="form-input h-9 w-40"
            value={status}
            onChange={(e) => setStatus(e.target.value)}
            aria-label="Filter by status"
          >
            <option value="">All</option>
            <option value="SENT">Still out</option>
            <option value="PARTLY_BACK">Part back</option>
            <option value="CLOSED">All back</option>
            <option value="CANCELLED">Cancelled</option>
          </select>
          <span className="text-muted-foreground ml-auto text-xs">{total} challans</span>
        </div>

        {loading && rows.length === 0 ? (
          <p className="text-muted-foreground px-4 py-8 text-sm">Loading...</p>
        ) : rows.length === 0 ? (
          <div className="px-4 py-10 text-center">
            <p className="text-muted-foreground text-sm">
              Nothing out at the moment. When fabric goes to an outside unit for cutting, dyeing or
              stitching, send it out from here — it stays on the stock screen, at their store.
            </p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="data-table w-full">
              <thead>
                <tr>
                  <th style={{ width: 30 }} />
                  <th>Challan</th>
                  <th>Unit</th>
                  <th>Work</th>
                  <th>Sent</th>
                  <th>Due back</th>
                  <th style={{ textAlign: 'right' }}>Items</th>
                  <th>Status</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {rows.map((c) => {
                  const expanded = open === c.id
                  const s = stage(c)
                  const late =
                    c.expectedBackOn &&
                    c.status !== 'CLOSED' &&
                    c.status !== 'CANCELLED' &&
                    new Date(c.expectedBackOn) < new Date()

                  return (
                    <Fragment key={c.id}>
                      <tr>
                        <td>
                          <button
                            className="btn-ghost p-1"
                            onClick={() => setOpen(expanded ? null : c.id)}
                            aria-label={expanded ? 'Hide items' : 'Show items'}
                          >
                            {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                          </button>
                        </td>
                        <td className="font-mono text-xs text-teal-400">{c.challanNumber}</td>
                        <td className="text-sm">
                          {c.jobWorker.name}
                          <div className="text-muted-foreground flex items-center gap-1 text-[10px]">
                            {c.fromWarehouse.name}
                            <ArrowRight size={10} />
                            {c.toWarehouse.name}
                          </div>
                        </td>
                        <td className="text-xs">{c.process}</td>
                        <td className="text-xs">
                          {formatDate(c.challanDate)}
                          {c.sentBy && (
                            <div className="text-muted-foreground text-[10px]">
                              by {c.sentBy.name}
                            </div>
                          )}
                        </td>
                        <td className="text-xs">
                          {c.expectedBackOn ? (
                            <span className={late ? 'text-red-400' : undefined}>
                              {formatDate(c.expectedBackOn)}
                              {late && <div className="text-[10px]">overdue</div>}
                            </span>
                          ) : (
                            <span className="text-muted-foreground">—</span>
                          )}
                        </td>
                        <td className="text-right text-sm tabular-nums">{c.lines.length}</td>
                        <td>
                          <span className={s.cls}>{s.label}</span>
                          {c.cancelReason && (
                            <div className="text-muted-foreground max-w-[160px] truncate text-[10px]">
                              {c.cancelReason}
                            </div>
                          )}
                        </td>
                        <td className="whitespace-nowrap text-right">
                          <div className="flex justify-end gap-1">
                            {(c.status === 'SENT' || c.status === 'PARTLY_BACK') && (
                              <button
                                className="btn-ghost p-1.5 hover:text-teal-400"
                                onClick={() => setReceiving(c)}
                                title="Record what has come back"
                                aria-label={`Take back ${c.challanNumber}`}
                              >
                                <PackageCheck size={15} />
                              </button>
                            )}
                            {c.status === 'SENT' && c.returns.length === 0 && (
                              <button
                                className="btn-ghost p-1.5 hover:text-red-400"
                                onClick={() => void cancel(c)}
                                disabled={busy === c.id}
                                title="Cancel and bring the goods back"
                                aria-label={`Cancel ${c.challanNumber}`}
                              >
                                <Ban size={15} />
                              </button>
                            )}
                          </div>
                        </td>
                      </tr>

                      {expanded && (
                        <tr>
                          <td colSpan={9} className="bg-secondary/40 p-0">
                            <table className="data-table w-full">
                              <thead>
                                <tr>
                                  <th>Item</th>
                                  <th>HSN</th>
                                  <th style={{ textAlign: 'right' }}>Sent</th>
                                  <th style={{ textAlign: 'right' }}>Still out</th>
                                </tr>
                              </thead>
                              <tbody>
                                {c.lines.map((l) => {
                                  const out = outstandingOf(c, l)
                                  return (
                                    <tr key={l.id}>
                                      <td>
                                        <div className="text-sm">{l.item.name}</div>
                                        <div className="text-muted-foreground font-mono text-[10px]">
                                          {l.item.code}
                                        </div>
                                      </td>
                                      <td className="text-muted-foreground font-mono text-xs">
                                        {l.hsnCode ?? '—'}
                                      </td>
                                      <td className="text-right text-sm tabular-nums">
                                        {qty(l.qty)} {l.item.uom?.symbol ?? ''}
                                      </td>
                                      <td className="text-right text-sm tabular-nums">
                                        {out <= 0 ? (
                                          <span className="badge-success">all back</span>
                                        ) : (
                                          qty(out)
                                        )}
                                      </td>
                                    </tr>
                                  )
                                })}
                              </tbody>
                            </table>

                            {c.returns.length > 0 && (
                              <div className="border-border border-t px-4 py-2">
                                <p className="text-muted-foreground mb-1 text-[10px] uppercase tracking-wide">
                                  What has come back
                                </p>
                                {c.returns.map((r) => (
                                  <div key={r.id} className="py-1 text-xs">
                                    <span className="font-mono text-teal-400">
                                      {r.returnNumber}
                                    </span>
                                    <span className="text-muted-foreground">
                                      {' '}
                                      · {formatDate(r.returnDate)}
                                      {r.receivedBy ? ` · by ${r.receivedBy.name}` : ''}
                                    </span>
                                    {r.lines.map((rl) => (
                                      <div key={rl.id} className="text-muted-foreground pl-3">
                                        {qty(rl.consumedQty)} settled →{' '}
                                        <span className="text-foreground">
                                          {qty(rl.receivedQty)} {rl.item.uom?.symbol ?? ''}{' '}
                                          {rl.item.name}
                                        </span>{' '}
                                        into {rl.warehouse.name}
                                        {Number(rl.wastedQty) > 0 && (
                                          <span className="text-red-400">
                                            {' '}
                                            · {qty(rl.wastedQty)} wasted
                                          </span>
                                        )}
                                      </div>
                                    ))}
                                  </div>
                                ))}
                              </div>
                            )}

                            {(c.vehicleNo || c.lrNumber || c.notes) && (
                              <p className="text-muted-foreground px-4 py-2 text-xs">
                                {[c.vehicleNo, c.lrNumber, c.notes].filter(Boolean).join(' · ')}
                              </p>
                            )}
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {sending && (
        <SendJobWorkDialog
          onClose={() => setSending(false)}
          onSaved={(msg) => {
            setSending(false)
            setMessage(msg)
            void load()
          }}
        />
      )}

      {receiving && (
        <ReceiveJobWorkDialog
          challan={{
            id: receiving.id,
            challanNumber: receiving.challanNumber,
            process: receiving.process,
            jobWorker: receiving.jobWorker,
            fromWarehouse: receiving.fromWarehouse,
            lines: receiving.lines.map((l) => ({
              ...l,
              outstanding: outstandingOf(receiving, l),
            })),
          }}
          onClose={() => setReceiving(null)}
          onSaved={(msg) => {
            setReceiving(null)
            setMessage(msg)
            void load()
          }}
        />
      )}
    </div>
  )
}
