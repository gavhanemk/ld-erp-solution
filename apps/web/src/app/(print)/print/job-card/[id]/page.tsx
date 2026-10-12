'use client'

import { useEffect, useState } from 'react'
import { useParams } from 'next/navigation'
import { api, ApiError } from '@/lib/api'
import { StoreSheet, Fact, Eyebrow, qty, longDate, GREY, INK, MUTED, RULE, TINT, type SheetColumn } from '@/components/print/StoreSheet'
import { refNo, type JobCardDetail } from '@/components/production/floor/types'

interface Payload {
  company: Record<string, string | null>
  template: { title: string; footerNote: string | null }
  detail: JobCardDetail
}

/**
 * The job card, to print: the order and its references, the fabric, colour
 * and design, metres, average and ratio, the count by size — and the process
 * forms it goes through in order, with how far each has got.
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
  const columns: SheetColumn[] = [
    { key: 'what', head: 'Sizes', width: '22%' },
    ...sizes.map((z) => ({ key: z.id, head: z.code, width: `${Math.floor(66 / Math.max(1, sizes.length))}%`, align: 'center' as const })),
    { key: 'total', head: 'Total', width: '12%', align: 'right' },
  ]
  const cell: React.CSSProperties = { border: `1px solid ${RULE}`, padding: '4px 6px', fontSize: '9.5px' }

  return (
    <StoreSheet
      company={company}
      title={template.title}
      number={c.jobCardNumber}
      dateLabel="Made on"
      date={longDate(c.createdAt) ?? ''}
      backHref="/production/job-cards"
      backLabel="Job cards"
      panels={[
        {
          title: 'Order',
          body: (
            <>
              <Fact label="Ref no." value={refNo(c)} mono />
              <Fact label="Order no." value={c.orderNo ?? c.so?.customerPORef ?? null} />
              <Fact label="Project ID" value={c.projectId} />
              <Fact label="Mfg. order" value={d.mo.moNumber} mono />
              <Fact label="Customer" value={d.mo.so?.customer.name ?? null} />
            </>
          ),
        },
        {
          title: 'Garment',
          body: (
            <>
              <Fact label="Description" value={c.description} />
              <Fact label="Style" value={d.line ? `${d.line.style.code} · ${d.line.style.name}` : null} />
              <Fact label="Colour" value={d.line?.color ?? null} />
              <Fact label="Design no." value={c.designNo} mono />
            </>
          ),
        },
        {
          title: 'Fabric',
          body: (
            <>
              <Fact label="Fabric quality" value={c.fabricQuality} />
              <Fact label="Metres" value={c.meters != null ? qty(c.meters) : null} />
              <Fact label="Average" value={c.average != null ? `${qty(c.average)} m a piece` : null} />
              <Fact label="Ratio" value={c.ratio} />
              <Fact label="Lot no." value={c.lotNo} />
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
            ...Object.fromEntries(sizes.map((z) => [z.id, qty(z.qty)])),
            total: <strong>{qty(d.line?.totalQty ?? 0)}</strong>,
          },
        },
      ]}
      after={
        <div style={{ border: `1px solid ${RULE}`, marginTop: '8px' }}>
          <div style={{ background: TINT, borderBottom: `1px solid ${RULE}`, padding: '5px 10px' }}>
            <Eyebrow>Process forms, in order</Eyebrow>
          </div>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                {['#', 'Stage', 'Department', 'In', 'Processed', 'Out', 'Damaged', 'Sign'].map((h) => (
                  <th key={h} style={{ ...cell, textAlign: h === 'Stage' || h === 'Department' || h === 'Sign' ? 'left' : 'right' }}>
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {d.steps.map((s) => {
                const f = s.figures
                return (
                  <tr key={s.id}>
                    <td style={{ ...cell, textAlign: 'right' }}>{s.sequence}</td>
                    <td style={cell}>
                      {s.name}
                      {s.execution === 'OUTSOURCED' ? ' (outside)' : ''}
                      {s.skippedAt ? ' — left out' : ''}
                    </td>
                    <td style={{ ...cell, color: GREY }}>{s.department.name}</td>
                    <td style={{ ...cell, textAlign: 'right' }}>{f?.received ? qty(f.received) : ''}</td>
                    <td style={{ ...cell, textAlign: 'right' }}>{f?.completed ? qty(f.completed) : ''}</td>
                    <td style={{ ...cell, textAlign: 'right' }}>{s.last ? (f?.packed ? qty(f.packed) : '') : f?.sentOn ? qty(f.sentOn) : ''}</td>
                    <td style={{ ...cell, textAlign: 'right' }}>{f && f.damaged + f.rejected ? qty(f.damaged + f.rejected) : ''}</td>
                    <td style={{ ...cell, width: '22%' }} />
                  </tr>
                )
              })}
            </tbody>
          </table>
          {c.notes && <div style={{ padding: '6px 10px', fontSize: '9.5px', color: GREY, borderTop: `1px solid ${RULE}` }}>{c.notes}</div>}
        </div>
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
