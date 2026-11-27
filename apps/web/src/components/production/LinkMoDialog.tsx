'use client'

import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { Link2, Loader2 } from 'lucide-react'
import { api, ApiError } from '@/lib/api'
import { formatDate } from '@/lib/utils'
import { useEscape } from '@/lib/useEscape'
import { SmartSelect } from '@/components/ui/SmartSelect'

/** A sales order a direct manufacturing order can be made for: it has every style and colour the MO makes. */
interface Linkable {
  id: string
  soNumber: string
  customer: string
  deliveryDate: string | null
  brand: string
}

/**
 * A direct manufacturing order (stock or samples) taken over by a sales
 * order: pick the order, and each of its lines goes on the order's line of
 * the same finished item. Only orders with every style and colour it makes
 * are offered.
 */
export function LinkMoDialog({ moId, moNumber, onCancel, onLinked }: { moId: string; moNumber: string; onCancel: () => void; onLinked: (message: string) => void }) {
  const [orders, setOrders] = useState<Linkable[] | null>(null)
  const [soId, setSoId] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  useEscape(() => {
    if (!busy) onCancel()
  }, true)

  useEffect(() => {
    api
      .get<{ data: Linkable[] }>(`/production/orders/${moId}/linkable`)
      .then((r) => setOrders(r.data))
      .catch((err) => {
        setOrders([])
        setError(err instanceof ApiError ? err.message : 'Could not load the sales orders.')
      })
  }, [moId])

  const link = async () => {
    if (!soId) return
    setBusy(true)
    setError(null)
    try {
      const res = await api.post<{ message?: string }>(`/production/orders/${moId}/link`, { soId })
      onLinked(res.message ?? `${moNumber} linked.`)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not link it.')
      setBusy(false)
    }
  }

  const picked = orders?.find((o) => o.id === soId)
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm" onClick={() => !busy && onCancel()}>
      <div className="glass-card w-full max-w-md p-5" role="dialog" aria-modal="true" aria-labelledby="link-mo-title" onClick={(e) => e.stopPropagation()}>
        <h2 id="link-mo-title" className="text-foreground text-base font-semibold">
          Make {moNumber} for a sales order
        </h2>
        <p className="text-muted-foreground mt-1 text-sm">
          Its lines go on the order&apos;s lines of the same items, it takes the order&apos;s brand, and pieces already tagged are kept for the order. Anything made beyond what the order still needs goes to stock.
        </p>
        <label className="mt-4 block" htmlFor="link-mo-so">
          <span className="form-label">Sales order</span>
        </label>
        {orders === null ? (
          <div className="skeleton h-10 w-full rounded-lg" />
        ) : orders.length ? (
          <SmartSelect id="link-mo-so" className="form-input" value={soId} onChange={(e) => setSoId(e.target.value)}>
            <option value="">Pick the order…</option>
            {orders.map((o) => (
              <option key={o.id} value={o.id} data-sub={`${o.customer} · ${o.brand}${o.deliveryDate ? ` · due ${formatDate(o.deliveryDate)}` : ''}`}>
                {o.soNumber}
              </option>
            ))}
          </SmartSelect>
        ) : (
          <p className="text-muted-foreground text-sm">No open sales order has every style and colour {moNumber} makes.</p>
        )}
        {picked && <p className="text-muted-foreground mt-2 text-xs">From then on it shows {picked.customer}, under {picked.brand}.</p>}
        {error && <p className="text-destructive mt-3 text-sm">{error}</p>}
        <div className="mt-5 flex justify-end gap-2">
          <button type="button" className="btn-secondary" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          <button type="button" className="btn-primary" onClick={() => void link()} disabled={!soId || busy}>
            {busy ? <Loader2 size={15} className="animate-spin" /> : <Link2 size={15} />} Make it for this order
          </button>
        </div>
      </div>
    </div>,
    document.body
  )
}
