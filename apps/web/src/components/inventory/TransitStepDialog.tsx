'use client'

import { useMemo, useRef, useState } from 'react'
import { Loader2, PackageCheck, Undo2, Ban, Package, CalendarDays } from 'lucide-react'
import { api, apiErrorMessage } from '@/lib/api'
import { newRequestId } from '@/lib/utils'
import { useQtyRules } from '@/lib/qtyRules'
import { FormFrame } from '@/components/ui/FormFrame'
import { Section } from '@/components/purchase/Section'
import { StepInput } from '@/components/ui/StepInput'
import { QtyProblem } from '@/components/ui/QtyProblem'

/**
 * One step with goods sent in transit: the store they went to receives what
 * arrived (good, and damaged — held as rejected), or what did not arrive is
 * sent back to the store it left, or written off as lost by a store manager.
 * Each line starts at what is still on the way; what is not entered stays on
 * the road for a later step.
 */

export type TransitStep = 'receive' | 'send-back' | 'write-off'

export interface TransitLine {
  id: string
  qty: string | number
  receivedQty?: string | number
  damagedQty?: string | number
  returnedQty?: string | number
  lostQty?: string | number
  item: { id: string; code: string; name: string; uom: { symbol: string } | null; decimalPlaces?: number | null }
  ownership?: 'OWNED' | 'CUSTOMER_OWNED'
  ownerCustomer?: { id: string; name: string } | null
  size?: { id: string; code: string } | null
}

export interface TransitTransfer {
  id: string
  transferNumber: string
  fromWarehouse: { id: string; name: string }
  toWarehouse: { id: string; name: string }
  transitWarehouse?: { id: string; name: string } | null
  lines: TransitLine[]
}

/** What of a line is still on the road. */
export const onTheWay = (l: TransitLine) =>
  Math.round(
    (Number(l.qty) - Number(l.receivedQty ?? 0) - Number(l.damagedQty ?? 0) - Number(l.returnedQty ?? 0) - Number(l.lostQty ?? 0)) * 1000,
  ) / 1000

const COPY: Record<TransitStep, { title: (t: TransitTransfer) => string; blurb: (t: TransitTransfer) => string; action: string; qtyLabel: string }> = {
  receive: {
    title: (t) => `Receive ${t.transferNumber}`,
    blurb: (t) =>
      `What arrived at ${t.toWarehouse.name}. Good goods go into stock as they left; damaged ones are held there as rejected. Anything not entered stays on the way.`,
    action: 'Receive it',
    qtyLabel: 'Arrived good',
  },
  'send-back': {
    title: (t) => `Send back on ${t.transferNumber}`,
    blurb: (t) => `What did not arrive goes back into ${t.fromWarehouse.name}, at what it left at.`,
    action: 'Send it back',
    qtyLabel: 'Goes back',
  },
  'write-off': {
    title: (t) => `Write off on ${t.transferNumber}`,
    blurb: () => 'What was lost on the way leaves stock at what it left at. Say what happened; this needs a store manager.',
    action: 'Write it off',
    qtyLabel: 'Lost',
  },
}

const fmt = (n: number) => n.toLocaleString('en-IN', { maximumFractionDigits: 3 })

export function TransitStepDialog({
  transfer,
  step,
  onClose,
  onDone,
}: {
  transfer: TransitTransfer
  step: TransitStep
  onClose: () => void
  onDone: (message: string) => void
}) {
  const copy = COPY[step]
  const open = useMemo(() => transfer.lines.filter((l) => onTheWay(l) > 0.0005), [transfer.lines])
  const [qty, setQty] = useState<Record<string, string>>(() => Object.fromEntries(open.map((l) => [l.id, String(onTheWay(l))])))
  const [damaged, setDamaged] = useState<Record<string, string>>({})
  const [date, setDate] = useState('')
  const [notes, setNotes] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const qtyRules = useQtyRules()
  // One id until it saves: a double click or a retry receives once.
  const requestId = useRef(newRequestId())

  const save = async () => {
    setError(null)
    if (step === 'write-off' && notes.trim().length < 5) return setError('Say what happened to it — one line is enough.')
    const lines = open
      .map((l) => ({ lineId: l.id, qty: Number(qty[l.id] || 0), damagedQty: step === 'receive' ? Number(damaged[l.id] || 0) : undefined, l }))
      .filter((x) => x.qty > 0 || (x.damagedQty ?? 0) > 0)
    if (!lines.length) return setError('Enter how much on at least one line.')
    for (const x of lines) {
      const left = onTheWay(x.l)
      if (x.qty + (x.damagedQty ?? 0) > left + 0.0005) {
        return setError(`${x.l.item.name}: only ${fmt(left)} ${x.l.item.uom?.symbol ?? ''} is still on the way.`)
      }
      const problem = qtyRules.placesProblem(qty[x.l.id] ?? '', x.l.item) || (step === 'receive' ? qtyRules.placesProblem(damaged[x.l.id] ?? '', x.l.item) : null)
      if (problem) return setError(`${x.l.item.name}: ${problem}`)
    }
    setSaving(true)
    try {
      const body =
        step === 'receive'
          ? { requestId: requestId.current, receivedAt: date || undefined, notes: notes.trim() || null, lines: lines.map((x) => ({ lineId: x.lineId, qty: x.qty, damagedQty: x.damagedQty ?? 0 })) }
          : step === 'send-back'
            ? { requestId: requestId.current, date: date || undefined, notes: notes.trim() || null, lines: lines.map((x) => ({ lineId: x.lineId, qty: x.qty })) }
            : { requestId: requestId.current, date: date || undefined, reason: notes.trim(), lines: lines.map((x) => ({ lineId: x.lineId, qty: x.qty })) }
      const res = await api.post<{ message?: string }>(`/inventory/transfers/${transfer.id}/${step}`, body)
      requestId.current = newRequestId()
      onDone(res.message ?? 'Saved.')
    } catch (err) {
      setError(apiErrorMessage(err))
    } finally {
      setSaving(false)
    }
  }

  const Icon = step === 'receive' ? PackageCheck : step === 'send-back' ? Undo2 : Ban

  return (
    <FormFrame
      icon={Icon}
      title={copy.title(transfer)}
      subtitle={copy.blurb(transfer)}
      primary={
        <button type="button" className={step === 'write-off' ? 'btn-danger' : 'btn-primary'} onClick={() => void save()} disabled={saving}>
          {saving ? <Loader2 size={15} className="animate-spin" /> : <Icon size={15} />}
          {copy.action}
        </button>
      }
      footer={
        <button type="button" className="btn-secondary" onClick={onClose} disabled={saving}>
          Cancel
        </button>
      }
      error={error}
      onClose={onClose}
      busy={saving}
    >
      <Section icon={CalendarDays} title={step === 'receive' ? 'Received' : step === 'send-back' ? 'Sent back' : 'Written off'}>
        <div className="grid grid-cols-1 gap-x-4 gap-y-3 sm:grid-cols-3">
          <label className="block min-w-0">
            <span className="form-label">{step === 'receive' ? 'Arrived on' : 'Dated'}</span>
            <input type="date" className="form-input" value={date} onChange={(e) => setDate(e.target.value)} aria-label="Date" />
          </label>
          <label className="block min-w-0 sm:col-span-2">
            <span className="form-label">
              {step === 'write-off' ? (
                <>
                  What happened<span className="ml-0.5 text-red-500">*</span>
                </>
              ) : (
                'Note'
              )}
            </span>
            <input
              className="form-input placeholder:text-muted-foreground/60"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder={step === 'receive' ? 'e.g. Two rolls wet, vehicle MH-12-AB-1234' : step === 'send-back' ? 'e.g. Did not fit on the vehicle' : 'e.g. Fell off the vehicle; police complaint filed'}
              autoFocus
            />
          </label>
        </div>
      </Section>

      <Section icon={Package} title="Items on the way">
        <div className="overflow-x-auto">
          <table className="line-table w-full min-w-[640px] text-sm">
            <thead>
              <tr>
                <th style={{ width: 36 }}>#</th>
                <th>Item</th>
                <th style={{ textAlign: 'right' }}>On the way</th>
                <th style={{ textAlign: 'right' }}>{copy.qtyLabel}</th>
                {step === 'receive' && <th style={{ textAlign: 'right' }}>Damaged</th>}
              </tr>
            </thead>
            <tbody data-grid>
              {open.map((l, i) => {
                const unit = l.item.uom?.symbol ?? ''
                const whose = [l.ownership === 'CUSTOMER_OWNED' ? `${l.ownerCustomer?.name ?? 'Customer'}'s` : null, l.size ? `size ${l.size.code}` : null].filter(Boolean).join(' · ')
                return (
                  <tr key={l.id} data-grid-row>
                    <td className="text-muted-foreground px-3 py-2 text-xs">{i + 1}</td>
                    <td className="px-3 py-2">
                      <div className="text-foreground text-xs">
                        <span className="text-muted-foreground font-mono">{l.item.code}</span> {l.item.name}
                      </div>
                      {whose && <div className="text-muted-foreground text-[10px]">{whose}</div>}
                    </td>
                    <td className="whitespace-nowrap px-3 py-2 text-right text-xs tabular-nums">
                      {fmt(onTheWay(l))} {unit}
                    </td>
                    <td className="px-3 py-2 text-right">
                      <div className="flex items-center justify-end gap-2">
                        <StepInput
                          decimals
                          className="form-input h-9 w-28 text-right tabular-nums"
                          value={qty[l.id] ?? ''}
                          onValueChange={(v) => setQty((q) => ({ ...q, [l.id]: v }))}
                          aria-label={`${copy.qtyLabel} on line ${i + 1}`}
                        />
                        <span className="text-muted-foreground w-8 text-left text-xs">{unit}</span>
                      </div>
                      <QtyProblem className="ml-auto max-w-[14rem] text-right" text={qtyRules.placesProblem(qty[l.id] ?? '', l.item)} />
                    </td>
                    {step === 'receive' && (
                      <td className="px-3 py-2 text-right">
                        <div className="flex items-center justify-end gap-2">
                          <StepInput
                            decimals
                            className="form-input h-9 w-24 text-right tabular-nums"
                            value={damaged[l.id] ?? ''}
                            onValueChange={(v) => {
                              // Damaged comes out of what arrived good, so the two still add up to what came.
                              const was = Number(damaged[l.id] || 0)
                              const now = Number(v || 0)
                              setDamaged((d) => ({ ...d, [l.id]: v }))
                              setQty((q) => ({ ...q, [l.id]: String(Math.max(0, Math.round((Number(q[l.id] || 0) + was - now) * 1000) / 1000)) }))
                            }}
                            aria-label={`Damaged on line ${i + 1}`}
                          />
                          <span className="text-muted-foreground w-8 text-left text-xs">{unit}</span>
                        </div>
                        <QtyProblem className="ml-auto max-w-[14rem] text-right" text={qtyRules.placesProblem(damaged[l.id] ?? '', l.item)} />
                      </td>
                    )}
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </Section>
    </FormFrame>
  )
}
