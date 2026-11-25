'use client'

import { useCallback, useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { AlertCircle, Check, History, IndianRupee, Loader2, PenLine, Undo2, X } from 'lucide-react'
import { api, ApiError, can, currentUser } from '@/lib/api'
import { cn } from '@/lib/utils'
import { useEscape } from '@/lib/useEscape'
import { StepInput } from '@/components/ui/StepInput'

/*
 * Opening stock put right after it is in, never deleted: a line that came in
 * without a rate gets its rate (Inventory → approve); a correction to lines,
 * or a whole entry's reversal, is asked for with a reason and posted only
 * once someone else with Inventory → approve approves it.
 */

const money = (v: number) => `₹${v.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
const num = (v: number) => v.toLocaleString('en-IN', { maximumFractionDigits: 3 })
const when = (d: string | null) => (d ? new Date(d).toLocaleString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' }) : '')

interface ChangeLine {
  lineId: string
  qty: number
  rate: number
  row: number
  was: { qty: number; rate: number }
}
interface Change {
  id: string
  number: string
  kind: 'CORRECTION' | 'REVERSAL'
  status: 'PENDING' | 'APPROVED' | 'REJECTED' | 'WITHDRAWN'
  reason: string
  lines: ChangeLine[] | null
  requestedAt: string
  decidedAt: string | null
  decisionNote: string | null
  requestedById: string | null
  requestedBy: { name: string } | null
  decidedBy: { name: string } | null
}
interface EntryLine {
  id: string
  rowNo: number
  qty: string | number
  unitRate: string | number
  lotNo: string | null
  valuationPending: boolean
  item: { code: string; name: string; uom: { symbol: string } | null }
  size: { code: string } | null
  warehouse: { name: string }
}
interface EntryDetail {
  id: string
  number: string
  fileName: string | null
  reversedAt: string | null
  reversedBy: { name: string } | null
  lines: EntryLine[]
  changes: Change[]
}

const STATUS_BADGE: Record<Change['status'], string> = { PENDING: 'badge-warning', APPROVED: 'badge-success', REJECTED: 'badge-danger', WITHDRAWN: 'badge-neutral' }

/** An entry's state and what can be done to it: correct its lines, take it back, decide what is waiting. */
export function EntryControls({ entryId, onChanged, say }: { entryId: string; onChanged: () => void; say: (message: string) => void }) {
  const [doc, setDoc] = useState<EntryDetail | null>(null)
  const [dialog, setDialog] = useState<null | 'correct' | 'reverse' | { reject: Change }>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const me = currentUser() as { id?: string; role?: string } | null
  const mayAsk = can('inventory', 'create')
  const mayApprove = can('inventory', 'approve')

  const load = useCallback(async () => {
    try {
      setDoc((await api.get<{ data: EntryDetail }>(`/inventory/opening-stock/${entryId}`)).data)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load the entry.')
    }
  }, [entryId])
  useEffect(() => {
    void load()
  }, [load])

  const act = async (path: string, body: unknown = {}) => {
    setBusy(true)
    setError(null)
    try {
      const res = await api.post<{ message: string }>(path, body)
      say(res.message)
      setDialog(null)
      await load()
      onChanged()
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'That could not be done.')
    } finally {
      setBusy(false)
    }
  }

  if (!doc) return null
  const pending = doc.changes.find((c) => c.status === 'PENDING')
  const past = doc.changes.filter((c) => c.status !== 'PENDING')
  const own = pending && pending.requestedById === me?.id
  const mayDecide = mayApprove && (!own || me?.role === 'Admin')

  return (
    <section className="glass-card space-y-3 px-4 py-3" aria-label={`Entry ${doc.number}`}>
      <div className="flex flex-wrap items-center gap-3">
        <div className="min-w-0 flex-1">
          <div className="text-foreground flex flex-wrap items-center gap-2 text-sm font-semibold">
            <span className="font-mono text-teal-400">{doc.number}</span>
            {doc.reversedAt ? <span className="badge-danger">Reversed</span> : pending ? <span className="badge-warning">{pending.kind === 'REVERSAL' ? 'Reversal' : 'Correction'} waiting</span> : <span className="badge-success">In stock</span>}
          </div>
          <p className="text-muted-foreground text-xs">
            {doc.reversedAt
              ? `Taken back ${when(doc.reversedAt)}${doc.reversedBy ? ` by ${doc.reversedBy.name}` : ''}: its stock went out again and its stickers were voided. The lines stay here as history.`
              : 'Put right without deleting anything: a correction posts the difference, a reversal posts the stock out again — each once approved.'}
          </p>
        </div>
        {!doc.reversedAt && !pending && mayAsk && (
          <div className="flex items-center gap-2">
            <button type="button" className="btn-secondary h-8 text-xs" onClick={() => setDialog('correct')}>
              <PenLine size={13} /> Request correction
            </button>
            <button type="button" className="btn-secondary h-8 text-xs" onClick={() => setDialog('reverse')}>
              <Undo2 size={13} /> Request reversal
            </button>
          </div>
        )}
      </div>

      {error && !dialog && (
        <p className="flex items-center gap-1.5 text-sm text-red-400" role="alert">
          <AlertCircle size={14} /> {error}
        </p>
      )}

      {pending && (
        <div className="rounded-lg border border-amber-500/40 bg-amber-500/5 px-4 py-3" aria-label="Waiting for approval">
          <div className="flex flex-wrap items-start gap-3">
            <div className="min-w-0 flex-1 text-sm">
              <div className="text-foreground font-semibold">
                {pending.number}: {pending.kind === 'REVERSAL' ? 'take the whole entry back' : 'correct its lines'}
              </div>
              <div className="text-muted-foreground text-xs">
                Asked by {pending.requestedBy?.name ?? '—'}, {when(pending.requestedAt)} · “{pending.reason}”
              </div>
              {pending.lines && (
                <ul className="text-foreground mt-1.5 space-y-0.5 text-xs">
                  {pending.lines.map((l) => (
                    <li key={l.lineId}>
                      Row {l.row}:{' '}
                      {Math.abs(l.qty - l.was.qty) > 0.0005 && (
                        <>
                          quantity {num(l.was.qty)} → <b>{num(l.qty)}</b>
                        </>
                      )}
                      {Math.abs(l.qty - l.was.qty) > 0.0005 && Math.abs(l.rate - l.was.rate) > 0.004 && ' · '}
                      {Math.abs(l.rate - l.was.rate) > 0.004 && (
                        <>
                          rate {money(l.was.rate)} → <b>{money(l.rate)}</b>
                        </>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {mayDecide && (
                <>
                  <button type="button" className="btn-primary h-8 text-xs" disabled={busy} onClick={() => void act(`/inventory/opening-stock/changes/${pending.id}/approve`)}>
                    {busy ? <Loader2 size={13} className="animate-spin" /> : <Check size={13} />} Approve
                  </button>
                  <button type="button" className="btn-secondary h-8 text-xs" disabled={busy} onClick={() => setDialog({ reject: pending })}>
                    Turn down
                  </button>
                </>
              )}
              {own && (
                <button type="button" className="btn-ghost h-8 text-xs" disabled={busy} onClick={() => void act(`/inventory/opening-stock/changes/${pending.id}/withdraw`)}>
                  Withdraw
                </button>
              )}
              {!mayDecide && !own && <span className="text-muted-foreground text-xs">Waiting for someone with Inventory → approve.</span>}
              {mayApprove && own && me?.role !== 'Admin' && <span className="text-muted-foreground text-xs">Someone else approves your own request.</span>}
            </div>
          </div>
        </div>
      )}

      {past.length > 0 && (
        <details className="text-xs">
          <summary className="text-muted-foreground flex cursor-pointer items-center gap-1.5 font-medium">
            <History size={13} /> {past.length} earlier {past.length === 1 ? 'request' : 'requests'}
          </summary>
          <ul className="divide-border border-border mt-2 divide-y rounded-lg border">
            {past.map((c) => (
              <li key={c.id} className="flex flex-wrap items-center gap-2 px-3 py-2">
                <span className="font-mono font-semibold text-teal-400">{c.number}</span>
                <span className="text-foreground">{c.kind === 'REVERSAL' ? 'Reversal' : 'Correction'}</span>
                <span className={STATUS_BADGE[c.status]}>{c.status.charAt(0) + c.status.slice(1).toLowerCase()}</span>
                <span className="text-muted-foreground min-w-0 flex-1 truncate">
                  “{c.reason}” · {c.requestedBy?.name ?? '—'}
                  {c.decidedBy ? ` · decided by ${c.decidedBy.name}` : ''}
                  {c.decisionNote ? ` · “${c.decisionNote}”` : ''}
                </span>
                <span className="text-muted-foreground">{when(c.decidedAt ?? c.requestedAt)}</span>
              </li>
            ))}
          </ul>
        </details>
      )}

      {dialog === 'correct' && (
        <CorrectDialog doc={doc} busy={busy} error={error} onClose={() => setDialog(null)} onSend={(reason, lines) => void act(`/inventory/opening-stock/${doc.id}/changes`, { kind: 'CORRECTION', reason, lines })} />
      )}
      {dialog === 'reverse' && (
        <ReasonDialog
          title={`Take ${doc.number} back`}
          text="Every line's stock goes out again and its stickers are voided, once someone with Inventory → approve approves it. The entry stays as history, and the same stock can then be brought in again correctly. Refused if any of it has been used since."
          label="Why it is taken back"
          action="Ask for the reversal"
          busy={busy}
          error={error}
          onClose={() => setDialog(null)}
          onSend={(reason) => void act(`/inventory/opening-stock/${doc.id}/changes`, { kind: 'REVERSAL', reason })}
        />
      )}
      {dialog && typeof dialog === 'object' && (
        <ReasonDialog
          title={`Turn down ${dialog.reject.number}`}
          text="Nothing is posted. The reason goes back to whoever asked."
          label="Why it is turned down"
          action="Turn it down"
          busy={busy}
          error={error}
          onClose={() => setDialog(null)}
          onSend={(note) => void act(`/inventory/opening-stock/changes/${dialog.reject.id}/reject`, { note })}
        />
      )}
    </section>
  )
}

/** A line's rate: and, when it came in without one, its valuation waiting — set here by someone with Inventory → approve. */
export function RateCell({ line, onDone }: { line: { id: string; unitRate: string | number; valuationPending?: boolean; openingStock?: { reversedAt?: string | null } }; onDone: (message: string) => void }) {
  const [open, setOpen] = useState(false)
  const [rate, setRate] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  if (!line.valuationPending || line.openingStock?.reversedAt) return <>{money(Number(line.unitRate))}</>
  const save = async () => {
    setBusy(true)
    setError(null)
    try {
      const res = await api.post<{ message: string }>(`/inventory/opening-stock/lines/${line.id}/rate`, { rate: Number(rate) })
      setOpen(false)
      onDone(res.message)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not set the rate.')
    } finally {
      setBusy(false)
    }
  }
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className="badge-warning text-[10px]">Valuation pending</span>
      {can('inventory', 'approve') && (
        <button type="button" className="text-primary text-[11px] font-semibold hover:underline" onClick={() => setOpen(true)} aria-label="Set rate">
          Set rate
        </button>
      )}
      {open && (
        <Modal title="Set its rate" onClose={() => !busy && setOpen(false)}>
          <p className="text-muted-foreground text-sm">It came in at ₹0. The rate is applied from the opening date: anything issued from this stock since is priced again at the new average.</p>
          <label className="block space-y-1.5">
            <span className="text-foreground text-xs font-semibold">Rate per unit (₹)</span>
            <div className="relative">
              <IndianRupee size={13} className="text-muted-foreground pointer-events-none absolute left-3 top-1/2 -translate-y-1/2" />
              <StepInput className="form-input h-10 pl-8 text-right" value={rate} decimals onValueChange={setRate} aria-label="Rate per unit" autoFocus />
            </div>
          </label>
          {error && (
            <p className="text-sm text-red-400" role="alert">
              {error}
            </p>
          )}
          <div className="flex justify-end gap-2">
            <button type="button" className="btn-secondary" disabled={busy} onClick={() => setOpen(false)}>
              Cancel
            </button>
            <button type="button" className="btn-primary" disabled={busy || !(Number(rate) > 0)} onClick={() => void save()}>
              {busy && <Loader2 size={14} className="animate-spin" />} Set the rate
            </button>
          </div>
        </Modal>
      )}
    </span>
  )
}

/** The lines of an entry, each with its new quantity and rate, and why. */
function CorrectDialog({ doc, busy, error, onClose, onSend }: { doc: EntryDetail; busy: boolean; error: string | null; onClose: () => void; onSend: (reason: string, lines: Array<{ lineId: string; qty: number; rate: number }>) => void }) {
  const [edits, setEdits] = useState<Record<string, { qty: string; rate: string }>>({})
  const [reason, setReason] = useState('')
  const changed = doc.lines
    .map((l) => {
      const e = edits[l.id]
      if (!e) return null
      const qty = e.qty === '' ? Number(l.qty) : Number(e.qty)
      const rate = e.rate === '' ? Number(l.unitRate) : Number(e.rate)
      return Math.abs(qty - Number(l.qty)) > 0.0005 || Math.abs(rate - Number(l.unitRate)) > 0.004 ? { lineId: l.id, qty, rate } : null
    })
    .filter((x): x is { lineId: string; qty: number; rate: number } => x !== null)
  const set = (id: string, change: Partial<{ qty: string; rate: string }>) => setEdits((e) => ({ ...e, [id]: { qty: e[id]?.qty ?? '', rate: e[id]?.rate ?? '', ...change } }))
  return (
    <Modal title={`Correct ${doc.number}`} wide onClose={() => !busy && onClose()}>
      <p className="text-muted-foreground text-sm">
        Give the lines their right quantity or rate. Nothing changes until someone with Inventory → approve approves it; then the difference is posted and the line shows the new figures. A line on stickers has them taken off first (Change → packaging pending).
      </p>
      <div className="border-border max-h-[50vh] overflow-auto rounded-lg border">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-muted-foreground text-left text-[11px] font-semibold uppercase tracking-wide">
              <th className="px-3 py-2">Row</th>
              <th className="px-2 py-2">Item</th>
              <th className="px-2 py-2 text-right">Quantity now</th>
              <th className="w-36 px-2 py-2 text-right">Right quantity</th>
              <th className="px-2 py-2 text-right">Rate now</th>
              <th className="w-36 px-3 py-2 text-right">Right rate (₹)</th>
            </tr>
          </thead>
          <tbody>
            {doc.lines.map((l) => (
              <tr key={l.id} className="border-border border-t">
                <td className="text-muted-foreground px-3 py-1.5 tabular-nums">{l.rowNo}</td>
                <td className="px-2 py-1.5">
                  <span className="font-mono text-xs text-teal-400">{l.item.code}</span> {l.item.name}
                  <span className="text-muted-foreground text-xs">{[l.size?.code && `size ${l.size.code}`, l.lotNo && `lot ${l.lotNo}`, l.warehouse.name].filter(Boolean).map((x) => ` · ${x}`).join('')}</span>
                </td>
                <td className="px-2 py-1.5 text-right tabular-nums">
                  {num(Number(l.qty))} {l.item.uom?.symbol ?? ''}
                </td>
                <td className="px-2 py-1.5">
                  <StepInput className="form-input h-8 text-right" value={edits[l.id]?.qty ?? ''} decimals onValueChange={(v) => set(l.id, { qty: v })} placeholder="Same" aria-label={`Right quantity, row ${l.rowNo}`} />
                </td>
                <td className="px-2 py-1.5 text-right tabular-nums">{l.valuationPending ? <span className="badge-warning text-[10px]">Pending</span> : money(Number(l.unitRate))}</td>
                <td className="px-3 py-1.5">
                  <StepInput className="form-input h-8 text-right" value={edits[l.id]?.rate ?? ''} decimals onValueChange={(v) => set(l.id, { rate: v })} placeholder="Same" aria-label={`Right rate, row ${l.rowNo}`} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <label className="block space-y-1.5">
        <span className="text-foreground text-xs font-semibold">
          Why <span className="text-primary">*</span>
        </span>
        <input className="form-input" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Recounted, wrong rate on the sheet…" aria-label="Why it is corrected" />
      </label>
      {error && (
        <p className="text-sm text-red-400" role="alert">
          {error}
        </p>
      )}
      <div className="flex items-center justify-between gap-2">
        <span className="text-muted-foreground text-xs">{changed.length ? `${changed.length} ${changed.length === 1 ? 'line' : 'lines'} to correct` : 'Nothing changed yet'}</span>
        <div className="flex gap-2">
          <button type="button" className="btn-secondary" disabled={busy} onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="btn-primary" disabled={busy || !changed.length || reason.trim().length < 3} onClick={() => onSend(reason.trim(), changed)}>
            {busy && <Loader2 size={14} className="animate-spin" />} Ask for the correction
          </button>
        </div>
      </div>
    </Modal>
  )
}

function ReasonDialog({ title, text, label, action, busy, error, onClose, onSend }: { title: string; text: string; label: string; action: string; busy: boolean; error: string | null; onClose: () => void; onSend: (reason: string) => void }) {
  const [reason, setReason] = useState('')
  return (
    <Modal title={title} onClose={() => !busy && onClose()}>
      <p className="text-muted-foreground text-sm">{text}</p>
      <label className="block space-y-1.5">
        <span className="text-foreground text-xs font-semibold">
          {label} <span className="text-primary">*</span>
        </span>
        <input className="form-input" value={reason} onChange={(e) => setReason(e.target.value)} aria-label={label} autoFocus />
      </label>
      {error && (
        <p className="text-sm text-red-400" role="alert">
          {error}
        </p>
      )}
      <div className="flex justify-end gap-2">
        <button type="button" className="btn-secondary" disabled={busy} onClick={onClose}>
          Cancel
        </button>
        <button type="button" className="btn-primary" disabled={busy || reason.trim().length < 3} onClick={() => onSend(reason.trim())}>
          {busy && <Loader2 size={14} className="animate-spin" />} {action}
        </button>
      </div>
    </Modal>
  )
}

function Modal({ title, wide, onClose, children }: { title: string; wide?: boolean; onClose: () => void; children: React.ReactNode }) {
  useEscape(onClose)
  return createPortal(
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 p-3 backdrop-blur-sm sm:left-[var(--sidebar-current-width)]">
      <div className={cn('glass-card flex max-h-full w-full flex-col gap-4 overflow-auto p-5', wide ? 'max-w-4xl' : 'max-w-lg')} role="dialog" aria-modal="true" aria-label={title}>
        <div className="flex items-start justify-between gap-3">
          <h2 className="text-foreground text-lg font-semibold">{title}</h2>
          <button type="button" className="text-muted-foreground hover:text-foreground" onClick={onClose} aria-label="Close">
            <X size={18} />
          </button>
        </div>
        {children}
      </div>
    </div>,
    document.body,
  )
}
