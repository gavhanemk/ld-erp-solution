'use client'

import { inPack } from '@/lib/packs'
import { chargeSnapshot } from '@ld-erp/shared'

import { useCallback, useEffect, useState } from 'react'
import { useParams, useSearchParams } from 'next/navigation'
import { api, ApiError } from '@/lib/api'
import type { TaxByRate as TaxByRateRow } from '@ld-erp/shared'
import {
  Band,
  Banner,
  CODE,
  Dash,
  DocTable,
  DocumentSheet,
  NUM,
  Note,
  PartyBlock,
  PartyLine,
  Signatures,
  SubLine,
  TaxByRate,
  Terms,
  TotalsBox,
  WordsAndTotals,
  money,
  pct,
  shortDate,
  type DocColumn,
} from '@/components/print/doc'

/**
 * The printed purchase order — the sheet the whole document kit was drawn
 * from (components/print/doc). Black on white since 27 Nov 2026; only the
 * company logo keeps its colours.
 *
 * Pages are the browser's: the line table's heading repeats on every page, a
 * line never splits across two, and each page's margin carries the order
 * number and "Page n of N" — so an order of any length prints whole, with
 * nothing clipped and no column running into the next.
 */

interface Line {
  id: string
  description: string | null
  /** What the buyer typed for the garment; `style` is the master it matched. */
  styleNo: string | null
  style: { code: string; name: string } | null
  hsnCode: string | null
  qty: string
  /** The pack it is ordered in (a box of 20 pcs); qty is in the item's own unit. */
  uomFactor?: string | number
  uom?: { symbol: string } | null
  unitRate: string
  discount: string
  gstRate: string
  amount: string
  item: {
    code: string
    name: string
    /** A fabric's own stock line carries its design and colour. */
    designNo?: string | null
    color?: string | null
    /** The fabric a design / colour line sits under. */
    parentItem?: { name: string } | null
    uom?: { symbol: string } | null
    category?: { name: string; parent?: { name: string } | null } | null
  }
}

interface PrintPayload {
  company: Record<string, string | null>
  template: {
    title: string
    termsText: string | null
    declaration: string | null
    footerNote: string | null
    showHsn: boolean
    showAmountInWords: boolean
    showSignature: boolean
    copies: string[]
  }
  order: {
    poNumber: string
    poDate: string
    deliveryDate?: string | null
    poType: string | null
    isService?: boolean
    enquiryNo: string | null
    enquiryDate: string | null
    reference: string | null
    supplierAddress: string | null
    notes: string | null
    terms: string | null
    subtotal: string
    discountAmount: string
    taxableAmount: string
    cgst: string
    sgst: string
    igst: string
    roundOff: string
    otherCharges: string
    charges: { taxSnapshot?: unknown; amount: string; gstRate: string; chargeType: { name: string } }[]
    totalAmount: string
    supplier: Record<string, string | null> & { creditDays?: number | null }
    deliveryWarehouse: { name: string; address: string | null } | null
    deliveryCustomer: { name: string; code: string; gstin: string | null } | null
    deliveryAddress: string | null
    brand?: { name: string } | null
    createdBy: { name: string } | null
    lines: Line[]
  }
  totalInWords: string
  taxMode: 'IGST' | 'CGST_SGST' | 'NONE'
  /** GST rate by rate, goods and charges together; null when it would not add up. */
  taxByRate?: TaxByRateRow[] | null
}

/** "Raw Materials › Fabric" from whichever level the item was filed under. */
function categoryPath(c?: { name: string; parent?: { name: string } | null } | null): string | null {
  if (!c) return null
  return c.parent ? `${c.parent.name} › ${c.name}` : c.name
}

/*
 * Twelve columns, every one the old sheet had. Widths are shares of the row,
 * sized to what each column holds at 9.5px: an eight-digit HSN, a quantity
 * like 13,500.00 with its pack line, an amount like ₹12,84,650.00. They
 * overlapped when HSN had 5% and Qty 8% of the row.
 */
const COLUMNS: DocColumn[] = [
  { key: 'sn', head: 'S.N', weight: 4.2, align: 'center' },
  { key: 'item', head: 'Description', weight: 20.5 },
  { key: 'colour', head: 'Design / Colour', weight: 9 },
  { key: 'code', head: 'Item Code', weight: 12 },
  { key: 'style', head: 'Style No.', weight: 7.5 },
  { key: 'hsn', head: 'HSN', weight: 8 },
  { key: 'qty', head: 'Qty', weight: 10.5, align: 'right' },
  { key: 'uom', head: 'UOM', weight: 5.5, align: 'center' },
  { key: 'rate', head: 'Rate', weight: 9, align: 'right' },
  { key: 'disc', head: 'Disc', weight: 5.5, align: 'right' },
  { key: 'gst', head: 'GST', weight: 5, align: 'right' },
  { key: 'amount', head: 'Amount (₹)', weight: 12.5, align: 'right' },
]

export default function PrintPurchaseOrder() {
  const { id } = useParams<{ id: string }>()
  const params = useSearchParams()
  const [data, setData] = useState<PrintPayload | null>(null)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      const res = await api.get<{ success: boolean; data: PrintPayload }>(`/purchase/orders/${id}/print`)
      setData(res.data)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load this order.')
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
    return <div style={{ maxWidth: '210mm', margin: '40px auto', color: '#fff', textAlign: 'center' }}>Loading...</div>
  }

  const { company, template, taxMode } = data
  const order = data.order
  const supplier = order.supplier

  /*
   * Layout previews, stamped DO NOT SEND whenever used:
   * `?lines=n` repeats the order's lines to n, `?to=customer` shows the
   * direct-to-customer band, `?charges=1` adds sample charge rows.
   */
  const sampleCount = Number(params.get('lines'))
  const sampleLines = Number.isFinite(sampleCount) && sampleCount >= 1 && sampleCount <= 200
  const sampleCustomer = params.get('to') === 'customer'
  const sampleCharges = params.get('charges') === '1'
  const preview = sampleLines || sampleCustomer || sampleCharges
  const lines: Line[] =
    sampleLines && order.lines.length
      ? Array.from({ length: sampleCount }, (_, i) => {
          const src = order.lines[i % order.lines.length]
          return { ...src, id: `${src.id}-preview-${i}` }
        })
      : order.lines

  const sheetOrder: PrintPayload['order'] = preview
    ? {
        ...order,
        enquiryNo: order.enquiryNo ?? 'SQ/2026/0187',
        enquiryDate: order.enquiryDate ?? order.poDate,
        reference: order.reference ?? 'IND-4471',
        ...(sampleCharges
          ? {
              charges: [
                { amount: '150.00', gstRate: '5', chargeType: { name: 'Transport Charges' } },
                { amount: '80.00', gstRate: '18', chargeType: { name: 'Packing Charges' } },
                { amount: '0.00', gstRate: '0', chargeType: { name: 'Loading / Unloading' } },
              ],
            }
          : {}),
        ...(sampleCustomer
          ? {
              deliveryCustomer: { name: 'Shreeji Garments', code: 'CUST-0042', gstin: null },
              deliveryWarehouse: null,
              deliveryAddress: 'Gala 7, Sai Industrial Estate, Dapoda Road, Bhiwandi, Thane, Maharashtra, 421302',
            }
          : {}),
      }
    : order

  const companyAddress = [company.address, company.city, company.state, company.pincode].filter(Boolean).join(', ')
  // The address frozen onto the order wins over the master's current one.
  const supplierAddress =
    order.supplierAddress || [supplier.address, supplier.city, supplier.state, supplier.pincode].filter(Boolean).join(', ')
  const paymentTerms = supplier.paymentTerms || (supplier.creditDays ? `${supplier.creditDays} days` : null)

  // Each charge by name, at its own rate where it carries one: "Transport Charges @5%".
  const chargeName = (c: PrintPayload['order']['charges'][number]) => chargeSnapshot(c.taxSnapshot)?.name ?? c.chargeType.name
  const chargeLines = (sheetOrder.charges ?? []).map((c) => ({
    label: taxMode !== 'NONE' && Number(c.gstRate) > 0 ? `${chargeName(c)} @${Number(c.gstRate)}%` : chargeName(c),
    value: money(c.amount),
  }))

  // Goods at 0% still show; charges at 0% (GST inside the figure) do not.
  const gstSummary =
    taxMode !== 'NONE' && Array.isArray(data.taxByRate) && data.taxByRate.length > 0
      ? data.taxByRate
          .filter((b) => Number(b.gstRate) > 0 || b.goodsTaxable > 0)
          .map((b) => (Number(b.gstRate) > 0 ? b : { ...b, taxable: b.goodsTaxable }))
      : []

  const totalRows = [
    // The whole-order discount only; each line's own is in its Disc column.
    { label: 'Order Discount', value: money(order.discountAmount) },
    { label: 'Sub Total', value: money(order.taxableAmount) },
    ...(taxMode === 'CGST_SGST'
      ? [
          { label: 'SGST', value: money(order.sgst) },
          { label: 'CGST', value: money(order.cgst) },
        ]
      : []),
    ...(taxMode === 'IGST' ? [{ label: 'IGST', value: money(order.igst) }] : []),
    ...chargeLines,
    // Always a row, at 0.00 when there are none — unless Other Charges is one of the charges above.
    ...(Number(order.otherCharges) > 0
      ? [{ label: 'Other Charges', value: money(order.otherCharges) }]
      : (sheetOrder.charges ?? []).some((c) => chargeName(c) === 'Other Charges')
        ? []
        : [{ label: 'Other Charges', value: money(0) }]),
    ...(Number(order.roundOff) !== 0 ? [{ label: 'Rounding', value: money(order.roundOff) }] : []),
  ]

  const docTitle = order.isService ? 'Service Purchase Order' : template.title

  // Where the goods go: a customer called out, or our own godown.
  const toCustomer = Boolean(sheetOrder.deliveryCustomer)
  const deliverName = sheetOrder.deliveryCustomer
    ? sheetOrder.deliveryCustomer.name
    : sheetOrder.deliveryWarehouse
      ? sheetOrder.deliveryWarehouse.name
      : company.name
  const deliverAddress =
    sheetOrder.deliveryAddress || sheetOrder.deliveryWarehouse?.address || (toCustomer ? null : companyAddress)

  const rows = lines.map((line, i) => {
    const pack = inPack(line)
    const filing = categoryPath(line.item.category)
    const sub = [filing, line.description].filter(Boolean).join(' · ')
    const shade = [line.item.designNo && `D.No ${line.item.designNo}`, line.item.color].filter(Boolean).join(' / ')
    return {
      key: line.id,
      cells: {
        sn: <span style={NUM}>{i + 1}</span>,
        item: (
          <>
            {/* A fabric's own line prints as the fabric; its design and colour have a column. */}
            <div style={{ fontWeight: 700 }}>{line.item.parentItem?.name ?? line.item.name}</div>
            {sub && <SubLine>{sub}</SubLine>}
          </>
        ),
        colour: shade || <Dash />,
        code: <span style={{ ...CODE, fontSize: '8.5px', letterSpacing: 0 }}>{line.item.code}</span>,
        style: line.styleNo || line.style?.code || <Dash />,
        hsn: <span style={NUM}>{line.hsnCode || <Dash />}</span>,
        qty: (
          <>
            <strong>{money(pack.qty)}</strong>
            {pack.pieces && <SubLine>= {pack.pieces}</SubLine>}
          </>
        ),
        uom: pack.unit || <Dash />,
        rate: `₹${money(line.unitRate)}`,
        disc: pct(line.discount),
        gst: pct(line.gstRate),
        amount: <strong>₹{money(line.amount)}</strong>,
      },
    }
  })

  return (
    <DocumentSheet
      company={company}
      title={docTitle}
      number={order.poNumber}
      hideNumber
      backHref="/purchase/orders"
      backLabel="Back to orders"
      copies={template.copies.length || 1}
      fileName={order.poNumber}
      footerNote={template.footerNote}
    >
      {preview && (
        <Banner>
          Layout preview —{' '}
          {[
            sampleLines ? `${sampleCount} sample lines` : null,
            'a sample enquiry number',
            sampleCharges ? 'sample charges' : null,
            sampleCustomer ? 'a sample delivery customer' : null,
          ]
            .filter(Boolean)
            .join(', ')}
          . Not this order. Do not send.
        </Banner>
      )}

      {/* "To," the supplier, with the order's own facts beside it. */}
      <PartyBlock
        name={supplier.name}
        meta={[
          ['P.O No', order.poNumber, true],
          ['P.O Date', shortDate(order.poDate), true],
          !!order.deliveryDate && ['Delivery by', shortDate(order.deliveryDate), true],
          !!sheetOrder.enquiryNo && ['Enquiry No', sheetOrder.enquiryNo, true],
          !!sheetOrder.enquiryDate && ['Enquiry Date', shortDate(sheetOrder.enquiryDate), true],
          !!sheetOrder.reference && ['Your reference', sheetOrder.reference],
          !!order.brand?.name && ['Brand', order.brand.name],
        ]}
      >
        <PartyLine label="Address-" value={supplierAddress || null} />
        <PartyLine label="GST No" value={supplier.gstin} mono />
        <PartyLine label="Contact No" value={supplier.phone} mono />
        <PartyLine label="Kind Attention" value={null} />
        <PartyLine label="Payment Terms" value={paymentTerms} />
      </PartyBlock>

      {(deliverName || deliverAddress) && (
        <Band icon="truck" label="Deliver to" strong={toCustomer}>
          <div style={{ fontSize: '11px', fontWeight: 800, textTransform: 'uppercase' }}>
            {deliverName}
            {sheetOrder.deliveryCustomer?.code && (
              <span style={{ fontWeight: 600, marginLeft: '6px', ...CODE }}>{sheetOrder.deliveryCustomer.code}</span>
            )}
          </div>
          {deliverAddress && <div style={{ marginTop: '1px' }}>{deliverAddress}</div>}
          {toCustomer && (
            <div style={{ fontSize: '8.5px', fontWeight: 700, letterSpacing: '.08em', textTransform: 'uppercase', marginTop: '2px' }}>
              Ship direct to this address — not to our works
            </div>
          )}
        </Band>
      )}

      <DocTable columns={COLUMNS} rows={rows} />

      <WordsAndTotals
        words={template.showAmountInWords ? data.totalInWords : null}
        left={
          <>
            <Note title="Special notes">{order.notes || <Dash />}</Note>
            {taxMode === 'NONE' && <div style={{ fontSize: '9.5px' }}>Supplier is not registered under GST, so this order carries no tax.</div>}
          </>
        }
        totals={<TotalsBox rows={totalRows} total={`₹ ${money(order.totalAmount)}`} />}
      />

      <TaxByRate rows={gstSummary} split={taxMode} />

      <Terms text={order.terms || template.termsText} />

      {template.declaration && <div style={{ fontSize: '9.5px', marginTop: '7px' }}>{template.declaration}</div>}

      {template.showSignature && (
        <Signatures company={company.name} roles={['Authorized Signature', 'Director']} signatureUrl={company.signatureUrl} />
      )}
    </DocumentSheet>
  )
}
