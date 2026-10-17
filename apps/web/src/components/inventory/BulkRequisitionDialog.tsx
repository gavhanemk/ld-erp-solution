'use client'

import { useEffect, useState } from 'react'
import { CheckCircle2, CircleAlert, Loader2, PackageCheck, ShoppingCart, Tag, ThumbsUp, type LucideIcon } from 'lucide-react'
import { api, ApiError, currentUser } from '@/lib/api'
import { FormFrame } from '@/components/ui/FormFrame'
import { newRequestId } from '@/lib/utils'
import type { OutwardRef } from '@/components/packages/packageTypes'
import type { ProcessRequisition } from './ProcessDialog'
import { noBuyBox, planRows, r3, spread, startingQty, type FulfilData } from './processPlan'

/**
 * Several requisitions at once — an MO raises one per department, and taking
 * each through its own window was five approvals, five indents and five
 * issues. The same rules as the Process window (processPlan.ts): what stock
 * covers is issued, store by store; what it cannot cover goes on the indent;
 * nobody approves or issues what they raised themselves unless they are the
 * Admin. Each one is shown before anything is done, ticked, and each says
 * afterwards how it went.
 */

export type BulkAction = 'approve' | 'indent' | 'issue'

const WORDS: Record<BulkAction, { title: string; icon: LucideIcon; what: string; button: (n: number) => string; none: string }> = {
  approve: {
    title: 'Approve requisitions',
    icon: ThumbsUp,
    what: 'Each ticked requisition is approved, and goes to the store to issue or buy.',
    button: (n) => `Approve ${n}`,
    none: 'Nothing here is waiting for approval.',
  },
  indent: {
    title: 'Put short items on the indent',
    icon: ShoppingCart,
    what: 'What the store cannot give goes on the indent for the buyer, never below what a PO already covers. The buyer raises the PO from Purchase Orders → Select from indent.',
    button: (n) => `Save ${n} ${n === 1 ? 'indent' : 'indents'}`,
    none: 'Nothing here is short: the store has it, or it is already with Purchase.',
  },
  issue: {
    title: 'Issue what is in stock',
    icon: PackageCheck,
    what: 'What the store has for each ticked requisition is issued to its department: stock kept aside for it first, then the store it asked, then the store with most free.',
    button: (n) => `Issue ${n}`,
    none: 'Nothing here can be issued from stock yet.',
  },
}

interface Plan {
  mr: ProcessRequisition
  /** One line per item, in words: "Poly Bag 12x16 Self Seal: 60 pcs from Store". */
  lines: string[]
  /** What would be sent; null when there is nothing to do. */
  call: { method: 'patch' | 'post'; path: string; body: Record<string, unknown> } | null
  /** Why nothing is done for it, when nothing is. */
  why: string | null
  outward?: OutwardRef
}
type Result = { ok: boolean; message: string; outward?: OutwardRef }

const fmt = (v: number) => v.toLocaleString('en-IN', { maximumFractionDigits: 3 })

export function BulkRequisitionDialog({
  action,
  mrs,
  onClose,
  onDone,
  onLabels,
}: {
  action: BulkAction
  mrs: ProcessRequisition[]
  onClose: () => void
  /** After the run, so the list behind can refresh. */
  onDone: () => void
  /** Labels for what one issue handed over. */
  onLabels: (outward: OutwardRef) => void
}) {
  const w = WORDS[action]
  const me = currentUser()
  const admin = me?.role === 'Admin'
  // The list behind refreshes after the run; this window keeps the ones it opened with.
  const [count] = useState(mrs.length)
  const [plans, setPlans] = useState<Plan[] | null>(null)
  const [ticked, setTicked] = useState<Record<string, boolean>>({})
  const [results, setResults] = useState<Record<string, Result>>({})
  const [running, setRunning] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // What each would do, worked out from the store's own figures before anything is pressed.
  useEffect(() => {
    let alive = true
    const plan = async (mr: ProcessRequisition): Promise<Plan> => {
      const base = { mr, lines: [] as string[], call: null, why: null }
      if (action === 'approve') {
        if (mr.status !== 'PENDING') return { ...base, why: 'Already decided.' }
        if (mr.raisedBy?.id === me?.id && !admin) return { ...base, why: 'You raised it, so somebody else approves it.' }
        return { ...base, lines: mr.lines.map((l) => `${l.item.name}: ${fmt(Number(l.requestedQty))} ${l.item.uom.symbol}`), call: { method: 'patch', path: `/inventory/requisitions/${mr.id}/approve`, body: {} } }
      }
      if (mr.status !== 'APPROVED' || mr.closedAt || mr.issuedAt) return { ...base, why: mr.status === 'PENDING' ? 'Waiting for approval first.' : 'Nothing more is owed on it.' }
      const canIssue = admin || (me?.id !== mr.raisedBy?.id && me?.id !== mr.approvedBy?.id)
      if (action === 'issue' && !canIssue) return { ...base, why: 'You raised or approved it, so somebody else in the store issues it.' }
      const res = await api.get<{ data: FulfilData }>(`/inventory/requisitions/${mr.id}/fulfil`)
      const rows = planRows(mr.lines, res.data)
      const start = startingQty(rows, canIssue)
      if (action === 'indent') {
        const buy = rows
          .map((r) => ({ r, v: Number(start.buy[r.l.id] || 0) }))
          .filter(({ r, v }) => !noBuyBox(r) && v > 0 && Math.abs(v - r.onIndent) > 1e-9)
        if (!buy.length) return { ...base, why: 'Nothing short: the store has it, or it is already with Purchase.' }
        return {
          ...base,
          lines: buy.map(({ r, v }) => `${r.l.item.name}: ${fmt(v)} ${r.unit} to buy`),
          call: { method: 'patch', path: `/inventory/requisitions/${mr.id}/plan`, body: { lines: buy.map(({ r, v }) => ({ lineId: r.l.id, buyQty: r3(v) })) } },
        }
      }
      const give = rows.map((r) => ({ r, v: Number(start.issue[r.l.id] || 0) })).filter(({ v }) => v > 0)
      if (!give.length) return { ...base, why: 'Nothing in stock for it yet.' }
      const lines = give.flatMap(({ r, v }) => [...spread(r, v).entries()].map(([warehouseId, q]) => ({ lineId: r.l.id, warehouseId, issueQty: q })))
      const storeName = (r: (typeof rows)[number], id: string) => r.stores.find((s) => s.id === id)?.name ?? 'store'
      return {
        ...base,
        lines: give.map(({ r, v }) => `${r.l.item.name}: ${fmt(v)} ${r.unit} from ${[...spread(r, v).keys()].map((id) => storeName(r, id)).join(' and ')}`),
        call: { method: 'post', path: `/inventory/requisitions/${mr.id}/issue`, body: { lines, requestId: newRequestId() } },
        outward: { type: 'MR', id: mr.id, q: lines.map((l) => `${l.lineId}:${l.issueQty}:${l.warehouseId}`).join(',') },
      }
    }
    Promise.all(mrs.map((mr) => plan(mr).catch((err): Plan => ({ mr, lines: [], call: null, why: err instanceof ApiError ? err.message : 'Could not read its figures.' }))))
      .then((ps) => {
        if (!alive) return
        setPlans(ps)
        setTicked(Object.fromEntries(ps.filter((p) => p.call).map((p) => [p.mr.id, true])))
      })
    return () => {
      alive = false
    }
    // Worked out once, for the requisitions the window opened with.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const chosen = (plans ?? []).filter((p) => p.call && ticked[p.mr.id] && !results[p.mr.id])
  const ran = Object.keys(results).length > 0

  // One at a time, in order: each is its own save, and one refused does not stop the rest.
  const run = async () => {
    setRunning(true)
    setError(null)
    for (const p of chosen) {
      try {
        const res =
          p.call!.method === 'patch'
            ? await api.patch<{ message?: string }>(p.call!.path, p.call!.body)
            : await api.post<{ message?: string }>(p.call!.path, p.call!.body)
        setResults((r) => ({ ...r, [p.mr.id]: { ok: true, message: res.message ?? 'Done.', outward: p.outward } }))
      } catch (err) {
        setResults((r) => ({ ...r, [p.mr.id]: { ok: false, message: err instanceof ApiError ? err.message : 'Could not save it.' } }))
      }
    }
    setRunning(false)
    onDone()
  }

  const okCount = Object.values(results).filter((r) => r.ok).length
  return (
    <FormFrame
      icon={w.icon}
      title={w.title}
      subtitle={`${count} ${count === 1 ? 'requisition' : 'requisitions'} from the list`}
      width="max-w-3xl"
      primary={
        ran && !chosen.length ? (
          <button type="button" className="btn-primary" onClick={onClose}>
            Close
          </button>
        ) : (
          <button type="button" className="btn-primary" onClick={() => void run()} disabled={running || !plans || !chosen.length}>
            {running ? <Loader2 size={15} className="animate-spin" /> : <w.icon size={15} />} {w.button(chosen.length)}
          </button>
        )
      }
      footer={
        <button type="button" className="btn-secondary" onClick={onClose} disabled={running}>
          {ran ? 'Close' : 'Cancel'}
        </button>
      }
      footerNote={ran ? `${okCount} of ${Object.keys(results).length} done.` : w.what}
      error={error}
      onClose={onClose}
      busy={running}
    >
      {!plans ? (
        <p className="text-muted-foreground flex items-center gap-2 text-sm">
          <Loader2 size={15} className="animate-spin" /> Working out what each one needs…
        </p>
      ) : !plans.some((p) => p.call) && !ran ? (
        <p className="text-muted-foreground text-sm">{w.none}</p>
      ) : (
        <ul className="divide-border border-border divide-y rounded-lg border">
          {plans.map((p) => {
            const r = results[p.mr.id]
            return (
              <li key={p.mr.id} className={`flex gap-3 px-3 py-2.5 ${!p.call ? 'opacity-60' : ''}`}>
                <div className="pt-0.5">
                  {r ? (
                    r.ok ? <CheckCircle2 size={16} className="text-emerald-500" /> : <CircleAlert size={16} className="text-red-500" />
                  ) : (
                    <input
                      type="checkbox"
                      checked={!!ticked[p.mr.id]}
                      disabled={!p.call || running}
                      onChange={(e) => setTicked((t) => ({ ...t, [p.mr.id]: e.target.checked }))}
                      aria-label={`Include ${p.mr.mrNumber}`}
                    />
                  )}
                </div>
                <div className="min-w-0 flex-1">
                  <p className="text-sm">
                    <span className="text-foreground font-mono font-semibold">{p.mr.mrNumber}</span>
                    <span className="text-muted-foreground"> · {p.mr.department.name}{p.mr.mo ? ` · ${p.mr.mo.moNumber}` : ''}</span>
                  </p>
                  {r ? (
                    <p className={`text-xs ${r.ok ? 'text-foreground' : 'text-red-500'}`}>{r.message}</p>
                  ) : p.why ? (
                    <p className="text-muted-foreground text-xs">{p.why}</p>
                  ) : (
                    <ul className="text-muted-foreground text-xs">
                      {p.lines.map((t) => (
                        <li key={t}>{t}</li>
                      ))}
                    </ul>
                  )}
                </div>
                {r?.ok && r.outward && (
                  <button type="button" className="btn-secondary h-8 shrink-0 px-2.5 text-xs" onClick={() => onLabels(r.outward!)}>
                    <Tag size={13} /> Labels
                  </button>
                )}
              </li>
            )
          })}
        </ul>
      )}
    </FormFrame>
  )
}
