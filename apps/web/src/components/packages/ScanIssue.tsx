'use client'

import { useEffect, useRef, useState } from 'react'
import { CheckCircle2, Loader2, Printer, ScanLine } from 'lucide-react'
import { api, ApiError } from '@/lib/api'
import { newRequestId } from '@/lib/utils'
import { StepInput } from '@/components/ui/StepInput'
import { StickerScanner } from './StickerSearch'
import { FifoOverride, isFifoStop } from './FifoOverride'
import { STATUS, packCount, printLabels, qtyText, type PackageDetail } from './packageTypes'

type Waiting = PackageDetail['requisitions'][number]

interface Issued {
  id: string
  code: string
  item: string
  qty: number
  /** What is left on the same sticker: nought when the whole of it went. */
  left: number
  /** Only for an issue made before part of a roll kept its sticker: the new sticker for what was left. */
  newSticker: { id: string; code: string } | null
  unit: string
  /** "roll", "box": what it was. */
  kind: string
  lot: string | null
  store: string
}

/**
 * Issuing an approved requisition by scanning its stickers: scan one, say how
 * much of it goes, press Issue — the store's stock comes down there and then.
 * Scan the next one straight after. A packet only partly issued keeps its
 * sticker, and what is left stays on it: 50, then 40, then 35. An older
 * packet of the same item still on the rack goes first (FIFO), unless the
 * store manager lets this one go, with a reason.
 */
export function ScanIssue({
  mrId,
  mrNumber,
  itemIds,
  onIssued,
  pick,
}: {
  mrId: string
  mrNumber: string
  /** The items on the requisition, to say why a sticker cannot be issued against it. */
  itemIds: string[]
  onIssued: (message: string) => void
  /** A packet chosen from the pick list: read as if its sticker had been scanned. */
  pick?: { code: string; n: number } | null
}) {
  const [pkg, setPkg] = useState<PackageDetail | null>(null)
  const [line, setLine] = useState<Waiting | null>(null)
  const [qty, setQty] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [issued, setIssued] = useState<Issued[]>([])
  // FIFO stopped this one: the server's words, naming the older package.
  const [fifo, setFifo] = useState<string | null>(null)
  // Bumped after each issue, so the scan box is fresh and focused for the next sticker.
  const [round, setRound] = useState(0)
  // Set the moment Issue is pressed, before any state settles: a second Enter
  // a scanner sends straight after the first is dropped here, and the id
  // below makes the server issue once even if both got through.
  const sending = useRef(false)
  const requestId = useRef<string>('')

  const read = async (code: string) => {
    setError(null)
    setFifo(null)
    setBusy(true)
    try {
      const res = await api.get<{ data: PackageDetail }>(`/packages/scan/${encodeURIComponent(code)}`)
      const p = res.data
      const waiting = p.requisitions.find((r) => r.mrId === mrId)
      if (p.status === 'SPLIT') {
        setError(
          p.replacedBy?.length
            ? `${p.code} is retired. What is left of its roll is now ${p.replacedBy.map((r) => `${r.code} (${qtyText(r.qty)} ${p.unit})`).join(', ')} — scan that sticker instead.`
            : `${p.code} is retired, and nothing of its roll is left in stock.`,
        )
      } else if (p.status !== 'IN_STOCK') {
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
        requestId.current = newRequestId()
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

  // A packet chosen from the pick list below: the same as scanning it.
  const panel = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!pick) return
    void read(pick.code)
    panel.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
    // Only when another packet is chosen.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pick?.n])

  const n = Number(qty) || 0
  const problem = !pkg || !line ? null : !(n > 0) ? 'Enter how much goes.' : n > pkg.qty + 1e-9 ? `${pkg.code} has only ${qtyText(pkg.qty)} ${pkg.unit} on it.` : n > line.owed + 1e-9 ? `${mrNumber} needs only ${qtyText(line.owed)} ${pkg.unit} more.` : null

  const issue = async (fifoReason?: string) => {
    if (!pkg || !line || problem || sending.current) return
    sending.current = true
    setBusy(true)
    setError(null)
    try {
      const res = await api.post<{ message: string; data: PackageDetail & { newSticker: { id: string; code: string; qty: number } | null } }>(`/packages/${pkg.id}/issue`, {
        mrId,
        lineId: line.lineId,
        qty: n,
        requestId: requestId.current,
        ...(fifoReason ? { fifoReason } : {}),
      })
      setFifo(null)
      const fresh = res.data.newSticker
      setIssued((list) => [
        {
          id: pkg.id,
          code: pkg.code,
          item: pkg.item.name,
          qty: n,
          left: fresh?.qty ?? (res.data.status === 'IN_STOCK' ? res.data.qty : 0),
          newSticker: fresh ? { id: fresh.id, code: fresh.code } : null,
          unit: pkg.unit,
          kind: packCount(1, pkg.packType).replace(/^1 /, ''),
          lot: pkg.lotNo,
          store: pkg.warehouse.name,
        },
        ...list,
      ])
      setPkg(null)
      setLine(null)
      setQty('')
      setRound((r) => r + 1)
      onIssued(res.message)
    } catch (err) {
      if (err instanceof ApiError && isFifoStop(err.code)) setFifo(err.message)
      else setError(err instanceof ApiError ? err.message : 'Could not issue it.')
    } finally {
      sending.current = false
      setBusy(false)
    }
  }

  return (
    <div ref={panel} className="relative z-20 space-y-3">
      <p className="flex flex-wrap items-center gap-x-2 text-sm">
        <ScanLine size={16} className="text-primary" />
        <span className="font-semibold text-foreground">Scan items to issue</span>
        <span className="text-xs text-muted-foreground">each sticker comes out of stock the moment you press Issue</span>
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
                onKeyDown={(e) => {
                  if (e.key !== 'Enter') return
                  e.preventDefault()
                  if (!fifo) void issue()
                }}
                aria-label={`How much of ${pkg.code} to issue`}
              />
              <span className="text-sm text-foreground">{pkg.unit}</span>
            </div>
          </label>
          <button type="button" className="btn-primary h-10" onClick={() => void issue()} disabled={busy || !!problem || !!fifo}>
            {busy ? <Loader2 size={15} className="animate-spin" /> : <CheckCircle2 size={15} />}
            Issue {n > 0 ? `${qtyText(n)} ${pkg.unit}` : ''}
          </button>
          <button
            type="button"
            className="btn-secondary h-10"
            onClick={() => {
              setPkg(null)
              setLine(null)
              setFifo(null)
              setRound((r) => r + 1)
            }}
            disabled={busy}
          >
            Cancel
          </button>
          {problem && n > 0 && <p className="w-full text-sm text-red-400">{problem}</p>}
          {fifo && (
            <div className="w-full">
              <FifoOverride message={fifo} busy={busy} onAllow={(reason) => void issue(reason)} />
            </div>
          )}
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
                  {d.newSticker
                    ? `issued from a ${d.kind}${d.lot ? ` (lot ${d.lot})` : ''} — the ${qtyText(d.left)} ${d.unit} left in ${d.store} is now ${d.newSticker.code}; ${d.code} is retired`
                    : d.left > 0
                      ? `issued from a ${d.kind}${d.lot ? ` (lot ${d.lot})` : ''} — ${qtyText(d.left)} ${d.unit} left on the same sticker in ${d.store}`
                      : `issued — the whole ${d.kind}${d.lot ? ` (lot ${d.lot})` : ''}, now out of ${d.store}`}
                </span>{' '}
                <span className="font-mono text-[11px] text-muted-foreground">{d.code}</span>
              </span>
              {d.newSticker ? (
                <button
                  type="button"
                  className="btn-secondary h-8 px-2.5 text-xs"
                  onClick={() => printLabels([d.newSticker!.id])}
                  title={`Put it on the roll in place of ${d.code}`}
                >
                  <Printer size={13} /> Print {d.newSticker.code}
                </button>
              ) : (
                d.left > 0 && (
                  // Not needed: the sticker on it still scans to what is left. Only for a packet opened often.
                  <button
                    type="button"
                    className="btn-ghost h-8 px-2.5 text-xs text-muted-foreground"
                    onClick={() => printLabels([d.id])}
                    title={`The same code, printed with the ${qtyText(d.left)} ${d.unit} left`}
                  >
                    <Printer size={13} /> Reprint with balance
                  </button>
                )
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
