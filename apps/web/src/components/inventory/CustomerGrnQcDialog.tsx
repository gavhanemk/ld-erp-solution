'use client'

import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { X, Loader2, AlertCircle, ClipboardCheck, BadgeCheck, Save, CornerUpLeft, Boxes, FileText } from 'lucide-react'
import { api, ApiError, can, currentUser } from '@/lib/api'
import { StepInput } from '@/components/ui/StepInput'
import { Section } from '@/components/purchase/Section'
import { formatDate } from '@/lib/utils'
import type { InwardRef } from '@/components/packages/InwardStickers'

/**
 * QC on a customer's receipt, the step between receiving and stock approval.
 *
 * Receiving said what came off the lorry; QC says, line by line, how much of
 * it is rejected and why — the rest passes. Nothing is in stock until an
 * approver approves it: then what passed becomes usable and what was rejected
 * is held. Whoever received it does not check it, unless they are an approver,
 * who may also approve it here in the same step.
 */

interface Receipt {
  id: string
  grnNumber: string
  status: string
  statusLabel?: string
  receiptDate: string
  challanNumber: string | null
  receivedById: string | null
  customer: { name: string }
  warehouse: { name: string }
  so: { soNumber: string } | null
  receivedBy: { name: string } | null
  inspectedBy: { name: string } | null
  inspectedAt: string | null
  inspectionNotes: string | null
  notes: string | null
  lines: Array<{
    id: string
    challanQty: string | number
    receivedQty: string | number
    rejectedQty: string | number
    rejectReason: string | null
    batchNumber: string | null
    markings: string | null
    item: { code: string; name: string; uom: { symbol: string } | null }
  }>
}

interface Check {
  rejected: string
  reason: string
}

const fmt = (v: number) => v.toLocaleString('en-IN', { maximumFractionDigits: 3 })
const num = (v: string) => Number(v) || 0

export function CustomerGrnQcDialog({
  receiptId,
  onClose,
  onDone,
}: {
  receiptId: string
  onClose: () => void
  /** `stickers`: set when it was approved into stock, for its sticker window. */
  onDone: (message: string, stickers?: InwardRef) => void
}) {
  const [grn, setGrn] = useState<Receipt | null>(null)
  const [checks, setChecks] = useState<Check[]>([])
  const [notes, setNotes] = useState('')
  const [saving, setSaving] = useState<null | 'save' | 'approve' | 'back'>(null)
  const [error, setError] = useState<string | null>(null)
  const mayApprove = can('inventory', 'approve')
  const me = (currentUser() as { id?: string } | null)?.id ?? null

  useEffect(() => {
    let cancelled = false
    api
      .get<{ data: Receipt }>(`/inventory/customer-grn/${receiptId}`)
      .then((res) => {
        if (cancelled) return
        setGrn(res.data)
        setChecks(res.data.lines.map((l) => ({ rejected: Number(l.rejectedQty) > 0 ? String(Number(l.rejectedQty)) : '', reason: l.rejectReason ?? '' })))
        setNotes(res.data.status === 'INSPECTED' ? (res.data.inspectionNotes ?? '') : '')
      })
      .catch((err) => !cancelled && setError(err instanceof ApiError ? err.message : 'Could not open the receipt.'))
    return () => {
      cancelled = true
    }
  }, [receiptId])

  const ownReceipt = !!grn && grn.receivedById === me && !mayApprove
  // What QC has recorded already, and whether it has been changed here.
  const unchanged = useMemo(
    () =>
      !!grn &&
      grn.status === 'INSPECTED' &&
      grn.lines.every((l, i) => num(checks[i]?.rejected ?? '') === Number(l.rejectedQty) && (checks[i]?.reason ?? '').trim() === (l.rejectReason ?? '')) &&
      notes.trim() === (grn.inspectionNotes ?? ''),
    [grn, checks, notes],
  )

  const problem = (() => {
    if (!grn) return null
    for (const [i, l] of grn.lines.entries()) {
      const r = num(checks[i]?.rejected ?? '')
      if (r > Number(l.receivedQty) + 1e-9) return `${l.item.name}: only ${fmt(Number(l.receivedQty))} arrived, so no more than that can be rejected.`
      if (r > 0 && !checks[i]?.reason.trim()) return `${l.item.name}: say why it was rejected — torn, stained, wrong shade.`
    }
    return null
  })()

  const save = async (approve: boolean) => {
    if (!grn) return
    setError(null)
    if (problem) return setError(problem)
    setSaving(approve ? 'approve' : 'save')
    try {
      // Approving a check already on record, unchanged: approve it as it stands.
      const res =
        approve && unchanged
          ? await api.post<{ message?: string; data: { id: string; status: string } }>(`/inventory/customer-grn/${grn.id}/post`, {})
          : await api.post<{ message?: string; data: { id: string; status: string } }>(`/inventory/customer-grn/${grn.id}/inspect`, {
              lines: grn.lines.map((l, i) => ({ lineId: l.id, rejectedQty: num(checks[i]?.rejected ?? ''), rejectReason: checks[i]?.reason.trim() || null })),
              inspectionNotes: notes.trim() || null,
              approve,
            })
      onDone(res.message ?? `${grn.grnNumber} saved.`, res.data.status === 'POSTED' ? { type: 'CUSTOMER_GRN', id: res.data.id } : undefined)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save the QC. Try again.')
    } finally {
      setSaving(null)
    }
  }

  const sendBack = async () => {
    if (!grn) return
    const toReceiving = grn.status === 'SUBMITTED'
    const reason = prompt(toReceiving ? `What needs counting again on ${grn.grnNumber}? It goes back to receiving as a draft.` : `What should QC check again on ${grn.grnNumber}?`)
    if (!reason || reason.trim().length < 5) return
    setSaving('back')
    setError(null)
    try {
      const res = await api.post<{ message?: string }>(`/inventory/customer-grn/${grn.id}/send-back`, { reason: reason.trim() })
      onDone(res.message ?? `${grn.grnNumber} sent back.`)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not send it back.')
    } finally {
      setSaving(null)
    }
  }

  const spin = (k: 'save' | 'approve' | 'back', icon: ReactNode) => (saving === k ? <Loader2 size={15} className="animate-spin" /> : icon)
  const totals = grn
    ? grn.lines.reduce(
        (t, l, i) => {
          const r = Math.min(num(checks[i]?.rejected ?? ''), Number(l.receivedQty))
          return { received: t.received + Number(l.receivedQty), rejected: t.rejected + r }
        },
        { received: 0, rejected: 0 },
      )
    : { received: 0, rejected: 0 }
  const mayBack = grn?.status === 'SUBMITTED' ? can('inventory', 'edit') : mayApprove

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-stretch justify-center bg-black/60 p-2 backdrop-blur-sm sm:left-[var(--sidebar-current-width)] sm:p-3">
      <form
        onSubmit={(e) => {
          e.preventDefault()
          void save(mayApprove)
        }}
        noValidate
        className="glass-card po-form flex max-h-full w-full max-w-5xl flex-col self-center overflow-hidden"
        role="dialog"
        aria-modal="true"
        aria-labelledby="cgrn-qc-title"
      >
        <div className="border-border flex shrink-0 items-center justify-between gap-4 border-b px-5 py-3.5">
          <div className="flex min-w-0 items-center gap-3">
            <div className="bg-primary/10 border-primary/20 flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border">
              <ClipboardCheck size={19} className="text-primary" />
            </div>
            <div className="min-w-0">
              <h2 id="cgrn-qc-title" className="text-foreground truncate text-xl font-semibold tracking-tight">
                QC {grn ? `· ${grn.grnNumber}` : ''}
              </h2>
              <p className="text-muted-foreground mt-0.5 truncate text-[13px]">
                {grn
                  ? `${grn.customer.name}${grn.so ? ` · for ${grn.so.soNumber}` : ''} · ${grn.statusLabel ?? grn.status} · on hold, not in stock, until approved`
                  : 'Loading…'}
              </p>
            </div>
          </div>
          <button type="button" onClick={onClose} className="btn-ghost p-2" aria-label="Close">
            <X size={18} />
          </button>
        </div>

        <div className="flex-1 space-y-3 overflow-y-auto px-4 py-3">
          {error && (
            <div className="flex items-start gap-3 rounded-lg border border-red-500/40 bg-red-500/5 p-3">
              <AlertCircle size={16} className="mt-0.5 shrink-0 text-red-400" />
              <p className="text-sm text-red-400">{error}</p>
            </div>
          )}
          {ownReceipt && (
            <p className="warn-text rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm">
              You received {grn?.grnNumber}, so someone else does its QC.
            </p>
          )}

          {grn && (
            <>
              <Section icon={FileText} title="Received">
                <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm sm:grid-cols-4">
                  <Fact label="Received on">{formatDate(grn.receiptDate)}</Fact>
                  <Fact label="By">{grn.receivedBy?.name ?? '—'}</Fact>
                  <Fact label="Their challan">{grn.challanNumber ?? '—'}</Fact>
                  <Fact label="Store">{grn.warehouse.name}</Fact>
                  {grn.notes && (
                    <div className="col-span-2 sm:col-span-4">
                      <Fact label="Receiving's note">{grn.notes}</Fact>
                    </div>
                  )}
                  {grn.status === 'INSPECTED' && grn.inspectedBy && (
                    <div className="col-span-2 sm:col-span-4">
                      <Fact label="Checked">
                        by {grn.inspectedBy.name}
                        {grn.inspectedAt ? ` on ${formatDate(grn.inspectedAt)}` : ''} — waiting for stock approval
                      </Fact>
                    </div>
                  )}
                </div>
              </Section>

              <Section icon={Boxes} title="Line by line">
                <div className="-mx-4 -mb-3.5 -mt-3 overflow-x-auto">
                  <table className="data-table w-full [&>tbody>tr>td]:px-3 [&>thead>tr>th]:px-3">
                    <thead>
                      <tr>
                        <th>Item</th>
                        <th style={{ textAlign: 'right' }}>Challan</th>
                        <th style={{ textAlign: 'right' }}>Arrived</th>
                        <th style={{ textAlign: 'right' }}>Rejected</th>
                        <th>Why rejected</th>
                        <th style={{ textAlign: 'right' }}>Passes</th>
                      </tr>
                    </thead>
                    <tbody>
                      {grn.lines.map((l, i) => {
                        const unit = l.item.uom?.symbol ?? ''
                        const arrived = Number(l.receivedQty)
                        const rejected = num(checks[i]?.rejected ?? '')
                        const over = rejected > arrived + 1e-9
                        return (
                          <tr key={l.id} className="align-top">
                            <td className="min-w-[200px]">
                              <div className="text-foreground text-sm font-medium">{l.item.name}</div>
                              <div className="text-muted-foreground font-mono text-[11px]">
                                {l.item.code}
                                {l.batchNumber ? ` · lot ${l.batchNumber}` : ''}
                                {l.markings ? ` · ${l.markings}` : ''}
                              </div>
                            </td>
                            <td className="text-muted-foreground whitespace-nowrap pt-3 text-right tabular-nums">
                              {fmt(Number(l.challanQty))} {unit}
                            </td>
                            <td className="whitespace-nowrap pt-3 text-right font-semibold tabular-nums">
                              {fmt(arrived)} {unit}
                            </td>
                            <td className="min-w-[120px]">
                              <div className="relative">
                                <StepInput
                                  className={`form-input h-9 pr-10 text-right ${over ? 'border-red-500/60' : ''}`}
                                  decimals
                                  max={arrived}
                                  value={checks[i]?.rejected ?? ''}
                                  onValueChange={(v) => setChecks((c) => c.map((x, j) => (j === i ? { ...x, rejected: v } : x)))}
                                  aria-label={`Rejected quantity of ${l.item.name}`}
                                  disabled={ownReceipt}
                                />
                                {unit && <span className="text-muted-foreground pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-xs">{unit}</span>}
                              </div>
                            </td>
                            <td className="min-w-[180px]">
                              <input
                                className="form-input h-9 placeholder:text-muted-foreground/60"
                                value={checks[i]?.reason ?? ''}
                                onChange={(e) => setChecks((c) => c.map((x, j) => (j === i ? { ...x, reason: e.target.value } : x)))}
                                placeholder={rejected > 0 ? 'Torn, stained, wrong shade…' : 'Nothing rejected'}
                                maxLength={200}
                                disabled={ownReceipt || !(rejected > 0)}
                                aria-label={`Why ${l.item.name} was rejected`}
                              />
                              {rejected > 0 && <div className="mt-0.5 text-[10px] text-amber-600">held apart once approved — not issued until released</div>}
                            </td>
                            <td className="whitespace-nowrap pt-3 text-right tabular-nums">
                              {over ? <span className="text-red-500">more than arrived</span> : <span className="text-emerald-600">{fmt(arrived - rejected)} {unit}</span>}
                            </td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>
              </Section>

              <Section icon={ClipboardCheck} title="What QC found">
                <textarea
                  className="form-input min-h-[60px] placeholder:text-muted-foreground/60"
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  placeholder="e.g. Shade and width checked on every roll. Two rolls stained along the selvedge."
                  maxLength={1000}
                  disabled={ownReceipt}
                  aria-label="What QC found"
                />
              </Section>
            </>
          )}
        </div>

        <div className="border-border flex shrink-0 flex-wrap items-center justify-end gap-2 border-t px-5 py-3">
          <span className="text-muted-foreground mr-auto hidden text-xs sm:inline">
            {grn ? `${fmt(totals.received - totals.rejected)} passes, ${fmt(totals.rejected)} rejected of ${fmt(totals.received)} · nothing is in stock until approved` : ''}
          </span>
          <button type="button" onClick={onClose} className="btn-secondary" disabled={!!saving}>
            Close
          </button>
          {grn && mayBack && (
            <button type="button" className="btn-secondary" onClick={() => void sendBack()} disabled={!!saving}>
              {spin('back', <CornerUpLeft size={15} />)} {grn.status === 'SUBMITTED' ? 'Send back to receiving' : 'Send back to QC'}
            </button>
          )}
          {grn && mayApprove && (
            <button type="button" className="btn-secondary" onClick={() => void save(false)} disabled={!!saving || unchanged}>
              {spin('save', <Save size={15} />)} Save QC only
            </button>
          )}
          {grn && (
            <button type="submit" className="btn-primary" disabled={!!saving || ownReceipt}>
              {mayApprove ? spin('approve', <BadgeCheck size={15} />) : spin('save', <ClipboardCheck size={15} />)}
              {mayApprove ? 'Approve into stock' : 'Save QC — send for approval'}
            </button>
          )}
        </div>
      </form>
    </div>,
    document.body,
  )
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <div className="text-muted-foreground text-[11px] font-semibold uppercase tracking-wide">{label}</div>
      <div className="text-foreground truncate">{children}</div>
    </div>
  )
}
