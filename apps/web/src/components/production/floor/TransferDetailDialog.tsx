'use client'

import { ArrowRight, ClipboardCheck, ExternalLink, Printer, Scale, Send } from 'lucide-react'
import { can } from '@/lib/api'
import { formatDate } from '@/lib/utils'
import { FormFrame } from '@/components/ui/FormFrame'
import { Section } from '@/components/purchase/Section'
import { transferStatus } from './transferStatus'
import { pcs, sheetHref, type FlowTransfer } from './types'

/**
 * One process transfer, in full: what was sent, from which department to
 * which (or to which outside unit), by whom and when, who counted it in, and
 * bundle by bundle what was sent and what arrived. From here it is counted
 * in, settled, printed, or its sheet opened.
 */
export type TransferRow = Omit<FlowTransfer, 'toStep' | 'fromStep'> & {
  fromStep: { id: string; name: string; department?: { name: string } }
  toStep: { id: string; name: string; kind: string; isQcStep: boolean; department?: { name: string } }
  vehicleNo?: string | null
  mo: { id: string; moNumber: string; so: { soNumber: string; customer: { name: string } } | null }
  jobCard: { id: string; jobCardNumber: string; designNo: string | null; moLine: { color: string; style: { code: string } } } | null
  createdBy?: { name: string } | null
}

export function TransferDetailDialog({
  t,
  onClose,
  onCountIn,
  onSettle,
}: {
  t: TransferRow
  onClose: () => void
  onCountIn: () => void
  onSettle: () => void
}) {
  const st = transferStatus(t)
  const sent = t.lines.reduce((s, l) => s + l.dispatchedQty, 0)
  const got = t.lines.reduce((s, l) => s + l.receivedQty, 0)
  const short = t.lines.reduce((s, l) => s + l.shortQty - l.settledQty, 0)
  const toCount = !t.vendor && (t.status === 'DISPATCHED' || t.status === 'PARTLY_RECEIVED')
  const facts: Array<[string, React.ReactNode]> = [
    ['Job card', t.jobCard ? `${t.jobCard.jobCardNumber} · ${t.jobCard.moLine.style.code} ${t.jobCard.moLine.color}` : t.mo.moNumber],
    ['Order', `${t.mo.moNumber}${t.mo.so ? ` · ${t.mo.so.customer.name}` : ''}`],
    ['From', `${t.fromStep.name}${t.fromStep.department ? ` (${t.fromStep.department.name})` : ''}`],
    ['To', t.vendor ? `${t.toStep.name} at ${t.vendor.name} (outside unit)` : `${t.toStep.name}${t.toStep.department ? ` (${t.toStep.department.name})` : ''}`],
    ['Sent on', formatDate(t.dispatchDate)],
    ['Issued by', t.issuedBy ?? t.createdBy?.name ?? '—'],
    [t.vendor ? 'Back' : 'Received by', t.vendor ? `${pcs(got)} of ${pcs(sent)} pcs` : t.receivedBy ? `${t.receivedBy}${t.receivedAt ? `, ${formatDate(t.receivedAt)}` : ''}` : '—'],
    ['Vehicle no.', t.vehicleNo ?? '—'],
  ]
  return (
    <FormFrame
      icon={Send}
      title={`Transfer ${t.transferNumber}`}
      subtitle={
        <span className="inline-flex flex-wrap items-center gap-1.5">
          {t.fromStep.name} <ArrowRight size={12} /> {t.vendor ? `${t.vendor.name} (${t.toStep.name})` : t.toStep.name} · {pcs(sent)} pcs in {t.lines.length}{' '}
          {t.lines.length === 1 ? 'bundle' : 'bundles'} <span className={st.cls}>{st.label}</span>
        </span>
      }
      width="max-w-4xl"
      primary={
        toCount && can('production', 'create') ? (
          <button type="button" className="btn-primary" onClick={onCountIn}>
            <ClipboardCheck size={15} /> Count in
          </button>
        ) : t.status === 'DISCREPANCY' && can('production', 'edit') ? (
          <button type="button" className="btn-primary" onClick={onSettle}>
            <Scale size={15} /> Settle short
          </button>
        ) : (
          <button type="button" className="btn-secondary" onClick={() => window.open(`/print/transfer/${t.id}`, '_blank', 'noopener')}>
            <Printer size={15} /> Print
          </button>
        )
      }
      footer={
        <>
          <button type="button" className="btn-secondary" onClick={() => window.open(`/print/transfer/${t.id}`, '_blank', 'noopener')}>
            <Printer size={15} /> Print card
          </button>
          {t.jobCard && (
            <a className="btn-secondary" href={sheetHref(t.jobCard.id, t.toStep.id)}>
              <ExternalLink size={15} /> {t.toStep.name} sheet
            </a>
          )}
          <button type="button" className="btn-secondary" onClick={onClose}>
            Close
          </button>
        </>
      }
      footerNote={short ? <span className="text-destructive">{pcs(short)} pcs short, not yet settled.</span> : t.notes ? t.notes : undefined}
      onClose={onClose}
    >
      <dl className="border-border bg-card grid grid-cols-1 gap-x-6 gap-y-2 rounded-lg border p-3 text-sm sm:grid-cols-2">
        {facts.map(([label, value]) => (
          <div key={label} className="flex justify-between gap-3">
            <dt className="text-muted-foreground">{label}</dt>
            <dd className="text-foreground text-right font-medium">{value}</dd>
          </div>
        ))}
      </dl>
      {t.status === 'CANCELLED' && t.cancelReason && <p className="text-muted-foreground text-sm">Cancelled: {t.cancelReason}</p>}

      <Section icon={Send} title={`Bundles (${t.lines.length})`}>
        <div className="border-border overflow-x-auto rounded-lg border">
          <table className="data-table w-full">
            <thead>
              <tr className="bg-secondary">
                <th>Bundle</th>
                <th>Size</th>
                <th style={{ textAlign: 'right' }}>Sent</th>
                <th style={{ textAlign: 'right' }}>{t.vendor ? 'Back' : 'Counted in'}</th>
                <th style={{ textAlign: 'right' }}>Difference</th>
              </tr>
            </thead>
            <tbody>
              {t.lines.map((l) => (
                <tr key={l.id}>
                  <td className="font-mono text-xs">{l.bundle.code}</td>
                  <td className="text-xs">{l.bundle.size?.code ?? '—'}</td>
                  <td className="text-right text-xs tabular-nums">{pcs(l.dispatchedQty)}</td>
                  <td className="text-right text-xs tabular-nums">{l.receivedQty ? pcs(l.receivedQty) : '—'}</td>
                  <td className={`text-right text-xs tabular-nums ${l.shortQty - l.settledQty > 0 ? 'text-destructive font-semibold' : ''}`}>
                    {l.shortQty ? `${pcs(l.shortQty)} short${l.settledQty ? ` (${pcs(l.settledQty)} settled)` : ''}` : l.excessQty ? `${pcs(l.excessQty)} over` : ''}
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="bg-secondary">
                <td colSpan={2} className="text-xs font-medium">
                  Total
                </td>
                <td className="text-right text-xs font-semibold tabular-nums">{pcs(sent)}</td>
                <td className="text-right text-xs font-semibold tabular-nums">{pcs(got)}</td>
                <td />
              </tr>
            </tfoot>
          </table>
        </div>
      </Section>
    </FormFrame>
  )
}
