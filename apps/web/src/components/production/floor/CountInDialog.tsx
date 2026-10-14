'use client'

import { useMemo, useState } from 'react'
import { Boxes, ClipboardCheck, Loader2 } from 'lucide-react'
import { api, ApiError } from '@/lib/api'
import { formatDate } from '@/lib/utils'
import { FormFrame } from '@/components/ui/FormFrame'
import { Section } from '@/components/purchase/Section'
import { BundleQtyTable, type QtyValues } from './BundleQtyTable'
import { newClientKey, pcs, type FlowTransfer } from './types'

/**
 * Counting a transfer card in at the receiving desk. What was sent is kept as
 * the sender wrote it; what is counted is recorded beside it. More than was
 * sent is taken off the sender's count (they miscounted). Closing says
 * nothing more is coming: what has not been counted in is held as short until
 * somebody settles it — found, never sent, or written off.
 */
export function CountInDialog({ transfer, moNumber, onClose, onSaved }: { transfer: FlowTransfer; moNumber: string; onClose: () => void; onSaved: (message: string) => void }) {
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

  const counted = rows.map((r) => ({ lineId: r.id, qty: Number(values[r.id]?.qty) || 0 }))
  const total = counted.reduce((s, l) => s + l.qty, 0)
  const pending = rows.reduce((s, r) => s + r.available, 0)
  const shortBy = rows.reduce((s, r) => s + Math.max(0, r.available - (Number(values[r.id]?.qty) || 0)), 0)
  const overBy = rows.reduce((s, r) => s + Math.max(0, (Number(values[r.id]?.qty) || 0) - r.available), 0)
  const blocker = !total && !close ? 'Enter what was counted in, or close it as short.' : null

  const save = async () => {
    if (blocker) return
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
      title={`Count in ${transfer.transferNumber}`}
      subtitle={`${moNumber}: ${transfer.fromStep.name} → ${transfer.toStep.name}, sent ${formatDate(transfer.dispatchDate)}${transfer.issuedBy ? ` by ${transfer.issuedBy}` : ''}`}
      width="max-w-3xl"
      primary={
        <button type="button" className="btn-primary" onClick={() => void save()} disabled={saving || !!blocker}>
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
        <div className="mt-3 grid grid-cols-1 gap-x-4 gap-y-3 sm:grid-cols-3">
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
    </FormFrame>
  )
}
