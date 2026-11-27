'use client'

import { inPack, ratePer } from '@/lib/packs'
import { useCallback, useEffect, useState } from 'react'
import { useParams } from 'next/navigation'
import { api, ApiError } from '@/lib/api'
import {
  Box,
  BoxRow,
  CODE,
  Dash,
  DocTable,
  DocumentSheet,
  Eyebrow,
  Fact,
  NUM,
  Note,
  PartyBlock,
  PartyLine,
  Signatures,
  SubLine,
  TotalsBox,
  WordsAndTotals,
  money,
  qty,
  shortDate,
  type DocColumn,
} from '@/components/print/doc'

/**
 * The printed goods receipt note.
 *
 * Built to the same sheet as the purchase order (components/print/doc) —
 * because they are two halves of one conversation with a supplier, and
 * arriving in different clothes would make them look like they came from
 * different companies. Black on white since 27 Nov 2026; only the company
 * logo keeps its colours.
 *
 * The content follows the mill's old ERP, surveyed on 18 Sep 2026: who it came
 * from, the delivery, the order it answers, the items, the money, and three
 * signatures — Prepared By, Inspected By, Authorized By.
 *
 * Two deliberate departures from the old note, both because our receipt knows
 * more than theirs did:
 *
 * - **Rejected quantity is printed.** The old note showed only what was taken.
 *   A driver standing at the gate is owed a piece of paper saying what is
 *   going back on the lorry, and the store keeper is owed one saying why the
 *   figure is short.
 * - **The store is printed against each line.** One delivery can be split
 *   across godowns, and a note that does not say where the goods went is a
 *   note nobody can use to find them.
 *
 * Every figure is worked out by the API and laid out here. A sheet that does
 * its own arithmetic is a second implementation of the arithmetic, and the two
 * drift.
 */

// ─────────────────────────────────────────────────────────────
// The payload
// ─────────────────────────────────────────────────────────────

interface GrnLine {
  id: string
  orderedQty: string
  receivedQty: string
  rejectedQty: string
  acceptedQty: string
  unitRate: string
  discountPct: number
  gstPct: number
  gross: number
  discountAmount: number
  taxable: number
  item: {
    code: string
    name: string
    hsnCode: string | null
    uom: { symbol: string } | null
    /** A fabric's own stock line carries its design and colour, when the API sends them. */
    designNo?: string | null
    color?: string | null
  }
  /** The order's pack (a box of 20 pcs): quantities are in pieces, the rate per pack. */
  uomFactor?: string | number
  uom?: { symbol: string } | null
  warehouse: { name: string } | null
  poLine: { description: string | null; hsnCode: string | null } | null
  /** How it came packed: one sticker per roll, bale or box. */
  packs: { count: number; packType: string; sizes: number[] } | null
}

const PACK_WORD: Record<string, [string, string]> = {
  ROLL: ['roll', 'rolls'],
  BUNDLE: ['bundle', 'bundles'],
  BOX: ['box', 'boxes'],
  CARTON: ['carton', 'cartons'],
  BAG: ['bag', 'bags'],
  PACKET: ['packet', 'packets'],
  OTHER: ['package', 'packages'],
}
/** "5 rolls", "1 roll". */
const packsText = (count: number, type: string) => `${count} ${(PACK_WORD[type] ?? PACK_WORD.OTHER)[count === 1 ? 0 : 1]}`

interface Payload {
  company: Record<string, string | null>
  template: { title: string; footerNote: string | null; showAmountInWords: boolean }
  grn: {
    grnNumber: string
    grnDate: string
    vehicleNo: string | null
    notes: string | null
    gateEntryNo: string | null
    gateEntryDate: string | null
    challanNo: string | null
    challanDate: string | null
    supplierBillNo: string | null
    supplierInvoiceNo: string | null
    supplierInvoiceDate: string | null
    packageCount: number | null
    driverName: string | null
    formNo: string | null
    clientName: string | null
    orderedBy: string | null
    referenceNo: string | null
    createdBy: { name: string } | null
    po: {
      poNumber: string
      poDate: string
      supplier: {
        name: string
        address: string | null
        city: string | null
        state: string | null
        pincode: string | null
        gstin: string | null
        phone: string | null
      } | null
    }
    lines: GrnLine[]
  }
  totals: {
    subtotal: number
    discount: number
    taxable: number
    cgst: number
    sgst: number
    igst: number
    tax: number
    roundOff: number
    total: number
    rejectedQty: number
  }
  totalInWords: string
  taxMode: 'IGST' | 'CGST_SGST' | 'NONE'
}

/**
 * The receipt carries the hour as well as the day: two deliveries from the
 * same supplier on one day are told apart by nothing else.
 */
const dateTime = (v: string) =>
  new Date(v).toLocaleString('en-GB', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: true,
  })

/*
 * The item table's columns.
 *
 * Eleven of them, and the four quantity columns are the reason this sheet
 * exists: ordered, arrived, rejected and into stock, side by side, so a short
 * or a refused delivery is a thing you can see rather than a subtraction you
 * have to do. Widths are shares of the row, sized so a quantity like
 * 13,500.000 and an amount like 12,84,650.00 sit inside their own column.
 */
const COLUMNS: DocColumn[] = [
  { key: 'sn', head: 'S.N', weight: 3.8, align: 'center' },
  { key: 'code', head: 'Item Code', weight: 10.9 },
  { key: 'desc', head: 'Description', weight: 16.6 },
  { key: 'store', head: 'Store', weight: 8.9 },
  { key: 'uom', head: 'UOM', weight: 4.6, align: 'center' },
  { key: 'ord', head: 'Ordered', weight: 9.1, align: 'right' },
  { key: 'rec', head: 'Arrived', weight: 9.1, align: 'right' },
  { key: 'rej', head: 'Rejected', weight: 9.1, align: 'right' },
  { key: 'acc', head: 'Into stock', weight: 9.1, align: 'right' },
  { key: 'rate', head: 'Rate', weight: 8.4, align: 'right' },
  { key: 'amt', head: 'Amount (₹)', weight: 10.4, align: 'right' },
]

// ─────────────────────────────────────────────────────────────

export default function PrintGoodsReceipt() {
  const { id } = useParams<{ id: string }>()
  const [data, setData] = useState<Payload | null>(null)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      const res = await api.get<{ data: Payload }>(`/purchase/grn/${id}/print`)
      setData(res.data)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not open that goods receipt.')
    }
  }, [id])

  useEffect(() => {
    void load()
  }, [load])

  if (error) {
    return (
      <div style={{ maxWidth: '210mm', margin: '40px auto', background: '#fff', padding: '24px' }}>
        <p style={{ margin: 0 }}>{error}</p>
      </div>
    )
  }
  if (!data) {
    return <div style={{ maxWidth: '210mm', margin: '40px auto', color: '#fff', textAlign: 'center' }}>Opening the receipt…</div>
  }

  const { company, template, grn, totals, taxMode } = data
  const supplier = grn.po.supplier

  const supplierAddress = [supplier?.address, supplier?.city, supplier?.state, supplier?.pincode].filter(Boolean).join(', ')

  // The gate's own count when it was written down, else one per sticker made on receipt.
  const packages =
    grn.packageCount != null
      ? String(grn.packageCount)
      : grn.lines.some((l) => l.packs)
        ? String(grn.lines.reduce((t, l) => t + (l.packs?.count ?? 0), 0))
        : null

  const rows = grn.lines.map((line, i) => {
    const rejected = Number(line.rejectedQty)
    const arrivedInPack = inPack({ ...line, qty: line.receivedQty })
    const per = ratePer(line)
    const shade = [line.item.designNo && `D.${line.item.designNo.replace(/^d\.?\s*/i, '')}`, line.item.color].filter(Boolean).join(' / ')
    return {
      key: line.id,
      cells: {
        sn: <span style={NUM}>{i + 1}</span>,
        code: <span style={{ ...CODE, fontSize: '8.5px', letterSpacing: 0 }}>{line.item.code}</span>,
        desc: (
          <>
            <div style={{ fontWeight: 700 }}>{line.item.name}</div>
            {shade && <SubLine>{shade}</SubLine>}
            {line.poLine?.description && <SubLine>{line.poLine.description}</SubLine>}
            {/* How many rolls (or bales, boxes) it came in, and each one's size. */}
            {line.packs && (
              <SubLine>
                <strong>{packsText(line.packs.count, line.packs.packType)}</strong>
                {line.packs.count > 1 ? `: ${line.packs.sizes.map((q) => qty(q)).join(', ')} ${line.item.uom?.symbol ?? ''}` : ''}
              </SubLine>
            )}
          </>
        ),
        store: line.warehouse?.name ?? <Dash />,
        uom: line.item.uom?.symbol ?? <Dash />,
        ord: qty(line.orderedQty),
        rec: (
          <>
            {qty(line.receivedQty)}
            {arrivedInPack.pieces && (
              <SubLine>
                = {qty(arrivedInPack.qty)} {arrivedInPack.unit}
              </SubLine>
            )}
          </>
        ),
        // Rejected goods in bold: the number the driver is going to be asked about at the gate.
        rej: rejected > 0 ? <strong>{qty(rejected)}</strong> : <Dash />,
        acc: <strong>{qty(line.acceptedQty)}</strong>,
        rate: (
          <>
            {money(line.unitRate)}
            {per && <SubLine>{per}</SubLine>}
          </>
        ),
        amt: <strong>{money(line.taxable)}</strong>,
      },
    }
  })

  const totalRows = [
    { label: 'Total discount', value: money(totals.discount) },
    { label: 'Sub total', value: money(totals.taxable) },
    ...(taxMode === 'CGST_SGST'
      ? [
          { label: 'SGST', value: money(totals.sgst) },
          { label: 'CGST', value: money(totals.cgst) },
        ]
      : []),
    ...(taxMode === 'IGST' ? [{ label: 'IGST', value: money(totals.igst) }] : []),
    ...(taxMode === 'NONE' ? [{ label: 'GST', value: 'Not registered' }] : []),
    ...(Math.abs(totals.roundOff) >= 0.005 ? [{ label: 'Rounding', value: money(totals.roundOff) }] : []),
  ]

  return (
    <DocumentSheet
      company={company}
      title={template.title}
      number={grn.grnNumber}
      hideNumber
      backHref="/purchase/grn"
      backLabel="Goods receipts"
      copies={1}
      fileName={grn.grnNumber}
      footerNote={template.footerNote ?? 'Goods received subject to inspection. This note is not a tax invoice.'}
    >
      {/* Who it came from, with the receipt's own facts and the order it answers beside it. */}
      <PartyBlock
        heading="Received from,"
        name={supplier?.name ?? 'Supplier not named'}
        meta={[
          ['GRN No', grn.grnNumber, true],
          ['Received', dateTime(grn.grnDate), true],
          ['PO No', grn.po.poNumber, true],
          ['PO Date', shortDate(grn.po.poDate), true],
        ]}
      >
        <PartyLine label="Address-" value={supplierAddress || null} />
        <PartyLine label="GST No" value={supplier?.gstin ?? null} mono />
        <PartyLine label="Phone" value={supplier?.phone ?? null} mono />
      </PartyBlock>

      {/* The delivery, and the other papers it came with. The question asked of a
          receipt six months later is almost always "which delivery was that", and
          the delivery box answers it. */}
      <BoxRow>
        <Box title="The delivery">
          <Fact label="Gate entry" value={grn.gateEntryNo} mono />
          <Fact label="Gate date" value={shortDate(grn.gateEntryDate)} mono />
          <Fact label="Challan No" value={grn.challanNo} mono />
          <Fact label="Challan date" value={shortDate(grn.challanDate)} mono />
          <Fact label="Packages" value={packages} mono />
          <Fact label="Vehicle No" value={grn.vehicleNo} mono />
          <Fact label="Driver" value={grn.driverName} />
        </Box>
        <Box title="Against">
          <Fact label="Bill No" value={grn.supplierInvoiceNo} mono />
          <Fact label="Bill date" value={shortDate(grn.supplierInvoiceDate)} mono />
          <Fact label="Form No" value={grn.formNo} mono />
          <Fact label="Client" value={grn.clientName} />
          <Fact label="Ordered by" value={grn.orderedBy} />
          <Fact label="Reference" value={grn.referenceNo} mono />
        </Box>
      </BoxRow>

      <DocTable columns={COLUMNS} rows={rows} />

      <WordsAndTotals
        left={
          <>
            {template.showAmountInWords && (
              <div>
                <Eyebrow>Value of goods taken in</Eyebrow>
                <div style={{ fontSize: '11px', fontWeight: 700, lineHeight: 1.4, marginTop: '2px' }}>{data.totalInWords}</div>
              </div>
            )}

            {/* Said in words as well as in the column, because a short delivery is
                the thing somebody has to act on today and a figure in a table is
                easy to read past. */}
            {totals.rejectedQty > 0 && (
              <div style={{ border: '1.25pt solid #000', padding: '5px 8px' }}>
                <Eyebrow>Not taken into stock</Eyebrow>
                <div style={{ fontSize: '9.5px', lineHeight: 1.5, marginTop: '2px' }}>
                  <strong style={NUM}>{qty(totals.rejectedQty)}</strong> rejected at the gate and going back with the vehicle.
                  Nothing on this note has been valued for it, and the order still owes the quantity.
                </div>
              </div>
            )}

            {grn.notes && <Note title="Note">{grn.notes}</Note>}
          </>
        }
        totals={<TotalsBox rows={totalRows} total={`₹ ${money(totals.total)}`} />}
      />

      {/* Three, as the old note has them. Prepared By is filled in from who
          recorded the receipt — a signature line anybody can write any name on
          is not a signature line. The other two are signed by hand at the gate. */}
      <Signatures
        company={company.name}
        roles={[
          { role: 'Prepared by', who: grn.createdBy?.name ?? null },
          { role: 'Inspected by' },
          { role: 'Authorized by' },
        ]}
      />
    </DocumentSheet>
  )
}
