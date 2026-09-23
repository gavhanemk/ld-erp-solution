'use client'

import { Fragment, useCallback, useEffect, useMemo, useState } from 'react'
import {
  AlertCircle,
  Ban,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  FileMinus,
  FilePlus2,
  Landmark,
  Pencil,
  Plus,
  Printer,
  RefreshCw,
  RotateCcw,
  Search,
  Send,
  Trash2,
  XCircle,
} from 'lucide-react'
import { api, ApiError, masterResource, type Paginated } from '@/lib/api'
import { Pagination } from '@/components/tables/Pagination'
import { ActionMenu, type RowAction } from '@/components/tables/ActionMenu'
import { RowPanel } from '@/components/tables/RowPanel'
import { formatDate } from '@/lib/utils'
import { PurchaseNoteDialog } from '@/components/purchase/PurchaseNoteDialog'
import { NoteDetail } from '@/components/purchase/NoteDetail'
import {
  MODULE_WORDS,
  NOTE_STATUS,
  REASON_WORDS,
  money,
  type NoteStatus,
  type NoteType,
  type PurchaseNote,
} from '@/components/purchase/noteTypes'

/**
 * The list of debit or credit notes, as one screen wearing two names.
 *
 * Both modules want the same table, the same filters, the same cards and the
 * same actions; what differs is the word in the heading and which `noteType`
 * the rows are filtered to. Two files would have been two of all of that,
 * drifting from the first fix that only one of them got.
 *
 * The four cards are the position: what is still to send, what has gone out
 * and not come back, what has actually landed on a bill, and what was refused.
 * They answer the questions a purchase manager asks standing at the screen,
 * and they describe the same filter as the table under them — a card that
 * ignored the supplier filter would contradict the rows beneath it.
 */

const PER_PAGE = 25

type Summary = Record<string, { count: number; amount: number }>

export function PurchaseNotesScreen({ moduleType }: { moduleType: NoteType }) {
  const words = MODULE_WORDS[moduleType]

  const [rows, setRows] = useState<PurchaseNote[]>([])
  const [summary, setSummary] = useState<Summary>({})
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [pages, setPages] = useState(1)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [expanded, setExpanded] = useState<string | null>(null)

  const [dialogOpen, setDialogOpen] = useState(false)
  const [editing, setEditing] = useState<PurchaseNote | null>(null)

  const [search, setSearch] = useState('')
  const [debounced, setDebounced] = useState('')
  const [status, setStatus] = useState('')
  const [reason, setReason] = useState('')
  const [supplierId, setSupplierId] = useState('')
  const [fromDate, setFromDate] = useState('')
  const [toDate, setToDate] = useState('')
  const [suppliers, setSuppliers] = useState<Array<{ id: string; name: string }>>([])

  useEffect(() => {
    const t = setTimeout(() => setDebounced(search), 350)
    return () => clearTimeout(t)
  }, [search])

  useEffect(() => {
    setPage(1)
  }, [debounced, status, reason, supplierId, fromDate, toDate])

  useEffect(() => {
    void (async () => {
      try {
        const list = await masterResource<{ id: string; name: string }>('suppliers').list({
          limit: 500,
        })
        setSuppliers([...list.data].sort((a, b) => a.name.localeCompare(b.name)))
      } catch {
        // The filter comes up empty; the list still loads.
      }
    })()
  }, [])

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const qs = new URLSearchParams({
        page: String(page),
        limit: String(PER_PAGE),
        noteType: moduleType,
      })
      if (debounced) qs.set('q', debounced)
      if (status) qs.set('status', status)
      if (reason) qs.set('reason', reason)
      if (supplierId) qs.set('supplierId', supplierId)
      if (fromDate) qs.set('from', fromDate)
      if (toDate) qs.set('to', toDate)

      const res = await api.get<Paginated<PurchaseNote> & { summary: Summary }>(
        `/purchase/notes?${qs}`
      )
      setRows(res.data)
      setSummary(res.summary ?? {})
      setTotal(res.pagination.total)
      setPages(res.pagination.pages)
    } catch (err) {
      setError(
        err instanceof ApiError
          ? err.status === 403
            ? `Your role does not allow viewing ${words.one}s.`
            : err.message
          : 'Could not reach the server. Is the API running?'
      )
    } finally {
      setLoading(false)
    }
  }, [page, moduleType, debounced, status, reason, supplierId, fromDate, toDate, words.one])

  useEffect(() => {
    void load()
  }, [load])

  const act = async (
    note: PurchaseNote,
    what: 'submit' | 'approve' | 'reject' | 'post' | 'cancel' | 'reopen'
  ) => {
    let reasonText: string | null = null

    if (what === 'cancel') {
      const undoing = note.status === 'POSTED'
      if (
        !window.confirm(
          undoing
            ? `${note.noteNumber} has been posted. Cancelling puts the adjustment back on ${note.bill?.billNumber ?? 'the bill'}${note.warehouse ? ' and the goods back into stock' : ''}. Go ahead?`
            : `Cancel ${note.noteNumber}?`
        )
      ) {
        return
      }
      reasonText = window.prompt('Why is it being cancelled? (optional)') ?? null
    }

    if (what === 'reject') {
      reasonText = window.prompt('Why is it being sent back? (optional)') ?? null
    }

    if (
      what === 'post' &&
      !window.confirm(
        `Posting ${note.noteNumber} changes what ${note.supplier.name} is owed. Go ahead?`
      )
    ) {
      return
    }

    setBusy(true)
    setError(null)
    setMessage(null)
    try {
      const res = await api.post<{ message?: string }>(
        `/purchase/notes/${note.id}/${what}`,
        reasonText ? { reason: reasonText } : {}
      )
      await load()
      if (res.message) setMessage(res.message)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save.')
    } finally {
      setBusy(false)
    }
  }

  const remove = async (note: PurchaseNote) => {
    if (!window.confirm(`Delete ${note.noteNumber}? Its number will not be reused.`)) return
    setBusy(true)
    setError(null)
    try {
      const res = await api.delete<{ message?: string }>(`/purchase/notes/${note.id}`)
      await load()
      if (res.message) setMessage(res.message)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not delete.')
    } finally {
      setBusy(false)
    }
  }

  /**
   * What can be done to this row, in the order of the workflow.
   *
   * Offered by state rather than always shown and sometimes refused: a menu of
   * six things of which four throw is a menu nobody trusts.
   */
  const rowActions = (n: PurchaseNote): RowAction[] => {
    const items: RowAction[] = []

    if (n.status === 'DRAFT') {
      items.push({
        key: 'edit',
        label: 'Edit',
        icon: <Pencil size={14} />,
        onClick: () => {
          setEditing(n)
          setDialogOpen(true)
        },
      })
      items.push({
        key: 'submit',
        label: 'Send for approval',
        icon: <Send size={14} />,
        onClick: () => void act(n, 'submit'),
      })
    }

    if (n.status === 'SUBMITTED') {
      items.push({
        key: 'approve',
        label: 'Approve',
        icon: <CheckCircle2 size={14} />,
        onClick: () => void act(n, 'approve'),
      })
      items.push({
        key: 'reject',
        label: 'Send back',
        icon: <XCircle size={14} />,
        onClick: () => void act(n, 'reject'),
      })
    }

    if (n.status === 'APPROVED') {
      items.push({
        key: 'post',
        label: 'Post to the bill',
        icon: <Landmark size={14} />,
        onClick: () => void act(n, 'post'),
      })
    }

    if (n.status === 'REJECTED') {
      items.push({
        key: 'reopen',
        label: 'Reopen as draft',
        icon: <RotateCcw size={14} />,
        onClick: () => void act(n, 'reopen'),
      })
    }

    items.push({
      key: 'print',
      label: 'Print',
      icon: <Printer size={14} />,
      href: `/print/purchase-note/${n.id}`,
      newTab: true,
    })

    if (n.status !== 'CANCELLED') {
      items.push({
        key: 'cancel',
        label: n.status === 'POSTED' ? 'Cancel and reverse' : 'Cancel note',
        icon: <Ban size={14} />,
        danger: true,
        onClick: () => void act(n, 'cancel'),
      })
    }

    if (n.status === 'DRAFT') {
      items.push({
        key: 'delete',
        label: 'Delete draft',
        icon: <Trash2 size={14} />,
        danger: true,
        onClick: () => void remove(n),
      })
    }

    return items
  }

  const anyFilter = Boolean(search || status || reason || supplierId || fromDate || toDate)

  const cards = useMemo(() => {
    const at = (k: NoteStatus) => summary[k] ?? { count: 0, amount: 0 }
    const waiting = {
      count: at('DRAFT').count + at('SUBMITTED').count + at('APPROVED').count,
      amount: at('DRAFT').amount + at('SUBMITTED').amount + at('APPROVED').amount,
    }
    return [
      {
        label: 'Still to post',
        value: String(waiting.count),
        sub: `₹${money(waiting.amount)} not yet on a bill`,
        tone: 'text-foreground',
      },
      {
        label: 'Awaiting approval',
        value: String(at('SUBMITTED').count),
        sub: `₹${money(at('SUBMITTED').amount)} waiting on somebody`,
        tone: 'text-amber-400',
      },
      {
        label: 'Posted',
        value: `₹${money(at('POSTED').amount)}`,
        sub: `${at('POSTED').count} note${at('POSTED').count === 1 ? '' : 's'} off the payable`,
        tone: 'text-emerald-400',
      },
      {
        label: 'Sent back or cancelled',
        value: String(at('REJECTED').count + at('CANCELLED').count),
        sub: `₹${money(at('REJECTED').amount + at('CANCELLED').amount)} claimed nothing`,
        tone: 'text-muted-foreground',
      },
    ]
  }, [summary])

  const Icon = moduleType === 'DEBIT' ? FileMinus : FilePlus2

  return (
    <div className="space-y-5">
      <div className="page-header flex-wrap gap-3">
        <div>
          <h1 className="page-title">{words.title}</h1>
          <p className="page-subtitle hidden sm:block">{words.subtitle}</p>
        </div>
        <div className="ml-auto flex items-center gap-2">
          <button className="btn-ghost" onClick={() => void load()} disabled={loading}>
            <RefreshCw size={15} className={loading ? 'animate-spin' : undefined} />
          </button>
          <button
            className="btn-primary"
            onClick={() => {
              setEditing(null)
              setDialogOpen(true)
            }}
          >
            <Plus size={15} />
            <span className="hidden sm:inline">{words.newLabel}</span>
            <span className="sm:hidden">New</span>
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
        <div className="flex items-start justify-between gap-3 rounded-lg border border-emerald-500/40 bg-emerald-500/5 p-3">
          <p className="text-sm text-emerald-400">{message}</p>
          <button
            className="text-emerald-400/70 hover:text-emerald-400"
            onClick={() => setMessage(null)}
            aria-label="Dismiss"
          >
            <XCircle size={15} />
          </button>
        </div>
      )}

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {cards.map((c) => (
          <div key={c.label} className="glass-card p-3">
            <p className="text-muted-foreground text-xs">{c.label}</p>
            <p className={`mt-1 text-lg font-semibold tabular-nums ${c.tone}`}>{c.value}</p>
            <p className="text-muted-foreground mt-0.5 text-[11px]">{c.sub}</p>
          </div>
        ))}
      </div>

      <div className="glass-card overflow-hidden p-0">
        {/* One row of filters, the way the reports screen settled on. Each
          control says what it is when nothing is chosen, so no labels are
          needed above them and the bar stays one line deep. */}
        <div className="border-border flex flex-wrap items-center gap-x-2 gap-y-2 border-b px-3 py-2">
          <div className="border-border bg-secondary flex min-w-0 shrink grow basis-full items-center gap-2 rounded-lg border px-2.5 py-1.5 sm:min-w-[150px] sm:max-w-[240px] sm:basis-0">
            <Search size={14} className="text-muted-foreground shrink-0" />
            <input
              className="text-foreground placeholder:text-muted-foreground min-w-0 flex-1 border-0 bg-transparent text-sm outline-none"
              placeholder="Note or bill number, supplier…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              aria-label={`Search ${words.one}s`}
            />
          </div>

          <select
            className="form-input h-8 w-full min-w-0 py-0 text-xs sm:w-36"
            value={status}
            onChange={(e) => setStatus(e.target.value)}
            aria-label="Filter by status"
          >
            <option value="">Any status</option>
            {Object.entries(NOTE_STATUS).map(([v, s]) => (
              <option key={v} value={v}>
                {s.label}
              </option>
            ))}
          </select>

          <select
            className="form-input h-8 w-full min-w-0 py-0 text-xs sm:w-40"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            aria-label="Filter by reason"
          >
            <option value="">Any reason</option>
            {Object.entries(REASON_WORDS).map(([v, label]) => (
              <option key={v} value={v}>
                {label}
              </option>
            ))}
          </select>

          <select
            className="form-input h-8 w-full min-w-0 py-0 text-xs sm:w-44"
            value={supplierId}
            onChange={(e) => setSupplierId(e.target.value)}
            aria-label="Filter by supplier"
          >
            <option value="">All suppliers</option>
            {suppliers.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>

          <div className="flex w-full min-w-0 shrink-0 items-center gap-1.5 sm:w-auto">
            <span className="text-muted-foreground shrink-0 text-xs">Raised</span>
            <input
              type="date"
              className="form-input h-8 min-w-0 flex-1 py-0 text-xs sm:w-[8.5rem] sm:flex-none"
              value={fromDate}
              max={toDate || undefined}
              onChange={(e) => setFromDate(e.target.value)}
              aria-label="Raised on or after"
            />
            <span className="text-muted-foreground shrink-0 text-xs">to</span>
            <input
              type="date"
              className="form-input h-8 min-w-0 flex-1 py-0 text-xs sm:w-[8.5rem] sm:flex-none"
              value={toDate}
              min={fromDate || undefined}
              onChange={(e) => setToDate(e.target.value)}
              aria-label="Raised on or before"
            />
          </div>

          {anyFilter && (
            <button
              className="btn-ghost h-8 shrink-0 px-2 text-xs"
              onClick={() => {
                setSearch('')
                setStatus('')
                setReason('')
                setSupplierId('')
                setFromDate('')
                setToDate('')
              }}
            >
              Clear
            </button>
          )}

          <span className="text-muted-foreground ml-auto shrink-0 text-xs tabular-nums">
            {total} {total === 1 ? words.one : `${words.one}s`}
          </span>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full min-w-[60rem] text-sm">
            <thead>
              <tr className="border-border bg-secondary/60 border-b text-left">
                <th className="w-8 px-3 py-2"></th>
                <th className="text-muted-foreground px-3 py-2 text-xs font-medium">Note</th>
                <th className="text-muted-foreground px-3 py-2 text-xs font-medium">Supplier</th>
                <th className="text-muted-foreground px-3 py-2 text-xs font-medium">
                  Against bill
                </th>
                <th className="text-muted-foreground px-3 py-2 text-xs font-medium">
                  What happened
                </th>
                <th className="text-muted-foreground px-3 py-2 text-right text-xs font-medium">
                  Taxable
                </th>
                <th className="text-muted-foreground px-3 py-2 text-right text-xs font-medium">
                  Tax
                </th>
                <th className="text-muted-foreground px-3 py-2 text-right text-xs font-medium">
                  Total
                </th>
                <th className="text-muted-foreground px-3 py-2 text-xs font-medium">Status</th>
                <th className="w-10 px-3 py-2"></th>
              </tr>
            </thead>
            <tbody>
              {loading && rows.length === 0 ? (
                <tr>
                  <td colSpan={10} className="text-muted-foreground px-3 py-10 text-center text-sm">
                    Loading…
                  </td>
                </tr>
              ) : rows.length === 0 ? (
                <tr>
                  <td colSpan={10} className="px-3 py-12 text-center">
                    <Icon size={26} className="text-muted-foreground mx-auto mb-2 opacity-40" />
                    <p className="text-foreground text-sm font-medium">
                      {anyFilter ? `No ${words.one}s match those filters` : `No ${words.one}s yet`}
                    </p>
                    <p className="text-muted-foreground mt-1 text-xs">
                      {anyFilter
                        ? 'Clear the filters to see everything.'
                        : moduleType === 'DEBIT'
                          ? 'One is raised for you whenever a supplier bills above the order rate.'
                          : 'Record one when a supplier sends you a credit note.'}
                    </p>
                  </td>
                </tr>
              ) : (
                rows.map((n) => {
                  const open = expanded === n.id
                  const tax = Number(n.cgst) + Number(n.sgst) + Number(n.igst)
                  const s = NOTE_STATUS[n.status]
                  return (
                    <Fragment key={n.id}>
                      <tr className="border-border/60 hover:bg-secondary/40 border-b transition-colors">
                        <td className="px-3 py-2">
                          <button
                            onClick={() => setExpanded(open ? null : n.id)}
                            className="text-muted-foreground hover:text-foreground"
                            aria-label={open ? 'Hide detail' : 'Show detail'}
                            aria-expanded={open}
                          >
                            {open ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
                          </button>
                        </td>
                        <td className="px-3 py-2">
                          <p className="text-foreground text-[13px] font-medium">{n.noteNumber}</p>
                          <p className="text-muted-foreground text-[11px]">
                            {formatDate(n.noteDate)}
                            {n.supplierDocNo ? ` · their ${n.supplierDocNo}` : ''}
                          </p>
                        </td>
                        <td className="px-3 py-2">
                          <p className="text-foreground truncate text-[13px]">{n.supplier.name}</p>
                          <p className="text-muted-foreground text-[11px]">{n.supplier.code}</p>
                        </td>
                        <td className="px-3 py-2">
                          {n.bill ? (
                            <>
                              <p className="text-foreground text-[13px]">{n.bill.billNumber}</p>
                              <p className="text-muted-foreground text-[11px]">
                                {n.bill.supplierInvoiceNo ?? formatDate(n.bill.billDate)}
                              </p>
                            </>
                          ) : (
                            <span
                              className="text-[12px] text-amber-400/90"
                              title={n.withoutBillReason ?? undefined}
                            >
                              No bill linked
                            </span>
                          )}
                        </td>
                        <td className="px-3 py-2">
                          <p className="text-foreground text-[13px]">
                            {REASON_WORDS[n.reason] ?? n.reason}
                          </p>
                          {n.reasonNote && (
                            <p className="text-muted-foreground max-w-[16rem] truncate text-[11px]">
                              {n.reasonNote}
                            </p>
                          )}
                        </td>
                        <td className="text-foreground px-3 py-2 text-right text-[13px] tabular-nums">
                          ₹{money(n.taxableAmount)}
                        </td>
                        <td className="text-muted-foreground px-3 py-2 text-right text-[13px] tabular-nums">
                          ₹{money(tax)}
                        </td>
                        <td className="px-3 py-2 text-right">
                          <span className="text-foreground text-[13px] font-semibold tabular-nums">
                            ₹{money(n.totalAmount)}
                          </span>
                          {n.effect === 'INCREASES_PAYABLE' && (
                            <span className="block text-[10px] text-amber-400">
                              adds to payable
                            </span>
                          )}
                        </td>
                        <td className="px-3 py-2">
                          <span className={s.cls} title={s.hint}>
                            {s.label}
                          </span>
                        </td>
                        <td className="px-3 py-2 text-right">
                          <ActionMenu label={n.noteNumber} items={rowActions(n)} />
                        </td>
                      </tr>
                      {open && (
                        <tr className="bg-secondary/20">
                          <td colSpan={10} className="px-3 pb-3 pt-1">
                            <RowPanel
                              icon={Icon}
                              title={`${n.noteNumber} — ${REASON_WORDS[n.reason] ?? n.reason}`}
                              note={`${n.lines.length} line${n.lines.length === 1 ? '' : 's'}`}
                            >
                              <NoteDetail note={n} />
                            </RowPanel>
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  )
                })
              )}
            </tbody>
          </table>
        </div>

        <Pagination page={page} pages={pages} onPageChange={setPage} busy={loading || busy} />
      </div>

      <PurchaseNoteDialog
        open={dialogOpen}
        moduleType={moduleType}
        record={editing}
        onClose={() => {
          setDialogOpen(false)
          setEditing(null)
        }}
        onSaved={() => {
          void load()
        }}
      />
    </div>
  )
}
