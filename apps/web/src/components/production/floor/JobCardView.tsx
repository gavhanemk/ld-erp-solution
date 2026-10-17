'use client'

import { useEffect, useState } from 'react'
import { ClipboardList, FileText, Loader2, Printer, Route } from 'lucide-react'
import { api, ApiError, can } from '@/lib/api'
import { FormFrame } from '@/components/ui/FormFrame'
import { Section } from '@/components/purchase/Section'
import { StepInput } from '@/components/ui/StepInput'
import { SheetView } from './SheetView'
import { useJobCard } from './useFlow'
import { pcs, refNo, stageOf } from './types'

/**
 * One job card: a colour (or design) of a manufacturing order, as the floor
 * works it. Its header — order no., project ID, fabric quality, design no.,
 * metres, average, ratio, lot — is what every sheet of it prints, and can be
 * corrected here. Below, its process forms in the order of the route, each
 * with how far the pieces have got, and a click to open the sheet.
 */
export function JobCardView({ jobCardId, onClose, onChanged }: { jobCardId: string; onClose: () => void; onChanged?: (message: string) => void }) {
  const { detail: d, error: loadError, reload } = useJobCard(jobCardId)
  const [form, setForm] = useState<Record<string, string>>({})
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [sheet, setSheet] = useState<string | null>(null)

  useEffect(() => {
    if (!d) return
    const c = d.card
    setForm({
      orderNo: c.orderNo ?? '',
      projectId: c.projectId ?? '',
      description: c.description ?? '',
      fabricQuality: c.fabricQuality ?? '',
      designNo: c.designNo ?? '',
      lotNo: c.lotNo ?? '',
      meters: c.meters != null ? String(c.meters) : '',
      average: c.average != null ? String(c.average) : '',
      ratio: c.ratio ?? '',
      notes: c.notes ?? '',
    })
  }, [d])

  const mayEdit = can('production', 'edit') && d?.mo.status !== 'CLOSED'
  const set = (k: string, v: string) => setForm((f) => ({ ...f, [k]: v }))
  const save = async () => {
    setSaving(true)
    setError(null)
    try {
      const res = await api.patch<{ message?: string }>(`/production/job-cards/${jobCardId}`, {
        ...form,
        meters: form.meters === '' ? null : Number(form.meters),
        average: form.average === '' ? null : Number(form.average),
      })
      setMessage(res.message ?? 'Saved.')
      onChanged?.(res.message ?? 'Saved.')
      void reload()
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save the job card.')
    } finally {
      setSaving(false)
    }
  }

  const field = (key: string, label: string, opts: { span?: number; placeholder?: string; number?: boolean } = {}) => (
    <label className={`block ${opts.span === 2 ? 'sm:col-span-2' : ''}`}>
      <span className="form-label">{label}</span>
      {opts.number ? (
        <StepInput decimals className="form-input text-right tabular-nums" value={form[key] ?? ''} placeholder="0" onValueChange={(v) => set(key, v)} aria-label={label} />
      ) : (
        <input className="form-input" value={form[key] ?? ''} placeholder={opts.placeholder} disabled={!mayEdit} onChange={(e) => set(key, e.target.value)} />
      )}
    </label>
  )

  return (
    <>
      <FormFrame
        icon={ClipboardList}
        title={d ? `Job card ${d.card.jobCardNumber}` : 'Job card'}
        subtitle={d ? `${d.line?.style.code} ${d.line?.color} · ${pcs(d.line?.totalQty ?? 0)} pcs · ${d.mo.moNumber}${d.mo.so ? ` · ${d.mo.so.soNumber} · ${d.mo.so.customer.name}` : ''}` : undefined}
        width="max-w-6xl"
        primary={
          mayEdit ? (
            <button type="button" className="btn-primary" onClick={() => void save()} disabled={saving || !d}>
              {saving ? <Loader2 size={15} className="animate-spin" /> : <FileText size={15} />} Save job card
            </button>
          ) : (
            <span />
          )
        }
        footer={
          <>
            <button type="button" className="btn-secondary" onClick={() => window.open(`/print/job-card/${jobCardId}`, '_blank', 'noopener')}>
              <Printer size={15} /> Print
            </button>
            <button type="button" className="btn-secondary" onClick={onClose} disabled={saving}>
              Close
            </button>
          </>
        }
        footerNote={d ? <span>Ref no. {refNo(d.card)} — printed on every sheet of it.</span> : undefined}
        error={error ?? loadError}
        onClose={onClose}
        busy={saving}
      >
        {!d ? (
          <div className="skeleton h-72 w-full rounded-xl" />
        ) : (
          <>
            {message && (
              <div className="border-primary/40 bg-primary/5 rounded-lg border p-2.5">
                <p className="text-primary text-sm">{message}</p>
              </div>
            )}
            <Section icon={FileText} title="Header">
              <div className="grid grid-cols-1 gap-x-4 gap-y-3 sm:grid-cols-2 lg:grid-cols-4">
                {field('orderNo', 'Order no.', { placeholder: 'LDCM-06' })}
                {field('projectId', 'Project ID', { placeholder: 'DC-46' })}
                {field('description', 'Description', { span: 2, placeholder: 'Formal shirts' })}
                {field('fabricQuality', 'Fabric quality', { span: 2, placeholder: 'Poplin print PS-426A' })}
                {field('designNo', 'Design no.')}
                {field('lotNo', 'Lot no.')}
                {field('meters', 'Metres', { number: true })}
                {field('average', 'Average (m per piece)', { number: true })}
                {field('ratio', 'Ratio', { placeholder: 'M1 L2 XL2 2XL1' })}
                {field('notes', 'Note')}
              </div>
              <p className="text-muted-foreground mt-3 text-xs">
                Filled in from the order: order no. from the buyer&apos;s PO on the sales order, project ID the sales order, description, fabric and
                design from the order line, metres and average from the BOM, lot no. from the fabric rolls issued, ratio from the size quantities,
                note from the manufacturing order. Change any of them for this card.
              </p>
              {(d.line?.sizes.length ?? 0) > 0 && (
                <p className="text-muted-foreground mt-1 text-xs tabular-nums">
                  Count by size: {d.line!.sizes.map((z) => `${z.code} ${pcs(z.qty)}`).join(' · ')} — {pcs(d.line!.totalQty)} pcs
                </p>
              )}
            </Section>

            <Section icon={Route} title="Process forms">
              {!d.steps.length ? (
                <p className="text-muted-foreground text-sm">
                  No stages yet. Once {d.mo.moNumber}&apos;s materials are issued, load its stages on the manufacturing order: a form follows for each.
                </p>
              ) : (
                <div className="border-border overflow-x-auto rounded-lg border">
                  <table className="data-table w-full min-w-[760px]">
                    <thead>
                      <tr className="bg-secondary">
                        <th>Form</th>
                        <th>Department</th>
                        <th style={{ textAlign: 'right' }}>In</th>
                        <th style={{ textAlign: 'right' }}>Processed</th>
                        <th style={{ textAlign: 'right' }}>Out</th>
                        <th style={{ textAlign: 'right' }}>Damaged</th>
                        <th style={{ textAlign: 'right' }}>Balance</th>
                        <th />
                      </tr>
                    </thead>
                    <tbody>
                      {d.steps.map((s) => {
                        const f = s.figures
                        const stage = stageOf(s)
                        const balance = f ? f.inHand + f.waiting + f.atVendor + f.inTransit : 0
                        return (
                          <tr key={s.id} className={s.skippedAt ? 'opacity-60' : undefined}>
                            <td className="text-xs font-medium">
                              {s.name} {stage === 'QC' ? 'check sheet' : 'sheet'}
                              {s.execution === 'OUTSOURCED' && <span className="badge-purple ml-1.5">Outside</span>}
                              {s.skippedAt && <span className="badge-neutral ml-1.5">Left out</span>}
                            </td>
                            <td className="text-muted-foreground text-xs">{s.department.name}</td>
                            <td className="text-right text-xs tabular-nums">{f?.received ? pcs(f.received) : '—'}</td>
                            <td className="text-right text-xs tabular-nums">{f?.completed ? pcs(f.completed) : '—'}</td>
                            <td className="text-right text-xs tabular-nums">{s.last ? (f?.packed ? pcs(f.packed) : '—') : f?.sentOn ? pcs(f.sentOn) : '—'}</td>
                            <td className="warn-text text-right text-xs tabular-nums">{f && f.damaged + f.rejected ? pcs(f.damaged + f.rejected) : ''}</td>
                            <td className="text-right text-xs font-medium tabular-nums">{balance ? pcs(balance) : '—'}</td>
                            <td className="w-24 text-right">
                              <button type="button" className="btn-secondary h-7 px-2.5 text-xs" onClick={() => setSheet(s.id)}>
                                Open
                              </button>
                            </td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </Section>
          </>
        )}
      </FormFrame>
      {sheet && (
        <SheetView
          jobCardId={jobCardId}
          stepId={sheet}
          onClose={() => {
            setSheet(null)
            void reload()
          }}
          onChanged={onChanged}
        />
      )}
    </>
  )
}
