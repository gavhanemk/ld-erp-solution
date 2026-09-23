'use client'

import { useEffect, useMemo, useState } from 'react'
import { X, Loader2, AlertCircle, Search } from 'lucide-react'
import { api, ApiError } from '@/lib/api'
import { formatDate } from '@/lib/utils'

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

  // Everything typed into the box at once — number, item, job, department.
  // A buyer looking for "the thread on MO00010" should not have to know which
  // of four boxes that word lives in.
  const shown = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return rows
    return rows.filter((r) =>
      [r.mrNumber, r.item.code, r.item.name, r.moNumber, r.soNumber, r.department?.name, r.remark]
        .filter(Boolean)
        .some((v) => String(v).toLowerCase().includes(q))
    )
  }, [rows, search])

  const selectable = shown.filter((r) => !alreadyPicked.has(r.mrLineId))
  const allTicked = selectable.length > 0 && selectable.every((r) => ticked.has(r.mrLineId))

  const toggle = (id: string) =>
    setTicked((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  const toggleAll = () =>
    setTicked((prev) => {
      const next = new Set(prev)
      if (allTicked) selectable.forEach((r) => next.delete(r.mrLineId))
      else selectable.forEach((r) => next.add(r.mrLineId))
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
  const TD = 'text-foreground px-3 py-2 align-middle text-xs'

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/60 p-4 backdrop-blur-sm">
      <div className="border-border bg-card my-4 w-full max-w-6xl overflow-hidden rounded-xl border shadow-2xl">
        <div className="border-border flex items-center gap-3 border-b px-4 py-3">
          <div className="min-w-0">
            <h3 className="text-foreground text-base font-semibold">Indent items</h3>
            <p className="text-muted-foreground text-xs">
              What production has asked for and nobody has ordered yet
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

        <div className="border-border flex flex-wrap items-center gap-3 border-b px-4 py-2.5">
          <div className="border-field-edge bg-field flex w-full min-w-0 flex-1 items-center gap-2 rounded-lg border px-3 py-2 sm:w-auto sm:max-w-sm">
            <Search size={14} className="text-muted-foreground shrink-0" />
            <input
              className="text-foreground placeholder:text-muted-foreground min-w-0 flex-1 border-0 bg-transparent text-sm outline-none"
              placeholder="Indent no, item, job, department…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              aria-label="Search indent items"
            />
          </div>
          <span className="text-muted-foreground ml-auto text-xs">
            {shown.length} {shown.length === 1 ? 'line' : 'lines'}
            {picks.length > 0 && ` · ${picks.length} picked`}
          </span>
        </div>

        {error && (
          <div className="flex items-start gap-3 border-b border-red-500/40 bg-red-500/5 px-4 py-3">
            <AlertCircle size={16} className="mt-0.5 shrink-0 text-red-400" />
            <p className="text-sm text-red-400">{error}</p>
          </div>
        )}

        <div className="max-h-[52vh] overflow-auto">
          {loading ? (
            <p className="text-muted-foreground flex items-center gap-2 px-4 py-10 text-sm">
              <Loader2 size={15} className="animate-spin" /> Loading…
            </p>
          ) : shown.length === 0 ? (
            <div className="px-4 py-10 text-center">
              <p className="text-muted-foreground text-sm">
                {rows.length === 0
                  ? 'Nothing is waiting to be bought. A requisition line only appears here once it is approved and marked “Buy it”.'
                  : 'Nothing matches that. Clear the search to see the rest.'}
              </p>
            </div>
          ) : (
            <table className="w-full min-w-[1000px] text-sm">
              <thead className="bg-secondary sticky top-0 z-10">
                <tr className="border-border border-b">
                  <th className={`${TH} w-10`}>
                    <input
                      type="checkbox"
                      checked={allTicked}
                      onChange={toggleAll}
                      disabled={selectable.length === 0}
                      aria-label="Select every line shown"
                    />
                  </th>
                  <th className={TH}>Indent no</th>
                  <th className={TH}>SO no</th>
                  <th className={TH}>MO no</th>
                  <th className={TH}>Remark</th>
                  <th className={TH}>Item</th>
                  <th className={`${TH} !text-right`}>Indent qty</th>
                  <th className={`${TH} !text-right`}>PO created qty</th>
                  <th className={`${TH} !text-right`}>PO pending qty</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((r) => {
                  const taken = alreadyPicked.has(r.mrLineId)
                  const on = ticked.has(r.mrLineId)
                  const over = Number(amounts[r.mrLineId]) > r.pendingQty
                  return (
                    <tr
                      key={r.mrLineId}
                      className={`border-border/40 border-b last:border-0 ${
                        taken ? 'opacity-50' : on ? 'bg-primary/5' : ''
                      }`}
                    >
                      <td className={TD}>
                        <input
                          type="checkbox"
                          checked={on}
                          disabled={taken}
                          onChange={() => toggle(r.mrLineId)}
                          aria-label={`Order ${r.item.name} from ${r.mrNumber}`}
                        />
                      </td>
                      <td className={`${TD} whitespace-nowrap font-mono`}>
                        {r.mrNumber}
                        <div className="text-muted-foreground text-[10px]">
                          {formatDate(r.requestDate)}
                        </div>
                      </td>
                      <td className={`${TD} text-muted-foreground`}>{r.soNumber ?? '—'}</td>
                      <td className={TD}>
                        {r.moNumber ?? <span className="text-muted-foreground">—</span>}
                      </td>
                      <td className={TD}>
                        {r.remark ?? <span className="text-muted-foreground">—</span>}
                        {r.department && (
                          <div className="text-muted-foreground text-[10px]">
                            {r.department.name}
                          </div>
                        )}
                      </td>
                      <td className={TD}>
                        <div className="text-foreground">{r.item.name}</div>
                        <div className="text-muted-foreground font-mono text-[10px]">
                          {r.item.code}
                        </div>
                      </td>
                      <td className={`${TD} whitespace-nowrap text-right tabular-nums`}>
                        {qty(r.indentQty)} {r.item.uom?.symbol ?? ''}
                      </td>
                      <td className={`${TD} text-right tabular-nums`}>{qty(r.orderedQty)}</td>
                      <td className={`${TD} text-right`}>
                        {taken ? (
                          <span className="text-muted-foreground text-[11px]">
                            already on this order
                          </span>
                        ) : (
                          /* The wheel and the arrow keys move this by whole units.
                           Not 0.001, which moved it by a thousandth of a piece; and not 1,
                           which would refuse 1500.5 metres of fabric outright. "any" steps
                           by one while still accepting a decimal that is typed. */
                          <input
                            type="number"
                            step="any"
                            min="0"
                            className={`form-input h-8 w-24 text-right tabular-nums ${
                              over ? 'border-amber-500' : ''
                            }`}
                            value={amounts[r.mrLineId] ?? ''}
                            onChange={(e) =>
                              setAmounts((prev) => ({ ...prev, [r.mrLineId]: e.target.value }))
                            }
                            aria-label={`Quantity to order of ${r.item.name}`}
                          />
                        )}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          )}
        </div>

        <div className="border-border flex flex-wrap items-center gap-3 border-t px-4 py-3">
          {/* A warning, not a refusal. Ordering more than was asked for is
            ordinary — the supplier sells thread in full cones — and the extra
            simply is not credited against the request. */}
          <p className="text-muted-foreground min-w-0 flex-1 text-xs">
            {overBooked.length > 0
              ? `${overBooked.length} ${
                  overBooked.length === 1 ? 'line is' : 'lines are'
                } over what was asked for. That is allowed — only the requested quantity counts against the indent.`
              : 'Tick the lines to order, change any quantity, then add them to the order.'}
          </p>
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
  )
}
