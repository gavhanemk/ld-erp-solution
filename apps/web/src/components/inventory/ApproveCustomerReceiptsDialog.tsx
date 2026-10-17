'use client'

import { useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { X, Loader2, AlertCircle, BadgeCheck } from 'lucide-react'
import { api, ApiError } from '@/lib/api'
import { formatDate } from '@/lib/utils'
import { useEscape } from '@/lib/useEscape'

/**
 * Approving several customer receipts into stock at once.
 *
 * A sheet's receipts skip QC and wait here, and so does anything QC has
 * checked; an approver ticks what goes in and approves them together. Each is
 * approved on its own, as one at a time would be: one that cannot be — its
 * order closed, its customer switched off — is listed with the reason and
 * stays waiting, and the rest still go in.
 */

export interface WaitingReceipt {
  id: string
  grnNumber: string
  receiptDate: string
  customerName: string
  warehouseName: string
  challanNumber: string | null
  soNumber: string | null
  /** From a sheet: no QC, straight to stock approval. */
  imported: boolean
  inspectedByName: string | null
  lines: Array<{ itemName: string; uom: string; received: number; rejected: number; rejectReason: string | null }>
}

interface Refused {
  id: string
  grnNumber: string
  message: string
}

const fmt = (v: number) => v.toLocaleString('en-IN', { maximumFractionDigits: 3 })

/** "120 m, 40 pcs": the lines' quantities added up unit by unit. */
function byUnit(lines: WaitingReceipt['lines'], pick: (l: WaitingReceipt['lines'][number]) => number) {
  const sums = new Map<string, number>()
  for (const l of lines) sums.set(l.uom, (sums.get(l.uom) ?? 0) + pick(l))
  return [...sums]
    .filter(([, v]) => v > 0)
    .map(([u, v]) => `${fmt(v)} ${u}`.trim())
    .join(', ')
}

export function ApproveCustomerReceiptsDialog({
  receipts,
  preselect,
  onClose,
  onApproved,
}: {
  receipts: WaitingReceipt[]
  /** Ticked to begin with, such as the receipts a sheet just made; every receipt when none of these is waiting. */
  preselect?: string[]
  onClose: () => void
  /** Some or all went in: the screen reloads and says so. */
  onApproved: (message: string) => void
}) {
  const [ticked, setTicked] = useState<Set<string>>(() => {
    const start = (preselect ?? []).filter((id) => receipts.some((r) => r.id === id))
    return new Set(start.length ? start : receipts.map((r) => r.id))
  })
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [refused, setRefused] = useState<Refused[]>([])

  // What was approved leaves the list when the screen reloads; it is untouched here.
  useEffect(() => {
    setTicked((t) => new Set([...t].filter((id) => receipts.some((r) => r.id === id))))
  }, [receipts])

  // Escape closes this window only — not the ones behind it.
  useEscape(() => {
    if (!saving) onClose()
  })

  const picked = receipts.filter((r) => ticked.has(r.id))
  const imported = receipts.filter((r) => r.imported).length
  const allTicked = receipts.length > 0 && picked.length === receipts.length
  const items = picked.reduce((n, r) => n + r.lines.length, 0)
  const withRejects = picked.filter((r) => r.lines.some((l) => l.rejected > 0)).length
  const refusedBy = useMemo(() => new Map(refused.map((r) => [r.id, r.message])), [refused])

  const toggle = (id: string) =>
    setTicked((t) => {
      const next = new Set(t)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  const approve = async () => {
    if (!picked.length) return
    const many = picked.length === 1 ? `${picked[0].grnNumber}` : `these ${picked.length} receipts`
    if (
      !confirm(
        `Approve ${many} into stock?\n\nWhat passed becomes the customer's usable stock${withRejects ? '; what was rejected is held apart' : ''}. Their stickers are made now and wait on Ready to print. An approved receipt is never edited again.`,
      )
    )
      return
    setSaving(true)
    setError(null)
    setRefused([])
    try {
      const res = await api.post<{ message?: string; data: { approved: Array<{ id: string }>; refused: Refused[] } }>('/inventory/customer-grn/post-many', {
        ids: picked.map((r) => r.id),
      })
      setRefused(res.data.refused)
      if (res.data.approved.length) onApproved(res.message ?? 'Approved into stock.')
      if (!res.data.refused.length) onClose()
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not approve them. Nothing was approved.')
    } finally {
      setSaving(false)
    }
  }

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-stretch justify-center bg-black/60 p-2 backdrop-blur-sm sm:left-[var(--sidebar-current-width)] sm:p-3">
      <div className="glass-card flex max-h-full w-full max-w-4xl flex-col self-center overflow-hidden" role="dialog" aria-modal="true" aria-labelledby="cgrn-approve-title">
        <div className="border-border flex shrink-0 items-center justify-between gap-4 border-b px-5 py-3.5">
          <div className="flex min-w-0 items-center gap-3">
            <div className="bg-primary/10 border-primary/20 flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border">
              <BadgeCheck size={19} className="text-primary" />
            </div>
            <div className="min-w-0">
              <h2 id="cgrn-approve-title" className="text-foreground truncate text-xl font-semibold tracking-tight">
                Approve into stock
              </h2>
              <p className="text-muted-foreground mt-0.5 truncate text-[13px]">
                {receipts.length} {receipts.length === 1 ? 'receipt is' : 'receipts are'} waiting for stock approval
                {imported ? ` · ${imported} from a sheet, with no QC` : ''} · none of it is in stock yet
              </p>
            </div>
          </div>
          <button type="button" onClick={onClose} className="btn-ghost p-2" aria-label="Close" disabled={saving}>
            <X size={18} />
          </button>
        </div>

        <div className="flex-1 space-y-3 overflow-y-auto px-4 py-3">
          {error && (
            <div className="border-destructive/30 bg-destructive/10 text-destructive flex items-start gap-2 rounded-lg border px-3 py-2 text-sm">
              <AlertCircle size={15} className="mt-0.5 shrink-0" /> {error}
            </div>
          )}
          {refused.length > 0 && (
            <div className="border-destructive/30 bg-destructive/10 rounded-lg border px-3 py-2 text-sm">
              <p className="text-destructive flex items-center gap-2 font-medium">
                <AlertCircle size={15} className="shrink-0" />
                {refused.length} could not be approved and {refused.length === 1 ? 'is' : 'are'} still waiting:
              </p>
              <ul className="text-foreground mt-1 space-y-0.5 pl-6 text-xs">
                {refused.map((r) => (
                  <li key={r.id}>
                    <span className="font-mono font-semibold">{r.grnNumber}</span> — {r.message}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {receipts.length === 0 ? (
            <p className="text-muted-foreground py-8 text-center text-sm">Nothing is waiting for stock approval.</p>
          ) : (
            <>
              <label className="text-foreground flex w-fit cursor-pointer items-center gap-2 text-sm font-medium">
                <input
                  type="checkbox"
                  className="accent-primary h-4 w-4"
                  checked={allTicked}
                  onChange={() => setTicked(allTicked ? new Set() : new Set(receipts.map((r) => r.id)))}
                  disabled={saving}
                />
                {allTicked ? 'Untick all' : `Tick all ${receipts.length}`}
              </label>
              <ul className="space-y-2">
                {receipts.map((r) => {
                  const on = ticked.has(r.id)
                  const passed = byUnit(r.lines, (l) => l.received - l.rejected)
                  const rejected = byUnit(r.lines, (l) => l.rejected)
                  const why = refusedBy.get(r.id)
                  return (
                    <li key={r.id}>
                      <label
                        className={`bg-card flex cursor-pointer items-start gap-3 rounded-xl border px-3 py-2.5 ${on ? 'border-primary/50' : 'border-border'} ${why ? 'border-destructive/50' : ''}`}
                      >
                        <input type="checkbox" className="accent-primary mt-1 h-4 w-4 shrink-0" checked={on} onChange={() => toggle(r.id)} disabled={saving} />
                        <div className="grid min-w-0 flex-1 gap-x-4 gap-y-1 sm:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)_auto]">
                          <div className="min-w-0">
                            <p className="text-foreground truncate text-sm font-semibold">
                              <span className="font-mono">{r.grnNumber}</span>
                              <span className="text-muted-foreground font-normal"> · {formatDate(r.receiptDate)}</span>
                            </p>
                            <p className="text-muted-foreground truncate text-xs">
                              {r.customerName}
                              {r.soNumber ? ` · for ${r.soNumber}` : ''}
                              {r.challanNumber ? ` · their challan ${r.challanNumber}` : ''} · {r.warehouseName}
                            </p>
                          </div>
                          <div className="min-w-0 text-xs">
                            <p className="text-foreground truncate" title={r.lines.map((l) => l.itemName).join(', ')}>
                              {r.lines.length} {r.lines.length === 1 ? 'item' : 'items'}: {r.lines.slice(0, 2).map((l) => l.itemName).join(', ')}
                              {r.lines.length > 2 ? ` +${r.lines.length - 2} more` : ''}
                            </p>
                            <p className="text-muted-foreground tabular-nums">
                              {passed || '0'} passes
                              {rejected && (
                                <span className="text-destructive" title={r.lines.filter((l) => l.rejected > 0).map((l) => `${l.itemName}: ${l.rejectReason ?? 'no reason'}`).join('\n')}>
                                  {' '}
                                  · {rejected} rejected
                                </span>
                              )}
                            </p>
                          </div>
                          <div className="sm:text-right">
                            {r.imported ? <span className="badge-neutral whitespace-nowrap">From a sheet, no QC</span> : <span className="badge-info whitespace-nowrap">QC by {r.inspectedByName ?? '—'}</span>}
                          </div>
                        </div>
                      </label>
                    </li>
                  )
                })}
              </ul>
            </>
          )}
        </div>

        <div className="border-border flex shrink-0 flex-wrap items-center justify-end gap-2 border-t px-5 py-3">
          <span className="text-muted-foreground mr-auto text-xs">
            {picked.length} ticked · {items} {items === 1 ? 'item' : 'items'}
            {withRejects ? ` · ${withRejects} with rejected material, held apart` : ''}
          </span>
          <button type="button" onClick={onClose} className="btn-secondary" disabled={saving}>
            Close
          </button>
          <button type="button" className="btn-primary" onClick={() => void approve()} disabled={saving || !picked.length}>
            {saving ? <Loader2 size={15} className="animate-spin" /> : <BadgeCheck size={15} />}
            Approve {picked.length || ''} into stock
          </button>
        </div>
      </div>
    </div>,
    document.body,
  )
}
