'use client'

import { Fragment, useMemo } from 'react'
import { Archive, CheckCircle2, Equal, PencilLine, Plus } from 'lucide-react'
import { can } from '@/lib/api'
import { cn, formatDate, formatRupees } from '@/lib/utils'
import type { Bom } from '@/components/masters/BomFormDialog'

/*
 * One BOM in full, read-only: what its status means, the cost of one piece as
 * the sum it is, its components, its labour and overheads, its notes. The BOM
 * list shows it under a line; the review before approving shows the same.
 */

const num = (v: unknown) => Number(v ?? 0)

/**
 * Quantities to four places at most — the precision a BOM stores — and never
 * fewer than two, so a column of them lines up on the decimal point.
 */
const qty = (v: unknown) =>
  Number(v ?? 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 4 })

const percent = (v: unknown) =>
  `${Number(v ?? 0).toLocaleString('en-IN', { maximumFractionDigits: 2 })}%`

/*
 * Cells for the tables. The same header type and row dividers as .data-table,
 * with tighter cells: its reading-table padding does not leave ten columns
 * room to line up.
 */
const th = 'px-3 py-2.5 text-xs font-semibold uppercase tracking-wider text-muted-foreground'
const td = 'px-3 py-2.5 align-middle'
const sectionTitle = 'text-xs font-semibold uppercase tracking-wide text-muted-foreground'

/** Everything about one BOM: what its status means, the cost sum, its components and costing, its notes. */
export function BomDetail({ bom }: { bom: Bom }) {
  // Labour, overhead, cost and price reach only those who may approve masters;
  // the API leaves them out for everyone else, who see material alone.
  const canCost = can('masters', 'approve')
  const material = num(bom.totalCost)
  const labour = num(bom.labourCost)
  const overhead = num(bom.overheadCost)
  const cost = bom.costPerPiece != null ? num(bom.costPerPiece) : material + labour + overhead
  const price = bom.sellingPrice != null ? num(bom.sellingPrice) : null
  const lines = bom.lines ?? []
  const costLines = bom.costLines ?? []

  // What the status means for this BOM, in words. A badge saying "Approved"
  // does not tell anyone what approving did, or what to do next.
  const who = `${bom.style?.code ?? 'this style'}${bom.color ? ` in ${bom.color}` : ''}`
  const note =
    bom.status === 'APPROVED'
      ? {
          icon: CheckCircle2,
          iconClass: 'text-emerald-400',
          title: `Approved — this is the BOM to use for ${who}`,
          body: 'Only one BOM per style and colour can be approved at a time. It is locked, so its costing stays fixed: to change it, copy it to a new version and approve that.',
        }
      : bom.status === 'OBSOLETE'
        ? {
            icon: Archive,
            iconClass: 'text-muted-foreground',
            title: 'Retired — kept for the record',
            body: `A newer BOM replaced it, or it was taken out of use. It is no longer the BOM for ${who}.`,
          }
        : {
            icon: PencilLine,
            iconClass: 'text-primary',
            title: 'Draft — not in use yet',
            body: `Check the components and the costing, then approve it. Approving makes it the BOM for ${who} and retires any BOM approved for it before.`,
          }

  const sizeTotals = useMemo(() => {
    // A per-size cost only means something when at least one component varies.
    const ids = new Set<string>()
    for (const line of bom.lines ?? []) {
      for (const s of line.sizes ?? []) ids.add(s.sizeId)
    }
    if (ids.size === 0) return []

    const rows = new Map<string, { label: string; sequence: number; cost: number }>()
    for (const line of bom.lines ?? []) {
      const base = num(line.totalCost)
      for (const id of ids) {
        const own = (line.sizes ?? []).find((s) => s.sizeId === id)
        const label = own?.size?.label ?? own?.size?.code ?? ''
        const seq = own?.size?.sequence ?? 0
        const prev = rows.get(id) ?? { label, sequence: seq, cost: 0 }
        rows.set(id, {
          label: own ? label : prev.label,
          sequence: own ? seq : prev.sequence,
          // A size with no row of its own consumes what the line consumes.
          cost: prev.cost + (own ? num(own.totalCost) : base),
        })
      }
    }
    return [...rows.values()].sort((a, b) => a.sequence - b.sequence)
  }, [bom.lines])

  return (
    <div className="space-y-6 px-4 py-4">

          {/* What this BOM's status means, said once, in words, before any numbers. */}
          <div className="flex items-start gap-3 rounded-lg border border-border bg-secondary/40 px-4 py-3">
            <note.icon size={16} className={cn('mt-0.5 shrink-0', note.iconClass)} />
            <div className="space-y-0.5">
              <p className="text-sm font-semibold text-foreground">{note.title}</p>
              <p className="text-xs text-muted-foreground">{note.body}</p>
              {bom.approvedBy && (
                <p className="text-xs text-muted-foreground">
                  Approved by <span className="text-foreground">{bom.approvedBy.name}</span>
                  {bom.approvedAt && ` on ${formatDate(bom.approvedAt)}`}
                </p>
              )}
            </div>
          </div>

          {/* The answer first, as the sum it is. The tables below show where each part comes from. */}
          <section className="space-y-2">
            <h3 className={sectionTitle}>
              Cost of one piece{bom.baseSize && ` · size ${bom.baseSize.label}`}
            </h3>
            {canCost ? (
              <>
                <div className="flex flex-col gap-2 md:flex-row md:items-stretch">
                  <CostBox
                    label="Material"
                    amount={material}
                    note={`${lines.length} component${lines.length === 1 ? '' : 's'}${
                      cost > 0 ? ` · ${Math.round((material / cost) * 100)}% of the cost` : ''
                    }`}
                  />
                  <span className="flex items-center justify-center text-muted-foreground" aria-hidden>
                    <Plus size={16} />
                  </span>
                  <CostBox
                    label="Labour"
                    amount={labour}
                    note={
                      cost > 0 && labour > 0
                        ? `${Math.round((labour / cost) * 100)}% of the cost`
                        : 'None entered'
                    }
                  />
                  <span className="flex items-center justify-center text-muted-foreground" aria-hidden>
                    <Plus size={16} />
                  </span>
                  <CostBox
                    label="Overhead"
                    amount={overhead}
                    note={
                      cost > 0 && overhead > 0
                        ? `${Math.round((overhead / cost) * 100)}% of the cost`
                        : 'None entered'
                    }
                  />
                  <span className="flex items-center justify-center text-muted-foreground" aria-hidden>
                    <Equal size={16} />
                  </span>
                  <CostBox label="Cost per piece" amount={cost} note="to make one piece" strong />
                </div>

                {/* The price, and what it leaves, under the cost it is worked from. */}
                <div className="flex flex-wrap items-center gap-x-6 gap-y-1 rounded-lg border border-border px-4 py-3">
                  <div>
                    <p className="text-xs font-medium text-muted-foreground">Selling price</p>
                    <p className={cn('mt-1 font-mono text-lg font-bold', price !== null ? 'text-primary' : 'text-muted-foreground')}>
                      {price !== null ? formatRupees(price) : '—'}
                    </p>
                  </div>
                  {price !== null ? (
                    <p className="text-xs text-muted-foreground">
                      {bom.marginPercent != null && `${percent(bom.marginPercent)} margin · `}
                      profit {formatRupees(price - cost)} a piece · before GST
                      {bom.pricedBy &&
                        ` · priced by ${bom.pricedBy.name}${bom.pricedAt ? ` on ${formatDate(bom.pricedAt)}` : ''}`}
                    </p>
                  ) : (
                    <p className="text-xs text-muted-foreground">
                      Not priced yet. Edit this BOM and set a margin on its last step.
                    </p>
                  )}
                </div>
              </>
            ) : (
              <div className="flex flex-col gap-2 md:flex-row md:items-stretch">
                <CostBox
                  label="Material"
                  amount={material}
                  note={`${lines.length} component${lines.length === 1 ? '' : 's'}`}
                  strong
                />
              </div>
            )}

            {sizeTotals.length > 0 && (
              <div className="overflow-x-auto rounded-lg border border-border">
                <table className="w-full text-sm">
                  <thead className="bg-secondary/60">
                    <tr className="border-b border-border">
                      <th className={cn(th, 'text-left')}>Total by size</th>
                      {sizeTotals.map((s) => (
                        <th key={s.label} className={cn(th, 'text-right')}>
                          {s.label}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    <tr>
                      {/* Material only: a percentage overhead would need working
                          out again for every size, and these rows are older data. */}
                      <td className={cn(td, 'text-xs text-muted-foreground')}>Material</td>
                      {sizeTotals.map((s) => (
                        <td key={s.label} className={cn(td, 'text-right font-mono text-foreground')}>
                          {formatRupees(s.cost)}
                        </td>
                      ))}
                    </tr>
                  </tbody>
                </table>
              </div>
            )}
          </section>

          <section className="space-y-2">
            <div>
              <h3 className={sectionTitle}>Material — components ({lines.length})</h3>
              <p className="mt-0.5 text-xs text-muted-foreground">
                What goes into one piece. The material cost is the total of the Cost column.
              </p>
            </div>

            <div className="overflow-x-auto rounded-lg border border-border">
              <table className="w-full min-w-[980px] table-fixed text-sm">
                <colgroup>
                  <col className="w-10" />
                  <col />
                  <col className="w-24" />
                  <col className="w-32" />
                  <col className="w-24" />
                  <col className="w-24" />
                  <col className="w-24" />
                  <col className="w-16" />
                  <col className="w-24" />
                  <col className="w-28" />
                </colgroup>
                <thead className="bg-secondary/60">
                  <tr className="border-b border-border">
                    <th className={cn(th, 'text-center')}>#</th>
                    <th className={cn(th, 'text-left')}>Component</th>
                    <th className={cn(th, 'text-left')}>Part</th>
                    <th className={cn(th, 'text-left')} title="The department that draws it from the store">
                      Used by
                    </th>
                    <th className={cn(th, 'text-right')}>Qty / pc</th>
                    <th className={cn(th, 'text-right')}>Wastage</th>
                    <th className={cn(th, 'text-right')} title="Quantity with the wastage added">
                      Effective
                    </th>
                    <th className={cn(th, 'text-left')}>Unit</th>
                    <th className={cn(th, 'text-right')}>Rate</th>
                    <th className={cn(th, 'text-right')}>Cost</th>
                  </tr>
                </thead>

                <tbody>
                  {lines.map((line, index) => {
                    const bySize = line.sizes ?? []
                    return (
                      <Fragment key={line.id ?? index}>
                        {/* A line with size quantities keeps its divider below the size row instead. */}
                        <tr className={cn(bySize.length === 0 && 'border-b border-border/50')}>
                          <td className={cn(td, 'text-center font-mono text-xs text-muted-foreground')}>
                            {index + 1}
                          </td>
                          <td className={td}>
                            <div className="flex min-w-0 items-baseline gap-2">
                              <span className="shrink-0 font-mono text-xs text-muted-foreground">
                                {line.componentItem?.code}
                              </span>
                              <span className="truncate text-foreground" title={line.componentItem?.name}>
                                {line.componentItem?.name}
                              </span>
                            </div>
                          </td>
                          <td className={cn(td, 'truncate text-xs text-muted-foreground')}>
                            {line.component || '—'}
                          </td>
                          <td className={cn(td, 'truncate text-xs')}>
                            {line.department ? (
                              <span className="text-foreground">{line.department.name}</span>
                            ) : (
                              <span className="text-accent">Not set</span>
                            )}
                          </td>
                          <td className={cn(td, 'text-right font-mono')}>{qty(line.qtyPerUnit)}</td>
                          <td className={cn(td, 'text-right font-mono text-muted-foreground')}>
                            {percent(line.wastagePercent)}
                          </td>
                          <td className={cn(td, 'text-right font-mono font-medium')}>{qty(line.effectiveQty)}</td>
                          <td className={cn(td, 'text-xs text-muted-foreground')}>
                            {line.componentItem?.uom?.symbol ?? '—'}
                          </td>
                          <td className={cn(td, 'text-right font-mono text-muted-foreground')}>
                            {formatRupees(line.unitCost)}
                          </td>
                          <td className={cn(td, 'text-right font-mono font-semibold text-foreground')}>
                            {formatRupees(line.totalCost)}
                          </td>
                        </tr>

                        {bySize.length > 0 && (
                          <tr className="border-b border-border/50">
                            <td />
                            <td colSpan={9} className="px-3 pb-2.5">
                              <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1 text-xs text-muted-foreground">
                                <span>Effective by size:</span>
                                {bySize.map((s) => (
                                  <span key={s.id ?? s.sizeId} className="font-mono">
                                    {s.size?.label ?? s.size?.code}{' '}
                                    <span className="text-foreground">{qty(s.effectiveQty)}</span>
                                  </span>
                                ))}
                              </div>
                            </td>
                          </tr>
                        )}
                      </Fragment>
                    )
                  })}
                </tbody>

                <tfoot>
                  <tr className="bg-secondary/40">
                    <td colSpan={9} className={cn(td, 'text-right font-semibold text-foreground')}>
                      Material for one piece
                    </td>
                    <td className={cn(td, 'text-right font-mono font-bold text-foreground')}>
                      {formatRupees(material)}
                    </td>
                  </tr>
                </tfoot>
              </table>
            </div>
          </section>

          {canCost && (
            <section className="space-y-2">
              <div>
                <h3 className={sectionTitle}>Labour and overheads ({costLines.length})</h3>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  What one piece costs beyond its material. A percentage overhead is worked out on
                  material and labour together.
                </p>
              </div>

              {costLines.length === 0 ? (
                <p className="rounded-lg border border-border px-4 py-3 text-xs text-muted-foreground">
                  {bom.status === 'DRAFT'
                    ? 'No labour or overheads entered yet. Edit this BOM to add them on its costing step.'
                    : 'No labour or overheads were entered before this BOM was approved.'}
                </p>
              ) : (
                <div className="overflow-x-auto rounded-lg border border-border">
                  <table className="w-full min-w-[640px] table-fixed text-sm">
                    <colgroup>
                      <col />
                      <col className="w-28" />
                      <col className="w-48" />
                      <col className="w-48" />
                      <col className="w-28" />
                    </colgroup>
                    <thead className="bg-secondary/60">
                      <tr className="border-b border-border">
                        <th className={cn(th, 'text-left')}>Cost</th>
                        <th className={cn(th, 'text-left')}>Type</th>
                        <th className={cn(th, 'text-left')}>Department</th>
                        <th className={cn(th, 'text-right')}>Charged as</th>
                        <th className={cn(th, 'text-right')}>Per piece</th>
                      </tr>
                    </thead>
                    <tbody>
                      {costLines.map((c, i) => (
                        <tr key={c.id ?? i} className="border-b border-border/50">
                          <td className={cn(td, 'truncate text-foreground')} title={c.name}>
                            {c.name}
                          </td>
                          <td className={cn(td, 'text-xs text-muted-foreground')}>
                            {c.kind === 'LABOUR' ? 'Labour' : 'Overhead'}
                          </td>
                          <td className={cn(td, 'truncate text-xs text-muted-foreground')}>
                            {c.department?.name ?? '—'}
                          </td>
                          <td className={cn(td, 'text-right text-xs text-muted-foreground')}>
                            {c.basis === 'PERCENT'
                              ? `${percent(c.value)} of material + labour`
                              : 'Rupees per piece'}
                          </td>
                          <td className={cn(td, 'text-right font-mono font-semibold text-foreground')}>
                            {formatRupees(c.amount)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                    <tfoot>
                      <tr className="bg-secondary/40">
                        <td colSpan={4} className={cn(td, 'text-right font-semibold text-foreground')}>
                          Labour and overheads for one piece
                        </td>
                        <td className={cn(td, 'text-right font-mono font-bold text-foreground')}>
                          {formatRupees(labour + overhead)}
                        </td>
                      </tr>
                    </tfoot>
                  </table>
                </div>
              )}
            </section>
          )}

          {bom.notes && (
            <section className="space-y-1">
              <h3 className={sectionTitle}>Notes</h3>
              <p className="whitespace-pre-line text-sm text-foreground">{bom.notes}</p>
            </section>
          )}
    </div>
  )
}

interface CostBoxProps {
  label: string
  /** null when this part is not costed at all — a different fact from ₹0.00. */
  amount: number | null
  note: string
  strong?: boolean
}

/** One term of the "material + labour = total" sum at the top of an expanded BOM. */
function CostBox({ label, amount, note, strong }: CostBoxProps) {
  return (
    <div className={cn('flex-1 rounded-lg border border-border px-4 py-3', strong && 'bg-secondary/40')}>
      <p className="text-xs font-medium text-muted-foreground">{label}</p>
      <p className={cn('mt-1 font-mono text-lg font-bold', strong ? 'text-primary' : 'text-foreground')}>
        {amount === null ? '—' : formatRupees(amount)}
      </p>
      <p className="mt-0.5 text-xs text-muted-foreground">{note}</p>
    </div>
  )
}

