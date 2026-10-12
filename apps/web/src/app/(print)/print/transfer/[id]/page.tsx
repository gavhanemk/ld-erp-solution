'use client'

import { useEffect, useState } from 'react'
import { useParams } from 'next/navigation'
import { api, ApiError } from '@/lib/api'
import { StoreSheet, Fact, Eyebrow, qty, money, longDate, CODE, GREY, INK, MUTED, NAVY, NUM, RULE, type SheetColumn } from '@/components/print/StoreSheet'
import { SmartSelect } from '@/components/ui/SmartSelect'

interface Line {
  id: string
  dispatchedQty: number
  receivedQty: number
  shortQty: number
  settledQty: number
  excessQty: number
  bundle: { id: string; code: string; bundleNo: number; size: { code: string; sequence: number } | null; moLine: { color: string; style: { code: string; name: string } } }
}
interface Payload {
  company: Record<string, string | null>
  template: { title: string; footerNote: string | null; declaration: string | null }
  goods: Array<{ style: string; color: string; item: string | null; hsnCode: string | null; rate: number }>
  transfer: {
    transferNumber: string
    status: string
    isRework: boolean
    dispatchDate: string
    issuedBy: string | null
    receivedBy: string | null
    receivedAt: string | null
    vehicleNo: string | null
    notes: string | null
    cancelReason: string | null
    mo: { moNumber: string; so: { soNumber: string; customerPORef: string | null; customer: { name: string } } | null }
    fromStep: { name: string; department: { name: string } }
    toStep: { name: string; department: { name: string } }
    vendor: { name: string; gstin: string | null; address: string | null; city: string | null; state: string | null; stateCode: string | null } | null
    jobWorkOrder: { orderNumber: string; rate: string | number } | null
    jobCard: { jobCardNumber: string; orderNo: string | null; projectId: string | null; designNo: string | null; fabricQuality: string | null; lotNo: string | null } | null
    createdBy: { name: string }
    lines: Line[]
  }
}

const CARD_COLS: SheetColumn[] = [
  { key: 'sn', head: 'S.N', width: '6%', align: 'center' },
  { key: 'bundle', head: 'Bundle', width: '24%' },
  { key: 'line', head: 'Style · colour', width: '26%' },
  { key: 'size', head: 'Size', width: '8%', align: 'center' },
  { key: 'sent', head: 'Sent', width: '10%', align: 'right' },
  { key: 'got', head: 'Received', width: '12%', align: 'right' },
  { key: 'diff', head: 'Short / over', width: '14%', align: 'right' },
]
const CHALLAN_COLS: SheetColumn[] = [
  { key: 'sn', head: 'S.N', width: '5%', align: 'center' },
  { key: 'desc', head: 'Description of goods', width: '39%' },
  { key: 'hsn', head: 'HSN', width: '9%', align: 'center' },
  { key: 'sizes', head: 'Sizes', width: '17%' },
  { key: 'qty', head: 'Pieces', width: '9%', align: 'right' },
  { key: 'rate', head: 'Rate', width: '9%', align: 'right' },
  { key: 'value', head: 'Value (₹)', width: '12%', align: 'right' },
]
const COPIES = ['Original for job worker', 'Duplicate for transporter', 'Triplicate for us']
const yearOn = (d: string) => {
  const x = new Date(d)
  x.setFullYear(x.getFullYear() + 1)
  return x
}

/**
 * The transfer card that travels with the bundles from one department to the
 * next — sent, counted in, and signed by both. To an outside unit it is the
 * job-work delivery challan instead (rule 55): both parties, the goods with
 * HSN, pieces and value, and why no tax is charged.
 */
export default function PrintTransfer() {
  const { id } = useParams<{ id: string }>()
  const [data, setData] = useState<Payload | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [copy, setCopy] = useState(COPIES[0])

  useEffect(() => {
    api
      .get<{ data: Payload }>(`/production/transfers/${id}/print`)
      .then((res) => setData(res.data))
      .catch((err) => setError(err instanceof ApiError ? err.message : 'Could not open that card.'))
  }, [id])

  if (error) return <p style={{ padding: 48, color: INK }}>{error}</p>
  if (!data) return <p style={{ padding: 48, color: MUTED }}>Opening the card…</p>

  const { company, template, transfer: t, goods } = data
  const mo = t.mo
  const lines = [...t.lines].sort((a, b) => a.bundle.bundleNo - b.bundle.bundleNo)
  const sent = lines.reduce((s, l) => s + l.dispatchedQty, 0)
  const banner = t.status === 'CANCELLED' ? `CANCELLED${t.cancelReason ? ` — ${t.cancelReason}` : ''}. The bundles did not go on this card.` : null

  if (t.vendor) {
    // One row per style and colour, its sizes and pieces, at what it is carried at.
    const groups = new Map<string, { style: string; color: string; name: string; pieces: number; sizes: Map<string, number> }>()
    for (const l of lines) {
      const key = `${l.bundle.moLine.style.code}|${l.bundle.moLine.color}`
      const g = groups.get(key) ?? { style: l.bundle.moLine.style.code, color: l.bundle.moLine.color, name: l.bundle.moLine.style.name, pieces: 0, sizes: new Map() }
      g.pieces += l.dispatchedQty
      if (l.bundle.size) g.sizes.set(l.bundle.size.code, (g.sizes.get(l.bundle.size.code) ?? 0) + l.dispatchedQty)
      groups.set(key, g)
    }
    const rows = [...groups.values()].map((g, i) => {
      const good = goods.find((x) => x.style === g.style && x.color === g.color)
      const value = g.pieces * (good?.rate ?? 0)
      return {
        key: `${g.style}|${g.color}`,
        value,
        cells: {
          sn: i + 1,
          desc: (
            <div>
              <div style={{ fontWeight: 600 }}>{good?.item ?? g.name}</div>
              <div style={{ fontSize: '9px', color: GREY }}>
                {g.style} · {g.color} · cut pieces for {t.toStep.name.toLowerCase()}
              </div>
            </div>
          ),
          hsn: <span style={{ fontSize: '9px', color: GREY }}>{good?.hsnCode ?? '—'}</span>,
          sizes: <span style={{ fontSize: '9px', color: GREY }}>{[...g.sizes.entries()].map(([s, n]) => `${s}:${n}`).join(' ') || '—'}</span>,
          qty: <strong>{qty(g.pieces)}</strong>,
          rate: good?.rate ? money(good.rate) : '—',
          value: value ? money(value) : '—',
        },
      }
    })
    const total = rows.reduce((s, r) => s + r.value, 0)
    const v = t.vendor
    return (
      <StoreSheet
        company={company}
        title={template.title}
        number={t.transferNumber}
        copyLabel={copy}
        dateLabel="Challan date"
        date={longDate(t.dispatchDate) ?? ''}
        backHref="/production/orders"
        backLabel="Production"
        banner={banner}
        options={
          <label>
            Copy
            <SmartSelect value={copy} onChange={(e) => setCopy(e.target.value)}>
              {COPIES.map((c) => (
                <option key={c}>{c}</option>
              ))}
            </SmartSelect>
          </label>
        }
        panels={[
          {
            title: 'Job worker (consignee)',
            body: (
              <>
                <div style={{ fontSize: '12px', fontWeight: 700, color: NAVY, lineHeight: 1.3 }}>{v.name}</div>
                <div style={{ fontSize: '10px', color: GREY, lineHeight: 1.55, marginTop: '3px' }}>{[v.address, v.city, v.state].filter(Boolean).join(', ')}</div>
                <div style={{ marginTop: '4px' }}>
                  <Fact label="GSTIN" value={v.gstin ?? 'Unregistered'} mono />
                  <Fact label="State" value={v.state ? `${v.state}${v.stateCode ? ` (${v.stateCode})` : ''}` : null} />
                </div>
              </>
            ),
          },
          {
            title: 'The job',
            body: (
              <>
                <Fact label="Process" value={`${t.toStep.name}${t.isRework ? ' — to put right' : ''}`} />
                <Fact label="Job order" value={t.jobWorkOrder?.orderNumber ?? null} mono />
                <Fact label="Mfg. order" value={t.jobCard ? `${mo.moNumber} · ${t.jobCard.jobCardNumber}` : mo.moNumber} mono />
                <Fact label="Design no." value={t.jobCard?.designNo ?? null} mono />
                <Fact label="Bundles" value={`${lines.length} · ${qty(sent)} pieces`} />
              </>
            ),
          },
          {
            title: 'Dispatch',
            body: (
              <>
                <Fact label="Vehicle No" value={t.vehicleNo} mono />
                <Fact label="Sent by" value={t.issuedBy ?? t.createdBy.name} />
                <Fact label="Order" value={mo.so ? `${mo.so.soNumber}${mo.so.customerPORef ? ` · PO ${mo.so.customerPORef}` : ''}` : null} />
              </>
            ),
          },
        ]}
        columns={CHALLAN_COLS}
        rows={rows}
        minRows={3}
        after={
          <>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 250px', gap: '7px', marginTop: '8px' }}>
              <div style={{ border: `1px solid ${RULE}`, padding: '7px 10px' }}>
                <Eyebrow style={{ color: GREY }}>Bundles</Eyebrow>
                <div style={{ fontSize: '9px', color: INK, marginTop: '3px', lineHeight: 1.6, ...CODE }}>
                  {lines.map((l) => `${l.bundle.code.split('-').pop()}${l.bundle.size ? `/${l.bundle.size.code}` : ''}:${l.dispatchedQty}`).join('  ')}
                </div>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '7px 11px', background: NAVY, color: '#fff' }}>
                <span style={{ fontSize: '10px', fontWeight: 700, letterSpacing: '.1em', textTransform: 'uppercase' }}>Value of goods</span>
                <span style={{ fontSize: '13px', fontWeight: 700, ...NUM }}>₹{money(total)}</span>
              </div>
            </div>
            <div style={{ border: `1px solid ${RULE}`, padding: '7px 10px', marginTop: '7px' }}>
              <Eyebrow style={{ color: GREY }}>Declaration</Eyebrow>
              <div style={{ fontSize: '10px', color: INK, marginTop: '3px', lineHeight: 1.6 }}>
                {template.declaration ??
                  `Goods sent for job work (${t.toStep.name.toLowerCase()}) under section 143 of the CGST Act, 2017, and rule 55 of the CGST Rules, 2017. This is not a supply and no GST is charged. The goods remain the property of ${company.name} and are to be returned, processed, by ${longDate(yearOn(t.dispatchDate))} — one year from this challan.`}
              </div>
            </div>
          </>
        }
        signatures={[
          { role: `For ${company.name}`, who: t.issuedBy ?? t.createdBy.name },
          { role: 'Transporter', who: null },
          { role: 'Received by job worker', who: null },
        ]}
        footerNote={template.footerNote ?? 'Delivery challan for job work. Not a tax invoice.'}
      />
    )
  }

  const rows = lines.map((l, i) => {
    const counted = l.receivedQty > 0 || l.shortQty > 0
    return {
      key: l.id,
      cells: {
        sn: i + 1,
        bundle: <span style={CODE}>{l.bundle.code}</span>,
        line: (
          <span>
            {l.bundle.moLine.style.code} · {l.bundle.moLine.color}
          </span>
        ),
        size: l.bundle.size?.code ?? '—',
        sent: <strong>{qty(l.dispatchedQty)}</strong>,
        got: l.receivedQty ? qty(l.receivedQty) : '',
        diff: l.shortQty ? `${l.shortQty} short` : l.excessQty ? `${l.excessQty} over` : counted ? '—' : '',
      },
    }
  })
  return (
    <StoreSheet
      company={company}
      title={template.title}
      number={t.transferNumber}
      dateLabel="Sent on"
      date={longDate(t.dispatchDate) ?? ''}
      backHref="/production/orders"
      backLabel="Production"
      banner={banner}
      panels={[
        {
          title: 'Order',
          body: (
            <>
              <Fact label="Ref no." value={t.jobCard ? [t.jobCard.orderNo, t.jobCard.projectId, t.jobCard.designNo].filter(Boolean).join('/') || null : null} mono />
              <Fact label="Job card" value={t.jobCard ? `${t.jobCard.jobCardNumber} · ${mo.moNumber}` : mo.moNumber} mono />
              <Fact label="Customer" value={mo.so ? `${mo.so.customer.name}${mo.so.customerPORef ? ` · PO ${mo.so.customerPORef}` : ''}` : null} />
              <Fact label="Fabric · lot" value={t.jobCard ? [t.jobCard.fabricQuality, t.jobCard.lotNo].filter(Boolean).join(' · ') || null : null} />
            </>
          ),
        },
        {
          title: 'From → to',
          body: (
            <>
              <Fact label="From" value={`${t.fromStep.name} (${t.fromStep.department.name})`} />
              <Fact label="To" value={`${t.toStep.name} (${t.toStep.department.name})`} />
              <Fact label="Bundles" value={`${lines.length} · ${qty(sent)} pieces`} />
            </>
          ),
        },
        {
          title: 'Hand-over',
          body: (
            <>
              <Fact label="Issued by" value={t.issuedBy} />
              <Fact label="Received by" value={t.receivedBy} />
              <Fact label="Counted on" value={longDate(t.receivedAt)} />
            </>
          ),
        },
      ]}
      columns={CARD_COLS}
      rows={rows}
      minRows={Math.max(0, 8 - rows.length)}
      after={
        t.notes ? (
          <div style={{ border: `1px solid ${RULE}`, padding: '7px 10px', marginTop: '8px' }}>
            <Eyebrow style={{ color: GREY }}>Note</Eyebrow>
            <div style={{ fontSize: '10px', color: GREY, marginTop: '3px' }}>{t.notes}</div>
          </div>
        ) : null
      }
      signatures={[
        { role: `Issued by — ${t.fromStep.department.name}`, who: t.issuedBy },
        { role: `Received by — ${t.toStep.department.name}`, who: t.receivedBy },
        { role: 'Supervisor', who: null },
      ]}
      footerNote={template.footerNote ?? 'Count the bundles in against this card on the receiving sheet. A difference is recorded, not corrected.'}
    />
  )
}
