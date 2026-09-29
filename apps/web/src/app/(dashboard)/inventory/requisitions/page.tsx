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
  /** Off the rack, or to be bought. Absent on rows written before the choice
      existed, which all meant the rack. */
  fulfilment?: 'FROM_STOCK' | 'PURCHASE'
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
  isMine: boolean,
  iApproved = false
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
      // Raised, approved and issued by three different people, so the two
      // who have had their say are told it is somebody else's turn.
      next: isMine
        ? 'You raised it, so somebody else in the store hands the material over.'
        : iApproved
          ? 'You approved it, so somebody else in the store hands the material over.'
          : 'Nothing has moved yet. Press issue when the store hands the material over.',
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

  /*
   * What the store actually has, per line of the requisition that is open.
   *
   * Fetched when a row is expanded rather than with the list: it is a balance
   * per item per warehouse, and working out forty of them to draw a list
   * nobody has opened is forty queries thrown away.
   */
  const [onHand, setOnHand] = useState<Record<string, number>>({})
  const [loadingStock, setLoadingStock] = useState(false)

  /** The store keeper's answer per line, before it is saved. */
  const [sourcing, setSourcing] = useState<Record<string, 'FROM_STOCK' | 'PURCHASE'>>({})
  const [savingSourcing, setSavingSourcing] = useState(false)

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

  /*
   * Opening an approved requisition loads what is on the rack beside it.
   *
   * The mill's old ERP shows a Stock Qty column on its indent form for exactly
   * this reason: deciding whether something has to be bought without being
   * told how much there is of it is guessing.
   */
  useEffect(() => {
    const mr = rows.find((r) => r.id === open)
    if (!mr || mr.status !== 'APPROVED' || mr.issuedAt) {
      setOnHand({})
      return
    }

    let cancelled = false
    setLoadingStock(true)
    void (async () => {
      try {
        const res = await api.get<{
          data: { available?: Array<{ lineId: string; available: number }> }
        }>(`/inventory/requisitions/${mr.id}`)
        if (cancelled) return
        const avail = (res as unknown as { data: { available?: Array<{ lineId: string; available: number }> } })
          .data?.available
        setOnHand(Object.fromEntries((avail ?? []).map((a) => [a.lineId, Number(a.available)])))
      } catch {
        if (!cancelled) setOnHand({})
      } finally {
        if (!cancelled) setLoadingStock(false)
      }
    })()

    // Start from what is already recorded, so reopening a row shows the
    // answers given last time rather than resetting them to the rack.
    setSourcing(
      Object.fromEntries(mr.lines.map((l) => [l.id, l.fulfilment ?? 'FROM_STOCK'])) as Record<
        string,
        'FROM_STOCK' | 'PURCHASE'
      >
    )

    return () => {
      cancelled = true
    }
  }, [open, rows])

  /** Saves the store's answer for every line of one requisition. */
  const saveSourcing = async (mr: Requisition) => {
    setSavingSourcing(true)
    setError(null)
    setMessage(null)
    try {
      const res = await api.patch<{ message?: string }>(
        `/inventory/requisitions/${mr.id}/sourcing`,
        { lines: mr.lines.map((l) => ({ lineId: l.id, fulfilment: sourcing[l.id] ?? 'FROM_STOCK' })) }
      )
      await load()
      if (res.message) setMessage(res.message)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save what the store decided.')
    } finally {
      setSavingSourcing(false)
    }
  }

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
                  const iApproved = Boolean(me?.id && mr.approvedBy?.id === me.id)
                  const s = stage(mr, isMine, iApproved)

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
                            {mr.status === 'APPROVED' && !mr.issuedAt && !isMine && !iApproved && (
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
                              {/* ── What the store can answer ──────────────

                                Only on an approved requisition that has not
                                been issued, because that is the moment the
                                question is live: before approval it may yet be
                                refused, and after issue the stock has moved.

                                The mill's old ERP asks it here too — on
                                *Approved Material Requisition*, with Issue Raw
                                Material and Create Indent side by side — and
                                that is the right screen for it. Whoever raised
                                the requisition is asking for material; they
                                cannot know what is on the rack. The store
                                keeper can, and the figure is beside every line
                                while they decide. */}
                              {mr.status === 'APPROVED' && !mr.issuedAt && (
                                <div className="border-border bg-card mb-3 rounded-lg border">
                                  <div className="border-border flex flex-wrap items-center gap-2 border-b px-3 py-2">
                                    <h4 className="text-foreground text-xs font-semibold">
                                      What the store can give
                                    </h4>
                                    <span className="text-muted-foreground text-[11px]">
                                      {loadingStock
                                        ? 'checking the rack…'
                                        : 'Anything the store has not got goes to the buyer.'}
                                    </span>
                                    <button
                                      className="btn-primary ml-auto h-7 px-2.5 text-xs disabled:opacity-50"
                                      onClick={() => void saveSourcing(mr)}
                                      disabled={savingSourcing}
                                    >
                                      {savingSourcing ? 'Saving…' : 'Save'}
                                    </button>
                                  </div>
                                  <table className="w-full text-sm">
                                    <thead>
                                      <tr className="bg-secondary border-border border-b">
                                        <th className="text-muted-foreground px-3 py-1.5 text-left text-[10px] font-semibold uppercase tracking-wider">
                                          Item
                                        </th>
                                        <th className="text-muted-foreground px-3 py-1.5 text-right text-[10px] font-semibold uppercase tracking-wider">
                                          Asked
                                        </th>
                                        <th className="text-muted-foreground px-3 py-1.5 text-right text-[10px] font-semibold uppercase tracking-wider">
                                          In store
                                        </th>
                                        <th className="text-muted-foreground px-3 py-1.5 text-left text-[10px] font-semibold uppercase tracking-wider">
                                          Answer it from
                                        </th>
                                      </tr>
                                    </thead>
                                    <tbody>
                                      {mr.lines.map((l) => {
                                        const have = onHand[l.id]
                                        const asked = Number(l.requestedQty)
                                        const short = have !== undefined && have < asked
                                        const pick = sourcing[l.id] ?? l.fulfilment ?? 'FROM_STOCK'
                                        return (
                                          <tr
                                            key={l.id}
                                            className="border-border/40 border-b last:border-0"
                                          >
                                            <td className="text-foreground px-3 py-1.5 text-xs">
                                              {l.item.name}
                                              <span className="text-muted-foreground ml-2 font-mono text-[10px]">
                                                {l.item.code}
                                              </span>
                                            </td>
                                            <td className="text-foreground px-3 py-1.5 text-right text-xs tabular-nums">
                                              {qtyFmt(asked)} {l.item.uom.symbol}
                                            </td>
                                            {/* Red when there is not enough, which
                                              is the only number on this row that
                                              decides anything. */}
                                            <td
                                              className={`px-3 py-1.5 text-right text-xs tabular-nums ${
                                                short ? 'text-red-400' : 'text-foreground'
                                              }`}
                                            >
                                              {have === undefined ? '—' : qtyFmt(have)}
                                            </td>
                                            <td className="px-3 py-1.5">
                                              <select
                                                className="form-input h-7 w-40 px-2 py-0 text-xs"
                                                value={pick}
                                                onChange={(e) =>
                                                  setSourcing((prev) => ({
                                                    ...prev,
                                                    [l.id]: e.target.value as
                                                      | 'FROM_STOCK'
                                                      | 'PURCHASE',
                                                  }))
                                                }
                                                aria-label={`How to answer ${l.item.name}`}
                                              >
                                                <option value="FROM_STOCK">Issue from store</option>
                                                <option value="PURCHASE">Buy it</option>
                                              </select>
                                            </td>
                                          </tr>
                                        )
                                      })}
                                    </tbody>
                                  </table>
                                </div>
                              )}

                              {mr.lines.map((l) => (
                                <div
                                  key={l.id}
                                  className="flex flex-wrap items-baseline justify-between gap-3 text-sm"
                                >
                                  <div>
                                    <span className="text-foreground">{l.item.name}</span>
                                    <span className="ml-2 text-[10px] text-muted-foreground font-mono">
                                      {l.item.code} ·{' '}
                                      {l.fulfilment === 'PURCHASE'
                                        ? 'to be bought'
                                        : `from ${l.warehouse.name}`}
                                    </span>
                                    {/* A line the store cannot answer. Said here
                                      so whoever issues the requisition is not
                                      left hunting a rack for something that was
                                      never on it. */}
                                    {l.fulfilment === 'PURCHASE' && (
                                      <span className="badge-info ml-2">Purchase</span>
                                    )}
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
