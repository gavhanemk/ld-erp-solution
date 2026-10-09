'use client'

import { useCallback, useEffect, useState } from 'react'
import { CheckCircle2, Clock, XCircle, Loader2, Inbox } from 'lucide-react'
import { api, ApiError, currentUser } from '@/lib/api'
import { formatCurrency, formatDate } from '@/lib/utils'

interface Approval {
  id: string
  type: 'PO' | 'SO' | 'MR'
  number: string
  description: string
  amount: number | null
  date: string
  urgent: boolean
  /** Requisitions and sales orders: who raised it, who therefore may not approve it. */
  raisedById?: string | null
}

const typeColors: Record<string, string> = {
  PO: 'badge-info',
  SO: 'badge-success',
  MR: 'badge-warning',
}

const typeLabel: Record<string, string> = {
  PO: 'Purchase Order',
  SO: 'Sales Order',
  MR: 'Material Requisition',
}

export function PendingApprovalsTable() {
  const [approvals, setApprovals] = useState<Approval[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      const res = await api.get<{ success: boolean; data: Approval[] }>(
        '/dashboard/pending-approvals?limit=10',
      )
      setApprovals(res.data)
      setError(null)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load pending approvals.')
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const me = currentUser()

  const decide = async (a: Approval, decision: 'approve' | 'reject') => {
    let reason = ''
    if (decision === 'reject') {
      const input = window.prompt(`Why are you rejecting ${a.number}?`)
      if (input === null) return
      reason = input.trim()
      if (!reason) {
        setError('A reason is required when rejecting.')
        return
      }
      // The requisition screen asks for a reason somebody can act on, and the
      // server now holds this door to the same bar.
      if (a.type === 'MR' && reason.length < 5) {
        setError('Say why it is being refused, in a few words.')
        return
      }
    } else if (!window.confirm(`Approve ${a.number} (${typeLabel[a.type]})?`)) {
      return
    }

    setBusyId(a.id)
    setError(null)
    try {
      try {
        await api.post(`/approvals/${a.type}/${a.id}/${decision}`, decision === 'reject' ? { reason } : {})
      } catch (err) {
        // A customer over their credit limit, or blacklisted, is not a hard
        // stop: the server sends the figures, and the approver releases the
        // order with a reason that is kept on it.
        if (!(decision === 'approve' && err instanceof ApiError && err.code === 'CREDIT_HOLD')) throw err
        const why = window.prompt(`${err.message}\n\nWhy is the credit hold being released?`)
        if (why === null) return
        if (why.trim().length < 5) {
          setError('Say why the credit hold is being released, in a few words.')
          return
        }
        await api.post(`/approvals/${a.type}/${a.id}/approve`, { creditReleaseReason: why.trim() })
      }
      // Refetch rather than splicing locally: approving a document can change
      // what else is outstanding.
      await load()
    } catch (err) {
      setError(err instanceof ApiError ? err.message : `Could not ${decision} ${a.number}.`)
    } finally {
      setBusyId(null)
    }
  }

  /**
   * Whoever raised a document cannot approve it. The Admin may approve their
   * own sales order, as the server allows; requisitions keep their own rule.
   */
  const ownBlocked = (a: Approval) =>
    !!a.raisedById &&
    a.raisedById === me?.id &&
    (a.type === 'MR' || (a.type === 'SO' && me?.role !== 'Admin'))

  return (
    <div className="glass-card p-6">
      <div className="flex items-center justify-between mb-5">
        <div>
          <h3 className="text-sm font-semibold text-foreground flex items-center gap-2">
            <Clock size={15} className="text-amber-400" />
            Pending Approvals
          </h3>
          <p className="text-xs text-muted-foreground mt-0.5">
            {approvals === null && !error
              ? 'Loading...'
              : `${approvals?.length ?? 0} item${approvals?.length === 1 ? '' : 's'} waiting`}
          </p>
        </div>
      </div>

      {error && (
        <p className="text-xs text-red-400 mb-3 px-3 py-2 rounded-lg border border-red-500/30 bg-red-500/5">
          {error}
        </p>
      )}

      {!approvals && !error && <div className="skeleton h-32 w-full rounded-lg" />}

      {approvals && approvals.length === 0 && (
        <div className="py-10 text-center">
          <Inbox size={22} className="text-muted-foreground mx-auto mb-2" />
          <p className="text-xs text-muted-foreground">Nothing is waiting on approval.</p>
        </div>
      )}

      {approvals && approvals.length > 0 && (
        <div className="overflow-x-auto">
          <table className="data-table">
            <thead>
              <tr>
                <th>Type</th>
                <th>Document</th>
                <th>Description</th>
                <th className="text-right">Amount</th>
                <th>Raised</th>
                <th className="text-right">Action</th>
              </tr>
            </thead>
            <tbody>
              {approvals.map((a) => (
                <tr key={`${a.type}-${a.id}`}>
                  <td>
                    <span className={typeColors[a.type] ?? 'badge-neutral'} title={typeLabel[a.type]}>
                      {a.type}
                    </span>
                  </td>
                  <td>
                    <span className="font-mono text-xs text-teal-400">{a.number}</span>
                    {a.urgent && (
                      <span className="ml-2 text-[10px] text-red-400 font-semibold">URGENT</span>
                    )}
                  </td>
                  <td className="max-w-[200px] truncate text-muted-foreground">{a.description}</td>
                  <td className="text-right font-semibold text-foreground">
                    {a.amount != null && a.amount > 0 ? formatCurrency(a.amount) : '—'}
                  </td>
                  <td className="text-muted-foreground text-xs">{formatDate(a.date)}</td>
                  <td>
                    <div className="flex items-center gap-2 justify-end">
                      {ownBlocked(a) ? (
                        <span className="text-[11px] text-muted-foreground" title="You raised it, so somebody else has to approve it">
                          Yours — someone else approves
                        </span>
                      ) : (
                      <button
                        disabled={busyId === a.id}
                        onClick={() => void decide(a, 'approve')}
                        className="flex items-center gap-1 px-2.5 py-1 text-xs font-semibold rounded-lg bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 hover:bg-emerald-500/20 transition-colors disabled:opacity-50"
                      >
                        {busyId === a.id ? (
                          <Loader2 size={12} className="animate-spin" />
                        ) : (
                          <CheckCircle2 size={12} />
                        )}
                        Approve
                      </button>
                      )}
                      <button
                        disabled={busyId === a.id}
                        onClick={() => void decide(a, 'reject')}
                        title="Reject"
                        className="p-1.5 rounded-lg text-muted-foreground hover:text-red-400 hover:bg-red-500/10 transition-colors disabled:opacity-50"
                      >
                        <XCircle size={14} />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
