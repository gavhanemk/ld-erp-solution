'use client'

import { useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { Loader2, PackageCheck, X } from 'lucide-react'
import { api, apiErrorMessage } from '@/lib/api'

export interface IssueLine {
  id: string
  requestedQty: string | number
  issuedQty: string | number
  fulfilment?: 'FROM_STOCK' | 'PURCHASE'
  item: { id: string; name: string; uom: { symbol: string } }
  warehouse: { id: string; name: string }
  /** Whose material the line draws. Absent or OWNED is ours. */
  ownership?: 'OWNED' | 'CUSTOMER_OWNED'
  ownerCustomer?: { id: string; name: string } | null
}

const fmt = (v: number) =>
  v.toLocaleString('en-IN', { minimumFractionDigits: 0, maximumFractionDigits: 3 })

/**
 * Handing material over against a requisition, all of it or part.
 *
 * Each line says what was asked, what has gone already, what is still owed and
 * what the rack holds, and the store enters what it is handing over now. It
 * starts at whichever is smaller, the amount owed or the amount on the rack,
 * so a short rack gives a part issue rather than a refusal; the rest stays
 * owed until it is handed over or the requisition is closed.
 *
 * Every line from the store is sent, a nought for the ones not being handed
 * over now: a line left out would be read by the API as "all of it".
 */
export function IssueDialog({
  mrId,
  mrNumber,
  lines,
  onClose,
  onDone,
}: {
  mrId: string
  mrNumber: string
  lines: IssueLine[]
  onClose: () => void
  onDone: (message: string) => void
}) {
  const fromStock = useMemo(() => lines.filter((l) => l.fulfilment !== 'PURCHASE'), [lines])
  const toBuy = lines.length - fromStock.length

  const owedOf = (l: IssueLine) =>
    Math.max(0, Number((Number(l.requestedQty) - Number(l.issuedQty)).toFixed(3)))

  const [onHand, setOnHand] = useState<Record<string, number>>({})
  const [qty, setQty] = useState<Record<string, string>>(() =>
    Object.fromEntries(fromStock.map((l) => [l.id, String(owedOf(l))])),
  )
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // What each rack holds; once known, a line owed more than that starts at
  // what is there.
  useEffect(() => {
    let cancelled = false
    void Promise.all(
      fromStock.map(async (l) => {
        try {
          // A customer's material is its own balance: our cloth on the same
          // rack is not theirs to hand over, nor theirs ours.
          const theirs = l.ownership === 'CUSTOMER_OWNED'
          const res = await api.get<{ data: Array<{ warehouseId: string; qty: number; ownerCustomerId?: string | null }> }>(
            `/inventory/stock?itemId=${l.item.id}&warehouseId=${l.warehouse.id}&ownership=${theirs ? 'CUSTOMER_OWNED' : 'OWNED'}`,
          )
          const row = res.data.find(
            (r) => r.warehouseId === l.warehouse.id && (!theirs || r.ownerCustomerId === l.ownerCustomer?.id),
          )
          return [l.id, Number(row?.qty ?? 0)] as const
        } catch {
          return [l.id, NaN] as const
        }
      }),
    ).then((entries) => {
      if (cancelled) return
      const map = Object.fromEntries(entries)
      setOnHand(map)
      setQty((prev) => {
        const next = { ...prev }
        for (const l of fromStock) {
          const have = map[l.id]
          if (Number.isFinite(have) && prev[l.id] === String(owedOf(l))) {
            next[l.id] = String(Math.max(0, Math.min(owedOf(l), have)))
          }
        }
        return next
      })
    })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fromStock])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !busy) onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose, busy])

  const problems = fromStock.flatMap((l) => {
    const v = Number(qty[l.id] || 0)
    if (!Number.isFinite(v) || v < 0) return [`${l.item.name}: enter a quantity of nought or more.`]
    if (v > owedOf(l) + 1e-9) return [`${l.item.name}: only ${fmt(owedOf(l))} is still owed.`]
    if (Number.isFinite(onHand[l.id]) && v > onHand[l.id] + 1e-9)
      return [`${l.item.name}: only ${fmt(onHand[l.id])} on the rack.`]
    return []
  })
  const total = fromStock.reduce((n, l) => n + (Number(qty[l.id]) > 0 ? 1 : 0), 0)
  const ready = problems.length === 0 && total > 0

  const submit = async () => {
    setBusy(true)
    setError(null)
    try {
      const res = await api.post<{ message: string }>(`/inventory/requisitions/${mrId}/issue`, {
        lines: fromStock.map((l) => ({ lineId: l.id, issueQty: Number(qty[l.id] || 0) })),
      })
      onDone(res.message)
    } catch (err) {
      setError(apiErrorMessage(err, 'Could not issue.'))
      setBusy(false)
    }
  }

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-3 backdrop-blur-sm sm:left-[var(--sidebar-current-width)]">
      <div
        className="glass-card po-form flex max-h-full w-full max-w-3xl flex-col overflow-hidden"
        role="dialog"
        aria-modal="true"
        aria-labelledby="issue-title"
      >
        <div className="border-border flex shrink-0 items-center justify-between gap-3 border-b px-5 py-3.5">
          <div className="flex min-w-0 items-center gap-3">
            <div className="bg-primary/10 border-primary/20 flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border">
              <PackageCheck size={19} className="text-primary" />
            </div>
            <div className="min-w-0">
              <h2 id="issue-title" className="text-foreground truncate text-lg font-semibold">
                Hand over material · {mrNumber}
              </h2>
              <p className="text-muted-foreground text-[13px]">
                Stock leaves the store now. Anything not handed over stays owed.
              </p>
            </div>
          </div>
          <button type="button" onClick={onClose} className="btn-ghost p-2" aria-label="Close" disabled={busy}>
            <X size={18} />
          </button>
        </div>

        <div className="flex-1 overflow-auto px-5 py-4">
          <table className="line-table w-full text-sm">
            <thead>
              <tr>
                <th>Item</th>
                <th style={{ textAlign: 'right' }}>Asked</th>
                <th style={{ textAlign: 'right' }}>Given</th>
                <th style={{ textAlign: 'right' }}>Owed</th>
                <th style={{ textAlign: 'right' }}>On rack</th>
                <th style={{ textAlign: 'right' }}>Hand over now</th>
              </tr>
            </thead>
            <tbody>
              {fromStock.map((l) => {
                const owed = owedOf(l)
                const have = onHand[l.id]
                const done = owed <= 0
                return (
                  <tr key={l.id} className={done ? 'opacity-50' : ''}>
                    <td className="px-3 py-2">
                      <div className="text-foreground font-medium">{l.item.name}</div>
                      <div className="text-muted-foreground text-[11px]">
                        {l.warehouse.name}
                        {l.ownership === 'CUSTOMER_OWNED' && (
                          <span className="text-sky-400"> · {l.ownerCustomer?.name ?? 'customer'}&apos;s material</span>
                        )}
                      </div>
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">{fmt(Number(l.requestedQty))}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{fmt(Number(l.issuedQty))}</td>
                    <td className="px-3 py-2 text-right font-medium tabular-nums">{fmt(owed)}</td>
                    <td
                      className={`px-3 py-2 text-right tabular-nums ${
                        Number.isFinite(have) && have < owed ? 'text-amber-500' : ''
                      }`}
                    >
                      {have === undefined ? '…' : Number.isFinite(have) ? fmt(have) : '—'}
                    </td>
                    <td className="px-3 py-2 text-right">
                      {done ? (
                        <span className="text-muted-foreground text-xs">Given in full</span>
                      ) : (
                        <div className="flex items-center justify-end gap-1.5">
                          <input
                            type="number"
                            min={0}
                            step="any"
                            className="form-input h-9 w-24 text-right tabular-nums"
                            value={qty[l.id] ?? ''}
                            onChange={(e) => setQty((p) => ({ ...p, [l.id]: e.target.value }))}
                            disabled={busy}
                            aria-label={`Hand over now, ${l.item.name}`}
                          />
                          <span className="text-muted-foreground w-8 text-left text-xs">
                            {l.item.uom.symbol}
                          </span>
                        </div>
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>

          {toBuy > 0 && (
            <p className="text-muted-foreground mt-3 text-xs">
              {toBuy} {toBuy === 1 ? 'line is' : 'lines are'} marked to be bought, so the store does
              not hand {toBuy === 1 ? 'it' : 'them'} over here.
            </p>
          )}

          {(problems.length > 0 || error) && (
            <div className="mt-3 space-y-1 rounded-lg border border-red-500/40 bg-red-500/5 p-3 text-sm text-red-500">
              {problems.map((p) => (
                <p key={p}>{p}</p>
              ))}
              {error && <p>{error}</p>}
            </div>
          )}
        </div>

        <div className="border-border flex shrink-0 items-center justify-end gap-2 border-t px-5 py-3">
          <button type="button" onClick={onClose} className="btn-secondary" disabled={busy}>
            Cancel
          </button>
          <button type="button" onClick={() => void submit()} disabled={!ready || busy} className="btn-primary">
            {busy ? <Loader2 size={15} className="animate-spin" /> : <PackageCheck size={15} />}
            Hand over
          </button>
        </div>
      </div>
    </div>,
    document.body,
  )
}
