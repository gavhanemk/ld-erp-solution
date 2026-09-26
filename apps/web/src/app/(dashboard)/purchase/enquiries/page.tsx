'use client'

import { Fragment, useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import {
  AlertCircle,
  Check,
  Pencil,
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
import { EnquiryDetail } from '@/components/purchase/EnquiryDetail'
import {
  ENQUIRY_STATUS,
  money,
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
  }, [page, debounced, status, supplierId, card, rowsPerPage])

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
      label: e.supplierCount > 1 ? 'Compare suppliers' : 'Open enquiry',
      icon: <Scale size={15} />,
      onClick: () => setOpen((cur) => (cur === e.id ? null : e.id)),
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
    setSearch('')
    setPage(1)
  }

  const filtered = Boolean(card || status || supplierId || debounced)
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
                  </div>
                )
              })}
            </div>

            <div className="list-rows w-full">
              <table className="data-table table-compact w-full">
                <thead>
                  {/* Filled, not just underlined. Eight columns of small grey
                    capitals over white read as another row of data; a tint
                    says where the list starts. Same as the order list. */}
                  <tr className="bg-secondary">
                    <th>Enquiry</th>
                    <th>Suppliers</th>
                    <th className="col-roomy">Date</th>
                    <th className="col-full">Reference</th>
                    <th className="col-full">Items</th>
                    <th>Best quote</th>
                    <th style={{ textAlign: 'right' }}>Value</th>
                    <th>Status</th>
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
                          <td>
                            <button
                              type="button"
                              onClick={() => setOpen(expanded ? null : e.id)}
                              className="hover:text-primary text-left font-mono text-xs font-medium"
                              aria-expanded={expanded}
                            >
                              {e.enquiryNumber}
                            </button>
                            {e.location && (
                              <p className="text-muted-foreground text-[11px]">{e.location.name}</p>
                            )}
                          </td>
                          <td>
                            <p className="text-sm">{suppliersOf(e)}</p>
                            {/* Answered against asked, because "two of three
                              are back" is the fact a buyer chasing quotes
                              needs, and it cannot be read off a count. */}
                            {e.supplierCount > 0 && (
                              <p className="text-muted-foreground text-[11px]">
                                {e.answeredCount} of {e.supplierCount} answered
                                {waiting && ` · waiting ${waitingFor(waiting.sentAt)}`}
                              </p>
                            )}
                          </td>
                          <td className="col-roomy">
                            <p className="text-xs">{formatDate(e.enquiryDate)}</p>
                            {e.requiredDate && (
                              <p className="text-muted-foreground text-[11px]">
                                needed {formatDate(e.requiredDate)}
                              </p>
                            )}
                          </td>
                          <td className="col-full">
                            {e.reference ? (
                              <span className="font-mono text-xs">{e.reference}</span>
                            ) : (
                              <span className="text-muted-foreground/60 text-xs">—</span>
                            )}
                          </td>
                          <td className="col-full text-muted-foreground text-xs">
                            {e.lines.length === 1
                              ? e.lines[0].item.name
                              : e.lines.length + ' items'}
                          </td>
                          {/* The winner, named. The whole reason this document
                            exists is to answer "which of them is cheapest",
                            and a list that made the buyer open each enquiry to
                            find out would not have answered it. */}
                          <td>
                            {e.best ? (
                              <>
                                <p className="text-sm">{e.best.supplierName}</p>
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
                                <p className="text-sm font-medium tabular-nums">
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
                            {e.purchaseOrders.length > 0 && (
                              <div className="mt-1 space-y-0.5">
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
                            )}
                          </td>
                          <td>
                            <ActionMenu
                              label={`Actions for ${e.enquiryNumber}`}
                              items={rowActions(e)}
                            />
                          </td>
                        </tr>
                        {expanded && (
                          <tr>
                            <td colSpan={9} className="bg-secondary/20 p-0">
                              <EnquiryDetail
                                enquiryId={e.id}
                                onChanged={(msg) => {
                                  if (msg) setMessage(msg)
                                  void load()
                                }}
                                onError={setError}
                              />
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
