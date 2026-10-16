'use client'

import { Eyebrow, GREY, INK, NAVY, NUM, RULE_SOFT, TINT, TINT_SOFT, type SheetColumn } from '@/components/print/StoreSheet'

/**
 * A titled table in the store sheets' look, for the parts of a statement that
 * come after its main table: where the material is now, what is with job
 * workers, the movements item by item. A row can be a heading across the
 * whole table, for the item the rows under it belong to.
 */
export type StatementRow =
  | { key: string; heading: React.ReactNode }
  | { key: string; cells: Record<string, React.ReactNode>; strong?: boolean }

export function StatementTable({
  title,
  note,
  columns,
  rows,
}: {
  title: string
  note?: string
  columns: SheetColumn[]
  rows: StatementRow[]
}) {
  const cell = (align: SheetColumn['align'] = 'left'): React.CSSProperties => ({
    padding: '4px 5px',
    fontSize: '9.5px',
    textAlign: align,
    border: `1px solid ${RULE_SOFT}`,
    verticalAlign: 'top',
    color: INK,
    ...(align === 'right' ? NUM : {}),
  })
  let stripe = 0
  return (
    <div style={{ marginTop: '10px', breakInside: 'auto' }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: '8px', marginBottom: '4px' }}>
        <Eyebrow>{title}</Eyebrow>
        {note && <span style={{ fontSize: '9px', color: GREY }}>{note}</span>}
      </div>
      <table style={{ width: '100%', borderCollapse: 'collapse', tableLayout: 'fixed' }}>
        <colgroup>
          {columns.map((c) => (
            <col key={c.key} style={{ width: c.width }} />
          ))}
        </colgroup>
        <thead>
          <tr style={{ background: NAVY }}>
            {columns.map((c) => (
              <th
                key={c.key}
                style={{
                  padding: '4px 5px',
                  fontSize: '8px',
                  fontWeight: 600,
                  letterSpacing: '.04em',
                  textTransform: 'uppercase',
                  color: '#fff',
                  textAlign: c.align ?? 'left',
                  border: `1px solid ${NAVY}`,
                }}
              >
                {c.head}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            if ('heading' in r) {
              stripe = 0
              return (
                <tr key={r.key} style={{ background: TINT, breakAfter: 'avoid' }}>
                  <td colSpan={columns.length} style={{ ...cell(), fontWeight: 700, color: NAVY, fontSize: '10px' }}>
                    {r.heading}
                  </td>
                </tr>
              )
            }
            stripe += 1
            return (
              <tr key={r.key} style={{ background: stripe % 2 ? '#fff' : TINT_SOFT, fontWeight: r.strong ? 700 : undefined }}>
                {columns.map((c) => (
                  <td key={c.key} style={cell(c.align)}>
                    {r.cells[c.key] ?? ''}
                  </td>
                ))}
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
