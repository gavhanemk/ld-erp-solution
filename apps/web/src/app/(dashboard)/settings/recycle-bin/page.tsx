'use client'

import { useCallback, useEffect, useState } from 'react'
import { AlertCircle, Loader2, RefreshCw, RotateCcw, Trash2 } from 'lucide-react'
import { api, ApiError } from '@/lib/api'
import { SettingsCard } from '@/components/settings/ui'

/**
 * What has been deleted, and the way back.
 *
 * Moving a purchase order to the bin marks it rather than removing it, so
 * everything it had — lines, charges, files, its number — is still there.
 * Restoring is putting one field back, not rebuilding a document from a
 * description of it. Deleting one permanently here frees its number (27 Nov
 * 2026).
 *
 * Only purchase orders so far. The page says so plainly at the foot rather
 * than implying that everything deleted anywhere in the ERP arrives here,
 * because it does not yet.
 */
interface BinnedOrder {
  id: string
  poNumber: string
  poDate: string | null
  status: string
  totalAmount: string | number
  lineCount: number
  supplier: { id: string; name: string; code?: string | null } | null
  deletedAt: string
  deletedBy: string | null
  /** Sent to the supplier before it was binned: restore and cancel it; it cannot be destroyed. */
  wasSent?: boolean
}

export default function RecycleBinPage() {
  const [rows, setRows] = useState<BinnedOrder[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const res = await api.get<{ data: BinnedOrder[] }>('/purchase/recycle-bin')
      setRows(res.data)
      setError(null)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not read the recycle bin.')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const restore = async (row: BinnedOrder) => {
    setBusy(row.id)
    setMessage(null)
    try {
      const res = await api.post<{ message?: string }>(
        `/purchase/recycle-bin/${row.id}/restore`,
        {}
      )
      await load()
      setMessage(res.message ?? `${row.poNumber} restored.`)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not restore it.')
    } finally {
      setBusy(null)
    }
  }

  /*
   * The only thing on this screen that cannot be undone, so the prompt says so
   * in those words rather than asking "are you sure?". Leaving an order in the
   * bin costs nothing but its number, which stays reserved while it is here.
   */
  const destroy = async (row: BinnedOrder) => {
    const warning =
      `Delete ${row.poNumber} permanently? ` +
      'The order, its lines and anything attached to it are removed for good, and this cannot be undone. ' +
      `Its number is freed: if it is the latest order, the next purchase or service order takes ${row.poNumber}.`
    if (!confirm(warning)) return
    setBusy(row.id)
    setMessage(null)
    try {
      const res = await api.delete<{ message?: string }>(`/purchase/recycle-bin/${row.id}`)
      await load()
      setMessage(res.message ?? `${row.poNumber} deleted permanently.`)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not delete it.')
    } finally {
      setBusy(null)
    }
  }

  const money = (v: string | number) =>
    Number(v).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

  const when = (iso: string) =>
    new Date(iso).toLocaleString('en-IN', {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    })

  return (
    <div className="space-y-5">

      {error && (
        <div className="flex items-start gap-3 rounded-lg border border-red-500/40 bg-red-500/5 p-3">
          <AlertCircle size={16} className="mt-0.5 shrink-0 text-red-400" />
          <p className="text-sm text-red-400">{error}</p>
        </div>
      )}

      {message && (
        <div className="border-primary/30 bg-primary/5 rounded-lg border p-3">
          <p className="text-sm text-primary">{message}</p>
        </div>
      )}

      <SettingsCard
        icon={Trash2}
        title="Deleted purchase orders"
        description="Out of every list, report and search, but nothing has been thrown away — each keeps its number reserved, and restoring one puts it back exactly as it was. Deleting one permanently frees its number."
        flush
        actions={
          <button onClick={() => void load()} className="btn-secondary h-8 text-xs" disabled={loading}>
            <RefreshCw size={13} className={loading ? 'animate-spin' : ''} />
            Refresh
          </button>
        }
        footer={
          <p className="text-muted-foreground mr-auto text-xs">
            Only purchase orders arrive here so far. Deleting anything else in the ERP does not yet put it in this bin.
          </p>
        }
      >
        {loading ? (
          <div className="text-muted-foreground flex items-center justify-center gap-2 p-10 text-sm">
            <Loader2 size={16} className="animate-spin" />
            Reading the recycle bin...
          </div>
        ) : rows.length === 0 ? (
          <div className="p-10 text-center">
            <span className="bg-secondary mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-full">
              <Trash2 size={20} className="text-muted-foreground" />
            </span>
            <p className="text-foreground text-sm font-medium">The recycle bin is empty</p>
            <p className="text-muted-foreground mt-1 text-xs">
              Deleted purchase orders arrive here and stay until they are restored or deleted permanently.
            </p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-secondary border-border border-b">
                  {['Order', 'Supplier', 'Items', 'Total', 'Deleted', 'By', ''].map((h, i) => (
                    <th
                      key={h || i}
                      className={`text-muted-foreground px-4 py-2.5 text-[10px] font-semibold uppercase tracking-wider ${
                        h === 'Total' || h === 'Items' ? 'text-right' : 'text-left'
                      }`}
                    >
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.id} className="border-border/50 border-b last:border-0">
                    <td className="px-4 py-3">
                      <span className="font-mono text-xs">{row.poNumber}</span>
                      <span className="text-muted-foreground mt-0.5 block text-[10px]">
                        {row.status}
                      </span>
                    </td>
                    <td className="text-foreground px-4 py-3">{row.supplier?.name ?? '—'}</td>
                    <td className="text-muted-foreground px-4 py-3 text-right tabular-nums">
                      {row.lineCount}
                    </td>
                    <td className="px-4 py-3 text-right font-medium tabular-nums">
                      ₹{money(row.totalAmount)}
                    </td>
                    <td className="text-muted-foreground whitespace-nowrap px-4 py-3 text-xs">
                      {when(row.deletedAt)}
                    </td>
                    <td className="text-muted-foreground px-4 py-3 text-xs">
                      {row.deletedBy ?? '—'}
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex justify-end gap-1">
                        <button
                          onClick={() => void restore(row)}
                          disabled={busy === row.id}
                          className="btn-ghost p-1.5 hover:text-primary"
                          title="Put this order back"
                          aria-label={`Restore ${row.poNumber}`}
                        >
                          {busy === row.id ? (
                            <Loader2 size={15} className="animate-spin" />
                          ) : (
                            <RotateCcw size={15} />
                          )}
                        </button>
                        {/* An order the supplier had stays on record: restore and
                          cancel it. Its number is never given out again. */}
                        {row.wasSent ? (
                          <span
                            className="text-muted-foreground px-1.5 text-xs"
                            title="It was sent to the supplier, so it stays on record. Restore it and cancel it."
                          >
                            Sent — restore and cancel
                          </span>
                        ) : (
                        <button
                          onClick={() => void destroy(row)}
                          disabled={busy === row.id}
                          className="btn-ghost text-muted-foreground p-1.5 hover:text-red-400"
                          title="Delete permanently"
                          aria-label={`Delete ${row.poNumber} permanently`}
                        >
                          <Trash2 size={15} />
                        </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </SettingsCard>
    </div>
  )
}
