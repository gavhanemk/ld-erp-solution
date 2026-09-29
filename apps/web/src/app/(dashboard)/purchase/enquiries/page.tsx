'use client'

import { Fragment, useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import {
  AlertCircle,
  Check,
  ChevronDown,
  ChevronRight,
  Pencil,
  FileText,
  Plus,
  Printer,
  RefreshCw,
  RotateCcw,
  Scale,
  Search,
  Send,
  ShoppingCart,
  Trash2,
  X,
  XCircle,
} from 'lucide-react'
import { api, ApiError, apiErrorMessage, can } from '@/lib/api'
import { formatDate } from '@/lib/utils'
import { useAppSettings } from '@/lib/appSettings'
import { Pagination } from '@/components/tables/Pagination'
import { ActionMenu, type RowAction } from '@/components/tables/ActionMenu'
import { ReasonDialog } from '@/components/ui/ReasonDialog'
import { PurchaseEnquiryDialog } from '@/components/purchase/PurchaseEnquiryDialog'
import { EnquiryCompareDialog } from '@/components/purchase/EnquiryCompareDialog'
import { RowPanel } from '@/components/tables/RowPanel'
import {
  ENQUIRY_STATUS,
  money,
  qty,
  waitingFor,
  type EnquiryRecord,
  type EnquiryStatus,
} from '@/components/purchase/enquiryTypes'

/**
 * Purchase enquiries — what the mill asks its suppliers before it orders.
 *
 * The old ERP calls this a provisional PO. The buyer sends quantities and
 * usually no prices; each supplier answers with a proforma invoice quoting a
 * rate and how long he will hold it; the buyer compares what came back; and the
 * purchase order is raised against the winning PI.
 *
 * Dressed as the purchase order list is, down to the same `.data-table`, the
 * same badges, the same row menu and the same card layout below 700px. Five
 * screens in one module that each invent their own table do not read as one
 * application, and this one was the odd one out.
 */

const MODULE = 'purchase'

/**
 * What each card narrows the list to.
 *
 * A card and the rows it produces have to agree, so the card sends the same
 * query the status box would. `expiring` is the one that is not a status: a
 * quote whose validity has run out is still QUOTED, and it is the single thing
 * on this screen that goes stale on its own while nobody is looking.
 */
const CARD_FILTERS: Record<string, Record<string, string>> = {
  DRAFT: { status: 'DRAFT' },
  SENT: { status: 'SENT' },
  QUOTED: { status: 'QUOTED' },
  expiring: { expired: 'true' },
}

/*
 * The columns of the table inside an expanded row.
 *
 * Percentages, because the panel is as wide as the list is and the list moves
 * with the sidebar. Declared here rather than inline so the header and the
 * cells cannot drift apart — the order list keeps its own the same way.
 */
const INNER_COLS: Array<{ label: string; width: string }> = [
  { label: 'Item code', width: '14%' },
  { label: 'Item', width: '34%' },
  { label: 'HSN', width: '10%' },
  /* Which indent line this answers, where it came off one. Empty on an enquiry
     about something nobody requisitioned, which is ordinary. */
  { label: 'Against indent', width: '14%' },
  { label: 'Qty', width: '14%' },
  /* Ours, and the only rate on this table. What a supplier quoted is his, and
     it lives on the comparison window with his PI number beside it. */
  { label: 'We expected', width: '14%' },
]

const INNER_NUMERIC = ['Qty', 'We expected']

interface Meta {
  page: number
  pages: number
  total: number
  summary: Partial<Record<EnquiryStatus, number>>
  expiring: number
}

export default function PurchaseEnquiriesPage() {
  const { rowsPerPage } = useAppSettings()

  const [rows, setRows] = useState<EnquiryRecord[]>([])
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
  const [fromDate, setFromDate] = useState('')
  const [toDate, setToDate] = useState('')
  const [card, setCard] = useState('')

  const [options, setOptions] = useState<{
    suppliers: Array<{ id: string; code: string; name: string }>
  }>({ suppliers: [] })

  const [form, setForm] = useState<{ open: boolean; record: EnquiryRecord | null }>({
    open: false,
    record: null,
  })
  /** Which enquiry is open underneath its row, comparing what came back. */
  const [open, setOpen] = useState<string | null>(null)
  const [closing, setClosing] = useState<EnquiryRecord | null>(null)
  /** Which enquiry's answers are open in their own window. */
  const [comparing, setComparing] = useState<EnquiryRecord | null>(null)

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
    const params = new URLSearchParams({ page: String(page), limit: String(rowsPerPage) })
    if (debounced) params.set('q', debounced)
    if (status) params.set('status', status)
    if (supplierId) params.set('supplierId', supplierId)
    if (fromDate) params.set('from', fromDate)
    if (toDate) params.set('to', toDate)
    if (card) for (const [k, v] of Object.entries(CARD_FILTERS[card])) params.set(k, v)

    try {
      const res = await api.get<{ data: EnquiryRecord[]; meta: Meta }>(
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
  }, [page, debounced, status, supplierId, fromDate, toDate, card, rowsPerPage])

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

  /**
   * What this enquiry can actually take, in the order a buyer works.
   *
   * Nothing here that the server would refuse. Close and Delete disappear once
   * an order stands on it, because both are refused — and a button that always
   * answers with a refusal is worse than no button at all.
   */
  const rowActions = (e: EnquiryRecord): RowAction[] => {
    const items: RowAction[] = []
    const working = busy === e.id

    if (e.status === 'CLOSED') {
      if (can(MODULE, 'edit')) {
        items.push({
          key: 'reopen',
          label: 'Reopen enquiry',
          icon: <RotateCcw size={15} />,
          onClick: () =>
            void act(e.id, () =>
              api.patch<{ message: string }>('/purchase/enquiries/' + e.id + '/reopen', {})
            ),
          disabled: working,
        })
      }
      return items
    }

    if (can(MODULE, 'edit')) {
      items.push({
        key: 'edit',
        label: 'Edit enquiry',
        icon: <Pencil size={15} />,
        onClick: () => setForm({ open: true, record: e }),
        disabled: working,
      })
    }

    items.push({
      key: 'compare',
      label: e.supplierCount > 1 ? 'Compare what came back' : 'Suppliers and rates',
      icon: <Scale size={15} />,
      onClick: () => setComparing(e),
    })

    if (can(MODULE, 'edit') && e.quotes.some((q) => !q.sentAt)) {
      items.push({
        key: 'send',
        label:
          e.quotes.filter((q) => !q.sentAt).length === e.supplierCount
            ? 'Mark as sent'
            : 'Send to the rest',
        icon: <Send size={15} />,
        onClick: () =>
          void act(e.id, () =>
            api.patch<{ message: string }>('/purchase/enquiries/' + e.id + '/send', {})
          ),
        disabled: working || e.supplierCount === 0,
        hint: e.supplierCount === 0 ? 'Add a supplier first' : undefined,
      })
    }

    items.push({
      key: 'print',
      label: 'Print enquiry',
      icon: <Printer size={15} />,
      href: '/print/purchase-enquiry/' + e.id,
      newTab: true,
    })

    if (e.status !== 'ORDERED' && can(MODULE, 'edit')) {
      items.push({
        key: 'close',
        label: 'Close enquiry',
        icon: <XCircle size={15} />,
        onClick: () => setClosing(e),
        danger: true,
        disabled: working,
      })
    }

    if (e.status !== 'ORDERED' && can(MODULE, 'delete')) {
      items.push({
        key: 'delete',
        label: 'Delete enquiry',
        icon: <Trash2 size={15} />,
        onClick: () =>
          void act(e.id, () => api.delete<{ message: string }>('/purchase/enquiries/' + e.id)),
        danger: true,
        disabled: working,
      })
    }

    return items
  }

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
        label: 'Waiting on suppliers',
        value: s.SENT ?? 0,
        sub: 'no rates back yet',
        tone: 'text-sky-400',
      },
      {
        key: 'QUOTED',
        label: 'Quoted, not ordered',
        value: s.QUOTED ?? 0,
        sub: 'ready to compare and order',
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
    setFromDate('')
    setToDate('')
    setSearch('')
    setPage(1)
  }

  const filtered = Boolean(card || status || supplierId || debounced || fromDate || toDate)
  const pages = meta?.pages ?? 1

  /** The suppliers on a row, said in as few words as the cell allows. */
  const suppliersOf = (e: EnquiryRecord) => {
    if (e.supplierCount === 0) return 'Nobody yet'
    if (e.supplierCount === 1) return e.quotes[0].supplier.name
    return e.supplierCount + ' suppliers'
  }

  return (
    <div className="space-y-5">
      <div className="page-header gap-3">
        <div className="min-w-0">
          <h1 className="page-title text-xl sm:text-2xl">Purchase Enquiries</h1>
          <p className="page-subtitle hidden sm:block">
            What you ask suppliers before you order. They answer with a proforma invoice, and the
            order is raised against its number.
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <button className="btn-ghost" onClick={() => void load()} disabled={loading}>
            <RefreshCw size={15} className={loading ? 'animate-spin' : undefined} />
          </button>
          {can(MODULE, 'create') && (
            <button
              className="btn-primary"
              onClick={() => setForm({ open: true, record: null })}
              aria-label="New enquiry"
            >
              <Plus size={15} /> <span className="hidden sm:inline">New Enquiry</span>
            </button>
          )}
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
              placeholder="Enquiry no, PI no, reference, supplier, item"
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
            <option value="SENT">Waiting on suppliers</option>
            <option value="QUOTED">Quoted</option>
            <option value="ORDERED">Ordered</option>
            <option value="CLOSED">Closed</option>
          </select>
          {/* Two dates, not a preset list — the enquiry date, so "what did we
            ask about between the 3rd and the 11th" is answered directly. Each
            box caps the other, so a range that reads backwards cannot be typed.
            Same pair, same sizes, as the purchase order list. */}
          <div className="flex shrink-0 items-center gap-1">
            <input
              type="date"
              value={fromDate}
              max={toDate || undefined}
              onChange={(e) => {
                setFromDate(e.target.value)
                setPage(1)
              }}
              className="form-input w-auto"
              aria-label="Enquiries from this date"
            />
            <span className="text-muted-foreground hidden text-xs sm:inline">to</span>
            <input
              type="date"
              value={toDate}
              min={fromDate || undefined}
              onChange={(e) => {
                setToDate(e.target.value)
                setPage(1)
              }}
              className="form-input w-auto"
              aria-label="Enquiries up to this date"
            />
          </div>
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
          <div className="text-muted-foreground p-10 text-center text-sm">Loading enquiries…</div>
        ) : rows.length === 0 ? (
          <div className="p-10 text-center">
            <p className="text-foreground text-sm font-medium">
              {filtered ? 'Nothing matches those filters' : 'No enquiries yet'}
            </p>
            <p className="text-muted-foreground mx-auto mt-1 max-w-md text-xs">
              {filtered
                ? 'Clear them to see everything.'
                : 'Raise one when you need a rate before you can order. Where the rate is already known, go straight to a purchase order — this step is optional.'}
            </p>
          </div>
        ) : (
          <div className="list-scope">
            {/* On a narrow list each enquiry is a block rather than a table
              dragged sideways — the same trade the order list makes, and for
              the same reason: you cannot read the number and the value at once
              on a row that scrolls. Where it switches is decided by how wide
              the list is, not the window. See `.list-scope` in globals.css. */}
            <div className="list-cards divide-border divide-y">
              {rows.map((e) => {
                const s = ENQUIRY_STATUS[e.status]
                const expanded = open === e.id
                return (
                  <div key={e.id} className="p-3">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="font-mono text-sm font-medium">{e.enquiryNumber}</p>
                        <p className="text-muted-foreground text-xs">{suppliersOf(e)}</p>
                      </div>
                      <div className="flex shrink-0 items-center gap-2">
                        <span className={s.cls}>{s.label}</span>
                        <ActionMenu
                          label={`Actions for ${e.enquiryNumber}`}
                          items={rowActions(e)}
                        />
                      </div>
                    </div>
                    <div className="text-muted-foreground mt-2 grid grid-cols-2 gap-x-3 gap-y-1 text-xs">
                      <span>Date</span>
                      <span className="text-foreground">{formatDate(e.enquiryDate)}</span>
                      {e.best && (
                        <>
                          <span>Best quote</span>
                          <span className="text-foreground">
                            ₹{money(e.best.amount)} · {e.best.supplierName}
                          </span>
                        </>
                      )}
                      {e.reference && (
                        <>
                          <span>Reference</span>
                          <span className="text-foreground font-mono">{e.reference}</span>
                        </>
                      )}
                    </div>
                    {/* The same way in as the table has. A phone should not be
                      the one screen where the items and the comparison are
                      unreachable. */}
                    <button
                      type="button"
                      onClick={() => setOpen(expanded ? null : e.id)}
                      className="text-primary mt-2 flex items-center gap-1 text-xs"
                      aria-expanded={expanded}
                    >
                      {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                      {expanded ? 'Hide items' : 'Item details'}
                    </button>
                    {expanded && (
                      <div className="border-border divide-border/40 mt-2 divide-y rounded-lg border">
                        {e.lines.map((l) => (
                          <div key={l.id} className="flex items-start justify-between gap-3 p-2">
                            <div className="min-w-0">
                              <p className="truncate text-xs">{l.item.name}</p>
                              <p className="text-muted-foreground font-mono text-[10px]">
                                {l.item.code}
                              </p>
                            </div>
                            <p className="shrink-0 text-xs tabular-nums">
                              {qty(l.qty)}
                              <span className="text-muted-foreground ml-1 text-[10px]">
                                {l.item.uom?.symbol}
                              </span>
                            </p>
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
                  {/* Filled, not just underlined. Eight columns of small grey
                    capitals over white read as another row of data; a tint
                    says where the list starts. Same as the order list. */}
                  <tr className="bg-secondary">
                    <th style={{ width: 30 }} />
                    {/* One fact per column.
                      Five of these used to be a second line under another —
                      the location under the number, "2 of 2 answered" under
                      the supplier count, the order under the status. Stacked
                      pairs read as one thing, so nothing in them can be
                      scanned down or sorted on, and the cell they share ends
                      up two lines tall on every row whether or not it has both.

                      Which of them survives a narrow list is the `col-` tier:
                      full at 1390px and up, then wide, then roomy. Never
                      dropped: the number, the value, the status and the
                      actions. */}
                    <th className="whitespace-nowrap">Enquiry</th>
                    <th className="col-full whitespace-nowrap">Location</th>
                    <th className="col-roomy whitespace-nowrap">Date</th>
                    <th className="col-full whitespace-nowrap">Needed by</th>
                    <th className="col-full whitespace-nowrap">Reference</th>
                    <th className="col-wide whitespace-nowrap" style={{ textAlign: 'right' }}>
                      Items
                    </th>
                    <th className="col-roomy whitespace-nowrap" style={{ textAlign: 'right' }}>
                      Asked
                    </th>
                    <th className="col-wide whitespace-nowrap" style={{ textAlign: 'right' }}>
                      Answered
                    </th>
                    <th className="whitespace-nowrap">Best quote</th>
                    <th className="whitespace-nowrap" style={{ textAlign: 'right' }}>
                      Value
                    </th>
                    <th className="whitespace-nowrap">Status</th>
                    <th className="col-roomy whitespace-nowrap">Order</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {rows.map((e) => {
                    const s = ENQUIRY_STATUS[e.status]
                    const expanded = open === e.id
                    const waiting = e.quotes.find((q) => q.sentAt && !q.answered)
                    return (
                      <Fragment key={e.id}>
                        <tr className={expanded ? 'bg-secondary/30' : undefined}>
                          {/* The toggle gets a cell of its own rather than
                            hiding on the number. A row that opens only when you
                            happen to press the right four characters is a row
                            most people never open — and the whole comparison
                            lives underneath it. */}
                          <td>
                            <button
                              type="button"
                              className="bg-primary/10 text-primary hover:bg-primary/20 flex h-7 w-7 items-center justify-center rounded-lg transition-colors"
                              onClick={() => setOpen(expanded ? null : e.id)}
                              title={expanded ? 'Hide items' : 'Show items'}
                              aria-label={`${expanded ? 'Hide' : 'Show'} items on ${e.enquiryNumber}`}
                              aria-expanded={expanded}
                            >
                              {expanded ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
                            </button>
                          </td>
                          <td>
                            <a
                              href={'/print/purchase-enquiry/' + e.id}
                              target="_blank"
                              rel="noreferrer"
                              className="whitespace-nowrap font-mono text-xs font-semibold text-teal-400 hover:underline"
                              title={'Open the printed sheet for ' + e.enquiryNumber}
                            >
                              {e.enquiryNumber}
                            </a>
                          </td>
                          <td className="col-full text-muted-foreground max-w-[9rem] truncate text-xs">
                            <span title={e.location?.name ?? 'Head office'}>
                              {e.location?.name ?? 'Head office'}
                            </span>
                          </td>
                          <td className="col-roomy whitespace-nowrap text-xs">
                            {formatDate(e.enquiryDate)}
                          </td>
                          <td className="col-full whitespace-nowrap text-xs">
                            {e.requiredDate ? (
                              formatDate(e.requiredDate)
                            ) : (
                              <span className="text-muted-foreground/60">—</span>
                            )}
                          </td>
                          <td className="col-full whitespace-nowrap">
                            {e.reference ? (
                              <span className="font-mono text-xs">{e.reference}</span>
                            ) : (
                              <span className="text-muted-foreground/60 text-xs">—</span>
                            )}
                          </td>
                          <td
                            className="col-wide text-xs tabular-nums"
                            style={{ textAlign: 'right' }}
                          >
                            {e.lines.length}
                          </td>
                          <td
                            className="col-roomy text-xs tabular-nums"
                            style={{ textAlign: 'right' }}
                          >
                            {e.supplierCount}
                          </td>
                          {/* Answered against asked, because "two of three are
                            back" is the fact a buyer chasing quotes needs, and
                            it cannot be read off either count alone. How long
                            the slowest of them has had it goes underneath —
                            it is the same fact, aged. */}
                          <td className="col-wide" style={{ textAlign: 'right' }}>
                            <p className="text-xs tabular-nums">
                              {e.answeredCount} of {e.supplierCount}
                            </p>
                            {waiting && (
                              <p className="text-muted-foreground text-[11px]">
                                waiting {waitingFor(waiting.sentAt)}
                              </p>
                            )}
                          </td>
                          {/* The winner, named. The whole reason this document
                            exists is to answer "which of them is cheapest",
                            and a list that made the buyer open each enquiry to
                            find out would not have answered it. */}
                          <td>
                            {e.best ? (
                              <>
                                <p
                                  className="max-w-[11rem] truncate text-sm"
                                  title={e.best.supplierName}
                                >
                                  {e.best.supplierName}
                                </p>
                                {!e.comparable && (
                                  <p className="text-[11px] text-amber-400">
                                    priced {e.best.pricedLines} of {e.lines.length}
                                  </p>
                                )}
                              </>
                            ) : (
                              <span className="text-muted-foreground/60 text-xs">
                                {e.supplierCount === 0 ? 'no supplier yet' : 'no rates yet'}
                              </span>
                            )}
                          </td>
                          <td style={{ textAlign: 'right' }}>
                            {e.best ? (
                              <>
                                <p className="whitespace-nowrap text-sm font-medium tabular-nums">
                                  ₹{money(e.best.amount)}
                                </p>
                                {e.expired && (
                                  <p className="text-[11px] font-medium text-red-400">lapsed</p>
                                )}
                              </>
                            ) : (
                              <span className="text-muted-foreground/60 text-xs">—</span>
                            )}
                          </td>
                          <td>
                            <span className={s.cls}>{s.label}</span>
                          </td>
                          {/* The orders raised from it. Under the status they
                            read as part of it; the status is derived from them,
                            which is not the same thing as being them. */}
                          <td className="col-roomy">
                            {e.purchaseOrders.length > 0 ? (
                              <div className="space-y-0.5">
                                {e.purchaseOrders.map((po) => (
                                  <Link
                                    key={po.id}
                                    href={'/purchase/orders?q=' + po.poNumber}
                                    className="text-primary block font-mono text-[11px] hover:underline"
                                  >
                                    {po.poNumber}
                                  </Link>
                                ))}
                              </div>
                            ) : (
                              <span className="text-muted-foreground/60 text-xs">—</span>
                            )}
                          </td>
                          <td>
                            <ActionMenu
                              label={`Actions for ${e.enquiryNumber}`}
                              items={rowActions(e)}
                            />
                          </td>
                        </tr>
                        {expanded && e.lines.length > 0 && (
                          <tr>
                            {/* The lines, and nothing else. The chevron on the
                              order list opens into exactly this, and a row that
                              opened into three supplier cards, a rates grid and
                              a strip of buttons was a row that opened into a
                              wall. What came back from the suppliers has its own
                              window, off the Actions menu. */}
                            <td colSpan={14} className="bg-secondary/40 !px-2 !pb-2 !pt-0">
                              <RowPanel
                                icon={FileText}
                                title="Item Details"
                                note={`${e.lines.length} ${
                                  e.lines.length === 1 ? 'line' : 'lines'
                                } on ${e.enquiryNumber}`}
                              >
                                <table className="subtable w-full table-fixed">
                                  <thead className="sticky top-0 z-10">
                                    <tr>
                                      {INNER_COLS.map(({ label: h, width }) => (
                                        <th
                                          key={h}
                                          style={{ width }}
                                          className={
                                            INNER_NUMERIC.includes(h) ? 'text-right' : undefined
                                          }
                                        >
                                          {h}
                                        </th>
                                      ))}
                                    </tr>
                                  </thead>
                                  <tbody>
                                    {e.lines.map((l, i) => (
                                      <tr
                                        key={l.id}
                                        className="border-border/40 border-b last:border-0"
                                      >
                                        <td className="text-muted-foreground whitespace-nowrap px-3 py-1.5 font-mono text-xs">
                                          {l.item.code}
                                        </td>
                                        <td className="px-3 py-1.5">
                                          <p className="text-xs">{l.item.name}</p>
                                          {l.description && (
                                            <p className="text-muted-foreground text-[10px]">
                                              {l.description}
                                            </p>
                                          )}
                                        </td>
                                        <td className="text-muted-foreground px-3 py-1.5 text-xs">
                                          {l.hsnCode ?? '—'}
                                        </td>
                                        <td className="text-muted-foreground px-3 py-1.5 text-xs">
                                          {l.mrLine?.mr.mrNumber ?? '—'}
                                        </td>
                                        <td className="px-3 py-1.5 text-right text-xs tabular-nums">
                                          {qty(l.qty)}
                                          <span className="text-muted-foreground ml-1 text-[10px]">
                                            {l.item.uom?.symbol}
                                          </span>
                                        </td>
                                        <td className="text-muted-foreground px-3 py-1.5 text-right text-xs tabular-nums">
                                          {l.expectedRate == null ? '—' : money(l.expectedRate)}
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
      </div>

      {pages > 1 && <Pagination page={page} pages={pages} onPageChange={setPage} busy={loading} />}

      {form.open && (
        <PurchaseEnquiryDialog
          record={form.record}
          onClose={() => setForm({ open: false, record: null })}
          onSaved={(saved, id) => {
            setForm({ open: false, record: null })
            setMessage(saved)
            // Straight into the detail panel, because the next thing the buyer
            // does is add suppliers and record what comes back.
            if (id) setOpen(id)
            void load()
          }}
        />
      )}

      {comparing && (
        <EnquiryCompareDialog
          enquiryId={comparing.id}
          enquiryNumber={comparing.enquiryNumber}
          onClose={() => setComparing(null)}
          onChanged={(msg) => {
            if (msg) setMessage(msg)
            void load()
          }}
          onError={setError}
        />
      )}

      {closing && (
        <ReasonDialog
          title={'Close ' + closing.enquiryNumber}
          description="Say why it is being dropped. Somebody looking at this in three weeks needs to know whether every rate was too high, nobody answered, or the job was cancelled."
          confirmLabel="Close enquiry"
          danger
          onCancel={() => setClosing(null)}
          onConfirm={(reason) => {
            const row = closing
            setClosing(null)
            void act(row.id, () =>
              api.patch<{ message: string }>('/purchase/enquiries/' + row.id + '/close', { reason })
            )
          }}
        />
      )}
    </div>
  )
}
