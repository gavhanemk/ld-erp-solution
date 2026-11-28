'use client'

import { Fragment } from 'react'
import { CODE, HAIR, NUM, money, qty } from '@/components/print/doc'
import type { SheetColumn } from '@/components/print/StoreSheet'

/** One garment line of a sales order or quotation, as its print payload carries it. */
export interface GarmentLine {
  id: string
  item: {
    code: string
    name: string
    color?: string | null
    hsnCode?: string | null
    uom?: { symbol: string } | null
    style?: { code: string; name: string } | null
  }
  styleCode?: string | null
  color?: string | null
  gender?: string | null
  fabric?: string | null
  printName?: string | null
  description?: string | null
  hsnCode?: string | null
  qty: number | string
  unitPrice: number | string
  discount?: number | string | null
  gstRate: number | string
  taxExempt?: boolean
  amount: number | string
  sizes?: Array<{ qty: number | string; size: { code: string; sequence?: number | null } }>
}

const SUB: React.CSSProperties = { fontSize: '8.5px', marginTop: '1px' }

/** "FEMALE" → "Female". */
const titleCase = (v: string) => v.charAt(0).toUpperCase() + v.slice(1).toLowerCase()

/**
 * The garment lines as the mill's old ERP printed them (the user, 28 Nov 2026):
 * item code, name and description, colour, fabric, gender and print name,
 * then every size with its pieces and the line's total, UOM, rate, GST and
 * amount. Fits A4 portrait: a column no line has anything for (a quotation
 * has no fabric or gender) is left out and its width goes to the description;
 * the sizes run down their own column, as on the old sheet, so a twelve-size
 * run makes the row taller rather than the page wider.
 */
export function garmentTable(
  lines: GarmentLine[],
  /** `allColumns`: print colour, fabric, gender and print name even when empty — the sales order, as on the old sheet. */
  opts: { showHsn?: boolean; rateHead?: string; allColumns?: boolean } = {},
): { columns: SheetColumn[]; rows: Array<{ key: string; cells: Record<string, React.ReactNode> }> } {
  const colour = (l: GarmentLine) => l.color || l.item.color || ''
  const has = {
    colour: opts.allColumns || lines.some((l) => colour(l)),
    fabric: opts.allColumns || lines.some((l) => l.fabric),
    gender: opts.allColumns || lines.some((l) => l.gender),
    print: opts.allColumns || lines.some((l) => l.printName),
  }
  const optional: Array<[keyof typeof has, number]> = [
    ['colour', 7],
    ['fabric', 8],
    ['gender', 6],
    ['print', 8],
  ]
  const spare = optional.filter(([k]) => !has[k]).reduce((n, [, w]) => n + w, 0)
  const pct = (n: number) => `${n}%`

  const columns: SheetColumn[] = [
    { key: 'sn', head: 'S.N', width: pct(4), align: 'center' },
    { key: 'code', head: 'Item code', width: pct(9) },
    { key: 'item', head: 'Item name & description', width: pct(19 + spare) },
    ...(has.colour ? [{ key: 'colour', head: 'Colour', width: pct(7) }] : []),
    ...(has.fabric ? [{ key: 'fabric', head: 'Fabric', width: pct(8) }] : []),
    ...(has.gender ? [{ key: 'gender', head: 'Gender', width: pct(6) }] : []),
    ...(has.print ? [{ key: 'print', head: 'Print name', width: pct(8) }] : []),
    { key: 'sizes', head: 'Size · Qty', width: pct(12) },
    { key: 'uom', head: 'UOM', width: pct(5), align: 'center' },
    { key: 'rate', head: opts.rateHead ?? 'Rate', width: pct(8), align: 'right' },
    { key: 'gst', head: 'GST', width: pct(5), align: 'right' },
    { key: 'amount', head: 'Amount (₹)', width: pct(9), align: 'right' },
  ]

  const rows = lines.map((l, i) => {
    const style = l.styleCode || l.item.style?.code
    const sizes = [...(l.sizes ?? [])]
      .filter((s) => Number(s.qty) > 0)
      .sort((a, b) => (a.size.sequence ?? 0) - (b.size.sequence ?? 0))
    const hsn = l.hsnCode || l.item.hsnCode
    return {
      key: l.id,
      cells: {
        sn: i + 1,
        code: (
          <>
            <div style={CODE}>{l.item.code}</div>
            {opts.showHsn !== false && hsn && <div style={SUB}>HSN {hsn}</div>}
          </>
        ),
        item: (
          <>
            <div style={{ fontWeight: 700 }}>{l.item.name}</div>
            {style && (
              <div style={SUB}>
                Style <span style={CODE}>{style}</span>
                {l.item.style?.name && l.item.style.name !== l.item.name ? ` · ${l.item.style.name}` : ''}
              </div>
            )}
            {l.description && <div style={SUB}>{l.description}</div>}
          </>
        ),
        colour: colour(l) || '—',
        fabric: l.fabric || '—',
        gender: l.gender ? titleCase(l.gender) : '—',
        print: l.printName || '—',
        sizes: sizes.length ? (
          <div style={{ fontSize: '9px', ...NUM }}>
            <div style={{ display: 'grid', gridTemplateColumns: 'auto auto', justifyContent: 'space-between', columnGap: '6px' }}>
              {sizes.map((s) => (
                <Fragment key={s.size.code}>
                  <span>{s.size.code}</span>
                  <span style={{ textAlign: 'right' }}>{qty(s.qty)}</span>
                </Fragment>
              ))}
            </div>
            <div
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                borderTop: HAIR,
                marginTop: '2px',
                paddingTop: '1px',
                fontWeight: 700,
              }}
            >
              <span>Total</span>
              <span>{qty(l.qty)}</span>
            </div>
          </div>
        ) : (
          <div style={{ fontWeight: 700, textAlign: 'right', ...NUM }}>{qty(l.qty)}</div>
        ),
        uom: l.item.uom?.symbol ?? 'pcs',
        rate: (
          <>
            <div>{money(l.unitPrice)}</div>
            {Number(l.discount) > 0 && <div style={SUB}>less {Number(l.discount)}%</div>}
          </>
        ),
        gst: l.taxExempt ? 'Nil' : `${Number(l.gstRate)}%`,
        amount: <strong>{money(l.amount)}</strong>,
      },
    }
  })
  return { columns, rows }
}
