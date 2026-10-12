'use client'

import { useMemo, useState } from 'react'
import { Loader2, Scale } from 'lucide-react'
import { api, ApiError, can } from '@/lib/api'
import { FormFrame } from '@/components/ui/FormFrame'
import { Section } from '@/components/purchase/Section'
import { BundleQtyTable, overRows, type QtyColumn, type QtyValues } from './BundleQtyTable'
import { newClientKey, pcs, type FlowTransfer } from './types'

/**
 * Settling what a card came up short: pieces found after all go to the
 * receiving desk; pieces that never left go back to the sender; pieces lost
 * are written off — that needs a production manager. Whatever is not settled
 * stays short.
 */
export function SettleDialog({ transfer, onClose, onSaved }: { transfer: FlowTransfer; onClose: () => void; onSaved: (message: string) => void }) {
  const manager = can('production', 'approve')
  const rows = useMemo(
    () =>
      transfer.lines
        .map((l) => ({ id: l.id, code: l.bundle.code, size: l.bundle.size?.code ?? null, line: null, available: l.shortQty - l.settledQty }))
        .filter((r) => r.available > 0),
    [transfer],
  )
  const columns: QtyColumn[] = [
    { key: 'FOUND', label: 'Found' },
    { key: 'NOT_SENT', label: 'Never sent' },
    ...(manager ? [{ key: 'LOST', label: 'Written off', bad: true }] : []),
  ]
  const [values, setValues] = useState<QtyValues>({})
  const [reason, setReason] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [clientKey] = useState(newClientKey)

  const lines = rows.flatMap((r) => columns.map((c) => ({ lineId: r.id, outcome: c.key, qty: Number(values[r.id]?.[c.key]) || 0 })).filter((l) => l.qty > 0))
  const over = overRows(rows, values, columns)
  const blocker = !lines.length ? 'Enter how many were found, never sent, or lost.' : over.length ? `${over[0].code} is only ${over[0].available} short.` : reason.trim().length < 5 ? 'Say what happened, in a few words.' : null

  const save = async () => {
    if (blocker) return
    setSaving(true)
    setError(null)
    try {
      const res = await api.post<{ message?: string }>(`/production/transfers/${transfer.id}/settle`, { lines, reason: reason.trim(), clientKey })
      onSaved(res.message ?? 'Settled.')
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not settle it.')
    } finally {
      setSaving(false)
    }
  }

  const open = rows.reduce((s, r) => s + r.available, 0)
  return (
    <FormFrame
      icon={Scale}
      title={`Settle ${transfer.transferNumber}`}
      subtitle={`${pcs(open)} pieces short between ${transfer.fromStep.name} and ${transfer.toStep.name}.`}
      width="max-w-3xl"
      primary={
        <button type="button" className="btn-primary" onClick={() => void save()} disabled={saving || !!blocker}>
          {saving ? <Loader2 size={15} className="animate-spin" /> : <Scale size={15} />} Settle
        </button>
      }
      footer={
        <button type="button" className="btn-secondary" onClick={onClose} disabled={saving}>
          Cancel
        </button>
      }
      footerNote={blocker ? <span className="warn-text">{blocker}</span> : manager ? null : 'Writing pieces off needs a production manager.'}
      error={error}
      onClose={onClose}
      busy={saving}
    >
      <Section icon={Scale} title="What happened to them">
        <BundleQtyTable rows={rows} columns={columns} values={values} onChange={(row, col, v) => setValues((x) => ({ ...x, [row]: { ...x[row], [col]: v } }))} availableLabel="Short" empty="Nothing on this card is short." />
        <label className="mt-3 block">
          <span className="form-label">What happened</span>
          <input className="form-input" value={reason} maxLength={500} placeholder="Three found under the cutting table; two not found anywhere" onChange={(e) => setReason(e.target.value)} />
        </label>
      </Section>
    </FormFrame>
  )
}
