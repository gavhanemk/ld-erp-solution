'use client'

import { Suspense, useEffect, useState } from 'react'
import { useParams, useSearchParams } from 'next/navigation'
import { api, ApiError } from '@/lib/api'
import { StoreSheet, Fact, Eyebrow, qty, longDate, CODE, GREY, INK, MUTED, RULE, TINT, type SheetColumn } from '@/components/print/StoreSheet'
import { sheetRows } from '@/components/production/floor/StageSheet'
import { isCheck, refNo, type JobCardDetail } from '@/components/production/floor/types'

interface Payload {
  company: Record<string, string | null>
  template: { title: string; footerNote: string | null }
  detail: JobCardDetail
  /** The department's challan run on this order, e.g. CUT/2627-0002. */
  series: string | null
}

const day = (iso: string) => iso.slice(0, 10)

/**
 * A department's sheet for one job card, to print and keep on the floor —
 * the cutting sheet (sizes across: the order's count, actual cutting, sent
 * on, then each day's in and out) or a process sheet (bundle by bundle: date,
 * in, out, damaged, balance, sign), with blank lines below for the day's
 * entries before they are put in.
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

  const panels = [
    {
      title: 'Order',
      body: (
        <>
          <Fact label="Ref no." value={refNo(c)} mono />
          <Fact label="Order no." value={c.orderNo ?? c.so?.customerPORef ?? null} />
          <Fact label="Project ID" value={c.projectId} />
          <Fact label="Description" value={c.description} />
          <Fact label="Mfg. order" value={`${d.mo.moNumber} · ${c.jobCardNumber}`} mono />
        </>
      ),
    },
    {
      title: 'Fabric',
      body: (
        <>
          <Fact label="Fabric quality" value={c.fabricQuality} />
          <Fact label="Colour" value={d.line?.color ?? null} />
          <Fact label="Design no." value={c.designNo} mono />
          <Fact label="Lot no." value={c.lotNo} />
        </>
      ),
    },
    step.kind === 'CUTTING'
      ? {
          title: 'Lay',
          body: (
            <>
              <Fact label="Metres" value={c.meters != null ? qty(c.meters) : null} />
              <Fact label="Average" value={c.average != null ? `${qty(c.average)} m a piece` : null} />
              <Fact label="Ratio" value={c.ratio} />
              <Fact label="Order qty" value={qty(d.line?.totalQty ?? 0)} />
            </>
          ),
        }
      : {
          title: step.name,
          body: (
            <>
              <Fact label="Department" value={`${step.department.name}${step.execution === 'OUTSOURCED' ? ' (outside unit)' : ''}`} />
              <Fact label="Average" value={c.average != null ? `${qty(c.average)} m` : null} />
              <Fact label="Order qty" value={qty(d.line?.totalQty ?? 0)} />
              <Fact label="Cutting qty" value={qty(cut)} />
              <Fact label="Next" value={next} />
            </>
          ),
        },
  ]

  if (step.kind === 'CUTTING') {
    const fig = (sizeId: string) => d.sizeFigures[sizeId]?.find((f) => f.stepId === step.id)
    // The order's own sizes, eight to a row as on the old paper sheet: past
    // eight, the next eight get a size row of their own with their figures under it.
    const PER_ROW = 8
    const chunks = Array.from({ length: Math.max(1, Math.ceil(sizes.length / PER_ROW)) }, (_, i) => sizes.slice(i * PER_ROW, (i + 1) * PER_ROW))
    const slots = Math.max(1, chunks.length > 1 ? PER_ROW : sizes.length)
    const columns: SheetColumn[] = [
      { key: 'what', head: 'Sizes', width: '22%' },
      ...Array.from({ length: slots }, (_, i) => ({ key: `s${i}`, head: chunks[0][i]?.code ?? '', width: `${Math.floor(66 / slots)}%`, align: 'center' as const })),
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
      return [
        row('count', 'Count (order)', (s) => sizes.find((z) => z.id === s)?.qty ?? 0),
        row('cut', 'Actual cutting', (s) => fig(s)?.completed ?? 0, true),
        row('out', `Sent to ${next}`, (s) => fig(s)?.sentOn ?? 0),
      ]
    }
    const sizeRows: Array<{ key: string; cells: Record<string, React.ReactNode> }> = chunks.flatMap((chunk, k) => [...(k ? [sizeRow(chunk, k)] : []), ...figureRows(chunk, k)])
    if (chunks.length > 1) {
      const all = (get: (sizeId: string) => number) => sizes.reduce((s, z) => s + get(z.id), 0)
      sizeRows.push({
        key: 'grand',
        cells: {
          what: <strong>All sizes</strong>,
          total: (
            <span>
              <strong>{qty(all((s) => sizes.find((z) => z.id === s)?.qty ?? 0))}</strong> ordered
              {all((s) => fig(s)?.completed ?? 0) ? ` · ${qty(all((s) => fig(s)?.completed ?? 0))} cut` : ''}
            </span>
          ),
        },
      })
    }
    const entries = d.log.filter((e) => e.stepId === step.id)
    const ins = entries.filter((e) => e.type === 'CUT' && e.qty > 0)
    const outs = entries.filter((e) => (e.type === 'DISPATCH' || e.type === 'EXCESS') && e.bucket === 'DONE' && e.qty < 0)
    const days = [...new Set([...ins, ...outs].map((e) => day(e.date)))].sort()
    // Room for the days still to come, as on the paper sheet.
    const shown = [...days, ...Array.from({ length: Math.max(0, 6 - days.length) }, () => '')]
    const sum = (list: typeof entries, date: string, sizeId: string) => list.filter((e) => day(e.date) === date && e.sizeId === sizeId).reduce((s, e) => s + Math.abs(e.qty), 0)
    const cell: React.CSSProperties = { border: `1px solid ${RULE}`, padding: '3px 4px', fontSize: '9px', textAlign: 'center', ...CODE }
    return (
      <StoreSheet
        company={company}
        title={data.template.title}
        number={data.series ?? refNo(c)}
        dateLabel="Department"
        date={`CUTTING · ${longDate(new Date()) ?? ''}`}
        backHref="/production/stages"
        backLabel="Production stages"
        panels={panels}
        columns={columns}
        rows={sizeRows}
        after={
          <div style={{ border: `1px solid ${RULE}`, marginTop: '8px' }}>
            <div style={{ background: TINT, borderBottom: `1px solid ${RULE}`, padding: '5px 10px' }}>
              <Eyebrow>For the cutting department — in and out, day by day</Eyebrow>
            </div>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr>
                  <th style={{ ...cell, textAlign: 'left' }}>Dates</th>
                  {shown.map((dt, i) => (
                    <th key={i} colSpan={2} style={cell}>
                      {dt ? longDate(dt) : ''}
                    </th>
                  ))}
                </tr>
                <tr>
                  <th style={{ ...cell, textAlign: 'left' }}>Sizes</th>
                  {shown.map((_, i) => [
                    <th key={`i${i}`} style={cell}>
                      In
                    </th>,
                    <th key={`o${i}`} style={cell}>
                      Out
                    </th>,
                  ])}
                </tr>
              </thead>
              <tbody>
                {sizes.map((z) => (
                  <tr key={z.id}>
                    <td style={{ ...cell, textAlign: 'left', fontWeight: 600 }}>{z.code}</td>
                    {shown.map((dt, i) => [
                      <td key={`i${i}`} style={cell}>
                        {dt && sum(ins, dt, z.id) ? qty(sum(ins, dt, z.id)) : ''}
                      </td>,
                      <td key={`o${i}`} style={cell}>
                        {dt && sum(outs, dt, z.id) ? qty(sum(outs, dt, z.id)) : ''}
                      </td>,
                    ])}
                  </tr>
                ))}
                <tr>
                  <td style={{ ...cell, textAlign: 'left', fontWeight: 600 }}>Sign</td>
                  {shown.map((dt, i) => (
                    <td key={i} colSpan={2} style={{ ...cell, color: GREY }}>
                      {dt ? [...new Set([...ins, ...outs].filter((e) => day(e.date) === dt).map((e) => e.person ?? e.by))].join(', ') : ''}
                    </td>
                  ))}
                </tr>
              </tbody>
            </table>
            {d.cuttings.some((x) => x.status !== 'CANCELLED') && (
              <div style={{ padding: '6px 10px', fontSize: '9px', color: GREY, borderTop: `1px solid ${RULE}` }}>
                Cutting contractors:{' '}
                {d.cuttings
                  .filter((x) => x.status !== 'CANCELLED')
                  .map((x) => `${x.cutOrderNumber} ${x.cutterName ?? ''} — ${x.status === 'COMPLETED' ? `${qty(x.actualPieces)} cut of ${qty(x.plannedPieces)}` : `${qty(x.plannedPieces)} issued`}`)
                  .join(' · ')}
              </div>
            )}
          </div>
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
      number={data.series ?? refNo(c)}
      dateLabel="Department"
      date={`${step.department.name.toUpperCase()} · ${longDate(new Date()) ?? ''}`}
      backHref="/production/stages"
      backLabel="Production stages"
      panels={panels}
      columns={columns}
      minRows={Math.max(12, rows.length + 6)}
      rows={rows.map((r) => ({
        key: r.key,
        cells: {
          date: longDate(r.date),
          bundle: <span style={CODE}>{r.bundle}</span>,
          size: r.size ?? '',
          in: r.in ? qty(r.in) : '',
          out: r.out ? qty(r.out) : '',
          damaged: r.damaged + r.rejected ? qty(r.damaged + r.rejected) : '',
          total: qty(r.balance),
          sign: <span style={{ color: GREY }}>{r.sign}{r.document ? ` · ${r.document}` : ''}</span>,
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
