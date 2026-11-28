'use client'

import { useCallback, useEffect, useState } from 'react'
import { ArrowRightLeft, ShieldAlert } from 'lucide-react'
import { api, apiErrorMessage, can, currentUser } from '@/lib/api'
import { itemShade, type ShadeFields } from '@/lib/items'
import { FormFrame } from '@/components/ui/FormFrame'
import { ReasonDialog } from '@/components/ui/ReasonDialog'

export interface Reallocation {
  id: string
  number: string
  kind: 'EARMARK' | 'MOVE' | 'RELEASE' | 'AUTO'
  kindWords: string
  status: 'PENDING' | 'POSTED' | 'REJECTED' | 'CANCELLED' | 'REVERSED'
  from: string
  to: string
  reason: string
  value: number
  createdAt: string
  postedAt: string | null
  selfApproved: boolean
  overrideReason: string | null
  rejectReason: string | null
  reverseReason: string | null
  warehouse: { id: string; name: string }
  mo: { id: string; moNumber: string } | null
  mr: { id: string; mrNumber: string } | null
  /** The challan an automatic one was made for, when a dispatch made it. */
  dc: { id: string; dcNumber: string } | null
  fromBrand: { id: string; name: string } | null
  toBrand: { id: string; name: string } | null
  requestedBy: { id: string; name: string }
  approvedBy: { name: string } | null
  rejectedBy: { name: string } | null
  reversedBy: { name: string } | null
  lines: Array<{
    id: string
    qty: string
    unitRate: string | null
    packageCodes: string[]
    garmentCodes: string[]
    grade: string
    item: ShadeFields & { code: string; name: string; uom: { symbol: string } | null }
    size: { code: string } | null
  }>
}
interface Detail extends Reallocation {
  rows: Array<{ id: string; share: string; inQty: number; outQty: number; unitRate: number; transactionDate: string; notes: string | null }>
}

export const REALLOCATION_STATUS: Record<Reallocation['status'], { label: string; badge: string }> = {
  PENDING: { label: 'Waiting for approval', badge: 'badge-warning' },
  POSTED: { label: 'Posted', badge: 'badge-success' },
  REJECTED: { label: 'Refused', badge: 'badge-danger' },
  CANCELLED: { label: 'Withdrawn', badge: 'badge-neutral' },
  REVERSED: { label: 'Reversed', badge: 'badge-neutral' },
}

const when = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : '')

/**
 * One reallocation: what moved from which share to which, and the step left
 * for whoever may take it. Its maker cannot approve it; an Admin may, only as
 * an override with a reason that is kept on it and in the audit trail.
 */
export function ReallocationView({ id, onClose, onChanged }: { id: string; onClose: () => void; onChanged: (message: string) => void }) {
  const [doc, setDoc] = useState<Detail | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [asking, setAsking] = useState<'reject' | 'reverse' | 'override' | null>(null)
  const me = currentUser() as { id?: string; role?: string; superAdmin?: boolean } | null
  const admin = !!me && (me.superAdmin || me.role === 'Super Admin' || me.role === 'Admin')

  const load = useCallback(async () => {
    try {
      setDoc((await api.get<{ data: Detail }>(`/inventory/reallocations/${id}`)).data)
    } catch (err) {
      setError(apiErrorMessage(err, 'Could not open it.'))
    }
  }, [id])
  useEffect(() => {
    void load()
  }, [load])

  const act = async (path: string, body: Record<string, unknown> = {}) => {
    setBusy(true)
    setError(null)
    try {
      const res = await api.post<{ message: string }>(`/inventory/reallocations/${id}/${path}`, body)
      setAsking(null)
      onChanged(res.message)
      await load()
    } catch (err) {
      setAsking(null)
      setError(apiErrorMessage(err, 'That could not be done.'))
    } finally {
      setBusy(false)
    }
  }

  const mine = !!doc && !!me?.id && doc.requestedBy.id === me.id
  const may = (a: string) => can('inventory.brand-stock', a)
  const primary = (() => {
    if (!doc) return null
    if (doc.status === 'PENDING' && may('approve') && !mine)
      return (
        <button type="button" className="btn-primary" disabled={busy} onClick={() => void act('approve')}>
          Approve and post
        </button>
      )
    if (doc.status === 'PENDING' && may('approve') && mine && admin)
      return (
        <button type="button" className="btn-ghost" disabled={busy} onClick={() => setAsking('override')}>
          <ShieldAlert size={14} /> Approve my own (override)
        </button>
      )
    if (doc.status === 'POSTED' && doc.kind !== 'AUTO' && may('approve'))
      return (
        <button type="button" className="btn-ghost" disabled={busy} onClick={() => setAsking('reverse')}>
          Reverse
        </button>
      )
    return (
      <button type="button" className="btn-ghost" onClick={onClose}>
        Close
      </button>
    )
  })()

  return (
    <>
      <FormFrame
        icon={ArrowRightLeft}
        title={doc ? `${doc.number} — ${doc.kindWords}` : 'Reallocation'}
        subtitle={doc ? <span className={REALLOCATION_STATUS[doc.status].badge}>{REALLOCATION_STATUS[doc.status].label}</span> : undefined}
        width="max-w-4xl"
        busy={busy}
        error={error}
        onClose={onClose}
        primary={primary}
        primaryInHeader={false}
        footer={
          doc?.status === 'PENDING' ? (
            <>
              {mine && (
                <button type="button" className="btn-ghost" disabled={busy} onClick={() => void act('cancel')}>
                  Withdraw
                </button>
              )}
              {!mine && may('approve') && (
                <button type="button" className="btn-ghost text-destructive" disabled={busy} onClick={() => setAsking('reject')}>
                  Refuse
                </button>
              )}
            </>
          ) : undefined
        }
        footerNote={
          doc?.status === 'PENDING'
            ? mine
              ? admin
                ? 'You raised it: someone else approves it, or you as an Admin override with a reason.'
                : 'You raised it: someone else approves it.'
              : 'Approving posts it at once: out of one share and into the other, at the giving share’s average.'
            : undefined
        }
      >
        {!doc && !error && <div className="skeleton h-40 w-full rounded-xl" />}
        {doc && (
          <>
            <div className="grid gap-2 text-sm sm:grid-cols-2">
              <p>
                <span className="text-muted-foreground">From </span>
                <strong>{doc.from}</strong>
                <span className="text-muted-foreground"> to </span>
                <strong>{doc.to}</strong>
                <span className="text-muted-foreground"> · {doc.warehouse.name}</span>
              </p>
              <p className="text-muted-foreground sm:text-right">
                {doc.mo ? `For ${doc.mo.moNumber}` : ''}
                {doc.mr ? ` · ${doc.mr.mrNumber}` : ''}
                {doc.dc ? `For challan ${doc.dc.dcNumber}` : ''}
              </p>
            </div>
            <p className="text-sm">
              <span className="text-muted-foreground">Why: </span>
              {doc.reason}
            </p>
            {doc.selfApproved && (
              <div className="flex items-start gap-2 rounded-lg border border-amber-500/40 bg-amber-500/5 p-3 text-sm">
                <ShieldAlert size={15} className="mt-0.5 shrink-0 text-amber-600" />
                <p className="text-foreground">
                  Approved by its own maker as an Admin override: {doc.overrideReason}
                </p>
              </div>
            )}
            <div className="border-border overflow-x-auto rounded-lg border">
              <table className="data-table table-compact w-full min-w-[640px]">
                <thead>
                  <tr>
                    <th>Item</th>
                    <th className="text-right">Quantity</th>
                    <th className="text-right">At</th>
                    <th className="text-right">Value</th>
                    <th>Stickers / tags</th>
                  </tr>
                </thead>
                <tbody>
                  {doc.lines.map((l) => (
                    <tr key={l.id}>
                      <td>
                        {l.item.code} · {l.item.name}
                        <span className="text-muted-foreground block text-[11px]">
                          {[itemShade(l.item), l.size ? `size ${l.size.code}` : '', l.grade !== 'A' ? `grade ${l.grade}` : ''].filter(Boolean).join(' · ')}
                        </span>
                      </td>
                      <td className="text-right tabular-nums">
                        {Number(l.qty)} {l.item.uom?.symbol ?? ''}
                      </td>
                      <td className="text-right tabular-nums">{l.unitRate ? `₹${Number(l.unitRate).toLocaleString('en-IN')}` : '—'}</td>
                      <td className="text-right tabular-nums">{l.unitRate ? `₹${(Number(l.qty) * Number(l.unitRate)).toLocaleString('en-IN', { maximumFractionDigits: 2 })}` : '—'}</td>
                      <td className="font-mono text-[11px]">{[...l.packageCodes, ...l.garmentCodes].join(' · ') || '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {doc.rows.length > 0 && (
              <div className="border-border rounded-lg border">
                <p className="border-border border-b px-3 py-2 text-xs font-medium">In the stock ledger</p>
                <table className="data-table table-compact w-full">
                  <tbody>
                    {doc.rows.map((r) => (
                      <tr key={r.id}>
                        <td className="whitespace-nowrap text-xs">{when(r.transactionDate)}</td>
                        <td className="text-xs">{r.share}</td>
                        <td className="text-right text-xs tabular-nums">{r.inQty > 0 ? `+${r.inQty}` : `−${r.outQty}`}</td>
                        <td className="text-right text-xs tabular-nums">₹{r.unitRate.toLocaleString('en-IN')}</td>
                        <td className="text-muted-foreground text-xs">{r.notes}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <p className="text-muted-foreground text-xs">
              Raised by {doc.requestedBy.name} on {when(doc.createdAt)}
              {doc.approvedBy ? `; approved by ${doc.approvedBy.name} on ${when(doc.postedAt)}` : doc.kind === 'AUTO' ? '; made by the material issue itself (decision 7)' : ''}
              {doc.rejectedBy ? `; refused by ${doc.rejectedBy.name}: ${doc.rejectReason}` : ''}
              {doc.reversedBy ? `; reversed by ${doc.reversedBy.name}: ${doc.reverseReason}` : ''}
            </p>
          </>
        )}
      </FormFrame>
      {asking && doc && (
        <ReasonDialog
          title={asking === 'reject' ? `Refuse ${doc.number}?` : asking === 'reverse' ? `Reverse ${doc.number}?` : `Approve your own ${doc.number}?`}
          description={
            asking === 'reject'
              ? 'Nothing moves. Say why, so its maker can put it right.'
              : asking === 'reverse'
                ? 'The same stock goes back to the share it came from, with its stickers and tags. Refused if some of it has been used since.'
                : 'You raised it, so this is an Admin override. Say why it cannot wait for someone else: the reason stays on the document and in the audit trail.'
          }
          confirmLabel={asking === 'reject' ? 'Refuse it' : asking === 'reverse' ? 'Reverse it' : 'Approve as an override'}
          danger={asking !== 'override'}
          minLength={asking === 'override' ? 10 : 5}
          busy={busy}
          onConfirm={(reason) => void (asking === 'override' ? act('approve', { overrideReason: reason }) : act(asking, { reason }))}
          onCancel={() => setAsking(null)}
        />
      )}
    </>
  )
}
