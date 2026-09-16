'use client'

import { Fragment, useCallback, useEffect, useState } from 'react'
import {
  Plus, Search, RefreshCw, AlertCircle, Check, X, PackageCheck, ChevronDown, ChevronRight,
} from 'lucide-react'
import { api, ApiError, currentUser, type Paginated } from '@/lib/api'
import { RequisitionDialog } from '@/components/inventory/RequisitionDialog'
import { formatDate } from '@/lib/utils'

/**
 * Material requisitions: asked for, allowed, handed over.
 *
 * Three states rather than two, because "approved" and "issued" are genuinely
 * different days in a mill. A requisition approved on Monday and still sitting
 * unissued on Thursday is a cutting room waiting, and lumping it in with the
 * ones already collected would hide that completely.
 */

interface Line {
  id: string
  requestedQty: string | number
  issuedQty: string | number
  purpose: string | null
  item: { id: string; code: string; name: string; uom: { symbol: string } }
  warehouse: { id: string; name: string }
}

interface Requisition {
  id: string
  mrNumber: string
  status: 'PENDING' | 'APPROVED' | 'REJECTED'
  requestDate: string
  requiredDate: string | null
  issuedAt: string | null
  rejectionReason: string | null
  notes: string | null
  department: { id: string; name: string }
  raisedBy: { id: string; name: string } | null
  approvedBy: { id: string; name: string } | null
  issuedBy: { id: string; name: string } | null
  lines: Line[]
}

const qtyFmt = (v: number) =>
  v.toLocaleString('en-IN', { minimumFractionDigits: 0, maximumFractionDigits: 3 })

/**
 * What this requisition is waiting for, and who has to do it.
 *
 * The status on its own was not enough. "Waiting for approval" is true, but it
 * leaves the person who raised it looking for a button that is deliberately not
 * there — so the stage now says whose move it is and where they make it.
 */
function stage(
  mr: Requisition,
  isMine: boolean
): { label: string; cls: string; next?: string } {
  if (mr.status === 'REJECTED') return { label: 'Refused', cls: 'badge-danger' }

  if (mr.status === 'PENDING') {
    return {
      label: 'Waiting for approval',
      cls: 'badge-warning',
      next: isMine
        ? 'You raised it, so somebody else has to approve it — on this screen or from the dashboard.'
        : 'Yours to approve or refuse.',
    }
  }

  if (!mr.issuedAt) {
    return {
      label: 'Approved — not collected',
      cls: 'badge-info',
      next: 'Nothing has moved yet. Press issue when the store hands the material over.',
    }
  }

  return { label: 'Issued', cls: 'badge-success' }
}

export default function RequisitionsPage() {
  const me = currentUser()

  const [rows, setRows] = useState<Requisition[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)

  const [search, setSearch] = useState('')
  const [debounced, setDebounced] = useState('')
  const [status, setStatus] = useState('')
  const [open, setOpen] = useState<string | null>(null)
  const [dialog, setDialog] = useState(false)

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
      const res = await api.get<Paginated<Requisition>>(`/inventory/requisitions?${qs}`)
      setRows(res.data)
      setTotal(res.pagination.total)
    } catch (err) {
      setError(
        err instanceof ApiError
          ? err.status === 403
            ? 'Your role does not allow viewing requisitions.'
            : err.message
          : 'Could not reach the server. Is the API running?',
      )
      setRows([])
    } finally {
      setLoading(false)
    }
  }, [debounced, status])

  useEffect(() => {
    void load()
  }, [load])

  const act = async (mr: Requisition, what: 'approve' | 'reject' | 'issue') => {
    let body: Record<string, unknown> = {}

    if (what === 'reject') {
      const reason = prompt(`Why is ${mr.mrNumber} being refused?`)
      if (!reason || reason.trim().length < 5) return
      body = { reason: reason.trim() }
    }
    if (what === 'issue' && !confirm(`Hand over the material on ${mr.mrNumber}? Stock leaves now.`)) {
      return
    }

    setBusy(mr.id)
    setError(null)
    setMessage(null)
    try {
      const res =
        what === 'issue'
          ? await api.post<{ message?: string }>(`/inventory/requisitions/${mr.id}/issue`, body)
          : await api.patch<{ message?: string }>(
              `/inventory/requisitions/${mr.id}/${what}`,
              body,
            )
      await load()
      if (res.message) setMessage(res.message)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save.')
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="space-y-5">
      <div className="page-header">
        <div>
          <h1 className="page-title">Material Requisitions</h1>
          <p className="page-subtitle">What the floor has asked the store for</p>
        </div>
        <div className="flex items-center gap-2">
          <button className="btn-ghost" onClick={() => void load()} disabled={loading}>
            <RefreshCw size={15} className={loading ? 'animate-spin' : undefined} />
          </button>
          <button className="btn-primary" onClick={() => setDialog(true)}>
            <Plus size={15} /> New requisition
          </button>
        </div>
      </div>

      {error && (
        <div className="flex items-start gap-3 p-3 rounded-lg border border-red-500/40 bg-red-500/5">
          <AlertCircle size={16} className="text-red-400 mt-0.5 shrink-0" />
          <p className="text-sm text-red-400">{error}</p>
        </div>
      )}
      {message && (
        <div className="p-3 rounded-lg border border-emerald-500/40 bg-emerald-500/5">
          <p className="text-sm text-emerald-400">{message}</p>
        </div>
      )}

      <div className="glass-card p-0 overflow-hidden">
        <div className="flex flex-wrap items-center gap-3 px-4 py-3 border-b border-border">
          <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-secondary border border-border flex-1 min-w-[220px] max-w-sm">
            <Search size={14} className="text-muted-foreground" />
            <input
              className="bg-transparent border-0 outline-none text-sm flex-1 text-foreground placeholder:text-muted-foreground"
              placeholder="Search number or department..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              aria-label="Search requisitions"
            />
          </div>
          <select
            className="form-input h-9 w-44"
            value={status}
            onChange={(e) => setStatus(e.target.value)}
            aria-label="Filter by status"
          >
            <option value="">All</option>
            <option value="PENDING">Waiting for approval</option>
            <option value="APPROVED">Approved</option>
            <option value="REJECTED">Refused</option>
          </select>
          <span className="text-xs text-muted-foreground ml-auto">{total} requisitions</span>
        </div>

        {loading && rows.length === 0 ? (
          <p className="px-4 py-8 text-sm text-muted-foreground">Loading...</p>
        ) : rows.length === 0 ? (
          <div className="px-4 py-10 text-center">
            <p className="text-sm text-muted-foreground">
              Nothing here. A requisition is how the cutting room asks the store for fabric.
            </p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="data-table w-full">
              <thead>
                <tr>
                  <th style={{ width: 30 }} />
                  <th>Number</th>
                  <th>Department</th>
                  <th>Raised</th>
                  <th style={{ textAlign: 'right' }}>Items</th>
                  <th>Stage</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {rows.map((mr) => {
                  const expanded = open === mr.id
                  // The server refuses this too; hiding the button just avoids
                  // offering somebody a door that is certain to be shut.
                  const isMine = Boolean(me?.id && mr.raisedBy?.id === me.id)
                  const s = stage(mr, isMine)

                  return (
                    <Fragment key={mr.id}>
                      <tr key={mr.id}>
                        <td>
                          <button
                            className="btn-ghost p-1"
                            onClick={() => setOpen(expanded ? null : mr.id)}
                            aria-label={expanded ? 'Hide items' : 'Show items'}
                          >
                            {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                          </button>
                        </td>
                        <td className="font-mono text-xs text-teal-400">{mr.mrNumber}</td>
                        <td className="text-sm">{mr.department.name}</td>
                        <td className="text-xs">
                          {formatDate(mr.requestDate)}
                          {mr.raisedBy && (
                            <div className="text-[10px] text-muted-foreground">
                              by {mr.raisedBy.name}
                            </div>
                          )}
                        </td>
                        <td className="text-right tabular-nums text-sm">{mr.lines.length}</td>
                        <td>
                          <span className={s.cls}>{s.label}</span>
                          {mr.status === 'REJECTED' && mr.rejectionReason && (
                            <div className="text-[10px] text-muted-foreground max-w-[200px] truncate">
                              {mr.rejectionReason}
                            </div>
                          )}
                          {s.next && (
                            <div className="mt-1 max-w-[240px] text-[10px] text-muted-foreground">
                              {s.next}
                            </div>
                          )}
                        </td>
                        <td className="text-right whitespace-nowrap">
                          <div className="flex justify-end gap-1">
                            {mr.status === 'PENDING' && !isMine && (
                              <>
                                <button
                                  className="btn-ghost p-1.5 hover:text-emerald-400"
                                  onClick={() => void act(mr, 'approve')}
                                  disabled={busy === mr.id}
                                  title="Approve"
                                  aria-label={`Approve ${mr.mrNumber}`}
                                >
                                  <Check size={15} />
                                </button>
                                <button
                                  className="btn-ghost p-1.5 hover:text-red-400"
                                  onClick={() => void act(mr, 'reject')}
                                  disabled={busy === mr.id}
                                  title="Refuse"
                                  aria-label={`Refuse ${mr.mrNumber}`}
                                >
                                  <X size={15} />
                                </button>
                              </>
                            )}
                            {mr.status === 'APPROVED' && !mr.issuedAt && (
                              <button
                                className="btn-ghost p-1.5 hover:text-teal-400"
                                onClick={() => void act(mr, 'issue')}
                                disabled={busy === mr.id}
                                title="Hand the material over"
                                aria-label={`Issue ${mr.mrNumber}`}
                              >
                                <PackageCheck size={15} />
                              </button>
                            )}
                          </div>
                        </td>
                      </tr>

                      {expanded && (
                        <tr key={`${mr.id}-lines`}>
                          <td colSpan={7} className="bg-secondary/40">
                            <div className="px-4 py-3 space-y-2">
                              {mr.lines.map((l) => (
                                <div
                                  key={l.id}
                                  className="flex flex-wrap items-baseline justify-between gap-3 text-sm"
                                >
                                  <div>
                                    <span className="text-foreground">{l.item.name}</span>
                                    <span className="ml-2 text-[10px] text-muted-foreground font-mono">
                                      {l.item.code} · from {l.warehouse.name}
                                    </span>
                                    {l.purpose && (
                                      <div className="text-[11px] text-muted-foreground">
                                        {l.purpose}
                                      </div>
                                    )}
                                  </div>
                                  <div className="tabular-nums text-xs">
                                    asked {qtyFmt(Number(l.requestedQty))} {l.item.uom.symbol}
                                    {Number(l.issuedQty) > 0 && (
                                      <span className="ml-2 text-emerald-400">
                                        issued {qtyFmt(Number(l.issuedQty))}
                                      </span>
                                    )}
                                  </div>
                                </div>
                              ))}

                              <div className="pt-2 border-t border-border text-[11px] text-muted-foreground">
                                {mr.approvedBy && <>Approved by {mr.approvedBy.name}. </>}
                                {mr.issuedBy && mr.issuedAt && (
                                  <>
                                    Handed over by {mr.issuedBy.name} on{' '}
                                    {formatDate(mr.issuedAt)}.
                                  </>
                                )}
                                {mr.notes && <div className="mt-1">{mr.notes}</div>}
                              </div>
                            </div>
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

      {dialog && (
        <RequisitionDialog
          onClose={() => setDialog(false)}
          onSaved={(msg) => {
            setDialog(false)
            setMessage(msg)
            void load()
          }}
        />
      )}
    </div>
  )
}
