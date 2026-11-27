'use client'

import { ratePer } from '@/lib/packs'
import { useEffect, useState } from 'react'
import { useParams } from 'next/navigation'
import { api, ApiError } from '@/lib/api'
import type { NoteDoc, PurchaseNote } from '@/components/purchase/noteTypes'
import {
  DocTable,
  DocumentSheet,
  NUM,
  Note,
  PartyBlock,
  PartyLine,
  Signatures,
  SubLine,
  TotalsBox,
  WordsAndTotals,
  money,
  pct,
  qty as qtyFmt,
  shortDate,
  type DocColumn,
  type DocRow,
} from '@/components/print/doc'

/**
 * The printed debit note, supplier's credit or debit note, or purchase
 * adjustment — one sheet for all of them, on the document kit
 * (components/print/doc). Black on white since 27 Nov 2026; only the company
 * logo keeps its colours.
 *
 * **The parties swap with the document.** A debit note is ours: it goes *to*
 * the supplier. A supplier's credit note is theirs, so it comes *from* them
 * and is addressed to us. Printing both the same way round would put the
 * mill's name on a document it never issued, which is a different tax
 * position and a different thing to hand somebody.
 */

interface PrintData {
  company: Record<string, string | null>
  template: {
    title: string
    declaration: string | null
    footerNote: string | null
    showSignature: boolean
  }
  note: PurchaseNote
  reasonLabel: string
  totalInWords: string
  taxMode: 'IGST' | 'CGST_SGST' | 'NONE'
}

/* What each kind is called when Settings has no title for it. The server
   falls back to the bare series code ("SDN"), which is not a title. */
const SERIES: Record<NoteDoc, string> = {
  OUR_DEBIT_NOTE: 'DN',
  SUPPLIER_CREDIT_NOTE: 'SCN',
  SUPPLIER_DEBIT_NOTE: 'SDN',
  OTHER: 'PADJ',
}
const PLAIN_TITLE: Record<NoteDoc, string> = {
  OUR_DEBIT_NOTE: 'Debit Note',
  SUPPLIER_CREDIT_NOTE: "Supplier's Credit Note",
  SUPPLIER_DEBIT_NOTE: "Supplier's Debit Note",
  OTHER: 'Purchase Adjustment Note',
}

/** An address written down the page, skipping whatever is not on file. */
function addressLines(p: Record<string, string | null> | null | undefined): string[] {
  if (!p) return []
  const cityLine = [p.city, p.state].filter(Boolean).join(', ')
  const pinLine = [cityLine, p.pincode].filter(Boolean).join(' - ')
  return [p.address, pinLine, p.country || 'INDIA'].filter((l): l is string => Boolean(l && l.trim()))
}

/* Sized to what each holds at 9.5px: an eight-digit HSN, a quantity like
   13,500.000 MTR, an amount like 12,84,650.00. Particulars takes the rest. */
const COLUMNS: DocColumn[] = [
  { key: 'sn', head: '#', weight: 4.5, align: 'center' },
  { key: 'item', head: 'Particulars', weight: 38 },
  { key: 'hsn', head: 'HSN', weight: 9.5, align: 'center' },
  { key: 'qty', head: 'Qty', weight: 13, align: 'right' },
  { key: 'rate', head: 'Rate', weight: 11.5, align: 'right' },
  { key: 'gst', head: 'GST', weight: 7, align: 'center' },
  { key: 'amount', head: 'Amount (₹)', weight: 14.5, align: 'right' },
]

const HSN_COLUMNS: Record<'IGST' | 'CGST_SGST', DocColumn[]> = {
  IGST: [
    { key: 'hsn', head: 'HSN', weight: 20 },
    { key: 'taxable', head: 'Taxable', weight: 22, align: 'right' },
    { key: 'igstRate', head: 'IGST %', weight: 12, align: 'right' },
    { key: 'igst', head: 'IGST', weight: 20, align: 'right' },
    { key: 'tax', head: 'Total Tax', weight: 26, align: 'right' },
  ],
  CGST_SGST: [
    { key: 'hsn', head: 'HSN', weight: 16 },
    { key: 'taxable', head: 'Taxable', weight: 17, align: 'right' },
    { key: 'cgstRate', head: 'CGST %', weight: 9, align: 'right' },
    { key: 'cgst', head: 'CGST', weight: 15, align: 'right' },
    { key: 'sgstRate', head: 'SGST %', weight: 9, align: 'right' },
    { key: 'sgst', head: 'SGST', weight: 15, align: 'right' },
    { key: 'tax', head: 'Total Tax', weight: 19, align: 'right' },
  ],
}

export default function PurchaseNotePrintPage() {
  const params = useParams<{ id: string }>()
  const [data, setData] = useState<PrintData | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    api
      .get<{ data: PrintData }>(`/purchase/notes/${params.id}/print`)
      .then((r) => setData(r.data))
      .catch((e) => setError(e instanceof ApiError ? e.message : 'Could not load this note.'))
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

  const { company, template, note, reasonLabel, taxMode } = data
  // The legal name heads the paper, as it did before the kit.
  const companyName = company.legalName || company.name || ''
  /* Who issued it, read off the column that records exactly that. It used
     to be inferred from the document being a debit note, which put the
     mill in the From box on a supplier's debit note — their document,
     printed as though we had written it. */
  const ours = note.issuedBy === 'OUR_COMPANY'

  const title =
    template.title && template.title !== SERIES[note.docType]
      ? template.title
      : PLAIN_TITLE[note.docType] ?? (ours ? 'Debit Note' : "Supplier's Credit Note")

  const toCredit = note.docType === 'SUPPLIER_CREDIT_NOTE'

  /* The mill is the letterhead, so only the supplier needs a block: who our
     debit note goes to, or whose credit note this is. */
  const supplierParty = note.supplier as unknown as Record<string, string | null>

  /* Its own facts beside the supplier: number and date, then the papers the
     supplier will look it up by, then why. A note a return challan wrote
     names the challan rather than a single receipt, since one challan can
     carry goods from several. The reason sits at the top, not buried at the
     foot: whoever opens this wants to know what is being claimed before
     reading a figure. */
  const meta: Array<[string, React.ReactNode, boolean?] | null | false> = [
    ours && ['Note No.', note.noteNumber, true],
    !ours && ['Their Note No.', note.supplierDocNo || null, true],
    !ours && ['Our Ref.', note.noteNumber, true],
    ['Date', shortDate(ours ? note.noteDate : note.supplierDocDate || note.noteDate), true],
    !!note.bill && [
      'Their invoice',
      <>
        {note.bill.supplierInvoiceNo || note.bill.billNumber}
        <span style={{ fontWeight: 400 }}> · {shortDate(note.bill.billDate)}</span>
      </>,
      true,
    ],
    !!note.po && ['Order', note.po.poNumber, true],
    note.purchaseReturn
      ? ['Return challan', note.purchaseReturn.returnNumber, true]
      : !!note.grn && ['Receipt', note.grn.grnNumber, true],
    [
      'Reason',
      <>
        {reasonLabel}
        {note.reasonNote && (
          <span style={{ display: 'block', fontSize: '9px', fontWeight: 400, lineHeight: 1.45, marginTop: '1px' }}>
            {note.reasonNote}
          </span>
        )}
      </>,
    ],
    !!note.warehouse && ['Goods out of', note.warehouse.name],
    !!note.lrNumber && ['LR No.', note.lrNumber, true],
    !!note.vehicleNo && ['Vehicle', note.vehicleNo, true],
  ]

  /* The HSN-wise summary, grouped by code and rate together — one code can
     legitimately carry two rates, and merging them prints a rate that applies
     to neither half. Summed from the lines, so this and the totals above it
     cannot disagree. */
  const hsnRows = (() => {
    if (taxMode === 'NONE') return []
    const groups = new Map<string, { hsn: string; rate: number; taxable: number; cgst: number; sgst: number; igst: number }>()
    for (const l of note.lines) {
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
    return [...groups.values()].sort((a, b) => a.hsn.localeCompare(b.hsn) || a.rate - b.rate)
  })()

  const hsnTotal = hsnRows.reduce(
    (t, g) => ({
      taxable: t.taxable + g.taxable,
      cgst: t.cgst + g.cgst,
      sgst: t.sgst + g.sgst,
      igst: t.igst + g.igst,
    }),
    { taxable: 0, cgst: 0, sgst: 0, igst: 0 },
  )

  const totals = [
    { label: 'Taxable Value', value: money(note.taxableAmount) },
    ...(taxMode === 'CGST_SGST'
      ? [
          { label: 'CGST', value: money(note.cgst) },
          { label: 'SGST', value: money(note.sgst) },
        ]
      : []),
    ...(taxMode === 'IGST' ? [{ label: 'IGST', value: money(note.igst) }] : []),
    ...(Number(note.otherCharges) !== 0 ? [{ label: 'Other Charges', value: money(note.otherCharges) }] : []),
    ...(Number(note.discountAmount) !== 0 ? [{ label: 'Less Discount', value: money(note.discountAmount) }] : []),
    ...(Number(note.roundOff) !== 0 ? [{ label: 'Round Off', value: money(note.roundOff) }] : []),
  ]

  const rows: DocRow[] = note.lines.map((l, i) => {
    const unit = l.item.uom ? ` ${l.item.uom.symbol}` : ''
    // A fabric's own stock line may carry its design and colour.
    const it = l.item as typeof l.item & { designNo?: string | null; color?: string | null }
    const shade = [it.designNo && `D.${it.designNo.replace(/^d\.?\s*/i, '')}`, it.color].filter(Boolean).join(' / ')
    /* The code, and what the bill said beside what is coming off it — a
       reader should not have to fetch the invoice to check the claim. */
    const sub = [
      l.item.code,
      shade || null,
      l.description,
      l.originalQty != null
        ? `billed ${qtyFmt(l.originalQty)}${unit}${l.originalRate != null ? ` @ ₹${money(l.originalRate)}` : ''}`
        : null,
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
            <div style={{ fontWeight: 700 }}>{l.item.name}</div>
            {sub && <SubLine>{sub}</SubLine>}
            {l.remarks && <SubLine style={{ fontStyle: 'italic' }}>{l.remarks}</SubLine>}
          </>
        ),
        hsn: <span style={NUM}>{l.hsnCode || '—'}</span>,
        qty: (
          <>
            {qtyFmt(l.qty)}
            {unit}
          </>
        ),
        rate: (
          <>
            {money(l.unitPrice)}
            {per && <SubLine>{per}</SubLine>}
          </>
        ),
        gst: <span style={NUM}>{pct(l.gstRate)}</span>,
        amount: <strong>{money(l.taxableValue)}</strong>,
      },
    }
  })

  const hsnSummary: DocRow[] = [
    ...hsnRows.map((g) => ({
      key: `${g.hsn}|${g.rate}`,
      cells: {
        hsn: <span style={NUM}>{g.hsn}</span>,
        taxable: money(g.taxable),
        igstRate: g.rate,
        igst: money(g.igst),
        cgstRate: g.rate / 2,
        cgst: money(g.cgst),
        sgstRate: g.rate / 2,
        sgst: money(g.sgst),
        tax: <strong>{money(g.cgst + g.sgst + g.igst)}</strong>,
      },
    })),
    ...(hsnRows.length > 1
      ? [
          {
            key: 'total',
            total: true,
            cells: {
              hsn: 'Total',
              taxable: money(hsnTotal.taxable),
              igst: money(hsnTotal.igst),
              cgst: money(hsnTotal.cgst),
              sgst: money(hsnTotal.sgst),
              tax: money(hsnTotal.cgst + hsnTotal.sgst + hsnTotal.igst),
            },
          },
        ]
      : []),
  ]

  return (
    <DocumentSheet
      company={{ ...company, name: companyName }}
      title={title}
      number={note.noteNumber}
      hideNumber
      backHref={toCredit ? '/purchase/credit-notes' : '/purchase/debit-notes'}
      backLabel={toCredit ? 'Back to credit notes' : 'Back to debit notes'}
      copies={1}
      fileName={note.noteNumber}
      /* A draft on paper has to say so, or it is read as a claim that has
         been made. Only a posted note has actually adjusted anything. */
      banner={
        note.status !== 'POSTED'
          ? note.status === 'CANCELLED' || note.status === 'REJECTED'
            ? `${note.status.toLowerCase()} — this note claims nothing`
            : 'Draft — not yet posted, for review only'
          : null
      }
    >
      <PartyBlock heading={ours ? 'To,' : 'From,'} name={note.supplier.name} meta={meta}>
        {addressLines(supplierParty).map((l) => (
          <div key={l} style={{ fontSize: '9.5px', lineHeight: 1.55 }}>
            {l}
          </div>
        ))}
        {note.supplier.gstin && <PartyLine label="GSTIN" value={note.supplier.gstin} mono />}
      </PartyBlock>

      {/* Ruled space under a short note, the way an invoice book rules its
          rows — it says nothing was added after signing. */}
      <DocTable columns={COLUMNS} rows={rows} minRows={3} />

      <WordsAndTotals
        words={data.totalInWords}
        left={
          <>
            {note.notes && <Note title="Notes">{note.notes}</Note>}
            {taxMode === 'NONE' && (
              <div style={{ fontSize: '9.5px', fontWeight: 700 }}>Supplier is not registered under GST. No tax on this note.</div>
            )}
          </>
        }
        totals={<TotalsBox rows={totals} total={`₹${money(note.totalAmount)}`} />}
      />

      {taxMode !== 'NONE' && hsnRows.length > 0 && <DocTable columns={HSN_COLUMNS[taxMode]} rows={hsnSummary} />}

      {template.declaration && <div style={{ fontSize: '9.5px', lineHeight: 1.55, marginTop: '7px' }}>{template.declaration}</div>}

      {/* Foot: what we ask, who raised it, and who signs. */}
      <div className="doc-push" style={{ display: 'flex', alignItems: 'flex-end', gap: '16px', paddingTop: '8px', breakInside: 'avoid' }}>
        <div style={{ flex: 1, minWidth: 0, fontSize: '9.5px', lineHeight: 1.55 }}>
          {template.footerNote ||
            (ours ? 'Please credit our account with the amount above.' : 'Recorded against the bill named above.')}
          {note.createdBy?.name && (
            <div style={{ marginTop: '2px', fontSize: '8.5px' }}>
              Raised by {note.createdBy.name}
              {note.approvedBy?.name ? ` · Approved by ${note.approvedBy.name}` : ''}
            </div>
          )}
        </div>
        {template.showSignature && (
          <div style={{ width: '62mm', flexShrink: 0 }}>
            <Signatures company={companyName} roles={['Authorised Signatory']} signatureUrl={company.signatureUrl} />
          </div>
        )}
      </div>
    </DocumentSheet>
  )
}
