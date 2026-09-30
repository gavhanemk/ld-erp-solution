'use client'

import { useEffect, useMemo, useState } from 'react'
import { Loader2, PackageCheck, Package, ShoppingCart, Warehouse, Info } from 'lucide-react'
import { api, ApiError, currentUser } from '@/lib/api'
import { FormFrame } from '@/components/ui/FormFrame'
import { Section } from '@/components/purchase/Section'
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
}

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
  onClose,
  onDone,
}: {
  mrId: string
  onClose: () => void
  onDone: (message: string) => void
}) {
  const [mr, setMr] = useState<Requisition | null>(null)
  const [bought, setBought] = useState<Bought[]>([])
  const [stock, setStock] = useState<StockRow[]>([])
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
        const [res, st] = await Promise.all([
          api.get<{ data: Requisition & { bought: Bought[] } }>(`/inventory/requisitions/${mrId}`),
          api.get<{ data: StockRow[] }>('/inventory/stock'),
        ])
        if (cancelled) return
        setMr(res.data)
        setBought(res.data.bought ?? [])
        setStock(st.data)
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
    if (!mr) return
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
  }, [mr, stock, bought])

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

  const doing =
    summary && (summary.issueLines || summary.buyChanges)
      ? [
          summary.issueLines ? `hand over ${summary.issueLines} ${summary.issueLines === 1 ? 'line' : 'lines'}` : null,
          summary.buyChanges ? `put ${summary.buyLines} ${summary.buyLines === 1 ? 'line' : 'lines'} on the indent` : null,
        ]
          .filter(Boolean)
          .join(' and ')
      : null

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
      footerNote={doing ? `Confirm will ${doing}.` : 'Enter what to hand over from each store, and how much to buy.'}
      error={error}
      onClose={onClose}
      busy={saving}
    >
      {loading || !mr ? (
        <p className="px-2 py-10 text-center text-sm text-muted-foreground">{loading ? 'Opening the requisition…' : null}</p>
      ) : (
        <>
          {whyNot && (
            <div className="flex items-start gap-2 rounded-lg border border-amber-500/40 bg-amber-500/5 p-3 text-sm text-amber-600 dark:text-amber-400">
              <Info size={16} className="mt-0.5 shrink-0" /> {whyNot}
            </div>
          )}
          {mr.notes && <p className="px-1 text-xs text-muted-foreground">Note on the requisition: {mr.notes}</p>}

          {mr.lines.map((l) => {
            const unit = l.item.uom.symbol
            const asked = Number(l.requestedQty)
            const issued = Number(l.issuedQty)
            const owed = owedOf(l)
            const stores = storesFor(l)
            const available = r3(stores.reduce((t, s) => t + s.qty, 0))
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
            return (
              <Section
                key={l.id}
                icon={Package}
                title={`${l.item.name}`}
                actions={
                  <div className="flex items-center gap-2">
                    {theirs && <span className="badge-info">{l.ownerCustomer?.name ?? 'Customer'}&apos;s material</span>}
                    <span className={status.cls}>{status.text}</span>
                  </div>
                }
              >
                {/* The line in figures. */}
                <div className="mb-3 grid grid-cols-2 gap-x-4 gap-y-2 text-xs sm:grid-cols-4 lg:grid-cols-7">
                  {[
                    ['Code', <span key="c" className="font-mono">{l.item.code}</span>],
                    ['Category', `${cat?.parent?.name ?? cat?.name ?? '—'}${cat?.parent ? ` › ${cat.name}` : ''}`],
                    ['Asked of', l.warehouse.name],
                    ['What for', l.purpose ?? '—'],
                    ['Asked', `${fmt(asked)} ${unit}`],
                    ['Handed over', issued ? `${fmt(issued)} ${unit}` : '—'],
                    ['Still owed', <span key="o" className={owed ? 'font-semibold text-amber-600 dark:text-amber-400' : ''}>{owed ? `${fmt(owed)} ${unit}` : '—'}</span>],
                  ].map(([label, value]) => (
                    <div key={String(label)} className="min-w-0">
                      <div className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</div>
                      <div className="truncate text-foreground">{value}</div>
                    </div>
                  ))}
                </div>

                <div className="grid gap-4 lg:grid-cols-5">
                  {/* Hand over now, from any rack that has it. */}
                  <div className="lg:col-span-3">
                    <div className="mb-1.5 flex items-center gap-1.5 text-xs font-semibold text-foreground">
                      <Warehouse size={13} className="text-muted-foreground" /> Hand over now
                      <span className="font-normal text-muted-foreground">
                        · {fmt(available)} {unit} {theirs ? 'of theirs' : 'of ours'} in {stores.filter((s) => s.qty > 0).length || 'no'}{' '}
                        {stores.filter((s) => s.qty > 0).length === 1 ? 'store' : 'stores'}
                      </span>
                    </div>
                    <table className="subtable w-full rounded-lg border border-border">
                      <thead>
                        <tr>
                          <th>Store</th>
                          <th className="text-right">Available</th>
                          <th className="text-right" style={{ width: '9rem' }}>
                            Issue now
                          </th>
                        </tr>
                      </thead>
                      <tbody>
                        {stores.map((s) => {
                          const v = issue[l.id]?.[s.id] ?? ''
                          const over = num(v) > s.qty + 1e-9
                          return (
                            <tr key={s.id}>
                              <td className="text-xs">
                                {s.name}
                                {s.id === l.warehouse.id && <span className="ml-1.5 text-[10px] text-muted-foreground">(asked of)</span>}
                              </td>
                              <td className={`text-right text-xs tabular-nums ${s.qty ? '' : 'text-muted-foreground'}`}>
                                {fmt(s.qty)} {unit}
                              </td>
                              <td className="text-right">
                                <div className="relative ml-auto w-32">
                                  <input
                                    className={`form-input h-8 pr-9 text-right text-xs tabular-nums ${over ? 'border-red-500' : ''}`}
                                    inputMode="decimal"
                                    value={v}
                                    placeholder="0"
                                    onChange={(e) => setIssue((p) => ({ ...p, [l.id]: { ...(p[l.id] ?? {}), [s.id]: e.target.value } }))}
                                    disabled={!canIssue || s.qty <= 0 || owed <= 0}
                                    aria-label={`Issue ${l.item.name} from ${s.name}`}
                                  />
                                  <span className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-[10px] text-muted-foreground">
                                    {unit}
                                  </span>
                                </div>
                              </td>
                            </tr>
                          )
                        })}
                      </tbody>
                      <tfoot>
                        <tr>
                          <td className="text-xs font-semibold">Handing over now</td>
                          <td />
                          <td className={`text-right text-xs font-semibold tabular-nums ${giving > owed + 1e-9 ? 'text-red-500' : ''}`}>
                            {fmt(giving)} of {fmt(owed)} {unit}
                          </td>
                        </tr>
                      </tfoot>
                    </table>
                    {stores.length > 1 && (
                      <p className="mt-1 text-[10px] text-muted-foreground">
                        Stock from another store goes straight to the department; the ledger records which rack it left.
                      </p>
                    )}
                  </div>

                  {/* What to buy. */}
                  <div className="lg:col-span-2">
                    <div className="mb-1.5 flex items-center gap-1.5 text-xs font-semibold text-foreground">
                      <ShoppingCart size={13} className="text-muted-foreground" /> Buy (indent)
                    </div>
                    {theirs ? (
                      <p className="rounded-lg border border-border bg-secondary/40 p-3 text-xs text-muted-foreground">
                        This is {l.ownerCustomer?.name ?? 'the customer'}&apos;s material, so it is never bought. If theirs is short, ask them to send
                        the rest.
                      </p>
                    ) : (
                      <div className="space-y-2 rounded-lg border border-border bg-secondary/40 p-3">
                        <div className="flex items-center justify-between text-xs">
                          <span className="text-muted-foreground">Still short after this</span>
                          <span className={`font-semibold tabular-nums ${shortAfter ? 'text-red-500' : 'text-emerald-600 dark:text-emerald-400'}`}>
                            {shortAfter ? `${fmt(shortAfter)} ${unit}` : 'nothing'}
                          </span>
                        </div>
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
                            { label: `Just the shortfall · ${fmt(shortAfter)}`, v: shortAfter },
                            { label: `The whole line · ${fmt(asked)}`, v: asked },
                            { label: was?.orderedQty ? `Only what is ordered · ${fmt(was.orderedQty)}` : 'Nothing', v: was?.orderedQty ?? 0 },
                          ].map((c) => (
                            <button
                              key={c.label}
                              type="button"
                              className={`rounded-full border px-2 py-0.5 text-[11px] transition-colors ${
                                Math.abs(buyNow - c.v) < 1e-9 ? 'border-primary bg-primary/10 text-primary' : 'border-border text-muted-foreground hover:text-foreground'
                              }`}
                              onClick={() => setBuy((p) => ({ ...p, [l.id]: String(c.v) }))}
                            >
                              {c.label}
                            </button>
                          ))}
                        </div>
                        {buyNow > shortAfter + 1e-9 && (
                          <p className="text-[11px] text-sky-600 dark:text-sky-400">
                            {fmt(r3(buyNow - shortAfter))} {unit} more than is short: the extra goes into stock when it arrives.
                          </p>
                        )}
                        {buyNow > 0 && buyNow + 1e-9 < shortAfter && (
                          <p className="text-[11px] text-amber-600 dark:text-amber-400">
                            {fmt(r3(shortAfter - buyNow))} {unit} would still be owed with nothing planned to cover it.
                          </p>
                        )}
                        {was && (was.orderedQty > 0 || was.buyQty > 0) && (
                          <p className="text-[11px] text-muted-foreground">
                            On the indent now: {fmt(was.buyQty)} {unit}
                            {was.orderedQty > 0 && (
                              <>
                                {' '}
                                · ordered {fmt(was.orderedQty)}
                                {was.poNumbers.length ? ` on ${was.poNumbers.join(', ')}` : ''}
                              </>
                            )}
                            {was.receivedQty > 0 && <> · received {fmt(was.receivedQty)}</>}
                          </p>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              </Section>
            )
          })}

          <p className="px-1 text-[11px] text-muted-foreground">
            What is bought appears for the buyer under <b>Select from indent</b> on a new purchase order. When it arrives on a goods receipt,
            open this requisition again to hand it over.
          </p>
        </>
      )}
    </FormFrame>
  )
}
