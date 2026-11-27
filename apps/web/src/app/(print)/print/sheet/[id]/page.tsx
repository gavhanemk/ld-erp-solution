'use client'

import { Suspense, useEffect, useState } from 'react'
import { useParams, useSearchParams } from 'next/navigation'
import { api, ApiError } from '@/lib/api'
import {
  StoreSheet,
  CODE,
  Dash,
  Eyebrow,
  Note,
  PartyLine,
  TotalsBox,
  WordsAndTotals,
  qty,
  longDate,
  shortDate,
  INK,
  MUTED,
  type SheetColumn,
  type SheetParty,
} from '@/components/print/StoreSheet'
import { HAIR, LINE } from '@/components/print/doc'
import { sheetRows } from '@/components/production/floor/StageSheet'
import { isCheck, lotOf, refNo, type JobCardDetail } from '@/components/production/floor/types'

interface Payload {
  company: Record<string, string | null>
  template: { title: string; footerNote: string | null }
  detail: JobCardDetail
  /** The department's challan run on this order, e.g. CUT/2627-0002. */
  series: string | null
}

const day = (iso: string) => iso.slice(0, 10)

/** Facts run on across a band: a bold label, its value, then the next — wrapping, never squeezed. */
function Facts({ items }: { items: Array<[string, React.ReactNode, boolean?] | null | false> }) {
  const shown = items.filter(Boolean) as Array<[string, React.ReactNode, boolean?]>
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', columnGap: '18px', rowGap: '1px' }}>
      {shown.map(([label, value, mono]) => (
        <span key={label}>
          <span style={{ fontWeight: 700 }}>{label}</span>
          <span style={{ marginLeft: '5px', ...(mono && value ? CODE : {}) }}>{value || value === 0 ? value : <Dash />}</span>
        </span>
      ))}
    </div>
  )
}

/**
 * A department's sheet for one job card, to print and keep on the floor —
 * the cutting sheet (sizes across: the order's count, actual cutting, sent
 * on, then each day's in and out) or a process sheet (bundle by bundle: date,
 * in, out, damaged, balance, sign), with blank lines below for the day's
 * entries before they are put in.
 *
 * Laid out like the purchase order (27 Nov 2026): the department the sheet is
 * for in the "To," block with the order's facts under it and the sheet's
 * number, date and references beside it, the lay or the stage in a band.
 */
function Sheet() {
  const { id } = useParams<{ id: string }>()
  const stepId = useSearchParams().get('step') ?? ''
  const [data, setData] = useState<Payload | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    api
      .get<{ data: Payload }>(`/production/job-cards/${id}/print?stepId=${encodeURIComponent(stepId)}`)
      .then((res) => setData(res.data))
      .catch((err) => setError(err instanceof ApiError ? err.message : 'Could not open that sheet.'))
  }, [id, stepId])

  if (error) return <p style={{ padding: 48, color: INK }}>{error}</p>
  if (!data) return <p style={{ padding: 48, color: MUTED }}>Opening the sheet…</p>

  const { company, detail: d } = data
  const step = d.steps.find((s) => s.id === stepId) ?? d.steps[0]
  if (!step) return <p style={{ padding: 48, color: INK }}>This job card has no stages yet.</p>
  const c = d.card
  const sizes = d.line?.sizes ?? []
  const cut = d.steps.find((s) => s.kind === 'CUTTING')?.figures?.completed ?? 0
  const next = step.next?.name ?? 'Finished goods'
  const number = data.series ?? refNo(c)

  // The department the sheet is for, the order's facts under it; the sheet's
  // own number, date and references beside it.
  const party: SheetParty = {
    heading: 'To,',
    name: `${step.department.name} department`,
    code: step.execution === 'OUTSOURCED' ? '(outside unit)' : null,
    lines: (
      <>
        <PartyLine label="Order no." value={c.orderNo ?? c.so?.customerPORef ?? null} />
        <PartyLine label="Description" value={c.description} />
        <PartyLine label="Fabric quality" value={c.fabricQuality} />
        <PartyLine label="Colour" value={d.line?.color ?? null} />
        <PartyLine label="Print / design" value={c.designNo} mono />
        <PartyLine label="Lot no." value={lotOf(d)?.lot ?? null} />
      </>
    ),
    meta: [
      ['Sheet No', number, true],
      ['Date', shortDate(new Date()), true],
      // The reference is the number when the department has no challan run yet.
      !!data.series && ['Ref no.', refNo(c), true],
      ['Project ID', c.projectId],
      ['Mfg. order', d.mo.moNumber, true],
      ['Job card', c.jobCardNumber, true],
    ],
  }

  if (step.kind === 'CUTTING') {
    const fig = (sizeId: string) => d.sizeFigures[sizeId]?.find((f) => f.stepId === step.id)
    // The order's own sizes, eight to a row as on the old paper sheet: past
    // eight, the next eight get a size row of their own with their figures under it.
    const PER_ROW = 8
    const chunks = Array.from({ length: Math.max(1, Math.ceil(sizes.length / PER_ROW)) }, (_, i) => sizes.slice(i * PER_ROW, (i + 1) * PER_ROW))
    const slots = Math.max(1, chunks.length > 1 ? PER_ROW : sizes.length)
    const columns: SheetColumn[] = [
      { key: 'what', head: 'Sizes', width: '22%' },
      ...Array.from({ length: slots }, (_, i) => ({ key: `s${i}`, head: chunks[0][i]?.code ?? '', width: `${(66 / slots).toFixed(3)}%`, align: 'center' as const })),
      { key: 'total', head: 'Total', width: '12%', align: 'right' },
    ]
    const sizeRow = (chunk: typeof sizes, k: number) => ({
      key: `sizes${k}`,
      cells: {
        what: <strong>Sizes</strong>,
        ...Object.fromEntries(chunk.map((z, i) => [`s${i}`, <strong key={z.id}>{z.code}</strong>])),
        total: <strong>Total</strong>,
      },
    })
    const ordered = (sizeId: string) => sizes.find((z) => z.id === sizeId)?.qty ?? 0
    const cutQty = (sizeId: string) => fig(sizeId)?.completed ?? 0
    const sentQty = (sizeId: string) => fig(sizeId)?.sentOn ?? 0
    const figureRows = (chunk: typeof sizes, k: number) => {
      const row = (key: string, label: string, get: (sizeId: string) => number, strong = false) => {
        const total = chunk.reduce((s, z) => s + get(z.id), 0)
        return {
          key: `${key}${k}`,
          cells: {
            what: <span style={{ fontWeight: strong ? 700 : 500 }}>{label}</span>,
            ...Object.fromEntries(chunk.map((z, i) => [`s${i}`, get(z.id) ? (strong ? <strong>{qty(get(z.id))}</strong> : qty(get(z.id))) : ''])),
            total: total ? (strong ? <strong>{qty(total)}</strong> : qty(total)) : '',
          },
        }
      }
      return [row('count', 'Count (order)', ordered), row('cut', 'Actual cutting', cutQty, true), row('out', `Sent to ${next}`, sentQty)]
    }
    const sizeRows: Array<{ key: string; cells: Record<string, React.ReactNode> }> = chunks.flatMap((chunk, k) => [...(k ? [sizeRow(chunk, k)] : []), ...figureRows(chunk, k)])
    // All the sizes together, under the table as the purchase order puts its totals.
    const all = (get: (sizeId: string) => number) => sizes.reduce((s, z) => s + get(z.id), 0)

    const entries = d.log.filter((e) => e.stepId === step.id)
    const ins = entries.filter((e) => e.type === 'CUT' && e.qty > 0)
    const outs = entries.filter((e) => (e.type === 'DISPATCH' || e.type === 'EXCESS') && e.bucket === 'DONE' && e.qty < 0)
    const days = [...new Set([...ins, ...outs].map((e) => day(e.date)))].sort()
    // Room for the days still to come, as on the paper sheet. Six days to a
    // grid: past six, the next six get a grid of their own, so a column never
    // gets too narrow to write in.
    const DAYS = 6
    const shown = [...days, ...Array.from({ length: Math.max(0, DAYS - days.length) }, () => '')]
    const dayChunks = Array.from({ length: Math.ceil(shown.length / DAYS) }, (_, i) => {
      const part = shown.slice(i * DAYS, (i + 1) * DAYS)
      return [...part, ...Array.from({ length: DAYS - part.length }, () => '')]
    })
    const sum = (list: typeof entries, date: string, sizeId: string) => list.filter((e) => day(e.date) === date && e.sizeId === sizeId).reduce((s, e) => s + Math.abs(e.qty), 0)
    // The grid is drawn with the kit's own rules: a box edge round it, hairlines inside.
    const th: React.CSSProperties = {
      border: HAIR,
      padding: '3px 3px',
      fontSize: '7.5px',
      fontWeight: 700,
      letterSpacing: '.04em',
      textTransform: 'uppercase',
      textAlign: 'center',
      lineHeight: 1.25,
      overflowWrap: 'anywhere',
    }
    const td: React.CSSProperties = { border: HAIR, padding: '3px 3px', fontSize: '9px', textAlign: 'center', height: '18px', overflowWrap: 'anywhere', ...CODE }
    const contractors = d.cuttings.filter((x) => x.status !== 'CANCELLED')

    return (
      <StoreSheet
        company={company}
        title={data.template.title}
        number={number}
        dateLabel="Department"
        date={`CUTTING · ${longDate(new Date()) ?? ''}`}
        backHref="/production/floor?tab=stages"
        backLabel="Production stages"
        party={party}
        bands={[
          {
            label: 'The lay',
            body: (
              <Facts
                items={[
                  ['Metres', c.meters != null ? qty(c.meters) : null],
                  ['Average', c.average != null ? `${qty(c.average)} m a piece` : null],
                  ['Ratio', c.ratio],
                ]}
              />
            ),
          },
        ]}
        columns={columns}
        rows={sizeRows}
        after={
          <>
            <WordsAndTotals
              words={null}
              left={
                <Note title="Cutting contractors">
                  {contractors.length
                    ? contractors
                        .map((x) => `${x.cutOrderNumber} ${x.cutterName ?? ''} — ${x.status === 'COMPLETED' ? `${qty(x.actualPieces)} cut of ${qty(x.plannedPieces)}` : `${qty(x.plannedPieces)} issued`}`)
                        .join('\n')
                    : <Dash />}
                </Note>
              }
              totals={
                <TotalsBox
                  rows={[
                    { label: 'Order qty', value: qty(d.line?.totalQty ?? all(ordered)) },
                    { label: `Sent to ${next}`, value: qty(all(sentQty)) },
                  ]}
                  totalLabel="Actual cutting"
                  total={qty(all(cutQty))}
                />
              }
            />

            <Eyebrow style={{ marginTop: '10px' }}>For the cutting department — in and out, day by day</Eyebrow>
            {dayChunks.map((part, k) => (
              <table
                key={k}
                className="doc-lines"
                style={{ width: '100%', borderCollapse: 'collapse', tableLayout: 'fixed', border: LINE, marginTop: k ? '6px' : '3px' }}
              >
                <colgroup>
                  <col style={{ width: '10%' }} />
                  {part.flatMap((_, i) => [<col key={`i${i}`} style={{ width: `${(90 / (DAYS * 2)).toFixed(3)}%` }} />, <col key={`o${i}`} style={{ width: `${(90 / (DAYS * 2)).toFixed(3)}%` }} />])}
                </colgroup>
                <thead>
                  <tr>
                    <th style={{ ...th, textAlign: 'left' }}>Dates</th>
                    {part.map((dt, i) => (
                      <th key={i} colSpan={2} style={{ ...th, ...CODE }}>
                        {dt ? shortDate(dt) : ''}
                      </th>
                    ))}
                  </tr>
                  <tr>
                    <th style={{ ...th, textAlign: 'left', borderBottom: LINE }}>Sizes</th>
                    {part.flatMap((_, i) => [
                      <th key={`i${i}`} style={{ ...th, borderBottom: LINE }}>
                        In
                      </th>,
                      <th key={`o${i}`} style={{ ...th, borderBottom: LINE }}>
                        Out
                      </th>,
                    ])}
                  </tr>
                </thead>
                <tbody>
                  {sizes.map((z) => (
                    <tr key={z.id}>
                      <td style={{ ...td, textAlign: 'left', fontWeight: 600 }}>{z.code}</td>
                      {part.flatMap((dt, i) => [
                        <td key={`i${i}`} style={td}>
                          {dt && sum(ins, dt, z.id) ? qty(sum(ins, dt, z.id)) : ''}
                        </td>,
                        <td key={`o${i}`} style={td}>
                          {dt && sum(outs, dt, z.id) ? qty(sum(outs, dt, z.id)) : ''}
                        </td>,
                      ])}
                    </tr>
                  ))}
                  <tr>
                    <td style={{ ...td, textAlign: 'left', fontWeight: 600, height: '24px' }}>Sign</td>
                    {part.map((dt, i) => (
                      <td key={i} colSpan={2} style={{ ...td, fontSize: '8px', height: '24px', letterSpacing: 0 }}>
                        {dt ? [...new Set([...ins, ...outs].filter((e) => day(e.date) === dt).map((e) => e.person ?? e.by))].join(', ') : ''}
                      </td>
                    ))}
                  </tr>
                </tbody>
              </table>
            ))}
          </>
        }
        signatures={[
          { role: 'Prepared by', who: null },
          { role: 'Cutting master', who: null },
          { role: 'Issued by (authorised signatory)', who: null },
        ]}
        footerNote={data.template.footerNote ?? 'For the cutting department. Each bundle carries its own sticker; send them on to the next department on a process transfer.'}
      />
    )
  }

  const rows = sheetRows(d, step)
  const check = isCheck(step)
  const columns: SheetColumn[] = [
    { key: 'date', head: 'Date', width: '11%' },
    { key: 'bundle', head: 'Bundle no.', width: '17%' },
    { key: 'size', head: 'Size', width: '7%', align: 'center' },
    { key: 'in', head: 'In', width: '9%', align: 'right' },
    { key: 'out', head: 'Out', width: '9%', align: 'right' },
    { key: 'damaged', head: check ? 'Failed / damaged' : 'Damaged qty', width: '12%', align: 'right' },
    { key: 'total', head: 'Total', width: '9%', align: 'right' },
    { key: 'sign', head: 'Sign', width: '26%' },
  ]
  return (
    <StoreSheet
      company={company}
      title={`${step.name.toUpperCase()} SHEET`}
      number={number}
      dateLabel="Department"
      date={`${step.department.name.toUpperCase()} · ${longDate(new Date()) ?? ''}`}
      backHref="/production/floor?tab=stages"
      backLabel="Production stages"
      party={party}
      bands={[
        {
          label: step.name,
          body: (
            <Facts
              items={[
                ['Next', next],
                ['Average', c.average != null ? `${qty(c.average)} m` : null],
                ['Order qty', qty(d.line?.totalQty ?? 0)],
                ['Cutting qty', qty(cut)],
              ]}
            />
          ),
        },
      ]}
      columns={columns}
      minRows={Math.max(12, rows.length + 6)}
      rows={rows.map((r) => ({
        key: r.key,
        cells: {
          date: <span style={CODE}>{shortDate(r.date)}</span>,
          bundle: <span style={CODE}>{r.bundle}</span>,
          size: r.size ?? '',
          in: r.in ? qty(r.in) : '',
          out: r.out ? qty(r.out) : '',
          damaged: r.damaged + r.rejected ? qty(r.damaged + r.rejected) : '',
          total: qty(r.balance),
          // A size change moves pieces to or from another bundle: said here, as the paper sheet would note it.
          sign: (
            <span style={{ fontSize: '8.5px' }}>
              {r.sizeNote ? `${r.sizeNote} · ` : ''}
              {r.sign}
              {r.document ? ` · ${r.document}` : ''}
            </span>
          ),
        },
      }))}
      signatures={[
        { role: 'Issuer sign', who: null },
        { role: 'Receiver sign', who: null },
        { role: 'Issued by (authorised signatory)', who: null },
      ]}
      footerNote={data.template.footerNote ?? `For the ${step.department.name.toLowerCase()} department. Please sign while issuing and receiving the quantity.`}
    />
  )
}

// useSearchParams needs a Suspense boundary or the build refuses the route.
export default function PrintSheet() {
  return (
    <Suspense fallback={<p style={{ padding: 48, color: MUTED }}>Opening the sheet…</p>}>
      <Sheet />
    </Suspense>
  )
}
