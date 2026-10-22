'use client'

import { useEffect, useState } from 'react'
import { ClipboardCheck, Factory, Printer, Scissors, Shirt } from 'lucide-react'
import { FormFrame } from '@/components/ui/FormFrame'
import { CuttingSheet } from './CuttingSheet'
import { StageSheet } from './StageSheet'
import { useJobCard } from './useFlow'
import { RouteStrip } from './RouteStrip'
import { isCheck, pcs } from './types'

/**
 * One job card's sheet for one stage, with its whole route along the top —
 * each stage saying where the pieces are there — and every other sheet a
 * click away on it. The cutting sheet and the departments' sheets are worked
 * from here.
 */
export function SheetView({
  jobCardId,
  stepId,
  onClose,
  onChanged,
}: {
  jobCardId: string
  /** The stage to open at; the first one with work waiting when left out. */
  stepId?: string | null
  onClose: () => void
  onChanged?: (message: string) => void
}) {
  const { detail: d, error, reload } = useJobCard(jobCardId)
  const [current, setCurrent] = useState<string | null>(stepId ?? null)
  const [message, setMessage] = useState<string | null>(null)

  useEffect(() => {
    if (!d || current) return
    const busy = d.steps.find((s) => s.figures && s.figures.inTransit + s.figures.inHand + s.figures.waiting + s.figures.atVendor > 0)
    setCurrent((busy ?? d.steps[0])?.id ?? null)
  }, [d, current])

  const step = d?.steps.find((s) => s.id === current) ?? null
  const changed = (m: string) => {
    setMessage(m)
    onChanged?.(m)
    void reload()
  }
  const icon = !step ? Factory : step.kind === 'CUTTING' ? Scissors : isCheck(step) ? ClipboardCheck : Shirt
  return (
    <FormFrame
      icon={icon}
      title={step ? `${step.name} sheet` : 'Process sheet'}
      subtitle={d ? `${d.card.jobCardNumber} · ${d.line?.style.code} ${d.line?.color} · ${pcs(d.line?.totalQty ?? 0)} pcs · ${d.mo.moNumber}${d.mo.so ? ` · ${d.mo.so.customer.name}` : ''}` : undefined}
      width="max-w-7xl"
      primary={
        <button
          type="button"
          className="btn-secondary"
          disabled={!step}
          onClick={() => window.open(`/print/sheet/${jobCardId}?step=${step?.id ?? ''}`, '_blank', 'noopener')}
        >
          <Printer size={15} /> Print sheet
        </button>
      }
      footer={
        <button type="button" className="btn-secondary" onClick={onClose}>
          Close
        </button>
      }
      footerNote={d?.mo.held ? <span className="warn-text">{d.mo.moNumber} is on hold: nothing can be recorded until it is resumed.</span> : undefined}
      error={error}
      onClose={onClose}
    >
      {!d ? (
        <div className="skeleton h-72 w-full rounded-xl" />
      ) : (
        <>
          <RouteStrip
            steps={d.steps.map((s) => ({ id: s.id, name: s.name, kind: s.kind, execution: s.execution, skipped: !!s.skippedAt, figures: s.figures }))}
            current={current}
            onPick={setCurrent}
            withCutters={d.cuttings.filter((c) => c.status === 'IN_PROGRESS').reduce((t, c) => t + c.plannedPieces, 0)}
            label={`${d.card.jobCardNumber} route`}
          />
          {message && (
            <div className="border-primary/40 bg-primary/5 rounded-lg border p-2.5">
              <p className="text-primary text-sm">{message}</p>
            </div>
          )}
          {!d.steps.length ? (
            <p className="text-muted-foreground text-sm">{d.mo.moNumber} has no stages yet. Load them on the manufacturing order once its materials are issued.</p>
          ) : step ? (
            step.kind === 'CUTTING' ? (
              <CuttingSheet key={step.id} d={d} step={step} onChanged={changed} />
            ) : (
              <StageSheet key={step.id} d={d} step={step} onChanged={changed} />
            )
          ) : null}
        </>
      )}
    </FormFrame>
  )
}
