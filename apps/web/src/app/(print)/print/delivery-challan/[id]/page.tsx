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
  /** Job work: one row per customer receipt the challan's rolls came on. */
  reconciliation?: Array<{
    grnNumber: string
    receiptDate: string
    partyChallan: string | null
    lots: string[]
    receivedRolls: number
    receivedMeters: number
    packedPieces: number
  }>
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
    /** Job work: the customer's rolls the pieces were made from. */
    rolls?: Array<{
      id: string
      soLineId: string | null
      baleNo: string | null
      pieces: string | number
      grade: string
      roll: {
        id: string
        barcode: string
        meters: string | number
        designNo: string | null
        lotNo: string | null
        line: { item: { code: string; name: string } }
      }
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
 * garment, the job charge's SAC, the roll's design, the grade, the customer's
 * barcode, the bale, the roll's metres and the pieces made from it.
 */
const ROLL_COLUMNS: SheetColumn[] = [
  { key: 'sn', head: 'S.N', width: '4%', align: 'center' },
  { key: 'garment', head: 'Merchant name', width: '24%' },
  { key: 'hsn', head: 'HSN / SAC', width: '9%' },
  { key: 'design', head: 'Design', width: '11%' },
  { key: 'grade', head: 'Grade', width: '8%' },
  { key: 'barcode', head: 'Barcode', width: '14%' },
  { key: 'bale', head: 'Bale', width: '8%' },
  { key: 'mtrs', head: 'Mtrs', width: '11%', align: 'right' },
  { key: 'pcs', head: 'Pcs', width: '11%', align: 'right' },
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
function ProductionSummary({ rows }: { rows: Array<{ key: string; cells: Record<string, React.ReactNode> }> }) {
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
            {cols.map((c, i) => (
              <td
                key={c.key}
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
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  )
}

/** A grade as the job challan prints it. */
const gradeLabel = (g?: string | null) => (g === 'B' ? 'B-grade' : 'Fresh Pc')
const metres = (n: number) => n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

/**
 * The delivery challan that travels with the goods.
 *
 * What is in the cartons — garment, colour, size breakup, pieces — and how it
 * travels. No rates per line: the value of the consignment is printed once,
 * as the e-way bill and the transporter need it. It is not a tax invoice and
 * says so. A draft or a cancelled challan prints with a band across the top.
 *
 * A job-work challan whose rolls are named prints the old ERP's job challan
 * (28 Nov 2026): roll by roll — barcode, bale, metres, pieces — with a total
 * for each garment, the bales in the header, and what came in on each receipt
 * beside what was packed from it.
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
  const rolls = dc.so.isJobWork ? (dc.rolls ?? []) : []
  const byRolls = rolls.length > 0

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
  const lineFor = (soLineId: string | null) => dc.lines.find((l) => l.soLineId === soLineId || l.soLine?.id === soLineId) ?? dc.lines[0]
  const groups: Array<{ key: string; rows: typeof rolls }> = []
  for (const r of rolls) {
    const key = r.soLineId ?? ''
    const g = groups.find((x) => x.key === key)
    if (g) g.rows.push(r)
    else groups.push({ key, rows: [r] })
  }
  /** Each roll's metres once, however many rows (grades) it is on. */
  const metresOf = (rs: typeof rolls) => {
    const seen = new Map<string, number>()
    for (const r of rs) seen.set(r.roll.id, Number(r.roll.meters))
    return [...seen.values()].reduce((s, m) => s + m, 0)
  }
  let sn = 0
  const rollRows = groups.flatMap((g) => {
    const line = lineFor(g.key || null)
    const garment = line ? (
      <>
        <strong>{line.item.name}</strong>
        <div style={{ ...CODE, color: MUTED }}>{[line.soLine?.styleCode ?? line.item.style?.code, line.item.code].filter(Boolean).join(' · ')}</div>
      </>
    ) : (
      <Dash />
    )
    const hsn = line?.soLine?.hsnCode ?? line?.item.hsnCode ?? null
    // The garment and its SAC once, run down beside all its rolls (one merged cell each).
    const body = g.rows.map((r, j) => ({
      key: r.id,
      ...(j === 0 ? { spans: { garment: g.rows.length, hsn: g.rows.length } } : { covered: ['garment', 'hsn'] }),
      cells: {
        sn: ++sn,
        garment: j === 0 ? garment : '',
        hsn: j > 0 ? '' : hsn ? <span style={CODE}>{hsn}</span> : <Dash />,
        design: r.roll.designNo ?? <Dash />,
        grade: gradeLabel(r.grade),
        barcode: <span style={CODE}>{r.roll.barcode}</span>,
        bale: r.baleNo ?? <Dash />,
        mtrs: <span style={NUM}>{metres(Number(r.roll.meters))}</span>,
        pcs: <span style={NUM}>{qty(Number(r.pieces))}</span>,
      },
    }))
    const total = {
      key: `${g.key}-total`,
      total: true,
      shade: true,
      cells: {
        sn: '',
        garment: 'Total',
        hsn: '',
        design: '',
        grade: '',
        barcode: `${new Set(g.rows.map((r) => r.roll.id)).size} rolls`,
        bale: '',
        mtrs: <span style={NUM}>{metres(metresOf(g.rows))}</span>,
        pcs: <span style={NUM}>{qty(g.rows.reduce((s, r) => s + Number(r.pieces), 0))}</span>,
      },
    }
    return [...body, total]
  })

  const bales = [...new Set(rolls.map((r) => r.baleNo?.trim()).filter((b): b is string => !!b))]
  const rollMetres = metresOf(rolls)
  const pieces = dc.lines.reduce((s, l) => s + Number(l.qty), 0)

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
  const reconRows = (data.reconciliation ?? []).map((r) => ({
    key: r.grnNumber,
    cells: {
      recDate: shortDate(r.receiptDate),
      lot: r.lots.join(', ') || <Dash />,
      party: r.partyChallan ?? <Dash />,
      recPcs: <span style={NUM}>{r.receivedRolls}</span>,
      recMtr: <span style={NUM}>{metres(r.receivedMeters)}</span>,
      pckDate: shortDate(dc.dcDate),
      chl: <span style={CODE}>{dc.dcNumber}</span>,
      pckPcs: <span style={NUM}>{qty(r.packedPieces)}</span>,
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
    ...(byRolls
      ? [
          { label: 'Metres', value: metres(rollMetres) },
          { label: 'Bales', value: bales.length ? String(bales.length) : <Dash /> },
        ]
      : []),
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
          byRolls && ['Bale No', bales.length ? `${bales.join(', ')} (${bales.length})` : null],
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
