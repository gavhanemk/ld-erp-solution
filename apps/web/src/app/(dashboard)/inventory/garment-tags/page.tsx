'use client'

import { Fragment, useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { AlertTriangle, Barcode, CheckCircle2, ChevronDown, ChevronRight, Loader2, Printer, RefreshCw, ScanLine, Search, Shirt, Tags, X } from 'lucide-react'
import { api, ApiError, can } from '@/lib/api'
import { ScrollableTable } from '@/components/tables/ScrollableTable'
import { BuyerLabelsDialog } from '@/components/inventory/BuyerLabelsDialog'

interface Order {
  id: string
  moNumber: string
  status: string
  tagGarments: boolean
  planned: number
  soNumber: string | null
  customerPORef: string | null
  customer: string | null
  styles: string[]
  received: number
  tagged: number
  printed: number
}

interface OrderDetail {
  id: string
  moNumber: string
  tagGarments: boolean
  rows: Array<{
    key: string
    itemId: string
    itemCode: string
    item: string
    style: string
    color: string
    sizeId: string | null
    size: string
    grade: string
    received: number
    tagged: number
    printed: number
    inStock: number
  }>
  receipts: Array<{ id: string; fgrNumber: string; receiptDate: string; store: string; cancelled: boolean; pieces: number }>
  totals: { received: number; tagged: number; printed: number; inStock: number }
}

const n = (x: number) => x.toLocaleString('en-IN')

/** Opens labels for printing: an order, or one item, size and grade of it. */
const openLabels = (moId: string, part: { itemId?: string; sizeId?: string | null; grade?: string } = {}, only: 'new' | 'all' = 'new') => {
  const qs = new URLSearchParams({ moId, only })
  if (part.itemId) qs.set('itemId', part.itemId)
  if (part.sizeId !== undefined) qs.set('sizeId', part.sizeId ?? '')
  if (part.grade) qs.set('grade', part.grade)
  window.open(`/print/garments?${qs}`, '_blank')
}

/**
 * Garment tags: one QR label per finished piece.
 *
 * An order is switched on; once its pieces are received into finished goods
 * they are given their codes here, size by size or all at once, and the labels
 * printed. A label printed again keeps its code.
 */
export default function GarmentTagsPage() {
  const [orders, setOrders] = useState<Order[]>([])
  const [q, setQ] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [openId, setOpenId] = useState<string | null>(null)
  const [detail, setDetail] = useState<OrderDetail | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  // The order whose buyer stickers are being set up and printed.
  const [buyerFor, setBuyerFor] = useState<string | null>(null)
  const editor = can('inventory', 'edit')
  const creator = can('inventory', 'create')

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const res = await api.get<{ data: Order[] }>(`/garments/orders${q.trim() ? `?q=${encodeURIComponent(q.trim())}` : ''}`)
      setOrders(res.data)
      setError(null)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load the orders.')
    } finally {
      setLoading(false)
    }
  }, [q])

  useEffect(() => {
    const t = setTimeout(() => void load(), q ? 300 : 0)
    return () => clearTimeout(t)
  }, [load, q])

  const loadDetail = useCallback(async (id: string) => {
    const res = await api.get<{ data: OrderDetail }>(`/garments/orders/${id}`)
    setDetail(res.data)
  }, [])

  const toggleOpen = async (o: Order) => {
    if (openId === o.id) {
      setOpenId(null)
      return
    }
    setOpenId(o.id)
    setDetail(null)
    try {
      await loadDetail(o.id)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load the order.')
    }
  }

  const act = async (key: string, run: () => Promise<{ message?: string }>) => {
    setBusy(key)
    setError(null)
    setMessage(null)
    try {
      const res = await run()
      if (res.message) setMessage(res.message)
      await load()
      if (openId) await loadDetail(openId)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save. Is the API running?')
    } finally {
      setBusy(null)
    }
  }

  const switchTags = (o: Order, on: boolean) => act(`switch-${o.id}`, () => api.patch(`/garments/orders/${o.id}`, { tagGarments: on }))
  const generate = (moId: string, part: { itemId?: string; sizeId?: string | null; grade?: string } = {}, key = 'all') =>
    act(`gen-${moId}-${key}`, () => api.post(`/garments/orders/${moId}/generate`, part))

  const totals = orders.reduce((t, o) => ({ on: t.on + (o.tagGarments ? 1 : 0), tagged: t.tagged + o.tagged, printed: t.printed + o.printed }), { on: 0, tagged: 0, printed: 0 })

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <h1 className="page-title mr-auto" title="One QR label per finished garment">
          Garment Tags
        </h1>
        <Figure value={totals.on} label={totals.on === 1 ? 'order tagged' : 'orders tagged'} />
        <Figure value={totals.tagged} label="pieces tagged" />
        <Figure value={totals.printed} label="labels printed" />
        <button className="btn-ghost h-9" onClick={() => void load()} disabled={loading} title="Refresh">
          <RefreshCw size={15} className={loading ? 'animate-spin' : undefined} />
        </button>
        <Link href="/inventory/scan" className="btn-primary h-9">
          <ScanLine size={15} /> Scan
        </Link>
      </div>

      {message && (
        <div className="flex items-center gap-3 rounded-xl border border-emerald-500/40 bg-emerald-500/10 px-3 py-2 text-emerald-600">
          <CheckCircle2 size={18} className="shrink-0" />
          <p className="font-medium">{message}</p>
          <button className="ml-auto" onClick={() => setMessage(null)} aria-label="Dismiss">
            <X size={16} />
          </button>
        </div>
      )}
      {error && (
        <p className="flex items-start gap-2 rounded-xl border border-red-500/40 bg-red-500/5 px-3 py-2 text-sm text-red-400">
          <AlertTriangle size={16} className="mt-0.5 shrink-0" /> {error}
        </p>
      )}

      <div className="glass-card overflow-hidden p-0">
        <div className="relative z-20 flex flex-wrap items-center gap-2 border-b border-border px-3 py-2">
          <div className="flex h-9 min-w-[220px] flex-1 items-center gap-2 rounded-lg border border-border bg-secondary px-3">
            <Search size={14} className="text-muted-foreground" />
            <input
              className="flex-1 border-0 bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground"
              placeholder="Search MO, sales order, buyer or style…"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              aria-label="Search orders"
            />
          </div>
          <span className="text-xs text-muted-foreground">Orders with pieces received into finished goods, or switched on for tags</span>
        </div>

        {orders.length === 0 ? (
          <div className="p-10 text-center text-muted-foreground">
            {loading ? 'Loading…' : q ? 'No order matches that.' : 'No order has pieces in finished goods yet. Pieces are tagged once they are received there.'}
          </div>
        ) : (
          <ScrollableTable>
            <table className="data-table table-compact min-w-full">
              <thead>
                <tr className="bg-secondary">
                  <th className="w-8" />
                  <th>Manufacturing order</th>
                  <th>For</th>
                  <th>Style · colour</th>
                  <th>Garment tags</th>
                  <th style={{ textAlign: 'right' }}>Received</th>
                  <th style={{ textAlign: 'right' }}>Tagged</th>
                  <th style={{ textAlign: 'right' }}>Printed</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {orders.map((o) => {
                  const isOpen = openId === o.id
                  const toTag = Math.max(0, o.received - o.tagged)
                  return (
                    <Fragment key={o.id}>
                      <tr className={`cursor-pointer ${isOpen ? 'bg-primary/5' : ''}`} onClick={() => void toggleOpen(o)}>
                        <td className="text-muted-foreground">{isOpen ? <ChevronDown size={16} /> : <ChevronRight size={16} />}</td>
                        <td className="whitespace-nowrap font-mono text-sm font-semibold text-foreground">{o.moNumber}</td>
                        <td>
                          <div className="text-sm text-foreground">{o.customer ?? 'For stock'}</div>
                          <div className="text-xs text-muted-foreground">
                            {o.soNumber ?? ''}
                            {o.customerPORef ? ` · PO ${o.customerPORef}` : ''}
                          </div>
                        </td>
                        <td className="max-w-[260px] truncate text-sm" title={o.styles.join(', ')}>
                          {o.styles.join(', ')}
                        </td>
                        <td onClick={(e) => e.stopPropagation()}>
                          <Switch
                            on={o.tagGarments}
                            disabled={!editor || busy === `switch-${o.id}`}
                            onChange={(v) => void switchTags(o, v)}
                            label={`Garment tags for ${o.moNumber}`}
                          />
                        </td>
                        <td className="whitespace-nowrap text-right tabular-nums">{n(o.received)}</td>
                        <td className="whitespace-nowrap text-right font-semibold tabular-nums">{n(o.tagged)}</td>
                        <td className="whitespace-nowrap text-right tabular-nums">{n(o.printed)}</td>
                        <td className="whitespace-nowrap text-right" onClick={(e) => e.stopPropagation()}>
                          {o.tagGarments && toTag > 0 && creator && (
                            <button className="btn-primary h-8" disabled={busy !== null} onClick={() => void generate(o.id)}>
                              {busy === `gen-${o.id}-all` ? <Loader2 size={14} className="animate-spin" /> : <Tags size={14} />} Tag {n(toTag)}
                            </button>
                          )}
                          {o.tagged > o.printed && (
                            <button className="btn-secondary ml-1 h-8" onClick={() => openLabels(o.id)}>
                              <Printer size={14} /> Print {n(o.tagged - o.printed)} new
                            </button>
                          )}
                          {/* The buyer's own barcode sticker, for a customer's order. */}
                          {o.customer && (
                            <button className="btn-ghost ml-1 h-8" onClick={() => setBuyerFor(o.id)} title="The barcode sticker the buyer's brand wants on each garment or pack">
                              <Barcode size={14} /> Buyer stickers
                            </button>
                          )}
                        </td>
                      </tr>
                      {isOpen && (
                        <tr>
                          <td colSpan={9} className="p-0">
                            <OrderPanel
                              order={o}
                              detail={detail?.id === o.id ? detail : null}
                              busy={busy}
                              creator={creator}
                              onGenerate={(part, key) => void generate(o.id, part, key)}
                            />
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  )
                })}
              </tbody>
            </table>
          </ScrollableTable>
        )}
      </div>
      {buyerFor && (
        <BuyerLabelsDialog
          moId={buyerFor}
          onClose={() => setBuyerFor(null)}
          onSaved={(m) => {
            setBuyerFor(null)
            setMessage(m)
          }}
        />
      )}
    </div>
  )
}

/** An order opened: size by size, what is received, tagged and printed. */
function OrderPanel({
  order,
  detail,
  busy,
  creator,
  onGenerate,
}: {
  order: Order
  detail: OrderDetail | null
  busy: string | null
  creator: boolean
  onGenerate: (part: { itemId: string; sizeId: string | null; grade: string }, key: string) => void
}) {
  if (!detail) {
    return (
      <p className="flex items-center gap-2 px-12 py-4 text-sm text-muted-foreground">
        <Loader2 size={15} className="animate-spin" /> Loading the order…
      </p>
    )
  }
  const t = detail.totals
  return (
    <div className="border-y border-primary/20 bg-secondary/30">
      <div className="flex flex-wrap items-center gap-x-5 gap-y-1 px-4 py-2 text-sm">
        <span>
          <span className="font-bold text-foreground">{n(t.received)}</span> <span className="text-muted-foreground">received into finished goods</span>
        </span>
        <span>
          <span className="font-bold text-foreground">{n(t.tagged)}</span> <span className="text-muted-foreground">tagged</span>
        </span>
        <span>
          <span className="font-bold text-foreground">{n(t.printed)}</span> <span className="text-muted-foreground">labels printed</span>
        </span>
        {t.received - t.tagged > 0 && (
          <span className="warn-text">
            <span className="font-bold">{n(t.received - t.tagged)}</span> waiting for a tag
          </span>
        )}
        <span>
          <span className="font-bold text-foreground">{n(t.inStock)}</span> <span className="text-muted-foreground">tagged pieces in stock</span>
        </span>
        <span className="ml-auto text-xs text-muted-foreground">
          {detail.receipts.filter((r) => !r.cancelled).map((r) => `${r.fgrNumber} (${r.pieces})`).join(' · ')}
        </span>
      </div>
      {!detail.tagGarments && (
        <p className="border-t border-border px-4 py-2 text-sm warn-text">
          Switch <span className="font-semibold">Garment tags</span> on for {order.moNumber} to give its pieces their codes.
        </p>
      )}
      <div className="border-t border-border bg-card">
        <table className="data-table table-compact w-full [&>tbody>tr>td]:py-1.5">
          <thead>
            <tr className="bg-secondary">
              <th>Style · colour</th>
              <th>Size</th>
              <th>Grade</th>
              <th style={{ textAlign: 'right' }}>Received</th>
              <th style={{ textAlign: 'right' }}>Tagged</th>
              <th style={{ textAlign: 'right' }}>Printed</th>
              <th style={{ textAlign: 'right' }}>To tag</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {detail.rows.map((r) => {
              const toTag = Math.max(0, r.received - r.tagged)
              const part = { itemId: r.itemId, sizeId: r.sizeId, grade: r.grade }
              return (
                <tr key={r.key}>
                  <td>
                    <div className="flex items-center gap-2">
                      <Shirt size={14} className="shrink-0 text-muted-foreground" />
                      <span className="font-medium text-foreground">{r.style}</span>
                      <span className="text-muted-foreground">· {r.color}</span>
                    </div>
                  </td>
                  <td className="font-semibold">{r.size}</td>
                  <td>{r.grade === 'B' ? <span className="badge badge-warning">B</span> : 'A'}</td>
                  <td className="text-right tabular-nums">{n(r.received)}</td>
                  <td className="text-right font-semibold tabular-nums">{n(r.tagged)}</td>
                  <td className="text-right tabular-nums">{n(r.printed)}</td>
                  <td className={`text-right tabular-nums ${toTag ? 'warn-text font-semibold' : 'text-muted-foreground'}`}>{toTag ? n(toTag) : '—'}</td>
                  <td className="whitespace-nowrap text-right">
                    {toTag > 0 && detail.tagGarments && creator && (
                      <button className="btn-primary h-7 text-xs" disabled={busy !== null} onClick={() => onGenerate(part, r.key)}>
                        {busy === `gen-${order.id}-${r.key}` ? <Loader2 size={13} className="animate-spin" /> : <Tags size={13} />} Tag {n(toTag)}
                      </button>
                    )}
                    {r.tagged > r.printed && (
                      <button className="btn-secondary ml-1 h-7 text-xs" onClick={() => openLabels(order.id, part, 'new')}>
                        <Printer size={13} /> Print {n(r.tagged - r.printed)} new
                      </button>
                    )}
                    {r.printed > 0 && (
                      <button className="btn-ghost ml-1 h-7 text-xs" onClick={() => openLabels(order.id, part, 'all')} title="Print every label of this size again, with the same codes">
                        <Printer size={13} /> Reprint all
                      </button>
                    )}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}

function Figure({ value, label }: { value: number; label: string }) {
  return (
    <span className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-border bg-card px-3 text-sm">
      <span className="font-bold tabular-nums text-foreground">{n(value)}</span>
      <span className="text-muted-foreground">{label}</span>
    </span>
  )
}

/** An on/off switch. */
function Switch({ on, onChange, disabled, label }: { on: boolean; onChange: (v: boolean) => void; disabled?: boolean; label: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!on)}
      className={`inline-flex h-6 w-11 shrink-0 items-center rounded-full border transition-colors disabled:opacity-50 ${on ? 'border-primary bg-primary' : 'border-border bg-secondary'}`}
    >
      <span className={`h-5 w-5 rounded-full bg-white shadow transition-transform ${on ? 'translate-x-5' : 'translate-x-0.5'}`} />
    </button>
  )
}
