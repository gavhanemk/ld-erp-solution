'use client'

import { Fragment, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import Link from 'next/link'
import { X, Loader2, AlertCircle, Search } from 'lucide-react'
import { SAMPLE_OVER_REASON_MIN, type SampleNeed } from '@ld-erp/shared'
import { api, ApiError } from '@/lib/api'
import { useEscape } from '@/lib/useEscape'
import { useDialogFocus } from '@/lib/keys'
import { formatDate } from '@/lib/utils'
import { StepInput } from '@/components/ui/StepInput'
import { needsOverReason } from '@/components/purchase/sampleLines'

/**
 * Picking the order's items off what the samples still need bought.
 *
 * The same idea as "Select from indent", for the sampling room. Once a
 * sample's specification is released, every material on it that the mill buys
 * (not what the buyer sends in) is a line here, with what is already on order
 * for it subtracted — so the buyer orders "the collar rib for SMP-2627-0012"
 * off a list instead of retyping a BOM somebody in sampling already typed, and
 * the sample can say what has been bought for it and what is still missing.
 *
 * Grouped under the sample request, because that is how the buyer is asked:
 * "what is outstanding for H&M's polo", not "what rib do we need".
 *
 * The quantity defaults to what is still to buy and can be changed. Less is
 * ordinary — the rest stays on this list. More is allowed too, because
 * suppliers sell rib by the kilo and thread by the cone, but it has to say
 * why: the extra lands in the sample store, and somebody will later ask what
 * it is doing there.
 */

/** A store kept for samples' material, where these goods will be received. */
export interface SampleStore {
  id: string
  name: string
  code: string
}

/** What the form needs back: one sample line, how much of it to order, and why more when it is more. */
export interface SamplePick {
  need: SampleNeed
  qty: number
  /** Why more than the sample still needs. Empty when it is not more. */
  reason: string
}

const qty = (v: number) => v.toLocaleString('en-IN', { minimumFractionDigits: 0, maximumFractionDigits: 3 })

interface Group {
  key: string
  first: SampleNeed
  rows: SampleNeed[]
}

export function SampleNeedsDialog({
  onClose,
  onAdd,
  alreadyPicked,
}: {
  onClose: () => void
  /** The picks, and the sample stores — the order's delivery store is set to one of them. */
  onAdd: (picks: SamplePick[], sampleStores: SampleStore[]) => void
  /**
   * Sample lines already on the order being built.
   *
   * Shown as taken rather than hidden, the same as the indent list: a line
   * that vanished reads as a broken list, one that says "already on this
   * order" has answered the question. The server takes one order line per
   * sample line, so it cannot be picked twice either.
   */
  alreadyPicked: Set<string>
}) {
  const [needs, setNeeds] = useState<SampleNeed[]>([])
  const [stores, setStores] = useState<SampleStore[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const [search, setSearch] = useState('')
  const [ticked, setTicked] = useState<Set<string>>(new Set())
  const [amounts, setAmounts] = useState<Record<string, string>>({})
  const [reasons, setReasons] = useState<Record<string, string>>({})

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const res = await api.get<{ data: { needs: SampleNeed[]; sampleStores: SampleStore[] } }>(
          '/purchase/sample-needs'
        )
        if (cancelled) return
        const data = res.data?.needs ?? []
        setNeeds(data)
        setStores(res.data?.sampleStores ?? [])
        setAmounts(Object.fromEntries(data.map((n) => [n.sampleMaterialId, n.toBuy > 0 ? String(n.toBuy) : ''])))
      } catch (err) {
        if (!cancelled) {
          setError(
            err instanceof ApiError ? err.message : "Could not load what the samples need. Is the server running?"
          )
        }
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  // Escape closes this picker only — not the order form it was opened from.
  useEscape(onClose)
  // Focus into the search box when it opens, and back to the button after.
  const dialogRef = useRef<HTMLDivElement>(null)
  useDialogFocus(dialogRef)

  // One box for everything — buyer, sample number, their style ref, part,
  // colour, item, an order already raised. Nobody should need to know which
  // field "polo" lives in.
  const shown = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return needs
    return needs.filter((n) =>
      [
        n.requestNumber,
        n.title,
        n.customerName,
        n.buyerStyleRef,
        n.style?.code,
        n.component,
        n.colour,
        n.item.code,
        n.item.name,
        ...n.orders.map((o) => o.poNumber),
      ]
        .filter(Boolean)
        .some((v) => String(v).toLowerCase().includes(q))
    )
  }, [needs, search])

  // One heading per sample request, in the order the server sends them.
  const groups = useMemo(() => {
    const by = new Map<string, Group>()
    for (const n of shown) {
      const g = by.get(n.requestId)
      if (g) g.rows.push(n)
      else by.set(n.requestId, { key: n.requestId, first: n, rows: [n] })
    }
    return [...by.values()]
  }, [shown])

  const selectable = shown.filter((n) => !alreadyPicked.has(n.sampleMaterialId))
  const allTicked = selectable.length > 0 && selectable.every((n) => ticked.has(n.sampleMaterialId))

  const toggle = (id: string) =>
    setTicked((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  /** Ticks every free line of `of`, or unticks them all when they already are. */
  const toggleMany = (of: SampleNeed[]) =>
    setTicked((prev) => {
      const free = of.filter((n) => !alreadyPicked.has(n.sampleMaterialId))
      const on = free.length > 0 && free.every((n) => prev.has(n.sampleMaterialId))
      const next = new Set(prev)
      free.forEach((n) => (on ? next.delete(n.sampleMaterialId) : next.add(n.sampleMaterialId)))
      return next
    })

  const amountOf = (n: SampleNeed) => Number(amounts[n.sampleMaterialId]) || 0
  /** A ticked line ordering more than the sample still needs: it has to say why. */
  const asksWhy = (n: SampleNeed) =>
    ticked.has(n.sampleMaterialId) && !alreadyPicked.has(n.sampleMaterialId) && needsOverReason(amountOf(n), n.toBuy)

  /*
   * A ticked row with a blank or zero quantity is a row somebody is still
   * typing into, not an order for nothing — left out rather than refused, as
   * on the indent list. The reason travels only with a line that orders more
   * than is needed: one typed and then made unnecessary by lowering the
   * quantity is not sent, because the server would only throw it away.
   */
  const picks: SamplePick[] = needs
    .filter((n) => ticked.has(n.sampleMaterialId) && !alreadyPicked.has(n.sampleMaterialId))
    .map((n) => {
      const q = amountOf(n)
      return { need: n, qty: q, reason: needsOverReason(q, n.toBuy) ? (reasons[n.sampleMaterialId] ?? '').trim() : '' }
    })
    .filter((p) => p.qty > 0)

  const over = picks.filter((p) => needsOverReason(p.qty, p.need.toBuy))
  const unexplained = over.filter((p) => p.reason.length < SAMPLE_OVER_REASON_MIN)

  const TH =
    'text-muted-foreground px-3 py-2 text-left text-[10px] font-semibold uppercase tracking-wider whitespace-nowrap'
  const TD = 'text-foreground px-3 py-2 align-top text-xs'
  const unit = (n: SampleNeed) => n.item.uom?.symbol ?? ''

  /** The heading over one sample's lines: whose it is, its number, their style ref, ours, and when it is wanted. */
  const groupHead = (g: Group) => {
    const free = g.rows.filter((n) => !alreadyPicked.has(n.sampleMaterialId))
    const on = free.length > 0 && free.every((n) => ticked.has(n.sampleMaterialId))
    const f = g.first
    return (
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
        <label className="flex min-w-0 items-center gap-2.5">
          <input
            type="checkbox"
            checked={on}
            disabled={free.length === 0}
            onChange={() => toggleMany(g.rows)}
            aria-label={`Select every line for ${f.requestNumber}`}
          />
          {/* No buyer means the mill's own development sample, which is
            worth saying in words rather than leaving the heading blank. */}
          <span className="text-foreground text-sm font-semibold">{f.customerName ?? 'Internal development'}</span>
          {f.title && <span className="text-muted-foreground truncate text-xs">{f.title}</span>}
        </label>
        <span className="text-xs">
          <span className="text-muted-foreground">Sample no </span>
          <span className="text-foreground font-mono font-semibold">{f.requestNumber}</span>
        </span>
        {f.buyerStyleRef && (
          <span className="text-xs">
            <span className="text-muted-foreground">Buyer ref </span>
            <span className="text-foreground font-mono font-semibold">{f.buyerStyleRef}</span>
          </span>
        )}
        {f.style && (
          <span className="text-xs">
            <span className="text-muted-foreground">Style </span>
            <span className="text-foreground font-mono font-semibold">{f.style.code}</span>
          </span>
        )}
        {f.requiredAt && (
          <span className="text-xs">
            <span className="text-muted-foreground">Needed by </span>
            <span className="text-foreground font-semibold">{formatDate(f.requiredAt)}</span>
          </span>
        )}
        <span className="text-muted-foreground ml-auto text-xs">
          {g.rows.length} {g.rows.length === 1 ? 'item' : 'items'}
        </span>
      </div>
    )
  }

  /** Which part of the garment, and which colour — "All colours" when the line is for every one. */
  const partOf = (n: SampleNeed) => (
    <>
      <div className="text-foreground text-xs font-semibold">{n.component.trim() || '—'}</div>
      <div className="text-muted-foreground text-[11px]">{n.colour ?? 'All colours'}</div>
    </>
  )

  const itemOf = (n: SampleNeed) => (
    <>
      <div className="text-foreground text-sm font-medium leading-snug">{n.item.name}</div>
      <div className="text-muted-foreground font-mono text-[11px]">{n.item.code}</div>
    </>
  )

  /** What is on order already, and on which orders — so the buyer can see who to chase before ordering more. */
  const orderedOf = (n: SampleNeed) => {
    if (n.orderedQty <= 0) return <span className="text-muted-foreground">—</span>
    const pos = [...new Set(n.orders.map((o) => o.poNumber))]
    return (
      <>
        <div className="text-sm tabular-nums">{qty(n.orderedQty)}</div>
        <div className="text-muted-foreground font-mono text-[11px]" title={pos.join(', ')}>
          {pos.slice(0, 2).join(', ')}
          {pos.length > 2 ? ` +${pos.length - 2}` : ''}
        </div>
        {n.receivedQty > 0 && <div className="text-muted-foreground text-[11px]">{qty(n.receivedQty)} received</div>}
      </>
    )
  }

  const toBuyBox = (n: SampleNeed, wide: boolean) =>
    alreadyPicked.has(n.sampleMaterialId) ? (
      <span className="text-muted-foreground text-[11px]">already on this order</span>
    ) : (
      <div className={wide ? 'text-right' : ''}>
        <StepInput
          decimals
          className={`form-input h-8 text-right text-sm tabular-nums ${wide ? 'w-28' : 'w-full'} ${
            needsOverReason(amountOf(n), n.toBuy) ? 'border-amber-500' : ''
          }`}
          value={amounts[n.sampleMaterialId] ?? ''}
          onValueChange={(v) => {
            setAmounts((prev) => ({ ...prev, [n.sampleMaterialId]: v }))
            // Typing a quantity means ordering it.
            if (Number(v) > 0 && !ticked.has(n.sampleMaterialId)) toggle(n.sampleMaterialId)
          }}
          aria-label={`Quantity to order of ${n.item.name} for ${n.requestNumber}`}
        />
        <div className="text-muted-foreground mt-0.5 text-[11px]">
          {n.toBuy > 0 ? `${qty(n.toBuy)} still needed` : 'Nothing more needed'}
        </div>
      </div>
    )

  /** The reason box, under a ticked line that orders more than the sample still needs. */
  const whyBox = (n: SampleNeed) => {
    const said = (reasons[n.sampleMaterialId] ?? '').trim().length
    const extra = amountOf(n) - n.toBuy
    // The box sits inside its label rather than pointing at an id: every line
    // is drawn twice, as a card and as a table row with one hidden, and an
    // id would name both.
    return (
      <div className="space-y-1">
        <label className="block space-y-1">
          <span className="text-foreground block text-[11px] font-medium">
            Why more than the sample needs
            <span className="text-muted-foreground font-normal">
              {' '}
              — {qty(extra)} {unit(n)} over
            </span>
          </span>
          <input
            className={`form-input h-8 w-full text-sm ${said < SAMPLE_OVER_REASON_MIN ? 'border-amber-500' : ''}`}
            maxLength={300}
            value={reasons[n.sampleMaterialId] ?? ''}
            onChange={(e) => setReasons((prev) => ({ ...prev, [n.sampleMaterialId]: e.target.value }))}
            placeholder="For example: the supplier sells it by the full cone"
          />
        </label>
        {said < SAMPLE_OVER_REASON_MIN && (
          <p className="warn-text text-[11px]">
            Needed to add this line — at least {SAMPLE_OVER_REASON_MIN} letters.
          </p>
        )}
      </div>
    )
  }

  if (typeof document === 'undefined') return null

  /*
   * Portalled, for the reason IndentItemsDialog gives at length: it opens
   * from inside the order form, whose backdrop blur would otherwise become
   * the containing block for this `position: fixed` and offset it twice.
   * One layer above the order form (z-60 against its z-50).
   */
  return createPortal(
    <div className="fixed inset-0 z-[60] flex items-stretch justify-center bg-black/60 p-2 backdrop-blur-sm sm:left-[var(--sidebar-current-width)] sm:p-3">
      <div
        ref={dialogRef}
        className="glass-card po-form flex h-full max-h-full w-full flex-col overflow-hidden"
        role="dialog"
        aria-modal="true"
        aria-labelledby="sample-needs-title"
      >
        <div className="border-border flex shrink-0 items-center gap-3 border-b px-4 py-3">
          <div className="min-w-0">
            <h3 id="sample-needs-title" className="text-foreground text-base font-semibold">
              Select from sample needs
            </h3>
            <p className="text-muted-foreground text-xs">
              Material the samples still need bought, under the sample it is for
            </p>
          </div>
          <button className="btn-ghost ml-auto shrink-0 p-1.5" onClick={onClose} aria-label="Close sample needs">
            <X size={18} />
          </button>
        </div>

        <div className="border-border flex shrink-0 flex-wrap items-center gap-3 border-b px-4 py-2.5">
          <div className="border-field-edge bg-field flex min-w-0 flex-1 basis-full items-center gap-2 rounded-lg border px-3 py-2 sm:basis-auto sm:max-w-md">
            <Search size={14} className="text-muted-foreground shrink-0" />
            <input
              className="text-foreground placeholder:text-muted-foreground min-w-0 flex-1 border-0 bg-transparent text-sm outline-none"
              placeholder="Buyer, sample no, style, part, colour or item…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              aria-label="Search sample needs"
            />
          </div>
          {selectable.length > 0 && (
            <label className="text-foreground flex items-center gap-2 text-xs">
              <input type="checkbox" checked={allTicked} onChange={() => toggleMany(shown)} aria-label="Select every line shown" />
              Select all shown
            </label>
          )}
          <span className="text-muted-foreground ml-auto text-xs">
            {groups.length} {groups.length === 1 ? 'sample' : 'samples'} · {shown.length}{' '}
            {shown.length === 1 ? 'item' : 'items'}
            {picks.length > 0 && ` · ${picks.length} picked`}
          </span>
        </div>

        {error && (
          <div className="flex items-start gap-3 border-b border-red-500/40 bg-red-500/5 px-4 py-3">
            <AlertCircle size={16} className="mt-0.5 shrink-0 text-red-400" />
            <p className="text-sm text-red-400">{error}</p>
          </div>
        )}

        {/* Said before anything is ordered, not when the lorry arrives: a
          sample's material can only be received into a sample store, and with
          none set up the goods would have nowhere to go. */}
        {!loading && !error && needs.length > 0 && stores.length === 0 && (
          <div className="flex items-start gap-3 border-b border-amber-500/40 bg-amber-500/5 px-4 py-3">
            <AlertCircle size={16} className="mt-0.5 shrink-0 text-amber-500" />
            <p className="text-foreground text-sm">
              No sample store is set up yet. A sample&apos;s material can only be received into one — mark a store
              as a sample store under{' '}
              <Link href="/masters/warehouses" className="text-primary hover:underline">
                Masters &rarr; Warehouses
              </Link>{' '}
              before these goods arrive.
            </p>
          </div>
        )}

        <div className="flex-1 overflow-auto">
          {loading ? (
            <p className="text-muted-foreground flex items-center gap-2 px-4 py-10 text-sm">
              <Loader2 size={15} className="animate-spin" /> Loading…
            </p>
          ) : shown.length === 0 ? (
            <div className="px-4 py-10 text-center">
              <p className="text-muted-foreground text-sm">
                {needs.length === 0
                  ? 'No sample is waiting for material to be bought.'
                  : 'Nothing matches that. Clear the search to see the rest.'}
              </p>
              {/* Where these come from, said on the screen that has none —
                neither condition is visible from the purchase side. */}
              {needs.length === 0 && (
                <p className="text-muted-foreground mx-auto mt-2 max-w-md text-xs">
                  A sample&apos;s material appears here once its specification is{' '}
                  <span className="text-foreground">released</span> in{' '}
                  <Link href="/sampling" className="text-primary hover:underline">
                    Sampling
                  </Link>
                  . Only material we buy is listed — not what the buyer sends in.
                </p>
              )}
            </div>
          ) : (
            <div className="p-4">
              {/* Cards below the width the columns can be read at, the table
                above it — the `list-scope` switch every purchase list uses. */}
              <div className="list-scope">
                <div className="list-cards space-y-4">
                  {groups.map((g) => (
                    <div key={g.key} className="border-border overflow-hidden rounded-xl border">
                      <div className="bg-secondary/70 border-border border-b px-3 py-2.5">{groupHead(g)}</div>
                      <div className="divide-border/70 divide-y">
                        {g.rows.map((n) => {
                          const taken = alreadyPicked.has(n.sampleMaterialId)
                          const on = ticked.has(n.sampleMaterialId)
                          return (
                            <div
                              key={n.sampleMaterialId}
                              className={`p-3 ${taken ? 'opacity-50' : on ? 'bg-primary/5' : 'bg-card'}`}
                            >
                              <div className="flex items-start gap-2.5">
                                <input
                                  type="checkbox"
                                  className="mt-1 shrink-0"
                                  checked={on}
                                  disabled={taken}
                                  onChange={() => toggle(n.sampleMaterialId)}
                                  aria-label={`Order ${n.item.name} for ${n.requestNumber}`}
                                />
                                <div className="min-w-0 flex-1">
                                  {itemOf(n)}
                                  <div className="text-muted-foreground mt-1 text-[11px]">
                                    <span className="text-foreground font-semibold">{n.component.trim() || '—'}</span>
                                    {' · '}
                                    {n.colour ?? 'All colours'}
                                  </div>
                                </div>
                              </div>
                              <div className="mt-2.5 grid grid-cols-3 gap-2">
                                <div>
                                  <p className="text-muted-foreground text-[10px] font-semibold uppercase tracking-wider">
                                    Required
                                  </p>
                                  <p className="text-foreground text-sm tabular-nums">
                                    {qty(n.requiredQty)} <span className="text-muted-foreground text-[11px]">{unit(n)}</span>
                                  </p>
                                </div>
                                <div>
                                  <p className="text-muted-foreground text-[10px] font-semibold uppercase tracking-wider">
                                    Ordered
                                  </p>
                                  {orderedOf(n)}
                                </div>
                                <div>
                                  <p className="text-muted-foreground text-[10px] font-semibold uppercase tracking-wider">
                                    To buy
                                  </p>
                                  {toBuyBox(n, false)}
                                </div>
                              </div>
                              {asksWhy(n) && <div className="mt-2.5">{whyBox(n)}</div>}
                            </div>
                          )
                        })}
                      </div>
                    </div>
                  ))}
                </div>

                <div className="list-rows border-border bg-card overflow-x-auto rounded-xl border">
                  <table className="w-full min-w-[820px] text-sm">
                    <thead className="bg-secondary sticky top-0 z-10">
                      <tr className="border-border border-b">
                        <th className={`${TH} w-10`} />
                        <th className={TH}>Part &amp; colour</th>
                        <th className={TH}>Item</th>
                        <th className={`${TH} !text-right`}>Required</th>
                        <th className={`${TH} !text-right`}>Already ordered</th>
                        <th className={`${TH} !text-right`}>To buy</th>
                      </tr>
                    </thead>
                    <tbody>
                      {groups.map((g) => (
                        <Fragment key={g.key}>
                          <tr className="border-border bg-secondary/60 border-y">
                            <td colSpan={6} className="px-3 py-2.5">
                              {groupHead(g)}
                            </td>
                          </tr>
                          {g.rows.map((n) => {
                            const taken = alreadyPicked.has(n.sampleMaterialId)
                            const on = ticked.has(n.sampleMaterialId)
                            const why = asksWhy(n)
                            const tint = taken ? 'opacity-50' : on ? 'bg-primary/10' : 'bg-card hover:bg-secondary/40'
                            return (
                              <Fragment key={n.sampleMaterialId}>
                                <tr
                                  className={`cursor-pointer ${why ? '' : 'border-border/40 border-b last:border-0'} ${tint}`}
                                  // The whole row ticks it, not only the small box.
                                  onClick={(e) => {
                                    if (taken || (e.target as HTMLElement).closest('input')) return
                                    toggle(n.sampleMaterialId)
                                  }}
                                >
                                  <td className={`${TD} pl-5`}>
                                    <input
                                      type="checkbox"
                                      checked={on}
                                      disabled={taken}
                                      onChange={() => toggle(n.sampleMaterialId)}
                                      aria-label={`Order ${n.item.name} for ${n.requestNumber}`}
                                    />
                                  </td>
                                  <td className={`${TD} whitespace-nowrap`}>{partOf(n)}</td>
                                  <td className={TD}>{itemOf(n)}</td>
                                  <td className={`${TD} whitespace-nowrap text-right tabular-nums`}>
                                    <span className="text-sm font-semibold">{qty(n.requiredQty)}</span>{' '}
                                    <span className="text-muted-foreground text-[11px]">{unit(n)}</span>
                                  </td>
                                  <td className={`${TD} text-right`}>{orderedOf(n)}</td>
                                  <td className={`${TD} text-right`}>
                                    <div className="flex justify-end">{toBuyBox(n, true)}</div>
                                  </td>
                                </tr>
                                {/* Its own row under the line, full width: a
                                  sentence does not fit in the quantity cell. */}
                                {why && (
                                  <tr className={`border-border/40 border-b last:border-0 ${tint}`}>
                                    <td />
                                    <td colSpan={5} className="px-3 pb-3 pt-0">
                                      <div className="ml-auto max-w-xl">{whyBox(n)}</div>
                                    </td>
                                  </tr>
                                )}
                              </Fragment>
                            )
                          })}
                        </Fragment>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          )}
        </div>

        <div className="border-border flex shrink-0 flex-col gap-3 border-t px-4 py-3 sm:flex-row sm:flex-wrap sm:items-center">
          {/* Ordering more than the sample needs is allowed, with a reason;
            the lines without one hold the Add button back rather than being
            quietly left off the order. */}
          <p
            className={`min-w-0 flex-1 text-xs ${unexplained.length > 0 ? 'warn-text' : 'text-muted-foreground'}`}
          >
            {unexplained.length > 0
              ? `${unexplained.length} ${
                  unexplained.length === 1 ? 'line orders' : 'lines order'
                } more than the sample still needs. Say why under ${
                  unexplained.length === 1 ? 'it' : 'each'
                } — at least ${SAMPLE_OVER_REASON_MIN} letters — to add ${unexplained.length === 1 ? 'it' : 'them'}.`
              : over.length > 0
                ? `${over.length} ${
                    over.length === 1 ? 'line orders' : 'lines order'
                  } more than the sample needs. The reason goes on the order with ${over.length === 1 ? 'it' : 'them'}.`
                : 'Tick the lines to buy (or a whole sample at its heading), change any quantity, then add them to the order.'}
          </p>
          <div className="flex shrink-0 items-center justify-end gap-3">
            <button className="btn-secondary" onClick={onClose}>
              Cancel
            </button>
            <button
              className="btn-primary disabled:cursor-not-allowed disabled:opacity-50"
              disabled={picks.length === 0 || unexplained.length > 0}
              onClick={() => onAdd(picks, stores)}
            >
              Add {picks.length > 0 ? `${picks.length} ` : ''}
              {picks.length === 1 ? 'item' : 'items'} to the order
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body
  )
}
