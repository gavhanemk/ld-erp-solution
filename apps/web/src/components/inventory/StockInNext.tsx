'use client'

import Link from 'next/link'
import { useState } from 'react'
import { CheckCircle2, FileText, Info, Tags } from 'lucide-react'
import { api, ApiError, currentUser } from '@/lib/api'
import { ReasonDialog } from '@/components/ui/ReasonDialog'
import { formatRupees } from '@/lib/utils'
import { StickersReady } from '@/components/packages/StickersReady'

/** Which items of an approved stock-in need stickers, and which are not kept in packages. */
export interface StickerNews {
  tracked: Array<{ itemId: string; code: string; name: string; qty: number }>
  untracked: Array<{ itemId: string; code: string; name: string; category: string }>
}

/** A stock-in just saved, as the server sent it back. */
export interface SavedStockIn {
  id: string
  adjustmentNumber: string
  warehouse: { name: string }
  lines: Array<{ difference: string | number; unitRate?: string | number | null }>
}

/**
 * Where the stickers are after a stock-in is approved, or why there are none.
 * Without it somebody approves 12 rolls and goes looking for stickers that a
 * category not kept in packages never makes. `onMake` opens the sticker
 * window again, for somebody who closed it with "Later".
 */
export function StickerNote({ stickers }: { stickers: StickerNews }) {
  const byCategory = new Map<string, string[]>()
  for (const u of stickers.untracked) byCategory.set(u.category, [...(byCategory.get(u.category) ?? []), u.name])

  return (
    <div className="mt-2 space-y-2">
      {[...byCategory].map(([category, items]) => (
        <div key={category} className="flex flex-wrap items-center gap-2">
          <Info size={14} className="text-muted-foreground shrink-0" />
          <span className="text-muted-foreground text-sm">
            No sticker for {items.join(', ')}: {category} is not kept in packages. To label it, switch on{' '}
            <span className="text-foreground font-medium">Track by package</span> for {category}.
          </span>
          <Link href="/masters/item-categories" className="btn-secondary h-7 px-2.5 text-xs">
            Item Categories
          </Link>
        </div>
      ))}
    </div>
  )
}

/**
 * What comes after saving a stock-in: approve it on the spot, when this person
 * may, or go to where a store manager will. Only an Admin may approve what
 * they entered themselves, so nobody else is offered a button the server
 * would refuse.
 */
export function StockInNext({ saved, message, onApproved }: { saved: SavedStockIn; message: string; onApproved: () => void }) {
  const admin = (currentUser() as { role?: string } | null)?.role === 'Admin'
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState<{ message: string; stickers?: StickerNews } | null>(null)
  // Approving opens the sticker window by itself; printing from it says so here.
  const [stickersOpen, setStickersOpen] = useState(false)
  const [printed, setPrinted] = useState<string | null>(null)

  const worth = saved.lines.reduce((s, l) => s + Number(l.difference) * Number(l.unitRate ?? 0), 0)

  const approve = async () => {
    setBusy(true)
    setError(null)
    try {
      const res = await api.post<{ message?: string; stickers?: StickerNews }>(`/inventory/adjustments/${saved.id}/approve`, {})
      setDone({ message: res.message ?? `${saved.adjustmentNumber} approved.`, stickers: res.stickers })
      setConfirming(false)
      if (res.stickers?.tracked.length) setStickersOpen(true)
      onApproved()
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not approve it.')
      setConfirming(false)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="rounded-lg border border-emerald-500/40 bg-emerald-500/5 p-3">
      {done ? (
        <>
          <p className="flex items-center gap-1.5 text-sm text-emerald-400">
            <CheckCircle2 size={15} />
            {done.message}
          </p>
          {printed ? (
            <p className="mt-1 flex items-center gap-1.5 text-sm text-emerald-400">
              <Tags size={14} />
              {printed}
            </p>
          ) : (
            done.stickers && <StickerNote stickers={done.stickers} />
          )}
        </>
      ) : (
        <>
          <p className="text-sm text-emerald-400">{message}</p>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            {admin && (
              <button type="button" className="btn-primary h-7 px-2.5 text-xs" onClick={() => setConfirming(true)} disabled={busy}>
                <CheckCircle2 size={13} />
                Approve now
              </button>
            )}
            <Link href={`/inventory/documents?tab=adjustments&open=${saved.id}`} className="btn-secondary h-7 px-2.5 text-xs">
              <FileText size={13} />
              See it in Stock Documents
            </Link>
            {!admin && <span className="text-muted-foreground text-xs">A store manager approves it there.</span>}
          </div>
          {error && <p className="mt-2 text-sm text-red-400">{error}</p>}
        </>
      )}

      {stickersOpen && (
        <StickersReady
          source={{ type: 'STOCK_IN', id: saved.id }}
          onClose={() => setStickersOpen(false)}
          onDone={(m) => {
            setStickersOpen(false)
            setPrinted(m)
          }}
        />
      )}
      {confirming && (
        <ReasonDialog
          title={`Approve ${saved.adjustmentNumber}?`}
          description={`${saved.lines.length} ${saved.lines.length === 1 ? 'item goes' : 'items go'} into stock in ${saved.warehouse.name} now, worth ${formatRupees(worth)}. This cannot be undone except by a stock count.`}
          confirmLabel="Approve and add to stock"
          requireReason={false}
          busy={busy}
          onConfirm={() => void approve()}
          onCancel={() => setConfirming(false)}
        />
      )}
    </div>
  )
}
