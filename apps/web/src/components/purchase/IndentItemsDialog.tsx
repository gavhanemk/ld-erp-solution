'use client'

import { Fragment, useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import Link from 'next/link'
import { X, Loader2, AlertCircle, Search } from 'lucide-react'
import { api, ApiError } from '@/lib/api'
import { useEscape } from '@/lib/useEscape'
import { formatDate } from '@/lib/utils'
import { StepInput } from '@/components/ui/StepInput'

/**
 * Picking the order's items off the indents that asked for them.
 *
 * The mill's old ERP opens this as *View Indent Items* from a button on the
 * purchase order form, and the buyer works from it rather than typing item
 * codes somebody in production already typed. Three things come out of that:
 *
 *   - Nothing is ordered twice. What has already been ordered against a
 *     request is subtracted, so the quantity offered is what is left.
 *   - Nothing is forgotten. A request stays on this list until it is placed.
 *   - Every purchase has a reason attached to it: the line carries the
 *     requisition, and the requisition carries the job that needed it.
 *
 * The lines come grouped under the order they are for — the customer, the
 * sales order and the MO in one heading — so the buyer picks "the fabric for
 * Rajmandir's shirts", not a code. Each line then says which indent asked for
 * it and when, the item, and how much is required, already ordered and still
 * to order.
 *
 * The quantity is editable, and defaults to everything still due. Half a
 * request is a real thing — the mill orders 600 of the 1240 now because that
 * is what the supplier has — and the other 640 stays on this list.
 */

export interface IndentRow {
  mrLineId: string
  mrId: string
  mrNumber: string
  requestDate: string
  requiredDate: string | null
  department: { id: string; name: string } | null
  moNumber: string | null
  soNumber: string | null
  /** Whose order it is, from the sales order. */
  customerName?: string | null
  /** The garment style the material is for, as given on the requisition. */
  styleNo?: string | null
  remark: string | null
  item: {
    id: string
    code: string
    name: string
    hsnCode: string | null
    taxRate: { id: string; rate: string | number } | null
    uom: { symbol: string } | null
  }
  warehouse: { id: string; name: string } | null
  indentQty: number
  orderedQty: number
  pendingQty: number
}

/** What the form needs back: one row, and how much of it to order. */
export interface IndentPick {
  row: IndentRow
  qty: number
}

const qty = (v: number) =>
  v.toLocaleString('en-IN', { minimumFractionDigits: 0, maximumFractionDigits: 3 })

/**
 * The order's reference, said from the indents its lines came off: the sales
 * orders, the MOs and the indents, each once. Kept inside the 100 characters
 * the reference box holds by naming the first few and counting the rest.
 */
export function indentReference(rows: Array<Pick<IndentRow, 'soNumber' | 'moNumber' | 'mrNumber'>>, max = 100): string {
  const uniq = (xs: Array<string | null>) => [...new Set(xs.filter((x): x is string => !!x))]
  const parts: Array<[string, string[]]> = [
    ['', uniq(rows.map((r) => r.soNumber))],
    ['', uniq(rows.map((r) => r.moNumber))],
    ['Indent ', uniq(rows.map((r) => r.mrNumber))],
  ]
  const say = (keep: number) =>
    parts
      .filter(([, xs]) => xs.length)
      .map(([lead, xs]) => lead + (xs.length > keep ? [...xs.slice(0, keep), `+${xs.length - keep} more`] : xs).join(', '))
      .join(' · ')
  for (const keep of [Infinity, 3, 2, 1]) {
    const text = say(keep)
    if (text.length <= max) return text
  }
  return say(1).slice(0, max)
}

/** What a line's remark adds once its MO is named in the heading: "Cutting", not "For MO-… — Cutting". */
const ownRemark = (r: IndentRow) => {
  const p = r.remark?.trim() ?? ''
  const lead = r.moNumber ? `For ${r.moNumber}` : null
  const rest = lead && p.startsWith(lead) ? p.slice(lead.length).replace(/^\s*[—(-]\s*/, '').replace(/\)$/, '').trim() : p
  return rest || null
}

interface Group {
  key: string
  customerName: string | null
  soNumber: string | null
  moNumber: string | null
  /** The style every line shares, when they do. */
  styleNo: string | null
  rows: IndentRow[]
}

export function IndentItemsDialog({
  onClose,
  onAdd,
  alreadyPicked,
}: {
  onClose: () => void
  onAdd: (picks: IndentPick[]) => void
  /**
   * Requisition lines already on the order being built.
   *
   * Shown as taken rather than hidden. A buyer who cannot find a line they put
   * on the order two minutes ago assumes the list is broken; one that says
   * "already on this order" has answered them.
   */
  alreadyPicked: Set<string>
}) {
  const [rows, setRows] = useState<IndentRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const [search, setSearch] = useState('')
  const [ticked, setTicked] = useState<Set<string>>(new Set())
  const [amounts, setAmounts] = useState<Record<string, string>>({})

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const res = await api.get<{ data: IndentRow[] }>('/purchase/indent-items')
        if (cancelled) return
        const data = (res as unknown as { data: IndentRow[] }).data ?? []
        setRows(data)
        setAmounts(Object.fromEntries(data.map((r) => [r.mrLineId, String(r.pendingQty)])))
      } catch (err) {
        if (!cancelled) {
          setError(
            err instanceof ApiError
              ? err.message
              : 'Could not load the indent items. Is the server running?'
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

  // Escape closes this picker only — not the form it was opened from.
  useEscape(onClose)

  // Everything typed into the box at once — customer, order, indent, item.
  // A buyer looking for "Rajmandir's thread" should not have to know which
  // of four boxes that word lives in.
  const shown = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return rows
    return rows.filter((r) =>
      [r.mrNumber, r.item.code, r.item.name, r.moNumber, r.soNumber, r.customerName, r.styleNo, r.department?.name, r.remark]
        .filter(Boolean)
        .some((v) => String(v).toLowerCase().includes(q))
    )
  }, [rows, search])

  // One heading per order: the MO where there is one, else the sales order,
  // else the indent itself (the store's own, for no order).
  const groups = useMemo(() => {
    const by = new Map<string, Group>()
    for (const r of shown) {
      const key = r.moNumber ? `mo:${r.moNumber}` : r.soNumber ? `so:${r.soNumber}` : `mr:${r.mrId}`
      const g = by.get(key)
      if (g) {
        g.rows.push(r)
        if (g.styleNo !== (r.styleNo ?? null)) g.styleNo = null
      } else
        by.set(key, {
          key,
          customerName: r.customerName ?? null,
          soNumber: r.soNumber,
          moNumber: r.moNumber,
          styleNo: r.styleNo ?? null,
          rows: [r],
        })
    }
    // Customers' orders first, the store's own indents after them; each in the order it was asked.
    return [...by.values()].sort((a, b) => Number(!a.soNumber && !a.moNumber) - Number(!b.soNumber && !b.moNumber))
  }, [shown])

  const selectable = shown.filter((r) => !alreadyPicked.has(r.mrLineId))
  const allTicked = selectable.length > 0 && selectable.every((r) => ticked.has(r.mrLineId))

  const toggle = (id: string) =>
    setTicked((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  /** Ticks every free line of `of`, or unticks them all when they already are. */
  const toggleMany = (of: IndentRow[]) =>
    setTicked((prev) => {
      const free = of.filter((r) => !alreadyPicked.has(r.mrLineId))
      const on = free.length > 0 && free.every((r) => prev.has(r.mrLineId))
      const next = new Set(prev)
      free.forEach((r) => (on ? next.delete(r.mrLineId) : next.add(r.mrLineId)))
      return next
    })

  /*
   * A ticked row with a blank or zero quantity is not an order for nothing;
   * it is a row somebody is still typing into. Left out rather than refused,
   * so one half-typed box does not block the four rows that are ready.
   */
  const picks: IndentPick[] = rows
    .filter((r) => ticked.has(r.mrLineId) && !alreadyPicked.has(r.mrLineId))
    .map((r) => ({ row: r, qty: Number(amounts[r.mrLineId]) || 0 }))
    .filter((p) => p.qty > 0)

  const overBooked = picks.filter((p) => p.qty > p.row.pendingQty)

  const TH =
    'text-muted-foreground px-3 py-2 text-left text-[10px] font-semibold uppercase tracking-wider whitespace-nowrap'
  const TD = 'text-foreground px-3 py-2 align-top text-xs'

  /** The heading over one order's lines: whose it is, its SO and MO, and a box for all of them. */
  const groupHead = (g: Group) => {
    const free = g.rows.filter((r) => !alreadyPicked.has(r.mrLineId))
    const on = free.length > 0 && free.every((r) => ticked.has(r.mrLineId))
    return (
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
        <label className="flex min-w-0 items-center gap-2.5">
          <input
            type="checkbox"
            checked={on}
            disabled={free.length === 0}
            onChange={() => toggleMany(g.rows)}
            aria-label={`Select every line for ${g.moNumber ?? g.soNumber ?? g.rows[0].mrNumber}`}
          />
          <span className="text-foreground text-sm font-semibold">
            {g.customerName ?? (g.soNumber || g.moNumber ? 'Customer not given' : "Store's own indent — no order")}
          </span>
        </label>
        <span className="text-xs">
          <span className="text-muted-foreground">SO no </span>
          <span className="text-foreground font-mono font-semibold">{g.soNumber ?? '—'}</span>
        </span>
        <span className="text-xs">
          <span className="text-muted-foreground">MO no </span>
          <span className="text-foreground font-mono font-semibold">{g.moNumber ?? '—'}</span>
        </span>
        {g.styleNo && (
          <span className="text-xs">
            <span className="text-muted-foreground">Style </span>
            <span className="text-foreground font-mono font-semibold">{g.styleNo}</span>
          </span>
        )}
        <span className="text-muted-foreground ml-auto text-xs">
          {g.rows.length} {g.rows.length === 1 ? 'item' : 'items'}
        </span>
      </div>
    )
  }

  /** Which indent asked for a line, and when. */
  const indentOf = (r: IndentRow, label = false) => (
    <>
      {label && <span className="text-muted-foreground text-[11px]">Indent </span>}
      <span className="text-foreground font-mono text-xs font-semibold">{r.mrNumber}</span>
      <div className="text-muted-foreground text-[11px]">
        {formatDate(r.requestDate)}
        {r.department ? ` · ${r.department.name}` : ''}
      </div>
      {r.requiredDate && <div className="text-muted-foreground text-[11px]">needed by {formatDate(r.requiredDate)}</div>}
    </>
  )

  const itemOf = (r: IndentRow, g: Group) => {
    const remark = ownRemark(r)
    return (
      <>
        <div className="text-foreground text-sm font-medium leading-snug">{r.item.name}</div>
        <div className="text-muted-foreground text-[11px]">
          <span className="font-mono">{r.item.code}</span>
          {!g.styleNo && r.styleNo ? ` · style ${r.styleNo}` : ''}
          {remark && remark !== r.soNumber && remark.toLowerCase() !== r.department?.name.toLowerCase() ? ` · ${remark}` : ''}
        </div>
      </>
    )
  }

  const unit = (r: IndentRow) => r.item.uom?.symbol ?? ''

  const pendingBox = (r: IndentRow, wide: boolean) =>
    alreadyPicked.has(r.mrLineId) ? (
      <span className="text-muted-foreground text-[11px]">already on this order</span>
    ) : (
      <StepInput
        decimals
        className={`form-input h-8 text-right text-sm tabular-nums ${wide ? 'w-28' : 'w-full'} ${
          Number(amounts[r.mrLineId]) > r.pendingQty ? 'border-amber-500' : ''
        }`}
        value={amounts[r.mrLineId] ?? ''}
        onValueChange={(v) => {
          setAmounts((prev) => ({ ...prev, [r.mrLineId]: v }))
          // Typing a quantity means ordering it.
          if (Number(v) > 0 && !ticked.has(r.mrLineId)) toggle(r.mrLineId)
        }}
        aria-label={`Quantity to order of ${r.item.name}`}
      />
    )

  if (typeof document === 'undefined') return null

  /*
   * Portalled, like every other dialog here, and it has to be.
   *
   * This is opened from inside the purchase order form — which is itself
   * portalled, and whose backdrop carries `backdrop-blur-sm`. A
   * `backdrop-filter` makes that element the containing block for anything
   * `position: fixed` inside it, so `inset-0` here was measuring from the
   * order form's own backdrop rather than from the window: already inset past
   * the sidebar, and about to be inset past it a second time. Out at the body
   * it means the window, and the offset below is applied once.
   */
  return createPortal(
    <div className="fixed inset-0 z-[60] flex items-stretch justify-center bg-black/60 p-2 backdrop-blur-sm sm:left-[var(--sidebar-current-width)] sm:p-3">
      <div
        className="glass-card po-form flex h-full max-h-full w-full flex-col overflow-hidden"
        role="dialog"
        aria-modal="true"
        aria-labelledby="indent-items-title"
      >
        <div className="border-border flex shrink-0 items-center gap-3 border-b px-4 py-3">
          <div className="min-w-0">
            <h3 id="indent-items-title" className="text-foreground text-base font-semibold">
              Select from indent
            </h3>
            <p className="text-muted-foreground text-xs">
              What production has asked for and nobody has ordered yet, under the customer&apos;s order it is for
            </p>
          </div>
          <button
            className="btn-ghost ml-auto shrink-0 p-1.5"
            onClick={onClose}
            aria-label="Close indent items"
          >
            <X size={18} />
          </button>
        </div>

        <div className="border-border flex shrink-0 flex-wrap items-center gap-3 border-b px-4 py-2.5">
          <div className="border-field-edge bg-field flex min-w-0 flex-1 basis-full items-center gap-2 rounded-lg border px-3 py-2 sm:basis-auto sm:max-w-md">
            <Search size={14} className="text-muted-foreground shrink-0" />
            <input
              className="text-foreground placeholder:text-muted-foreground min-w-0 flex-1 border-0 bg-transparent text-sm outline-none"
              placeholder="Customer, SO, MO, indent no or item…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              aria-label="Search indent items"
            />
          </div>
          {selectable.length > 0 && (
            <label className="text-foreground flex items-center gap-2 text-xs">
              <input type="checkbox" checked={allTicked} onChange={() => toggleMany(shown)} aria-label="Select every line shown" />
              Select all shown
            </label>
          )}
          <span className="text-muted-foreground ml-auto text-xs">
            {groups.length} {groups.length === 1 ? 'order' : 'orders'} · {shown.length} {shown.length === 1 ? 'item' : 'items'}
            {picks.length > 0 && ` · ${picks.length} picked`}
          </span>
        </div>

        {error && (
          <div className="flex items-start gap-3 border-b border-red-500/40 bg-red-500/5 px-4 py-3">
            <AlertCircle size={16} className="mt-0.5 shrink-0 text-red-400" />
            <p className="text-sm text-red-400">{error}</p>
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
                {rows.length === 0
                  ? 'Nothing is waiting to be bought.'
                  : 'Nothing matches that. Clear the search to see the rest.'}
              </p>
              {/* Where these come from, said on the screen that has none.
                "Indent" is the mill's word and "Material Requisition" is this
                system's, and somebody looking at an empty list needs to be told
                both — and told which two conditions a line has to meet before it
                arrives here, because neither is obvious from the purchase side. */}
              {rows.length === 0 && (
                <p className="text-muted-foreground mx-auto mt-2 max-w-md text-xs">
                  Indents are raised in{' '}
                  <Link href="/inventory/requisitions" className="text-primary hover:underline">
                    Inventory &rarr; Requisitions
                  </Link>
                  . A line reaches this list once its requisition is{' '}
                  <span className="text-foreground">approved</span> and the store puts it on the indent
                  under <span className="text-foreground">Buy what&apos;s short</span>.
                </p>
              )}
            </div>
          ) : (
            <div className="p-4">
              {/* Cards below the width the columns can still be read at, the
                table above it — the same `list-scope` switch every purchase
                list uses. */}
              <div className="list-scope">
                <div className="list-cards space-y-4">
                  {groups.map((g) => (
                    <div key={g.key} className="border-border overflow-hidden rounded-xl border">
                      <div className="bg-secondary/70 border-border border-b px-3 py-2.5">{groupHead(g)}</div>
                      <div className="divide-border/70 divide-y">
                        {g.rows.map((r) => {
                          const taken = alreadyPicked.has(r.mrLineId)
                          const on = ticked.has(r.mrLineId)
                          return (
                            <div key={r.mrLineId} className={`p-3 ${taken ? 'opacity-50' : on ? 'bg-primary/5' : 'bg-card'}`}>
                              <div className="flex items-start gap-2.5">
                                <input
                                  type="checkbox"
                                  className="mt-1 shrink-0"
                                  checked={on}
                                  disabled={taken}
                                  onChange={() => toggle(r.mrLineId)}
                                  aria-label={`Order ${r.item.name} from ${r.mrNumber}`}
                                />
                                <div className="min-w-0 flex-1">
                                  {itemOf(r, g)}
                                  <div className="mt-1">{indentOf(r, true)}</div>
                                </div>
                              </div>
                              <div className="mt-2.5 grid grid-cols-3 gap-2">
                                <div>
                                  <p className="text-muted-foreground text-[10px] font-semibold uppercase tracking-wider">Required</p>
                                  <p className="text-foreground text-sm tabular-nums">
                                    {qty(r.indentQty)} <span className="text-muted-foreground text-[11px]">{unit(r)}</span>
                                  </p>
                                </div>
                                <div>
                                  <p className="text-muted-foreground text-[10px] font-semibold uppercase tracking-wider">Ordered</p>
                                  <p className="text-foreground text-sm tabular-nums">{qty(r.orderedQty)}</p>
                                </div>
                                <div>
                                  <p className="text-muted-foreground text-[10px] font-semibold uppercase tracking-wider">Pending PO</p>
                                  {pendingBox(r, false)}
                                </div>
                              </div>
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
                        <th className={TH}>Indent no &amp; date</th>
                        <th className={TH}>Item</th>
                        <th className={`${TH} !text-right`}>Required qty</th>
                        <th className={`${TH} !text-right`}>Already ordered</th>
                        <th className={`${TH} !text-right`}>Pending PO qty</th>
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
                          {g.rows.map((r) => {
                            const taken = alreadyPicked.has(r.mrLineId)
                            const on = ticked.has(r.mrLineId)
                            return (
                              <tr
                                key={r.mrLineId}
                                className={`border-border/40 cursor-pointer border-b last:border-0 ${
                                  taken ? 'opacity-50' : on ? 'bg-primary/10' : 'bg-card hover:bg-secondary/40'
                                }`}
                                // The whole row ticks it, not only the small box.
                                onClick={(e) => {
                                  if (taken || (e.target as HTMLElement).closest('input')) return
                                  toggle(r.mrLineId)
                                }}
                              >
                                <td className={`${TD} pl-5`}>
                                  <input
                                    type="checkbox"
                                    checked={on}
                                    disabled={taken}
                                    onChange={() => toggle(r.mrLineId)}
                                    aria-label={`Order ${r.item.name} from ${r.mrNumber}`}
                                  />
                                </td>
                                <td className={`${TD} whitespace-nowrap`}>{indentOf(r)}</td>
                                <td className={TD}>{itemOf(r, g)}</td>
                                <td className={`${TD} whitespace-nowrap text-right tabular-nums`}>
                                  <span className="text-sm font-semibold">{qty(r.indentQty)}</span>{' '}
                                  <span className="text-muted-foreground text-[11px]">{unit(r)}</span>
                                </td>
                                <td className={`${TD} text-right tabular-nums`}>
                                  {r.orderedQty > 0 ? qty(r.orderedQty) : <span className="text-muted-foreground">—</span>}
                                </td>
                                <td className={`${TD} text-right`}>
                                  <div className="flex justify-end">{pendingBox(r, true)}</div>
                                </td>
                              </tr>
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
          {/* A warning, not a refusal. Ordering more than was asked for is
            ordinary — the supplier sells thread in full cones — and the extra
            simply is not credited against the request. */}
          <p className="text-muted-foreground min-w-0 flex-1 text-xs">
            {overBooked.length > 0
              ? `${overBooked.length} ${
                  overBooked.length === 1 ? 'line is' : 'lines are'
                } over what was asked for. That is allowed — only the requested quantity counts against the indent.`
              : 'Tick the lines to order (or a whole order at its heading), change any quantity, then add them to the order.'}
          </p>
          {/* Both buttons stay one row even where the sentence above them
            gives up its own — it used to share that row too, which on a
            phone left it about four characters wide and reading top to
            bottom instead of left to right. */}
          <div className="flex shrink-0 items-center justify-end gap-3">
            <button className="btn-secondary" onClick={onClose}>
              Cancel
            </button>
            <button
              className="btn-primary disabled:cursor-not-allowed disabled:opacity-50"
              disabled={picks.length === 0}
              onClick={() => onAdd(picks)}
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
