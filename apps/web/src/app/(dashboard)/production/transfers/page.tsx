'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { AlertCircle, ArrowRight, Ban, ClipboardCheck, ExternalLink, Plus, Printer, RefreshCw, Scale, Search, Shuffle } from 'lucide-react'
import { api, ApiError, can, type Paginated } from '@/lib/api'
import { formatDate } from '@/lib/utils'
import { useAppSettings } from '@/lib/appSettings'
import { Pagination } from '@/components/tables/Pagination'
import { ReasonDialog } from '@/components/ui/ReasonDialog'
import { CountInDialog } from '@/components/production/floor/CountInDialog'
import { SettleDialog } from '@/components/production/floor/SettleDialog'
import { NewTransferDialog } from '@/components/production/floor/NewTransferDialog'
import { TransferDetailDialog, type TransferRow } from '@/components/production/floor/TransferDetailDialog'
import { transferStatus } from '@/components/production/floor/transferStatus'
import { RedirectDialog } from '@/components/production/floor/RedirectDialog'
import { pcs, sheetHref, type FlowTransfer } from '@/components/production/floor/types'

/**
 * Process transfers: every handover of a job card's bundles from one
 * department to the next — on our floor, counted in where it arrives, or out
 * to a unit on a job-work challan, back when the unit returns the pieces.
 * Tabs for what needs doing (to count in, short, at outside units) and what
 * is done; each row says in words where the transfer stands and has the one
 * button it needs.
 */

type View = 'count' | 'short' | 'units' | 'received' | 'all'
const VIEWS: Array<{ key: View; label: string; empty: string }> = [
  { key: 'count', label: 'To count in', empty: 'Nothing is waiting to be counted in. Transfers sent from one department to the next show here until the receiving department counts them in.' },
  { key: 'short', label: 'Short', empty: 'No transfer is short. One that arrived with fewer pieces than were sent shows here until it is settled.' },
  { key: 'units', label: 'At outside units', empty: 'Nothing is with an outside unit.' },
  { key: 'received', label: 'Received', empty: 'Nothing received yet.' },
  { key: 'all', label: 'All', empty: 'No transfers yet. One is made each time a department sends a job card’s bundles on.' },
]

export default function TransfersPage() {
  const { rowsPerPage } = useAppSettings()
  const [rows, setRows] = useState<TransferRow[]>([])
  const [total, setTotal] = useState(0)
  const [counts, setCounts] = useState<Record<View, number> | null>(null)
  const [view, setView] = useState<View | null>(null)
  const [page, setPage] = useState(1)
  const [search, setSearch] = useState('')
  const [debounced, setDebounced] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [detail, setDetail] = useState<TransferRow | null>(null)
  const [counting, setCounting] = useState<TransferRow | null>(null)
  const [settling, setSettling] = useState<TransferRow | null>(null)
  const [cancelling, setCancelling] = useState<TransferRow | null>(null)
  // Sent but not counted in: it can still go to another step.
  const [redirecting, setRedirecting] = useState<TransferRow | null>(null)
  const [creating, setCreating] = useState(false)
  const [busy, setBusy] = useState(false)
  const latest = useRef(0)

  useEffect(() => {
    const t = setTimeout(() => setDebounced(search), 350)
    return () => clearTimeout(t)
  }, [search])
  useEffect(() => setPage(1), [debounced, view])

  const loadCounts = useCallback(async () => {
    try {
      const res = await api.get<{ data: Record<View, number> }>('/production/transfers/counts')
      setCounts(res.data)
      // Open on what needs doing first.
      setView((v) => v ?? (res.data.count ? 'count' : res.data.short ? 'short' : res.data.units ? 'units' : 'all'))
    } catch {
      setView((v) => v ?? 'all')
    }
  }, [])

  const load = useCallback(async () => {
    if (!view) return
    const ticket = ++latest.current
    setLoading(true)
    setError(null)
    try {
      const qs = new URLSearchParams({ page: String(page), limit: String(rowsPerPage) })
      if (view !== 'all') qs.set('view', view)
      if (debounced) qs.set('q', debounced)
      const res = await api.get<Paginated<TransferRow>>(`/production/transfers?${qs}`)
      if (ticket !== latest.current) return
      setRows(res.data)
      setTotal(res.pagination.total)
    } catch (err) {
      if (ticket === latest.current) setError(err instanceof ApiError ? err.message : 'Could not load the process transfers.')
    } finally {
      if (ticket === latest.current) setLoading(false)
    }
  }, [page, rowsPerPage, view, debounced])

  useEffect(() => {
    void loadCounts()
  }, [loadCounts])
  useEffect(() => {
    void load()
  }, [load])

  const saved = (m: string) => {
    setCounting(null)
    setSettling(null)
    setCreating(false)
    setDetail(null)
    setMessage(m)
    void load()
    void loadCounts()
  }
  const cancel = async (t: TransferRow, reason: string) => {
    setBusy(true)
    try {
      const res = await api.post<{ message?: string }>(`/production/transfers/${t.id}/cancel`, { reason })
      setCancelling(null)
      saved(res.message ?? 'Cancelled.')
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not cancel it.')
      setCancelling(null)
    } finally {
      setBusy(false)
    }
  }
  const print = (t: TransferRow) => window.open(`/print/transfer/${t.id}`, '_blank', 'noopener')

  /** The one thing a transfer needs next, as a button. */
  const actionOf = (t: TransferRow) => {
    if (!t.vendor && (t.status === 'DISPATCHED' || t.status === 'PARTLY_RECEIVED') && can('production', 'create')) {
      return (
        <button type="button" className="btn-primary h-8 px-3 text-xs" onClick={() => setCounting(t)}>
          <ClipboardCheck size={14} /> Count in
        </button>
      )
    }
    if (t.status === 'DISCREPANCY' && can('production', 'edit')) {
      return (
        <button type="button" className="btn-primary h-8 px-3 text-xs" onClick={() => setSettling(t)}>
          <Scale size={14} /> Settle
        </button>
      )
    }
    if (t.vendor && (t.status === 'DISPATCHED' || t.status === 'PARTLY_RECEIVED') && t.jobCard) {
      return (
        <a className="btn-secondary h-8 px-3 text-xs" href={sheetHref(t.jobCard.id, t.toStep.id)} title="Record what came back, on the stage's sheet">
          <ExternalLink size={14} /> Record return
        </a>
      )
    }
    return null
  }

  const current = VIEWS.find((v) => v.key === view) ?? VIEWS[4]
  return (
    <div className="space-y-4">
      <div className="page-header">
        <div>
          <h1 className="page-title text-xl sm:text-2xl">Process Transfers</h1>
          <p className="page-subtitle hidden sm:block">Bundles handed from one department to the next — counted in where they arrive, or out to an outside unit and back</p>
        </div>
        <div className="flex items-center gap-2">
          <button
            className="btn-ghost"
            onClick={() => {
              void load()
              void loadCounts()
            }}
            disabled={loading}
            aria-label="Refresh"
          >
            <RefreshCw size={15} className={loading ? 'animate-spin' : undefined} />
          </button>
          {can('production', 'create') && (
            <button className="btn-primary" onClick={() => setCreating(true)}>
              <Plus size={15} /> New transfer
            </button>
          )}
        </div>
      </div>

      {error && (
        <div className="border-destructive/40 bg-destructive/5 flex items-start gap-3 rounded-lg border p-3">
          <AlertCircle size={16} className="text-destructive mt-0.5 shrink-0" />
          <p className="text-destructive text-sm">{error}</p>
        </div>
      )}
      {message && (
        <div className="border-primary/40 bg-primary/5 rounded-lg border p-3">
          <p className="text-primary text-sm">{message}</p>
        </div>
      )}

      <div className="glass-card overflow-hidden p-0">
        {/* Tabs: what needs doing first, then what is done. */}
        <div className="border-border flex gap-1 overflow-x-auto border-b px-2 pt-2" role="tablist">
          {VIEWS.map((v) => {
            const on = v.key === view
            const n = counts?.[v.key]
            const urgent = (v.key === 'count' || v.key === 'short') && !!n
            return (
              <button
                key={v.key}
                type="button"
                role="tab"
                aria-selected={on}
                onClick={() => setView(v.key)}
                className={`-mb-px flex shrink-0 items-center gap-2 border-b-2 px-3 py-2 text-sm ${on ? 'border-primary text-primary font-semibold' : 'text-muted-foreground hover:text-foreground border-transparent'}`}
              >
                {v.label}
                {n != null && (
                  <span
                    className={`rounded-full px-1.5 text-[11px] font-semibold tabular-nums ${urgent ? (v.key === 'short' ? 'bg-destructive text-white' : 'bg-primary text-primary-foreground') : 'bg-secondary text-foreground'}`}
                  >
                    {n}
                  </span>
                )}
              </button>
            )
          })}
        </div>

        <div className="border-border flex flex-wrap items-center gap-2 border-b px-4 py-3">
          <div className="bg-field border-field-edge flex min-w-[200px] max-w-md flex-1 items-center gap-2 rounded-lg border px-3 py-1.5">
            <Search size={14} className="text-muted-foreground" />
            <input
              className="text-foreground placeholder:text-muted-foreground flex-1 border-0 bg-transparent text-sm outline-none"
              placeholder="Search transfer no., job card, order, bundle, department or unit…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              aria-label="Search"
            />
          </div>
          <span className="text-muted-foreground ml-auto text-xs">
            {total} {total === 1 ? 'transfer' : 'transfers'}
          </span>
        </div>

        {loading && !rows.length ? (
          <div className="space-y-2 p-4">
            {[0, 1, 2].map((i) => (
              <div key={i} className="skeleton h-14 w-full rounded-lg" />
            ))}
          </div>
        ) : !rows.length ? (
          <p className="text-muted-foreground px-4 py-10 text-center text-sm">{debounced ? 'Nothing matches that search.' : current.empty}</p>
        ) : (
          <>
            {/* Wide screens: a table. */}
            <div className="hidden overflow-x-auto md:block">
              <table className="data-table w-full">
                <thead>
                  <tr className="bg-secondary">
                    <th>Transfer</th>
                    <th>Job card</th>
                    <th>From → to</th>
                    <th style={{ textAlign: 'right' }}>Pieces</th>
                    <th>Status</th>
                    <th style={{ textAlign: 'right' }}>Action</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((t) => {
                    const st = transferStatus(t)
                    const sent = t.lines.reduce((s, l) => s + l.dispatchedQty, 0)
                    const got = t.lines.reduce((s, l) => s + l.receivedQty, 0)
                    const short = t.lines.reduce((s, l) => s + l.shortQty - l.settledQty, 0)
                    return (
                      <tr key={t.id} className={`cursor-pointer ${t.status === 'CANCELLED' ? 'opacity-60' : ''}`} onClick={() => setDetail(t)}>
                        <td>
                          <span className="text-foreground font-mono text-xs font-semibold">{t.transferNumber}</span>
                          <span className="text-muted-foreground block text-[11px]">
                            {formatDate(t.dispatchDate)}
                            {t.issuedBy ? ` · by ${t.issuedBy}` : ''}
                          </span>
                        </td>
                        <td>
                          <span className="text-primary font-mono text-xs">{t.jobCard?.jobCardNumber ?? t.mo.moNumber}</span>
                          <span className="text-muted-foreground block text-[11px]">
                            {t.jobCard ? `${t.jobCard.moLine.style.code} · ${t.jobCard.moLine.color}` : ''}
                            {t.mo.so ? ` · ${t.mo.so.customer.name}` : ''}
                          </span>
                        </td>
                        <td className="text-xs">
                          <span className="flex flex-wrap items-center gap-1.5">
                            <span className="text-foreground font-medium">{t.fromStep.name}</span>
                            <ArrowRight size={12} className="text-muted-foreground" />
                            <span className="text-foreground font-medium">{t.toStep.name}</span>
                          </span>
                          {t.vendor && <span className="text-muted-foreground block text-[11px]">at {t.vendor.name} (outside unit)</span>}
                        </td>
                        <td className="text-right text-xs tabular-nums">
                          <span className="text-foreground font-semibold">{pcs(sent)}</span>
                          <span className="text-muted-foreground"> in {t.lines.length}</span>
                          {(got > 0 || short > 0) && (
                            <span className={`block text-[11px] ${short ? 'text-destructive' : 'text-muted-foreground'}`}>
                              {short ? `${pcs(short)} short` : `${pcs(got)} ${t.vendor ? 'back' : 'counted in'}`}
                            </span>
                          )}
                        </td>
                        <td>
                          <span className={st.cls}>{st.label}</span>
                        </td>
                        <td onClick={(e) => e.stopPropagation()}>
                          <span className="flex items-center justify-end gap-1">
                            {actionOf(t)}
                            <button type="button" className="btn-ghost h-8 px-2 text-xs" onClick={() => print(t)} aria-label={`Print ${t.transferNumber}`} title="Print the card">
                              <Printer size={14} />
                            </button>
                            {can('production', 'edit') && t.status === 'DISPATCHED' && !got && !t.vendor && (
                              <button type="button" className="btn-ghost h-8 px-2 text-xs" onClick={() => setRedirecting(t)} title="Not counted in yet: send it to another step instead">
                                <Shuffle size={14} /> Change where it goes
                              </button>
                            )}
                            {can('production', 'edit') && t.status === 'DISPATCHED' && !got && (
                              <button type="button" className="btn-ghost text-muted-foreground hover:text-destructive h-8 px-2" onClick={() => setCancelling(t)} aria-label={`Cancel ${t.transferNumber}`} title="Cancel">
                                <Ban size={14} />
                              </button>
                            )}
                          </span>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>

            {/* Phones: a card each. */}
            <div className="divide-border/60 divide-y md:hidden">
              {rows.map((t) => {
                const st = transferStatus(t)
                const sent = t.lines.reduce((s, l) => s + l.dispatchedQty, 0)
                return (
                  <div key={t.id} className={`space-y-1.5 px-4 py-3 ${t.status === 'CANCELLED' ? 'opacity-60' : ''}`} onClick={() => setDetail(t)}>
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-mono text-xs font-semibold">{t.transferNumber}</span>
                      <span className={st.cls}>{st.label}</span>
                    </div>
                    <p className="flex flex-wrap items-center gap-1.5 text-sm">
                      <span className="font-medium">{t.fromStep.name}</span> <ArrowRight size={12} /> <span className="font-medium">{t.toStep.name}</span>
                      {t.vendor && <span className="text-muted-foreground text-xs">at {t.vendor.name}</span>}
                    </p>
                    <p className="text-muted-foreground text-xs">
                      {t.jobCard ? `${t.jobCard.jobCardNumber} · ${t.jobCard.moLine.style.code} ${t.jobCard.moLine.color}` : t.mo.moNumber} · {pcs(sent)} pcs · {formatDate(t.dispatchDate)}
                    </p>
                    <div className="flex flex-wrap items-center gap-1" onClick={(e) => e.stopPropagation()}>
                      {actionOf(t)}
                      <button type="button" className="btn-ghost h-8 px-2 text-xs" onClick={() => print(t)}>
                        <Printer size={14} /> Print
                      </button>
                      {can('production', 'edit') && t.status === 'DISPATCHED' && !t.vendor && !t.lines.some((l) => l.receivedQty > 0) && (
                        <button type="button" className="btn-ghost h-8 px-2 text-xs" onClick={() => setRedirecting(t)}>
                          <Shuffle size={14} /> Change where it goes
                        </button>
                      )}
                    </div>
                  </div>
                )
              })}
            </div>
          </>
        )}
        <Pagination page={page} pages={Math.ceil(total / rowsPerPage) || 1} onPageChange={setPage} busy={loading} />
      </div>

      {detail && (
        <TransferDetailDialog
          t={detail}
          onClose={() => setDetail(null)}
          onCountIn={() => {
            setCounting(detail)
            setDetail(null)
          }}
          onSettle={() => {
            setSettling(detail)
            setDetail(null)
          }}
        />
      )}
      {counting && <CountInDialog transfer={counting as unknown as FlowTransfer} moNumber={counting.mo.moNumber} onClose={() => setCounting(null)} onSaved={saved} />}
      {settling && <SettleDialog transfer={settling as unknown as FlowTransfer} onClose={() => setSettling(null)} onSaved={saved} />}
      {creating && (
        <NewTransferDialog
          onClose={() => setCreating(false)}
          onSaved={(m, transferId) => {
            saved(m)
            window.open(`/print/transfer/${transferId}`, '_blank', 'noopener')
          }}
        />
      )}
      {redirecting && (
        <RedirectDialog
          transfer={redirecting}
          onClose={() => setRedirecting(null)}
          onDone={(m) => {
            setRedirecting(null)
            saved(m)
          }}
        />
      )}
      {cancelling && (
        <ReasonDialog
          title={`Cancel ${cancelling.transferNumber}?`}
          description="Nobody has counted it in, so the pieces go back to the department that sent them."
          confirmLabel="Cancel the transfer"
          danger
          busy={busy}
          onCancel={() => setCancelling(null)}
          onConfirm={(reason) => void cancel(cancelling, reason)}
        />
      )}
    </div>
  )
}
