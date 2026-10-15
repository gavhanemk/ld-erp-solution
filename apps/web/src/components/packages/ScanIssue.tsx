'use client'

import { useState } from 'react'
import { CheckCircle2, Loader2, Printer, ScanLine } from 'lucide-react'
import { api, ApiError } from '@/lib/api'
import { StepInput } from '@/components/ui/StepInput'
import { StickerScanner } from './StickerSearch'
import { STATUS, packCount, printLabels, qtyText, type PackageDetail } from './packageTypes'

type Waiting = PackageDetail['requisitions'][number]

interface Issued {
  id: string
  code: string
  item: string
  qty: number
  left: number
  unit: string
  /** "roll", "box": what it was. */
  kind: string
  lot: string | null
  store: string
}

/**
 * Issuing an approved requisition by scanning its stickers: scan one, say how
 * much of it goes, press Issue — the store's stock comes down there and then,
 * and the sticker keeps the rest. Scan the next one straight after. A sticker
 * part-used gets a fresh one printed for what is left on it.
 */
export function ScanIssue({
  mrId,
  mrNumber,
  itemIds,
  onIssued,
}: {
  mrId: string
  mrNumber: string
  /** The items on the requisition, to say why a sticker cannot be issued against it. */
  itemIds: string[]
  onIssued: (message: string) => void
}) {
  const [pkg, setPkg] = useState<PackageDetail | null>(null)
  const [line, setLine] = useState<Waiting | null>(null)
  const [qty, setQty] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [issued, setIssued] = useState<Issued[]>([])
  // Bumped after each issue, so the scan box is fresh and focused for the next sticker.
  const [round, setRound] = useState(0)

  const read = async (code: string) => {
    setError(null)
    setBusy(true)
    try {
      const res = await api.get<{ data: PackageDetail }>(`/packages/scan/${encodeURIComponent(code)}`)
      const p = res.data
      const waiting = p.requisitions.find((r) => r.mrId === mrId)
      if (p.status !== 'IN_STOCK') {
        setError(`${p.code} is ${STATUS[p.status]?.label.toLowerCase() ?? p.status}: there is nothing on it to issue.`)
      } else if (!waiting) {
        setError(
          itemIds.includes(p.item.id)
            ? `${mrNumber} has already been given all the ${p.item.name} it asked for.`
            : `${p.code} is ${p.item.name}, which is not on ${mrNumber}.`,
        )
      } else {
        setPkg(p)
        setLine(waiting)
        setQty(String(Math.round(Math.min(waiting.owed, p.qty) * 1000) / 1000))
        return
      }
      setPkg(null)
      setLine(null)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not read that sticker.')
    } finally {
      setBusy(false)
    }
  }

  const n = Number(qty) || 0
  const problem = !pkg || !line ? null : !(n > 0) ? 'Enter how much goes.' : n > pkg.qty + 1e-9 ? `${pkg.code} has only ${qtyText(pkg.qty)} ${pkg.unit} on it.` : n > line.owed + 1e-9 ? `${mrNumber} needs only ${qtyText(line.owed)} ${pkg.unit} more.` : null

  const issue = async () => {
    if (!pkg || !line || problem) return
    setBusy(true)
    setError(null)
    try {
      const res = await api.post<{ message: string; data: PackageDetail }>(`/packages/${pkg.id}/issue`, { mrId, lineId: line.lineId, qty: n })
      setIssued((list) => [
        { id: pkg.id, code: pkg.code, item: pkg.item.name, qty: n, left: res.data.qty, unit: pkg.unit, kind: packCount(1, pkg.packType).replace(/^1 /, ''), lot: pkg.lotNo, store: pkg.warehouse.name },
        ...list,
      ])
      setPkg(null)
      setLine(null)
      setQty('')
      setRound((r) => r + 1)
      onIssued(res.message)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not issue it.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="relative z-20 space-y-3 rounded-xl border border-border bg-card p-3">
      <p className="flex flex-wrap items-center gap-x-2 text-sm">
        <ScanLine size={16} className="text-primary" />
        <span className="font-semibold text-foreground">Scan stickers to issue</span>
        <span className="text-muted-foreground">— each one comes out of stock the moment you press Issue.</span>
      </p>
      {/* Typing finds this requisition's own items in stock: a word, a lot, a challan, a supplier. */}
      <StickerScanner
        key={round}
        onCode={(c) => void read(c)}
        busy={busy}
        status="IN_STOCK"
        itemIds={itemIds}
        placeholder="Scan a sticker, or type the item, lot, rack, challan or supplier"
      />
      {error && <p className="text-sm text-red-400">{error}</p>}

      {pkg && line && (
        <div className="flex flex-wrap items-end gap-3 rounded-lg border border-primary/40 bg-primary/5 p-3">
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-semibold text-foreground">{pkg.item.name}</div>
            <div className="text-xs text-muted-foreground">
              A {packCount(1, pkg.packType).replace(/^1 /, '')} of {qtyText(pkg.qty)} {pkg.unit}
              {pkg.lotNo ? ` · lot ${pkg.lotNo}` : ''} · {pkg.warehouse.name}
              {pkg.rack ? `, rack ${pkg.rack}` : ''} · {qtyText(line.owed)} {pkg.unit} still needed
            </div>
            <div className="font-mono text-[11px] text-muted-foreground">sticker {pkg.code}</div>
          </div>
          <label className="text-xs text-muted-foreground">
            How much goes
            <div className="mt-1 flex items-center gap-1.5">
              <StepInput
                className="form-input h-10 w-28 text-right text-base"
                value={qty}
                onValueChange={setQty}
                decimals
                autoFocus
                onKeyDown={(e) => e.key === 'Enter' && void issue()}
                aria-label={`How much of ${pkg.code} to issue`}
              />
              <span className="text-sm text-foreground">{pkg.unit}</span>
            </div>
          </label>
          <button type="button" className="btn-primary h-10" onClick={() => void issue()} disabled={busy || !!problem}>
            {busy ? <Loader2 size={15} className="animate-spin" /> : <CheckCircle2 size={15} />}
            Issue {n > 0 ? `${qtyText(n)} ${pkg.unit}` : ''}
          </button>
          <button
            type="button"
            className="btn-secondary h-10"
            onClick={() => {
              setPkg(null)
              setLine(null)
              setRound((r) => r + 1)
            }}
            disabled={busy}
          >
            Cancel
          </button>
          {problem && n > 0 && <p className="w-full text-sm text-red-400">{problem}</p>}
        </div>
      )}

      {issued.length > 0 && (
        <ul className="divide-y divide-border rounded-lg border border-border text-sm">
          {issued.map((d, i) => (
            <li key={`${d.code}-${i}`} className="flex flex-wrap items-center gap-2 px-3 py-2">
              <CheckCircle2 size={14} className="shrink-0 text-emerald-500" />
              <span className="min-w-0 flex-1">
                <span className="font-semibold text-foreground">
                  {qtyText(d.qty)} {d.unit} {d.item}
                </span>{' '}
                <span className="text-muted-foreground">
                  {d.left > 0
                    ? `issued from a ${d.kind}${d.lot ? ` (lot ${d.lot})` : ''} — ${qtyText(d.left)} ${d.unit} left on it in ${d.store}`
                    : `issued — the whole ${d.kind}${d.lot ? ` (lot ${d.lot})` : ''}, now out of ${d.store}`}
                </span>{' '}
                <span className="font-mono text-[11px] text-muted-foreground">{d.code}</span>
              </span>
              {d.left > 0 && (
                <button type="button" className="btn-secondary h-8 px-2.5 text-xs" onClick={() => printLabels([d.id])} title="The old sticker still shows what it held before">
                  <Printer size={13} /> Print fresh sticker
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
