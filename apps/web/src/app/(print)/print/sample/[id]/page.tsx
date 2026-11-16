'use client'

import { useEffect, useState } from 'react'
import { useParams } from 'next/navigation'
import { api, apiErrorMessage } from '@/lib/api'
import { StoreSheet, Fact, longDate, qty } from '@/components/print/StoreSheet'
import { SAMPLE_STATE_LABEL } from '@ld-erp/shared'
import type { Lookups, SampleRequest } from '@/components/sampling/types'

interface Payload {
  company: Record<string, string | null> | null
  request: SampleRequest
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
  for (const round of [...request.rounds].reverse()) {
    const s = round.specification
    const style = lookups.styles.find((x) => x.id === s.styleId)
    add(
      round.revision,
      s.milestone,
      `${style ? `${style.code} · ${style.name}` : s.styleId || 'Style pending'} · ${s.color || 'Colour pending'}`,
      SAMPLE_STATE_LABEL[round.state]
    )
    add(
      round.revision,
      'Technical specification',
      `Construction: ${s.construction || 'Pending'}\nTech pack: ${s.techPackRef || 'Pending'}\nPattern: ${s.patternRef || 'Pending'}\n${s.notes}`
    )
    add(
      round.revision,
      'Size quantities',
      s.sizes.map((x) => `${size(x.sizeId)}: ${x.qty}`).join('; ') || 'Pending'
    )
    for (const m of s.measurements) {
      add(
        round.revision,
        'Measurement target',
        `${size(m.sizeId)} · ${m.name}: ${m.target} ± ${m.tolerance} ${m.unit}`
      )
    }
    for (const m of s.materials) {
      const item = lookups.items.find((x) => x.id === m.itemId)
      const store = lookups.warehouses.find((x) => x.id === m.warehouseId)
      add(
        round.revision,
        'Material plan',
        `${item?.name ?? m.itemId} · ${store?.name ?? m.warehouseId} · ${m.ownership === 'OWNED' ? 'Company owned' : 'Buyer owned'}`,
        `${qty(m.qty)} ${item?.uom?.symbol ?? ''}`
      )
    }
    for (const m of round.materials) {
      add(
        round.revision,
        'Material reconciliation',
        `${m.item.name} · ${m.warehouse.name}\nIssued ${qty(m.issuedQty)}; used ${qty(m.usedQty)}; waste ${qty(m.wasteQty)}; returned ${qty(m.returnedQty)} ${m.item.uom?.symbol ?? ''}`,
        `Held ${qty(+m.issuedQty - +m.usedQty - +m.wasteQty - +m.returnedQty)}`
      )
    }
    for (const stage of round.stages) {
      add(
        round.revision,
        `${stage.sequence}. ${stage.name}`,
        `${stage.responsible ?? ''}\n${stage.reference ?? ''}\n${stage.notes ?? ''}`,
        stage.completedAt
          ? `${stage.doneQty} done / ${stage.rejectedQty} rejected · ${longDate(stage.completedAt)}`
          : 'Pending'
      )
    }
    if (round.qc) {
      add(
        round.revision,
        'Latest inspection',
        round.qc.notes,
        `${round.qc.passed ? 'Passed' : 'Failed'} · ${round.qc.passedQty} pieces`
      )
      for (const point of round.qc.results) {
        add(
          round.revision,
          'QC measurement',
          `${size(point.sizeId)} · ${point.name}: actual ${point.actual}, target ${point.target} ${point.unit}`,
          point.pass ? 'Within tolerance' : 'Outside tolerance'
        )
      }
    }
    if (round.submission)
      add(
        round.revision,
        'Buyer submission',
        `${round.submission.recipient} · ${round.submission.reference}\n${round.submission.notes}`,
        `${round.submission.qty} pieces`
      )
    if (round.decision)
      add(
        round.revision,
        'Buyer decision',
        `${round.decision.buyerName}\n${round.decision.evidence}\n${round.decision.conditions}`,
        SAMPLE_STATE_LABEL[round.decision.result]
      )
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
  for (const event of [...request.events].reverse()) {
    add(
      'History',
      event.action.replaceAll('_', ' '),
      event.detail.by ?? '',
      longDate(event.createdAt) ?? ''
    )
  }
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
      panels={[
        {
          title: 'Request',
          body: (
            <>
              <Fact label="Title" value={request.title} />
              <Fact label="Buyer" value={request.customer?.name ?? 'Internal development'} />
              <Fact label="Brand" value={request.brand.name} />
              <Fact label="Buyer ref" value={request.buyerRef} />
            </>
          ),
        },
        {
          title: 'Brief',
          body: <div style={{ whiteSpace: 'pre-wrap', fontSize: 10 }}>{request.brief}</div>,
        },
        {
          title: 'Responsibility',
          body: (
            <>
              <Fact label="Owner" value={request.owner} />
              <Fact label="Required by" value={longDate(request.requiredAt)} />
              <Fact label="Version" value={request.version} />
            </>
          ),
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
      signatures={[
        { role: 'Sampling owner', who: request.owner },
        { role: 'Technical / QC review' },
        { role: 'Production acceptance' },
      ]}
      footerNote="Internal sampling record. Production planning requires its own approved order and release."
    />
  )
}
