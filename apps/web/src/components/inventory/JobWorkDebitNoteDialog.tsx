'use client'

import { useEffect, useState } from 'react'
import { Loader2, FileMinus, Boxes } from 'lucide-react'
import { api, ApiError } from '@/lib/api'
import { FormFrame } from '@/components/ui/FormFrame'
import { Section } from '@/components/purchase/Section'
import { StepInput } from '@/components/ui/StepInput'

/**
 * Charging a job worker for pieces spoiled at their unit.
 *
 * Lists each receipt on the challan with damaged pieces and no debit note
 * yet, with what each piece is charged at — the value it went out at, or a
 * figure agreed with the unit when it was the customer's material (which
 * carries no value of ours). Saving drafts a debit note in Purchase; it moves
 * no stock, and the purchase desk settles its GST and posts it.
 */

interface Challan {
  id: string
  challanNumber: string
  jobWorker: { name: string }
  lines: Array<{ id: string; unitRate: string | number | null; item: { name: string } }>
  returns: Array<{
    id: string
    returnNumber: string
    returnDate: string
    theirChallanNo: string | null
    debitNotes?: Array<{ noteNumber: string }>
    lines: Array<{ id: string; challanLineId: string; damagedQty: string | number; item: { name: string } }>
  }>
}

const fmt = (n: number) => n.toLocaleString('en-IN', { maximumFractionDigits: 2 })

export function JobWorkDebitNoteDialog({ challanId, onClose, onSaved }: { challanId: string; onClose: () => void; onSaved: (message: string) => void }) {
  const [challan, setChallan] = useState<Challan | null>(null)
  const [rates, setRates] = useState<Record<string, string>>({})
  const [gst, setGst] = useState('')
  const [saving, setSaving] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState<string[]>([])

  useEffect(() => {
    api
      .get<{ data: Challan }>(`/inventory/job-work/${challanId}`)
      .then((res) => {
        setChallan(res.data)
        const r: Record<string, string> = {}
        for (const ret of res.data.returns)
          for (const l of ret.lines) {
            const rate = Number(res.data.lines.find((c) => c.id === l.challanLineId)?.unitRate ?? 0)
            r[l.id] = rate > 0 ? String(rate) : ''
          }
        setRates(r)
      })
      .catch((err) => setError(err instanceof ApiError ? err.message : 'Could not open the challan.'))
  }, [challanId])

  const toCharge = (challan?.returns ?? []).filter((r) => r.lines.some((l) => Number(l.damagedQty) > 0) && !r.debitNotes?.length && !done.includes(r.id))

  const raise = async (r: Challan['returns'][number]) => {
    setSaving(r.id)
    setError(null)
    try {
      const damaged = r.lines.filter((l) => Number(l.damagedQty) > 0)
      const res = await api.post<{ message?: string }>(`/inventory/job-work/returns/${r.id}/debit-note`, {
        rates: Object.fromEntries(damaged.map((l) => [l.id, Number(rates[l.id]) || 0])),
        gstRate: gst ? Number(gst) : 0,
      })
      setDone((d) => [...d, r.id])
      onSaved(res.message ?? 'Debit note drafted.')
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not draft the debit note.')
    } finally {
      setSaving(null)
    }
  }

  return (
    <FormFrame
      icon={FileMinus}
      title={`Charge damage${challan ? ` · ${challan.challanNumber}` : ''}`}
      subtitle={`A draft debit note to ${challan?.jobWorker.name ?? 'the job worker'} for pieces spoiled at their unit. It moves no stock; Purchase settles its GST and posts it.`}
      width="max-w-4xl"
      primary={
        <button type="button" className="btn-secondary" onClick={onClose}>
          Done
        </button>
      }
      error={error}
      onClose={onClose}
      busy={saving !== null}
    >
      <Section icon={Boxes} title="Damaged at the unit">
        {!challan ? (
          <div className="skeleton h-24 w-full rounded-lg" />
        ) : toCharge.length === 0 ? (
          <p className="text-muted-foreground text-sm">Every damaged piece on this challan is already charged.</p>
        ) : (
          <div className="space-y-3">
            <label className="flex items-center gap-2 text-xs">
              <span className="text-muted-foreground">GST % on the note</span>
              <StepInput decimals max={28} className="form-input h-8 w-20 text-right tabular-nums" value={gst} placeholder="0" onValueChange={setGst} aria-label="GST on the debit note" />
            </label>
            {toCharge.map((r) => {
              const damaged = r.lines.filter((l) => Number(l.damagedQty) > 0)
              const total = damaged.reduce((s, l) => s + Number(l.damagedQty) * (Number(rates[l.id]) || 0), 0)
              return (
                <div key={r.id} className="border-border rounded-lg border p-3">
                  <div className="mb-2 flex flex-wrap items-center justify-between gap-2 text-sm">
                    <span>
                      <span className="font-mono text-xs">{r.returnNumber}</span>
                      {r.theirChallanNo ? <span className="text-muted-foreground text-xs"> · their challan {r.theirChallanNo}</span> : null}
                    </span>
                    <button type="button" className="btn-primary h-8 px-3 text-xs" onClick={() => void raise(r)} disabled={saving !== null || total <= 0}>
                      {saving === r.id ? <Loader2 size={13} className="animate-spin" /> : <FileMinus size={13} />} Draft debit note · ₹{fmt(total)}
                    </button>
                  </div>
                  <table className="subtable w-full">
                    <tbody>
                      {damaged.map((l) => (
                        <tr key={l.id}>
                          <td className="text-xs">{l.item.name}</td>
                          <td className="text-right text-xs tabular-nums">{Number(l.damagedQty)} damaged ×</td>
                          <td className="w-32">
                            <StepInput
                              decimals
                              className="form-input h-8 text-right text-xs tabular-nums"
                              value={rates[l.id] ?? ''}
                              placeholder="₹ each"
                              onValueChange={(v) => setRates((x) => ({ ...x, [l.id]: v }))}
                              aria-label={`Charge per damaged ${l.item.name}`}
                            />
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {total <= 0 && <p className="warn-text mt-1 text-[11px]">Enter what each damaged piece is charged at — the customer&apos;s material carries no value of ours to take.</p>}
                </div>
              )
            })}
          </div>
        )}
      </Section>
    </FormFrame>
  )
}
