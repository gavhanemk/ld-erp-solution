'use client'

import { Fragment, useEffect, useMemo, useState } from 'react'
import { ChevronDown, ChevronRight, History, Loader2, PackageCheck, RotateCcw } from 'lucide-react'
import { api, ApiError, currentUser, type Paginated } from '@/lib/api'
import { FormFrame } from '@/components/ui/FormFrame'
import { formatDate } from '@/lib/utils'

/**
 * Processing a requisition: one table, one row per item, three boxes.
 *
 *   Issue now — issue it from the store today
 *   Reserve  — keep it aside in the store for this order; nobody else gets it
 *   Buy      — what the store cannot cover goes to Purchase as an indent
 *
 * Which rack it comes from is worked out (the asked store first, then
 * whichever has most free); the detail is behind each row's "More". It saves in
 * the order buy → reserve → issue, so the indent is right even if an issue fails.
 */

interface Line {
  id: string
  requestedQty: string | number
  issuedQty: string | number
  purchaseQty?: string | number | null
  purpose: string | null
  ownership?: 'OWNED' | 'CUSTOMER_OWNED'
  ownerCustomer?: { id: string; name: string } | null
  item: { id: string; code: string; name: string; uom: { symbol: string } }
  warehouse: { id: string; name: string }
}

export interface ProcessRequisition {
  id: string
  mrNumber: string
  requestDate: string
  requiredDate: string | null
  status: string
  closedAt: string | null
  issuedAt: string | null
  notes: string | null
  department: { id: string; name: string }
  raisedBy: { id: string; name: string } | null
  approvedBy: { id: string; name: string } | null
  so?: { id: string; soNumber: string; customer: { id: string; name: string } } | null
  lines: Line[]
}

interface Order {
  poId: string
  poNumber: string
  poDate: string
  status?: string
  deliveryDate?: string | null
  supplierName?: string
  qty: number
  receivedQty: number
}
interface Data {
  lines: Array<{ id: string; requestedQty: number; issuedQty: number; purchaseQty: number | null; fulfilment: string }>
  bought: Array<{ lineId: string; buyQty: number; orderedQty: number; receivedQty: number; poNumbers: string[]; orders?: Order[] }>
  stock: Array<{ itemId: string; warehouseId: string; warehouseName: string; ownership: string; ownerCustomerId: string | null; qty: number }>
  reservations?: Array<{ itemId: string; warehouseId: string; mrLineId: string; qty: number; mrNumber: string; customerName: string | null }>
  itemBuys?: Array<{ itemId: string; lastBuy: { poNumber: string; poDate: string; supplierName: string; unitRate: number } | null }>
  events: Array<{ at: string; who: string; action: string; handedOver: string[] | null; reservedNow?: string[] | null; plan: Array<{ lineId: string; buyQty: number }> | null; closeReason: string | null }>
}

const PO_STATUS: Record<string, string> = {
  DRAFT: 'Draft — not sent',
  SENT: 'Sent to supplier',
  PARTIALLY_RECEIVED: 'Part received',
  COMPLETED: 'Received',
}

const fmt = (v: number) => v.toLocaleString('en-IN', { maximumFractionDigits: 3 })
const r3 = (v: number) => Math.round(v * 1000) / 1000
const num = (v: string) => (v.trim() === '' ? 0 : Number(v))
const when = (d: string) =>
  new Date(d).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', timeZone: 'Asia/Kolkata' })

export function ProcessDialog({
  mr: given,
  onClose,
  onDone,
}: {
  /** The requisition; left out, the window asks which one. */
  mr?: ProcessRequisition | null
  onClose: () => void
  onDone: (message: string) => void
}) {
  const [mr, setMr] = useState<ProcessRequisition | null>(given ?? null)
  const [choices, setChoices] = useState<ProcessRequisition[]>([])
  const [data, setData] = useState<Data | null>(null)
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [give, setGive] = useState<Record<string, string>>({})
  const [keep, setKeep] = useState<Record<string, string>>({})
  const [buy, setBuy] = useState<Record<string, string>>({})
  const [open, setOpen] = useState<Record<string, boolean>>({})
  const [showHistory, setShowHistory] = useState(false)

  const me = currentUser()

  // Opened without a requisition: the approved, still-open ones to choose from.
  useEffect(() => {
    if (given) return
    void api
      .get<Paginated<ProcessRequisition>>('/inventory/requisitions?status=APPROVED&limit=200')
      .then((res) => setChoices(res.data.filter((r) => !r.closedAt && !r.issuedAt)))
      .catch(() => setError('Could not load the requisitions.'))
  }, [given])

  useEffect(() => {
    if (!mr) return
    let cancelled = false
    setLoading(true)
    setData(null)
    void (async () => {
      try {
        const res = await api.get<{ data: Data }>(`/inventory/requisitions/${mr.id}/fulfil`)
        if (!cancelled) setData(res.data)
      } catch (err) {
        if (!cancelled) setError(err instanceof ApiError ? err.message : 'Could not open the requisition.')
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [mr])

  // Raised, approved and issued by three people; the Admin may do all three.
  const canGive = !!mr && (me?.role === 'Admin' || (me?.id !== mr.raisedBy?.id && me?.id !== mr.approvedBy?.id))

  /** One row's facts: what is asked and given, and stock per store with what others hold. */
  const rows = useMemo(() => {
    if (!mr || !data) return []
    return mr.lines.map((l) => {
      const f = data.lines.find((x) => x.id === l.id)
      const asked = Number(f?.requestedQty ?? l.requestedQty)
      const given2 = Number(f?.issuedQty ?? l.issuedQty)
      const owed = r3(Math.max(0, asked - given2))
      const theirs = l.ownership === 'CUSTOMER_OWNED'
      const typedBuy = f?.purchaseQty != null && f.purchaseQty > 0 ? f.purchaseQty : 0
      const b = data.bought.find((x) => x.lineId === l.id)
      const by = new Map<string, { id: string; name: string; onHand: number; others: number; own: number; holders: string[] }>()
      for (const s of data.stock) {
        if (s.itemId !== l.item.id || s.qty <= 0) continue
        if (theirs ? s.ownership !== 'CUSTOMER_OWNED' || s.ownerCustomerId !== l.ownerCustomer?.id : s.ownership !== 'OWNED') continue
        const cur = by.get(s.warehouseId) ?? { id: s.warehouseId, name: s.warehouseName, onHand: 0, others: 0, own: 0, holders: [] }
        cur.onHand += s.qty
        by.set(s.warehouseId, cur)
      }
      if (!theirs)
        for (const h of data.reservations ?? []) {
          const cur = h.itemId === l.item.id ? by.get(h.warehouseId) : undefined
          if (!cur) continue
          if (h.mrLineId === l.id) cur.own += h.qty
          else {
            cur.others += h.qty
            cur.holders.push(`${fmt(h.qty)} for ${h.customerName ?? h.mrNumber}`)
          }
        }
      // The asked store first, then whichever has most free.
      const stores = [...by.values()]
        .map((s) => ({ ...s, free: r3(Math.max(0, s.onHand - s.others)) }))
        .sort((a, c) => (a.id === l.warehouse.id ? -1 : c.id === l.warehouse.id ? 1 : c.free - a.free))
      return {
        l,
        asked,
        given: given2,
        owed,
        theirs,
        typedBuy,
        stores,
        free: r3(stores.reduce((t, s) => t + s.free, 0)),
        held: r3(stores.reduce((t, s) => t + s.own, 0)),
        planned: b?.buyQty ?? 0,
        ordered: b?.orderedQty ?? 0,
        received: b?.receivedQty ?? 0,
        orders: b?.orders ?? [],
        lastBuy: data.itemBuys?.find((x) => x.itemId === l.item.id)?.lastBuy ?? null,
      }
    })
  }, [mr, data])
  type Row = (typeof rows)[number]

  /** The suggestion: keep what is already reserved, give what stock covers, buy what it cannot. */
  const suggest = () => {
    const g: Record<string, string> = {}
    const k: Record<string, string> = {}
    const b: Record<string, string> = {}
    for (const r of rows) {
      const onOrder = Math.max(0, r.ordered - r.received)
      const keepNow = r.theirs ? 0 : Math.min(r.held, r.owed)
      const giveNow = canGive ? Math.max(0, Math.min(r.owed - keepNow - onOrder, r.free - keepNow)) : 0
      k[r.l.id] = keepNow ? String(r3(keepNow)) : ''
      g[r.l.id] = giveNow > 0 ? String(r3(giveNow)) : ''
      const short = r3(Math.max(0, r.owed - r.free))
      const buyNow = r.theirs ? 0 : Math.max(r.typedBuy, r.ordered, short)
      b[r.l.id] = buyNow > 0 ? String(r3(buyNow)) : ''
    }
    setGive(g)
    setKeep(k)
    setBuy(b)
  }
  useEffect(() => {
    suggest()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows])

  /** Which racks the give and the reserve come from: reserve where it is already held, give from the rest. */
  const allocate = (r: Row) => {
    const left = new Map(r.stores.map((s) => [s.id, s.free]))
    const keepAt = new Map<string, number>()
    const giveAt = new Map<string, number>()
    let k = num(keep[r.l.id] ?? '')
    for (const s of [...r.stores].sort((a, c) => c.own - a.own)) {
      const t = Math.min(left.get(s.id) ?? 0, k)
      if (t > 0) keepAt.set(s.id, r3(t)), left.set(s.id, r3((left.get(s.id) ?? 0) - t)), (k = r3(k - t))
    }
    let g = num(give[r.l.id] ?? '')
    for (const s of r.stores) {
      const t = Math.min(left.get(s.id) ?? 0, g)
      if (t > 0) giveAt.set(s.id, r3(t)), left.set(s.id, r3((left.get(s.id) ?? 0) - t)), (g = r3(g - t))
    }
    return { keepAt, giveAt }
  }

  /** What each row will do, and anything that would stop it. */
  const plan = useMemo(() => {
    const problems: string[] = []
    const out = rows.map((r) => {
      const unit = r.l.item.uom.symbol
      const g = num(give[r.l.id] ?? '')
      const k = num(keep[r.l.id] ?? '')
      const b = num(buy[r.l.id] ?? '')
      const name = r.l.item.name
      if ([g, k, b].some((v) => Number.isNaN(v) || v < 0)) problems.push(`${name}: enter numbers only.`)
      else {
        if (g + k > r.owed + 1e-9) problems.push(`${name}: issue and reserve together are more than the ${fmt(r.owed)} ${unit} still needed.`)
        else if (g + k > r.free + 1e-9) problems.push(`${name}: only ${fmt(r.free)} ${unit} is in stock to issue or reserve.`)
        if (g > 0 && !canGive) problems.push(`${name}: you raised or approved this requisition, so somebody else in the store issues it.`)
        if (r.theirs && (k > 0 || b > 0)) problems.push(`${name}: the customer's own material is never reserved or bought.`)
        if (b + 1e-9 < r.ordered) problems.push(`${name}: ${fmt(r.ordered)} ${unit} is already on a PO, so Buy cannot go below that.`)
      }
      const notCovered = r3(Math.max(0, r.owed - g - k - Math.max(0, b - r.received)))
      return { r, g, k, b, notCovered, ...allocate(r) }
    })
    return { out, problems }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, give, keep, buy, canGive])

  /** The reservation to send per store, so the give then uses up the right part of it. */
  const reserveCalls = (p: (typeof plan.out)[number]) =>
    p.r.theirs
      ? []
      : p.r.stores
          .map((s) => {
            const k = p.keepAt.get(s.id) ?? 0
            const g = p.giveAt.get(s.id) ?? 0
            const target = k > 0 ? r3(k + g) : g > 0 && s.own > 0 ? Math.min(s.own, g) : 0
            return { s, target }
          })
          .filter((c) => Math.abs(c.target - c.s.own) > 1e-9)

  const changes = useMemo(() => {
    const words: string[] = []
    let buys = 0
    let reserves = 0
    let gives = 0
    for (const p of plan.out) {
      const unit = p.r.l.item.uom.symbol
      const name = p.r.l.item.name
      if (p.g > 0) (gives += 1), words.push(`issue ${fmt(p.g)} ${unit} ${name}`)
      if (reserveCalls(p).length) {
        reserves += 1
        if (Math.abs(p.k - p.r.held) > 1e-9) words.push(p.k > 0 ? `reserve ${fmt(p.k)} ${unit} ${name}` : `release ${name}`)
      }
      if (Math.abs(p.b - p.r.planned) > 1e-9) (buys += 1), words.push(p.b > 0 ? `buy ${fmt(p.b)} ${unit} ${name}` : `stop buying ${name}`)
    }
    return { words, buys, reserves, gives }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [plan])

  const save = async () => {
    if (!mr) return
    setError(null)
    if (plan.problems.length) return setError(plan.problems[0])
    if (!changes.words.length && !changes.reserves) return setError('Nothing to do yet: enter what to issue, reserve or buy.')
    setSaving(true)
    const done: string[] = []
    try {
      // Buy first: it cannot fail on stock, and a give that then fails still leaves the indent right.
      if (changes.buys) {
        const lines = plan.out.filter((p) => Math.abs(p.b - p.r.planned) > 1e-9).map((p) => ({ lineId: p.r.l.id, buyQty: r3(p.b) }))
        const res = await api.patch<{ message?: string }>(`/inventory/requisitions/${mr.id}/plan`, { lines })
        if (res.message) done.push(res.message)
      }
      if (changes.reserves) {
        const lines = plan.out.flatMap((p) => reserveCalls(p).map((c) => ({ lineId: p.r.l.id, warehouseId: c.s.id, qty: c.target })))
        await api.post(`/inventory/requisitions/${mr.id}/reserve`, { lines })
        done.push('Reservations saved.')
      }
      if (changes.gives) {
        const lines = plan.out.flatMap((p) =>
          [...p.giveAt.entries()].map(([warehouseId, q]) => ({ lineId: p.r.l.id, warehouseId, issueQty: q })),
        )
        const res = await api.post<{ message?: string }>(`/inventory/requisitions/${mr.id}/issue`, { lines })
        if (res.message) done.push(res.message)
      }
      onDone(done.join(' ') || 'Saved.')
    } catch (err) {
      setError((done.length ? `${done.join(' ')} But: ` : '') + (err instanceof ApiError ? err.message : 'Could not save. Try again.'))
    } finally {
      setSaving(false)
    }
  }

  const confirm = (
    <button type="button" className="btn-primary" onClick={() => void save()} disabled={saving || loading || !data}>
      {saving ? <Loader2 size={15} className="animate-spin" /> : <PackageCheck size={15} />}
      Confirm
    </button>
  )

  const box = (value: string, set: (v: string) => void, label: string, unit: string, disabled: boolean, tone: string) => (
    <div className="relative">
      <input
        className={`form-input h-9 pr-10 text-right text-sm tabular-nums ${value && num(value) > 0 ? tone : ''}`}
        inputMode="decimal"
        value={value}
        placeholder="0"
        onChange={(e) => set(e.target.value)}
        disabled={disabled}
        aria-label={label}
      />
      <span className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-[11px] text-muted-foreground">{unit}</span>
    </div>
  )

  const statusOf = (p: (typeof plan.out)[number]) => {
    const r = p.r
    if (r.owed <= 0) return { cls: 'badge-success', text: 'Issued in full' }
    if (r.ordered > 0 && r.received + 1e-9 < r.ordered) return { cls: 'badge-info', text: `On ${r.orders.map((o) => o.poNumber).join(', ')}` }
    if (p.notCovered > 0) return { cls: 'badge-danger', text: `${fmt(p.notCovered)} not covered` }
    if (p.b > r.received + 1e-9 && r.ordered <= 0 && p.b > 0) return { cls: 'badge-warning', text: 'Buy — no PO yet' }
    return { cls: 'badge-success', text: 'Covered' }
  }

  const th = 'px-3 py-2.5 text-right font-semibold'
  const td = 'px-3 py-2.5 text-right tabular-nums'

  return (
    <FormFrame
      icon={PackageCheck}
      title={mr ? `Process ${mr.mrNumber}` : 'Process a requisition'}
      subtitle={
        mr
          ? `${mr.department.name}${mr.so ? ` · for ${mr.so.customer.name} (${mr.so.soNumber})` : ''}${mr.requiredDate ? ` · needed by ${formatDate(mr.requiredDate)}` : ''}`
          : 'Choose the requisition to work on'
      }
      width="max-w-7xl"
      primary={confirm}
      footer={
        <button type="button" className="btn-secondary" onClick={onClose} disabled={saving}>
          Cancel
        </button>
      }
      footerNote={
        plan.problems.length
          ? plan.problems[0]
          : changes.words.length
            ? `Confirm will ${changes.words.join(' · ')}.`
            : 'Nothing changed yet.'
      }
      error={error}
      onClose={onClose}
      busy={saving}
    >
      {!given && (
        <label className="block max-w-md">
          <span className="form-label">Requisition</span>
          <select className="form-input" value={mr?.id ?? ''} onChange={(e) => setMr(choices.find((c) => c.id === e.target.value) ?? null)} autoFocus>
            <option value="">{choices.length ? 'Choose an approved requisition…' : 'Loading…'}</option>
            {choices.map((c) => (
              <option key={c.id} value={c.id}>
                {c.mrNumber} · {c.department.name}
                {c.so ? ` · ${c.so.customer.name}` : ''}
              </option>
            ))}
          </select>
        </label>
      )}

      {/* The three things you can do, in plain words. */}
      <div className="grid gap-2 sm:grid-cols-3">
        {[
          { n: 1, t: 'Issue now', d: 'Issue it from the store today.', c: 'bg-emerald-500' },
          { n: 2, t: 'Reserve', d: 'Keep it aside in the store for this order — nobody else gets it.', c: 'bg-violet-500' },
          { n: 3, t: 'Buy', d: 'What the store can’t cover goes to Purchase as an indent.', c: 'bg-sky-500' },
        ].map((s) => (
          <div key={s.n} className="flex items-start gap-2.5 rounded-lg border border-border bg-card px-3 py-2">
            <span className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold text-white ${s.c}`}>{s.n}</span>
            <span className="text-xs text-muted-foreground">
              <b className="font-semibold text-foreground">{s.t}</b> — {s.d}
            </span>
          </div>
        ))}
      </div>

      {!canGive && mr && (
        <p className="rounded-lg bg-amber-500/15 px-3 py-2 text-xs text-foreground">
          You raised or approved this requisition, so somebody else in the store issues it. You can still reserve and buy.
        </p>
      )}

      <div className="overflow-hidden rounded-xl border border-border bg-card">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-secondary text-[11px] uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="px-3 py-2.5 text-left font-semibold">Item</th>
                <th className={th}>In stock</th>
                <th className={th}>Asked</th>
                <th className={th}>Issued</th>
                <th className={th}>Still needed</th>
                <th className={`${th} text-emerald-600`} style={{ width: '9rem' }}>
                  1 · Issue now
                </th>
                <th className={`${th} text-violet-600`} style={{ width: '9rem' }}>
                  2 · Reserve
                </th>
                <th className={`${th} text-sky-600`} style={{ width: '9rem' }}>
                  3 · Buy
                </th>
                <th className="px-3 py-2.5 text-left font-semibold">Status</th>
              </tr>
            </thead>
            <tbody>
              {!mr ? (
                <tr>
                  <td colSpan={9} className="px-3 py-10 text-center text-muted-foreground">
                    Choose a requisition above.
                  </td>
                </tr>
              ) : !data ? (
                <tr>
                  <td colSpan={9} className="px-3 py-10 text-center text-muted-foreground">
                    {loading ? 'Reading the stock…' : ''}
                  </td>
                </tr>
              ) : (
                plan.out.map((p) => {
                  const r = p.r
                  const unit = r.l.item.uom.symbol
                  const done = r.owed <= 0
                  const st = statusOf(p)
                  const isOpen = !!open[r.l.id]
                  return (
                    <Fragment key={r.l.id}>
                      <tr className="border-t border-border">
                        <td className="px-3 py-2.5">
                          <button
                            type="button"
                            className="flex items-start gap-1.5 text-left"
                            onClick={() => setOpen((o) => ({ ...o, [r.l.id]: !o[r.l.id] }))}
                            aria-expanded={isOpen}
                            title="Show stock by store and purchase details"
                          >
                            {isOpen ? (
                              <ChevronDown size={15} className="mt-0.5 shrink-0 text-muted-foreground" />
                            ) : (
                              <ChevronRight size={15} className="mt-0.5 shrink-0 text-muted-foreground" />
                            )}
                            <span>
                              <span className="block font-medium text-foreground">{r.l.item.name}</span>
                              <span className="block text-[11px] text-muted-foreground">
                                {r.l.item.code}
                                {r.theirs ? ` · ${r.l.ownerCustomer?.name ?? 'customer'}'s material` : ''}
                                {r.l.purpose ? ` · for ${r.l.purpose}` : ''}
                              </span>
                            </span>
                          </button>
                        </td>
                        <td className={td}>
                          <span className={r.free > 0 ? 'font-semibold text-foreground' : 'text-red-500'}>{fmt(r.free)}</span>{' '}
                          <span className="text-[11px] text-muted-foreground">{unit}</span>
                        </td>
                        <td className={td}>{fmt(r.asked)}</td>
                        <td className={td}>{r.given > 0 ? <span className="text-emerald-600">{fmt(r.given)}</span> : <span className="text-muted-foreground">—</span>}</td>
                        <td className={`${td} font-semibold`}>{done ? <span className="text-muted-foreground">—</span> : fmt(r.owed)}</td>
                        <td className="px-3 py-1.5">
                          {box(give[r.l.id] ?? '', (v) => setGive((x) => ({ ...x, [r.l.id]: v })), `Issue ${r.l.item.name} now`, unit, done || !canGive, 'border-emerald-500/60')}
                        </td>
                        <td className="px-3 py-1.5">
                          {box(keep[r.l.id] ?? '', (v) => setKeep((x) => ({ ...x, [r.l.id]: v })), `Reserve ${r.l.item.name}`, unit, done || r.theirs, 'border-violet-500/60')}
                        </td>
                        <td className="px-3 py-1.5">
                          {box(buy[r.l.id] ?? '', (v) => setBuy((x) => ({ ...x, [r.l.id]: v })), `Buy ${r.l.item.name}`, unit, r.theirs, 'border-sky-500/60')}
                        </td>
                        <td className="whitespace-nowrap px-3 py-2.5">
                          <span className={st.cls}>{st.text}</span>
                        </td>
                      </tr>
                      {isOpen && (
                        <tr className="border-t border-border/60 bg-secondary/40">
                          <td colSpan={9} className="px-4 py-3">
                            <div className="grid gap-4 text-xs md:grid-cols-2">
                              <div>
                                <p className="mb-1 font-semibold text-foreground">Stock by store</p>
                                {r.stores.length ? (
                                  <ul className="space-y-0.5 text-muted-foreground">
                                    {r.stores.map((s) => {
                                      const g = p.giveAt.get(s.id) ?? 0
                                      const k = p.keepAt.get(s.id) ?? 0
                                      return (
                                        <li key={s.id}>
                                          <span className="text-foreground">{s.name}</span>: {fmt(s.onHand)} {unit} on hand
                                          {s.others > 0 && <> · {s.holders.join(', ')} reserved</>} · <b className="text-foreground">{fmt(s.free)} free</b>
                                          {(g > 0 || k > 0) && (
                                            <span className="text-foreground">
                                              {' '}
                                              → {g > 0 ? `issue ${fmt(g)}` : ''}
                                              {g > 0 && k > 0 ? ', ' : ''}
                                              {k > 0 ? `reserve ${fmt(k)}` : ''}
                                            </span>
                                          )}
                                        </li>
                                      )
                                    })}
                                  </ul>
                                ) : (
                                  <p className="text-muted-foreground">None in any store.</p>
                                )}
                              </div>
                              <div>
                                <p className="mb-1 font-semibold text-foreground">Purchase</p>
                                {r.orders.length ? (
                                  <ul className="space-y-0.5 text-muted-foreground">
                                    {r.orders.map((o) => (
                                      <li key={o.poId}>
                                        <a href={`/purchase/orders?q=${encodeURIComponent(o.poNumber)}`} target="_blank" rel="noreferrer" className="font-mono font-semibold text-primary hover:underline">
                                          {o.poNumber}
                                        </a>{' '}
                                        · {PO_STATUS[o.status ?? ''] ?? o.status} · {o.supplierName} · {fmt(o.receivedQty)} of {fmt(o.qty)} {unit} in
                                        {o.deliveryDate ? ` · due ${formatDate(o.deliveryDate)}` : ''}
                                      </li>
                                    ))}
                                  </ul>
                                ) : p.b > 0 ? (
                                  <p className="text-muted-foreground">
                                    No PO yet. The buyer raises it from <b className="text-foreground">Purchase Orders → New order → Select from indent</b>.
                                  </p>
                                ) : (
                                  <p className="text-muted-foreground">Nothing to buy.</p>
                                )}
                                {r.lastBuy && (
                                  <p className="mt-1 text-muted-foreground">
                                    Last bought from {r.lastBuy.supplierName} at ₹{fmt(r.lastBuy.unitRate)}/{unit} ({r.lastBuy.poNumber}, {formatDate(r.lastBuy.poDate)}).
                                  </p>
                                )}
                              </div>
                            </div>
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
      </div>

      {data && (
        <div className="flex flex-wrap items-center justify-between gap-2 px-1">
          <button type="button" className="text-xs text-primary hover:underline" onClick={suggest}>
            <RotateCcw size={12} className="mr-1 inline" /> Back to the suggestion
          </button>
          <span className="text-[11px] text-muted-foreground">Click an item for stock by store and purchase details.</span>
        </div>
      )}

      {/* What has happened so far, folded away. */}
      {data && data.events.length > 0 && (
        <div className="rounded-xl border border-border bg-card">
          <button
            type="button"
            onClick={() => setShowHistory((v) => !v)}
            className="flex w-full items-center gap-2 px-4 py-2.5 text-left text-sm font-medium text-foreground hover:bg-secondary/40"
          >
            {showHistory ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
            <History size={14} className="text-muted-foreground" /> History
            <span className="text-xs font-normal text-muted-foreground">({data.events.length})</span>
          </button>
          {showHistory && (
            <ol className="space-y-1.5 border-t border-border px-4 py-3">
              {data.events.map((e, i) => {
                const what =
                  e.action === 'CREATE'
                    ? 'raised it'
                    : e.action === 'APPROVE'
                      ? 'approved it'
                      : e.action === 'REJECT'
                        ? 'refused it'
                        : e.handedOver?.length
                          ? `issued ${e.handedOver.join(', ')}`
                          : e.reservedNow?.length
                            ? `reserved ${e.reservedNow.join(', ')}`
                            : e.plan
                              ? 'changed what to buy'
                              : e.closeReason
                                ? `closed it: ${e.closeReason}`
                                : 'updated it'
                return (
                  <li key={i} className="flex gap-3 text-xs">
                    <span className="w-28 shrink-0 tabular-nums text-muted-foreground">{when(e.at)}</span>
                    <span className="text-foreground">
                      <b className="font-semibold">{e.who}</b> {what}
                    </span>
                  </li>
                )
              })}
            </ol>
          )}
        </div>
      )}
    </FormFrame>
  )
}
