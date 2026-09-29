'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { AlertTriangle, PackageCheck } from 'lucide-react'
import { api } from '@/lib/api'

interface LowStockItem {
  id: string
  code: string
  name: string
  uom: string
  reorderLevel: number
  currentStock: number
  /** At or below the reorder level; otherwise only inside the early-warning margin. */
  belowReorder?: boolean
}

interface Totals {
  toReorder: number
  comingUp: number
}

export function LowStockWidget() {
  const [items, setItems] = useState<LowStockItem[] | null>(null)
  const [totals, setTotals] = useState<Totals | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false

    api
      .get<{ success: boolean; data: LowStockItem[]; totals?: Totals }>('/dashboard/low-stock?limit=6')
      .then((res) => {
        if (cancelled) return
        setItems(res.data)
        setTotals(res.totals ?? null)
      })
      .catch(() => {
        if (!cancelled) setError('Could not load stock alerts.')
      })

    return () => {
      cancelled = true
    }
  }, [])

  return (
    <div className="glass-card p-4">
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <div className="p-1.5 rounded-lg bg-red-500/10 border border-red-500/20">
            <AlertTriangle size={14} className="text-red-400" />
          </div>
          <h3 className="text-xs font-semibold text-foreground">Low Stock Alerts</h3>
        </div>
        {/* The card lists six; the badge is how many there are in all, the
          same number the stock screen gives. */}
        {totals && totals.toReorder > 0 && (
          <span className="badge-danger">{totals.toReorder} to reorder</span>
        )}
      </div>

      {error && <p className="text-xs text-red-400 py-6 text-center">{error}</p>}

      {!error && !items && (
        <div className="space-y-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="skeleton h-8 w-full rounded" />
          ))}
        </div>
      )}

      {!error && items && items.length === 0 && (
        <div className="py-6 text-center">
          <PackageCheck size={20} className="text-emerald-400 mx-auto mb-2" />
          <p className="text-xs text-muted-foreground">
            Nothing below its reorder level.
          </p>
        </div>
      )}

      {!error && items && items.length > 0 && (
        <div className="space-y-3">
          {items.map((item) => {
            // Out of stock entirely is a harder stop than merely dipping under
            // the reorder level, so the two are shown differently.
            const critical = item.currentStock <= 0

            return (
              <div key={item.id} className="flex items-center gap-3">
                <div
                  className={`w-2 h-2 rounded-full shrink-0 ${
                    critical ? 'bg-red-500 animate-pulse' : 'bg-amber-500'
                  }`}
                />
                <div className="flex-1 min-w-0">
                  <p className="text-xs font-medium text-foreground truncate">{item.name}</p>
                  <p className="text-[10px] text-muted-foreground">
                    {item.code} · Stock:{' '}
                    <span
                      className={
                        critical ? 'text-red-400 font-semibold' : 'text-amber-400 font-semibold'
                      }
                    >
                      {item.currentStock.toLocaleString('en-IN')} {item.uom}
                    </span>{' '}
                    of {item.reorderLevel.toLocaleString('en-IN')}
                    {item.belowReorder === false && (
                      <span className="text-muted-foreground"> · coming up</span>
                    )}
                  </p>
                </div>
              </div>
            )
          })}
          {totals && totals.toReorder + totals.comingUp > items.length && (
            <Link
              href="/inventory/stock?low=true"
              className="block pt-1 text-[11px] text-teal-400 hover:underline"
            >
              See all {totals.toReorder} to reorder on the stock screen →
            </Link>
          )}
        </div>
      )}
    </div>
  )
}
