'use client'

import { useEffect, useState } from 'react'
import { useParams } from 'next/navigation'
import { api, ApiError } from '@/lib/api'
import {
  StoreSheet,
  Dash,
  Note,
  PartyLine,
  TotalsBox,
  WordsAndTotals,
  qty,
  money,
  longDate,
  shortDate,
  CODE,
  INK,
  MUTED,
  type SheetColumn,
  type TotalLine,
} from '@/components/print/StoreSheet'
import { Box, SubLine } from '@/components/print/doc'
import { SmartSelect } from '@/components/ui/SmartSelect'
import { moCustomer } from '@/components/production/moCustomer'

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
  /** The own brand the order is made under, carried from start to end. */
  brand?: { name: string; type: string } | null
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

/** "Stitching (Kaj Button)": a step, and its department when that says more. */
const stepName = (s: { name: string; department: { name: string } }) =>
  s.department.name && s.department.name !== s.name ? `${s.name} (${s.department.name})` : s.name

/**
 * The transfer card that travels with the bundles from one department to the
 * next — sent, counted in, and signed by both. To an outside unit it is the
 * job-work delivery challan instead (rule 55): both parties, the goods with
 * HSN, pieces and value, and why no tax is charged.
 *
 * Both are laid out like the purchase order (27 Nov 2026): whoever receives the
 * bundles — the next process, or the job worker — in the "To," block with the
 * card's facts beside it, the process they leave in a band.
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
  const order = mo.so ? `${mo.so.soNumber}${mo.so.customerPORef ? ` · PO ${mo.so.customerPORef}` : ''}` : null

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
            <>
              <div style={{ fontWeight: 600 }}>{good?.item ?? g.name}</div>
              <SubLine>
                {g.style} · {g.color} · cut pieces for {t.toStep.name.toLowerCase()}
              </SubLine>
            </>
          ),
          hsn: good?.hsnCode ?? '—',
          sizes: [...g.sizes.entries()].map(([s, n]) => `${s}:${n}`).join(' ') || '—',
          qty: <strong>{qty(g.pieces)}</strong>,
          rate: good?.rate ? money(good.rate) : '—',
          value: value ? money(value) : '—',
        },
      }
    })
    const total = rows.reduce((s, r) => s + r.value, 0)
    const v = t.vendor
    const totals: TotalLine[] = [
      { label: 'Bundles', value: lines.length },
      { label: 'Pieces', value: qty(sent) },
    ]
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
        party={{
          heading: 'To, the job worker (consignee)',
          name: v.name,
          lines: (
            <>
              <PartyLine label="Address-" value={[v.address, v.city, v.state].filter(Boolean).join(', ') || null} />
              <PartyLine label="GST No" value={v.gstin ?? 'Unregistered'} mono={Boolean(v.gstin)} />
              <PartyLine label="State" value={v.state ? `${v.state}${v.stateCode ? ` (${v.stateCode})` : ''}` : null} />
            </>
          ),
          meta: [
            ['Challan No', t.transferNumber, true],
            ['Challan Date', shortDate(t.dispatchDate), true],
            ['Process', `${t.toStep.name}${t.isRework ? ' — to put right' : ''}`],
            ['Job order', t.jobWorkOrder?.orderNumber ?? null, true],
            ['Mfg. order', t.jobCard ? `${mo.moNumber} · ${t.jobCard.jobCardNumber}` : mo.moNumber, true],
            ['Order', order],
            ['Brand', data.brand?.name ?? null],
            ['Print / design', t.jobCard?.designNo ?? null, true],
          ],
        }}
        bands={[
          {
            icon: 'truck',
            label: 'From process',
            body: (
              <>
                <div style={{ fontSize: '11px', fontWeight: 800, textTransform: 'uppercase' }}>{stepName(t.fromStep)}</div>
                <div style={{ marginTop: '1px' }}>
                  <strong>Vehicle No</strong> <span style={CODE}>{t.vehicleNo || '—'}</span>
                  <span style={{ marginLeft: '14px' }}>
                    <strong>Sent by</strong> {t.issuedBy ?? t.createdBy.name}
                  </span>
                </div>
              </>
            ),
          },
        ]}
        columns={CHALLAN_COLS}
        rows={rows}
        after={
          <>
            <WordsAndTotals
              words={null}
              left={
                <Note title="Bundles">
                  <span style={CODE}>
                    {lines.map((l) => `${l.bundle.code.split('-').pop()}${l.bundle.size ? `/${l.bundle.size.code}` : ''}:${l.dispatchedQty}`).join('  ')}
                  </span>
                </Note>
              }
              totals={<TotalsBox rows={totals} totalLabel="Value of goods" total={`₹ ${money(total)}`} />}
            />
            <Box title="Declaration" style={{ marginTop: '7px' }}>
              {template.declaration ??
                `Goods sent for job work (${t.toStep.name.toLowerCase()}) under section 143 of the CGST Act, 2017, and rule 55 of the CGST Rules, 2017. This is not a supply and no GST is charged. The goods remain the property of ${company.name} and are to be returned, processed, by ${longDate(yearOn(t.dispatchDate))} — one year from this challan.`}
            </Box>
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
  // What was counted in at the other end, once anything has been.
  const counted = lines.some((l) => l.receivedQty > 0 || l.shortQty > 0)
  const received = lines.reduce((s, l) => s + l.receivedQty, 0)
  const short = lines.reduce((s, l) => s + l.shortQty, 0)
  const over = lines.reduce((s, l) => s + l.excessQty, 0)
  const totals: TotalLine[] = [
    { label: 'Bundles', value: lines.length },
    ...(counted
      ? [
          { label: 'Received', value: qty(received) },
          ...(short ? [{ label: 'Short', value: qty(short) }] : []),
          ...(over ? [{ label: 'Over', value: qty(over) }] : []),
        ]
      : []),
  ]
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
      party={{
        name: t.toStep.name,
        code: t.toStep.department.name !== t.toStep.name ? t.toStep.department.name : null,
        // A process has no address: under it, who counts the bundles in, and
        // whose order and which fabric they are.
        lines: (
          <>
            <PartyLine label="Received by" value={t.receivedBy} />
            <PartyLine label="Counted on" value={shortDate(t.receivedAt)} />
            <PartyLine
              label="Customer"
              value={mo.so ? `${mo.so.customer.name}${mo.so.customerPORef ? ` · PO ${mo.so.customerPORef}` : ''}` : moCustomer(mo)}
            />
            <PartyLine
              label="Fabric · lot"
              value={t.jobCard ? [t.jobCard.fabricQuality, t.jobCard.lotNo].filter(Boolean).join(' · ') || null : null}
            />
          </>
        ),
        meta: [
          ['Card No', t.transferNumber, true],
          ['Sent on', shortDate(t.dispatchDate), true],
          ['Job card', t.jobCard ? `${t.jobCard.jobCardNumber} · ${mo.moNumber}` : mo.moNumber, true],
          ['Ref no.', t.jobCard ? [t.jobCard.orderNo, t.jobCard.projectId, t.jobCard.designNo].filter(Boolean).join('/') || null : null, true],
        ],
      }}
      bands={[
        {
          label: 'From process',
          body: (
            <>
              <div style={{ fontSize: '11px', fontWeight: 800, textTransform: 'uppercase' }}>{stepName(t.fromStep)}</div>
              <div style={{ marginTop: '1px' }}>
                <strong>Issued by</strong> {t.issuedBy || '—'}
              </div>
            </>
          ),
        },
      ]}
      columns={CARD_COLS}
      rows={rows}
      after={
        <WordsAndTotals
          words={null}
          left={<Note title="Note">{t.notes || <Dash />}</Note>}
          totals={<TotalsBox rows={totals} totalLabel="Pieces sent" total={qty(sent)} />}
        />
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
