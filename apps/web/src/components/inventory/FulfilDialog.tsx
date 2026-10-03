'use client'

import { useEffect, useMemo, useState } from 'react'
import { Loader2, PackageCheck, Info, History, ChevronDown, ChevronRight } from 'lucide-react'
import { api, ApiError, currentUser } from '@/lib/api'
import { FormFrame } from '@/components/ui/FormFrame'
import { formatDate } from '@/lib/utils'

/**
 * Fulfilling an approved requisition, line by line: what to hand over now and
 * from which racks, and how much to buy.
 *
 * Every store holding the item is listed with what it has, so the store can
 * make a line up from several racks instead of only the one it was asked of.
 * What is still short can be bought — just the shortfall, the whole line, or
 * more than was asked with the extra going into stock. The buy quantity is the
 * indent the buyer sees on the purchase order form.
 */

interface Line {
  id: string
  requestedQty: string | number
  issuedQty: string | number
  fulfilment?: 'FROM_STOCK' | 'PURCHASE'
  purchaseQty?: string | number | null
  purpose: string | null
  ownership?: 'OWNED' | 'CUSTOMER_OWNED'
  ownerCustomer?: { id: string; name: string } | null
  item: {
    id: string
    code: string
    name: string
    uom: { symbol: string }
    category?: { name: string; parent: { name: string } | null } | null
  }
  warehouse: { id: string; name: string }
}

interface Requisition {
  id: string
  mrNumber: string
  requiredDate: string | null
  notes: string | null
  department: { id: string; name: string }
  raisedBy: { id: string; name: string } | null
  approvedBy: { id: string; name: string } | null
  lines: Line[]
}

interface Bought {
  lineId: string
  buyQty: number
  orderedQty: number
  receivedQty: number
  poNumbers: string[]
  orders?: Array<{
    poId: string
    poNumber: string
    poDate: string
    status?: string
    deliveryDate?: string | null
    qty: number
    receivedQty: number
  }>
}

/** A purchase order's status, as the buyer's list words it. */
const PO_STATUS: Record<string, { text: string; cls: string }> = {
  DRAFT: { text: 'Draft — not sent', cls: 'badge-neutral' },
  SENT: { text: 'Sent to supplier', cls: 'badge-info' },
  PARTIALLY_RECEIVED: { text: 'Part received', cls: 'badge-warning' },
  COMPLETED: { text: 'Received', cls: 'badge-success' },
}

/** One hand-over against the requisition, from the stock ledger. */
interface Handover {
  itemId: string
  ownership: string
  ownerCustomerId: string | null
  warehouseName: string
  qty: number
  at: string
}

/** One entry in the requisition's audit trail. */
interface TrailEvent {
  at: string
  who: string
  action: string
  handedOver: string[] | null
  plan: Array<{ lineId: string; buyQty: number }> | null
  closeReason: string | null
  /** From the old issue-or-buy answer: the items it marked to be bought. */
  toBuy?: string[] | null
}

const when = (d: string) =>
  new Date(d).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', timeZone: 'Asia/Kolkata' })

interface StockRow {
  itemId: string
  warehouseId: string
  warehouseName: string
  ownership: 'OWNED' | 'CUSTOMER_OWNED'
  ownerCustomerId: string | null
  qty: number
}

const fmt = (v: number) => v.toLocaleString('en-IN', { maximumFractionDigits: 3 })
const r3 = (v: number) => Math.round(v * 1000) / 1000
const num = (v: string) => (v.trim() === '' ? 0 : Number(v))

export function FulfilDialog({
  mrId,
  initial,
  onClose,
  onDone,
}: {
  mrId: string
  /** The list's copy: the window draws from it at once, and takes only live figures from the server. */
  initial: Requisition
  onClose: () => void
  onDone: (message: string) => void
}) {
  const [mr, setMr] = useState<Requisition | null>(initial)
  const [bought, setBought] = useState<Bought[]>([])
  const [stock, setStock] = useState<StockRow[]>([])
  const [handovers, setHandovers] = useState<Handover[]>([])
  const [events, setEvents] = useState<TrailEvent[]>([])
  const [showHistory, setShowHistory] = useState(false)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  /** Per line, per store: how much to hand over now. */
  const [issue, setIssue] = useState<Record<string, Record<string, string>>>({})
  /** Per line: how much to buy. */
  const [buy, setBuy] = useState<Record<string, string>>({})

  const me = currentUser()

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const res = await api.get<{
          data: {
            lines: Array<{ id: string; requestedQty: number; issuedQty: number; purchaseQty: number | null; fulfilment: Line['fulfilment'] }>
            bought: Bought[]
            stock: StockRow[]
            handovers: Handover[]
            events: TrailEvent[]
          }
        }>(`/inventory/requisitions/${mrId}/fulfil`)
        if (cancelled) return
        // The latest issued and buy quantities, in case the list is a moment old.
        const fresh = new Map(res.data.lines.map((l) => [l.id, l]))
        setMr((prev) =>
          prev
            ? {
                ...prev,
                lines: prev.lines.map((l) => {
                  const f = fresh.get(l.id)
                  return f ? { ...l, requestedQty: f.requestedQty, issuedQty: f.issuedQty, purchaseQty: f.purchaseQty, fulfilment: f.fulfilment } : l
                }),
              }
            : prev,
        )
        setBought(res.data.bought ?? [])
        setStock(res.data.stock ?? [])
        setHandovers(res.data.handovers ?? [])
        setEvents(res.data.events ?? [])
      } catch (err) {
        if (!cancelled) setError(err instanceof ApiError ? err.message : 'Could not open the requisition.')
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [mrId])

  // Raised, approved and handed over by three people; the Admin may do all three.
  const canIssue = !!mr && (me?.role === 'Admin' || (me?.id !== mr.raisedBy?.id && me?.id !== mr.approvedBy?.id))
  const whyNot =
    mr && !canIssue
      ? me?.id === mr.raisedBy?.id
        ? 'You raised this requisition, so somebody else in the store hands it over. You can still set what to buy.'
        : 'You approved this requisition, so somebody else in the store hands it over. You can still set what to buy.'
      : null

  /** Every store holding this line's stock — ours, or that customer's — the asked store first. */
  const storesFor = (l: Line) => {
    const theirs = l.ownership === 'CUSTOMER_OWNED'
    const by = new Map<string, { id: string; name: string; qty: number }>()
    for (const r of stock) {
      if (r.itemId !== l.item.id || r.qty <= 0) continue
      if (theirs ? r.ownership !== 'CUSTOMER_OWNED' || r.ownerCustomerId !== l.ownerCustomer?.id : r.ownership !== 'OWNED') continue
      const cur = by.get(r.warehouseId) ?? { id: r.warehouseId, name: r.warehouseName, qty: 0 }
      cur.qty += r.qty
      by.set(r.warehouseId, cur)
    }
    if (!by.has(l.warehouse.id)) by.set(l.warehouse.id, { id: l.warehouse.id, name: l.warehouse.name, qty: 0 })
    return [...by.values()].sort((a, b) => (a.id === l.warehouse.id ? -1 : b.id === l.warehouse.id ? 1 : b.qty - a.qty))
  }

  const owedOf = (l: Line) => r3(Math.max(0, Number(l.requestedQty) - Number(l.issuedQty)))
  const boughtOf = (l: Line) => bought.find((b) => b.lineId === l.id)

  // Start from the obvious answer: hand over what the racks have, asked store
  // first, and buy whatever is still short (or keep what was already planned).
  useEffect(() => {
    if (!mr || loading) return
    const nextIssue: Record<string, Record<string, string>> = {}
    const nextBuy: Record<string, string> = {}
    for (const l of mr.lines) {
      // What is already planned to be bought is left for the purchase to cover;
      // the racks are offered for the rest, so an earlier "buy it" is not doubled.
      const alreadyBuying = Math.max(0, (boughtOf(l)?.buyQty ?? 0) - (boughtOf(l)?.receivedQty ?? 0))
      let need = r3(Math.max(0, owedOf(l) - alreadyBuying))
      const per: Record<string, string> = {}
      for (const s of storesFor(l)) {
        const take = canIssue ? Math.min(s.qty, need) : 0
        per[s.id] = take > 0 ? String(r3(take)) : ''
        need = r3(need - take)
      }
      nextIssue[l.id] = per
      // Buy what all the racks together cannot cover, unless a figure was already set.
      const planned = boughtOf(l)?.buyQty ?? 0
      const onRacks = storesFor(l).reduce((t, st) => t + st.qty, 0)
      const theirs = l.ownership === 'CUSTOMER_OWNED'
      nextBuy[l.id] = theirs ? '0' : String(planned > 0 ? planned : r3(Math.max(0, owedOf(l) - onRacks)))
    }
    setIssue(nextIssue)
    setBuy(nextBuy)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mr, stock, bought, loading])

  const issuingOf = (l: Line) => r3(Object.values(issue[l.id] ?? {}).reduce((t, v) => t + num(v), 0))

  /** Everything the window would do, and anything that would stop it. */
  const summary = useMemo(() => {
    if (!mr) return null
    const problems: string[] = []
    let issueLines = 0
    let buyChanges = 0
    let buyLines = 0
    for (const l of mr.lines) {
      const unit = l.item.uom.symbol
      const owed = owedOf(l)
      const giving = issuingOf(l)
      if (giving > owed + 1e-9) problems.push(`${l.item.name}: handing over ${fmt(giving)} ${unit}, but only ${fmt(owed)} is owed.`)
      for (const s of storesFor(l)) {
        const v = num(issue[l.id]?.[s.id] ?? '')
        if (Number.isNaN(v) || v < 0) problems.push(`${l.item.name}: the quantity from ${s.name} is not a number.`)
        else if (v > s.qty + 1e-9) problems.push(`${l.item.name}: ${s.name} has only ${fmt(s.qty)} ${unit}.`)
      }
      if (giving > 0) issueLines += 1
      const b = num(buy[l.id] ?? '0')
      const was = boughtOf(l)
      if (Number.isNaN(b) || b < 0) problems.push(`${l.item.name}: the quantity to buy is not a number.`)
      else if (was && b + 1e-9 < was.orderedQty)
        problems.push(`${l.item.name}: ${fmt(was.orderedQty)} ${unit} is already ordered, so buy at least that.`)
      if (b > 0) buyLines += 1
      if (Math.abs(b - (was?.buyQty ?? 0)) > 1e-9) buyChanges += 1
    }
    return { problems, issueLines, buyChanges, buyLines }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mr, issue, buy, stock, bought])

  const save = async () => {
    if (!mr || !summary) return
    setError(null)
    if (summary.problems.length) return setError(summary.problems[0])
    if (!summary.issueLines && !summary.buyChanges) return setError('Nothing to do: enter a quantity to hand over or to buy.')

    setSaving(true)
    const done: string[] = []
    try {
      // What to buy first: it cannot fail on stock, and an issue that then
      // fails still leaves the indent right.
      if (summary.buyChanges) {
        const res = await api.patch<{ message?: string }>(`/inventory/requisitions/${mr.id}/plan`, {
          lines: mr.lines.map((l) => ({ lineId: l.id, buyQty: r3(num(buy[l.id] ?? '0')) })),
        })
        if (res.message) done.push(res.message)
      }
      if (summary.issueLines && canIssue) {
        const lines = mr.lines.flatMap((l) =>
          Object.entries(issue[l.id] ?? {})
            .map(([warehouseId, v]) => ({ lineId: l.id, warehouseId, issueQty: r3(num(v)) }))
            .filter((a) => a.issueQty > 0),
        )
        const res = await api.post<{ message?: string }>(`/inventory/requisitions/${mr.id}/issue`, { lines })
        if (res.message) done.push(res.message)
      }
      onDone(done.join(' ') || 'Saved.')
    } catch (err) {
      setError(
        (done.length ? `${done.join(' ')} But: ` : '') + (err instanceof ApiError ? err.message : 'Could not save. Try again.'),
      )
    } finally {
      setSaving(false)
    }
  }

  const confirm = (
    <button type="button" className="btn-primary" onClick={() => void save()} disabled={saving || loading || !mr}>
      {saving ? <Loader2 size={15} className="animate-spin" /> : <PackageCheck size={15} />}
      Confirm
    </button>
  )

  /** What Confirm will do, in words: "Hand over 500 mtr Interlining from Trims · buy 500 mtr". */
  const doing = (() => {
    if (!mr || !summary) return null
    const parts: string[] = []
    for (const l of mr.lines) {
      const unit = l.item.uom.symbol
      const giving = issuingOf(l)
      if (giving > 0) {
        const from = storesFor(l)
          .filter((st) => num(issue[l.id]?.[st.id] ?? '') > 0)
          .map((st) => st.name)
          .join(' + ')
        parts.push(`hand over ${fmt(giving)} ${unit} ${l.item.name} from ${from}`)
      }
      const b = num(buy[l.id] ?? '0')
      const was = boughtOf(l)?.buyQty ?? 0
      if (Math.abs(b - was) > 1e-9) parts.push(b > 0 ? `set ${fmt(b)} ${unit} ${l.item.name} to buy` : `stop buying ${l.item.name}`)
    }
    return parts.length ? parts.join(' · ') : null
  })()

  return (
    <FormFrame
      icon={PackageCheck}
      title={mr ? `Fulfil ${mr.mrNumber}` : 'Fulfil requisition'}
      subtitle={
        mr
          ? `${mr.department.name}${mr.raisedBy ? ` · raised by ${mr.raisedBy.name}` : ''}${mr.approvedBy ? ` · approved by ${mr.approvedBy.name}` : ''}${mr.requiredDate ? ` · needed by ${formatDate(mr.requiredDate)}` : ''}`
          : 'Opening…'
      }
      width="max-w-6xl"
      primary={confirm}
      footer={
        <button type="button" className="btn-secondary" onClick={onClose} disabled={saving}>
          Cancel
        </button>
      }
      footerNote={doing ? `Confirm will ${doing}.` : 'Nothing changed yet. Enter what to hand over, or change what to buy.'}
      error={error}
      onClose={onClose}
      busy={saving}
    >
      {!mr ? (
        <p className="px-2 py-10 text-center text-sm text-muted-foreground">{loading ? 'Opening the requisition…' : null}</p>
      ) : (
        <>
          {whyNot && (
            <div className="flex items-start gap-2 rounded-lg border border-amber-500/40 bg-amber-500/5 p-3 text-sm text-amber-600 dark:text-amber-400">
              <Info size={16} className="mt-0.5 shrink-0" /> {whyNot}
            </div>
          )}
          {mr.notes && <p className="px-1 text-xs text-muted-foreground">Note on the requisition: {mr.notes}</p>}
          {loading && (
            <p className="flex items-center gap-2 px-1 text-xs text-muted-foreground">
              <Loader2 size={13} className="animate-spin" /> Checking every store&apos;s stock…
            </p>
          )}

          {mr.lines.map((l) => {
            const unit = l.item.uom.symbol
            const asked = Number(l.requestedQty)
            const issued = Number(l.issuedQty)
            const owed = owedOf(l)
            const stores = storesFor(l)
            const available = r3(stores.reduce((t, st) => t + st.qty, 0))
            const giving = issuingOf(l)
            const shortAfter = r3(Math.max(0, owed - giving))
            const theirs = l.ownership === 'CUSTOMER_OWNED'
            const was = boughtOf(l)
            const buyNow = num(buy[l.id] ?? '0')
            const cat = l.item.category
            const status =
              owed === 0
                ? { cls: 'badge-success', text: 'Handed over in full' }
                : available >= owed
                  ? { cls: 'badge-success', text: 'In stock' }
                  : available > 0
                    ? { cls: 'badge-warning', text: 'Part in stock' }
                    : { cls: 'badge-danger', text: 'Not in stock' }
            /*
             * The bar, out of what was asked: handed over (green), arrived on an
             * order and waiting to be handed over (teal), on order (blue), and to
             * buy but not ordered yet (amber). What none of these cover is grey.
             */
            const pct = (v: number) => `${Math.max(0, Math.min(100, asked ? (v / asked) * 100 : 0))}%`
            const toBuy = was?.buyQty ?? 0
            const ordered = was?.orderedQty ?? 0
            const arrived = was?.receivedQty ?? 0
            const arrivedHere = Math.min(arrived, owed)
            const onOrder = Math.min(Math.max(0, ordered - arrived), Math.max(0, owed - arrivedHere))
            const notOrdered = Math.min(Math.max(0, toBuy - ordered), Math.max(0, owed - arrivedHere - onOrder))
            const segments = [
              { key: 'given', label: 'Handed over', value: issued, cls: 'bg-emerald-500', dot: 'bg-emerald-500' },
              { key: 'arrived', label: 'Arrived on PO', value: arrivedHere, cls: 'bg-teal-400', dot: 'bg-teal-400' },
              { key: 'ordered', label: 'On order', value: onOrder, cls: 'bg-sky-500', dot: 'bg-sky-500' },
              { key: 'waiting', label: 'To buy, no PO yet', value: notOrdered, cls: 'bg-amber-400', dot: 'bg-amber-400' },
            ]
            const buyState = theirs || toBuy <= 0 || owed <= 0
              ? null
              : ordered <= 0
                ? { cls: 'badge-warning', text: 'Waiting for PO' }
                : arrived >= Math.min(ordered, owed) - 1e-9 && arrived > 0
                  ? { cls: 'badge-success', text: 'Arrived — hand over' }
                  : { cls: 'badge-info', text: `On order · ${was?.poNumbers.join(', ')}` }
            const figures = [
              { label: 'Asked', value: asked, tone: 'text-foreground' },
              { label: 'Handed over', value: issued, tone: 'text-emerald-600 dark:text-emerald-400' },
              { label: 'To buy', value: was?.buyQty ?? 0, tone: 'text-sky-600 dark:text-sky-400' },
              { label: 'Still owed', value: owed, tone: owed ? 'text-amber-600 dark:text-amber-400' : 'text-muted-foreground' },
            ]
            return (
              <section key={l.id} className="overflow-hidden rounded-xl border border-border bg-card">
                {/* Which item, in one line, with the rest as small print. */}
                <header className="flex flex-wrap items-start justify-between gap-2 border-b border-border px-4 py-3">
                  <div className="min-w-0">
                    <h3 className="text-[15px] font-semibold text-foreground">{l.item.name}</h3>
                    <p className="mt-0.5 truncate text-xs text-muted-foreground">
                      <span className="font-mono">{l.item.code}</span>
                      {cat && <> · {cat.parent ? `${cat.parent.name} › ${cat.name}` : cat.name}</>} · asked of {l.warehouse.name}
                      {l.purpose && <> · for {l.purpose}</>}
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    {theirs && <span className="badge-info">{l.ownerCustomer?.name ?? 'Customer'}&apos;s material</span>}
                    {buyState && <span className={buyState.cls}>{buyState.text}</span>}
                    <span className={status.cls}>{status.text}</span>
                  </div>
                </header>

                <div className="space-y-4 px-4 py-3">
                  {/* Where the line stands: four numbers and one bar. */}
                  <div>
                    <div className="grid grid-cols-4 gap-3">
                      {figures.map((f) => (
                        <div key={f.label}>
                          <div className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">{f.label}</div>
                          <div className={`text-lg font-semibold tabular-nums ${f.tone}`}>
                            {f.value ? fmt(f.value) : '—'} {f.value ? <span className="text-xs font-normal text-muted-foreground">{unit}</span> : null}
                          </div>
                        </div>
                      ))}
                    </div>
                    <div className="mt-2 flex h-2 overflow-hidden rounded-full bg-secondary">
                      {segments.map((sg) => (
                        <div key={sg.key} className={sg.cls} style={{ width: pct(sg.value) }} title={`${sg.label}: ${fmt(sg.value)} ${unit}`} />
                      ))}
                    </div>
                    {/* The bar's key, with the figure behind each colour. */}
                    <div className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-muted-foreground">
                      {segments
                        .filter((sg) => sg.value > 0)
                        .map((sg) => (
                          <span key={sg.key} className="inline-flex items-center gap-1.5">
                            <span className={`h-2 w-2 rounded-full ${sg.dot}`} />
                            {sg.label} <b className="font-semibold tabular-nums text-foreground">{fmt(sg.value)}</b>
                          </span>
                        ))}
                      {owed > 0 && arrivedHere + onOrder + notOrdered + 1e-9 < owed && (
                        <span className="inline-flex items-center gap-1.5">
                          <span className="h-2 w-2 rounded-full bg-secondary ring-1 ring-border" />
                          Not covered yet <b className="font-semibold tabular-nums text-foreground">{fmt(r3(owed - arrivedHere - onOrder - notOrdered))}</b>
                        </span>
                      )}
                    </div>
                  </div>

                  {owed <= 0 ? (
                    <p className="rounded-lg bg-emerald-500/10 px-3 py-2 text-sm text-emerald-700 dark:text-emerald-400">
                      Everything asked for has been handed over.
                    </p>
                  ) : (
                    <div className="grid gap-4 lg:grid-cols-5">
                      {/* Step 1: hand over now, from any rack that has it. */}
                      <div className="lg:col-span-3">
                        <div className="mb-1.5 flex items-baseline justify-between gap-2">
                          <h4 className="text-sm font-semibold text-foreground">
                            <span className="mr-1.5 inline-flex h-5 w-5 items-center justify-center rounded-full bg-primary/10 text-[11px] text-primary">1</span>
                            Hand over now
                          </h4>
                          <span className="text-[11px] text-muted-foreground">
                            {available ? `${fmt(available)} ${unit} ${theirs ? 'of theirs ' : ''}in stock` : 'none in stock'}
                          </span>
                        </div>
                        <div className="overflow-hidden rounded-lg border border-border">
                          <table className="w-full text-sm">
                            <thead className="bg-secondary text-[10px] uppercase tracking-wider text-muted-foreground">
                              <tr>
                                <th className="px-3 py-1.5 text-left font-semibold">Store</th>
                                <th className="px-3 py-1.5 text-right font-semibold">Has</th>
                                <th className="px-3 py-1.5 text-right font-semibold" style={{ width: '9rem' }}>
                                  Give
                                </th>
                              </tr>
                            </thead>
                            <tbody>
                              {stores.map((st) => {
                                const v = issue[l.id]?.[st.id] ?? ''
                                const over = num(v) > st.qty + 1e-9
                                return (
                                  <tr key={st.id} className="border-t border-border">
                                    <td className="px-3 py-1.5 text-xs text-foreground">
                                      {st.name}
                                      {st.id === l.warehouse.id && <span className="ml-1 text-[10px] text-muted-foreground">(asked)</span>}
                                    </td>
                                    <td className={`px-3 py-1.5 text-right text-xs tabular-nums ${st.qty ? 'text-foreground' : 'text-muted-foreground'}`}>
                                      {fmt(st.qty)}
                                    </td>
                                    <td className="px-3 py-1">
                                      <div className="relative ml-auto w-32">
                                        <input
                                          className={`form-input h-8 pr-9 text-right text-xs tabular-nums ${over ? 'border-red-500' : ''}`}
                                          inputMode="decimal"
                                          value={v}
                                          placeholder="0"
                                          onChange={(e) => setIssue((p) => ({ ...p, [l.id]: { ...(p[l.id] ?? {}), [st.id]: e.target.value } }))}
                                          disabled={!canIssue || st.qty <= 0}
                                          aria-label={`Issue ${l.item.name} from ${st.name}`}
                                        />
                                        <span className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-[10px] text-muted-foreground">{unit}</span>
                                      </div>
                                    </td>
                                  </tr>
                                )
                              })}
                            </tbody>
                          </table>
                        </div>
                        <p className={`mt-1 text-[11px] ${giving > owed + 1e-9 ? 'text-red-500' : 'text-muted-foreground'}`}>
                          Giving {fmt(giving)} of the {fmt(owed)} {unit} still owed.
                        </p>
                      </div>

                      {/* Step 2: what to buy. */}
                      <div className="lg:col-span-2">
                        <div className="mb-1.5 flex items-baseline justify-between gap-2">
                          <h4 className="text-sm font-semibold text-foreground">
                            <span className="mr-1.5 inline-flex h-5 w-5 items-center justify-center rounded-full bg-primary/10 text-[11px] text-primary">2</span>
                            Buy
                          </h4>
                          {!theirs && (
                            <span className={`text-[11px] ${shortAfter ? 'text-red-500' : 'text-emerald-600 dark:text-emerald-400'}`}>
                              {shortAfter ? `${fmt(shortAfter)} ${unit} short` : 'nothing short'}
                            </span>
                          )}
                        </div>
                        {theirs ? (
                          <p className="rounded-lg border border-border bg-secondary/40 p-3 text-xs text-muted-foreground">
                            {l.ownerCustomer?.name ?? 'The customer'}&apos;s material is never bought. If it is short, ask them to send the rest.
                          </p>
                        ) : (
                          <div className="space-y-2">
                            <div className="relative">
                              <input
                                className="form-input h-9 pr-10 text-right tabular-nums"
                                inputMode="decimal"
                                value={buy[l.id] ?? ''}
                                onChange={(e) => setBuy((p) => ({ ...p, [l.id]: e.target.value }))}
                                aria-label={`Quantity to buy of ${l.item.name}`}
                              />
                              <span className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-xs text-muted-foreground">{unit}</span>
                            </div>
                            <div className="flex flex-wrap gap-1.5">
                              {[
                                { label: `Shortfall ${fmt(shortAfter)}`, v: shortAfter },
                                { label: `Whole line ${fmt(asked)}`, v: asked },
                                { label: was?.orderedQty ? `Only ordered ${fmt(was.orderedQty)}` : 'None', v: was?.orderedQty ?? 0 },
                              ].map((c) => (
                                <button
                                  key={c.label}
                                  type="button"
                                  className={`rounded-full border px-2.5 py-0.5 text-[11px] transition-colors ${
                                    Math.abs(buyNow - c.v) < 1e-9 ? 'border-primary bg-primary/10 text-primary' : 'border-border text-muted-foreground hover:text-foreground'
                                  }`}
                                  onClick={() => setBuy((p) => ({ ...p, [l.id]: String(c.v) }))}
                                >
                                  {c.label}
                                </button>
                              ))}
                            </div>
                            {/* One hint at most: the one that matters for this figure. */}
                            <p className="text-[11px] text-muted-foreground">
                              {buyNow > shortAfter + 1e-9
                                ? `${fmt(r3(buyNow - shortAfter))} ${unit} more than is short goes into stock.`
                                : buyNow > 0 && buyNow + 1e-9 < shortAfter
                                  ? `${fmt(r3(shortAfter - buyNow))} ${unit} would still be owed.`
                                  : buyNow > 0
                                    ? 'Goes on the indent for the buyer.'
                                    : shortAfter
                                      ? 'Nothing will be bought.'
                                      : 'Nothing needs buying.'}
                            </p>
                            {/* Where the buying has got to: the orders raised against this line, or that there are none. */}
                            {toBuy > 0 && (
                              <div className="rounded-lg border border-border">
                                <div className="flex items-center justify-between gap-2 border-b border-border bg-secondary/60 px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                                  <span>Purchase order</span>
                                  <span className="normal-case tracking-normal">
                                    {fmt(ordered)} of {fmt(toBuy)} {unit} ordered · {fmt(arrived)} received
                                  </span>
                                </div>
                                {(was?.orders ?? []).length === 0 ? (
                                  <p className="px-3 py-2 text-xs text-amber-700 dark:text-amber-400">
                                    <b className="font-semibold">Not ordered yet.</b> It is on the buyer&apos;s list under Purchase → Pending Indents. A PO raised
                                    without picking this indent is not linked here.
                                  </p>
                                ) : (
                                  <ul className="divide-y divide-border">
                                    {(was?.orders ?? []).map((o) => {
                                      const st = PO_STATUS[o.status ?? ''] ?? { text: o.status ?? '', cls: 'badge-neutral' }
                                      const got = o.qty ? Math.min(100, (o.receivedQty / o.qty) * 100) : 0
                                      return (
                                        <li key={o.poId} className="px-3 py-2 text-xs">
                                          <div className="flex items-center justify-between gap-2">
                                            <a
                                              href={`/purchase/orders?q=${encodeURIComponent(o.poNumber)}`}
                                              target="_blank"
                                              rel="noreferrer"
                                              className="font-mono font-semibold text-teal-600 hover:underline dark:text-teal-400"
                                              title="Open this order in Purchase Orders"
                                            >
                                              {o.poNumber}
                                            </a>
                                            <span className={st.cls}>{st.text}</span>
                                          </div>
                                          <div className="mt-1 flex items-center gap-2">
                                            <div className="h-1 flex-1 rounded-full bg-secondary">
                                              <div className="h-1 rounded-full bg-teal-500" style={{ width: `${got}%` }} />
                                            </div>
                                            <span className="shrink-0 tabular-nums text-muted-foreground">
                                              {fmt(o.receivedQty)} of {fmt(o.qty)} {unit} in
                                            </span>
                                          </div>
                                          <p className="mt-0.5 text-[11px] text-muted-foreground">
                                            Ordered {formatDate(o.poDate)}
                                            {o.deliveryDate ? ` · due ${formatDate(o.deliveryDate)}` : ''}
                                          </p>
                                        </li>
                                      )
                                    })}
                                  </ul>
                                )}
                                {ordered > 0 && ordered + 1e-9 < toBuy && (
                                  <p className="border-t border-border px-3 py-1.5 text-[11px] text-amber-700 dark:text-amber-400">
                                    {fmt(r3(toBuy - ordered))} {unit} still to be put on an order.
                                  </p>
                                )}
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              </section>
            )
          })}

          {/* Everything that has happened to it, folded away until wanted. */}
          {(events.length > 0 || handovers.length > 0) && (
            <div className="rounded-xl border border-border bg-card">
              <button
                type="button"
                onClick={() => setShowHistory((v) => !v)}
                className="flex w-full items-center gap-2 px-4 py-2.5 text-left text-sm font-medium text-foreground hover:bg-secondary/40"
                aria-expanded={showHistory}
              >
                {showHistory ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
                <History size={14} className="text-muted-foreground" /> History
                <span className="text-xs font-normal text-muted-foreground">({events.length})</span>
              </button>
              {showHistory && (
                <ol className="space-y-1.5 border-t border-border px-4 py-3">
                  {events.map((e, n) => {
                    const what =
                      e.action === 'CREATE'
                        ? 'raised it'
                        : e.action === 'APPROVE'
                          ? 'approved it'
                          : e.action === 'REJECT'
                            ? 'refused it'
                            : e.handedOver?.length
                              ? `handed over ${e.handedOver.join(', ')}`
                              : e.plan
                                ? `set to buy ${
                                    e.plan
                                      .map((p) => {
                                        const l = mr.lines.find((x) => x.id === p.lineId)
                                        return l ? `${fmt(p.buyQty)} ${l.item.uom.symbol} ${l.item.name}` : null
                                      })
                                      .filter(Boolean)
                                      .join(', ') || 'nothing'
                                  }`
                                : e.closeReason
                                  ? `closed it: ${e.closeReason}`
                                  : e.toBuy?.length
                                    ? `marked ${e.toBuy.join(', ')} to be bought (the whole line)`
                                    : 'updated it'
                    return (
                      <li key={n} className="flex gap-3 text-xs">
                        <span className="w-28 shrink-0 tabular-nums text-muted-foreground">{when(e.at)}</span>
                        <span className="text-foreground">
                          <b className="font-semibold">{e.who}</b> {what}
                        </span>
                      </li>
                    )
                  })}
                  {bought.flatMap((b) => b.orders ?? []).map((o) => (
                    <li key={o.poId} className="flex gap-3 text-xs">
                      <span className="w-28 shrink-0 tabular-nums text-muted-foreground">{formatDate(o.poDate)}</span>
                      <span className="text-foreground">
                        Ordered {fmt(o.qty)} on{' '}
                        <a href={`/print/purchase-order/${o.poId}`} target="_blank" rel="noreferrer" className="font-mono text-teal-500 hover:underline">
                          {o.poNumber}
                        </a>
                        {o.receivedQty > 0 ? ` · ${fmt(o.receivedQty)} received` : ' · not received yet'}
                      </span>
                    </li>
                  ))}
                </ol>
              )}
            </div>
          )}
        </>
      )}
    </FormFrame>
  )
}
