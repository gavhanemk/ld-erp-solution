'use client'

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { useParams } from 'next/navigation'
import { ArrowLeft, AlertCircle, RefreshCw } from 'lucide-react'
import { api, ApiError } from '@/lib/api'
import { formatDate } from '@/lib/utils'
import { ScrollableTable } from '@/components/tables/ScrollableTable'

/**
 * One item: where it is, and the last fifty things that happened to it.
 *
 * This page exists to answer "why does it say 340 when I counted 300" without
 * anybody having to ask the store keeper. The movements are read only and
 * always will be — a ledger somebody can edit is not a ledger.
 */

interface WarehouseRow {
  warehouseId: string
  warehouseName: string
  ownership: 'OWNED' | 'CUSTOMER_OWNED'
  ownerName: string | null
  qty: number
  value: number
  avgRate: number
  isLow: boolean
}

interface Movement {
  id: string
  transactionType: string
  referenceType: string | null
  inQty: string | number
  outQty: string | number
  closingStock: string | number
  unitRate: string | number | null
  transactionDate: string
  notes: string | null
  warehouse: { id: string; name: string }
  ownerCustomer: { id: string; name: string } | null
}

interface Detail {
  item: {
    id: string
    code: string
    name: string
    hsnCode: string | null
    reorderLevel: string | number | null
    uom: { symbol: string }
    category: { name: string }
  }
  byWarehouse: WarehouseRow[]
  totals: { qty: number; value: number }
  movements: Movement[]
}

/**
 * A movement's colour says direction, and its word says why. Both are needed:
 * "issue" and "sale" are both stock going out, but only one of them is a
 * problem when it appears against packing material.
 */
const MOVEMENT: Record<string, string> = {
  OPENING: 'Opening',
  PURCHASE: 'Received',
  SALE: 'Sold',
  ISSUE: 'Issued',
  PRODUCTION: 'Produced',
  TRANSFER: 'Transfer',
  ADJUSTMENT: 'Count',
  RETURN: 'Returned',
  CUSTOMER_MATERIAL: "Customer's material",
}

const money = (v: number) =>
  v.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const qtyFmt = (v: number) =>
  v.toLocaleString('en-IN', { minimumFractionDigits: 0, maximumFractionDigits: 3 })

export default function StockItemPage() {
  const { itemId } = useParams<{ itemId: string }>()
  const [data, setData] = useState<Detail | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await api.get<{ data: Detail }>(`/inventory/stock/${itemId}`)
      setData(res.data)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not reach the server.')
    } finally {
      setLoading(false)
    }
  }, [itemId])

  useEffect(() => {
    void load()
  }, [load])

  if (loading && !data) {
    return <p className="text-sm text-muted-foreground">Loading...</p>
  }

  if (error) {
    return (
      <div className="flex items-start gap-3 p-3 rounded-lg border border-red-500/40 bg-red-500/5">
        <AlertCircle size={16} className="text-red-400 mt-0.5 shrink-0" />
        <p className="text-sm text-red-400">{error}</p>
      </div>
    )
  }

  if (!data) return null

  const { item, byWarehouse, totals, movements } = data
  const owned = byWarehouse.filter((r) => r.ownership === 'OWNED')

  return (
    <div className="space-y-5">
      <div className="page-header">
        <div>
          <Link
            href="/inventory/stock"
            className="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground"
          >
            <ArrowLeft size={13} /> All stock
          </Link>
          <h1 className="page-title mt-1">{item.name}</h1>
          <p className="page-subtitle font-mono">
            {item.code} · {item.category.name}
            {item.hsnCode ? ` · HSN ${item.hsnCode}` : ''}
          </p>
        </div>
        <button className="btn-ghost" onClick={() => void load()} disabled={loading}>
          <RefreshCw size={15} className={loading ? 'animate-spin' : undefined} />
        </button>
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        <div className="glass-card p-4">
          <p className="text-xs text-muted-foreground">On hand, everywhere</p>
          <p className="mt-1 text-2xl font-bold text-foreground tabular-nums">
            {qtyFmt(totals.qty)} <span className="text-sm font-normal">{item.uom.symbol}</span>
          </p>
        </div>
        <div className="glass-card p-4">
          <p className="text-xs text-muted-foreground">Carried at</p>
          <p className="mt-1 text-2xl font-bold text-foreground tabular-nums">
            ₹{money(totals.value)}
          </p>
          <p className="mt-0.5 text-[11px] text-muted-foreground">
            {totals.qty > 0 ? `₹${money(totals.value / totals.qty)} a ${item.uom.symbol}` : '—'}
          </p>
        </div>
        <div className="glass-card p-4">
          <p className="text-xs text-muted-foreground">Reorder level</p>
          <p className="mt-1 text-2xl font-bold text-foreground tabular-nums">
            {item.reorderLevel !== null ? qtyFmt(Number(item.reorderLevel)) : '—'}
          </p>
          <p className="mt-0.5 text-[11px] text-muted-foreground">
            {Number(item.reorderLevel) > 0 && totals.qty <= Number(item.reorderLevel)
              ? 'below it — time to order'
              : 'comfortable'}
          </p>
        </div>
      </div>

      <div className="glass-card p-0 overflow-hidden">
        <div className="px-4 py-3 border-b border-border">
          <h2 className="text-sm font-semibold text-foreground">Where it is</h2>
        </div>
        {byWarehouse.length === 0 ? (
          <p className="px-4 py-8 text-sm text-muted-foreground">None on hand anywhere.</p>
        ) : (
          <ScrollableTable>
            <table className="data-table table-compact min-w-full">
              <thead>
                <tr className="bg-secondary">
                  <th className="whitespace-nowrap">Store</th>
                  <th className="whitespace-nowrap" style={{ textAlign: 'right' }}>Quantity</th>
                  <th className="whitespace-nowrap" style={{ textAlign: 'right' }}>Rate</th>
                  <th className="whitespace-nowrap" style={{ textAlign: 'right' }}>Value</th>
                </tr>
              </thead>
              <tbody>
                {byWarehouse.map((w) => (
                  <tr key={`${w.warehouseId}-${w.ownerName ?? ''}`}>
                    <td>
                      {w.warehouseName}
                      {w.ownership === 'CUSTOMER_OWNED' && (
                        <div className="text-[10px] text-sky-400">
                          {w.ownerName ?? 'customer'}&apos;s material — not ours
                        </div>
                      )}
                    </td>
                    <td className="text-right tabular-nums">
                      {qtyFmt(w.qty)} {item.uom.symbol}
                    </td>
                    <td className="text-right tabular-nums text-muted-foreground">
                      {w.ownership === 'OWNED' ? `₹${money(w.avgRate)}` : '—'}
                    </td>
                    <td className="text-right tabular-nums font-semibold">
                      {w.ownership === 'OWNED' ? `₹${money(w.value)}` : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </ScrollableTable>
        )}
        {owned.length > 1 && (
          <p className="px-4 py-2 text-[11px] text-muted-foreground border-t border-border">
            Each store carries its own average rate, because what was paid for the cloth in one
            godown has nothing to do with what was paid for the cloth in another.
          </p>
        )}
      </div>

      <div className="glass-card p-0 overflow-hidden">
        <div className="px-4 py-3 border-b border-border flex items-center justify-between">
          <h2 className="text-sm font-semibold text-foreground">What has happened to it</h2>
          <Link
            href={`/inventory/ledger?itemId=${item.id}`}
            className="text-xs text-teal-400 hover:underline"
          >
            Full ledger →
          </Link>
        </div>
        {movements.length === 0 ? (
          <p className="px-4 py-8 text-sm text-muted-foreground">Nothing yet.</p>
        ) : (
          <ScrollableTable>
            <table className="data-table table-compact min-w-full">
              <thead>
                <tr className="bg-secondary">
                  <th className="whitespace-nowrap">Date</th>
                  <th className="whitespace-nowrap">What</th>
                  <th className="whitespace-nowrap">Store</th>
                  <th className="whitespace-nowrap" style={{ textAlign: 'right' }}>In</th>
                  <th className="whitespace-nowrap" style={{ textAlign: 'right' }}>Out</th>
                  <th className="whitespace-nowrap" style={{ textAlign: 'right' }}>Balance</th>
                  <th className="whitespace-nowrap">Note</th>
                </tr>
              </thead>
              <tbody>
                {movements.map((m) => {
                  const inQty = Number(m.inQty)
                  const outQty = Number(m.outQty)
                  return (
                    <tr key={m.id}>
                      <td className="text-xs whitespace-nowrap">
                        {formatDate(m.transactionDate)}
                      </td>
                      <td className="text-xs">
                        {MOVEMENT[m.transactionType] ?? m.transactionType}
                      </td>
                      <td className="text-xs">{m.warehouse.name}</td>
                      <td className="text-right tabular-nums text-emerald-400">
                        {inQty > 0 ? qtyFmt(inQty) : ''}
                      </td>
                      <td className="text-right tabular-nums text-red-400">
                        {outQty > 0 ? qtyFmt(outQty) : ''}
                      </td>
                      <td className="text-right tabular-nums font-semibold">
                        {qtyFmt(Number(m.closingStock))}
                      </td>
                      <td className="text-xs text-muted-foreground max-w-[240px] truncate">
                        {m.notes ?? ''}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </ScrollableTable>
        )}
      </div>
    </div>
  )
}
