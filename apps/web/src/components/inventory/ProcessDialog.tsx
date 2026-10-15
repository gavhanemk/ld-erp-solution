'use client'

import { Fragment, useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import {
  ChevronDown, ChevronRight, History, Loader2, Lock, PackageCheck, ShoppingCart, CheckCircle2, type LucideIcon,
} from 'lucide-react'
import { api, ApiError, currentUser } from '@/lib/api'
import { FormFrame } from '@/components/ui/FormFrame'
import { StepInput } from '@/components/ui/StepInput'
import { formatDate } from '@/lib/utils'
import type { OutwardRef } from '@/components/packages/packageTypes'
import { ScanIssue } from '@/components/packages/ScanIssue'

/**
 * Working on an approved requisition: three forms in one window, one tab each.
 *
 *   Issue from store — hand items over to the department
 *   Keep aside       — reserve items in the store for this order
 *   Buy what's short — put items on the indent for Purchase
 *
 * At the top, in plain words: which order and MO it is for, who asked and who
 * approved, when it is needed; then four counts — ready in store, short,
 * with Purchase, issued. Each item shows what is still needed, what the store
 * has, and what happens next, and opens for its stock and purchase history.
 * Each tab is its own form with its own save button; the window stays open
 * after a save and every tab reads the same fresh figures. Which rack a
 * quantity comes from is worked out: where it is reserved for this line
 * first, then the asked store, then whichever has most free.
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
  /** The manufacturing order it was raised from, when it was. */
  mo?: { id: string; moNumber: string } | null
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

const TABS: Array<{ key: ProcessTab; label: string; short: string; icon: LucideIcon; what: string; button: string }> = [
  { key: 'issue', label: 'Issue from store', short: 'Issue', icon: PackageCheck, what: 'Hand items over to the department now: scan their stickers, or type how much and press Issue.', button: 'Issue' },
  { key: 'reserve', label: 'Keep aside', short: 'Keep aside', icon: Lock, what: 'Keep items aside in the store for this order, so nobody else is given them. Issuing later uses them up.', button: 'Keep aside' },
  { key: 'buy', label: "Buy what's short", short: 'Buy', icon: ShoppingCart, what: 'Put what the store cannot give on the indent. The buyer raises the PO from Purchase Orders → New order → Select from indent.', button: 'Save indent' },
]

/** One fact about the requisition: a small label over its value, never cut short. */
function Fact({ label, children, bad, wide }: { label: string; children: ReactNode; bad?: boolean; wide?: boolean }) {
  return (
    <div className={`min-w-0 ${wide ? 'col-span-2 lg:col-span-4' : ''}`}>
      <div className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className={`break-words font-medium ${bad ? 'text-red-500' : 'text-foreground'}`}>{children}</div>
    </div>
  )
}

/** "for Packing", but not "for For MO-…". */
const forText = (p: string) => (/^for\b/i.test(p) ? p : `for ${p}`)

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
  /** `outward`: what an issue just handed over, for its labels. */
  onDone: (message: string, outward?: OutwardRef) => void
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
      let outward: OutwardRef | undefined
      if (tab === 'issue') {
        const lines = check.work.flatMap(({ r, v }) => [...spread(r, v).entries()].map(([warehouseId, q]) => ({ lineId: r.l.id, warehouseId, issueQty: q })))
        const res = await api.post<{ message?: string }>(`/inventory/requisitions/${mr.id}/issue`, { lines })
        message = res.message ?? 'Issued.'
        // This issue's own lines: a requisition can be issued against more than once.
        outward = { type: 'MR', id: mr.id, q: lines.map((l) => `${l.lineId}:${l.issueQty}:${l.warehouseId}`).join(',') }
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
      onDone(message, outward)
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

  const mo = mr.mo ?? null
  /** What a line is for, less the MO the top already names: "Packing", not "For MO-2627-0002 — Packing". */
  const forWhat = (l: Line) => {
    const p = l.purpose?.trim() ?? ''
    const lead = mo ? `For ${mo.moNumber}` : null
    const rest = lead && p.startsWith(lead) ? p.slice(lead.length).replace(/^\s*—\s*/, '').trim() : p
    return rest || null
  }
  // What every line shares is said once at the top; a line then says only what is its own.
  // A string: all lines say it. Null: none says anything. Undefined: they differ.
  const one = (xs: Array<string | null>) => (xs.length > 0 && xs.every((x) => x === xs[0]) ? xs[0] : undefined)
  const shared = {
    style: one(mr.lines.map((l) => l.styleNo ?? null)),
    purpose: one(mr.lines.map(forWhat)),
    store: one(mr.lines.map((l) => l.warehouse.name)),
  }
  // The note production writes on its own ("For MO-… (SO-…)") is already said above.
  const note = mr.notes?.trim() && !(mo && mr.notes.trim().startsWith(`For ${mo.moNumber}`)) ? mr.notes.trim() : null

  // The counts across the requisition, for the four boxes at the top.
  const summary = useMemo(() => {
    const live = rows.filter((r) => r.owed > 0)
    const short = (r: Row) => r.free + 1e-9 < r.owed
    const withPurchase = (r: Row) => (r.ordered > 0 ? r.received + 1e-9 < r.ordered : r.onIndent > 0)
    return {
      items: rows.length,
      pending: live.length,
      ready: live.filter((r) => r.free > 0).length,
      toBuy: live.filter((r) => short(r) && !withPurchase(r) && !r.theirs).length,
      withPurchase: live.filter((r) => short(r) && withPurchase(r)).length,
      done: rows.length - live.length,
    }
  }, [rows])

  const daysLeft = mr.requiredDate ? Math.round((Date.parse(dayKey(mr.requiredDate)) - Date.parse(dayKey(new Date()))) / 86_400_000) : null
  const late = daysLeft != null && daysLeft < 0 && summary.pending > 0
  const due =
    daysLeft == null
      ? 'Not given'
      : `${formatDate(mr.requiredDate!)} · ${daysLeft < 0 ? `${-daysLeft} ${daysLeft === -1 ? 'day' : 'days'} late` : daysLeft === 0 ? 'today' : daysLeft === 1 ? 'tomorrow' : `in ${daysLeft} days`}`

  const poLinks = (r: Row) =>
    r.orders.map((o, i) => (
      <Fragment key={o.poId}>
        {i > 0 && ', '}
        <a href={`/purchase/orders?q=${encodeURIComponent(o.poNumber)}`} target="_blank" rel="noreferrer" className="font-mono text-primary hover:underline">
          {o.poNumber}
        </a>
      </Fragment>
    ))

  /** Where one item stands, in words: what the store can give now, and what is happening about the rest. */
  const standing = (r: Row): { cls: string; text: string; rest: ReactNode; buy: number } => {
    const short = r3(Math.max(0, r.owed - r.free))
    const inStore = r.free > 0 ? `${fmt(r.free)} ${r.unit} in store now` : null
    if (r.owed <= 0) return { cls: 'badge-success', text: 'Issued in full', rest: null, buy: 0 }
    if (short <= 0) return { cls: 'badge-success', text: 'In store — issue it', rest: r.reserved > 0 ? `${fmt(r.reserved)} ${r.unit} kept aside for this` : null, buy: 0 }
    if (r.ordered > 0) {
      const dueBy = r.orders.map((o) => o.deliveryDate).filter((d): d is string => !!d).sort()[0]
      if (r.received + 1e-9 >= r.ordered)
        return { cls: 'badge-warning', text: `${fmt(short)} short`, rest: <>{poLinks(r)} has come in full{inStore ? ` · ${inStore}` : ''}</>, buy: r.theirs ? 0 : short }
      return { cls: 'badge-info', text: 'On order', rest: <>{poLinks(r)}{dueBy ? ` · due ${formatDate(dueBy)}` : ''}{inStore ? ` · ${inStore}` : ''}</>, buy: 0 }
    }
    if (r.onIndent > 0) return { cls: 'badge-warning', text: 'On indent — no PO yet', rest: inStore, buy: 0 }
    if (r.theirs) return { cls: 'badge-danger', text: `${fmt(short)} short`, rest: "The customer's own material: ask them to send it.", buy: 0 }
    return {
      cls: r.free > 0 ? 'badge-warning' : 'badge-danger',
      text: r.free > 0 ? `${fmt(short)} short` : 'Not in store',
      rest: tab === 'buy' ? [inStore, 'Save the indent to pass it to Purchase.'].filter(Boolean).join(' · ') : inStore,
      buy: short,
    }
  }

  /** Why a quantity box cannot be used, said under it; null when it can. */
  const lockOf = (r: Row): string | null =>
    tab === 'buy'
      ? r.theirs
        ? "Customer's own — not bought"
        : null
      : r.owed <= 0
        ? 'All issued'
        : tab === 'issue'
          ? !canIssue
            ? 'Someone else issues it'
            : r.free <= 0
              ? 'Nothing in store'
              : null
          : r.theirs
            ? "Customer's own — not kept aside"
            : r.free <= 0 && r.reserved <= 0
              ? 'Nothing in store'
              : null

  const dash = <span className="text-muted-foreground">—</span>
  const small = 'text-[11px] text-muted-foreground'
  const ariaWord = tab === 'issue' ? 'Issue' : tab === 'reserve' ? 'Reserve' : 'Buy (indent)'

  const itemCell = (r: Row) => {
    const purpose = forWhat(r.l)
    const own = [
      shared.style === undefined && r.l.styleNo ? `Style ${r.l.styleNo}` : null,
      shared.purpose === undefined && purpose ? forText(purpose) : null,
      shared.store === undefined ? `asks ${r.l.warehouse.name}` : null,
    ].filter(Boolean)
    const isOpen = !!open[r.l.id]
    return (
      <>
        <div className="font-medium text-foreground">{r.l.item.name}</div>
        <div className={small}>
          <span className="font-mono">{r.l.item.code}</span>
          {r.category ? ` · ${r.category}` : ''}
        </div>
        {(own.length > 0 || r.theirs) && (
          <div className={small}>
            {own.join(' · ')}
            {r.theirs && (
              <span className="text-sky-600">
                {own.length ? ' · ' : ''}
                {r.l.ownerCustomer?.name ?? 'customer'}&apos;s material
              </span>
            )}
          </div>
        )}
        <button
          type="button"
          onClick={() => setOpen((o) => ({ ...o, [r.l.id]: !o[r.l.id] }))}
          className="mt-1 inline-flex items-center gap-0.5 text-[11px] font-medium text-primary hover:underline"
          aria-expanded={isOpen}
        >
          {isOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />} {isOpen ? 'Hide details' : 'Details'}
        </button>
      </>
    )
  }

  const neededCell = (r: Row) => (
    <>
      {r.owed > 0 ? (
        <>
          <span className="text-base font-semibold text-foreground">{fmt(r.owed)}</span> <span className={small}>{r.unit}</span>
        </>
      ) : (
        dash
      )}
      {r.issued > 0 && (
        <div className={small}>
          {fmt(r.issued)} of {fmt(r.asked)} issued
        </div>
      )}
      {r.reserved > 0 && r.owed > 0 && (
        <div className="text-[11px] text-violet-600">
          {fmt(r.reserved)} kept aside
        </div>
      )}
    </>
  )

  const storeCell = (r: Row) => (
    <>
      <span
        className={`text-base font-semibold ${
          r.owed <= 0 ? 'text-foreground' : r.free <= 0 ? 'text-red-500' : r.free + 1e-9 >= r.owed ? 'text-emerald-600' : 'text-amber-600'
        }`}
      >
        {fmt(r.free)}
      </span>{' '}
      <span className={small}>{r.unit}</span>
      {/* Store by store, so nobody has to hover. */}
      <div className={`mt-0.5 space-y-0.5 ${small}`}>
        {r.stores.length ? (
          r.stores.slice(0, 3).map((s) => (
            <div key={s.id} className="whitespace-nowrap">
              {s.name}: {fmt(s.free)}
              {s.others > 0 ? ` (+${fmt(s.others)} kept for others)` : ''}
            </div>
          ))
        ) : (
          <div>None in any store</div>
        )}
      </div>
    </>
  )

  const shortCell = (r: Row) => {
    const s = r3(Math.max(0, r.owed - r.free))
    return s > 0 ? <span className="text-base font-semibold text-red-500">{fmt(s)}</span> : dash
  }

  const orderCell = (r: Row) =>
    r.ordered > 0 ? (
      <>
        <span className="font-semibold text-foreground">{fmt(r.ordered)}</span>
        <div className={small}>{fmt(r.received)} come in</div>
        <div className="text-[11px]">{poLinks(r)}</div>
      </>
    ) : r.onIndent > 0 ? (
      <span className={small}>on the indent, no PO yet</span>
    ) : (
      dash
    )

  const qtyBox = (r: Row) => {
    const lock = lockOf(r)
    const v = num(qty[tab][r.l.id] ?? '')
    const from = tab !== 'buy' && v > 0 ? [...spread(r, v).entries()] : []
    return (
      <>
        <div className="relative">
          <StepInput
            className="form-input h-9 pr-10 text-right text-sm tabular-nums"
            decimals
            value={qty[tab][r.l.id] ?? ''}
            max={tab === 'buy' ? undefined : r3(Math.min(r.owed, r.free))}
            placeholder="0"
            onValueChange={(x) => set(tab, r.l.id, x)}
            disabled={!!lock || saving}
            aria-label={`${ariaWord} quantity for ${r.l.item.name}`}
          />
          <span className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-[11px] text-muted-foreground">{r.unit}</span>
        </div>
        {lock ? (
          <div className={`mt-0.5 text-right ${small}`}>{lock}</div>
        ) : (
          from.length > 0 && (
            <div className={`mt-0.5 text-right ${small}`}>
              from {from.map(([id, q]) => `${r.stores.find((s) => s.id === id)?.name}${from.length > 1 ? ` ${fmt(q)}` : ''}`).join(' + ')}
            </div>
          )
        )}
      </>
    )
  }

  const statusCell = (r: Row) => {
    const st = standing(r)
    return (
      <>
        <span className={st.cls}>{st.text}</span>
        {st.rest && <div className={`mt-1 ${small}`}>{st.rest}</div>}
        {st.buy > 0 && tab !== 'buy' && (
          <button type="button" className="mt-1 block text-[11px] font-medium text-primary hover:underline" onClick={() => setTab('buy')}>
            Buy {fmt(st.buy)} {r.unit} →
          </button>
        )}
      </>
    )
  }

  const detailsOf = (r: Row) => {
    const buy = standing(r).buy
    return (
      <div className="grid gap-4 text-xs md:grid-cols-3">
        <div>
          <p className="mb-1 font-semibold text-foreground">Stock by store</p>
          {r.stores.length ? (
            <table className="w-full">
              <thead className="text-[10px] uppercase text-muted-foreground">
                <tr>
                  <th className="py-0.5 text-left font-medium">Store</th>
                  <th className="py-0.5 text-right font-medium">On hand</th>
                  <th className="py-0.5 text-right font-medium">Kept aside</th>
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
            <p className="mt-1 text-muted-foreground">Kept aside for others: {r.stores.flatMap((s) => s.holders).join(', ')}</p>
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
              {buy > 0 ? ` · the shortfall would cost about ${inr(r3(buy * r.lastBuy.unitRate))}` : ''}
            </p>
          ) : (
            <p className="text-muted-foreground">Never bought on a purchase order.</p>
          )}
        </div>
      </div>
    )
  }

  const qtyHead = tab === 'issue' ? 'Issue now' : tab === 'reserve' ? 'Keep aside' : 'Buy (indent qty)'
  const heads: Array<{ label: string; right?: boolean; width?: string }> = [
    { label: 'Item' },
    { label: 'Still needed', right: true },
    { label: 'In store', right: true },
    ...(tab === 'buy' ? [{ label: 'Short', right: true }, { label: 'On order', right: true }] : []),
    { label: qtyHead, right: true, width: '10rem' },
    { label: 'What next' },
  ]
  const td = 'px-3 py-2.5 text-right tabular-nums align-top'
  const mini = 'text-[10px] font-semibold uppercase tracking-wide text-muted-foreground'

  const boxes = [
    { n: summary.ready, label: 'Ready in store', note: 'can be issued now', on: 'border-emerald-500/30 bg-emerald-500/10', num: 'text-emerald-600' },
    { n: summary.toBuy, label: 'Short — to buy', note: 'not on the indent yet', on: 'border-red-500/30 bg-red-500/10', num: 'text-red-500', buy: true },
    { n: summary.withPurchase, label: 'With Purchase', note: 'on the indent or a PO', on: 'border-sky-500/30 bg-sky-500/10', num: 'text-sky-600' },
    { n: summary.done, label: 'Issued in full', note: `of ${summary.items} ${summary.items === 1 ? 'item' : 'items'}`, on: 'border-border bg-secondary/50', num: 'text-foreground' },
  ]

  return (
    <FormFrame
      icon={current.icon}
      title={mr.mrNumber}
      subtitle={`${mr.department.name} asked for ${mr.lines.length} ${mr.lines.length === 1 ? 'item' : 'items'}${mo ? ` for ${mo.moNumber}` : ''}${mr.so ? ` · ${mr.so.customer.name}` : ''}`}
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
          ? `${check.work.length} ${check.work.length === 1 ? 'item' : 'items'} will be ${tab === 'issue' ? 'issued' : tab === 'reserve' ? 'kept aside' : 'put on the indent'} when you press ${current.button}.`
          : tab === 'issue'
            ? 'Enter how much to issue.'
            : 'Nothing changed yet.')
      }
      error={error}
      onClose={onClose}
      busy={saving}
    >
      {/* What it is for, and who has had a hand in it — in full, nothing cut short. */}
      <div className="grid grid-cols-2 gap-x-6 gap-y-3 rounded-xl border border-border bg-card px-4 py-3 text-sm lg:grid-cols-4">
        <Fact label="For order">
          {mr.so ? (
            <>
              <a href={`/sales/orders?q=${encodeURIComponent(mr.so.soNumber)}`} target="_blank" rel="noreferrer" className="font-mono text-primary hover:underline">
                {mr.so.soNumber}
              </a>{' '}
              · {mr.so.customer.name}
            </>
          ) : (
            'No sales order'
          )}
        </Fact>
        <Fact label="Manufacturing order">
          {mo ? (
            <a href={`/production/orders?open=${mo.id}`} target="_blank" rel="noreferrer" className="font-mono text-primary hover:underline">
              {mo.moNumber}
            </a>
          ) : (
            'Not from an MO'
          )}
          {shared.style && <span className="text-muted-foreground"> · style {shared.style}</span>}
        </Fact>
        <Fact label="Department asking">
          {mr.department.name}
          {shared.purpose && shared.purpose.toLowerCase() !== mr.department.name.toLowerCase() && (
            <span className="text-muted-foreground"> · {forText(shared.purpose)}</span>
          )}
        </Fact>
        <Fact label="From store">{shared.store ?? 'Different stores — see each item'}</Fact>
        <Fact label="Raised by">
          {mr.raisedBy?.name ?? '—'} <span className="text-muted-foreground">· {formatDate(mr.requestDate)}</span>
        </Fact>
        <Fact label="Approved by">{mr.approvedBy?.name ?? 'Not yet'}</Fact>
        <Fact label="Needed by" bad={late}>
          {due}
        </Fact>
        {note && <Fact label="Note">{note}</Fact>}
      </div>

      {/* Where it stands, in four counts. */}
      {data && (
        <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
          {boxes.map((b) => (
            <div key={b.label} className={`rounded-xl border px-3 py-2 ${b.n > 0 ? b.on : 'border-border bg-card'}`}>
              <div className="flex items-baseline gap-2">
                <span className={`text-2xl font-bold tabular-nums ${b.n > 0 ? b.num : 'text-muted-foreground'}`}>{b.n}</span>
                <span className="text-sm font-semibold text-foreground">{b.label}</span>
              </div>
              <div className={`${small} ${b.buy && b.n > 0 && tab !== 'buy' ? '' : 'hidden sm:block'}`}>
                {b.buy && b.n > 0 && tab !== 'buy' ? (
                  <button type="button" className="font-medium text-primary hover:underline" onClick={() => setTab('buy')}>
                    Put them on the indent →
                  </button>
                ) : (
                  b.note
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Three forms, one tab each. */}
      <div className="flex rounded-lg border border-border bg-secondary p-1" role="tablist">
        {TABS.map((t) => {
          const count = !data ? 0 : t.key === 'issue' ? summary.ready : t.key === 'buy' ? summary.toBuy : 0
          return (
            <button
              key={t.key}
              type="button"
              role="tab"
              aria-selected={tab === t.key}
              onClick={() => {
                setTab(t.key)
                setError(null)
              }}
              className={`flex min-w-0 flex-1 items-center justify-center gap-1.5 rounded-md px-2 py-2 text-sm transition-colors ${
                tab === t.key ? 'bg-card font-semibold text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              <t.icon size={15} className="hidden shrink-0 sm:block" />
              <span className="truncate sm:hidden">{t.short}</span>
              <span className="hidden truncate sm:inline">{t.label}</span>
              {count > 0 && (
                <span
                  className={`rounded-full px-1.5 text-[11px] font-semibold tabular-nums ${t.key === 'buy' ? 'bg-red-500/15 text-red-500' : 'bg-emerald-500/15 text-emerald-600'}`}
                >
                  {count}
                </span>
              )}
            </button>
          )
        })}
      </div>
      <p className="-mt-1 px-1 text-xs text-muted-foreground">{current.what}</p>

      {notice && (
        <p className="flex items-start gap-2 rounded-lg bg-emerald-500/15 px-3 py-2 text-sm text-foreground">
          <CheckCircle2 size={16} className="mt-0.5 shrink-0 text-emerald-600" /> {notice}
        </p>
      )}

      {tab === 'issue' &&
        data &&
        (!canIssue ? (
          <p className="rounded-lg bg-amber-500/15 px-3 py-2 text-sm text-foreground">
            You raised or approved this requisition, so somebody else in the store issues it. You can still keep items aside and buy.
          </p>
        ) : summary.pending === 0 ? (
          <p className="rounded-lg bg-emerald-500/10 px-3 py-2 text-sm text-foreground">Everything on this requisition has been issued.</p>
        ) : summary.ready > 0 ? (
          // Approved, so it can be handed over by scanning: stock comes down with each sticker.
          <ScanIssue
            mrId={mr.id}
            mrNumber={mr.mrNumber}
            itemIds={mr.lines.map((l) => l.item.id)}
            onIssued={(message) => {
              setNotice(message)
              onDone(message)
              void read()
            }}
          />
        ) : (
          <div className="rounded-lg border border-dashed border-border bg-secondary/40 px-4 py-3 text-sm">
            <p className="font-medium text-foreground">Nothing on this requisition is in the store yet, so there is nothing to issue.</p>
            <p className="mt-0.5 text-muted-foreground">
              {summary.toBuy > 0 ? (
                <>
                  Put what is short on the indent for Purchase.{' '}
                  <button type="button" className="font-medium text-primary hover:underline" onClick={() => setTab('buy')}>
                    Buy what&apos;s short →
                  </button>
                </>
              ) : (
                'It is with Purchase. Issue it here when the goods come in.'
              )}
            </p>
          </div>
        ))}

      <div className="overflow-hidden rounded-xl border border-border bg-card">
        {!data ? (
          <p className="px-3 py-10 text-center text-sm text-muted-foreground">Reading the stock…</p>
        ) : (
          <>
            <div className="hidden overflow-x-auto md:block">
              <table className="w-full text-sm">
                <thead className="bg-secondary text-[11px] uppercase tracking-wide text-muted-foreground">
                  <tr>
                    {heads.map((h) => (
                      <th key={h.label} className={`px-3 py-2.5 font-semibold ${h.right ? 'text-right' : 'text-left'}`} style={h.width ? { width: h.width } : undefined}>
                        {h.label}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <Fragment key={r.l.id}>
                      <tr className="border-t border-border">
                        <td className="px-3 py-2.5 align-top">{itemCell(r)}</td>
                        <td className={td}>{neededCell(r)}</td>
                        <td className={td}>{storeCell(r)}</td>
                        {tab === 'buy' && (
                          <>
                            <td className={td}>{shortCell(r)}</td>
                            <td className={td}>{orderCell(r)}</td>
                          </>
                        )}
                        <td className="px-3 py-1.5 align-top">{qtyBox(r)}</td>
                        <td className="px-3 py-2.5 align-top">{statusCell(r)}</td>
                      </tr>
                      {open[r.l.id] && (
                        <tr className="border-t border-border/60 bg-secondary/40">
                          <td colSpan={heads.length} className="px-4 py-3">
                            {detailsOf(r)}
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  ))}
                </tbody>
              </table>
            </div>

            {/* On a phone, one card per item. */}
            <div className="divide-y divide-border md:hidden">
              {rows.map((r) => (
                <div key={r.l.id} className="space-y-2.5 px-3 py-3">
                  <div>{itemCell(r)}</div>
                  <div className={`grid gap-2 ${tab === 'buy' ? 'grid-cols-3' : 'grid-cols-2'}`}>
                    <div>
                      <div className={mini}>Still needed</div>
                      {neededCell(r)}
                    </div>
                    <div>
                      <div className={mini}>In store</div>
                      {storeCell(r)}
                    </div>
                    {tab === 'buy' && (
                      <div>
                        <div className={mini}>Short</div>
                        {shortCell(r)}
                        {(r.ordered > 0 || r.onIndent > 0) && <div className="mt-0.5">{orderCell(r)}</div>}
                      </div>
                    )}
                  </div>
                  <div className="grid grid-cols-2 items-start gap-3">
                    <div>
                      <div className={mini}>{qtyHead}</div>
                      {qtyBox(r)}
                    </div>
                    <div>
                      <div className={mini}>What next</div>
                      {statusCell(r)}
                    </div>
                  </div>
                  {open[r.l.id] && <div className="rounded-lg bg-secondary/40 px-3 py-2">{detailsOf(r)}</div>}
                </div>
              ))}
            </div>
          </>
        )}
      </div>
      <p className="px-1 text-[11px] text-muted-foreground">
        {tab === 'issue'
          ? 'Stock kept aside for this requisition goes first; the store each quantity comes from shows under the box.'
          : tab === 'reserve'
            ? 'Keep aside is the total to hold for the item. Change it, or set 0 to let it go.'
            : 'The indent quantity is the total to buy for the item. It replaces what is on the indent, and cannot go below what is already on a PO.'}
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
                            ? `kept aside ${e.reservedNow.join(', ')}`
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
