'use client'

import { useEffect, useState } from 'react'
import { useParams } from 'next/navigation'
import { api, apiErrorMessage } from '@/lib/api'
import {
  StoreSheet,
  Eyebrow,
  Fact,
  Panel,
  longDate,
  money,
  qty,
  GREY,
  INK,
  MUTED,
  RULE,
  TINT,
} from '@/components/print/StoreSheet'
import {
  SAMPLE_ATTACHMENT_KINDS,
  SAMPLE_MATERIAL_SOURCE_LABEL,
  SAMPLE_STATE_LABEL,
  STYLE_STAGE_LABEL,
  lineRequiredQty,
  normaliseDecision,
  normaliseQc,
  SAMPLE_COLOUR_RESULT_LABEL,
  SAMPLE_DISPATCH_MODE_LABEL,
  type SampleAttachmentKind,
} from '@ld-erp/shared'
import {
  colourGrid,
  colourSummary,
  eventLabel,
  eventNote,
  fileScope,
  lineColour,
  lineItem,
  materialHeld,
  measureMatrix,
  stepFacts,
} from '@/components/sampling/samplingFlow'
import {
  materialCost,
  MATERIAL_COST_LABEL,
  plural,
  rateFigure,
} from '@/components/sampling/specRules'
import type { Lookups, SampleRequest, SampleRound } from '@/components/sampling/types'

/** A file as the printed record has it: what it is and when it came, never where it is kept. */
interface PrintedFile {
  id: string
  roundId: string | null
  kind: SampleAttachmentKind
  kindLabel: string
  fileName: string
  createdAt: string
}
interface Payload {
  company: Record<string, string | null> | null
  request: Omit<SampleRequest, 'attachments'> & { attachments: PrintedFile[] }
  lookups: Lookups
}

export default function PrintSample() {
  const { id } = useParams<{ id: string }>()
  const [data, setData] = useState<Payload | null>(null)
  const [error, setError] = useState('')
  useEffect(() => {
    let active = true
    api
      .get<{ data: Payload }>(`/sampling/${id}/print`)
      .then((res) => {
        if (active) setData(res.data)
      })
      .catch((err) => {
        if (active) setError(apiErrorMessage(err, 'Could not open this sample.'))
      })
    return () => {
      active = false
    }
  }, [id])
  if (error) return <p className="bg-white p-8 text-red-700">{error}</p>
  if (!data) return <p className="bg-white p-8 text-slate-800">Opening sample record…</p>
  const { request, lookups } = data
  const size = (id: string) => lookups.sizes.find((s) => s.id === id)?.code ?? id
  const rows: Array<{ key: string; cells: Record<string, React.ReactNode> }> = []
  const add = (round: number | string, section: string, detail: string, result = '') => {
    rows.push({ key: String(rows.length), cells: { round, section, detail, result } })
  }
  // Old rounds remain on the record, including failed inspections and buyer decisions.
  // Each round's grid, measurements, materials and route print as tables below.
  for (const round of [...request.rounds].reverse()) {
    const s = round.specification
    const style = lookups.styles.find((x) => x.id === s.styleId)
    add(
      round.revision,
      s.milestone,
      `${style ? `${style.code} · ${style.name}` : s.styleId || 'Style pending'} · ${colourSummary(s)}`,
      SAMPLE_STATE_LABEL[round.state]
    )
    add(
      round.revision,
      'Technical specification',
      `Construction: ${s.construction || 'Pending'}\nTech pack: ${s.techPackRef || 'Pending'}\nPattern: ${s.patternRef || 'Pending'}\n${s.notes}`,
      `Round ${round.revision} specification below`
    )
    // What was issued and accounted for; a draft has issued nothing.
    if (round.state !== 'DRAFT')
      for (const m of round.materials) {
        const unit = m.item?.uom?.symbol ?? ''
        add(
          round.revision,
          'Material reconciliation',
          `${m.component ? `${m.component}: ` : ''}${m.item?.name ?? 'No material picked'} · ${lineColour(m.colour)} · ${m.warehouse?.name ?? 'Store not picked yet'}\nIssued ${qty(m.issuedQty)}; used ${qty(m.usedQty)}; waste ${qty(m.wasteQty)}; returned ${qty(m.returnedQty)} ${unit}`,
          `Held ${qty(materialHeld(m))} ${unit}`
        )
      }
    for (const stage of round.stages) {
      // Who did the work, the outside units' challans, and the labour where it is shown.
      const by = [
        ...new Set((round.works ?? []).filter((w) => w.stageId === stage.id && !w.undoneAt).map((w) => w.doneBy)),
      ]
      const challans = (round.jobWorks ?? [])
        .filter((j) => j.stageId === stage.id && !j.cancelledAt)
        .map((j) => `${j.number} · ${j.vendor?.name ?? 'outside unit'}`)
      const detail = stage.wholeStep
        ? [stage.responsible, stage.reference, stage.notes]
        : [
            by.length ? `Done by ${by.join(', ')}` : '',
            challans.length ? `Job work: ${challans.join('; ')}` : '',
            stage.labourAmount !== undefined && Number(stage.labourAmount) > 0
              ? `Labour ₹${money(stage.labourAmount)}`
              : '',
          ]
      add(
        round.revision,
        `${stage.sequence}. ${stage.name}`,
        detail.filter(Boolean).join('\n'),
        stage.completedAt
          ? `${stage.doneQty} done / ${stage.rejectedQty} rejected · ${longDate(stage.completedAt)}`
          : stage.doneQty !== null || stage.rejectedQty !== null
            ? `In progress: ${stage.doneQty ?? 0} done / ${stage.rejectedQty ?? 0} rejected so far`
            : 'Pending'
      )
    }
    // The inspection colour by colour, the challans the samples went on, and the buyer's word.
    const qc = normaliseQc(round.qc, s)
    if (qc) {
      const passedColours = qc.colours.filter((c) => c.passed).length
      add(
        round.revision,
        'Latest inspection',
        qc.notes,
        qc.whole
          ? `${qc.passed ? 'Passed' : 'Failed'} · ${qc.passedQty} pieces`
          : `${passedColours} of ${qc.colours.length} colours passed · ${qc.passedQty} pieces`
      )
      // Inspected whole before colours were: one set of readings, for the whole set.
      const blocks = qc.whole
        ? [{ colour: 'the whole set', passed: qc.passed, results: qc.results, cells: [], notes: '' }]
        : qc.colours
      for (const c of blocks) {
        add(
          round.revision,
          `QC · ${c.colour}`,
          [
            c.cells.map((z) => `${size(z.sizeId)}: ${z.passed} of ${z.finished} passed`).join(' · '),
            ...c.results.map(
              (point) =>
                `${size(point.sizeId)} · ${point.name}: actual ${point.actual}, target ${point.target} ± ${point.tolerance} ${point.unit}${point.pass ? '' : ' (outside tolerance)'}`
            ),
            c.notes,
          ]
            .filter(Boolean)
            .join('\n'),
          c.passed ? 'Passed' : 'Failed'
        )
      }
    }
    for (const d of round.dispatches ?? [])
      add(
        round.revision,
        `Sent to the buyer · ${d.number}`,
        [
          `${d.recipient} · ${SAMPLE_DISPATCH_MODE_LABEL[d.mode]}${d.courier ? ` ${d.courier}` : ''}${d.awb ? ` ${d.awb}` : ''}`,
          d.cells.map((c) => `${c.colour} ${size(c.sizeId)}: ${c.qty}`).join(' · '),
          d.cancelledAt ? `Cancelled: ${d.cancelReason}` : '',
        ]
          .filter(Boolean)
          .join('\n'),
        `${d.cells.reduce((t, c) => t + c.qty, 0)} pieces · ${longDate(d.sentOn)}`
      )
    if (round.submission)
      add(
        round.revision,
        'Buyer submission',
        `${round.submission.recipient} · ${round.submission.reference}\n${round.submission.notes}`,
        `${round.submission.qty} pieces`
      )
    const decision = normaliseDecision(round.decision, s)
    for (const c of Object.values(decision?.colours ?? {}))
      add(
        round.revision,
        `Buyer decision · ${c.colour}`,
        [c.buyerName, c.evidence, c.conditions].filter(Boolean).join('\n'),
        SAMPLE_COLOUR_RESULT_LABEL[c.result]
      )
    if (decision?.result)
      add(round.revision, 'Round decided', decision.conditions ?? '', SAMPLE_STATE_LABEL[decision.result])
    if (round.handover)
      add(
        round.revision,
        'Production handover',
        `BOM ${round.handover.bomVersion} · Routing v${round.handover.routingVersion}\nPrepared by ${round.handover.preparedBy}\n${round.handover.notes}`,
        round.handover.acceptedAt
          ? `Accepted by ${round.handover.acceptedBy} · ${longDate(round.handover.acceptedAt)}`
          : 'Acceptance pending'
      )
  }
  const sizeRun = (id: string) => lookups.sizeGroups?.find((g) => g.id === id)?.name ?? id
  for (const event of [...request.events].reverse()) {
    const note = eventNote(event, request.rounds, sizeRun)
    add(
      'History',
      eventLabel(event.action, event.detail.data),
      [event.detail.by ?? '', note].filter(Boolean).join('\n'),
      longDate(event.createdAt) ?? ''
    )
  }
  const style = request.style
  // Kinds in their usual order (tech pack first), oldest first within each.
  const files = [...(request.attachments ?? [])].sort(
    (a, b) =>
      SAMPLE_ATTACHMENT_KINDS.indexOf(a.kind) - SAMPLE_ATTACHMENT_KINDS.indexOf(b.kind) ||
      a.createdAt.localeCompare(b.createdAt)
  )
  return (
    <StoreSheet
      company={data.company ?? { name: 'Sampling record' }}
      title="Sample development record"
      number={request.number}
      dateLabel="Requested"
      date={longDate(request.createdAt) ?? ''}
      backHref="/sampling"
      backLabel="Sampling"
      banner={request.cancelledAt ? `CANCELLED · ${request.cancelReason}` : null}
      // Three panels, so each stays wide enough to read: who asked and who
      // answers for it, the style and its tech-pack details, and the brief.
      panels={[
        {
          title: 'Request',
          body: (
            <>
              <Fact label="Title" value={request.title} />
              <Fact label="Buyer" value={request.customer?.name ?? 'Internal development'} />
              <Fact label="Brand" value={request.brand.name} />
              <Fact label="Buyer ref" value={request.buyerRef} />
              <Fact label="Owner" value={request.owner} />
              <Fact label="Required by" value={longDate(request.requiredAt)} />
              <Fact label="Version" value={request.version} />
            </>
          ),
        },
        {
          title: 'Style & tech pack',
          body: (
            <>
              <Fact label="Buyer style" value={request.buyerStyleRef} />
              <Fact label="Style" value={style ? `${style.code} · ${style.name}` : 'Not set'} />
              <Fact label="Stage" value={style ? STYLE_STAGE_LABEL[style.stage] : null} />
              <Fact label="Garment" value={style?.category || request.garmentCategory} />
              <Fact label="Season" value={style?.season || request.season} />
              <Fact
                label="Size run"
                value={style?.sizeGroupId ? sizeRun(style.sizeGroupId) : null}
              />
              <Fact label="Colours" value={style?.colors.join(', ')} />
            </>
          ),
        },
        {
          title: 'Brief',
          body: <div style={{ whiteSpace: 'pre-wrap', fontSize: 10 }}>{request.brief}</div>,
        },
      ]}
      columns={[
        { key: 'round', head: 'Round', width: '9%' },
        { key: 'section', head: 'Record', width: '22%' },
        { key: 'detail', head: 'Details', width: '47%' },
        { key: 'result', head: 'Result / quantity', width: '22%' },
      ]}
      rows={rows.map((r) => ({
        ...r,
        cells: {
          ...r.cells,
          detail: (
            <span style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
              {r.cells.detail}
            </span>
          ),
        },
      }))}
      after={
        <div style={{ marginTop: '8px' }}>
          {[...request.rounds].reverse().map((round) => (
            <SpecBlock key={round.id} round={round} lookups={lookups} />
          ))}
          <Panel title="Tech pack files">
            {files.length ? (
              files.map((f) => (
                <Fact
                  key={f.id}
                  label={f.kindLabel}
                  value={`${f.fileName} · ${fileScope(f, request.rounds)} · ${longDate(f.createdAt) ?? ''}`}
                />
              ))
            ) : (
              <div style={{ fontSize: 10 }}>No files attached.</div>
            )}
          </Panel>
        </div>
      }
      signatures={[
        { role: 'Sampling owner', who: request.owner },
        { role: 'Technical / QC review' },
        { role: 'Production acceptance' },
      ]}
      footerNote="Internal sampling record. Production planning requires its own approved order and release."
    />
  )
}

/** A figure as typed: no trailing zeros, up to four places (a quantity per piece). */
const figure = (v: number) => v.toLocaleString('en-IN', { maximumFractionDigits: 4 })
const CELL: React.CSSProperties = {
  border: `1px solid ${RULE}`,
  padding: '3px 5px',
  fontSize: '9px',
  color: INK,
  verticalAlign: 'top',
  overflowWrap: 'anywhere',
}
interface PrintColumn {
  key: string
  head: string
  align?: 'left' | 'right'
  width?: string
}

/** One titled table of a round's specification, ruled like the job card's process table. */
function PrintTable({
  title,
  columns,
  rows,
  foot,
  empty,
}: {
  title: string
  columns: PrintColumn[]
  rows: Array<Record<string, React.ReactNode>>
  /** A totals row, set in bold. */
  foot?: Record<string, React.ReactNode>
  empty: string
}) {
  return (
    <div>
      <Eyebrow style={{ color: GREY, marginBottom: '3px' }}>{title}</Eyebrow>
      {rows.length ? (
        <table style={{ width: '100%', borderCollapse: 'collapse', tableLayout: 'fixed' }}>
          <colgroup>
            {columns.map((c) => (
              <col key={c.key} style={c.width ? { width: c.width } : undefined} />
            ))}
          </colgroup>
          <thead>
            <tr>
              {columns.map((c) => (
                <th
                  key={c.key}
                  style={{ ...CELL, textAlign: c.align ?? 'left', fontWeight: 600, color: GREY }}
                >
                  {c.head}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i}>
                {columns.map((c) => (
                  <td
                    key={c.key}
                    style={{
                      ...CELL,
                      textAlign: c.align ?? 'left',
                      fontVariantNumeric: c.align === 'right' ? 'tabular-nums' : undefined,
                    }}
                  >
                    {r[c.key] ?? ''}
                  </td>
                ))}
              </tr>
            ))}
            {foot && (
              <tr>
                {columns.map((c) => (
                  <td
                    key={c.key}
                    style={{
                      ...CELL,
                      textAlign: c.align ?? 'left',
                      fontWeight: 700,
                      fontVariantNumeric: 'tabular-nums',
                    }}
                  >
                    {foot[c.key] ?? ''}
                  </td>
                ))}
              </tr>
            )}
          </tbody>
        </table>
      ) : (
        <div style={{ fontSize: '9.5px', color: MUTED }}>{empty}</div>
      )}
    </div>
  )
}

/**
 * A round's specification on paper: the colour × size grid with its totals,
 * the measurements as points × sizes, the sample BOM and the making route,
 * laid out as the workspace shows them, from the same helpers.
 */
function SpecBlock({ round, lookups }: { round: SampleRound; lookups: Lookups }) {
  const s = round.specification
  // The size list is in the run's own order, which the grids follow.
  const order = lookups.sizes.map((z) => z.id)
  const size = (id: string) => lookups.sizes.find((z) => z.id === id)?.code ?? id
  const grid = colourGrid(s, order)
  const matrix = measureMatrix(s, order)
  const cost = materialCost(s)
  const sizeColumns = (ids: string[]): PrintColumn[] =>
    ids.map((id) => ({ key: `size:${id}`, head: size(id), align: 'right' }))
  return (
    <div style={{ border: `1px solid ${RULE}`, marginBottom: '8px' }}>
      <div
        style={{
          background: TINT,
          borderBottom: `1px solid ${RULE}`,
          padding: '5px 10px',
          display: 'flex',
          justifyContent: 'space-between',
          gap: '10px',
        }}
      >
        <Eyebrow>
          Round {round.revision} specification · {s.milestone || 'Milestone not named'}
        </Eyebrow>
        <span style={{ fontSize: '9px', color: GREY }}>
          {SAMPLE_STATE_LABEL[round.state]} · {colourSummary(s)}
        </span>
      </div>
      <div style={{ padding: '6px 10px', display: 'grid', gap: '8px' }}>
        <PrintTable
          title="Colours and pieces"
          columns={[
            { key: 'colour', head: 'Colour', width: '24%' },
            ...sizeColumns(grid.sizeIds),
            { key: 'total', head: 'Total', align: 'right', width: '11%' },
          ]}
          rows={grid.rows.map((r) => ({
            colour: r.colour || 'Colour not picked',
            ...Object.fromEntries(grid.sizeIds.map((id) => [`size:${id}`, r.qty[id] || '—'])),
            total: <strong>{r.total}</strong>,
          }))}
          foot={{
            colour: 'Total',
            ...Object.fromEntries(grid.sizeIds.map((id) => [`size:${id}`, grid.cols[id]])),
            total: grid.total,
          }}
          empty="No colours yet."
        />
        <PrintTable
          title="Measurements · the same for every colour"
          columns={[
            { key: 'point', head: 'Point', width: '24%' },
            { key: 'tol', head: 'Tolerance', align: 'right', width: '13%' },
            ...sizeColumns(matrix.sizeIds),
          ]}
          rows={matrix.points.map((p) => ({
            point: p.name || 'Point not named',
            tol: `± ${figure(p.tolerance)} ${p.unit}`,
            ...Object.fromEntries(
              matrix.sizeIds.map((id) => [
                `size:${id}`,
                id in p.targets ? figure(p.targets[id]) : '—',
              ])
            ),
          }))}
          empty="No measurements yet."
        />
        <PrintTable
          title={`Materials · ${plural(s.materials.length, 'line')}`}
          columns={[
            { key: 'part', head: 'Part', width: '11%' },
            { key: 'material', head: 'Material', width: '22%' },
            { key: 'colour', head: 'Colour', width: '10%' },
            { key: 'perPiece', head: 'Qty / pc', align: 'right', width: '9%' },
            { key: 'wastage', head: 'Wastage', align: 'right', width: '8%' },
            { key: 'required', head: 'Required', align: 'right', width: '15%' },
            { key: 'source', head: 'Source', width: '13%' },
            { key: 'rate', head: 'Est. rate ₹', align: 'right', width: '12%' },
          ]}
          rows={s.materials.map((l) => {
            const it = lineItem(l, round, lookups.items)
            return {
              part: l.component || '—',
              material: it.code ? `${it.name} (${it.code})` : it.name,
              colour: lineColour(l.colour),
              perPiece: l.qtyPerPiece ? figure(l.qtyPerPiece) : '—',
              wastage: l.wastagePct ? `${figure(l.wastagePct)}%` : '—',
              required: (
                <>
                  {qty(lineRequiredQty(l, s))} {it.uom}
                  {l.requiredOverride && (
                    <div style={{ color: MUTED, fontSize: '8px', textAlign: 'left' }}>
                      Typed by hand{l.overrideReason ? `: ${l.overrideReason}` : ''}
                    </div>
                  )}
                </>
              ),
              source: SAMPLE_MATERIAL_SOURCE_LABEL[l.source],
              // As the screen shows it: to 4 places, none for what the buyer sends.
              rate:
                l.estRate === null || l.source === 'BUYER_SUPPLIED' ? '—' : rateFigure(l.estRate),
            }
          })}
          foot={
            s.materials.length
              ? {
                  part: MATERIAL_COST_LABEL,
                  source: cost.unrated ? `${plural(cost.unrated, 'line')} with no rate` : '',
                  rate: money(cost.total),
                }
              : undefined
          }
          empty="No materials yet."
        />
        <PrintTable
          title="Making route"
          columns={[
            { key: 'n', head: '#', align: 'right', width: '5%' },
            { key: 'step', head: 'Step', width: '16%' },
            { key: 'process', head: 'Process', width: '15%' },
            { key: 'department', head: 'Department', width: '14%' },
            { key: 'doneAt', head: 'Done at', width: '22%' },
            { key: 'instructions', head: 'Instructions', width: '28%' },
          ]}
          rows={s.route.map((step, i) => {
            const f = stepFacts(step, lookups)
            return {
              n: i + 1,
              step: step.name || 'Step not named',
              process: f.process || '—',
              department: f.department || '—',
              doneAt: f.process ? `${f.doneAt} · ${f.who}` : '—',
              instructions: <span style={{ whiteSpace: 'pre-wrap' }}>{f.instructions || '—'}</span>,
            }
          })}
          empty="No steps yet."
        />
      </div>
    </div>
  )
}
