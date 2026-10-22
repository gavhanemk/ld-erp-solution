'use client'

import { useState } from 'react'
import { AlertTriangle, Ban, Boxes, CalendarDays, PackageOpen, Printer, Scissors, Send, Users } from 'lucide-react'
import { api, ApiError, can } from '@/lib/api'
import { formatDate } from '@/lib/utils'
import { Section } from '@/components/purchase/Section'
import { ReasonDialog } from '@/components/ui/ReasonDialog'
import { SheetHeader, SizeTable } from './SheetHeader'
import { NextSteps, type NextStep } from './NextSteps'
import { CutterIssueDialog } from './CutterIssueDialog'
import { CutterReceiveDialog } from './CutterReceiveDialog'
import { SendOnDialog } from './SendOnDialog'
import { pcs, type FlowStep, type JobCardCutting, type JobCardDetail } from './types'

/**
 * The cutting sheet of one job card: what the order wants by size, what has
 * been issued to each cutting contractor and received back cut, the bundles
 * and their stickers, and — as the paper sheet had it — each day's pieces in
 * (cut) and out (sent to the next department), size by size.
 */

type Open = { kind: 'issue' } | { kind: 'receive'; issue: JobCardCutting } | { kind: 'send' } | { kind: 'cancel'; issue: JobCardCutting }

const openWindow = (url: string) => window.open(url, '_blank', 'noopener')
const day = (iso: string) => iso.slice(0, 10)

export function CuttingSheet({ d, step, onChanged }: { d: JobCardDetail; step: FlowStep; onChanged: (message: string) => void }) {
  const [open, setOpen] = useState<Open | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const live = !['DRAFT', 'CLOSED'].includes(d.mo.status) && !d.mo.held
  const mayCreate = can('production', 'create') && live
  const sizes = d.line?.sizes ?? []
  const fig = (sizeId: string) => d.sizeFigures[sizeId]?.find((f) => f.stepId === step.id)
  const withCutters = (sizeId: string) => d.cuttings.filter((c) => c.status === 'IN_PROGRESS').reduce((s, c) => s + Number(c.plannedBreakup?.[sizeId] ?? 0), 0)
  const f = step.figures
  const next = step.next ? d.steps.find((s) => s.id === step.next!.id) : null

  // The paper's grid: each day's pieces in (cut) and out (sent on), by size.
  const entries = d.log.filter((e) => e.stepId === step.id)
  const inOf = entries.filter((e) => e.type === 'CUT' && e.qty > 0)
  const outOf = entries.filter((e) => (e.type === 'DISPATCH' || e.type === 'EXCESS') && e.bucket === 'DONE' && e.qty < 0)
  const days = [...new Set([...inOf, ...outOf].map((e) => day(e.date)))].sort()
  const sumOf = (list: typeof entries, date: string, sizeId: string) => list.filter((e) => day(e.date) === date && e.sizeId === sizeId).reduce((s, e) => s + Math.abs(e.qty), 0)
  const signOf = (date: string) => [...new Set([...inOf, ...outOf].filter((e) => day(e.date) === date).map((e) => e.person ?? e.by))].join(', ')

  const cancel = async (issue: JobCardCutting, reason: string) => {
    setBusy(true)
    setError(null)
    try {
      const res = await api.post<{ message?: string }>(`/production/cutting/${issue.id}/cancel`, { reason })
      setOpen(null)
      onChanged(res.message ?? 'Cancelled.')
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not cancel it.')
      setOpen(null)
    } finally {
      setBusy(false)
    }
  }

  const done = (message: string) => {
    setOpen(null)
    onChanged(message)
  }

  // What waits on the cutting sheet, each with the button that does it.
  const toMake = d.line?.totalQty ?? 0
  const out = d.cuttings.filter((c) => c.status === 'IN_PROGRESS')
  const left = Math.max(0, toMake - (f?.completed ?? 0) - out.reduce((s, c) => s + c.plannedPieces, 0))
  const steps: NextStep[] = []
  if (!d.materials.issued) {
    steps.push({
      key: 'materials',
      tone: 'warn',
      text: `${d.mo.moNumber}'s materials have not been issued yet${
        d.materials.requisitions.length
          ? ` (${d.materials.requisitions.map((r) => `${r.mrNumber}: ${r.issued ? 'issued' : r.status === 'APPROVED' ? 'approved, not issued' : 'waiting approval'}`).join('; ')})`
          : ' — no requisition raised'
      }. Cutting starts once the store issues them.`,
    })
  }
  if (left > 0 && f?.state !== 'DONE') {
    steps.push({
      key: 'issue',
      text: `${pcs(left)} pcs still to issue for cutting`,
      actions: mayCreate ? [{ label: 'Issue to cutting contractor', icon: Scissors, primary: true, disabled: !d.materials.issued, onClick: () => setOpen({ kind: 'issue' }) }] : [],
    })
  }
  for (const c of out) {
    steps.push({
      key: c.id,
      tone: 'info',
      text: (
        <>
          {pcs(c.plannedPieces)} pcs with <span className="text-foreground font-medium">{c.cutterName ?? 'a contractor'}</span> on {c.cutOrderNumber}, issued {formatDate(c.cutDate)} — receive them when cut
        </>
      ),
      actions: mayCreate ? [{ label: 'Receive cut', icon: PackageOpen, primary: true, onClick: () => setOpen({ kind: 'receive', issue: c }) }] : [],
    })
  }
  if ((f?.waiting ?? 0) > 0 && next) {
    steps.push({
      key: 'send',
      text: `${pcs(f!.waiting)} pcs cut and ready to send on to ${next.name}${next.execution === 'OUTSOURCED' ? ' (outside unit)' : ''}`,
      actions: mayCreate ? [{ label: `Send to ${next.name}`, icon: Send, primary: true, onClick: () => setOpen({ kind: 'send' }) }] : [],
    })
  }
  const idle = f?.state === 'DONE' ? `All ${pcs(toMake)} pcs cut and sent to ${next?.name ?? 'the next stage'}.` : 'Nothing waiting at cutting right now.'

  return (
    <>
      {error && (
        <div className="border-destructive/40 bg-destructive/5 flex items-start gap-3 rounded-lg border p-3">
          <AlertTriangle size={16} className="text-destructive mt-0.5 shrink-0" />
          <p className="text-destructive text-sm">{error}</p>
        </div>
      )}
      <SheetHeader d={d} step={step} />

      <NextSteps items={steps} idle={idle} />

      <Section icon={Scissors} title="Size details">
        <SizeTable
          d={d}
          rows={[
            { label: 'Count (order)', of: (id) => sizes.find((z) => z.id === id)?.qty ?? 0 },
            { label: 'With contractors', of: withCutters, tone: 'muted' },
            { label: 'Actual cutting', of: (id) => fig(id)?.completed ?? 0, tone: 'primary' },
            { label: `Sent to ${next?.name ?? 'next'}`, of: (id) => fig(id)?.sentOn ?? 0 },
            { label: 'At cutting now', of: (id) => fig(id)?.waiting ?? 0, tone: 'warn' },
          ]}
        />
      </Section>

      <Section
        icon={Users}
        title={`Cutting contractors (${d.cuttings.filter((c) => c.status !== 'CANCELLED').length})`}
        actions={
          d.bundles.length > 0 ? (
            <button type="button" className="btn-ghost h-7 px-2.5 text-xs" onClick={() => openWindow(`/print/bundles?mo=${d.mo.id}&line=${d.card.moLineId}`)}>
              <Boxes size={13} /> All {d.bundles.length} bundle stickers
            </button>
          ) : undefined
        }
      >
        {!d.cuttings.length ? (
          <p className="text-muted-foreground text-sm">Nothing issued for cutting yet. Issue sizes to a cutting contractor to start.</p>
        ) : (
          <div className="space-y-2">
            {d.cuttings.map((c) => {
              const planned = c.plannedBreakup ?? {}
              const actual = c.sizeBreakup ?? {}
              const sizeText = sizes
                .filter((z) => planned[z.id] || actual[z.id])
                .map((z) => (c.status === 'COMPLETED' ? `${z.code} ${actual[z.id] ?? 0}/${planned[z.id] ?? 0}` : `${z.code} ${planned[z.id] ?? 0}`))
                .join(' · ')
              return (
                <div key={c.id} className={`border-border bg-card rounded-lg border p-2.5 text-sm ${c.status === 'CANCELLED' ? 'opacity-60' : ''}`}>
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p>
                        <span className="font-mono text-xs">{c.cutOrderNumber}</span> <span className="text-foreground font-medium">{c.cutterName ?? '—'}</span>{' '}
                        <span className={c.status === 'IN_PROGRESS' ? 'badge-warning' : c.status === 'COMPLETED' ? 'badge-success' : 'badge-neutral'}>
                          {c.status === 'IN_PROGRESS' ? 'With contractor' : c.status === 'COMPLETED' ? 'Received' : 'Cancelled'}
                        </span>
                      </p>
                      <p className="text-muted-foreground mt-0.5 text-xs">
                        Issued {formatDate(c.cutDate)}
                        {c.status === 'COMPLETED' ? ` · received ${formatDate(c.updatedAt)}` : ''}
                        {c.lotNo ? ` · lot ${c.lotNo}` : ''}
                        {c.ratio ? ` · ratio ${c.ratio}` : ''}
                        {c.noOfLayers ? ` · ${c.noOfLayers} layers` : ''}
                        {c.fabricItem ? ` · ${c.fabricItem.name}` : ''}
                        {c.fabricIssued != null ? ` · ${Number(c.fabricIssued)} ${c.fabricItem?.uom?.symbol ?? ''} given` : ''}
                        {c.status === 'COMPLETED' && c.fabricUsed != null ? ` · ${Number(c.fabricUsed)} used, ${Number(c.wastage ?? 0)} waste` : ''}
                      </p>
                      <p className="text-xs tabular-nums">
                        {c.status === 'COMPLETED' ? `Cut ${pcs(c.actualPieces)} of ${pcs(c.plannedPieces)} issued` : `${pcs(c.plannedPieces)} pcs issued`}
                        {sizeText ? <span className="text-muted-foreground"> — {sizeText}</span> : null}
                        {c._count.bundles ? <span className="text-muted-foreground"> · {c._count.bundles} bundles</span> : null}
                      </p>
                    </div>
                    <span className="flex items-center gap-1">
                      {mayCreate && c.status === 'IN_PROGRESS' && (
                        <button type="button" className="btn-secondary h-7 px-2.5 text-xs" onClick={() => setOpen({ kind: 'receive', issue: c })}>
                          <PackageOpen size={13} /> Receive cut
                        </button>
                      )}
                      {c._count.bundles > 0 && (
                        <button type="button" className="btn-ghost h-7 px-2 text-xs" title="Print the bundle stickers" onClick={() => openWindow(`/print/bundles?mo=${d.mo.id}&cutting=${c.id}`)}>
                          <Boxes size={13} /> Stickers
                        </button>
                      )}
                      {c.status === 'COMPLETED' && (
                        <button type="button" className="btn-ghost p-1" title="Print the lay" aria-label={`Print ${c.cutOrderNumber}`} onClick={() => openWindow(`/print/cutting/${c.id}`)}>
                          <Printer size={13} />
                        </button>
                      )}
                      {can('production', 'edit') && live && c.status !== 'CANCELLED' && (
                        <button type="button" className="btn-ghost text-muted-foreground hover:text-destructive p-1" aria-label={`Cancel ${c.cutOrderNumber}`} onClick={() => setOpen({ kind: 'cancel', issue: c })}>
                          <Ban size={13} />
                        </button>
                      )}
                    </span>
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </Section>

      <Section icon={CalendarDays} title="Day by day: in (cut) and out (sent on)">
        {!days.length ? (
          <p className="text-muted-foreground text-sm">Nothing cut yet.</p>
        ) : (
          <div className="border-border overflow-x-auto rounded-lg border">
            <table className="data-table w-full">
              <thead>
                <tr className="bg-secondary">
                  <th rowSpan={2}>Size</th>
                  {days.map((dt) => (
                    <th key={dt} colSpan={2} style={{ textAlign: 'center' }} className="whitespace-nowrap">
                      {formatDate(dt)}
                    </th>
                  ))}
                </tr>
                <tr className="bg-secondary">
                  {days.map((dt) => (
                    <th key={dt} colSpan={2} className="p-0">
                      <div className="grid grid-cols-2 text-[11px]">
                        <span className="text-center">In</span>
                        <span className="text-center">Out</span>
                      </div>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {sizes.map((z) => (
                  <tr key={z.id}>
                    <td className="text-xs font-medium">{z.code}</td>
                    {days.map((dt) => {
                      const i = sumOf(inOf, dt, z.id)
                      const o = sumOf(outOf, dt, z.id)
                      return (
                        <td key={dt} colSpan={2} className="p-0">
                          <div className="grid grid-cols-2 text-xs tabular-nums">
                            <span className="text-center">{i ? pcs(i) : ''}</span>
                            <span className="text-center">{o ? pcs(o) : ''}</span>
                          </div>
                        </td>
                      )
                    })}
                  </tr>
                ))}
                <tr className="bg-secondary">
                  <td className="text-xs font-medium">Sign</td>
                  {days.map((dt) => (
                    <td key={dt} colSpan={2} className="text-muted-foreground text-center text-[11px]">
                      {signOf(dt)}
                    </td>
                  ))}
                </tr>
              </tbody>
            </table>
          </div>
        )}
      </Section>

      {open?.kind === 'issue' && <CutterIssueDialog d={d} onClose={() => setOpen(null)} onSaved={done} />}
      {open?.kind === 'receive' && (
        <CutterReceiveDialog
          d={d}
          issue={open.issue}
          onClose={() => setOpen(null)}
          onSaved={(message, cuttingId) => {
            done(message)
            openWindow(`/print/bundles?mo=${d.mo.id}&cutting=${cuttingId}`)
          }}
        />
      )}
      {open?.kind === 'send' && (
        <SendOnDialog
          flow={d}
          fromStepId={step.id}
          onClose={() => setOpen(null)}
          onSaved={(message, transferId) => {
            done(message)
            if (transferId) openWindow(`/print/transfer/${transferId}`)
          }}
        />
      )}
      {open?.kind === 'cancel' && (
        <ReasonDialog
          title={`Cancel ${open.issue.cutOrderNumber}?`}
          description={
            open.issue.status === 'IN_PROGRESS'
              ? 'The pieces issued to the contractor are no longer to be cut by them.'
              : 'Its pieces come off the cut count and its bundles go with them — refused once any has been sent on.'
          }
          confirmLabel="Cancel it"
          danger
          busy={busy}
          onCancel={() => setOpen(null)}
          onConfirm={(reason) => void cancel(open.issue, reason)}
        />
      )}
    </>
  )
}
