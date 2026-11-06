'use client'

import { useCallback, useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  AlertCircle,
  AlertTriangle,
  Ban,
  Boxes,
  CheckCircle2,
  ClipboardList,
  ExternalLink,
  Factory,
  Layers,
  Loader2,
  PackageCheck,
  RefreshCw,
  Scissors,
  ShoppingCart,
  Truck,
  Undo2,
  X,
} from 'lucide-react'
import { api, ApiError, can } from '@/lib/api'
import { formatDate } from '@/lib/utils'
import { useEscape } from '@/lib/useEscape'
import { Section } from '@/components/purchase/Section'
import { KpiTile, TONE } from '@/components/dashboard/DashKit'
import { ReasonDialog } from '@/components/ui/ReasonDialog'
import { moStage } from '@/components/production/status'
import { OPEN_ORDER_STATUSES } from './status'

interface Impact {
  order: { id: string; soNumber: string; status: string; isJobWork: boolean; customer: string; sent: boolean }
  request: { at: string; by: string | null; reason: string | null; pending: boolean } | null
  nothingStarted: boolean
  pieces: { ordered: number; dispatched: number; pending: number; planned: number; cut: number; onFloor: number; packed: number; inStore: number }
  mos: Array<{
    id: string
    moNumber: string
    status: string
    stage: string
    held: string | null
    planned: number
    cut: number
    packed: number
    onFloor: number
    floor: { onTheWay: number; inHand: number; atOutsideUnits: number; inRework: number; damaged: number; bGrade: number; scrapped: number } | null
    closes: boolean
  }>
  materials: Array<{
    item: { code: string; name: string; uom: string | null }
    customers: boolean
    asked: number
    issued: number
    returned: number
    usedInCutting: number
    withProduction: number
    toIssue: number
  }>
  requisitions: Array<{ id: string; mrNumber: string; moNumber: string | null; department: string | null; state: string; closes: boolean; returnable: boolean }>
  purchase: Array<{ poId: string; poNumber: string; status: string; supplier: string; item: string; uom: string | null; ordered: number; received: number }>
  enquiries: Array<{ id: string; enquiryNumber: string; status: string }>
  gaps: Array<{ item: string; kind: string; qty: number; text: string }>
  effects: string[]
  warnings: string[]
}

const n = (x: number) => x.toLocaleString('en-IN', { maximumFractionDigits: 3 })
const qty = (x: number, unit: string | null) => (x ? `${n(x)}${unit ? ` ${unit}` : ''}` : '—')

/**
 * Calling a sales order off, at whatever stage it has reached: everything it
 * touches laid out — its manufacturing orders and their pieces, material
 * issued, used and still out, requisitions, purchase raised for them — then
 * the cancellation asked for, approved or withdrawn.
 *
 * Asking puts its manufacturing orders on hold. Approving (someone who
 * approves orders) closes them and its open requisitions and ends the order:
 * cancelled, or short-closed at what was sent. Nothing recorded is undone;
 * material still on the floor goes back on a floor return when the store has
 * it. An order with nothing asked for, made or sent is simply cancelled.
 */
export function CancellationDialog({
  orderId,
  onClose,
  onChanged,
}: {
  orderId: string | null
  onClose: () => void
  onChanged: (message: string) => void
}) {
  const [mounted, setMounted] = useState(false)
  useEffect(() => setMounted(true), [])
  const [data, setData] = useState<Impact | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState<string | null>(null)
  const [busy, setBusy] = useState<null | 'load' | 'request' | 'cancel' | 'withdraw' | 'approve'>(null)
  const [reason, setReason] = useState('')
  const [exception, setException] = useState('')
  const [confirming, setConfirming] = useState<null | 'approve' | 'withdraw'>(null)

  const load = useCallback(async () => {
    if (!orderId) return
    setBusy('load')
    try {
      const res = await api.get<{ data: Impact }>(`/sales/orders/${orderId}/cancellation`)
      setData(res.data)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not work out what cancelling it touches.')
    } finally {
      setBusy(null)
    }
  }, [orderId])

  useEffect(() => {
    setData(null)
    setError(null)
    setDone(null)
    setReason('')
    setException('')
    setConfirming(null)
    void load()
  }, [load])

  useEscape(() => {
    if (!busy && !confirming) onClose()
  }, Boolean(orderId))

  if (!orderId || !mounted) return null

  const d = data
  const open = !!d && OPEN_ORDER_STATUSES.includes(d.order.status)
  const pending = !!d?.request?.pending
  const mayAsk = can('sales', 'edit')
  const mayApprove = can('sales', 'approve')
  const mayException = mayApprove && can('inventory', 'approve')
  const reasonOk = reason.trim().length >= 5
  const exceptionOk = exception.trim().length >= 10
  // The customer's material not all accounted for stops it, unless a manager makes an exception.
  const blocked = !!d?.gaps.length && !(mayException && exceptionOk)

  const post = async (kind: 'request' | 'cancel' | 'withdraw' | 'approve', path: string, body: object, fallback: string) => {
    setBusy(kind)
    setError(null)
    try {
      const res = await api.post<{ message?: string }>(path, body)
      const msg = res.message ?? fallback
      setDone(msg)
      onChanged(msg)
      setConfirming(null)
      setReason('')
      await load()
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'That could not be done.')
      setConfirming(null)
    } finally {
      setBusy(null)
    }
  }
  const withException = d?.gaps.length && exceptionOk ? { materialException: exception.trim() } : {}

  const look = !d
    ? null
    : pending
      ? { label: 'Waiting for approval', cls: 'badge-danger' }
      : d.order.status === 'CANCELLED'
        ? { label: 'Cancelled', cls: 'badge-neutral' }
        : d.order.status === 'COMPLETED'
          ? { label: 'Closed', cls: 'badge-neutral' }
          : { label: 'Not asked yet', cls: 'badge-info' }

  return createPortal(
    <div className="fixed inset-0 z-[60] flex items-stretch justify-center bg-black/60 p-2 backdrop-blur-sm sm:left-[var(--sidebar-current-width)] sm:p-3">
      <div className="glass-card flex h-full max-h-full w-full max-w-6xl flex-col overflow-hidden" role="dialog" aria-modal="true" aria-labelledby="so-cancel-title">
        <div className="border-border flex shrink-0 items-center justify-between gap-3 border-b px-5 py-3.5">
          <div className="flex min-w-0 items-center gap-3">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-red-500/30 bg-red-500/10">
              <Ban size={19} className="text-red-500" />
            </div>
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <h2 id="so-cancel-title" className="text-foreground text-lg font-semibold tracking-tight">
                  Cancel {d?.order.soNumber ?? 'order'}
                </h2>
                {look && <span className={look.cls}>{look.label}</span>}
              </div>
              <p className="text-muted-foreground truncate text-[13px]">
                {d ? `${d.order.customer}${d.order.isJobWork ? ' · job work' : ''} · what cancelling it touches, as it stands now` : 'Working out what it touches…'}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-1">
            <button type="button" className="btn-ghost p-2" onClick={() => void load()} disabled={busy !== null} aria-label="Refresh the figures" title="Refresh the figures">
              <RefreshCw size={16} className={busy === 'load' ? 'animate-spin' : undefined} />
            </button>
            <button type="button" onClick={onClose} className="btn-ghost p-2" aria-label="Close" disabled={busy !== null && busy !== 'load'}>
              <X size={18} />
            </button>
          </div>
        </div>

        <div className="flex-1 space-y-3 overflow-y-auto px-4 py-3">
          {error && (
            <div className="border-destructive/40 bg-destructive/5 flex items-start gap-3 rounded-lg border p-3">
              <AlertCircle size={16} className="text-destructive mt-0.5 shrink-0" />
              <p className="text-destructive text-sm">{error}</p>
            </div>
          )}
          {done && (
            <div className="border-primary/40 bg-primary/5 rounded-lg border p-3">
              <p className="text-primary text-sm">{done}</p>
            </div>
          )}
          {!d ? (
            <div className="space-y-2">
              {Array.from({ length: 5 }).map((_, i) => (
                <div key={i} className="skeleton h-12 w-full rounded-lg" />
              ))}
            </div>
          ) : (
            <>
              {pending && d.request ? (
                <div className="flex items-start gap-3 rounded-lg border border-red-500/40 bg-red-500/10 p-3">
                  <Ban size={16} className="mt-0.5 shrink-0 text-red-500" />
                  <p className="text-foreground text-sm">
                    <b>Cancellation asked for</b> on {formatDate(d.request.at)}
                    {d.request.by ? ` by ${d.request.by}` : ''}
                    {d.request.reason ? `: ${d.request.reason}` : ''}. Its manufacturing orders are on hold: nothing more is issued, cut, moved,
                    packed or sent for it until this is approved or withdrawn.
                  </p>
                </div>
              ) : open ? (
                <div className="border-border bg-secondary/40 flex items-start gap-3 rounded-lg border p-3">
                  <AlertTriangle size={16} className="mt-0.5 shrink-0 text-amber-500" />
                  <p className="text-foreground text-sm">
                    {d.nothingStarted
                      ? 'Nothing has been asked for, made or sent against this order, so it is simply cancelled.'
                      : 'Nothing changes until it is asked for. Asking puts its manufacturing orders on hold while the figures below are put right; then someone who approves orders approves it.'}
                  </p>
                </div>
              ) : null}

              <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
                <KpiTile icon={ClipboardList} tone={TONE.blue} label="Ordered" value={n(d.pieces.ordered)} sub={`${n(d.pieces.pending)} still to send`} />
                <KpiTile icon={Truck} tone={TONE.teal} label="Sent" value={n(d.pieces.dispatched)} sub={d.order.sent ? 'stays sent' : 'nothing yet'} />
                <KpiTile icon={Scissors} tone={TONE.violet} label="Cut" value={n(d.pieces.cut)} sub={`of ${n(d.pieces.planned)} planned`} />
                <KpiTile
                  icon={Layers}
                  tone={TONE.amber}
                  label="On the floor"
                  value={n(d.pieces.onFloor)}
                  valueClass={d.pieces.onFloor ? 'text-amber-500' : 'text-foreground'}
                  sub="cut, not packed"
                />
                <KpiTile icon={PackageCheck} tone={TONE.emerald} label="Packed" value={n(d.pieces.packed)} sub="into finished goods" />
                <KpiTile icon={Boxes} tone={TONE.sky} label="In the store" value={n(d.pieces.inStore)} sub="packed, not sent" />
              </div>

              <Section icon={CheckCircle2} title={open ? 'What approving does' : 'What it did'}>
                <ul className="text-foreground list-disc space-y-1 pl-5 text-sm">
                  {d.effects.map((e) => (
                    <li key={e}>{e}</li>
                  ))}
                  <li className="text-muted-foreground">Every issue, cutting, transfer, receipt and challan stays on record, linked to the order.</li>
                </ul>
              </Section>

              {open && (d.gaps.length > 0 || d.warnings.length > 0) && (
                <Section icon={AlertTriangle} title="See to before approving">
                  <ul className="space-y-1.5 text-sm">
                    {d.gaps.map((g) => (
                      <li key={g.text} className="text-destructive flex items-start gap-2">
                        <AlertCircle size={14} className="mt-0.5 shrink-0" />
                        <span>
                          <b>Stops approval:</b> {g.text}.
                        </span>
                      </li>
                    ))}
                    {d.warnings.map((w) => (
                      <li key={w} className="flex items-start gap-2">
                        <AlertTriangle size={14} className="mt-0.5 shrink-0 text-amber-500" />
                        <span className="text-foreground">{w}</span>
                      </li>
                    ))}
                  </ul>
                </Section>
              )}

              {d.mos.length > 0 && (
                <Section icon={Factory} title={`Manufacturing orders (${d.mos.length})`}>
                  <div className="overflow-x-auto">
                    <table className="data-table w-full">
                      <thead>
                        <tr className="bg-secondary">
                          <th>MO</th>
                          <th>Where it stands</th>
                          <th style={{ textAlign: 'right' }}>Planned</th>
                          <th style={{ textAlign: 'right' }}>Cut</th>
                          <th style={{ textAlign: 'right' }}>On the floor</th>
                          <th style={{ textAlign: 'right' }}>Packed</th>
                          <th>On approval</th>
                        </tr>
                      </thead>
                      <tbody>
                        {d.mos.map((m) => {
                          const s = moStage(m.stage, m.status)
                          const f = m.floor
                          const detail = f
                            ? [
                                f.inHand ? `${n(f.inHand)} in hand` : '',
                                f.onTheWay ? `${n(f.onTheWay)} on the way` : '',
                                f.atOutsideUnits ? `${n(f.atOutsideUnits)} at outside units` : '',
                                f.inRework ? `${n(f.inRework)} in rework` : '',
                                f.damaged ? `${n(f.damaged)} damaged or rejected` : '',
                                f.bGrade ? `${n(f.bGrade)} B-grade` : '',
                              ].filter(Boolean)
                            : []
                          return (
                            <tr key={m.id}>
                              <td className="whitespace-nowrap">
                                <a href={`/production/orders?open=${m.id}`} target="_blank" rel="noreferrer" className="text-primary font-mono text-xs font-semibold hover:underline">
                                  {m.moNumber}
                                </a>
                                {m.held && <div className="text-muted-foreground text-[11px]">On hold</div>}
                              </td>
                              <td>
                                <span className={`${s.cls} whitespace-nowrap`}>{s.label}</span>
                              </td>
                              <td className="text-right tabular-nums">{n(m.planned)}</td>
                              <td className="text-right tabular-nums">{n(m.cut)}</td>
                              <td className="text-right tabular-nums">
                                <span className={m.onFloor ? 'warn-text font-medium' : ''}>{n(m.onFloor)}</span>
                                {detail.length > 0 && <div className="text-muted-foreground text-[11px]">{detail.join(' · ')}</div>}
                              </td>
                              <td className="text-right tabular-nums">{n(m.packed)}</td>
                              <td className="text-xs">
                                {m.closes ? <span className="text-foreground">Closes, records kept</span> : <span className="text-muted-foreground">Already {m.status === 'COMPLETED' ? 'completed' : 'closed'}</span>}
                              </td>
                            </tr>
                          )
                        })}
                      </tbody>
                    </table>
                  </div>
                </Section>
              )}

              {d.materials.length > 0 && (
                <Section icon={Boxes} title="Materials">
                  <div className="overflow-x-auto">
                    <table className="data-table w-full">
                      <thead>
                        <tr className="bg-secondary">
                          <th>Material</th>
                          <th style={{ textAlign: 'right' }}>Asked for</th>
                          <th style={{ textAlign: 'right' }}>Issued</th>
                          <th style={{ textAlign: 'right' }} title="Fabric used and wasted in cutting">
                            Used in cutting
                          </th>
                          <th style={{ textAlign: 'right' }} title="Brought back to the store on floor returns">
                            Returned
                          </th>
                          <th style={{ textAlign: 'right' }} title="Issued, not used in cutting and not returned">
                            With production
                          </th>
                          <th style={{ textAlign: 'right' }} title="Asked for and not issued: not issued once approved">
                            Not issued
                          </th>
                        </tr>
                      </thead>
                      <tbody>
                        {d.materials.map((m) => (
                          <tr key={m.item.code}>
                            <td>
                              <div className="text-foreground font-medium">{m.item.name}</div>
                              <div className="text-muted-foreground font-mono text-[11px]">
                                {m.item.code}
                                {m.customers ? ' · customer’s' : ''}
                              </div>
                            </td>
                            <td className="text-right tabular-nums">{qty(m.asked, m.item.uom)}</td>
                            <td className="text-right tabular-nums">{qty(m.issued, m.item.uom)}</td>
                            <td className="text-right tabular-nums">{qty(m.usedInCutting, m.item.uom)}</td>
                            <td className="text-right tabular-nums">{qty(m.returned, m.item.uom)}</td>
                            <td className="text-right tabular-nums">
                              <span className={m.withProduction ? 'warn-text font-medium' : ''}>{qty(m.withProduction, m.item.uom)}</span>
                            </td>
                            <td className="text-right tabular-nums">{qty(m.toIssue, m.item.uom)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  <p className="text-muted-foreground mt-2 text-xs">
                    With production is issued and neither used in cutting nor returned; trims and thread are not counted out as they are used. What is
                    not used comes back on a floor return (Return on its requisition), into stock when the store receives it.
                  </p>
                </Section>
              )}

              {d.requisitions.length > 0 && (
                <Section icon={ClipboardList} title={`Requisitions (${d.requisitions.length})`}>
                  <div className="overflow-x-auto">
                    <table className="data-table w-full">
                      <thead>
                        <tr className="bg-secondary">
                          <th>Requisition</th>
                          <th>For</th>
                          <th>As it stands</th>
                          <th>On approval</th>
                          <th />
                        </tr>
                      </thead>
                      <tbody>
                        {d.requisitions.map((r) => (
                          <tr key={r.id}>
                            <td className="font-mono text-xs font-semibold">{r.mrNumber}</td>
                            <td className="text-xs">
                              {r.moNumber ?? 'The order'}
                              {r.department ? <div className="text-muted-foreground text-[11px]">{r.department}</div> : null}
                            </td>
                            <td className="text-xs">{r.state}</td>
                            <td className="text-xs">{r.closes ? <span className="text-foreground">Closes: nothing more issued</span> : <span className="text-muted-foreground">—</span>}</td>
                            <td className="whitespace-nowrap text-right">
                              {r.returnable && can('inventory', 'create') && (
                                <a
                                  href={`/inventory/requisitions?return=${r.id}`}
                                  target="_blank"
                                  rel="noreferrer"
                                  className="btn-secondary h-7 px-2.5 text-xs"
                                  title="Record unused material coming back to the store"
                                >
                                  <Undo2 size={13} /> Return to store
                                </a>
                              )}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </Section>
              )}

              {(d.purchase.length > 0 || d.enquiries.length > 0) && (
                <Section icon={ShoppingCart} title="Purchase raised for it">
                  {d.purchase.length > 0 && (
                    <div className="overflow-x-auto">
                      <table className="data-table w-full">
                        <thead>
                          <tr className="bg-secondary">
                            <th>Purchase order</th>
                            <th>Supplier</th>
                            <th>Material</th>
                            <th style={{ textAlign: 'right' }}>Ordered</th>
                            <th style={{ textAlign: 'right' }}>Received</th>
                            <th style={{ textAlign: 'right' }}>Still to come</th>
                          </tr>
                        </thead>
                        <tbody>
                          {d.purchase.map((p) => (
                            <tr key={`${p.poId}-${p.item}`}>
                              <td>
                                <a href={`/purchase/orders?q=${encodeURIComponent(p.poNumber)}`} target="_blank" rel="noreferrer" className="text-primary inline-flex items-center gap-1 font-mono text-xs font-semibold hover:underline">
                                  {p.poNumber} <ExternalLink size={11} />
                                </a>
                              </td>
                              <td className="text-xs">{p.supplier}</td>
                              <td className="text-xs">{p.item}</td>
                              <td className="text-right tabular-nums">{qty(p.ordered, p.uom)}</td>
                              <td className="text-right tabular-nums">{qty(p.received, p.uom)}</td>
                              <td className="text-right tabular-nums">{qty(Math.max(0, p.ordered - p.received), p.uom)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                  {d.enquiries.length > 0 && (
                    <p className="text-foreground mt-2 text-sm">
                      Still asking suppliers for rates: {d.enquiries.map((e) => e.enquiryNumber).join(', ')}.
                    </p>
                  )}
                  <p className="text-muted-foreground mt-2 text-xs">
                    Approving closes the requisitions, so nothing new is ordered for this order. What is already ordered stays as it is: Purchase cancels the
                    balance with the supplier, or keeps it for stock.
                  </p>
                </Section>
              )}
            </>
          )}
        </div>

        {d && (
          <div className="border-border flex shrink-0 flex-wrap items-center justify-end gap-2 border-t px-4 py-3">
            {open && !pending && (mayAsk || mayApprove) && (
              <>
                <input
                  className="form-input h-9 min-w-0 flex-1 sm:max-w-md"
                  placeholder="Why is it being cancelled? In the customer’s words"
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  aria-label="Why it is being cancelled"
                  maxLength={500}
                />
                {d.nothingStarted ? (
                  mayApprove ? (
                    <button
                      type="button"
                      className="btn-danger"
                      disabled={!reasonOk || busy !== null || blocked}
                      onClick={() => void post('cancel', `/sales/orders/${d.order.id}/cancel`, { reason: reason.trim(), ...withException }, `${d.order.soNumber} cancelled.`)}
                    >
                      {busy === 'cancel' ? <Loader2 size={15} className="animate-spin" /> : <Ban size={15} />} Cancel order
                    </button>
                  ) : (
                    <span className="text-muted-foreground text-xs">Only someone who approves orders can cancel a confirmed order.</span>
                  )
                ) : (
                  <button
                    type="button"
                    className="btn-danger"
                    disabled={!reasonOk || busy !== null}
                    onClick={() => void post('request', `/sales/orders/${d.order.id}/cancellation/request`, { reason: reason.trim() }, 'Cancellation asked for.')}
                    title="Puts its manufacturing orders on hold until it is approved or withdrawn"
                  >
                    {busy === 'request' ? <Loader2 size={15} className="animate-spin" /> : <Ban size={15} />} Request cancellation
                  </button>
                )}
              </>
            )}
            {open && pending && (
              <>
                {d.gaps.length > 0 && mayException && (
                  <input
                    className="form-input h-9 min-w-0 flex-1"
                    placeholder="Manager’s exception: why it can close with the customer’s material not accounted for"
                    value={exception}
                    onChange={(e) => setException(e.target.value)}
                    aria-label="Why it can close with the customer's material not accounted for"
                    maxLength={1000}
                  />
                )}
                {d.gaps.length > 0 && !mayException && (
                  <span className="text-destructive text-xs">The customer’s material has to be accounted for first, or a manager who approves stock makes an exception.</span>
                )}
                {mayAsk && (
                  <button type="button" className="btn-secondary" disabled={busy !== null} onClick={() => setConfirming('withdraw')}>
                    <Undo2 size={15} /> Withdraw request
                  </button>
                )}
                {mayApprove ? (
                  <button type="button" className="btn-danger" disabled={blocked || busy !== null} onClick={() => setConfirming('approve')}>
                    {busy === 'approve' ? <Loader2 size={15} className="animate-spin" /> : <CheckCircle2 size={15} />} Approve cancellation
                  </button>
                ) : (
                  <span className="text-muted-foreground text-xs">Someone who approves orders approves it.</span>
                )}
              </>
            )}
            {!open && (
              <button type="button" className="btn-secondary" onClick={onClose}>
                Close
              </button>
            )}
          </div>
        )}
      </div>

      {confirming === 'approve' && d && (
        <ReasonDialog
          title={`Approve the cancellation of ${d.order.soNumber}?`}
          description={d.effects.join(' ')}
          confirmLabel="Approve cancellation"
          requireReason={false}
          danger
          busy={busy === 'approve'}
          onCancel={() => setConfirming(null)}
          onConfirm={() => void post('approve', `/sales/orders/${d.order.id}/cancellation/approve`, withException, `${d.order.soNumber} cancelled.`)}
        />
      )}
      {confirming === 'withdraw' && d && (
        <ReasonDialog
          title={`Withdraw the cancellation of ${d.order.soNumber}?`}
          description="The order carries on as before: its manufacturing orders come off hold, and material can be issued and work moved again."
          confirmLabel="Withdraw request"
          requireReason={false}
          busy={busy === 'withdraw'}
          onCancel={() => setConfirming(null)}
          onConfirm={() => void post('withdraw', `/sales/orders/${d.order.id}/cancellation/withdraw`, {}, 'Cancellation withdrawn.')}
        />
      )}
    </div>,
    document.body,
  )
}
