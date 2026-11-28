'use client'

import { useEffect, useState } from 'react'
import { useParams } from 'next/navigation'
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
} from '@/components/print/StoreSheet'
import { DocTable, type DocColumn } from '@/components/print/doc'
import { refNo, type JobCardDetail } from '@/components/production/floor/types'
import { moCustomer } from '@/components/production/moCustomer'

interface Payload {
  /** The own brand the order is made under, carried from start to end. */
  brand?: { name: string; type: string } | null
  company: Record<string, string | null>
  template: { title: string; footerNote: string | null }
  detail: JobCardDetail
}

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
 * The job card, to print: the order and its references, the fabric, colour
 * and design, metres, average and ratio, the count by size — and the process
 * forms it goes through in order, with how far each has got.
 *
 * Laid out like the purchase order (27 Nov 2026): who the order is for in the
 * "For," block with the card's number, date and references beside it, the
 * fabric in a band, the count by size, metres and average beside the pieces,
 * then the process forms to sign.
 */
export default function PrintJobCard() {
  const { id } = useParams<{ id: string }>()
  const [data, setData] = useState<Payload | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    api
      .get<{ data: Payload }>(`/production/job-cards/${id}/print`)
      .then((res) => setData(res.data))
      .catch((err) => setError(err instanceof ApiError ? err.message : 'Could not open that job card.'))
  }, [id])

  if (error) return <p style={{ padding: 48, color: INK }}>{error}</p>
  if (!data) return <p style={{ padding: 48, color: MUTED }}>Opening the job card…</p>

  const { company, template, detail: d } = data
  const c = d.card
  const sizes = d.line?.sizes ?? []
  const customer = moCustomer(d.mo)

  // Sizes run across the page. Past ten, the label and total give up some room
  // and the figures drop a point, so every size keeps a column of its own.
  const many = sizes.length > 10
  const labelW = many ? 12 : 22
  const totalW = many ? 10 : 12
  const columns: SheetColumn[] = [
    { key: 'what', head: 'Sizes', width: `${labelW}%` },
    ...sizes.map((z) => ({
      key: z.id,
      head: z.code,
      width: `${((100 - labelW - totalW) / Math.max(1, sizes.length)).toFixed(3)}%`,
      align: 'center' as const,
    })),
    { key: 'total', head: 'Total', width: `${totalW}%`, align: 'right' },
  ]
  const fig = (v: React.ReactNode) => (many ? <span style={{ fontSize: '8.5px' }}>{v}</span> : v)

  const steps: DocColumn[] = [
    { key: 'seq', head: '#', width: '5%', align: 'center' },
    { key: 'stage', head: 'Stage', width: '22%' },
    { key: 'dept', head: 'Department', width: '16%' },
    { key: 'in', head: 'In', width: '9%', align: 'right' },
    { key: 'done', head: 'Processed', width: '11%', align: 'right' },
    { key: 'out', head: 'Out', width: '9%', align: 'right' },
    { key: 'damaged', head: 'Damaged', width: '10%', align: 'right' },
    { key: 'sign', head: 'Sign', width: '18%' },
  ]

  return (
    <StoreSheet
      company={company}
      title={template.title}
      number={c.jobCardNumber}
      dateLabel="Made on"
      date={longDate(c.createdAt) ?? ''}
      backHref="/production/floor"
      backLabel="Job cards"
      party={{
        heading: 'For,',
        // A direct order with no customer is made for the brand's own stock.
        name: customer ?? data.brand?.name ?? d.mo.moNumber,
        lines: (
          <>
            <PartyLine label="Order no." value={c.orderNo ?? c.so?.customerPORef ?? null} />
            <PartyLine label="Description" value={c.description} />
            <PartyLine label="Style" value={d.line ? `${d.line.style.code} · ${d.line.style.name}` : null} />
            <PartyLine label="Colour" value={d.line?.color ?? null} />
            <PartyLine label="Print / design" value={c.designNo} mono />
            <PartyLine label="Brand" value={data.brand?.name ?? null} />
          </>
        ),
        meta: [
          ['Job Card No', c.jobCardNumber, true],
          ['Made on', shortDate(c.createdAt), true],
          ['Ref no.', refNo(c), true],
          ['Mfg. order', d.mo.moNumber, true],
          ['Project ID', c.projectId],
        ],
      }}
      bands={[
        {
          label: 'Fabric',
          body: (
            <>
              <div style={{ fontSize: '11px', fontWeight: 800, textTransform: 'uppercase' }}>{c.fabricQuality || <Dash />}</div>
              <Facts
                items={[
                  ['Ratio', c.ratio],
                  ['Lot no.', c.lotNo],
                ]}
              />
            </>
          ),
        },
      ]}
      columns={columns}
      rows={[
        {
          key: 'count',
          cells: {
            what: <strong>Count</strong>,
            ...Object.fromEntries(sizes.map((z) => [z.id, fig(qty(z.qty))])),
            total: <strong>{qty(d.line?.totalQty ?? 0)}</strong>,
          },
        },
      ]}
      after={
        <>
          <WordsAndTotals
            words={null}
            left={<Note title="Notes">{c.notes || <Dash />}</Note>}
            totals={
              <TotalsBox
                rows={[
                  { label: 'Metres', value: c.meters != null ? qty(c.meters) : <Dash /> },
                  { label: 'Average', value: c.average != null ? `${qty(c.average)} m a piece` : <Dash /> },
                ]}
                totalLabel="Pieces"
                total={qty(d.line?.totalQty ?? 0)}
              />
            }
          />

          <Eyebrow style={{ marginTop: '10px' }}>Process forms, in order</Eyebrow>
          <DocTable
            style={{ marginTop: '3px' }}
            columns={steps}
            rows={d.steps.map((s) => {
              const f = s.figures
              return {
                key: s.id,
                cells: {
                  seq: s.sequence,
                  stage: (
                    <>
                      {s.name}
                      {s.execution === 'OUTSOURCED' ? ' (outside)' : ''}
                      {s.skippedAt ? ' — left out' : ''}
                    </>
                  ),
                  dept: s.department.name,
                  in: f?.received ? qty(f.received) : '',
                  done: f?.completed ? qty(f.completed) : '',
                  out: s.last ? (f?.packed ? qty(f.packed) : '') : f?.sentOn ? qty(f.sentOn) : '',
                  damaged: f && f.damaged + f.rejected ? qty(f.damaged + f.rejected) : '',
                  sign: '',
                },
              }
            })}
          />
        </>
      }
      signatures={[
        { role: 'Prepared by', who: null },
        { role: 'Production manager', who: null },
        { role: 'Issued by (authorised signatory)', who: null },
      ]}
      footerNote={template.footerNote ?? 'One job card for each colour of the order. Its cutting sheet and process sheets carry the same reference.'}
    />
  )
}
