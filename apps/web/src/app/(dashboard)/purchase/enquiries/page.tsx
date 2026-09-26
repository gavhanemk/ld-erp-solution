'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import {
  AlertCircle,
  CalendarClock,
  Check,
  ChevronLeft,
  ChevronRight,
  FileText,
  Loader2,
  Plus,
  RotateCcw,
  Search,
  Send,
  ShoppingCart,
  Trash2,
  X,
  XCircle,
} from 'lucide-react'
import { api, ApiError, apiErrorMessage, can } from '@/lib/api'
import { formatDate } from '@/lib/utils'
import { ReasonDialog } from '@/components/ui/ReasonDialog'
import {
  PurchaseEnquiryDialog,
  type EnquiryRecord,
} from '@/components/purchase/PurchaseEnquiryDialog'
import { RecordQuoteDialog } from '@/components/purchase/RecordQuoteDialog'

/**
 * Purchase enquiries — what the mill asks a supplier before it commits.
 *
 * The old ERP calls this a provisional PO. The buyer sends quantities and
 * usually no prices; the supplier answers with a proforma invoice quoting a rate
 * and how long he will hold it; the purchase order is raised against that PI.
 *
 * The screen is built around the one question a buyer actually has when they
 * open it: **which of these is waiting on me?** Everything else — the value, the
 * item count, who raised it — is detail behind that. So the cards are the four
 * states of waiting, and the row leads with the supplier and how long he has
 * had it rather than with a document number nobody remembers.
 */

const MODULE = 'purchase'

type Status = 'DRAFT' | 'SENT' | 'QUOTED' | 'ORDERED' | 'CLOSED'

/**
 * What each card narrows the list to.
 *
 * A card and the rows it produces have to agree, so the card sends the same
 * query the box below would. `expiring` is the one that is not a status: a quote
 * whose validity has run out is still QUOTED, and it is the single thing on this
 * screen that goes stale on its own while nobody is looking.
 */
const CARD_FILTERS: Record<string, Record<string, string>> = {
  DRAFT: { status: 'DRAFT' },
  SENT: { status: 'SENT' },
  QUOTED: { status: 'QUOTED' },
  expiring: { expired: 'true' },
}

const STATUS_STYLE: Record<Status, { label: string; className: string }> = {
  DRAFT: { label: 'Draft', className: 'bg-secondary text-muted-foreground' },
  SENT: { label: 'Sent', className: 'bg-sky-500/15 text-sky-400' },
  QUOTED: { label: 'Quoted', className: 'bg-amber-500/15 text-amber-400' },
  ORDERED: { label: 'Ordered', className: 'bg-emerald-500/15 text-emerald-400' },
  CLOSED: { label: 'Closed', className: 'bg-secondary text-muted-foreground line-through' },
}

const money = (v: unknown) =>
  Number(v ?? 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

const qty = (v: unknown) => Number(v ?? 0).toLocaleString('en-IN', { maximumFractionDigits: 3 })

/** How long the supplier has had it, in the words a buyer would use. */
function waitingFor(sentAt: string | null): string | null {
  if (!sentAt) return null
  const days = Math.floor((Date.now() - new Date(sentAt).getTime()) / 86_400_000)
  if (days <= 0) return 'today'
  if (days === 1) return '1 day'
  if (days < 14) return days + ' days'
  if (days < 60) return Math.floor(days / 7) + ' weeks'
  return Math.floor(days / 30) + ' months'
}

interface Row extends EnquiryRecord {
  quotedValue: number
  expectedValue: number
  quotedLines: number
  expired: boolean
  purchaseOrders: Array<{
    id: string
    poNumber: string
    poDate: string
    status: string
    totalAmount: string
  }>
}

interface Meta {
  page: number
  pages: number
  total: number
  summary: Partial<Record<Status, number>>
  expiring: number
}

export default function PurchaseEnquiriesPage() {
  const [rows, setRows] = useState<Row[]>([])
  const [meta, setMeta] = useState<Meta | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)

  const [page, setPage] = useState(1)
  const [search, setSearch] = useState('')
  const [debounced, setDebounced] = useState('')
  const [status, setStatus] = useState('')
  const [supplierId, setSupplierId] = useState('')
  const [card, setCard] = useState('')

  const [options, setOptions] = useState<{
    suppliers: Array<{ id: string; code: string; name: string }>
  }>({ suppliers: [] })

  const [form, setForm] = useState<{ open: boolean; record: EnquiryRecord | null }>({
    open: false,
    record: null,
  })
  const [quoting, setQuoting] = useState<Row | null>(null)
  const [closing, setClosing] = useState<Row | null>(null)

  useEffect(() => {
    const t = setTimeout(() => {
      setDebounced(search)
      setPage(1)
    }, 300)
    return () => clearTimeout(t)
  }, [search])

  /*
   * Fetched once, from every enquiry ever raised rather than from the rows on
   * screen. A dropdown built from the page offers nothing on an empty page and
   * hides the value somebody is filtering down to — which is exactly what the
   * receipts filters were doing before they were fixed.
   */
  useEffect(() => {
    api
      .get<{ data: { suppliers: Array<{ id: string; code: string; name: string }> } }>(
        '/purchase/enquiries/filter-options'
      )
      .then((r) => setOptions({ suppliers: r.data.suppliers }))
      .catch(() => {})
  }, [])

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    const params = new URLSearchParams({ page: String(page), limit: '20' })
    if (debounced) params.set('q', debounced)
    if (status) params.set('status', status)
    if (supplierId) params.set('supplierId', supplierId)
    if (card) for (const [k, v] of Object.entries(CARD_FILTERS[card])) params.set(k, v)

    try {
      const res = await api.get<{ data: Row[]; meta: Meta }>(
        '/purchase/enquiries?' + params.toString()
      )
      setRows(res.data)
      setMeta(res.meta)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load enquiries.')
      setRows([])
    } finally {
      setLoading(false)
    }
  }, [page, debounced, status, supplierId, card])

  useEffect(() => {
    void load()
  }, [load])

  /** One helper for every action, so each one reports the same way. */
  const act = useCallback(
    async (id: string, run: () => Promise<{ message?: string }>) => {
      setBusy(id)
      setError(null)
      setMessage(null)
      try {
        const res = await run()
        if (res.message) setMessage(res.message)
        await load()
      } catch (err) {
        setError(apiErrorMessage(err, 'That did not go through.'))
      } finally {
        setBusy(null)
      }
    },
    [load]
  )

  const send = (row: Row) =>
    act(row.id, () => api.patch<{ message: string }>('/purchase/enquiries/' + row.id + '/send', {}))

  const reopen = (row: Row) =>
    act(row.id, () =>
      api.patch<{ message: string }>('/purchase/enquiries/' + row.id + '/reopen', {})
    )

  const remove = (row: Row) =>
    act(row.id, () => api.delete<{ message: string }>('/purchase/enquiries/' + row.id))

  const cards = useMemo(() => {
    const s = meta?.summary ?? {}
    return [
      {
        key: 'DRAFT',
        label: 'Not yet sent',
        value: s.DRAFT ?? 0,
        sub: 'still on our desk',
        tone: 'text-muted-foreground',
      },
      {
        key: 'SENT',
        label: 'Waiting on supplier',
        value: s.SENT ?? 0,
        sub: 'no rates back yet',
        tone: 'text-sky-400',
      },
      {
        key: 'QUOTED',
        label: 'Quoted, not ordered',
        value: s.QUOTED ?? 0,
        sub: 'ready to raise an order',
        tone: 'text-amber-400',
      },
      {
        key: 'expiring',
        label: 'Price lapsed',
        value: meta?.expiring ?? 0,
        sub: 'validity has run out',
        tone: (meta?.expiring ?? 0) > 0 ? 'text-red-400' : 'text-muted-foreground',
      },
    ]
  }, [meta])

  const clearAll = () => {
    setCard('')
    setStatus('')
    setSupplierId('')
    setSearch('')
    setPage(1)
  }

  const filtered = Boolean(card || status || supplierId || debounced)

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-foreground text-xl font-semibold">Purchase Enquiries</h1>
          <p className="text-muted-foreground mt-0.5 text-sm">
            What we ask a supplier before we order. He answers with a proforma invoice, and the
            order is raised against its number.
          </p>
        </div>
        {can(MODULE, 'create') && (
          <button
            type="button"
            onClick={() => setForm({ open: true, record: null })}
            className="btn-primary"
          >
            <Plus size={15} />
            New enquiry
          </button>
        )}
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

      {/* Pressable, and pressing the pressed one clears it — so the card is the
          way back out as well as the way in. Choosing a status in the box below
          clears the card for the same reason: two controls narrowing the same
          thing with only one of them showing what it did is how a filter starts
          lying about itself. */}
      <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
        {cards.map((c) => {
          const on = card === c.key
          return (
            <button
              key={c.key}
              type="button"
              onClick={() => {
                setCard(on ? '' : c.key)
                setStatus('')
                setPage(1)
              }}
              aria-pressed={on}
              title={on ? 'Showing only these — press to clear' : 'Show only these'}
              className={`glass-card cursor-pointer p-2 text-left transition-colors ${
                on ? 'ring-primary bg-primary/5 ring-2' : 'hover:bg-secondary/40'
              }`}
            >
              <p className="text-muted-foreground text-[10px] leading-tight">{c.label}</p>
              <p className={`text-sm font-semibold tabular-nums leading-tight ${c.tone}`}>
                {c.value}
              </p>
              <p className="text-muted-foreground mt-0.5 text-[10px] leading-snug">{c.sub}</p>
            </button>
          )
        })}
      </div>

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
              placeholder="Enquiry no, PI no, supplier, item"
              className="form-input pl-8"
            />
          </div>
          <select
            value={status}
            onChange={(e) => {
              setStatus(e.target.value)
              setCard('')
              setPage(1)
            }}
            className="form-input w-auto"
          >
            <option value="">Any status</option>
            <option value="DRAFT">Not yet sent</option>
            <option value="SENT">Waiting on supplier</option>
            <option value="QUOTED">Quoted</option>
            <option value="ORDERED">Ordered</option>
            <option value="CLOSED">Closed</option>
          </select>
          <select
            value={supplierId}
            onChange={(e) => {
              setSupplierId(e.target.value)
              setPage(1)
            }}
            className="form-input w-auto"
          >
            <option value="">Any supplier</option>
            {options.suppliers.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
          {filtered && (
            <button type="button" onClick={clearAll} className="btn-ghost text-xs">
              <X size={14} />
              Clear
            </button>
          )}
        </div>

        {loading ? (
          <div className="text-muted-foreground flex items-center justify-center gap-2 p-10 text-sm">
            <Loader2 size={16} className="animate-spin" />
            Loading enquiries
          </div>
        ) : rows.length === 0 ? (
          <div className="p-10 text-center">
            <FileText size={28} className="text-muted-foreground/40 mx-auto" />
            <p className="text-foreground mt-3 text-sm font-medium">
              {filtered ? 'Nothing matches those filters' : 'No enquiries yet'}
            </p>
            <p className="text-muted-foreground mx-auto mt-1 max-w-md text-xs">
              {filtered
                ? 'Clear them to see everything.'
                : 'Raise one when you need a rate before you can order. Where the rate is already known, go straight to a purchase order — this step is optional.'}
            </p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-secondary/40 text-muted-foreground text-[11px] uppercase">
                <tr>
                  <th className="px-3 py-2 text-left font-medium">Enquiry</th>
                  <th className="px-3 py-2 text-left font-medium">Supplier</th>
                  <th className="px-3 py-2 text-left font-medium">Items</th>
                  <th className="px-3 py-2 text-left font-medium">Proforma invoice</th>
                  <th className="px-3 py-2 text-right font-medium">Value</th>
                  <th className="px-3 py-2 text-left font-medium">Status</th>
                  <th className="px-3 py-2 text-right font-medium">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-border/60 divide-y">
                {rows.map((row) => {
                  const waiting = waitingFor(row.sentAt)
                  const working = busy === row.id
                  return (
                    <tr key={row.id} className="hover:bg-secondary/20">
                      <td className="px-3 py-2 align-top">
                        <p className="font-mono text-xs font-medium">{row.enquiryNumber}</p>
                        <p className="text-muted-foreground text-[11px]">
                          {formatDate(row.enquiryDate)}
                        </p>
                        {row.requiredDate && (
                          <p className="text-muted-foreground text-[11px]">
                            needed {formatDate(row.requiredDate)}
                          </p>
                        )}
                      </td>
                      <td className="px-3 py-2 align-top">
                        <p className="font-medium">{row.supplier?.name}</p>
                        {/* How long he has had it, which is the question a buyer
                            actually has about a sent enquiry. */}
                        {waiting && row.status === 'SENT' && (
                          <p className="text-muted-foreground flex items-center gap-1 text-[11px]">
                            <CalendarClock size={11} />
                            waiting {waiting}
                          </p>
                        )}
                      </td>
                      <td className="text-muted-foreground px-3 py-2 align-top text-xs">
                        {row.lines.length === 1
                          ? row.lines[0].item.name
                          : row.lines.length + ' items'}
                        {row.lines.length > 1 && (
                          <p className="text-[11px]">
                            {qty(row.lines.reduce((t, l) => t + Number(l.qty), 0))} total
                          </p>
                        )}
                      </td>
                      <td className="px-3 py-2 align-top">
                        {row.piNumber ? (
                          <>
                            <p className="font-mono text-xs">{row.piNumber}</p>
                            <p className="text-muted-foreground text-[11px]">
                              {row.piDate && formatDate(row.piDate)}
                            </p>
                            {/* The one fact on this document that goes stale
                                while nobody is looking, so it is said out loud
                                rather than left as a date to work out. */}
                            {row.expired ? (
                              <p className="text-[11px] font-medium text-red-400">
                                lapsed {row.piValidUntil && formatDate(row.piValidUntil)}
                              </p>
                            ) : (
                              row.piValidUntil && (
                                <p className="text-muted-foreground text-[11px]">
                                  holds to {formatDate(row.piValidUntil)}
                                </p>
                              )
                            )}
                          </>
                        ) : (
                          <span className="text-muted-foreground/60 text-xs">—</span>
                        )}
                      </td>
                      {/* Three figures could go here and only one is the truth
                          at a time, so the cell says which it is showing. His PI
                          total wins when we have it; the rates he quoted are
                          next; our own estimate is last and is greyed, because
                          it is a guess and must not read as a price. */}
                      <td className="px-3 py-2 text-right align-top">
                        {row.piAmount != null ? (
                          <>
                            <p className="text-xs font-medium tabular-nums">
                              ₹{money(row.piAmount)}
                            </p>
                            <p className="text-muted-foreground text-[10px]">his PI total</p>
                          </>
                        ) : row.quotedValue > 0 ? (
                          <>
                            <p className="text-xs font-medium tabular-nums">
                              ₹{money(row.quotedValue)}
                            </p>
                            <p className="text-muted-foreground text-[10px]">
                              {row.quotedLines} of {row.lines.length} priced
                            </p>
                          </>
                        ) : row.expectedValue > 0 ? (
                          <>
                            <p className="text-muted-foreground text-xs tabular-nums">
                              ₹{money(row.expectedValue)}
                            </p>
                            <p className="text-muted-foreground text-[10px]">our estimate</p>
                          </>
                        ) : (
                          <span className="text-muted-foreground/60 text-xs">—</span>
                        )}
                      </td>
                      <td className="px-3 py-2 align-top">
                        <span
                          className={`inline-block rounded px-1.5 py-0.5 text-[10px] font-medium ${
                            STATUS_STYLE[row.status as Status].className
                          }`}
                        >
                          {STATUS_STYLE[row.status as Status].label}
                        </span>
                        {row.purchaseOrders.length > 0 && (
                          <div className="mt-1 space-y-0.5">
                            {row.purchaseOrders.map((po) => (
                              <Link
                                key={po.id}
                                href={'/purchase/orders?q=' + po.poNumber}
                                className="text-primary block font-mono text-[11px] hover:underline"
                              >
                                {po.poNumber}
                              </Link>
                            ))}
                          </div>
                        )}
                        {row.status === 'CLOSED' && row.closeReason && (
                          <p className="text-muted-foreground mt-1 max-w-[180px] text-[10px]">
                            {row.closeReason}
                          </p>
                        )}
                      </td>
                      {/* Only what this enquiry can actually take.
                          Delete and Close are gone once an order stands on it,
                          because the server refuses both — and a button that
                          always answers with a refusal is worse than no button.
                          Editing stays, narrowly: the server allows correcting
                          the part nobody has ordered. */}
                      <td className="px-3 py-2 align-top">
                        <div className="flex flex-wrap items-center justify-end gap-1">
                          {working && <Loader2 size={14} className="animate-spin" />}
                          {row.status === 'CLOSED' ? (
                            can(MODULE, 'edit') && (
                              <button
                                type="button"
                                onClick={() => reopen(row)}
                                disabled={working}
                                className="btn-ghost text-xs"
                                title="Put it back on the list"
                              >
                                <RotateCcw size={13} />
                                Reopen
                              </button>
                            )
                          ) : (
                            <>
                              {can(MODULE, 'edit') && (
                                <button
                                  type="button"
                                  onClick={() => setForm({ open: true, record: row })}
                                  disabled={working}
                                  className="btn-ghost text-xs"
                                >
                                  Edit
                                </button>
                              )}
                              {row.status === 'DRAFT' && can(MODULE, 'edit') && (
                                <button
                                  type="button"
                                  onClick={() => send(row)}
                                  disabled={working}
                                  className="btn-ghost text-xs"
                                  title="Mark as sent to the supplier"
                                >
                                  <Send size={13} />
                                  Send
                                </button>
                              )}
                              {(row.status === 'SENT' || row.status === 'QUOTED') &&
                                can(MODULE, 'edit') && (
                                  <button
                                    type="button"
                                    onClick={() => setQuoting(row)}
                                    disabled={working}
                                    className="btn-ghost text-xs"
                                    title={row.piNumber ? 'Record a revised PI' : 'Record his PI'}
                                  >
                                    <Check size={13} />
                                    {row.piNumber ? 'Revise PI' : 'Record PI'}
                                  </button>
                                )}
                              {row.status === 'QUOTED' && can(MODULE, 'create') && (
                                <Link
                                  href={'/purchase/orders?fromEnquiry=' + row.id}
                                  className="btn-primary text-xs"
                                  title="Raise a purchase order against this PI"
                                >
                                  <ShoppingCart size={13} />
                                  Order
                                </Link>
                              )}
                              {row.status !== 'ORDERED' && can(MODULE, 'edit') && (
                                <button
                                  type="button"
                                  onClick={() => setClosing(row)}
                                  disabled={working}
                                  className="btn-ghost text-xs"
                                  title="Drop it, with a reason"
                                >
                                  Close
                                </button>
                              )}
                              {row.status !== 'ORDERED' && can(MODULE, 'delete') && (
                                <button
                                  type="button"
                                  onClick={() => remove(row)}
                                  disabled={working}
                                  className="btn-ghost text-xs text-red-400"
                                  title="Move to the recycle bin"
                                >
                                  <Trash2 size={13} />
                                </button>
                              )}
                            </>
                          )}
                        </div>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}

        {meta && meta.pages > 1 && (
          <div className="border-border/70 flex items-center justify-between border-t p-3">
            <p className="text-muted-foreground text-xs">
              Page {meta.page} of {meta.pages} · {meta.total} enquir
              {meta.total === 1 ? 'y' : 'ies'}
            </p>
            <div className="flex gap-1">
              <button
                type="button"
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                disabled={page <= 1}
                className="btn-ghost text-xs"
              >
                <ChevronLeft size={14} />
                Back
              </button>
              <button
                type="button"
                onClick={() => setPage((p) => Math.min(meta.pages, p + 1))}
                disabled={page >= meta.pages}
                className="btn-ghost text-xs"
              >
                Next
                <ChevronRight size={14} />
              </button>
            </div>
          </div>
        )}
      </div>

      {form.open && (
        <PurchaseEnquiryDialog
          record={form.record}
          onClose={() => setForm({ open: false, record: null })}
          onSaved={(saved) => {
            setForm({ open: false, record: null })
            setMessage(saved)
            void load()
          }}
        />
      )}

      {quoting && (
        <RecordQuoteDialog
          enquiry={quoting}
          onClose={() => setQuoting(null)}
          onSaved={(saved) => {
            setQuoting(null)
            setMessage(saved)
            void load()
          }}
        />
      )}

      {closing && (
        <ReasonDialog
          title={'Close ' + closing.enquiryNumber}
          description="Say why it is being dropped. Somebody looking at this in three weeks needs to know whether the rate was too high, the supplier never answered, or the job was cancelled."
          confirmLabel="Close enquiry"
          onCancel={() => setClosing(null)}
          onConfirm={async (reason) => {
            const row = closing
            setClosing(null)
            await act(row.id, () =>
              api.patch<{ message: string }>('/purchase/enquiries/' + row.id + '/close', { reason })
            )
          }}
        />
      )}
    </div>
  )
}
