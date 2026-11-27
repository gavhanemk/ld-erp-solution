'use client'

import { ratePer, valueAt } from '@/lib/packs'
import { useEffect, useState } from 'react'
import { useParams } from 'next/navigation'
import { api, ApiError } from '@/lib/api'
import {
  Band,
  Box,
  CODE,
  DocTable,
  DocumentSheet,
  HAIR,
  NUM,
  PartyBlock,
  PartyLine,
  Signatures,
  SubLine,
  TotalsBox,
  WordsAndTotals,
  money,
  pct,
  qty,
  shortDate,
  type DocColumn,
} from '@/components/print/doc'

/**
 * The printed return challan — the outward gate pass goods leave the mill on.
 *
 * Read by three people who want different things from it. The security gate
 * checks the vehicle and the count against it and signs it out. The driver
 * carries it with the goods, so it has to say who they are going to and why.
 * The supplier's store receives against it, and the value on it is what an
 * e-way bill is raised on. So: who it is from and to, how it is travelling,
 * what is on the vehicle and what it is worth, why it is going back, and a
 * signature for each hand it passes through.
 *
 * It is not the debit note. The money is settled separately, by accounts, on
 * the note this challan wrote — named in the declaration, so the two can
 * always be matched up, and never printed as a claim here.
 *
 * On the document kit since 27 Nov 2026: black on white, only the logo in
 * colour, and the browser's own pages with the heading repeated on each.
 */

interface Line {
  id: string
  qty: string | number
  unitPrice: string | number
  gstRate: string | number
  remarks: string | null
  /** This row's reason in words — the challan's own where the row had none. */
  reasonLabel?: string
  billLine: {
    hsnCode: string | null
    description: string | null
    grnLine: {
      grn: {
        grnNumber: string
        challanNo?: string | null
        challanDate?: string | null
        po?: { poNumber: string } | null
      }
    } | null
  }
  item: {
    code: string
    name: string
    uom: { symbol: string } | null
    /** A fabric's own stock line carries its design and colour. */
    designNo?: string | null
    color?: string | null
  }
  /** The bill's pack the price is per (a box of 20 pcs); qty is in pieces. */
  uomFactor?: string | number
  uom?: { symbol: string } | null
  warehouse: { name: string }
}

interface Challan {
  id: string
  returnNumber: string
  status: 'DISPATCHED' | 'CANCELLED'
  returnDate: string
  reasonLabel: string
  reasonNote: string | null
  vehicleNo: string | null
  transporterName: string | null
  lrNumber: string | null
  ewayBillNo: string | null
  driverName: string | null
  remarks: string | null
  cancelReason: string | null
  supplier: {
    code: string
    name: string
    gstin: string | null
    address: string | null
    city: string | null
    state: string | null
    pincode: string | null
    phone: string | null
  }
  bill: {
    billNumber: string
    supplierInvoiceNo: string | null
    supplierInvoiceDate: string | null
  }
  createdBy: { name: string }
  lines: Line[]
  debitNotes: Array<{ noteNumber: string; status: string }>
  taxableValue: number
  gstValue: number
  totalValue: number
}

interface PrintData {
  company: Record<string, string | null>
  template: { title: string; footerNote: string | null; showSignature: boolean } | null
  challan: Challan
  totalInWords: string
}

/*
 * Every column the old sheet had, the unit split out of the quantity so a
 * figure like 13,500.000 has its own room. Shares sized for an eight-digit
 * HSN, a godown's name and a value like 12,84,650.00 at 9.5px.
 */
const COLUMNS: DocColumn[] = [
  { key: 'sn', head: '#', weight: 4, align: 'center' },
  { key: 'item', head: 'Item & Description', weight: 29 },
  { key: 'hsn', head: 'HSN', weight: 9 },
  { key: 'godown', head: 'From godown', weight: 13 },
  { key: 'qty', head: 'Qty', weight: 11, align: 'right' },
  { key: 'uom', head: 'UOM', weight: 6, align: 'center' },
  { key: 'rate', head: 'Rate', weight: 11, align: 'right' },
  { key: 'gst', head: 'GST %', weight: 6.5, align: 'right' },
  { key: 'value', head: 'Value (₹)', weight: 13, align: 'right' },
]

/** A transport fact, or a line to write it on where it was not typed. */
function TransportFact({ label, value }: { label: string; value: string | null }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '70px 8px minmax(0, 1fr)', alignItems: 'baseline', lineHeight: 1.6 }}>
      <span>{label}</span>
      <span>:</span>
      {value ? (
        <span style={{ fontWeight: 700, overflowWrap: 'anywhere', ...CODE }}>{value}</span>
      ) : (
        <span aria-hidden style={{ display: 'block', borderBottom: HAIR, height: '11px' }} />
      )}
    </div>
  )
}

export default function PurchaseReturnPrintPage() {
  const params = useParams<{ id: string }>()
  const [data, setData] = useState<PrintData | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    void (async () => {
      try {
        const res = await api.get<{ data: PrintData }>('/purchase/returns/' + params.id + '/print')
        setData(res.data)
      } catch (err) {
        setError(err instanceof ApiError ? err.message : 'Could not build the sheet.')
      }
    })()
  }, [params.id])

  if (error) {
    return (
      <div style={{ maxWidth: '210mm', margin: '40px auto', background: '#fff', padding: '24px' }}>
        <p style={{ margin: 0 }}>{error}</p>
      </div>
    )
  }
  if (!data) {
    return <div style={{ maxWidth: '210mm', margin: '40px auto', color: '#fff', textAlign: 'center' }}>Building the sheet…</div>
  }

  const c = data.challan
  const co = data.company
  // Rows that went back for different reasons each print their own.
  const mixed = c.lines.some((l) => l.reasonLabel && l.reasonLabel !== c.reasonLabel)
  const cancelled = c.status === 'CANCELLED'

  const supplierAddress = [c.supplier.address, c.supplier.city, c.supplier.state, c.supplier.pincode]
    .filter(Boolean)
    .join(', ')

  // The order and their delivery challan, off the receipts the lines came in
  // on — the two numbers a supplier's store looks the goods up by.
  const grns = c.lines.map((l) => l.billLine.grnLine?.grn).filter((g): g is NonNullable<typeof g> => Boolean(g))
  const pos = [...new Set(grns.map((g) => g.po?.poNumber).filter(Boolean))]
  const theirChallans = [
    ...new Set(grns.filter((g) => g.challanNo).map((g) => g.challanNo + (g.challanDate ? ' · ' + shortDate(g.challanDate) : ''))),
  ]

  const theirBill =
    (c.bill.supplierInvoiceNo ?? '—') + (c.bill.supplierInvoiceDate ? ' · ' + shortDate(c.bill.supplierInvoiceDate) : '')

  /*
   * What is on the vehicle, with the godown each line left from — so the
   * store keeper who loaded it and the gate who counts it are reading the same
   * row — and the receipt it originally came in on, so the supplier's store
   * can find it at their end.
   */
  const rows = c.lines.map((l, i) => {
    const shade = [l.item.designNo && `D.${l.item.designNo.replace(/^d\.?\s*/i, '')}`, l.item.color].filter(Boolean).join(' / ')
    const sub = [
      shade || null,
      mixed ? l.reasonLabel : null,
      l.billLine.description,
      l.remarks,
      l.billLine.grnLine && 'received on ' + l.billLine.grnLine.grn.grnNumber,
    ]
      .filter(Boolean)
      .join(' · ')
    const per = ratePer(l)
    return {
      key: l.id,
      cells: {
        sn: <span style={NUM}>{i + 1}</span>,
        item: (
          <>
            <div>
              <strong>{l.item.name}</strong> ·{' '}
              {/* A code breaks before itself, never inside. */}
              <span style={{ ...CODE, fontSize: '8.5px', letterSpacing: 0, whiteSpace: 'nowrap' }}>{l.item.code}</span>
            </div>
            {sub && <SubLine>{sub}</SubLine>}
          </>
        ),
        hsn: <span style={NUM}>{l.billLine.hsnCode ?? '—'}</span>,
        godown: l.warehouse.name,
        qty: <strong>{qty(l.qty)}</strong>,
        uom: l.item.uom?.symbol ?? '—',
        rate: (
          <>
            {money(l.unitPrice)}
            {per && <SubLine>{per}</SubLine>}
          </>
        ),
        gst: pct(l.gstRate),
        value: <strong>{money(valueAt(l, l.unitPrice))}</strong>,
      },
    }
  })

  return (
    <DocumentSheet
      company={co}
      title={data.template?.title || 'Purchase Return Challan'}
      number={c.returnNumber}
      date={shortDate(c.returnDate)}
      hideNumber
      copyLabel="Outward gate pass"
      // A cancelled challan still prints — the gate may need to see why a
      // vehicle it signed out has no paper behind it any more — but it says
      // so across the sheet, not in a corner.
      banner={cancelled ? 'Cancelled' : undefined}
      backHref="/purchase/returns"
      backLabel="Returns"
      copies={1}
      fileName={c.returnNumber + ' ' + c.supplier.name}
      footerNote={[`${c.returnNumber} · ${c.supplier.name} · against ${c.bill.billNumber}`, data.template?.footerNote]
        .filter(Boolean)
        .join('  ·  ')}
    >
      {/* Returned to, with the challan's own facts beside it. */}
      <PartyBlock
        heading="Returned to,"
        name={c.supplier.name}
        code={c.supplier.code}
        meta={[
          ['Challan No', c.returnNumber, true],
          ['Date', shortDate(c.returnDate), true],
          ['Against our bill', c.bill.billNumber, true],
          ['Their bill no.', theirBill, true],
          pos.length > 0 && ['Our PO no.', pos.join(', '), true],
          theirChallans.length > 0 && ['Their challan', theirChallans.join(', '), true],
        ]}
      >
        <PartyLine label="Address-" value={supplierAddress || null} />
        <PartyLine label="GST No" value={c.supplier.gstin} mono />
        <PartyLine label="Contact No" value={c.supplier.phone} mono />
      </PartyBlock>

      {/* The vehicle taking the goods: what the gate and the driver look for first. */}
      <Band icon="truck" label="Transport">
        {/* The transporter's name is the long one: its column gets the room. */}
        <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1.35fr) minmax(0, 0.9fr)', columnGap: '14px' }}>
          <TransportFact label="Vehicle no." value={c.vehicleNo} />
          <TransportFact label="Transporter" value={c.transporterName} />
          <TransportFact label="LR no." value={c.lrNumber} />
          <TransportFact label="E-way bill no." value={c.ewayBillNo} />
          <TransportFact label="Driver" value={c.driverName} />
        </div>
      </Band>

      <DocTable columns={COLUMNS} rows={rows} />

      <WordsAndTotals
        words={data.totalInWords}
        totals={
          <TotalsBox
            rows={[
              { label: 'Taxable value', value: money(c.taxableValue) },
              { label: 'GST', value: money(c.gstValue) },
            ]}
            totalLabel="Value of goods returned"
            total={`₹ ${money(c.totalValue)}`}
          />
        }
      />

      <Box title="Reason for return" style={{ marginTop: '7px' }}>
        <div style={{ fontSize: '10px', fontWeight: 700 }}>
          {c.reasonLabel}
          {mixed ? ' and others — see each line' : ''}
        </div>
        {c.reasonNote && <div>{c.reasonNote}</div>}
        {c.remarks && <div style={{ marginTop: '4px', whiteSpace: 'pre-line' }}>{c.remarks}</div>}
        {cancelled && c.cancelReason && (
          <div style={{ marginTop: '4px', fontWeight: 700 }}>Cancelled: {c.cancelReason}</div>
        )}
      </Box>

      {/* The declaration a return challan carries: these goods are going back,
          they are not being sold. A driver stopped on the road with goods and
          no invoice is asked exactly that. */}
      <Band label="Declaration">
        Goods returned to the supplier for the reason stated above. Not a sale. The value shown is for transport and
        e-way bill purposes; the amount is settled separately on debit note{' '}
        <strong style={CODE}>{c.debitNotes.map((n) => n.noteNumber).join(', ') || '—'}</strong>.
      </Band>

      {/* Four hands: whoever loaded it, the gate that let it out, the driver
          or supplier who took it, and the mill's authority. A gate pass with
          one signature on it is a gate pass anybody could have written. */}
      {data.template?.showSignature !== false && (
        <Signatures
          company={co.name}
          roles={[
            { role: 'Prepared by', sub: c.createdBy.name },
            { role: 'Checked out by', sub: 'Security · Time' },
            { role: 'Received by', sub: 'Driver / supplier' },
            { role: 'Authorised signatory', sub: co.name ? `For ${co.name}` : null },
          ]}
        />
      )}
    </DocumentSheet>
  )
}
