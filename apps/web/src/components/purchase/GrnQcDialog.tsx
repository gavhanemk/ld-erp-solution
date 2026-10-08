'use client'

import { useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  AlertCircle,
  Ban,
  ClipboardCheck,
  History,
  Loader2,
  MessageSquare,
  Package,
  X,
} from 'lucide-react'
import { api, apiErrorMessage, can } from '@/lib/api'
import { Section } from '@/components/purchase/Section'
import { SmartSelect } from '@/components/ui/SmartSelect'

/**
 * Quality check on a goods receipt — optional, after the goods are in.
 *
 * Per line the checker enters only what was rejected and why; what passed is
 * the rest of what arrived. The mill keeps one store, so nothing is moved:
 * rejected goods stay where they were received, recorded as rejected, until a
 * return challan sends them back against the bill. (Older checks may name a
 * reject godown the goods were moved to; those still show it.)
 *
 * A receipt with a check standing on it opens read-only, with the one thing
 * that can be done to it: cancel the check (its goods move back) so it can be
 * recorded again.
 */

interface QcFormLine {
  grnLineId: string
  itemId: string
  itemCode: string
  itemName: string
  uom: string | null
  warehouseId: string
  warehouseName: string
  receivedQty: number
  onHand: number
}

interface QcRecordLine {
  grnLineId: string
  itemCode?: string
  itemName?: string
  uom?: string | null
  warehouseName?: string
  receivedQty: number
  approvedQty: number
  rejectedQty: number
  reason: string | null
  /** The reason picked, in words. Absent on checks recorded before the list. */
  reasonLabel?: string | null
}

interface QcRecord {
  id: string
  inspectionDate: string
  inspectedBy: string | null
  result: 'PASS' | 'CONDITIONAL_PASS' | 'FAIL'
  remarks: string | null
  rejectWarehouse: { id: string; name: string } | null
  cancelled: { at: string; byName: string; reason: string } | null
  lines: QcRecordLine[]
  rejectedQty: number
}

interface QcData {
  grn: {
    id: string
    grnNumber: string
    grnDate: string
    status: string
    challanNo: string | null
    poNumber: string
    supplier: { id: string; code: string; name: string }
  }
  lines: QcFormLine[]
  qc: QcRecord | null
  history: QcRecord[]
  /** The return challan's reasons, so a rejection is recorded in its words. */
  reasons: Array<{ value: string; label: string }>
}

export const QC_RESULT: Record<QcRecord['result'], { label: string; cls: string }> = {
  PASS: { label: 'QC passed', cls: 'badge-success' },
  CONDITIONAL_PASS: { label: 'QC part rejected', cls: 'badge-warning' },
  FAIL: { label: 'QC rejected', cls: 'badge-danger' },
}

const num = (v: string) => {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}

const today = () => {
  const d = new Date()
  const two = (n: number) => String(n).padStart(2, '0')
  return d.getFullYear() + '-' + two(d.getMonth() + 1) + '-' + two(d.getDate())
}

const day = (iso: string) =>
  new Date(iso).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })

const fieldLabel = 'text-muted-foreground text-[10px] font-semibold uppercase tracking-wider'

export function GrnQcDialog({
  grnId,
  onClose,
  onSaved,
}: {
  grnId: string
  onClose: () => void
  onSaved: (message: string) => void
}) {
  const [data, setData] = useState<QcData | null>(null)
  const [rejected, setRejected] = useState<Record<string, string>>({})
  const [reasons, setReasons] = useState<Record<string, string>>({})
  /** Why each line was rejected, as one of the return challan's reasons. */
  const [reasonCodes, setReasonCodes] = useState<Record<string, string>>({})
  const [inspectionDate, setInspectionDate] = useState(today)
  const [remarks, setRemarks] = useState('')
  const [cancelReason, setCancelReason] = useState('')
  const [cancelling, setCancelling] = useState(false)

  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    api
      .get<{ data: QcData }>('/purchase/qc/grn/' + grnId)
      .then((r) => {
        if (alive) setData(r.data)
      })
      .catch((err) => {
        if (alive) setError(apiErrorMessage(err, 'Could not read that receipt.'))
      })
      .finally(() => {
        if (alive) setLoading(false)
      })
    return () => {
      alive = false
    }
  }, [grnId])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !saving) onClose()
    }
    document.addEventListener('keydown', onKey)
    const previous = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.removeEventListener('keydown', onKey)
      document.body.style.overflow = previous
    }
  }, [onClose, saving])

  const lines = useMemo(() => data?.lines ?? [], [data])
  const rejecting = lines.filter((l) => num(rejected[l.grnLineId] ?? '') > 0)

  /*
   * What stops the save, said before the press. The server checks all of it
   * again; these are here so nothing typed is lost to a round trip.
   */
  const problems = useMemo(() => {
    const out: string[] = []
    for (const l of lines) {
      const r = num(rejected[l.grnLineId] ?? '')
      if (r < 0) out.push(`${l.itemName}: a rejected quantity cannot be negative`)
      if (r > l.receivedQty + 0.0005) {
        out.push(`${l.itemName}: only ${l.receivedQty} ${l.uom ?? ''} was received`)
      }
      if (r > 0 && !reasonCodes[l.grnLineId]) {
        out.push(`${l.itemName}: pick why it was rejected`)
      }
    }
    return out
  }, [lines, rejected, reasonCodes])

  const save = async () => {
    if (problems.length || saving || !data) return
    setSaving(true)
    setError(null)
    try {
      const res = await api.post<{ message: string }>('/purchase/qc', {
        grnId: data.grn.id,
        inspectionDate,
        remarks: remarks.trim() || null,
        lines: lines.map((l) => ({
          grnLineId: l.grnLineId,
          rejectedQty: num(rejected[l.grnLineId] ?? ''),
          reason: reasons[l.grnLineId]?.trim() || null,
          reasonCode: num(rejected[l.grnLineId] ?? '') > 0 ? reasonCodes[l.grnLineId] || null : null,
        })),
      })
      onSaved(res.message)
    } catch (err) {
      setError(apiErrorMessage(err))
    } finally {
      setSaving(false)
    }
  }

  const cancelQc = async () => {
    if (!data?.qc || cancelReason.trim().length < 5 || saving) return
    setSaving(true)
    setError(null)
    try {
      const res = await api.post<{ message: string }>(`/purchase/qc/${data.qc.id}/cancel`, {
        reason: cancelReason.trim(),
      })
      onSaved(res.message)
    } catch (err) {
      setError(apiErrorMessage(err))
    } finally {
      setSaving(false)
    }
  }

  const grn = data?.grn
  const standing = data?.qc ?? null
  const cancelled = grn?.status === 'CANCELLED'
  const readOnly = Boolean(standing) || cancelled

  return createPortal(
    /* Narrower than the document forms, and only as tall as it needs to be: a
       check is a handful of lines and three fields, and at full screen width it
       read as mostly empty space. The chrome is the module's own, as the new-item
       window's is. */
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-2 backdrop-blur-sm sm:left-[var(--sidebar-current-width)] sm:p-4">
      <div
        className="glass-card po-form flex max-h-full w-full max-w-6xl flex-col overflow-hidden"
        role="dialog"
        aria-modal="true"
        aria-labelledby="qc-dialog-title"
      >
        <div className="border-border flex shrink-0 items-center justify-between gap-4 border-b px-5 py-3.5">
          <div className="flex min-w-0 items-center gap-3">
            <div className="bg-primary/10 border-primary/20 flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border">
              <ClipboardCheck size={19} className="text-primary" />
            </div>
            <div className="min-w-0">
              <h2
                id="qc-dialog-title"
                className="text-foreground truncate text-xl font-semibold tracking-tight"
              >
                Quality Check
              </h2>
              <p className="text-muted-foreground mt-0.5 truncate text-[13px]">
                {grn
                  ? `${grn.grnNumber} · ${grn.supplier.name} · order ${grn.poNumber}`
                  : 'Reading the receipt…'}
              </p>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {!readOnly && (
              <button
                type="button"
                className="btn-primary hidden md:inline-flex"
                onClick={() => void save()}
                disabled={saving || loading || problems.length > 0}
              >
                {saving ? (
                  <Loader2 size={15} className="animate-spin" />
                ) : (
                  <ClipboardCheck size={15} />
                )}
                Save QC
              </button>
            )}
            <button
              type="button"
              onClick={onClose}
              className="btn-ghost p-1.5"
              aria-label="Close"
              disabled={saving}
            >
              <X size={18} />
            </button>
          </div>
        </div>

        <div className="min-h-0 flex-1 space-y-2.5 overflow-y-auto px-5 py-3">
          {!readOnly && !loading && (
            <p className="text-muted-foreground text-[11px]">
              Enter only what was rejected and why — the rest counts as passed. Rejected goods go back
              to the supplier on a return challan from the bill.
            </p>
          )}

          {error && (
            <div className="flex items-start gap-3 rounded-lg border border-red-500/40 bg-red-500/5 p-3">
              <AlertCircle size={16} className="mt-0.5 shrink-0 text-red-400" />
              <p className="text-sm text-red-400">{error}</p>
            </div>
          )}

          {loading ? (
            <p className="text-muted-foreground flex items-center gap-2 py-10 text-sm">
              <Loader2 size={15} className="animate-spin" /> Reading the receipt…
            </p>
          ) : !data ? null : standing ? (
            <StandingCheck
              qc={standing}
              canCancel={can('purchase', 'edit')}
              cancelReason={cancelReason}
              setCancelReason={setCancelReason}
              cancelling={cancelling}
              setCancelling={setCancelling}
              onCancel={() => void cancelQc()}
              saving={saving}
            />
          ) : cancelled ? (
            <div className="border-border/70 rounded-lg border border-dashed p-6 text-center">
              <p className="text-foreground text-sm">{grn?.grnNumber} is cancelled.</p>
              <p className="text-muted-foreground mt-1 text-xs">There is nothing on it to check.</p>
            </div>
          ) : (
            <>
              <Section icon={MessageSquare} title="Check Details">
                <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-3">
                  <label className="block">
                    <span className="form-label">QC date</span>
                    <input
                      type="date"
                      className="form-input"
                      value={inspectionDate}
                      onChange={(e) => setInspectionDate(e.target.value)}
                    />
                  </label>
                  <label className="block sm:col-span-2">
                    <span className="form-label">Remarks</span>
                    <input
                      className="form-input"
                      value={remarks}
                      onChange={(e) => setRemarks(e.target.value)}
                      placeholder="e.g. checked 10% of rolls for GSM and shade"
                    />
                  </label>
                </div>
              </Section>

              <Section icon={Package} title="Items Checked">
                {/* On a phone, one card per line. */}
                <div className="space-y-3 sm:hidden">
                  {lines.map((l) => {
                    const r = num(rejected[l.grnLineId] ?? '')
                    const over = r > l.receivedQty + 0.0005
                    return (
                      <div
                        key={l.grnLineId}
                        className="border-border bg-card rounded-lg border p-3"
                      >
                        <p className="text-foreground text-sm font-medium">{l.itemName}</p>
                        <p className="text-muted-foreground font-mono text-[10px]">
                          {l.itemCode}
                        </p>
                        <div className="border-border/70 mt-2 grid grid-cols-2 gap-2 border-t pt-2 text-xs">
                          <div>
                            <p className={fieldLabel}>Received</p>
                            <p className="tabular-nums">
                              {l.receivedQty} {l.uom ?? ''}
                            </p>
                          </div>
                          <div>
                            <p className={fieldLabel}>Approved</p>
                            <p className="tabular-nums text-emerald-400">
                              {Math.max(0, Number((l.receivedQty - r).toFixed(3)))} {l.uom ?? ''}
                            </p>
                          </div>
                        </div>
                        <div className="mt-2 grid grid-cols-2 gap-2">
                          <div className="space-y-1">
                            <label className={fieldLabel}>Rejected</label>
                            <input
                              type="number"
                              step="any"
                              min={0}
                              inputMode="decimal"
                              className={`form-input h-9 w-full text-right ${
                                over ? 'border-red-500/60' : ''
                              }`}
                              placeholder="0"
                              value={rejected[l.grnLineId] ?? ''}
                              onChange={(e) =>
                                setRejected((p) => ({ ...p, [l.grnLineId]: e.target.value }))
                              }
                              aria-label={`${l.itemName} rejected quantity`}
                            />
                          </div>
                          <div className="space-y-1">
                            <label className={fieldLabel}>Reason</label>
                            <SmartSelect
                              className={`form-input h-9 w-full ${
                                r > 0 && !reasonCodes[l.grnLineId] ? 'border-amber-500/70' : ''
                              }`}
                              value={reasonCodes[l.grnLineId] ?? ''}
                              onChange={(e) =>
                                setReasonCodes((p) => ({ ...p, [l.grnLineId]: e.target.value }))
                              }
                              disabled={!(r > 0)}
                              aria-label={`Why ${l.itemName} was rejected`}
                            >
                              <option value="">{r > 0 ? 'Pick…' : '—'}</option>
                              {data?.reasons.map((x) => (
                                <option key={x.value} value={x.value}>
                                  {x.label}
                                </option>
                              ))}
                            </SmartSelect>
                          </div>
                        </div>
                        <div className="mt-2 space-y-1">
                          <label className={fieldLabel}>Note</label>
                          <input
                            className="form-input h-9 w-full"
                            value={reasons[l.grnLineId] ?? ''}
                            onChange={(e) =>
                              setReasons((p) => ({ ...p, [l.grnLineId]: e.target.value }))
                            }
                            placeholder={r > 0 ? 'e.g. shade mismatch (optional)' : '—'}
                            disabled={!(r > 0)}
                            aria-label={`${l.itemName} rejection note`}
                          />
                        </div>
                      </div>
                    )
                  })}
                </div>

                <div className="border-border bg-card hidden overflow-x-auto rounded-lg border sm:block">
                  <table className="w-full min-w-[720px] table-fixed border-collapse text-sm">
                    <thead>
                      <tr className="bg-secondary">
                        {[
                          // The reason takes whatever is left, which is most of a
                          // wide window — it is the one box people type a sentence in.
                          ['Item', 'w-52', 'left'],
                          ['Received', 'w-24', 'right'],
                          ['Approved', 'w-24', 'right'],
                          ['Rejected', 'w-28', 'right'],
                          ['Reason', 'w-48', 'left'],
                          ['Note', '', 'left'],
                        ].map(([label, width, align]) => (
                          <th
                            key={label}
                            className={`${width} border-border text-muted-foreground border-b px-2 py-1.5 text-[10px] font-semibold uppercase tracking-wider ${
                              align === 'right' ? 'text-right' : 'text-left'
                            }`}
                          >
                            {label}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {lines.map((l, i) => {
                        const r = num(rejected[l.grnLineId] ?? '')
                        const over = r > l.receivedQty + 0.0005
                        return (
                          <tr
                            key={l.grnLineId}
                            className={`border-border/50 border-b last:border-0 [&>td]:px-2 [&>td]:py-1.5 [&>td]:align-top ${
                              i % 2 ? 'zebra-row' : ''
                            }`}
                          >
                            <td>
                              <p className="text-foreground truncate font-medium">{l.itemName}</p>
                              <p className="text-muted-foreground font-mono text-[10px]">
                                {l.itemCode}
                              </p>
                            </td>
                            <td className="whitespace-nowrap pt-2.5 text-right text-xs tabular-nums">
                              {l.receivedQty} {l.uom ?? ''}
                            </td>
                            <td className="whitespace-nowrap pt-2.5 text-right text-xs tabular-nums text-emerald-400">
                              {Math.max(0, Number((l.receivedQty - r).toFixed(3)))} {l.uom ?? ''}
                            </td>
                            <td>
                              <input
                                type="number"
                                step="any"
                                min={0}
                                className={`form-input h-8 text-right text-xs ${
                                  over ? 'border-red-500/60' : ''
                                }`}
                                placeholder="0"
                                value={rejected[l.grnLineId] ?? ''}
                                onChange={(e) =>
                                  setRejected((p) => ({ ...p, [l.grnLineId]: e.target.value }))
                                }
                                aria-label={`${l.itemName} rejected quantity`}
                              />
                            </td>
                            <td>
                              <SmartSelect
                                className={`form-input h-8 text-xs ${
                                  r > 0 && !reasonCodes[l.grnLineId] ? 'border-amber-500/70' : ''
                                }`}
                                value={reasonCodes[l.grnLineId] ?? ''}
                                onChange={(e) =>
                                  setReasonCodes((p) => ({ ...p, [l.grnLineId]: e.target.value }))
                                }
                                disabled={!(r > 0)}
                                aria-label={`Why ${l.itemName} was rejected`}
                              >
                                <option value="">{r > 0 ? 'Pick…' : '—'}</option>
                                {data?.reasons.map((x) => (
                                  <option key={x.value} value={x.value}>
                                    {x.label}
                                  </option>
                                ))}
                              </SmartSelect>
                            </td>
                            <td>
                              <input
                                className="form-input h-8 text-xs"
                                value={reasons[l.grnLineId] ?? ''}
                                onChange={(e) =>
                                  setReasons((p) => ({ ...p, [l.grnLineId]: e.target.value }))
                                }
                                placeholder={r > 0 ? 'e.g. shade mismatch, GSM low (optional)' : '—'}
                                disabled={!(r > 0)}
                                aria-label={`${l.itemName} rejection note`}
                              />
                            </td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>
              </Section>
            </>
          )}

          {data && data.history.length > 0 && (
            <Section icon={History} title="Earlier Checks (cancelled)">
              <ul className="space-y-1.5 text-xs">
                {data.history.map((h) => (
                  <li key={h.id} className="text-muted-foreground">
                    <span className="text-foreground">{day(h.inspectionDate)}</span>
                    {h.inspectedBy ? ` by ${h.inspectedBy}` : ''} ·{' '}
                    {QC_RESULT[h.result]?.label ?? h.result}
                    {h.rejectedQty > 0 ? ` (${h.rejectedQty} rejected)` : ''} — cancelled{' '}
                    {h.cancelled
                      ? `${day(h.cancelled.at)} by ${h.cancelled.byName}: ${h.cancelled.reason}`
                      : ''}
                  </li>
                ))}
              </ul>
            </Section>
          )}
        </div>

        {!readOnly && !loading && data && (
          <div className="border-border flex shrink-0 flex-wrap items-center justify-end gap-2 border-t px-3 py-2.5 sm:gap-3 sm:px-5 sm:py-3.5">
            {problems.length > 0 ? (
              <p className="warn-text mr-auto flex basis-full items-start gap-1.5 text-xs sm:basis-auto">
                <AlertCircle size={13} className="mt-px shrink-0" />
                <span>{problems[0]}</span>
              </p>
            ) : (
              <p className="text-muted-foreground mr-auto basis-full text-xs sm:basis-auto">
                {rejecting.length
                  ? `${rejecting.length} line${rejecting.length === 1 ? '' : 's'} with rejects`
                  : 'Everything passes'}
              </p>
            )}
            <button
              type="button"
              onClick={onClose}
              className="btn-secondary hidden sm:inline-flex"
              disabled={saving}
            >
              Cancel
            </button>
            <button
              type="button"
              className="btn-primary"
              onClick={() => void save()}
              disabled={saving || problems.length > 0}
            >
              {saving ? (
                <Loader2 size={15} className="animate-spin" />
              ) : (
                <ClipboardCheck size={15} />
              )}
              Save QC
            </button>
          </div>
        )}
      </div>
    </div>,
    document.body
  )
}

/** A check already standing on the receipt: what it found, and the way to take it back. */
function StandingCheck({
  qc,
  canCancel,
  cancelReason,
  setCancelReason,
  cancelling,
  setCancelling,
  onCancel,
  saving,
}: {
  qc: QcRecord
  canCancel: boolean
  cancelReason: string
  setCancelReason: (v: string) => void
  cancelling: boolean
  setCancelling: (v: boolean) => void
  onCancel: () => void
  saving: boolean
}) {
  const r = QC_RESULT[qc.result]
  return (
    <>
      <Section icon={ClipboardCheck} title="Check Recorded">
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span className={r?.cls ?? 'badge-neutral'}>{r?.label ?? qc.result}</span>
          <span className="text-muted-foreground text-xs">
            {day(qc.inspectionDate)}
            {qc.inspectedBy ? ` · by ${qc.inspectedBy}` : ''}
            {qc.rejectWarehouse ? ` · rejects moved to ${qc.rejectWarehouse.name}` : ''}
          </span>
        </div>
        {qc.remarks && <p className="text-muted-foreground mt-1.5 text-xs">{qc.remarks}</p>}

        <div className="divide-border/60 border-border mt-2.5 divide-y rounded-lg border">
          {qc.lines.map((l) => (
            <div key={l.grnLineId} className="flex items-start justify-between gap-3 p-2.5">
              <div className="min-w-0">
                <p className="text-xs font-medium">{l.itemName}</p>
                <p className="text-muted-foreground font-mono text-[10px]">
                  {l.itemCode}
                </p>
                {(l.reasonLabel || l.reason) && (
                  <p className="warn-text mt-0.5 text-[11px] font-semibold">
                    {[l.reasonLabel, l.reason].filter(Boolean).join(' — ')}
                  </p>
                )}
              </div>
              <div className="shrink-0 text-right text-xs tabular-nums">
                <p className="text-emerald-400">
                  {l.approvedQty} {l.uom ?? ''} passed
                </p>
                {l.rejectedQty > 0 && (
                  <p className="text-red-400">
                    {l.rejectedQty} {l.uom ?? ''} rejected
                  </p>
                )}
              </div>
            </div>
          ))}
        </div>
      </Section>

      {canCancel && (
        <Section icon={Ban} title="Cancel This Check">
          {!cancelling ? (
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-muted-foreground text-xs">
                Cancelling undoes this check. The receipt can then be corrected, or checked again.
              </p>
              <button type="button" className="btn-danger" onClick={() => setCancelling(true)}>
                <Ban size={14} /> Cancel QC
              </button>
            </div>
          ) : (
            <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
              <label className="block flex-1">
                <span className="form-label">Why is the check being cancelled?</span>
                <input
                  className="form-input"
                  value={cancelReason}
                  onChange={(e) => setCancelReason(e.target.value)}
                  placeholder="e.g. rejected quantity keyed wrongly"
                  autoFocus
                />
              </label>
              <div className="flex gap-2">
                <button
                  type="button"
                  className="btn-secondary"
                  onClick={() => setCancelling(false)}
                  disabled={saving}
                >
                  Keep it
                </button>
                <button
                  type="button"
                  className="btn-danger"
                  onClick={onCancel}
                  disabled={saving || cancelReason.trim().length < 5}
                >
                  {saving ? <Loader2 size={14} className="animate-spin" /> : <Ban size={14} />}
                  Cancel QC
                </button>
              </div>
            </div>
          )}
        </Section>
      )}
    </>
  )
}
