'use client'

import { useEffect, useState } from 'react'
import { ArrowRight, Send } from 'lucide-react'
import { api, type Paginated } from '@/lib/api'
import { FormFrame } from '@/components/ui/FormFrame'
import { SmartSelect } from '@/components/ui/SmartSelect'
import { SendOnDialog } from './SendOnDialog'
import { sendsFromHand, useJobCard } from './useFlow'
import { pcs } from './types'

/**
 * A new process transfer from the transfers list: pick the job card and the
 * department sending, and the form for that handover opens — to the next
 * stage of the job card's route, never anywhere else.
 */
export function NewTransferDialog({ onClose, onSaved }: { onClose: () => void; onSaved: (message: string, transferId: string) => void }) {
  const [cards, setCards] = useState<Array<{ id: string; jobCardNumber: string; moLine: { color: string; style: { code: string } }; mo: { moNumber: string } }>>([])
  const [jobCardId, setJobCardId] = useState('')
  const [fromStepId, setFromStepId] = useState('')
  const [go, setGo] = useState(false)
  const { detail: d } = useJobCard(jobCardId || null)

  useEffect(() => {
    void api
      .get<Paginated<(typeof cards)[number]>>('/production/job-cards?show=open&limit=200')
      .then((res) => setCards(res.data))
      .catch(() => setCards([]))
  }, [])

  // Departments with something they can send on.
  const senders = (d?.steps ?? []).filter((s) => s.next && s.figures && s.figures.waiting + (sendsFromHand(s) ? s.figures.inHand : 0) > 0)
  useEffect(() => {
    setFromStepId(senders[0]?.id ?? '')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [d])

  if (go && d && fromStepId) return <SendOnDialog flow={d} fromStepId={fromStepId} onClose={onClose} onSaved={onSaved} />

  const from = senders.find((s) => s.id === fromStepId)
  return (
    <FormFrame
      icon={Send}
      title="New process transfer"
      subtitle="Pick the job card and the department sending; the pieces go to the next stage of its route"
      width="max-w-2xl"
      primary={
        <button type="button" className="btn-primary" disabled={!d || !fromStepId} onClick={() => setGo(true)}>
          <ArrowRight size={15} /> Next
        </button>
      }
      footer={
        <button type="button" className="btn-secondary" onClick={onClose}>
          Cancel
        </button>
      }
      footerNote={jobCardId && d && !senders.length ? <span className="warn-text">Nothing on this job card is ready to send on.</span> : undefined}
      onClose={onClose}
    >
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <label className="block">
          <span className="form-label">Job card</span>
          <SmartSelect className="form-input" value={jobCardId} onChange={(e) => setJobCardId(e.target.value)}>
            <option value="">Pick the job card…</option>
            {cards.map((c) => (
              <option key={c.id} value={c.id} data-sub={`${c.mo.moNumber} · ${c.moLine.style.code} ${c.moLine.color}`}>
                {c.jobCardNumber}
              </option>
            ))}
          </SmartSelect>
        </label>
        <label className="block">
          <span className="form-label">From department</span>
          <SmartSelect className="form-input" value={fromStepId} onChange={(e) => setFromStepId(e.target.value)} disabled={!senders.length}>
            {!senders.length && <option value="">—</option>}
            {senders.map((s) => (
              <option key={s.id} value={s.id} data-sub={`${pcs(s.figures!.waiting + (sendsFromHand(s) ? s.figures!.inHand : 0))} ready to send on`}>
                {s.name}
              </option>
            ))}
          </SmartSelect>
        </label>
      </div>
      {from && <p className="text-muted-foreground text-xs">From {from.name}: on the next screen, pick the step they go to.</p>}
    </FormFrame>
  )
}
