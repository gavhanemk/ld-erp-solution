'use client'

import { formatDate } from '@/lib/utils'
import { pcs, refNo, type FlowStep, type JobCardDetail } from './types'

/**
 * The top of a department's sheet, as the paper ones had it: the order and
 * its references, the fabric, colour and design, metres, average and ratio,
 * and the quantities ordered and cut. Read from the job card.
 */
export function SheetHeader({ d, step }: { d: JobCardDetail; step?: FlowStep }) {
  const c = d.card
  const cutting = d.steps.find((s) => s.kind === 'CUTTING')
  const cut = cutting?.figures?.completed ?? 0
  const facts: Array<[string, React.ReactNode]> = [
    ['Ref no.', <span key="ref" className="font-mono">{refNo(c)}</span>],
    ['Job card', <span key="jc" className="font-mono">{c.jobCardNumber}</span>],
    ['Order no.', c.orderNo ?? c.so?.customerPORef ?? '—'],
    ['Project ID', c.projectId ?? '—'],
    ['Description', c.description ?? '—'],
    ['Fabric quality', c.fabricQuality ?? '—'],
    ['Colour', d.line?.color || '—'],
    ['Design no.', c.designNo ?? '—'],
    ['Lot no.', c.lotNo ?? '—'],
    ['Metres', c.meters != null ? c.meters.toLocaleString('en-IN', { maximumFractionDigits: 3 }) : '—'],
    ['Average', c.average != null ? `${c.average.toLocaleString('en-IN', { maximumFractionDigits: 4 })} m/pc` : '—'],
    ['Ratio', c.ratio ?? '—'],
    ['Order qty', `${pcs(d.line?.totalQty ?? 0)} pcs`],
    ['Cutting qty', `${pcs(cut)} pcs`],
    ['Style', d.line ? `${d.line.style.code} · ${d.line.style.name}` : '—'],
    ['Order', `${d.mo.moNumber}${d.mo.so ? ` · ${d.mo.so.soNumber} · ${d.mo.so.customer.name}` : ''}`],
  ]
  return (
    <div className="border-border bg-card rounded-lg border p-3">
      {step && (
        <p className="text-primary mb-2 text-xs font-semibold uppercase tracking-wide">
          {step.name} · {step.department.name}
          {step.execution === 'OUTSOURCED' ? ' · outside unit' : ''}
          {c.due ? <span className="text-muted-foreground font-normal normal-case tracking-normal"> · order due {formatDate(c.due)}</span> : null}
        </p>
      )}
      <dl className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-xs sm:grid-cols-4">
        {facts.map(([label, value]) => (
          <div key={label} className="min-w-0">
            <dt className="text-muted-foreground text-[11px]">{label}</dt>
            <dd className="text-foreground truncate font-medium">{value}</dd>
          </div>
        ))}
      </dl>
    </div>
  )
}

/** Size by size: a row of figures across the line's sizes, with a total. */
export function SizeTable({
  d,
  rows,
}: {
  d: JobCardDetail
  rows: Array<{ label: string; of: (sizeId: string) => number; total?: number; tone?: 'muted' | 'primary' | 'warn' }>
}) {
  const sizes = d.line?.sizes ?? []
  if (!sizes.length) return null
  return (
    <div className="border-border overflow-x-auto rounded-lg border">
      <table className="data-table w-full">
        <thead>
          <tr className="bg-secondary">
            <th>Size</th>
            {sizes.map((z) => (
              <th key={z.id} style={{ textAlign: 'right' }}>
                {z.code}
              </th>
            ))}
            <th style={{ textAlign: 'right' }}>Total</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const values = sizes.map((z) => r.of(z.id))
            const total = r.total ?? values.reduce((s, n) => s + n, 0)
            const cls = r.tone === 'muted' ? 'text-muted-foreground' : r.tone === 'primary' ? 'text-primary' : r.tone === 'warn' ? 'warn-text' : ''
            return (
              <tr key={r.label}>
                <td className={`whitespace-nowrap text-xs font-medium ${cls}`}>{r.label}</td>
                {values.map((v, i) => (
                  <td key={sizes[i].id} className={`text-right text-xs tabular-nums ${cls}`}>
                    {v ? pcs(v) : '—'}
                  </td>
                ))}
                <td className={`text-right text-xs font-semibold tabular-nums ${cls}`}>{pcs(total)}</td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
