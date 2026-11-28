'use client'

import { useEffect, useState } from 'react'
import { useParams } from 'next/navigation'
import { api, ApiError } from '@/lib/api'
import {
  StoreSheet,
  Dash,
  Eyebrow,
  Note,
  PartyLine,
  Terms,
  TotalsBox,
  WordsAndTotals,
  qty,
  money,
  longDate,
  shortDate,
  CODE,
  INK,
  MUTED,
  NUM,
  type SheetColumn,
  type TotalLine,
} from '@/components/print/StoreSheet'
import { Box, DocTable, HAIR, LINE, type DocColumn } from '@/components/print/doc'
import { garmentTable } from '@/components/print/garmentLines'

interface Payload {
  /** The own brand the order is made under, carried from start to end. */
  brand?: { name: string; type: string } | null
  company: Record<string, string | null>
  template: {
    title: string
    termsText: string | null
    declaration: string | null
    footerNote: string | null
    showHsn: boolean
    showAmountInWords: boolean
  }
  value: number
  gst: number
  valueInWords: string
  /** Job work: one row per customer receipt the garments' rolls came on. */
  reconciliation?: Array<{
    grnNumber: string
    receiptDate: string
    partyChallan: string | null
    lots: string[]
    receivedRolls: number
    receivedMeters: number
  }>
  /** Job work: each order line's fabric, read from production (the roll stickers issued to its MO). */
  trace?: Record<
    string,
    {
      rolls: Array<{ barcode: string; designNo: string | null; lotNo: string | null; received: number; issued: number }>
      gaps: Array<{ text: string }>
    }
  >
  challan: {
    dcNumber: string
    dcDate: string
    status: string
    deliveryAddress: string | null
    transporter: string | null
    vehicleNumber: string | null
    lrNumber: string | null
    eWayBillNumber: string | null
    cartons: number | null
    baleNumbers?: string | null
    packingListRef?: string | null
    grossWeight?: string | number | null
    packingNote: string | null
    notes: string | null
    dispatchedAt: string | null
    cancelledAt: string | null
    cancelReason: string | null
    so: {
      soNumber: string
      orderDate: string
      customerPORef: string | null
      customerPODate: string | null
      isJobWork: boolean
      broker?: { name: string } | null
    }
    customer: {
      name: string
      gstin: string | null
      phone: string | null
      billingAddress: string | null
      billingCity: string | null
      billingState: string | null
      billingPincode: string | null
      shippingAddress?: string | null
      shippingCity?: string | null
      shippingState?: string | null
      shippingPincode?: string | null
      shippingGstin?: string | null
    }
    warehouse: { name: string } | null
    createdBy: { name: string } | null
    dispatchedBy: { name: string } | null
    cancelledBy: { name: string } | null
    lines: Array<{
      id: string
      qty: string
      overNote: string | null
      grade?: string
      soLineId?: string | null
      item: {
        code: string
        name: string
        color: string | null
        hsnCode: string | null
        uom?: { symbol: string } | null
        style?: { code: string; name: string } | null
      }
      /** The order line it delivers: its colour, fabric, gender, print name. */
      soLine?: {
        id?: string
        styleCode: string | null
        color: string | null
        gender: string | null
        fabric: string | null
        printName: string | null
        description: string | null
        hsnCode: string | null
      } | null
      sizes: Array<{ id: string; qty: string; size: { code: string; sequence: number } }>
    }>
    /** The cartons loaded on it, scanned or picked: its packing list. */
    fgCartons?: Array<{
      code: string
      lines: Array<{ qty: number; grade: string; item: { code: string; name: string; color: string | null; style: { code: string } | null }; size: { code: string; sequence: number } }>
    }>
  }
}

/** The packing list: one row per item in each carton. */
const CARTON_COLUMNS: DocColumn[] = [
  { key: 'carton', head: 'Carton', width: '15%' },
  { key: 'item', head: 'Style · Item', width: '42%' },
  { key: 'sizes', head: 'Sizes × pcs', width: '33%' },
  { key: 'pcs', head: 'Pcs', width: '10%', align: 'right' },
]

/**
 * The job challan's goods, roll by roll, as the old ERP printed them: the
 * garment, the job charge's SAC, its grade and pieces, run down beside the
 * customer's rolls it was cut from — each roll's design, lot, barcode and the
 * metres issued from it to production. The rolls come from production, not
 * from the dispatch screen (28 Nov 2026); cutting does not record the pieces
 * per roll, so the pieces are the garment's.
 */
const ROLL_COLUMNS: SheetColumn[] = [
  { key: 'sn', head: 'S.N', width: '4%', align: 'center' },
  { key: 'garment', head: 'Merchant name', width: '24%' },
  { key: 'hsn', head: 'HSN / SAC', width: '9%' },
  { key: 'grade', head: 'Grade', width: '10%' },
  { key: 'design', head: 'Design', width: '9%' },
  { key: 'lot', head: 'Lot', width: '7%' },
  { key: 'barcode', head: 'Barcode', width: '15%' },
  { key: 'mtrs', head: 'Mtrs', width: '10%', align: 'right' },
  { key: 'pcs', head: 'Pcs', width: '12%', align: 'right' },
]

/**
 * The production summary: what came in on each receipt, what was packed from
 * it on this challan, and the shortage, as three groups of columns under one
 * heading each (the user's layout of 28 Nov 2026).
 */
const SUMMARY_GROUPS: Array<{ title: string; columns: Array<{ key: string; head: string; width: number; right?: boolean; nowrap?: boolean }> }> = [
  {
    title: 'Material received',
    columns: [
      { key: 'recDate', head: 'Received date', width: 11, nowrap: true },
      { key: 'lot', head: 'Lot no.', width: 6 },
      { key: 'party', head: 'Party challan no.', width: 13 },
      // Fabric rolls received, not garment pieces: those are "Packed pcs".
      { key: 'recPcs', head: 'Received rolls', width: 8, right: true },
      { key: 'recMtr', head: 'Received mtr', width: 8, right: true },
    ],
  },
  {
    title: 'Material packed',
    columns: [
      { key: 'pckDate', head: 'Packing date', width: 11, nowrap: true },
      { key: 'chl', head: 'Challan no.', width: 14, nowrap: true },
      { key: 'pckPcs', head: 'Packed pcs', width: 8, right: true },
      { key: 'pcsMtr', head: 'Pcs. mtr', width: 7, right: true },
    ],
  },
  {
    title: 'Shortage',
    columns: [
      { key: 'shMtr', head: 'Sh. mtr', width: 7, right: true },
      { key: 'shPct', head: 'Sh (%)', width: 7, right: true },
    ],
  },
]

/** The production summary table: grouped headings over the three parts, then a row per receipt. */
function ProductionSummary({ rows }: { rows: Array<{ key: string; cells: Record<string, React.ReactNode>; spans?: Record<string, number>; covered?: string[] }> }) {
  const cols = SUMMARY_GROUPS.flatMap((g, gi) => g.columns.map((c, ci) => ({ ...c, groupEnd: ci === g.columns.length - 1 && gi < SUMMARY_GROUPS.length - 1 })))
  const head: React.CSSProperties = {
    padding: '4px 6px',
    fontSize: '8px',
    fontWeight: 700,
    letterSpacing: '.04em',
    textTransform: 'uppercase',
    lineHeight: 1.25,
    verticalAlign: 'bottom',
  }
  return (
    <table style={{ width: '100%', borderCollapse: 'collapse', tableLayout: 'fixed', border: LINE, marginTop: '3px', color: INK }}>
      <colgroup>
        {cols.map((c) => (
          <col key={c.key} style={{ width: `${c.width}%` }} />
        ))}
      </colgroup>
      <thead>
        <tr>
          {SUMMARY_GROUPS.map((g, gi) => (
            <th
              key={g.title}
              colSpan={g.columns.length}
              style={{ ...head, textAlign: 'center', borderBottom: HAIR, borderRight: gi < SUMMARY_GROUPS.length - 1 ? LINE : undefined }}
            >
              {g.title}
            </th>
          ))}
        </tr>
        <tr>
          {cols.map((c, i) => (
            <th
              key={c.key}
              style={{ ...head, textAlign: c.right ? 'right' : 'left', borderBottom: LINE, borderRight: i === cols.length - 1 ? undefined : c.groupEnd ? LINE : HAIR }}
            >
              {c.head}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.key}>
            {cols.map((c, i) =>
              r.covered?.includes(c.key) ? null : (
              <td
                key={c.key}
                rowSpan={r.spans?.[c.key]}
                style={{
                  padding: '6px 6px',
                  fontSize: '10px',
                  lineHeight: 1.4,
                  verticalAlign: 'top',
                  textAlign: c.right ? 'right' : 'left',
                  borderTop: HAIR,
                  borderRight: i === cols.length - 1 ? undefined : c.groupEnd ? LINE : HAIR,
                  // A date or a challan number on one line, never broken in two.
                  ...(c.nowrap ? { whiteSpace: 'nowrap' } : { overflowWrap: 'anywhere' }),
                  ...(c.right ? NUM : {}),
                }}
              >
                {r.cells[c.key] ?? ''}
              </td>
              )
            )}
          </tr>
        ))}
      </tbody>
    </table>
  )
}

const metres = (n: number) => n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

/**
 * The delivery challan that travels with the goods.
 *
 * What is in the cartons — garment, colour, size breakup, pieces — and how it
 * travels. No rates per line: the value of the consignment is printed once,
 * as the e-way bill and the transporter need it. It is not a tax invoice and
 * says so. A draft or a cancelled challan prints with a band across the top.
 *
 * A job-work challan whose garments production traced to the customer's rolls
 * prints the old ERP's job challan (28 Nov 2026): roll by roll — design, lot,
 * barcode, metres — beside each garment and its pieces, with a total for each
 * garment, the bales in the header, and what came in on each receipt beside
 * what was packed.
 */
export default function PrintDeliveryChallan() {
  const { id } = useParams<{ id: string }>()
  const [data, setData] = useState<Payload | null>(null)
  const [error, setError] = useState<string | null>(null)
  // When it was printed, as the old ERP put it on every challan; read in the browser.
  const [printedAt, setPrintedAt] = useState('')

  useEffect(() => {
    setPrintedAt(new Date().toLocaleString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' }))
    api
      .get<{ data: Payload }>(`/sales/challans/${id}/print`)
      .then((res) => setData(res.data))
      .catch((err) => setError(err instanceof ApiError ? err.message : 'Could not open that challan.'))
  }, [id])

  if (error) return <p style={{ padding: 48, color: INK }}>{error}</p>
  if (!data) return <p style={{ padding: 48, color: MUTED }}>Opening the challan…</p>

  const { company, template, challan: dc } = data
  const c = dc.customer
  const billing = [c.billingAddress, c.billingCity, c.billingState, c.billingPincode].filter(Boolean).join(', ')
  const shipping = [c.shippingAddress, c.shippingCity, c.shippingState, c.shippingPincode].filter(Boolean).join(', ')
  const showHsn = template.showHsn !== false
  const trace = dc.so.isJobWork ? (data.trace ?? {}) : {}
  const byRolls = Object.values(trace).some((t) => t.rolls.length > 0)


  // The goods as the sales order prints them (28 Nov 2026): code, description,
  // colour, fabric, gender, print name and every size with its pieces. No
  // prices per line — the consignment's value is printed once, below.
  const garments = garmentTable(
    dc.lines.map((l) => ({
      id: l.id,
      item: l.item,
      styleCode: l.soLine?.styleCode,
      color: l.soLine?.color,
      gender: l.soLine?.gender,
      fabric: l.soLine?.fabric,
      printName: l.soLine?.printName,
      // B-grade pieces travel on a line of their own and say so.
      description: [l.soLine?.description, l.grade === 'B' ? 'B-grade' : null, l.overNote].filter(Boolean).join(' · ') || null,
      hsnCode: l.soLine?.hsnCode,
      qty: l.qty,
      unitPrice: 0,
      gstRate: 0,
      amount: 0,
      sizes: l.sizes,
    })),
    { showHsn, allColumns: true, money: false },
  )

  // ── The job challan, roll by roll ──────────────────────────────────────
  // One group per garment (fresh and B-grade together), its rolls from production.
  const garmentGroups: Array<{ soLineId: string; lines: typeof dc.lines }> = []
  for (const l of dc.lines) {
    const key = l.soLineId ?? l.soLine?.id ?? l.id
    const g = garmentGroups.find((x) => x.soLineId === key)
    if (g) g.lines.push(l)
    else garmentGroups.push({ soLineId: key, lines: [l] })
  }
  let sn = 0
  const rollRows = garmentGroups.flatMap((g) => {
    const line = g.lines[0]
    const rolls = trace[g.soLineId]?.rolls ?? []
    const fresh = g.lines.filter((l) => l.grade !== 'B').reduce((s, l) => s + Number(l.qty), 0)
    const bGrade = g.lines.filter((l) => l.grade === 'B').reduce((s, l) => s + Number(l.qty), 0)
    const pcsAll = fresh + bGrade
    const garment = (
      <>
        <strong>{line.item.name}</strong>
        <div style={{ ...CODE, color: MUTED }}>{[line.soLine?.styleCode ?? line.item.style?.code, line.item.code].filter(Boolean).join(' · ')}</div>
      </>
    )
    const hsn = line.soLine?.hsnCode ?? line.item.hsnCode ?? null
    const grade = bGrade && fresh ? `Fresh ${qty(fresh)} · B ${qty(bGrade)}` : bGrade ? 'B-grade' : 'Fresh Pc'
    const n = Math.max(1, rolls.length)
    // The garment, its SAC, grade and pieces once, run down beside all its rolls.
    const merged = ['garment', 'hsn', 'grade', 'pcs']
    const body = (rolls.length ? rolls : [null]).map((r, j) => ({
      key: `${g.soLineId}-${r?.barcode ?? 'none'}`,
      ...(j === 0 ? { spans: Object.fromEntries(merged.map((k) => [k, n])) } : { covered: merged }),
      cells: {
        sn: ++sn,
        garment: j === 0 ? garment : '',
        hsn: j > 0 ? '' : hsn ? <span style={CODE}>{hsn}</span> : <Dash />,
        grade: j === 0 ? grade : '',
        design: r?.designNo ?? <Dash />,
        lot: r?.lotNo ?? <Dash />,
        barcode: r ? <span style={CODE}>{r.barcode}</span> : <Dash />,
        mtrs: r ? <span style={NUM}>{metres(r.issued)}</span> : <Dash />,
        pcs: j === 0 ? <span style={NUM}>{qty(pcsAll)}</span> : '',
      },
    }))
    if (!rolls.length) return body
    const total = {
      key: `${g.soLineId}-total`,
      total: true,
      shade: true,
      cells: {
        sn: '',
        garment: 'Total',
        hsn: '',
        grade: '',
        design: '',
        lot: '',
        barcode: `${rolls.length} ${rolls.length === 1 ? 'roll' : 'rolls'}`,
        mtrs: <span style={NUM}>{metres(rolls.reduce((s, r) => s + r.issued, 0))}</span>,
        pcs: <span style={NUM}>{qty(pcsAll)}</span>,
      },
    }
    return [...body, total]
  })

  const bales = (dc.baleNumbers ?? '')
    .split(/[,;]/)
    .map((b) => b.trim())
    .filter(Boolean)
  const rollMetres = Object.values(trace).reduce((s, t) => s + t.rolls.reduce((x, r) => x + r.issued, 0), 0)
  const pieces = dc.lines.reduce((s, l) => s + Number(l.qty), 0)
  const grossWeight = dc.grossWeight != null && Number(dc.grossWeight) > 0 ? Number(dc.grossWeight) : null

  // Carton by carton: what is in each, by style, item and size.
  const cartonRows = (dc.fgCartons ?? []).flatMap((carton) => {
    const items = new Map<string, { label: string; sizes: string[]; pcs: number }>()
    for (const l of carton.lines) {
      const k = `${l.item.code}|${l.grade}`
      const it = items.get(k) ?? {
        label: `${l.item.style?.code ? `${l.item.style.code} · ` : ''}${l.item.code} ${l.item.color ?? ''}${l.grade === 'B' ? ' (B)' : ''}`,
        sizes: [],
        pcs: 0,
      }
      it.sizes.push(`${l.size.code}×${l.qty}`)
      it.pcs += l.qty
      items.set(k, it)
    }
    return [...items.values()].map((it, i) => ({
      key: `${carton.code}-${i}`,
      cells: {
        carton: i === 0 ? <strong style={CODE}>{carton.code}</strong> : '',
        item: it.label,
        sizes: <span style={NUM}>{it.sizes.join('  ')}</span>,
        pcs: it.pcs,
      },
    }))
  })

  // What came in on each receipt beside what was packed from it on this challan.
  const recon = data.reconciliation ?? []
  const packed = ['pckDate', 'chl', 'pckPcs', 'pcsMtr', 'shMtr', 'shPct']
  const reconRows = recon.map((r, i) => ({
    key: r.grnNumber,
    // What this challan packed is one figure, run down beside every receipt its fabric came on.
    ...(i === 0 ? { spans: Object.fromEntries(packed.map((k) => [k, recon.length])) } : { covered: packed }),
    cells: {
      recDate: shortDate(r.receiptDate),
      lot: r.lots.join(', ') || <Dash />,
      party: r.partyChallan ?? <Dash />,
      recPcs: <span style={NUM}>{r.receivedRolls}</span>,
      recMtr: <span style={NUM}>{metres(r.receivedMeters)}</span>,
      pckDate: shortDate(dc.dcDate),
      chl: <span style={CODE}>{dc.dcNumber}</span>,
      pckPcs: <span style={NUM}>{qty(pieces)}</span>,
      // Left blank until the business confirms how they are worked out (28 Nov 2026).
      pcsMtr: '',
      shMtr: '',
      shPct: '',
    },
  }))

  const banner =
    dc.status === 'CANCELLED'
      ? `CANCELLED on ${longDate(dc.cancelledAt)}${dc.cancelledBy ? ` by ${dc.cancelledBy.name}` : ''}${
          dc.cancelReason ? ` — ${dc.cancelReason}` : ''
        }. These goods are not to travel on this challan.`
      : dc.status === 'DRAFT'
        ? 'DRAFT — not yet dispatched. The goods have not left the store.'
        : null

  const totals: TotalLine[] = [
    { label: 'Pieces', value: qty(pieces) },
    ...(byRolls ? [{ label: 'Metres', value: metres(rollMetres) }] : []),
    ...(bales.length ? [{ label: 'Bales', value: String(bales.length) }] : []),
    ...(grossWeight ? [{ label: 'Gross weight', value: `${grossWeight.toLocaleString('en-IN', { maximumFractionDigits: 2 })} kg` }] : []),
    { label: 'Cartons', value: dc.cartons != null ? String(dc.cartons) : <Dash /> },
    { label: 'Value', value: money(data.value) },
    { label: 'GST', value: money(data.gst) },
  ]

  // The consignee: where the goods go, under the GSTIN they are taken in there.
  const consigneeGstin = c.shippingGstin || c.gstin

  // Laid out like the purchase order (27 Nov 2026): the consignee in the "To,"
  // block with the challan's facts and how it travels beside it, then where
  // it goes.
  return (
    <StoreSheet
      company={company}
      title={template.title}
      number={dc.dcNumber}
      dateLabel="Challan date"
      date={longDate(dc.dcDate) ?? ''}
      backHref="/sales/challan?tab=challans"
      backLabel="Delivery challans"
      banner={banner}
      party={{
        name: c.name,
        lines: (
          <>
            <PartyLine label="Address-" value={billing || null} />
            <PartyLine label="GST No" value={c.gstin ?? 'Unregistered'} mono={Boolean(c.gstin)} />
            <PartyLine label="Contact No" value={c.phone} mono />
            {/* How it travels, under the customer: the left column filled, the right one shorter. */}
            <div style={{ marginTop: '6px' }} />
            <PartyLine label="Transporter" value={dc.transporter} />
            <PartyLine label="Vehicle No" value={dc.vehicleNumber} mono />
            <PartyLine label="LR No" value={dc.lrNumber} mono />
            <PartyLine label="E-way Bill" value={dc.eWayBillNumber} mono />
          </>
        ),
        meta: [
          ['Challan No', dc.dcNumber, true],
          ['Challan Date', shortDate(dc.dcDate), true],
          ['Our Order', `${dc.so.soNumber}, ${shortDate(dc.so.orderDate)}`, true],
          !!dc.so.customerPORef && [
            'Your PO',
            `${dc.so.customerPORef}${dc.so.customerPODate ? `, ${shortDate(dc.so.customerPODate)}` : ''}`,
          ],
          !!data.brand?.name && ['Brand', data.brand?.name],
          dc.so.isJobWork && ['Type', 'Job work (your fabric)'],
          !!dc.so.broker?.name && ['Broker', dc.so.broker?.name],
          bales.length > 0 && ['Bale No', `${bales.join(', ')} (${bales.length})`],
          !!dc.packingListRef && ['Packing list', dc.packingListRef, true],
          ['From store', dc.warehouse?.name ?? null],
        ],
      }}
      bands={[
        {
          icon: 'truck',
          label: 'Deliver to',
          body: (
            <>
              <div style={{ fontSize: '11px', fontWeight: 800, textTransform: 'uppercase' }}>{c.name}</div>
              <div style={{ marginTop: '1px' }}>{dc.deliveryAddress || shipping || billing || <Dash />}</div>
              {consigneeGstin && (
                <div style={{ marginTop: '1px' }}>
                  GST No <span style={CODE}>{consigneeGstin}</span>
                </div>
              )}
            </>
          ),
        },
      ]}
      columns={byRolls ? ROLL_COLUMNS : garments.columns}
      rows={byRolls ? rollRows : garments.rows}
      after={
        <>
          {cartonRows.length > 0 && (
            <>
              <Eyebrow style={{ marginTop: '9px' }}>
                Packing list — {dc.fgCartons!.length} carton{dc.fgCartons!.length === 1 ? '' : 's'}
              </Eyebrow>
              <DocTable columns={CARTON_COLUMNS} rows={cartonRows} fontSize={9} style={{ marginTop: '3px' }} />
            </>
          )}
          <WordsAndTotals
            words={template.showAmountInWords !== false ? data.valueInWords : null}
            left={
              <>
                {/* Only when there is something to say about the packing. */}
                {dc.packingNote && <Note title="Packing">{dc.packingNote}</Note>}
                {dc.notes && <Note title="Note">{dc.notes}</Note>}
              </>
            }
            totals={<TotalsBox rows={totals} totalLabel="Consignment value" total={`₹ ${money(data.value + data.gst)}`} />}
          />
          {/* After the consignment, before the signatures: job work with its rolls named only. */}
          {byRolls && reconRows.length > 0 && (
            <div style={{ breakInside: 'avoid' }}>
              <Eyebrow style={{ marginTop: '9px' }}>Production summary (received vs packed)</Eyebrow>
              <ProductionSummary rows={reconRows} />
            </div>
          )}
          <Terms text={template.termsText} title="Terms" />
          {template.declaration && (
            <Box title="Declaration" style={{ marginTop: '7px' }}>
              {template.declaration}
            </Box>
          )}
        </>
      }
      signatures={[
        { role: `For ${company.name}`, who: dc.dispatchedBy?.name ?? dc.createdBy?.name },
        { role: 'Transporter', who: null },
        { role: 'Received in good condition', who: null },
      ]}
      footerNote={`${template.footerNote ?? 'Delivery challan. Not a tax invoice; the invoice follows separately.'}${printedAt ? ` · Printed ${printedAt}` : ''}`}
    />
  )
}
