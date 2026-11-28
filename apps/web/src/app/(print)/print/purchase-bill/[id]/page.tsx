'use client'

import { inPack } from '@/lib/packs'
import { itemShade, type ShadeFields } from '@/lib/items'
import { chargeSnapshot } from '@ld-erp/shared'

import { Fragment, useEffect, useState } from 'react'
import { useParams } from 'next/navigation'
import { api, ApiError } from '@/lib/api'
import type { TaxByRate } from '@ld-erp/shared'
import {
  Band,
  CODE,
  Dash,
  DocTable,
  DocumentSheet,
  Eyebrow,
  HAIR,
  LINE,
  NUM,
  Note,
  PartyBlock,
  PartyLine,
  Signatures,
  SubLine,
  Terms,
  TotalsBox,
  WordsAndTotals,
  money,
  pct,
  qty,
  shortDate,
  type DocColumn,
  type DocRow,
} from '@/components/print/doc'

/**
 * The printed purchase bill — our record of a supplier's invoice. On the
 * document kit (components/print/doc) since 27 Nov 2026: black on white, only
 * the company logo in colour, and the browser's own pages, so a bill of any
 * length prints whole with the table heading on every page.
 *
 * **The parties are the right way round.** The 21 Sep mock put LD Cotton Mills
 * under "Bill From" and the supplier under "Bill To". On a purchase bill that
 * is backwards: this is the supplier's demand for money, so it comes *from*
 * them and is addressed *to* us. Printed the other way it would read as a bill
 * we had issued, which is a different document with a different tax position.
 * The mill's own old sheet has it right — its Bill From block holds SABLE
 * TRADING.
 */

interface BillLine {
  id: string
  description: string | null
  hsnCode: string | null
  qty: string
  unitPrice: string
  /** A percentage off the line, not rupees. */
  discount: string
  gstRate: string
  taxableValue: string
  cgst: string
  sgst: string
  igst: string
  amount: string
  /** A fabric's design and colour (a thread's colour) come with it, from Masters → Items. */
  item: {
    code: string
    name: string
    uom?: { symbol: string } | null
  } & ShadeFields
  /** The pack it was billed in (a box of 20 pcs); qty is in the item's own unit. */
  uomFactor?: string | number
  uom?: { symbol: string } | null
  grnLine?: { grn: { grnNumber: string } } | null
}

interface PrintData {
  company: Record<string, string | null>
  template: {
    title: string
    termsText: string | null
    declaration: string | null
    footerNote: string | null
    showHsn: boolean
    showAmountInWords: boolean
    showSignature: boolean
  }
  bill: {
    billNumber: string
    /** CANCELLED prints across the sheet; a cancelled bill is not payable. */
    status?: string
    supplierInvoiceNo: string | null
    supplierInvoiceDate: string | null
    billDate: string
    dueDate: string | null
    notes: string | null
    subtotal: string
    discountAmount: string
    taxableAmount: string
    cgst: string
    sgst: string
    igst: string
    tdsSection: string | null
    tdsAmount: string
    isReverseCharge: boolean
    roundOff: string
    totalAmount: string
    balanceAmount: string
    supplier: Record<string, string | null>
    po: { poNumber: string } | null
    createdBy: { name: string } | null
    lines: BillLine[]
    charges: Array<{
      taxSnapshot?: unknown
      id: string
      amount: string
      gstRate: string
      cgst: string
      sgst: string
      igst: string
      chargeType: { name: string }
    }>
  }
  totalInWords: string
  taxMode: 'IGST' | 'CGST_SGST' | 'NONE'
  /**
   * The bill's GST rate by rate, goods and charges together, built by the
   * server from the stored lines and charges. Missing from an older API, and
   * then the sheet works the charges' share out for itself.
   */
  taxByRate?: TaxByRate[] | null
}

/** An address on one line, skipping whatever is not on file. */
function addressOf(p: Record<string, string | null>): string {
  const cityLine = [p.city, p.state].filter(Boolean).join(', ')
  const pinLine = [cityLine, p.pincode].filter(Boolean).join(' - ')
  return [p.address, pinLine, p.country || 'INDIA'].filter((l): l is string => Boolean(l && l.trim())).join(', ')
}

/*
 * Every column the old sheet had, plus the line's GST rate — the Amount
 * column includes the line's tax, so without the rate qty × rate never
 * matches it. Shares sized for an eight-digit HSN, a quantity like 13,500
 * with its pack line, and an amount like 13,48,751.25.
 */
const COLUMNS: DocColumn[] = [
  { key: 'sn', head: '#', weight: 4.5, align: 'center' },
  { key: 'item', head: 'Item & Description', weight: 31 },
  { key: 'hsn', head: 'HSN/SAC', weight: 10, align: 'center' },
  { key: 'qty', head: 'Qty', weight: 11, align: 'right' },
  { key: 'uom', head: 'Unit', weight: 6.5, align: 'center' },
  { key: 'rate', head: 'Rate (₹)', weight: 11, align: 'right' },
  { key: 'disc', head: 'Disc', weight: 6.5, align: 'right' },
  { key: 'gst', head: 'GST', weight: 6, align: 'right' },
  { key: 'amount', head: 'Amount (₹)', weight: 13.5, align: 'right' },
]

export default function PurchaseBillPrintPage() {
  const params = useParams<{ id: string }>()
  const [data, setData] = useState<PrintData | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    api
      .get<{ data: PrintData }>(`/purchase/bills/${params.id}/print`)
      .then((r) => setData(r.data))
      .catch((e) => setError(e instanceof ApiError ? e.message : 'Could not load this bill.'))
  }, [params.id])

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

  const { company, template, bill, taxMode, taxByRate } = data
  const companyName = company.legalName || company.name || ''
  const chargeName = (c: PrintData['bill']['charges'][number]) => chargeSnapshot(c.taxSnapshot)?.name ?? c.chargeType.name

  const receipts = [...new Set(bill.lines.map((l) => l.grnLine?.grn.grnNumber).filter(Boolean))] as string[]

  /*
   * The HSN-wise summary, grouped by code and rate together.
   *
   * One code can legitimately carry two rates on one bill, and merging them
   * would print a rate that applies to neither half. Amounts are summed from
   * the lines rather than recalculated, so this block and the totals above it
   * cannot disagree.
   *
   * Charges are the supplier's figure with any GST already inside it and
   * carry no GST of their own, so they are not in this table. Only a bill
   * saved while charges still had GST put on top lists them, after the goods,
   * one row per rate — their tax is inside the totals, and the table has to
   * add up to it.
   */
  type SummaryRow = {
    hsn: string
    rate: number
    taxable: number
    cgst: number
    sgst: number
    igst: number
  }
  const hsnRows = ((): SummaryRow[] => {
    if (taxMode === 'NONE') return []
    const groups = new Map<string, SummaryRow>()
    for (const l of bill.lines) {
      const hsn = l.hsnCode || '—'
      const rate = Number(l.gstRate)
      const key = `${hsn}|${rate}`
      const g = groups.get(key) ?? { hsn, rate, taxable: 0, cgst: 0, sgst: 0, igst: 0 }
      g.taxable += Number(l.taxableValue)
      g.cgst += Number(l.cgst)
      g.sgst += Number(l.sgst)
      g.igst += Number(l.igst)
      groups.set(key, g)
    }
    const goods = [...groups.values()].sort((a, b) => a.hsn.localeCompare(b.hsn) || a.rate - b.rate)
    return [...goods, ...chargeSummaryRows(goods)]
  })()

  /*
   * The charges' rows, one per GST rate, named after the charges at that rate.
   *
   * When the server sends the bill's tax by rate, the charges' share of it is
   * what is left at each rate once the goods' own tax is taken off — so the
   * summary's total is the server's figure to the paisa. From an older server
   * the sheet adds up the tax each charge row was saved with, the same way the
   * goods' rows are summed from their lines — never worked out again from
   * amount and rate, because an old bill or a different rounding would then
   * print a summary that disagrees with the tax in the totals above it.
   */
  function chargeSummaryRows(goods: SummaryRow[]): SummaryRow[] {
    const live = bill.charges.filter((c) => Number(c.amount) > 0 && Number(c.gstRate) > 0)
    if (!live.length) return []
    const namesAt = (rate: number) =>
      live
        .filter((c) => Number(c.gstRate) === rate)
        .map(chargeName)
        .join(', ') || 'Charges'
    const round2 = (n: number) => Math.round(n * 100) / 100

    if (Array.isArray(taxByRate) && taxByRate.length > 0) {
      return taxByRate
        .filter((r) => Number(r.chargeTaxable) > 0 && Number(r.gstRate) > 0)
        .map((r) => {
          const rate = Number(r.gstRate)
          const goodsAt = goods.filter((g) => g.rate === rate)
          const less = (key: 'cgst' | 'sgst' | 'igst') => round2(Number(r[key]) - goodsAt.reduce((s, g) => s + g[key], 0))
          return {
            hsn: namesAt(rate),
            rate,
            taxable: Number(r.chargeTaxable),
            cgst: less('cgst'),
            sgst: less('sgst'),
            igst: less('igst'),
          }
        })
        .sort((a, b) => a.rate - b.rate)
    }

    const byRate = new Map<number, SummaryRow>()
    for (const c of live) {
      const rate = Number(c.gstRate)
      const amount = Number(c.amount)
      const g = byRate.get(rate) ?? { hsn: namesAt(rate), rate, taxable: 0, cgst: 0, sgst: 0, igst: 0 }
      g.taxable = round2(g.taxable + amount)
      g.cgst = round2(g.cgst + Number(c.cgst))
      g.sgst = round2(g.sgst + Number(c.sgst))
      g.igst = round2(g.igst + Number(c.igst))
      byRate.set(rate, g)
    }
    return [...byRate.values()].sort((a, b) => a.rate - b.rate)
  }

  const hsnTotal = hsnRows.reduce(
    (t, g) => ({
      taxable: t.taxable + g.taxable,
      cgst: t.cgst + g.cgst,
      sgst: t.sgst + g.sgst,
      igst: t.igst + g.igst,
    }),
    { taxable: 0, cgst: 0, sgst: 0, igst: 0 },
  )

  const otherCharges = bill.charges.reduce((s, c) => s + Number(c.amount), 0)

  /* The calculation, in the order the mill checks it. */
  const totals = [
    { label: 'Total Discount', value: money(bill.discountAmount) },
    { label: 'Sub Total', value: money(bill.subtotal) },
    ...(taxMode === 'CGST_SGST'
      ? [
          { label: 'SGST', value: money(bill.sgst) },
          { label: 'CGST', value: money(bill.cgst) },
        ]
      : []),
    ...(taxMode === 'IGST' ? [{ label: 'IGST', value: money(bill.igst) }] : []),
    ...(otherCharges > 0 ? [{ label: 'Other Charges', value: money(otherCharges) }] : []),
    ...(Number(bill.roundOff) !== 0 ? [{ label: 'Round Off', value: money(bill.roundOff) }] : []),
  ]

  /* Goods first, then freight and the like in the same grid, so a clerk
     checking the bill with a calculator adds straight down one column. */
  const rows: DocRow[] = [
    ...bill.lines.map((l, i) => {
      const pack = inPack(l)
      // "Design No: 1164 · Colour: Navy", exactly as typed in the Items master,
      // on its own line under the name as on the goods receipt.
      const shade = itemShade(l.item)
      const sub = `${l.item.code}${l.description ? ` — ${l.description}` : ''}`
      const grn = l.grnLine?.grn.grnNumber
      return {
        key: l.id,
        cells: {
          sn: <span style={NUM}>{i + 1}</span>,
          item: (
            <>
              <div style={{ fontWeight: 700 }}>{l.item.name}</div>
              {shade && <SubLine>{shade}</SubLine>}
              <SubLine>
                {sub}
                {grn && (
                  <>
                    {' · '}
                    <span style={{ whiteSpace: 'nowrap' }}>{grn}</span>
                  </>
                )}
              </SubLine>
            </>
          ),
          hsn: <span style={NUM}>{l.hsnCode || <Dash />}</span>,
          qty: (
            <>
              {qty(pack.qty)}
              {pack.pieces && <SubLine>= {pack.pieces}</SubLine>}
            </>
          ),
          uom: pack.unit || <Dash />,
          rate: money(l.unitPrice),
          disc: pct(l.discount),
          gst: pct(l.gstRate),
          amount: <strong>{money(l.amount)}</strong>,
        },
      }
    }),
    ...bill.charges.map((c, i) => ({
      key: c.id,
      cells: {
        sn: <span style={NUM}>{bill.lines.length + i + 1}</span>,
        item: <div style={{ fontWeight: 700 }}>{chargeName(c)}</div>,
        hsn: <Dash />,
        amount: <strong>{money(c.amount)}</strong>,
      },
    })),
  ]

  const igst = taxMode === 'IGST'
  const summaryColumns: DocColumn[] = [
    { key: 'hsn', head: 'HSN/SAC', weight: 22, align: 'center' },
    { key: 'taxable', head: 'Taxable Value (₹)', weight: 19, align: 'right' },
    ...(igst
      ? [
          { key: 'igstRate', head: 'IGST %', weight: 10, align: 'center' as const },
          { key: 'igst', head: 'IGST Amount (₹)', weight: 19, align: 'right' as const },
        ]
      : [
          { key: 'sgstRate', head: 'SGST %', weight: 9, align: 'center' as const },
          { key: 'sgst', head: 'SGST Amount (₹)', weight: 16.5, align: 'right' as const },
          { key: 'cgstRate', head: 'CGST %', weight: 9, align: 'center' as const },
          { key: 'cgst', head: 'CGST Amount (₹)', weight: 16.5, align: 'right' as const },
        ]),
  ]
  const summaryRows: DocRow[] = [
    ...hsnRows.map((g) => ({
      key: `${g.hsn}-${g.rate}`,
      cells: {
        hsn: <span style={NUM}>{g.hsn}</span>,
        taxable: money(g.taxable),
        igstRate: pct(g.rate),
        igst: money(g.igst),
        sgstRate: pct(g.rate / 2),
        sgst: money(g.sgst),
        cgstRate: pct(g.rate / 2),
        cgst: money(g.cgst),
      },
    })),
    {
      key: 'total',
      total: true,
      cells: {
        hsn: 'Total',
        taxable: money(hsnTotal.taxable),
        igst: money(hsnTotal.igst),
        sgst: money(hsnTotal.sgst),
        cgst: money(hsnTotal.cgst),
      },
    },
  ]

  /* A row under the total, ruled like the rows above it. */
  const afterTotal = (label: React.ReactNode, value: React.ReactNode, strong: boolean, rule: string) => (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: 'minmax(0, 1fr) 8px minmax(92px, auto)',
        alignItems: 'baseline',
        gap: '6px',
        padding: '3.5px 9px',
        fontSize: '10px',
        borderTop: rule,
        fontWeight: strong ? 800 : 400,
      }}
    >
      <span>{label}</span>
      <span>:</span>
      <span style={{ textAlign: 'right', fontWeight: strong ? 800 : 600, fontSize: strong ? '12px' : undefined, ...NUM }}>{value}</span>
    </div>
  )

  return (
    <DocumentSheet
      company={{ ...company, name: companyName }}
      title={template.title || 'Bill'}
      number={bill.billNumber}
      hideNumber
      backHref="/purchase/bills"
      backLabel="Back to bills"
      copies={1}
      fileName={bill.billNumber}
      footerNote={template.footerNote || 'Thank you for your business'}
      banner={bill.status === 'CANCELLED' ? 'Cancelled — this bill is not payable' : null}
    >
      {/* The supplier the bill comes from, with the bill's own facts beside
          it. Labels exactly as the mill writes them. */}
      <PartyBlock
        heading="Bill From,"
        name={bill.supplier.name}
        meta={[
          ['Bill No.', bill.supplierInvoiceNo || bill.billNumber, true],
          ['Bill Date', shortDate(bill.supplierInvoiceDate || bill.billDate), true],
          ['Due Date', shortDate(bill.dueDate), true],
          receipts.length > 0 && [
            'Receipt No.',
            receipts.map((r, i) => (
              <Fragment key={r}>
                {i > 0 && ', '}
                <span style={{ whiteSpace: 'nowrap' }}>{r}</span>
              </Fragment>
            )),
            true,
          ],
          !!bill.po && ['Order No.', bill.po.poNumber, true],
          ['Our Reference', bill.billNumber, true],
        ]}
      >
        <PartyLine label="Address-" value={addressOf(bill.supplier) || null} />
        <PartyLine label="GST No" value={bill.supplier.gstin} mono />
        <PartyLine label="Contact No" value={bill.supplier.phone} mono />
      </PartyBlock>

      <Band label="Bill to">
        <div style={{ fontSize: '11px', fontWeight: 800, textTransform: 'uppercase' }}>{companyName}</div>
        <div style={{ marginTop: '1px' }}>{addressOf(company)}</div>
        {company.gstin && (
          <div style={{ marginTop: '1px' }}>
            <span style={{ fontWeight: 700 }}>GST No</span>
            <span style={{ marginLeft: '6px', ...CODE }}>{company.gstin}</span>
          </div>
        )}
      </Band>

      {/* Ruled blank rows under a short bill: every printed invoice book rules
          its rows down the page, and the ruled space is what says nothing was
          added after this was signed. */}
      <DocTable columns={COLUMNS} rows={rows} minRows={5} />

      <WordsAndTotals
        words={template.showAmountInWords ? data.totalInWords : null}
        left={
          <>
            <Note title="Notes">{bill.notes || <Dash />}</Note>
            {/* A bill where the tax is ours to pay, or where there is none at
                all, has to say so on the paper — a reader cannot infer it
                from a blank. */}
            {(bill.isReverseCharge || taxMode === 'NONE') && (
              <div style={{ fontSize: '9.5px', fontWeight: 700 }}>
                {bill.isReverseCharge
                  ? 'Reverse charge — GST on this bill is payable by the recipient, not by the supplier.'
                  : 'Supplier is not registered under GST. No tax charged on this bill.'}
              </div>
            )}
          </>
        }
        totals={
          <>
            <TotalsBox rows={totals} total={`₹ ${money(bill.totalAmount)}`} />
            {/* TDS is withheld from the supplier rather than paid to them, so
                the bill is settled in full by the smaller payment. It sits
                below the total because it is not part of it. */}
            {Number(bill.tdsAmount) > 0 && (
              <>
                {afterTotal(`Less TDS${bill.tdsSection ? ` ${bill.tdsSection}` : ''}`, money(bill.tdsAmount), false, LINE)}
                {afterTotal('Payable', `₹ ${money(bill.balanceAmount)}`, true, HAIR)}
              </>
            )}
          </>
        }
      />

      {hsnRows.length > 0 && (
        <div style={{ breakInside: 'avoid', marginTop: '9px' }}>
          <Eyebrow>HSN-wise tax summary</Eyebrow>
          <DocTable columns={summaryColumns} rows={summaryRows} style={{ marginTop: '3px' }} />
        </div>
      )}

      <Terms text={template.termsText} />

      {template.declaration && <div style={{ fontSize: '9px', lineHeight: 1.5, marginTop: '7px' }}>{template.declaration}</div>}

      {/* Who booked it on the left; the signature, when the template asks for
          one, at the right as on the mill's sheet. Pushed to the foot of the
          page so a short bill signs at the bottom of the paper. */}
      <div className="doc-push" style={{ display: 'flex', alignItems: 'flex-end', gap: '22px', breakInside: 'avoid' }}>
        <div style={{ flex: 1, minWidth: 0, fontSize: '9.5px', paddingTop: '14px' }}>
          {bill.createdBy?.name && (
            <>
              Booked by <strong>{bill.createdBy.name}</strong>
            </>
          )}
        </div>
        {template.showSignature && (
          <div style={{ width: '40%', flexShrink: 0 }}>
            <Signatures company={companyName} roles={['Authorised Signatory']} signatureUrl={company.signatureUrl} />
          </div>
        )}
      </div>
    </DocumentSheet>
  )
}
