'use client'

import { useMemo, useState } from 'react'
import { ArrowLeftRight, Boxes, ClipboardCheck, Loader2, Plus, Trash2 } from 'lucide-react'
import { api, ApiError } from '@/lib/api'
import { formatDate } from '@/lib/utils'
import { FormFrame } from '@/components/ui/FormFrame'
import { Section } from '@/components/purchase/Section'
import { SmartSelect } from '@/components/ui/SmartSelect'
import { StepInput } from '@/components/ui/StepInput'
import { BundleQtyTable, type QtyValues } from './BundleQtyTable'
import { bundleShort, newClientKey, pcs, type FlowTransfer } from './types'

/**
 * Counting a transfer card in at the receiving desk. What was sent is kept as
 * the sender wrote it; what is counted is recorded beside it. More than was
 * sent is taken off the sender's count (they miscounted). Closing says
 * nothing more is coming: what has not been counted in is held as short until
 * somebody settles it — found, never sent, or written off.
 *
 * Counting in at stitching on our own floor (the caller passes the job card's
 * sizes), pieces that will be made as another size can be recorded with the
 * count: saved together, by the same rules as Change sizes on the sheet.
 */
export function CountInDialog({
  transfer,
  moNumber,
  sizes,
  onClose,
  onSaved,
}: {
  transfer: FlowTransfer
  moNumber: string
  /** The job card's sizes, when this is a count-in at stitching on our own floor; null otherwise. */
  sizes?: Array<{ id: string; code: string }> | null
  onClose: () => void
  onSaved: (message: string) => void
}) {
  const rows = useMemo(
    () =>
      transfer.lines
        .map((l) => ({
          id: l.id,
          code: l.bundle.code,
          size: l.bundle.size?.code ?? null,
          line: null,
          available: l.dispatchedQty + l.excessQty - l.receivedQty - l.shortQty,
          note: l.receivedQty ? `${l.receivedQty} of ${l.dispatchedQty} already counted` : null,
        }))
        .filter((r) => r.available > 0),
    [transfer],
  )
  // Starts at what was sent: the receiver changes only what differs.
  const [values, setValues] = useState<QtyValues>(() => Object.fromEntries(rows.map((r) => [r.id, { qty: String(r.available) }])))
  const [close, setClose] = useState(false)
  const [receivedBy, setReceivedBy] = useState('')
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10))
  const [notes, setNotes] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [clientKey] = useState(newClientKey)
  // Size jumps recorded with the count: a bundle on the card, the size its pieces are made as, how many.
  const [jumps, setJumps] = useState<Array<{ key: number; lineId: string; toSizeId: string; qty: string }>>([])
  const [reason, setReason] = useState('')
  /** Save was pressed with something missing: marked from then on. */
  const [tried, setTried] = useState(false)
  const offerSizes = !!sizes && sizes.length > 1 && !transfer.vendor

  const counted = rows.map((r) => ({ lineId: r.id, qty: Number(values[r.id]?.qty) || 0 }))
  const total = counted.reduce((s, l) => s + l.qty, 0)
  const pending = rows.reduce((s, r) => s + r.available, 0)
  const shortBy = rows.reduce((s, r) => s + Math.max(0, r.available - (Number(values[r.id]?.qty) || 0)), 0)
  const overBy = rows.reduce((s, r) => s + Math.max(0, (Number(values[r.id]?.qty) || 0) - r.available), 0)
  const countedOf = (lineId: string) => Number(values[lineId]?.qty) || 0
  const setJump = (key: number, patch: Partial<{ lineId: string; toSizeId: string; qty: string }>) => setJumps((js) => js.map((j) => (j.key === key ? { ...j, ...patch } : j)))
  const addJump = () => setJumps((js) => [...js, { key: Date.now() + js.length, lineId: '', toSizeId: '', qty: '' }])
  /** What is wrong with one size change, if anything. */
  const jumpProblem = (j: { lineId: string; toSizeId: string; qty: string }) => {
    if (!j.lineId) return 'Pick the bundle.'
    if (!j.toSizeId) return 'Pick the size its pieces are made as.'
    const q = Number(j.qty) || 0
    if (q <= 0) return 'Say how many pieces.'
    const taken = jumps.filter((x) => x.lineId === j.lineId).reduce((s, x) => s + (Number(x.qty) || 0), 0)
    if (taken > countedOf(j.lineId)) return `Only ${pcs(countedOf(j.lineId))} pcs of this bundle are counted in.`
    return null
  }
  const sizeBlocker = jumps.length
    ? jumps.some((j) => jumpProblem(j))
      ? 'Finish each size change below, or take it off.'
      : reason.trim().length < 5
        ? 'Say why the pieces are made as another size.'
        : null
    : null
  const blocker = !total && !close ? 'Enter what was counted in, or close it as short.' : sizeBlocker

  const save = async () => {
    if (blocker) {
      setTried(true)
      return
    }
    setSaving(true)
    setError(null)
    try {
      const res = await api.post<{ message?: string }>(`/production/transfers/${transfer.id}/receive`, {
        lines: counted.filter((l) => l.qty > 0),
        close,
        receivedBy: receivedBy.trim() || null,
        receivedAt: date,
        notes: notes.trim() || null,
        clientKey,
        ...(jumps.length
          ? {
              sizeChanges: {
                lines: jumps.map((j) => ({ bundleId: transfer.lines.find((l) => l.id === j.lineId)!.bundle.id, toSizeId: j.toSizeId, qty: Number(j.qty) || 0 })),
                reason: reason.trim(),
              },
            }
          : {}),
      })
      onSaved(res.message ?? 'Counted in.')
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not count it in.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <FormFrame
      icon={ClipboardCheck}
      // Named for where the pieces are counted in. The card's number begins with the department that
      // sent it (FUS/… from Fusing), so on its own it read as if the count were at the sending end.
      title={`Count in at ${transfer.toStep.name}`}
      subtitle={`Card ${transfer.transferNumber} from ${transfer.fromStep.name} · ${moNumber} · sent ${formatDate(transfer.dispatchDate)}${transfer.issuedBy ? ` by ${transfer.issuedBy}` : ''}`}
      width="max-w-3xl"
      primary={
        <button type="button" className="btn-primary" onClick={() => void save()} disabled={saving} title={blocker ?? undefined}>
          {saving ? <Loader2 size={15} className="animate-spin" /> : <ClipboardCheck size={15} />} Count in {total ? `${pcs(total)} pcs` : ''}
        </button>
      }
      footer={
        <button type="button" className="btn-secondary" onClick={onClose} disabled={saving}>
          Cancel
        </button>
      }
      footerNote={
        blocker ? (
          <span className="warn-text">{blocker}</span>
        ) : overBy ? (
          <span className="text-primary">{pcs(overBy)} more than was sent — taken off {transfer.fromStep.name}&apos;s count.</span>
        ) : shortBy ? (
          close ? (
            <span className="warn-text">{pcs(shortBy)} short — held until settled.</span>
          ) : (
            `${pcs(shortBy)} still to come.`
          )
        ) : (
          `All ${pcs(pending)} counted.`
        )
      }
      error={error}
      onClose={onClose}
      busy={saving}
    >
      {/* Who counted, when, and whether more is coming — first, as the sending window has its own. */}
      <Section icon={ClipboardCheck} title={`Counting in at ${transfer.toStep.name}`}>
        <div className="grid grid-cols-1 gap-x-4 gap-y-3 sm:grid-cols-3">
          <label className="block">
            <span className="form-label">Counted on</span>
            <input type="date" className="form-input" value={date} onChange={(e) => setDate(e.target.value)} />
          </label>
          <label className="block">
            <span className="form-label">Received by</span>
            <input className="form-input" value={receivedBy} maxLength={120} placeholder="Who counted them" onChange={(e) => setReceivedBy(e.target.value)} />
          </label>
          <label className="block">
            <span className="form-label">Note</span>
            <input className="form-input" value={notes} maxLength={1000} onChange={(e) => setNotes(e.target.value)} />
          </label>
        </div>
        <label className="mt-3 flex items-start gap-2 text-xs">
          <input type="checkbox" className="accent-primary mt-0.5" checked={close} onChange={(e) => setClose(e.target.checked)} />
          <span>
            Nothing more is coming on this card. What has not been counted in is <strong>short</strong>, and waits to be settled — found later, never sent, or written off by a manager.
          </span>
        </label>
      </Section>
      <Section icon={Boxes} title="Counted at the desk">
        <BundleQtyTable
          rows={rows}
          columns={[{ key: 'qty', label: 'Counted' }]}
          values={values}
          onChange={(row, col, v) => setValues((x) => ({ ...x, [row]: { ...x[row], [col]: v } }))}
          availableLabel="Sent, not counted"
          fill={{ label: 'As sent', column: 'qty' }}
          allowOver
          empty="Everything on this card has been counted in."
        />
      </Section>
      {offerSizes && (
        <Section icon={ArrowLeftRight} title="Made as another size">
          <p className="text-muted-foreground text-xs">
            Optional. Pieces counted in here that will be made as another size of the order. Each bundle&apos;s become a new bundle of that size, with its own
            sticker. It can also be done later, from Change sizes on the Stitching sheet.
          </p>
          {jumps.length > 0 && (
            <div className="mt-3 space-y-2">
              {jumps.map((j, i) => {
                const row = rows.find((r) => r.id === j.lineId)
                const wrong = tried ? jumpProblem(j) : null
                return (
                  <div key={j.key}>
                    <div className="grid grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)_6.5rem_auto] items-center gap-2">
                      <SmartSelect
                        className={`form-input h-9 ${wrong && !j.lineId ? 'border-red-500/70' : ''}`}
                        value={j.lineId}
                        onChange={(e) => setJump(j.key, { lineId: e.target.value, toSizeId: '' })}
                        aria-label={`Size change ${i + 1}: bundle`}
                      >
                        <option value="">Bundle…</option>
                        {rows
                          .filter((r) => r.size && countedOf(r.id) > 0)
                          .map((r) => (
                            <option key={r.id} value={r.id} data-sub={`${countedOf(r.id)} counted in`}>
                              {bundleShort(r.code)} · size {r.size}
                            </option>
                          ))}
                      </SmartSelect>
                      <SmartSelect
                        className={`form-input h-9 ${wrong && j.lineId && !j.toSizeId ? 'border-red-500/70' : ''}`}
                        value={j.toSizeId}
                        onChange={(e) => setJump(j.key, { toSizeId: e.target.value })}
                        aria-label={`Size change ${i + 1}: made as`}
                        disabled={!row}
                      >
                        <option value="">Made as…</option>
                        {(sizes ?? [])
                          .filter((z) => z.code !== row?.size)
                          .map((z) => (
                            <option key={z.id} value={z.id}>
                              size {z.code}
                            </option>
                          ))}
                      </SmartSelect>
                      <StepInput
                        className={`form-input h-9 text-right tabular-nums ${wrong && j.lineId && j.toSizeId ? 'border-red-500/70' : ''}`}
                        value={j.qty}
                        placeholder="Pieces"
                        onValueChange={(v) => setJump(j.key, { qty: v })}
                        aria-label={`Size change ${i + 1}: pieces`}
                      />
                      <button
                        type="button"
                        className="btn-ghost text-muted-foreground hover:text-destructive p-1.5"
                        onClick={() => setJumps((js) => js.filter((x) => x.key !== j.key))}
                        aria-label={`Remove size change ${i + 1}`}
                      >
                        <Trash2 size={14} />
                      </button>
                    </div>
                    {wrong && <p className="mt-1 text-[11px] font-medium text-red-500">{wrong}</p>}
                  </div>
                )
              })}
              <label className="block">
                <span className="form-label">
                  Why <span className="text-red-400">*</span>
                </span>
                <input
                  className={`form-input ${tried && reason.trim().length < 5 ? 'border-red-500/70' : ''}`}
                  value={reason}
                  maxLength={500}
                  placeholder="e.g. Buyer asked for more L; M pieces cut long"
                  onChange={(e) => setReason(e.target.value)}
                />
                {tried && reason.trim().length < 5 && <span className="mt-1 block text-[11px] font-medium text-red-500">Say why, in a few words.</span>}
              </label>
            </div>
          )}
          <button type="button" className="btn-secondary mt-3 h-8 px-3 text-xs" onClick={addJump}>
            <Plus size={13} /> {jumps.length ? 'Another bundle' : 'Some pieces will be made as another size'}
          </button>
        </Section>
      )}
    </FormFrame>
  )
}
