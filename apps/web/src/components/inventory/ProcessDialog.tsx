'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { ChevronDown, ChevronRight, History, Loader2, Lock, PackageCheck, ShoppingCart, CheckCircle2, type LucideIcon } from 'lucide-react'
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
 * fresh figures, so issuing, reserving and buying stay connected. Which rack a
 * quantity comes from is worked out: where it is reserved for this line first,
 * then the asked store, then whichever has most free.
 */

interface Line {
  id: string
  requestedQty: string | number
  issuedQty: string | number
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

export type ProcessTab = 'issue' | 'reserve' | 'buy'

interface Order {
  poId: string
  poNumber: string
  status?: string
  qty: number
  receivedQty: number
}
interface Data {
  lines: Array<{ id: string; requestedQty: number; issuedQty: number; purchaseQty: number | null; fulfilment: string }>
  bought: Array<{ lineId: string; buyQty: number; orderedQty: number; receivedQty: number; orders?: Order[] }>
  stock: Array<{ itemId: string; warehouseId: string; warehouseName: string; ownership: string; ownerCustomerId: string | null; qty: number }>
  reservations?: Array<{ itemId: string; warehouseId: string; mrLineId: string; qty: number; mrNumber: string; customerName: string | null }>
  events: Array<{ at: string; who: string; action: string; handedOver: string[] | null; reservedNow?: string[] | null; plan: unknown; closeReason: string | null }>
}

const fmt = (v: number) => v.toLocaleString('en-IN', { maximumFractionDigits: 3 })
const r3 = (v: number) => Math.round(v * 1000) / 1000
const num = (v: string) => (v.trim() === '' ? 0 : Number(v))
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
      const by = new Map<string, { id: string; name: string; onHand: number; others: number; own: number }>()
      for (const s of data.stock) {
        if (s.itemId !== l.item.id || s.qty <= 0) continue
        if (theirs ? s.ownership !== 'CUSTOMER_OWNED' || s.ownerCustomerId !== l.ownerCustomer?.id : s.ownership !== 'OWNED') continue
        const cur = by.get(s.warehouseId) ?? { id: s.warehouseId, name: s.warehouseName, onHand: 0, others: 0, own: 0 }
        cur.onHand += s.qty
        by.set(s.warehouseId, cur)
      }
      if (!theirs)
        for (const h of data.reservations ?? []) {
          const cur = h.itemId === l.item.id ? by.get(h.warehouseId) : undefined
          if (!cur) continue
          if (h.mrLineId === l.id) cur.own += h.qty
          else cur.others += h.qty
        }
      // Where it is reserved for this line first, then the asked store, then most free.
      const stores = [...by.values()]
        .map((s) => ({ ...s, free: r3(Math.max(0, s.onHand - s.others)) }))
        .sort((a, c) => c.own - a.own || (a.id === l.warehouse.id ? -1 : c.id === l.warehouse.id ? 1 : c.free - a.free))
      return {
        l,
        unit: l.item.uom.symbol,
        asked,
        issued,
        owed,
        theirs,
        stores,
        free: r3(stores.reduce((t, s) => t + s.free, 0)),
        reserved: r3(stores.reduce((t, s) => t + s.own, 0)),
        onIndent: b?.buyQty ?? 0,
        typed: f?.purchaseQty != null && f.purchaseQty > 0,
        ordered: b?.orderedQty ?? 0,
        received: b?.receivedQty ?? 0,
        orders: b?.orders ?? [],
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
      const raw = qty[tab][r.l.id] ?? ''
      const v = num(raw)
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
    if (r.owed <= 0) return { cls: 'badge-success', text: 'Issued in full' }
    if (r.ordered > 0) return r.received + 1e-9 >= r.ordered ? { cls: 'badge-success', text: 'Arrived — issue it' } : { cls: 'badge-info', text: `On ${r.orders.map((o) => o.poNumber).join(', ')}` }
    if (r.onIndent > 0) return { cls: 'badge-warning', text: 'On indent — no PO yet' }
    if (r.reserved > 0) return { cls: 'badge-info', text: 'Reserved' }
    return r.free + 1e-9 >= r.owed ? { cls: 'badge-success', text: 'In stock' } : { cls: 'badge-danger', text: 'Short' }
  }

  const th = 'px-3 py-2.5 text-right font-semibold'
  const td = 'px-3 py-2.5 text-right tabular-nums'
  const dash = <span className="text-muted-foreground">—</span>

  return (
    <FormFrame
      icon={current.icon}
      title={`${mr.mrNumber} — ${current.label}`}
      subtitle={`${mr.department.name}${mr.so ? ` · for ${mr.so.customer.name} (${mr.so.soNumber})` : ''}${mr.requiredDate ? ` · needed by ${formatDate(mr.requiredDate)}` : ''}`}
      width="max-w-6xl"
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
      <p className="px-1 text-sm text-muted-foreground">{current.what}</p>

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
                <th className={th}>In stock</th>
                {tab === 'issue' && (
                  <>
                    <th className={th}>Asked</th>
                    <th className={th}>Issued</th>
                  </>
                )}
                <th className={th}>Still needed</th>
                {tab === 'reserve' && <th className={th}>Reserved now</th>}
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
                  <td colSpan={9} className="px-3 py-10 text-center text-muted-foreground">
                    Reading the stock…
                  </td>
                </tr>
              ) : (
                rows.map((r) => {
                  const st = statusOf(r)
                  const locked =
                    r.owed <= 0 && tab !== 'buy'
                      ? true
                      : tab === 'issue'
                        ? !canIssue || r.free <= 0
                        : tab === 'reserve'
                          ? r.theirs || (r.free <= 0 && r.reserved <= 0)
                          : r.theirs
                  return (
                    <tr key={r.l.id} className="border-t border-border">
                      <td className="px-3 py-2.5">
                        <div className="font-medium text-foreground">{r.l.item.name}</div>
                        <div className="text-[11px] text-muted-foreground">
                          {r.l.item.code}
                          {r.theirs ? ` · ${r.l.ownerCustomer?.name ?? 'customer'}'s material` : ''}
                          {r.l.purpose ? ` · for ${r.l.purpose}` : ''}
                        </div>
                      </td>
                      <td className={td} title={r.stores.map((s) => `${s.name}: ${fmt(s.free)} free of ${fmt(s.onHand)}`).join('\n') || 'None in any store'}>
                        <span className={r.free + 1e-9 >= r.owed ? 'font-semibold text-emerald-600' : 'font-semibold text-red-500'}>{fmt(r.free)}</span>{' '}
                        <span className="text-[11px] text-muted-foreground">{r.unit}</span>
                      </td>
                      {tab === 'issue' && (
                        <>
                          <td className={td}>{fmt(r.asked)}</td>
                          <td className={td}>{r.issued > 0 ? <span className="text-emerald-600">{fmt(r.issued)}</span> : dash}</td>
                        </>
                      )}
                      <td className={`${td} font-semibold`}>{r.owed > 0 ? fmt(r.owed) : dash}</td>
                      {tab === 'reserve' && <td className={td}>{r.reserved > 0 ? <span className="text-violet-600">{fmt(r.reserved)}</span> : dash}</td>}
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
                      <td className="px-3 py-1.5">
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
                      </td>
                      <td className="whitespace-nowrap px-3 py-2.5">
                        <span className={st.cls}>{st.text}</span>
                      </td>
                    </tr>
                  )
                })
              )}
            </tbody>
          </table>
        </div>
      </div>
      <p className="px-1 text-[11px] text-muted-foreground">
        {tab === 'issue'
          ? 'Hover In stock to see each store. Reserved stock for this requisition is issued first.'
          : tab === 'reserve'
            ? 'Reserve is the total to keep aside for the item — change it, or set 0 to let it go. Issuing later uses it up.'
            : 'Indent qty is the total to buy for the item — it replaces what is on the indent, and cannot go below what is already ordered.'}
      </p>

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
