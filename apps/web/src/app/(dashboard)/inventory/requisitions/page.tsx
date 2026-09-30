'use client'

import { Fragment, useCallback, useEffect, useState } from 'react'
import {
  Plus, Search, RefreshCw, AlertCircle, Check, X, PackageCheck, ChevronDown, ChevronRight, Ban, Printer, FileText,
} from 'lucide-react'
import { api, ApiError, can, currentUser, type Paginated } from '@/lib/api'
import { RequisitionDialog } from '@/components/inventory/RequisitionDialog'
import { FulfilDialog } from '@/components/inventory/FulfilDialog'
import { ReasonDialog } from '@/components/ui/ReasonDialog'
import { RowPanel } from '@/components/tables/RowPanel'
import { ScrollableTable } from '@/components/tables/ScrollableTable'
import { ActionMenu, type RowAction } from '@/components/tables/ActionMenu'
import { formatDate, itemsPreview } from '@/lib/utils'

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
  /** How much of the line the store decided to buy. Null on lines decided before it could be set. */
  purchaseQty?: string | number | null
  purpose: string | null
  item: {
    id: string
    code: string
    name: string
    uom: { symbol: string }
    category?: { name: string; parent: { name: string } | null } | null
  }
  warehouse: { id: string; name: string }
  ownership?: 'OWNED' | 'CUSTOMER_OWNED'
  ownerCustomer?: { id: string; name: string } | null
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
  /** Cancelled, or closed with part still owed: nothing more is issued. */
  closedAt: string | null
  closeReason: string | null
  closedBy: { id: string; name: string } | null
  lines: Line[]
}

/** Something from the store is still owed on it, and some has been handed over. */
const partlyIssued = (mr: Requisition) =>
  mr.lines.some((l) => Number(l.issuedQty) > 0) &&
  mr.lines.some((l) => Number(l.issuedQty) < Number(l.requestedQty))

/** How much of a line is to be bought; the whole line where it was marked before a quantity could be set. */
const buyQtyOf = (l: Line) =>
  l.purchaseQty !== null && l.purchaseQty !== undefined ? Number(l.purchaseQty) : l.fulfilment === 'PURCHASE' ? Number(l.requestedQty) : 0

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
  iApproved = false,
  admin = false
): { label: string; cls: string; next?: string } {
  if (mr.closedAt) {
    const some = mr.lines.some((l) => Number(l.issuedQty) > 0)
    return {
      label: some ? 'Closed — part issued' : 'Cancelled',
      cls: 'badge-neutral',
      next: `${mr.closeReason ?? ''}${mr.closedBy ? ` — ${mr.closedBy.name}` : ''}`,
    }
  }
  if (mr.status === 'REJECTED') return { label: 'Refused', cls: 'badge-danger' }

  if (mr.status === 'PENDING') {
    return {
      label: 'Waiting for approval',
      cls: 'badge-warning',
      next: isMine
        ? admin
          ? 'You raised it. As admin you can approve it yourself, or leave it for someone else.'
          : 'You raised it, so somebody else has to approve it — on this screen or from the dashboard.'
        : 'Yours to approve or refuse.',
    }
  }

  if (!mr.issuedAt && partlyIssued(mr)) {
    const full = mr.lines.filter((l) => Number(l.issuedQty) >= Number(l.requestedQty)).length
    return {
      label: 'Part issued',
      cls: 'badge-warning',
      next: `${full} of ${mr.lines.length} ${mr.lines.length === 1 ? 'line' : 'lines'} handed over in full. Press Fulfil to hand over the rest, or close it if it is no longer wanted.`,
    }
  }

  if (!mr.issuedAt) {
    return {
      label: 'To be issued',
      cls: 'badge-info',
      // Raised, approved and issued by three different people (the Admin may
      // do all three), so the two who have had their say are told whose turn it is.
      next:
        (isMine || iApproved) && !admin
          ? `You ${isMine ? 'raised' : 'approved'} it, so somebody else in the store hands it over. You can still press Fulfil to set what to buy.`
          : 'Press Fulfil to hand it over from the stores that have it, and to buy what is short.',
    }
  }

  return { label: 'Issued', cls: 'badge-success' }
}

/**
 * Asked, issued and still owed, per unit. Metres and pieces are never added
 * together; a requisition for both shows both. Lines to be bought are owed by
 * the buyer, not the store, so they are counted apart.
 */
function qtyByUnit(lines: Line[]) {
  const m = new Map<string, { uom: string; asked: number; issued: number; owed: number; toBuy: number }>()
  for (const l of lines) {
    const u = l.item.uom.symbol
    const cur = m.get(u) ?? { uom: u, asked: 0, issued: 0, owed: 0, toBuy: 0 }
    const asked = Number(l.requestedQty)
    const issued = Number(l.issuedQty)
    cur.asked += asked
    cur.issued += issued
    cur.owed += Math.max(0, asked - issued)
    cur.toBuy += buyQtyOf(l)
    m.set(u, cur)
  }
  return [...m.values()]
}

type UnitGroup = ReturnType<typeof qtyByUnit>[number]

/** The item panel's columns, as shares of the row, so the table fits the panel it opens in. */
const ITEM_COLS = [
  { label: 'Code', width: '10%' },
  { label: 'Item', width: '20%' },
  { label: 'Category', width: '10%' },
  { label: 'Sub-cat.', width: '10%' },
  { label: 'Whose', width: '8%' },
  { label: 'Asked of', width: '10%' },
  { label: 'What for', width: '10%' },
  { label: 'To buy', width: '6%', numeric: true },
  { label: 'Asked', width: '7%', numeric: true },
  { label: 'Issued', width: '6%', numeric: true },
  { label: 'Owed', width: '5%', numeric: true },
]
/** One figure per unit on one line: "1,000 mtr · 250 pcs", or null when all are nil. */
const unitLine = (groups: UnitGroup[], pick: (g: UnitGroup) => number) => {
  const parts = groups
    .map((g) => ({ uom: g.uom, v: pick(g) }))
    .filter((g) => g.v > 0)
    .map((g) => `${qtyFmt(g.v)} ${g.uom}`)
  return parts.length ? parts.join(' · ') : null
}

export default function RequisitionsPage() {
  const me = currentUser()
  // The Admin may approve a requisition they raised themselves; the server says the same.
  const admin = me?.role === 'Admin'

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
  // The requisition being handed over, and the one a reason is being asked for.
  const [fulfilling, setFulfilling] = useState<Requisition | null>(null)
  const [asking, setAsking] = useState<{ mr: Requisition; kind: 'reject' | 'close' } | null>(null)

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

  const act = async (mr: Requisition, what: 'approve' | 'reject' | 'close', reason?: string) => {
    setBusy(mr.id)
    setError(null)
    setMessage(null)
    try {
      const res =
        what === 'close'
          ? await api.post<{ message?: string }>(`/inventory/requisitions/${mr.id}/close`, { reason })
          : await api.patch<{ message?: string }>(
              `/inventory/requisitions/${mr.id}/${what}`,
              what === 'reject' ? { reason } : {},
            )
      setAsking(null)
      await load()
      if (res.message) setMessage(res.message)
    } catch (err) {
      setAsking(null)
      setError(err instanceof ApiError ? err.message : 'Could not save.')
    } finally {
      setBusy(null)
    }
  }

  // The person who raised it may withdraw it; the store or an approver may
  // close it. The server holds the same rule.
  const mayClose = (mr: Requisition, isMine: boolean) =>
    !mr.closedAt &&
    mr.status !== 'REJECTED' &&
    !mr.issuedAt &&
    (isMine || can('inventory', 'edit') || can('inventory', 'approve'))

  /** What one row needs to draw itself, worked out once for the card and the table alike. */
  const rowFacts = (mr: Requisition) => {
    // The server refuses these too; hiding a button just avoids offering a door that is certain to be shut.
    const isMine = Boolean(me?.id && mr.raisedBy?.id === me.id)
    const iApproved = Boolean(me?.id && mr.approvedBy?.id === me.id)
    const s = stage(mr, isMine, iApproved, admin)
    const canDecide = mr.status === 'PENDING' && !mr.closedAt && (!isMine || admin)
    // Approved with something still owed: the store hands it over, buys it, or both.
    const canFulfil =
      mr.status === 'APPROVED' && !mr.closedAt && mr.lines.some((l) => Number(l.issuedQty) < Number(l.requestedQty))
    const actions: RowAction[] = []
    if (canDecide)
      actions.push({ key: 'refuse', label: 'Refuse', icon: <X size={14} />, onClick: () => setAsking({ mr, kind: 'reject' }), danger: true })
    if (mr.status === 'APPROVED')
      actions.push({ key: 'slip', label: 'Print issue slip', icon: <Printer size={14} />, href: `/print/material-issue/${mr.id}`, newTab: true })
    if (mayClose(mr, isMine))
      actions.push({
        key: 'close',
        label: partlyIssued(mr) ? 'Close — the rest is not needed' : 'Cancel requisition',
        icon: <Ban size={14} />,
        onClick: () => setAsking({ mr, kind: 'close' }),
        danger: true,
      })
    return { isMine, iApproved, s, canDecide, canFulfil, actions, groups: qtyByUnit(mr.lines) }
  }
  type Facts = ReturnType<typeof rowFacts>

  /** The one thing most likely to be done next to this row, as a button. */
  const primaryAction = (mr: Requisition, r: Facts) =>
    r.canDecide ? (
      <button className="btn-primary h-7 px-2.5 text-xs" onClick={() => void act(mr, 'approve')} disabled={busy === mr.id}>
        <Check size={13} /> Approve
      </button>
    ) : r.canFulfil ? (
      <button className="btn-primary h-7 px-2.5 text-xs" onClick={() => setFulfilling(mr)} disabled={busy === mr.id} title="Hand it over, buy what is short, or both">
        <PackageCheck size={13} /> Fulfil
      </button>
    ) : null

  /** The panel under an opened row: every line as a proper table, as on the purchase lists. */
  const itemPanel = (mr: Requisition, r: Facts) => {
    return (
      <RowPanel icon={FileText} title="Item Details" note={`${mr.lines.length} ${mr.lines.length === 1 ? 'line' : 'lines'} on ${mr.mrNumber}`}>
        <table className="subtable w-full table-fixed">
          <thead className="sticky top-0 z-10">
            <tr>
              {ITEM_COLS.map((c) => (
                <th key={c.label} style={{ width: c.width }} className={c.numeric ? 'text-right' : undefined}>
                  {c.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {mr.lines.map((l) => {
              const cat = l.item.category
              const asked = Number(l.requestedQty)
              const issued = Number(l.issuedQty)
              const owed = Math.max(0, asked - issued)
              const buying = buyQtyOf(l)
              return (
                <tr key={l.id}>
                  <td className="text-muted-foreground whitespace-nowrap font-mono text-xs">{l.item.code}</td>
                  <td>
                    <div className="text-foreground truncate text-xs" title={l.item.name}>
                      {l.item.name}
                    </div>
                  </td>
                  <td className="truncate text-xs">{cat?.parent?.name ?? cat?.name ?? <span className="text-muted-foreground">—</span>}</td>
                  <td className="truncate text-xs">{cat?.parent ? cat.name : <span className="text-muted-foreground">—</span>}</td>
                  <td className="truncate text-xs">
                    {l.ownership === 'CUSTOMER_OWNED' ? (
                      <span className="text-sky-400">{l.ownerCustomer?.name ?? 'Customer'}&apos;s</span>
                    ) : (
                      <span className="text-muted-foreground">Our own</span>
                    )}
                  </td>
                  <td className="truncate text-xs">
                    {l.warehouse.name}
                  </td>
                  <td className="truncate text-xs" title={l.purpose ?? undefined}>
                    {l.purpose ?? <span className="text-muted-foreground">—</span>}
                  </td>
                  <td className="whitespace-nowrap text-right text-xs tabular-nums">
                    {buying > 0 ? <span className="text-sky-500">{qtyFmt(buying)}</span> : <span className="text-muted-foreground">—</span>}
                  </td>
                  <td className="whitespace-nowrap text-right text-xs tabular-nums">
                    {qtyFmt(asked)} {l.item.uom.symbol}
                  </td>
                  <td className="whitespace-nowrap text-right text-xs tabular-nums">
                    {issued > 0 ? <span className="text-emerald-500">{qtyFmt(issued)}</span> : <span className="text-muted-foreground">—</span>}
                  </td>
                  <td className="whitespace-nowrap text-right text-xs tabular-nums">
                    {mr.closedAt || mr.status === 'REJECTED' || owed === 0 ? (
                      <span className="text-muted-foreground">—</span>
                    ) : (
                      <span className="text-amber-500">{qtyFmt(owed)}</span>
                    )}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
        <div className="border-border text-muted-foreground flex flex-wrap items-center gap-x-3 gap-y-1 border-t px-3 py-2 text-[11px]">
          <span>
            {r.s.next && <>{r.s.next} </>}
            {mr.approvedBy && <>Approved by {mr.approvedBy.name}. </>}
            {mr.issuedBy && mr.issuedAt && <>Handed over by {mr.issuedBy.name} on {formatDate(mr.issuedAt)}. </>}
            {mr.closedAt && (
              <>
                {mr.lines.some((l) => Number(l.issuedQty) > 0) ? 'Closed' : 'Cancelled'}
                {mr.closedBy && <> by {mr.closedBy.name}</>} on {formatDate(mr.closedAt)}
                {mr.closeReason && <>: {mr.closeReason}</>}.{' '}
              </>
            )}
            {mr.notes && <>Note: {mr.notes}</>}
          </span>
          {r.canFulfil && (
            <button className="btn-primary ml-auto h-7 px-2.5 text-xs" onClick={() => setFulfilling(mr)}>
              <PackageCheck size={13} /> Fulfil
            </button>
          )}
        </div>
      </RowPanel>
    )
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
            <option value="APPROVED">Approved — to hand over</option>
            <option value="PARTLY">Part issued</option>
            <option value="ISSUED">Issued in full</option>
            <option value="CLOSED">Cancelled or closed</option>
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
          <div className="list-scope">
            {/* On a phone each requisition is a card; the table is for a wider list. */}
            <div className="list-cards divide-border divide-y">
              {rows.map((mr) => {
                const r = rowFacts(mr)
                const expanded = open === mr.id
                return (
                  <div key={mr.id} className="p-3">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="font-mono text-xs font-semibold text-teal-400">{mr.mrNumber}</span>
                          <span className={r.s.cls}>{r.s.label}</span>
                        </div>
                        <p className="text-foreground mt-1 font-medium leading-snug">{mr.department.name}</p>
                      </div>
                      <span className="text-muted-foreground shrink-0 text-right text-xs">
                        {mr.lines.length} {mr.lines.length === 1 ? 'item' : 'items'}
                      </span>
                    </div>
                    <dl className="mt-2.5 grid grid-cols-[6rem_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs">
                      <dt className="text-muted-foreground">Raised</dt>
                      <dd className="text-foreground min-w-0">
                        {formatDate(mr.requestDate)}
                        {mr.raisedBy && <span className="text-muted-foreground"> · {mr.raisedBy.name}</span>}
                      </dd>
                      <dt className="text-muted-foreground">Asked</dt>
                      <dd className="text-foreground min-w-0 tabular-nums">{unitLine(r.groups, (g) => g.asked) ?? '—'}</dd>
                      <dt className="text-muted-foreground">Still owed</dt>
                      <dd className="min-w-0 tabular-nums text-amber-500">
                        {mr.closedAt || mr.status === 'REJECTED' ? <span className="text-muted-foreground">—</span> : (unitLine(r.groups, (g) => g.owed) ?? '—')}
                      </dd>
                    </dl>
                    {r.s.next && <p className="text-muted-foreground mt-2 text-[11px]">{r.s.next}</p>}
                    <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
                      <button
                        onClick={() => setOpen(expanded ? null : mr.id)}
                        className="bg-primary/10 text-primary hover:bg-primary/20 inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-medium transition-colors"
                        aria-expanded={expanded}
                      >
                        {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                        {expanded ? 'Hide items' : 'Show items'}
                      </button>
                      <div className="flex items-center gap-1.5">
                        {primaryAction(mr, r)}
                        {r.actions.length > 0 && <ActionMenu label={`Actions for ${mr.mrNumber}`} items={r.actions} />}
                      </div>
                    </div>
                    {expanded && <div className="mt-2.5">{itemPanel(mr, r)}</div>}
                  </div>
                )
              })}
            </div>

            <div className="list-rows w-full">
              <ScrollableTable>
                <table className="data-table table-compact min-w-full">
                  <thead>
                    <tr className="bg-secondary">
                      <th style={{ width: 30 }} />
                      <th className="whitespace-nowrap">Requisition</th>
                      <th className="whitespace-nowrap">Department</th>
                      <th className="whitespace-nowrap">Raised</th>
                      <th className="whitespace-nowrap">Items</th>
                      <th className="whitespace-nowrap" style={{ textAlign: 'right' }}>Asked qty</th>
                      <th className="whitespace-nowrap" style={{ textAlign: 'right' }}>Issued qty</th>
                      <th className="whitespace-nowrap" style={{ textAlign: 'right' }}>Still owed</th>
                      <th className="whitespace-nowrap">Status</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((mr) => {
                      const r = rowFacts(mr)
                      const expanded = open === mr.id
                      const late =
                        mr.requiredDate && !mr.issuedAt && !mr.closedAt && mr.status !== 'REJECTED' &&
                        new Date(mr.requiredDate).toLocaleDateString('en-CA') < new Date().toLocaleDateString('en-CA')
                      const owed = unitLine(r.groups, (g) => g.owed)
                      const toBuy = unitLine(r.groups, (g) => g.toBuy)
                      const p = itemsPreview(mr.lines.map((l) => l.item.name))
                      return (
                        <Fragment key={mr.id}>
                          <tr>
                            <td>
                              <button
                                className="bg-primary/10 text-primary hover:bg-primary/20 flex h-7 w-7 items-center justify-center rounded-lg transition-colors"
                                onClick={() => setOpen(expanded ? null : mr.id)}
                                title={expanded ? 'Hide items' : 'Show items'}
                                aria-label={`${expanded ? 'Hide' : 'Show'} items on ${mr.mrNumber}`}
                                aria-expanded={expanded}
                              >
                                {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                              </button>
                            </td>
                            <td className="whitespace-nowrap">
                              {mr.status === 'APPROVED' ? (
                                <a
                                  href={`/print/material-issue/${mr.id}`}
                                  target="_blank"
                                  rel="noreferrer"
                                  className="font-mono text-xs font-semibold text-teal-400 hover:underline"
                                  title="Open the issue slip"
                                >
                                  {mr.mrNumber}
                                </a>
                              ) : (
                                <span className="font-mono text-xs font-semibold text-teal-400">{mr.mrNumber}</span>
                              )}
                            </td>
                            <td className="whitespace-nowrap text-sm">{mr.department.name}</td>
                            <td className="whitespace-nowrap text-xs">
                              {formatDate(mr.requestDate)}
                              {mr.raisedBy && <div className="text-muted-foreground text-[10px]">by {mr.raisedBy.name}</div>}
                              {/* When it is wanted by, where somebody said: red once that day has gone. */}
                              {mr.requiredDate && (
                                <div className={`text-[10px] ${late ? 'font-medium text-red-400' : 'text-muted-foreground'}`}>
                                  needed by {formatDate(mr.requiredDate)}
                                  {late && ' · past due'}
                                </div>
                              )}
                            </td>
                            <td className="text-xs">
                              <div className="text-foreground whitespace-nowrap">
                                {mr.lines.length} {mr.lines.length === 1 ? 'item' : 'items'}
                              </div>
                              <div className="text-muted-foreground max-w-[9rem] truncate text-[10px] leading-tight" title={p.full}>
                                {p.shown}
                                {p.extra}
                              </div>
                            </td>
                            <td className="whitespace-nowrap text-right text-xs tabular-nums">
                              {unitLine(r.groups, (g) => g.asked) ?? '—'}
                            </td>
                            <td className="whitespace-nowrap text-right text-xs tabular-nums">
                              {unitLine(r.groups, (g) => g.issued) ?? <span className="text-muted-foreground">—</span>}
                            </td>
                            <td className="whitespace-nowrap text-right text-xs tabular-nums">
                              {mr.closedAt || mr.status === 'REJECTED' ? (
                                <span className="text-muted-foreground">—</span>
                              ) : (
                                <>
                                  {owed ? <span className="font-medium text-amber-500">{owed}</span> : !toBuy && <span className="text-muted-foreground">—</span>}
                                  {toBuy && <div className="text-[10px] text-sky-500">{toBuy} to buy</div>}
                                </>
                              )}
                            </td>
                            <td className="whitespace-nowrap">
                              <span className={r.s.cls} title={r.s.next}>
                                {r.s.label}
                              </span>
                              {mr.status === 'REJECTED' && mr.rejectionReason && (
                                <div className="text-muted-foreground max-w-[200px] truncate text-[10px]" title={mr.rejectionReason}>
                                  {mr.rejectionReason}
                                </div>
                              )}
                            </td>
                            <td className="whitespace-nowrap text-right">
                              <div className="flex justify-end gap-1.5">
                                {primaryAction(mr, r)}
                                {r.actions.length > 0 && <ActionMenu label={`Actions for ${mr.mrNumber}`} items={r.actions} />}
                              </div>
                            </td>
                          </tr>

                          {expanded && (
                            <tr>
                              <td colSpan={10} className="bg-secondary/40 !px-2 !pb-2 !pt-0">
                                {/* Sized to the visible row, not the scrolling table; see the purchase lists. */}
                                <div className="w-[100cqw]">{itemPanel(mr, r)}</div>
                              </td>
                            </tr>
                          )}
                        </Fragment>
                      )
                    })}
                  </tbody>
                </table>
              </ScrollableTable>
            </div>
          </div>
        )}
      </div>

      {fulfilling && (
        <FulfilDialog
          mrId={fulfilling.id}
          initial={fulfilling}
          onClose={() => setFulfilling(null)}
          onDone={(msg) => {
            setFulfilling(null)
            setMessage(msg)
            void load()
          }}
        />
      )}

      {asking && (
        <ReasonDialog
          title={
            asking.kind === 'reject'
              ? `Refuse ${asking.mr.mrNumber}?`
              : `${partlyIssued(asking.mr) ? 'Close' : 'Cancel'} ${asking.mr.mrNumber}?`
          }
          description={
            asking.kind === 'reject'
              ? 'Whoever raised it sees the reason, so say what they should do instead.'
              : partlyIssued(asking.mr)
                ? 'What was handed over stays issued. The rest is no longer owed, and nothing more can be issued against it.'
                : 'Nothing has been handed over. It comes off the list, and nothing can be issued against it.'
          }
          confirmLabel={
            asking.kind === 'reject' ? 'Refuse' : partlyIssued(asking.mr) ? 'Close it' : 'Cancel it'
          }
          danger
          minLength={5}
          placeholder={asking.kind === 'reject' ? 'e.g. Use the offcuts from lot 12 first' : 'e.g. Order for this style was dropped'}
          busy={busy === asking.mr.id}
          onConfirm={(reason) => void act(asking.mr, asking.kind, reason)}
          onCancel={() => setAsking(null)}
        />
      )}

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
