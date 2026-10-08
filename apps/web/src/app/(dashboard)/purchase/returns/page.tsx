'use client'

import { Fragment, useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import {
  AlertCircle,
  Ban,
  ChevronDown,
  ChevronRight,
  FileText,
  Printer,
  RefreshCw,
  Search,
  X,
} from 'lucide-react'
import { api, apiErrorMessage, can, masterResource, type Paginated } from '@/lib/api'
import { ActionMenu, type RowAction } from '@/components/tables/ActionMenu'
import { Pagination } from '@/components/tables/Pagination'
import { RowPanel } from '@/components/tables/RowPanel'
import { SmartSelect } from '@/components/ui/SmartSelect'

/**
 * Purchase returns — the challans goods went back to suppliers on.
 *
 * Raised from a bill ("Create return challan" on the bills screen), never from
 * here: every return is against something that was bought and billed, and the
 * bill is where the lines and what is left of each already are. This screen is
 * where they are found again — by the gate checking a vehicle out, by accounts
 * looking for the note a challan wrote, by the buyer asking what went back to
 * whom last month.
 *
 * Each row names the whole chain, left to right as it happened: the bill the
 * goods were charged on, the challan they left on, and the debit note that
 * charges them back.
 */

const MODULE = 'purchase'

interface ReturnLine {
  id: string
  qty: string | number
  unitPrice: string | number
  gstRate: string | number
  remarks: string | null
  /** This row's reason in words — the challan's own where the row had none. */
  reasonLabel?: string
  billLine: {
    hsnCode: string | null
    grnLine: { grn: { id: string; grnNumber: string } } | null
  }
  item: { id: string; code: string; name: string; uom: { symbol: string } | null }
  warehouse: { id: string; name: string }
}

interface ReturnRow {
  id: string
  returnNumber: string
  status: 'DISPATCHED' | 'CANCELLED'
  returnDate: string
  reason: string
  reasonLabel: string
  reasonNote: string | null
  vehicleNo: string | null
  transporterName: string | null
  lrNumber: string | null
  cancelReason: string | null
  supplier: { id: string; name: string; code: string }
  bill: { id: string; billNumber: string; supplierInvoiceNo: string | null; status: string }
  createdBy: { name: string }
  lines: ReturnLine[]
  debitNotes: Array<{
    id: string
    noteNumber: string
    status: string
    totalAmount: string | number
  }>
  taxableValue: number
  totalValue: number
}

const STATUS: Record<ReturnRow['status'], { label: string; cls: string }> = {
  DISPATCHED: { label: 'Dispatched', cls: 'badge-info' },
  CANCELLED: { label: 'Cancelled', cls: 'badge-neutral' },
}

/*
 * A challan writes its debit note itself, as a draft, the moment it is saved.
 * "Draft" alone read as though somebody had started one; it says what it is.
 */
const NOTE_DRAFT_HINT =
  'Written automatically when this challan was saved. Accounts checks it and posts it; only then is it adjusted against the bill.'

const NOTE_STATUS: Record<string, { label: string; cls: string }> = {
  DRAFT: { label: 'Draft · not posted', cls: 'badge-warning' },
  POSTED: { label: 'Posted', cls: 'badge-success' },
  CANCELLED: { label: 'Cancelled', cls: 'badge-neutral' },
}

const money = (v: string | number) =>
  Number(v).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

const qty = (v: string | number) => Number(v).toLocaleString('en-IN', { maximumFractionDigits: 3 })

const day = (iso: string) =>
  new Date(iso).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })

export default function PurchaseReturnsPage() {
  const [rows, setRows] = useState<ReturnRow[]>([])
  const [page, setPage] = useState(1)
  const [pages, setPages] = useState(1)
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [open, setOpen] = useState<string | null>(null)

  const [search, setSearch] = useState('')
  const [debounced, setDebounced] = useState('')
  const [status, setStatus] = useState('')
  const [supplierId, setSupplierId] = useState('')
  const [fromDate, setFromDate] = useState('')
  const [toDate, setToDate] = useState('')
  const [suppliers, setSuppliers] = useState<Array<{ id: string; name: string }>>([])

  useEffect(() => {
    const t = setTimeout(() => setDebounced(search.trim()), 350)
    return () => clearTimeout(t)
  }, [search])

  useEffect(() => {
    setPage(1)
  }, [debounced, status, supplierId, fromDate, toDate])

  useEffect(() => {
    masterResource<{ id: string; name: string }>('suppliers')
      .list({ limit: 500 })
      .then((r) => setSuppliers([...r.data].sort((a, b) => a.name.localeCompare(b.name))))
      .catch(() => {
        // The filter comes up empty; the list still loads.
      })
  }, [])

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    const q = new URLSearchParams({ page: String(page), limit: '25' })
    if (debounced) q.set('q', debounced)
    if (status) q.set('status', status)
    if (supplierId) q.set('supplierId', supplierId)
    if (fromDate) q.set('from', fromDate)
    if (toDate) q.set('to', toDate)
    try {
      const res = await api.get<Paginated<ReturnRow>>('/purchase/returns?' + q.toString())
      setRows(res.data)
      setPages(res.pagination.pages)
      setTotal(res.pagination.total)
    } catch (err) {
      setError(apiErrorMessage(err, 'Could not load the returns.'))
    } finally {
      setLoading(false)
    }
  }, [page, debounced, status, supplierId, fromDate, toDate])

  useEffect(() => {
    void load()
  }, [load])

  const filtered = Boolean(debounced || status || supplierId || fromDate || toDate)
  const clearAll = () => {
    setSearch('')
    setStatus('')
    setSupplierId('')
    setFromDate('')
    setToDate('')
  }

  /*
   * Cancelling asks why, because a gate pass that stops meaning anything with
   * no reason on it is the first thing a stock audit asks about. The server
   * refuses once the debit note it wrote has been posted, and says what to do
   * instead.
   */
  const cancel = async (r: ReturnRow) => {
    const reason = window.prompt(
      `Cancel ${r.returnNumber}? The goods go back into stock and its draft debit note is cancelled.\n\nWhy is it being cancelled?`
    )
    if (reason == null) return
    setError(null)
    try {
      const res = await api.post<{ message: string }>(`/purchase/returns/${r.id}/cancel`, {
        reason,
      })
      setMessage(res.message)
      void load()
    } catch (err) {
      setError(apiErrorMessage(err))
    }
  }

  const actions = (r: ReturnRow): RowAction[] => {
    const items: RowAction[] = [
      {
        key: 'print',
        label: 'Print challan / gate pass',
        icon: <Printer size={14} />,
        href: '/print/purchase-return/' + r.id,
        newTab: true,
      },
    ]
    for (const n of r.debitNotes) {
      const draft = n.status === 'DRAFT'
      items.push({
        key: 'note-' + n.id,
        label: draft
          ? `Review & post debit note ${n.noteNumber}`
          : `View debit note ${n.noteNumber}`,
        hint: draft ? 'Written automatically from this challan — not posted yet' : undefined,
        icon: <FileText size={14} />,
        href: '/purchase/debit-notes?q=' + encodeURIComponent(n.noteNumber),
      })
    }
    if (r.status === 'DISPATCHED' && can(MODULE, 'edit')) {
      const posted = r.debitNotes.find((n) => n.status !== 'DRAFT' && n.status !== 'CANCELLED')
      items.push({
        key: 'cancel',
        label: 'Cancel challan',
        icon: <Ban size={14} />,
        onClick: () => void cancel(r),
        danger: true,
        ...(posted
          ? {
              disabled: true,
              hint: `${posted.noteNumber} has been posted — the return stands.`,
            }
          : {}),
      })
    }
    return items
  }

  return (
    <div className="space-y-5">
      <div className="page-header gap-3">
        <div className="min-w-0">
          <h1 className="page-title text-xl sm:text-2xl">Purchase Returns</h1>
          <p className="page-subtitle hidden sm:block">
            Goods sent back to suppliers, raised from a bill. Saving one writes a draft debit
            note for accounts to check and post.
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <button
            className="btn-ghost"
            onClick={() => void load()}
            disabled={loading}
            aria-label="Refresh"
          >
            <RefreshCw size={15} className={loading ? 'animate-spin' : undefined} />
          </button>
          {/* No "New" here. A return is always against a bill, and the bill
            is where its lines and what is left of each already are. */}
          <Link href="/purchase/bills" className="btn-secondary">
            <span className="hidden sm:inline">Return goods from a bill</span>
            <span className="sm:hidden">Bills</span>
          </Link>
        </div>
      </div>

      {error && (
        <div className="flex items-start gap-3 rounded-lg border border-red-500/40 bg-red-500/5 p-3">
          <AlertCircle size={16} className="mt-0.5 shrink-0 text-red-400" />
          <p className="text-sm text-red-400">{error}</p>
        </div>
      )}
      {message && (
        <div className="flex items-start justify-between gap-3 rounded-lg border border-emerald-500/40 bg-emerald-500/5 p-3">
          <p className="text-sm text-emerald-400">{message}</p>
          <button
            className="text-emerald-400/70 hover:text-emerald-400"
            onClick={() => setMessage(null)}
            aria-label="Dismiss"
          >
            <X size={15} />
          </button>
        </div>
      )}

      <div className="glass-card overflow-hidden p-0">
        <div className="border-border/70 flex flex-wrap items-center gap-2 border-b p-3">
          <div className="relative min-w-[200px] flex-1">
            <Search
              size={15}
              className="text-muted-foreground pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2"
            />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Challan no, bill no, their bill, vehicle, debit note, supplier"
              className="form-input pl-8"
            />
          </div>
          <SmartSelect
            value={status}
            onChange={(e) => setStatus(e.target.value)}
            className="form-input w-auto"
          >
            <option value="">Any status</option>
            <option value="DISPATCHED">Dispatched</option>
            <option value="CANCELLED">Cancelled</option>
          </SmartSelect>
          <div className="flex shrink-0 items-center gap-1">
            <input
              type="date"
              value={fromDate}
              max={toDate || undefined}
              onChange={(e) => setFromDate(e.target.value)}
              className="form-input w-auto"
              aria-label="Returns from this date"
            />
            <span className="text-muted-foreground hidden text-xs sm:inline">to</span>
            <input
              type="date"
              value={toDate}
              min={fromDate || undefined}
              onChange={(e) => setToDate(e.target.value)}
              className="form-input w-auto"
              aria-label="Returns up to this date"
            />
          </div>
          <SmartSelect
            value={supplierId}
            onChange={(e) => setSupplierId(e.target.value)}
            className="form-input w-auto"
          >
            <option value="">Any supplier</option>
            {suppliers.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </SmartSelect>
          {filtered && (
            <button type="button" onClick={clearAll} className="btn-ghost text-xs">
              <X size={14} />
              Clear
            </button>
          )}
          <span className="text-muted-foreground ml-auto text-xs">
            {total} {total === 1 ? 'return' : 'returns'}
          </span>
        </div>

        {loading && rows.length === 0 ? (
          <div className="text-muted-foreground p-10 text-center text-sm">Loading returns…</div>
        ) : rows.length === 0 ? (
          <div className="p-10 text-center">
            <p className="text-foreground text-sm font-medium">
              {filtered ? 'Nothing matches those filters' : 'Nothing has been sent back yet'}
            </p>
            <p className="text-muted-foreground mx-auto mt-1 max-w-md text-xs">
              {filtered
                ? 'Clear them to see everything.'
                : 'Open the bill the goods were charged on and choose "Create return challan" from its Actions.'}
            </p>
          </div>
        ) : (
          <div className="list-scope">
            {/* ── On a phone, not a table ──────────────────────────────────
              The same switch every purchase list makes: under 700px of list
              each challan is a block, so nothing has to be dragged sideways
              to reach the value or the actions. */}
            <div className="list-cards divide-border divide-y">
              {rows.map((r) => {
                const s = STATUS[r.status]
                const expanded = open === r.id
                return (
                  <div key={r.id} className="p-3">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <a
                            href={'/print/purchase-return/' + r.id}
                            target="_blank"
                            rel="noreferrer"
                            className="font-mono text-xs font-semibold text-teal-400 underline-offset-2 hover:underline"
                            title={'Open the gate pass for ' + r.returnNumber}
                          >
                            {r.returnNumber}
                          </a>
                          <span className={s.cls} title={r.cancelReason ?? undefined}>
                            {s.label}
                          </span>
                        </div>
                        <p className="text-foreground mt-1 font-medium leading-snug">
                          {r.supplier.name}
                        </p>
                      </div>
                      <span className="text-foreground shrink-0 text-right font-semibold tabular-nums">
                        ₹{money(r.totalValue)}
                      </span>
                    </div>

                    <dl className="mt-2.5 grid grid-cols-[6.5rem_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs">
                      <dt className="text-muted-foreground">Date</dt>
                      <dd className="text-foreground min-w-0">{day(r.returnDate)}</dd>
                      <dt className="text-muted-foreground">Against bill</dt>
                      <dd className="min-w-0">
                        <Link
                          href={'/purchase/bills?q=' + encodeURIComponent(r.bill.billNumber)}
                          className="text-primary font-mono hover:underline"
                        >
                          {r.bill.billNumber}
                        </Link>
                        {r.bill.supplierInvoiceNo && (
                          <span className="text-muted-foreground font-mono">
                            {' '}
                            · theirs {r.bill.supplierInvoiceNo}
                          </span>
                        )}
                      </dd>
                      <dt className="text-muted-foreground">Reason</dt>
                      <dd className="text-foreground min-w-0">
                        {r.reasonLabel}
                        {r.reasonNote && (
                          <span className="text-muted-foreground"> — {r.reasonNote}</span>
                        )}
                      </dd>
                      <dt className="text-muted-foreground">Vehicle</dt>
                      <dd className="text-foreground min-w-0 font-mono">
                        {r.vehicleNo || <span className="text-muted-foreground">—</span>}
                      </dd>
                      <dt className="text-muted-foreground">Debit note</dt>
                      <dd className="min-w-0">
                        {r.debitNotes.length === 0 ? (
                          <span className="text-muted-foreground">—</span>
                        ) : (
                          r.debitNotes.map((n) => (
                            <span key={n.id} className="mr-2 inline-flex items-center gap-1.5">
                              <Link
                                href={'/purchase/debit-notes?q=' + encodeURIComponent(n.noteNumber)}
                                className="text-primary font-mono hover:underline"
                              >
                                {n.noteNumber}
                              </Link>
                              <span
                                    className={NOTE_STATUS[n.status]?.cls ?? 'badge-neutral'}
                                    title={n.status === 'DRAFT' ? NOTE_DRAFT_HINT : undefined}
                                  >
                                {NOTE_STATUS[n.status]?.label ?? n.status}
                              </span>
                            </span>
                          ))
                        )}
                      </dd>
                    </dl>

                    <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
                      <button
                        onClick={() => setOpen(expanded ? null : r.id)}
                        className="bg-primary/10 text-primary hover:bg-primary/20 inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-medium transition-colors"
                        aria-expanded={expanded}
                      >
                        {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                        {expanded ? 'Hide items' : `Items returned (${r.lines.length})`}
                      </button>
                      <ActionMenu label={`Actions for ${r.returnNumber}`} items={actions(r)} />
                    </div>

                    {expanded && (
                      <div className="border-border bg-secondary/40 divide-border/60 mt-2.5 max-h-[22rem] divide-y overflow-y-auto rounded-lg border">
                        {r.lines.map((l) => (
                          <div key={l.id} className="flex items-start justify-between gap-3 p-2.5">
                            <div className="min-w-0">
                              <p className="text-xs font-medium">{l.item.name}</p>
                              <p className="text-muted-foreground mt-0.5 text-[10px]">
                                <span className="font-mono">{l.item.code}</span>
                                {' · '}from {l.warehouse.name}
                                {l.billLine.grnLine && (
                                  <>
                                    {' · '}
                                    <span className="font-mono">
                                      {l.billLine.grnLine.grn.grnNumber}
                                    </span>
                                  </>
                                )}
                              </p>
                              {(l.remarks || (l.reasonLabel && l.reasonLabel !== r.reasonLabel)) && (
                                <p className="text-muted-foreground mt-0.5 text-[10px]">
                                  {[
                                    l.reasonLabel !== r.reasonLabel ? l.reasonLabel : null,
                                    l.remarks,
                                  ]
                                    .filter(Boolean)
                                    .join(' · ')}
                                </p>
                              )}
                            </div>
                            <div className="shrink-0 text-right text-xs tabular-nums">
                              <p>
                                {qty(l.qty)}{' '}
                                <span className="text-muted-foreground text-[10px]">
                                  {l.item.uom?.symbol}
                                </span>
                              </p>
                              <p className="text-muted-foreground text-[10px]">
                                ₹{money(Number(l.qty) * Number(l.unitPrice))}
                              </p>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )
              })}
            </div>

            <div className="list-rows w-full overflow-x-auto">
              <table className="data-table table-compact w-full">
                <thead>
                  <tr className="bg-secondary">
                    <th style={{ width: 30 }} />
                    <th className="whitespace-nowrap">Challan</th>
                    <th className="whitespace-nowrap">Date</th>
                    <th className="whitespace-nowrap">Supplier</th>
                    <th className="whitespace-nowrap">Against bill</th>
                    <th className="whitespace-nowrap">Reason</th>
                    <th className="whitespace-nowrap">Vehicle</th>
                    <th className="whitespace-nowrap" style={{ textAlign: 'right' }}>
                      Items
                    </th>
                    <th className="whitespace-nowrap" style={{ textAlign: 'right' }}>
                      Value
                    </th>
                    <th className="whitespace-nowrap">Debit note</th>
                    <th className="whitespace-nowrap">Status</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => {
                    const s = STATUS[r.status]
                    const expanded = open === r.id
                    return (
                      <Fragment key={r.id}>
                        <tr className={expanded ? 'bg-secondary/30' : undefined}>
                          <td>
                            <button
                              type="button"
                              onClick={() => setOpen(expanded ? null : r.id)}
                              className="btn-ghost p-1"
                              aria-expanded={expanded}
                              aria-label={`${expanded ? 'Hide' : 'Show'} items on ${r.returnNumber}`}
                            >
                              {expanded ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
                            </button>
                          </td>
                          <td>
                            <a
                              href={'/print/purchase-return/' + r.id}
                              target="_blank"
                              rel="noreferrer"
                              className="whitespace-nowrap font-mono text-xs font-semibold text-teal-400 hover:underline"
                              title={'Open the gate pass for ' + r.returnNumber}
                            >
                              {r.returnNumber}
                            </a>
                          </td>
                          <td className="whitespace-nowrap text-xs">{day(r.returnDate)}</td>
                          <td className="max-w-[12rem] truncate text-sm">{r.supplier.name}</td>
                          <td className="whitespace-nowrap">
                            <Link
                              href={'/purchase/bills?q=' + encodeURIComponent(r.bill.billNumber)}
                              className="text-primary font-mono text-xs hover:underline"
                            >
                              {r.bill.billNumber}
                            </Link>
                            {r.bill.supplierInvoiceNo && (
                              <p className="text-muted-foreground font-mono text-[10px]">
                                theirs {r.bill.supplierInvoiceNo}
                              </p>
                            )}
                          </td>
                          <td className="max-w-[11rem] truncate text-xs" title={r.reasonNote ?? ''}>
                            {r.reasonLabel}
                          </td>
                          <td className="whitespace-nowrap font-mono text-xs">
                            {r.vehicleNo || <span className="text-muted-foreground/60">—</span>}
                          </td>
                          <td className="text-xs tabular-nums" style={{ textAlign: 'right' }}>
                            {r.lines.length}
                          </td>
                          <td
                            className="whitespace-nowrap text-sm font-medium tabular-nums"
                            style={{ textAlign: 'right' }}
                          >
                            ₹{money(r.totalValue)}
                          </td>
                          <td className="whitespace-nowrap">
                            {r.debitNotes.length === 0 ? (
                              <span className="text-muted-foreground/60 text-xs">—</span>
                            ) : (
                              r.debitNotes.map((n) => (
                                <div key={n.id} className="flex items-center gap-1.5">
                                  <Link
                                    href={
                                      '/purchase/debit-notes?q=' + encodeURIComponent(n.noteNumber)
                                    }
                                    className="text-primary font-mono text-xs hover:underline"
                                  >
                                    {n.noteNumber}
                                  </Link>
                                  <span
                                    className={NOTE_STATUS[n.status]?.cls ?? 'badge-neutral'}
                                    title={n.status === 'DRAFT' ? NOTE_DRAFT_HINT : undefined}
                                  >
                                    {NOTE_STATUS[n.status]?.label ?? n.status}
                                  </span>
                                </div>
                              ))
                            )}
                          </td>
                          <td>
                            <span className={s.cls} title={r.cancelReason ?? undefined}>
                              {s.label}
                            </span>
                          </td>
                          <td>
                            <ActionMenu
                              label={`Actions for ${r.returnNumber}`}
                              items={actions(r)}
                            />
                          </td>
                        </tr>
                        {expanded && (
                          <tr>
                            <td colSpan={12} className="bg-secondary/40 !px-2 !pb-2 !pt-0">
                              <RowPanel
                                icon={FileText}
                                title="Items Returned"
                                note={`${r.lines.length} ${
                                  r.lines.length === 1 ? 'line' : 'lines'
                                } on ${r.returnNumber}`}
                              >
                                <table className="subtable w-full table-fixed">
                                  <thead className="sticky top-0 z-10">
                                    <tr>
                                      {[
                                        ['Item code', '12%', false],
                                        ['Item', '26%', false],
                                        ['HSN', '8%', false],
                                        ['Received on', '11%', false],
                                        ['From godown', '15%', false],
                                        ['Qty', '10%', true],
                                        ['Rate', '9%', true],
                                        ['Value', '9%', true],
                                      ].map(([h, w, right]) => (
                                        <th
                                          key={String(h)}
                                          style={{ width: String(w) }}
                                          className={right ? 'text-right' : undefined}
                                        >
                                          {h}
                                        </th>
                                      ))}
                                    </tr>
                                  </thead>
                                  <tbody>
                                    {r.lines.map((l) => (
                                      <tr
                                        key={l.id}
                                        className="border-border/40 border-b last:border-0"
                                      >
                                        <td className="text-muted-foreground whitespace-nowrap px-3 py-1.5 font-mono text-xs">
                                          {l.item.code}
                                        </td>
                                        <td className="px-3 py-1.5">
                                          <p className="text-xs">{l.item.name}</p>
                                          {(l.remarks ||
                                            (l.reasonLabel && l.reasonLabel !== r.reasonLabel)) && (
                                            <p className="text-muted-foreground text-[10px]">
                                              {[
                                                l.reasonLabel !== r.reasonLabel ? l.reasonLabel : null,
                                                l.remarks,
                                              ]
                                                .filter(Boolean)
                                                .join(' · ')}
                                            </p>
                                          )}
                                        </td>
                                        <td className="text-muted-foreground px-3 py-1.5 text-xs">
                                          {l.billLine.hsnCode ?? '—'}
                                        </td>
                                        <td className="text-muted-foreground px-3 py-1.5 font-mono text-xs">
                                          {l.billLine.grnLine?.grn.grnNumber ?? '—'}
                                        </td>
                                        <td className="px-3 py-1.5 text-xs">{l.warehouse.name}</td>
                                        <td className="px-3 py-1.5 text-right text-xs tabular-nums">
                                          {qty(l.qty)}
                                          <span className="text-muted-foreground ml-1 text-[10px]">
                                            {l.item.uom?.symbol}
                                          </span>
                                        </td>
                                        <td className="text-muted-foreground px-3 py-1.5 text-right text-xs tabular-nums">
                                          {money(l.unitPrice)}
                                        </td>
                                        <td className="px-3 py-1.5 text-right text-xs tabular-nums">
                                          {money(Number(l.qty) * Number(l.unitPrice))}
                                        </td>
                                      </tr>
                                    ))}
                                  </tbody>
                                </table>
                              </RowPanel>
                            </td>
                          </tr>
                        )}
                      </Fragment>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </div>
        )}

        <Pagination page={page} pages={pages} onPageChange={setPage} busy={loading} />
      </div>
    </div>
  )
}
