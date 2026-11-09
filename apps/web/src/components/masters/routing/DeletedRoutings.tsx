'use client'

import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { History, Loader2, RotateCcw, X } from 'lucide-react'
import { api, ApiError, can } from '@/lib/api'
import { formatDate } from '@/lib/utils'
import { useEscape } from '@/lib/useEscape'

interface Deleted {
  auditId: string
  routingId: string
  name: string
  code: string
  version: number
  style: { code: string; name: string } | null
  category: string | null
  fabric: string | null
  steps: string[]
  deletedAt: string
  deletedBy: string | null
}

/**
 * Routings deleted and not brought back, from their copies in the audit log,
 * each with Restore: it comes back as it was — name, code, style, fabric,
 * steps, version and dates — so it takes its old place, not the "In use" one.
 */
export function DeletedRoutings({ open, onClose, onRestored }: { open: boolean; onClose: () => void; onRestored: (message: string) => void }) {
  const [rows, setRows] = useState<Deleted[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const mayRestore = can('masters', 'create')

  useEscape(() => {
    if (!busy) onClose()
  }, open)

  useEffect(() => {
    if (!open) return
    let alive = true
    setRows(null)
    setError(null)
    api
      .get<{ data: Deleted[] }>('/masters/routings/deleted')
      .then((r) => alive && setRows(r.data))
      .catch((err) => alive && setError(err instanceof ApiError ? err.message : 'Could not read the deleted routings.'))
    return () => {
      alive = false
    }
  }, [open])

  const restore = async (d: Deleted) => {
    setBusy(d.auditId)
    setError(null)
    try {
      const res = await api.post<{ message?: string }>(`/masters/routings/deleted/${d.auditId}/restore`, {})
      onRestored(res.message ?? `${d.name} is back.`)
      onClose()
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not bring it back.')
    } finally {
      setBusy(null)
    }
  }

  if (!open || typeof document === 'undefined') return null
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/60 p-4 backdrop-blur-sm sm:p-8">
      <div className="glass-card my-auto w-full max-w-3xl" role="dialog" aria-modal="true" aria-label="Deleted routings">
        <div className="border-border flex items-center justify-between border-b px-5 py-4">
          <div>
            <h2 className="text-foreground flex items-center gap-2 text-lg font-semibold">
              <History size={18} className="text-primary" /> Deleted routings
            </h2>
            <p className="text-muted-foreground mt-0.5 text-xs">Restore brings one back as it was: its name, style, fabric, steps, version and dates.</p>
          </div>
          <button onClick={onClose} className="btn-ghost p-2" aria-label="Close" disabled={!!busy}>
            <X size={18} />
          </button>
        </div>
        <div className="max-h-[70vh] overflow-y-auto px-5 py-4">
          {error && <p className="mb-3 rounded-lg border border-red-500/40 bg-red-500/5 p-3 text-sm text-red-500">{error}</p>}
          {!rows ? (
            !error && (
              <div className="space-y-2">
                {[0, 1, 2].map((i) => (
                  <div key={i} className="skeleton h-14 w-full rounded-lg" />
                ))}
              </div>
            )
          ) : rows.length === 0 ? (
            <p className="text-muted-foreground py-8 text-center text-sm">No deleted routings.</p>
          ) : (
            <ul className="divide-border/60 border-border divide-y rounded-lg border">
              {rows.map((d) => (
                <li key={d.auditId} className="flex flex-wrap items-center gap-3 px-3 py-2.5">
                  <div className="min-w-0 flex-1">
                    <p className="text-foreground text-sm font-medium">
                      {d.name} <span className="text-muted-foreground font-mono text-[11px] font-normal">· {d.code} · v{d.version}</span>
                    </p>
                    <p className="text-muted-foreground text-xs">
                      {d.style ? `For ${d.style.code} — ${d.style.name}` : d.category ? `Shared by every ${d.category} style` : 'Shared by any style'}
                      {d.fabric ? ` · ${d.fabric}` : ''} · {d.steps.length} steps: {d.steps.join(' → ')}
                    </p>
                    <p className="text-muted-foreground text-[11px]">
                      Deleted {formatDate(d.deletedAt)}
                      {d.deletedBy ? ` by ${d.deletedBy}` : ''}
                    </p>
                  </div>
                  {mayRestore && (
                    <button className="btn-secondary h-8 shrink-0 px-3 text-xs" onClick={() => void restore(d)} disabled={!!busy}>
                      {busy === d.auditId ? <Loader2 size={13} className="animate-spin" /> : <RotateCcw size={13} />} Restore
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>,
    document.body,
  )
}
