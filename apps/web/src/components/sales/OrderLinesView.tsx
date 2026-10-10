'use client'

/**
 * An order's lines, each with its size run, read-only.
 *
 * Shared by the list's expanded row, the order detail and an earlier version
 * of an amended order, so a line reads the same wherever it is opened.
 */
export interface OrderLineView {
  id: string
  styleCode: string | null
  color: string | null
  totalQty: string | number
  unitPrice: string | number
  discount: string | number
  gstRate: string | number
  amount: string | number
  deliveredQty: string | number
  pendingQty: string | number
  hsnCode: string | null
  gender?: string | null
  fabric?: string | null
  printName?: string | null
  description?: string | null
  taxExempt?: boolean
  item: { code: string; name: string; color: string | null; style?: { code: string; name: string } | null }
  sizes: Array<{ id: string; qty: string | number; size: { code: string; label: string; sequence: number } }>
}

const pcs = (n: number | string) => Number(n).toLocaleString('en-IN', { maximumFractionDigits: 2 })
const GENDER: Record<string, string> = { MALE: "Men's", FEMALE: "Women's", UNISEX: 'Unisex' }

/** Gender, fabric and print name in one line, skipping the empty ones. */
export function lineDetails(l: Pick<OrderLineView, 'gender' | 'fabric' | 'printName'>): string {
  return [l.gender ? GENDER[l.gender] ?? l.gender : null, l.fabric, l.printName && `Print ${l.printName}`]
    .filter(Boolean)
    .join(' · ')
}
const money = (v: string | number) =>
  Number(v).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

export function OrderLinesView({ lines, showProgress = true }: { lines: OrderLineView[]; showProgress?: boolean }) {
  if (lines.length === 0) {
    return <p className="text-muted-foreground px-3 py-3 text-xs">This order has no lines.</p>
  }

  return (
    <div className="space-y-2 p-2">
      {lines.map((line) => {
        const sizes = [...line.sizes].sort((a, b) => a.size.sequence - b.size.sequence)
        const colour = line.color || line.item.color
        const style = line.styleCode || line.item.style?.code
        return (
          <div key={line.id} className="border-border bg-card rounded-lg border p-2.5">
            <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-1">
              <div className="min-w-0">
                <p className="text-foreground text-sm font-medium leading-snug">
                  {line.item.name}
                  {colour && <span className="text-muted-foreground font-normal"> · {colour}</span>}
                </p>
                <p className="text-muted-foreground mt-0.5 text-[10px]">
                  <span className="font-mono">{line.item.code}</span>
                  {style && (
                    <>
                      {' '}
                      · Style <span className="font-mono">{style}</span>
                    </>
                  )}
                  {line.hsnCode && (
                    <>
                      {' '}
                      · HSN <span className="font-mono">{line.hsnCode}</span>
                    </>
                  )}
                </p>
                {lineDetails(line) && <p className="text-muted-foreground mt-0.5 text-[11px]">{lineDetails(line)}</p>}
                {line.description && <p className="text-foreground mt-0.5 text-[11px]">{line.description}</p>}
              </div>
              <dl className="grid grid-cols-4 gap-x-4 text-right text-xs">
                {[
                  ['Rate', `₹${money(line.unitPrice)}`],
                  ['Disc', Number(line.discount) > 0 ? `${Number(line.discount)}%` : '—'],
                  ['GST', line.taxExempt ? 'Exempt' : `${Number(line.gstRate)}%`],
                  ['Amount', `₹${money(line.amount)}`],
                ].map(([label, value]) => (
                  <div key={label}>
                    <dt className="text-muted-foreground text-[10px] uppercase tracking-wider">{label}</dt>
                    <dd className="text-foreground tabular-nums">{value}</dd>
                  </div>
                ))}
              </dl>
            </div>

            {/* The size run across, with the total at the end, the way a
              cutting sheet reads it. Sideways scroll only inside this box, for
              a run too long for a phone. */}
            <div className="mt-2 overflow-x-auto">
              <table className="subtable w-auto">
                <thead>
                  <tr>
                    <th className="text-left">Pieces</th>
                    {sizes.map((s) => (
                      <th key={s.id} className="text-right" title={s.size.label}>
                        {s.size.code}
                      </th>
                    ))}
                    <th className="text-right">Total</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td className="text-muted-foreground pr-4 text-xs">Ordered</td>
                    {sizes.map((s) => (
                      <td key={s.id} className="px-2 text-right text-xs tabular-nums">
                        {pcs(s.qty)}
                      </td>
                    ))}
                    <td className="px-2 text-right text-xs font-semibold tabular-nums">{pcs(line.totalQty)}</td>
                  </tr>
                </tbody>
              </table>
            </div>
            {showProgress && (
              <p className="text-muted-foreground mt-1.5 text-[11px] tabular-nums">
                Dispatched {pcs(line.deliveredQty)} · Still to send {pcs(line.pendingQty)}
              </p>
            )}
          </div>
        )
      })}
    </div>
  )
}
