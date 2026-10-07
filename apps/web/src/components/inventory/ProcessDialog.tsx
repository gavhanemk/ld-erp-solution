'use client'

import { Fragment, useCallback, useEffect, useMemo, useState } from 'react'
import {
  ChevronDown, ChevronRight, History, Loader2, Lock, PackageCheck, ShoppingCart, CheckCircle2, type LucideIcon,
} from 'lucide-react'
import { api, ApiError, currentUser } from '@/lib/api'
import { FormFrame } from '@/components/ui/FormFrame'
import { formatDate } from '@/lib/utils'

/**
 * Working on an approved requisition: three forms in one window, one tab each.
 *
 *   Issue   — issue items from the store
 *   Reserve — keep items aside in the store for this order
 *   Buy     — put items on the indent for Purchase
 *
 * Each tab is its own form with one quantity box per item and its own save
 * button; the window stays open after a save and every tab reads the same
 * fresh figures. Above the tabs, the requisition's details and a summary; each
 * item shows its stock store by store and opens for its purchase history.
 * Which rack a quantity comes from is worked out: where it is reserved for this
 * line first, then the asked store, then whichever has most free.
 */

interface Line {
  id: string
  requestedQty: string | number
  issuedQty: string | number
  purpose: string | null
  /** The garment style it is for, as given on the requisition. */
  styleNo?: string | null
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

export type ProcessTab = 'issue' | 'reserve' | 'buy'

interface Order {
  poId: string
  poNumber: string
  poDate: string
  status?: string
  deliveryDate?: string | null
  supplierName?: string
  unitRate?: number
  qty: number
  receivedQty: number
  receipts?: Array<{ grnNumber: string; grnDate: string; qty: number }>
}
interface Data {
  lines: Array<{ id: string; requestedQty: number; issuedQty: number; purchaseQty: number | null; fulfilment: string }>
  bought: Array<{ lineId: string; buyQty: number; orderedQty: number; receivedQty: number; orders?: Order[] }>
  stock: Array<{ itemId: string; warehouseId: string; warehouseName: string; ownership: string; ownerCustomerId: string | null; qty: number }>
  reservations?: Array<{ itemId: string; warehouseId: string; mrLineId: string; qty: number; mrNumber: string; customerName: string | null }>
  itemBuys?: Array<{
    itemId: string
    lastBuy: { poNumber: string; poDate: string; supplierName: string; unitRate: number } | null
    otherOpen: Array<{ poNumber: string; supplierName: string; qty: number; receivedQty: number; deliveryDate: string | null; forMr: string | null }>
  }>
  events: Array<{ at: string; who: string; action: string; handedOver: string[] | null; reservedNow?: string[] | null; plan: unknown; closeReason: string | null }>
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
const inr = (v: number) => `₹${v.toLocaleString('en-IN', { maximumFractionDigits: 2 })}`
const dayKey = (d: Date | string) => new Date(d).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' })
const when = (d: string) =>
  new Date(d).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', timeZone: 'Asia/Kolkata' })

const TABS: Array<{ key: ProcessTab; label: string; icon: LucideIcon; what: string; button: string }> = [
  { key: 'issue', label: 'Issue', icon: PackageCheck, what: 'Issue items from the store to the department now.', button: 'Issue' },
  { key: 'reserve', label: 'Reserve', icon: Lock, what: 'Keep items aside in the store for this order. Nobody else is given them.', button: 'Save reservation' },
  { key: 'buy', label: 'Buy (indent)', icon: ShoppingCart, what: 'Put items on the indent. The buyer raises the PO from Purchase Orders → New order → Select from indent.', button: 'Save indent' },
]

export function ProcessDialog({
  mr,
  startTab = 'issue',
  onClose,
  onDone,
}: {
  mr: ProcessRequisition
  startTab?: ProcessTab
  onClose: () => void
  /** After each save, so the list behind can refresh. The window stays open. */
  onDone: (message: string) => void
}) {
  const [tab, setTab] = useState<ProcessTab>(startTab)
  const [data, setData] = useState<Data | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [qty, setQty] = useState<Record<ProcessTab, Record<string, string>>>({ issue: {}, reserve: {}, buy: {} })
  const [open, setOpen] = useState<Record<string, boolean>>({})
  const [showHistory, setShowHistory] = useState(false)

  const me = currentUser()
  // Raised, approved and issued by three people; the Admin may do all three.
  const canIssue = me?.role === 'Admin' || (me?.id !== mr.raisedBy?.id && me?.id !== mr.approvedBy?.id)

  const read = useCallback(async () => {
    setLoading(true)
    try {
      const res = await api.get<{ data: Data }>(`/inventory/requisitions/${mr.id}/fulfil`)
      setData(res.data)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not open the requisition.')
    } finally {
      setLoading(false)
    }
  }, [mr.id])
  useEffect(() => {
    void read()
  }, [read])

  /** One item's figures, the same on every tab. */
  const rows = useMemo(() => {
    if (!data) return []
    return mr.lines.map((l) => {
      const f = data.lines.find((x) => x.id === l.id)
      const asked = Number(f?.requestedQty ?? l.requestedQty)
      const issued = Number(f?.issuedQty ?? l.issuedQty)
      const owed = r3(Math.max(0, asked - issued))
      const theirs = l.ownership === 'CUSTOMER_OWNED'
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
      const stores = [...by.values()]
        .map((s) => ({ ...s, free: r3(Math.max(0, s.onHand - s.others)) }))
        .sort((a, c) => c.own - a.own || (a.id === l.warehouse.id ? -1 : c.id === l.warehouse.id ? 1 : c.free - a.free))
      const buys = data.itemBuys?.find((x) => x.itemId === l.item.id)
      const cat = l.item.category
      return {
        l,
        unit: l.item.uom.symbol,
        category: cat ? (cat.parent ? `${cat.parent.name} › ${cat.name}` : cat.name) : null,
        asked,
        issued,
        owed,
        theirs,
        stores,
        free: r3(stores.reduce((t, s) => t + s.free, 0)),
        reserved: r3(stores.reduce((t, s) => t + s.own, 0)),
        onIndent: b?.buyQty ?? 0,
        ordered: b?.orderedQty ?? 0,
        received: b?.receivedQty ?? 0,
        orders: b?.orders ?? [],
        lastBuy: buys?.lastBuy ?? null,
        otherOpen: buys?.otherOpen ?? [],
      }
    })
  }, [mr.lines, data])
  type Row = (typeof rows)[number]

  // Each tab starts filled in: issue what stock covers, the reservation as it
  // stands, and the indent as it stands (or what stock cannot cover).
  useEffect(() => {
    const issue: Record<string, string> = {}
    const reserve: Record<string, string> = {}
    const buy: Record<string, string> = {}
    for (const r of rows) {
      const onOrder = Math.max(0, r.ordered - r.received)
      const give = canIssue ? Math.max(0, Math.min(r.owed - onOrder, r.free)) : 0
      issue[r.l.id] = give > 0 ? String(r3(give)) : ''
      reserve[r.l.id] = r.reserved > 0 ? String(r.reserved) : ''
      const short = r3(Math.max(0, r.owed - r.free))
      const b = r.theirs ? 0 : r.onIndent > 0 || r.ordered > 0 ? Math.max(r.onIndent, r.ordered) : short
      buy[r.l.id] = b > 0 ? String(r3(b)) : ''
    }
    setQty({ issue, reserve, buy })
  }, [rows, canIssue])

  const set = (t: ProcessTab, id: string, v: string) => setQty((q) => ({ ...q, [t]: { ...q[t], [id]: v } }))

  /** Spreads a quantity over the racks in the row's order, never past what each has free. */
  const spread = (r: Row, total: number) => {
    const out = new Map<string, number>()
    let left = total
    for (const s of r.stores) {
      const t = Math.min(s.free, left)
      if (t > 0) out.set(s.id, r3(t)), (left = r3(left - t))
    }
    return out
  }

  /** What the open tab would do, item by item, and anything that would stop it. */
  const check = useMemo(() => {
    const problems: string[] = []
    const work: Array<{ r: Row; v: number }> = []
    for (const r of rows) {
      const v = num(qty[tab][r.l.id] ?? '')
      const name = r.l.item.name
      if (Number.isNaN(v) || v < 0) {
        problems.push(`${name}: enter a number.`)
        continue
      }
      if (tab === 'issue') {
        if (v <= 0) continue
        if (!canIssue) problems.push(`${name}: you raised or approved this requisition, so somebody else in the store issues it.`)
        else if (v > r.owed + 1e-9) problems.push(`${name}: only ${fmt(r.owed)} ${r.unit} is still needed.`)
        else if (v > r.free + 1e-9) problems.push(`${name}: only ${fmt(r.free)} ${r.unit} is in stock.`)
        work.push({ r, v })
      } else if (tab === 'reserve') {
        if (Math.abs(v - r.reserved) < 1e-9) continue
        if (r.theirs) problems.push(`${name}: the customer's own material is not reserved.`)
        else if (v > r.owed + 1e-9) problems.push(`${name}: only ${fmt(r.owed)} ${r.unit} is still needed.`)
        else if (v > r.free + 1e-9) problems.push(`${name}: only ${fmt(r.free)} ${r.unit} is in stock.`)
        work.push({ r, v })
      } else {
        if (Math.abs(v - r.onIndent) < 1e-9) continue
        if (r.theirs && v > 0) problems.push(`${name}: the customer's own material is never bought.`)
        else if (v + 1e-9 < r.ordered) problems.push(`${name}: ${fmt(r.ordered)} ${r.unit} is already on a PO, so the indent cannot go below that.`)
        work.push({ r, v })
      }
    }
    return { problems, work }
  }, [rows, qty, tab, canIssue])

  const save = async () => {
    setError(null)
    setNotice(null)
    if (check.problems.length) return setError(check.problems[0])
    if (!check.work.length)
      return setError(tab === 'issue' ? 'Enter a quantity to issue.' : tab === 'reserve' ? 'Nothing changed in what is reserved.' : 'Nothing changed on the indent.')
    setSaving(true)
    try {
      let message = 'Saved.'
      if (tab === 'issue') {
        const lines = check.work.flatMap(({ r, v }) => [...spread(r, v).entries()].map(([warehouseId, q]) => ({ lineId: r.l.id, warehouseId, issueQty: q })))
        const res = await api.post<{ message?: string }>(`/inventory/requisitions/${mr.id}/issue`, { lines })
        message = res.message ?? 'Issued.'
      } else if (tab === 'reserve') {
        // The amount to hold in each store; 0 lets a store's reservation go.
        const lines = check.work.flatMap(({ r, v }) => {
          const at = spread(r, v)
          return r.stores
            .filter((s) => Math.abs((at.get(s.id) ?? 0) - s.own) > 1e-9)
            .map((s) => ({ lineId: r.l.id, warehouseId: s.id, qty: at.get(s.id) ?? 0 }))
        })
        const res = await api.post<{ message?: string }>(`/inventory/requisitions/${mr.id}/reserve`, { lines })
        message = res.message ?? 'Reservation saved.'
      } else {
        const lines = check.work.map(({ r, v }) => ({ lineId: r.l.id, buyQty: r3(v) }))
        const res = await api.patch<{ message?: string }>(`/inventory/requisitions/${mr.id}/plan`, { lines })
        message = res.message ?? 'Indent saved.'
      }
      setNotice(message)
      onDone(message)
      await read()
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save. Try again.')
    } finally {
      setSaving(false)
    }
  }

  const current = TABS.find((t) => t.key === tab)!
  const saveButton = (
    <button type="button" className="btn-primary" onClick={() => void save()} disabled={saving || loading || !data}>
      {saving ? <Loader2 size={15} className="animate-spin" /> : <current.icon size={15} />}
      {current.button}
    </button>
  )

  const statusOf = (r: Row) => {
    if (r.owed <= 0) return { cls: 'badge-success', text: 'Issued in full', short: 0 }
    if (r.ordered > 0)
      return r.received + 1e-9 >= r.ordered
        ? { cls: 'badge-success', text: 'Arrived — issue it', short: 0 }
        : { cls: 'badge-info', text: `On ${r.orders.map((o) => o.poNumber).join(', ')}`, short: 0 }
    if (r.onIndent > 0) return { cls: 'badge-warning', text: 'On indent — no PO yet', short: 0 }
    if (r.reserved > 0) return { cls: 'badge-info', text: `Reserved ${fmt(r.reserved)}`, short: 0 }
    const short = r3(r.owed - r.free)
    return short > 0 ? { cls: 'badge-danger', text: `Short by ${fmt(short)}`, short } : { cls: 'badge-success', text: 'In stock', short: 0 }
  }

  // The figures across the requisition, for the summary line.
  const summary = useMemo(() => {
    const live = rows.filter((r) => r.owed > 0)
    return {
      items: rows.length,
      pending: live.length,
      inStock: live.filter((r) => r.free + 1e-9 >= r.owed).length,
      short: live.filter((r) => r.free + 1e-9 < r.owed && r.onIndent <= 0 && r.ordered <= 0).length,
      onIndent: live.filter((r) => r.onIndent > 0 && r.ordered <= 0).length,
      onOrder: live.filter((r) => r.ordered > 0).length,
      reserved: live.filter((r) => r.reserved > 0).length,
    }
  }, [rows])

  const late = mr.requiredDate && dayKey(mr.requiredDate) < dayKey(new Date())
  const th = 'px-3 py-2.5 text-right font-semibold'
  const td = 'px-3 py-2.5 text-right tabular-nums align-top'
  const dash = <span className="text-muted-foreground">—</span>
  const cols = tab === 'issue' ? 9 : tab === 'reserve' ? 7 : 9

  return (
    <FormFrame
      icon={current.icon}
      title={`${mr.mrNumber} — ${current.label}`}
      subtitle={current.what}
      width="max-w-7xl"
      primary={saveButton}
      footer={
        <button type="button" className="btn-secondary" onClick={onClose} disabled={saving}>
          Close
        </button>
      }
      footerNote={
        check.problems[0] ??
        (check.work.length
          ? `${check.work.length} ${check.work.length === 1 ? 'item' : 'items'} will be ${tab === 'issue' ? 'issued' : tab === 'reserve' ? 'reserved' : 'put on the indent'} when you press ${current.button}.`
          : tab === 'issue'
            ? 'Enter how much to issue.'
            : 'Nothing changed yet.')
      }
      error={error}
      onClose={onClose}
      busy={saving}
    >
      {/* The requisition itself. */}
      <div className="grid grid-cols-2 gap-x-6 gap-y-2 rounded-xl border border-border bg-card px-4 py-3 text-sm sm:grid-cols-3 lg:grid-cols-6">
        {[
          { k: 'Department', v: mr.department.name },
          { k: 'For', v: mr.so ? `${mr.so.customer.name} (${mr.so.soNumber})` : 'No sales order' },
          { k: 'Raised', v: `${formatDate(mr.requestDate)}${mr.raisedBy ? ` · ${mr.raisedBy.name}` : ''}` },
          { k: 'Approved by', v: mr.approvedBy?.name ?? '—' },
          { k: 'Needed by', v: mr.requiredDate ? `${formatDate(mr.requiredDate)}${late ? ' — late' : ''}` : 'Not given', bad: !!late },
          { k: 'Note', v: mr.notes || '—' },
        ].map((f) => (
          <div key={f.k} className="min-w-0">
            <div className="text-[11px] uppercase tracking-wide text-muted-foreground">{f.k}</div>
            <div className={`truncate font-medium ${f.bad ? 'text-red-500' : 'text-foreground'}`} title={f.v}>
              {f.v}
            </div>
          </div>
        ))}
      </div>

      {/* Three forms, one tab each. */}
      <div className="flex rounded-lg border border-border bg-secondary p-1" role="tablist">
        {TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            role="tab"
            aria-selected={tab === t.key}
            onClick={() => {
              setTab(t.key)
              setError(null)
            }}
            className={`flex flex-1 items-center justify-center gap-2 rounded-md px-3 py-2 text-sm transition-colors ${
              tab === t.key ? 'bg-card font-semibold text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'
            }`}
          >
            <t.icon size={15} /> {t.label}
          </button>
        ))}
      </div>

      {data && (
        <p className="px-1 text-xs text-muted-foreground">
          {summary.items} {summary.items === 1 ? 'item' : 'items'} · {summary.pending} still needed ·{' '}
          <span className="font-semibold text-emerald-600">{summary.inStock} in stock</span> ·{' '}
          <span className={summary.short ? 'font-semibold text-red-500' : ''}>{summary.short} short</span> · {summary.reserved} reserved · {summary.onIndent} on indent ·{' '}
          {summary.onOrder} on order
        </p>
      )}

      {notice && (
        <p className="flex items-start gap-2 rounded-lg bg-emerald-500/15 px-3 py-2 text-sm text-foreground">
          <CheckCircle2 size={16} className="mt-0.5 shrink-0 text-emerald-600" /> {notice}
        </p>
      )}
      {tab === 'issue' && !canIssue && (
        <p className="rounded-lg bg-amber-500/15 px-3 py-2 text-sm text-foreground">
          You raised or approved this requisition, so somebody else in the store issues it. You can still reserve and buy.
        </p>
      )}

      <div className="overflow-hidden rounded-xl border border-border bg-card">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-secondary text-[11px] uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="px-3 py-2.5 text-left font-semibold">Item</th>
                <th className="px-3 py-2.5 text-left font-semibold">Style no.</th>
                <th className={th}>In stock</th>
                {tab === 'issue' && (
                  <>
                    <th className={th}>Asked</th>
                    <th className={th}>Issued</th>
                  </>
                )}
                <th className={th}>Still needed</th>
                {tab === 'reserve' && <th className={th}>Reserved now</th>}
                {tab === 'issue' && <th className={th}>Reserved</th>}
                {tab === 'buy' && (
                  <>
                    <th className={th}>On indent</th>
                    <th className={th}>Ordered</th>
                    <th className={th}>Received</th>
                  </>
                )}
                <th className={th} style={{ width: '10rem' }}>
                  {tab === 'issue' ? 'Issue now' : tab === 'reserve' ? 'Reserve' : 'Indent qty'}
                </th>
                <th className="px-3 py-2.5 text-left font-semibold">Status</th>
              </tr>
            </thead>
            <tbody>
              {!data ? (
                <tr>
                  <td colSpan={cols} className="px-3 py-10 text-center text-muted-foreground">
                    Reading the stock…
                  </td>
                </tr>
              ) : (
                rows.map((r) => {
                  const st = statusOf(r)
                  const isOpen = !!open[r.l.id]
                  const v = num(qty[tab][r.l.id] ?? '')
                  const from = tab !== 'buy' && v > 0 ? [...spread(r, v).entries()] : []
                  const locked =
                    r.owed <= 0 && tab !== 'buy'
                      ? true
                      : tab === 'issue'
                        ? !canIssue || r.free <= 0
                        : tab === 'reserve'
                          ? r.theirs || (r.free <= 0 && r.reserved <= 0)
                          : r.theirs
                  return (
                    <Fragment key={r.l.id}>
                      <tr className="border-t border-border">
                        <td className="px-3 py-2.5 align-top">
                          <div className="font-medium text-foreground">{r.l.item.name}</div>
                          <div className="text-[11px] text-muted-foreground">
                            <span className="font-mono">{r.l.item.code}</span>
                            {r.category ? ` · ${r.category}` : ''} · {r.unit}
                          </div>
                          <div className="text-[11px] text-muted-foreground">
                            Asked of {r.l.warehouse.name}
                            {r.l.purpose ? ` · for ${r.l.purpose}` : ''}
                            {r.theirs && <span className="text-sky-600"> · {r.l.ownerCustomer?.name ?? 'customer'}&apos;s material</span>}
                          </div>
                          <button
                            type="button"
                            onClick={() => setOpen((o) => ({ ...o, [r.l.id]: !o[r.l.id] }))}
                            className="mt-1 inline-flex items-center gap-0.5 text-[11px] font-medium text-primary hover:underline"
                            aria-expanded={isOpen}
                          >
                            {isOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />} {isOpen ? 'Hide details' : 'Details'}
                          </button>
                        </td>
                        <td className="whitespace-nowrap px-3 py-2.5 align-top">
                          {r.l.styleNo ? <span className="font-mono text-sm font-semibold text-foreground">{r.l.styleNo}</span> : dash}
                        </td>
                        <td className={td}>
                          <span className={r.free + 1e-9 >= r.owed ? 'font-semibold text-emerald-600' : 'font-semibold text-red-500'}>{fmt(r.free)}</span>{' '}
                          <span className="text-[11px] text-muted-foreground">{r.unit}</span>
                          {/* Store by store, so nobody has to hover. */}
                          <div className="mt-0.5 space-y-0.5 text-[11px] font-normal text-muted-foreground">
                            {r.stores.length ? (
                              r.stores.slice(0, 3).map((s) => (
                                <div key={s.id} className="whitespace-nowrap">
                                  {s.name}: {fmt(s.free)}
                                  {s.others > 0 ? ` (+${fmt(s.others)} reserved)` : ''}
                                </div>
                              ))
                            ) : (
                              <div>none in any store</div>
                            )}
                          </div>
                        </td>
                        {tab === 'issue' && (
                          <>
                            <td className={td}>{fmt(r.asked)}</td>
                            <td className={td}>{r.issued > 0 ? <span className="text-emerald-600">{fmt(r.issued)}</span> : dash}</td>
                          </>
                        )}
                        <td className={`${td} font-semibold`}>{r.owed > 0 ? fmt(r.owed) : dash}</td>
                        {(tab === 'reserve' || tab === 'issue') && (
                          <td className={td}>{r.reserved > 0 ? <span className="text-violet-600">{fmt(r.reserved)}</span> : dash}</td>
                        )}
                        {tab === 'buy' && (
                          <>
                            <td className={td}>{r.onIndent > 0 ? <span className="text-sky-600">{fmt(r.onIndent)}</span> : dash}</td>
                            <td className={td}>
                              {r.ordered > 0 ? fmt(r.ordered) : dash}
                              {r.orders.length > 0 && (
                                <div className="text-[10px]">
                                  {r.orders.map((o) => (
                                    <a key={o.poId} href={`/purchase/orders?q=${encodeURIComponent(o.poNumber)}`} target="_blank" rel="noreferrer" className="mr-1 font-mono text-primary hover:underline">
                                      {o.poNumber}
                                    </a>
                                  ))}
                                </div>
                              )}
                            </td>
                            <td className={td}>{r.received > 0 ? <span className="text-emerald-600">{fmt(r.received)}</span> : dash}</td>
                          </>
                        )}
                        <td className="px-3 py-1.5 align-top">
                          <div className="relative">
                            <input
                              className="form-input h-9 pr-10 text-right text-sm tabular-nums"
                              inputMode="decimal"
                              value={qty[tab][r.l.id] ?? ''}
                              placeholder="0"
                              onChange={(e) => set(tab, r.l.id, e.target.value)}
                              disabled={locked || saving}
                              aria-label={`${current.label} quantity for ${r.l.item.name}`}
                            />
                            <span className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-[11px] text-muted-foreground">{r.unit}</span>
                          </div>
                          {from.length > 0 && (
                            <div className="mt-0.5 text-right text-[11px] text-muted-foreground">
                              from {from.map(([id, q]) => `${r.stores.find((s) => s.id === id)?.name}${from.length > 1 ? ` ${fmt(q)}` : ''}`).join(' + ')}
                            </div>
                          )}
                        </td>
                        <td className="px-3 py-2.5 align-top">
                          <span className={`${st.cls} whitespace-nowrap`}>{st.text}</span>
                          {st.short > 0 && tab !== 'buy' && !r.theirs && (
                            <button type="button" className="mt-1 block text-[11px] font-medium text-primary hover:underline" onClick={() => setTab('buy')}>
                              Buy the shortfall →
                            </button>
                          )}
                        </td>
                      </tr>
                      {isOpen && (
                        <tr className="border-t border-border/60 bg-secondary/40">
                          <td colSpan={cols} className="px-4 py-3">
                            <div className="grid gap-4 text-xs md:grid-cols-3">
                              <div>
                                <p className="mb-1 font-semibold text-foreground">Stock by store</p>
                                {r.stores.length ? (
                                  <table className="w-full">
                                    <thead className="text-[10px] uppercase text-muted-foreground">
                                      <tr>
                                        <th className="py-0.5 text-left font-medium">Store</th>
                                        <th className="py-0.5 text-right font-medium">On hand</th>
                                        <th className="py-0.5 text-right font-medium">Reserved</th>
                                        <th className="py-0.5 text-right font-medium">Free</th>
                                      </tr>
                                    </thead>
                                    <tbody>
                                      {r.stores.map((s) => (
                                        <tr key={s.id} title={s.holders.join(', ') || undefined}>
                                          <td className="py-0.5 text-foreground">{s.name}</td>
                                          <td className="py-0.5 text-right tabular-nums">{fmt(s.onHand)}</td>
                                          <td className="py-0.5 text-right tabular-nums text-violet-600">{s.others + s.own > 0 ? fmt(s.others + s.own) : '—'}</td>
                                          <td className="py-0.5 text-right font-semibold tabular-nums text-foreground">{fmt(s.free)}</td>
                                        </tr>
                                      ))}
                                    </tbody>
                                  </table>
                                ) : (
                                  <p className="text-muted-foreground">None in any store.</p>
                                )}
                                {r.stores.some((s) => s.holders.length) && (
                                  <p className="mt-1 text-muted-foreground">Reserved for others: {r.stores.flatMap((s) => s.holders).join(', ')}</p>
                                )}
                              </div>
                              <div>
                                <p className="mb-1 font-semibold text-foreground">Purchase orders for this requisition</p>
                                {r.orders.length ? (
                                  <ul className="space-y-1 text-muted-foreground">
                                    {r.orders.map((o) => (
                                      <li key={o.poId}>
                                        <a href={`/purchase/orders?q=${encodeURIComponent(o.poNumber)}`} target="_blank" rel="noreferrer" className="font-mono font-semibold text-primary hover:underline">
                                          {o.poNumber}
                                        </a>{' '}
                                        · {PO_STATUS[o.status ?? ''] ?? o.status} · {o.supplierName}
                                        <br />
                                        {fmt(o.receivedQty)} of {fmt(o.qty)} {r.unit} in
                                        {o.unitRate ? ` · ${inr(o.unitRate)}/${r.unit}` : ''}
                                        {o.deliveryDate ? ` · due ${formatDate(o.deliveryDate)}` : ''}
                                        {o.receipts?.length ? ` · ${o.receipts.map((g) => g.grnNumber).join(', ')}` : ''}
                                      </li>
                                    ))}
                                  </ul>
                                ) : (
                                  <p className="text-muted-foreground">{r.onIndent > 0 ? 'On the indent; no PO raised yet.' : 'Not on the indent.'}</p>
                                )}
                                {r.otherOpen.length > 0 && (
                                  <p className="mt-1 text-muted-foreground">
                                    Other open orders for this item: {r.otherOpen.map((o) => `${o.poNumber} (${fmt(o.qty - o.receivedQty)} to come${o.forMr ? `, for ${o.forMr}` : ''})`).join(', ')}
                                  </p>
                                )}
                              </div>
                              <div>
                                <p className="mb-1 font-semibold text-foreground">Last purchase</p>
                                {r.lastBuy ? (
                                  <p className="text-muted-foreground">
                                    {r.lastBuy.supplierName} at <b className="text-foreground">{inr(r.lastBuy.unitRate)}/{r.unit}</b> on {r.lastBuy.poNumber}, {formatDate(r.lastBuy.poDate)}
                                    {st.short > 0 ? ` · the shortfall would cost about ${inr(r3(st.short * r.lastBuy.unitRate))}` : ''}
                                  </p>
                                ) : (
                                  <p className="text-muted-foreground">Never bought on a purchase order.</p>
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
      <p className="px-1 text-[11px] text-muted-foreground">
        {tab === 'issue'
          ? 'Stock reserved for this requisition is issued first; the store each quantity comes from is shown under the box.'
          : tab === 'reserve'
            ? 'Reserve is the total to keep aside for the item — change it, or set 0 to let it go. Issuing later uses it up.'
            : 'Indent qty is the total to buy for the item — it replaces what is on the indent, and cannot go below what is already ordered.'}
      </p>

      {/* What has happened so far, folded away. */}
      {data && data.events.length > 0 && (
        <div className="rounded-xl border border-border bg-card">
          <button
            type="button"
            onClick={() => setShowHistory((x) => !x)}
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
                              ? 'changed the indent'
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
