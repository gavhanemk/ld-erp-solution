'use client'

import { useEffect, useState } from 'react'
import { useParams, useSearchParams } from 'next/navigation'
import { api, ApiError } from '@/lib/api'
import { inPack } from '@/lib/packs'
import type { EnquiryLine, EnquiryRecord } from '@/components/purchase/enquiryTypes'
import { SmartSelect } from '@/components/ui/SmartSelect'
import {
  Box,
  BoxRow,
  CODE,
  Dash,
  DocTable,
  DocumentSheet,
  LINE,
  NUM,
  PartyBlock,
  PartyLine,
  Signatures,
  SubLine,
  Terms,
  qty,
  shortDate,
  type DocColumn,
} from '@/components/print/doc'

/**
 * The printed purchase requisition — what the mill sends a supplier.
 *
 * On the document kit (components/print/doc), black on white since 27 Nov
 * 2026; only the company logo keeps its colours. It carries what the group's
 * purchase order sheet carries: the supplier with his address, bill-to and
 * ship-to, the lines by SKU, who prepared it and who to call. No rates: this
 * asks for a price. The supplier answers with a proforma invoice quoting our
 * requisition number, the PI is recorded in the app against the requisition,
 * and the order is raised against it.
 *
 * One sheet. A requisition goes to several suppliers, and the To block names
 * one of them — which one is picked in a bar above the sheet that never
 * prints. Pick a supplier, print, pick the next, print again: the same
 * template, each copy carrying its own supplier's address. `?quote=<id>`
 * opens with that supplier already picked, which is what the printer icon on
 * a supplier's card does.
 *
 * What it never carries is who else was asked or what they said.
 */

/**
 * What his proforma invoice should carry. A PI that comes back with a rate
 * and nothing else cannot be compared with the others: one is ex-works, one
 * delivered, one has buried the freight.
 */
const PI_MUST_SHOW = [
  'Rate per unit, for each item',
  'GST %',
  'Freight and packing, if extra',
  'Delivery time',
  'Payment terms',
  'How long the price holds',
]

/**
 * Who the supplier invoices. The group's office, not the mill — the goods
 * come to the mill (Ship to), the bill goes to Mumbai. Not in the company
 * settings, so it lives here until it has somewhere to be edited.
 */
const BILL_TO = {
  name: 'Linkd',
  lines: [
    'Essgee Option One, 3rd Floor,',
    'Office No. 333-338, Near Tilak Bhavan,',
    'Opp. Indiabulls, Senapati Bapat Marg, Prabhadevi,',
    'Mumbai - 400013',
  ],
}

/*
 * By SKU, as the group's sheets list them. No rate or amount — those come
 * back on his PI. Shares sized for an eight-digit HSN and a quantity like
 * 13,500.000 with its pack line under it.
 */
const COLUMNS: DocColumn[] = [
  { key: 'sn', head: 'S.No', weight: 5, align: 'center' },
  { key: 'sku', head: 'SKU', weight: 15 },
  { key: 'item', head: 'Item Description', weight: 46 },
  { key: 'hsn', head: 'HSN', weight: 10 },
  { key: 'qty', head: 'Qty', weight: 14, align: 'right' },
  { key: 'unit', head: 'Unit', weight: 10, align: 'center' },
]

/** A party's name in a Bill to / Ship to box, set like the To block's. */
const PARTY_NAME: React.CSSProperties = { fontSize: '10.5px', fontWeight: 800, textTransform: 'uppercase', lineHeight: 1.3 }

interface Recipient {
  quoteId: string
  code: string
  name: string
  phone: string | null
  email: string | null
  gstin: string | null
  address: string | null
  city: string | null
  state: string | null
  stateCode: string | null
  pincode: string | null
}

interface PrintData {
  company: Record<string, string | null>
  template: { title: string; footerNote: string | null; showSignature: boolean } | null
  enquiry: EnquiryRecord
  recipients: Recipient[]
  shipTo: { name: string; address: string | null } | null
  preparedBy: { name: string; phone: string | null; email: string | null } | null
}

/** "Coimbatore, Tamil Nadu - 641029". */
const placeOf = (p: { city?: string | null; state?: string | null; pincode?: string | null }) =>
  [[p.city, p.state].filter(Boolean).join(', '), p.pincode].filter(Boolean).join(' - ')

export default function PurchaseRequisitionPrintPage() {
  const params = useParams<{ id: string }>()
  const search = useSearchParams()
  const wantedQuote = search.get('quote')

  const [data, setData] = useState<PrintData | null>(null)
  const [error, setError] = useState<string | null>(null)
  /** Which supplier the To block names. */
  const [picked, setPicked] = useState<string>('')

  useEffect(() => {
    void (async () => {
      try {
        // Every supplier asked, always — the picker offers all of them, and
        // `?quote=` only decides which one it starts on.
        const res = await api.get<{ data: PrintData }>('/purchase/enquiries/' + params.id + '/print')
        setData(res.data)
        const start = res.data.recipients.find((r) => r.quoteId === wantedQuote) ?? res.data.recipients[0]
        setPicked(start?.quoteId ?? '')
      } catch (err) {
        setError(err instanceof ApiError ? err.message : 'Could not build the sheet.')
      }
    })()
  }, [params.id, wantedQuote])

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

  const e = data.enquiry
  const co = data.company
  const to = data.recipients.find((r) => r.quoteId === picked) ?? null
  const prep = data.preparedBy
  const showSignature = data.template?.showSignature !== false

  const companyPlace = placeOf(co)
  const companyTax = co.gstin ? 'GSTIN ' + co.gstin + (co.stateCode ? ' · State code ' + co.stateCode : '') : null
  const supplierAddress = to ? [to.address, placeOf(to)].filter(Boolean).join(', ') : null

  const rows = e.lines.map((l, i) => {
    // Asked in the pack it is bought in: 2 box (= 40 pcs).
    const pack = inPack(l)
    // A fabric's own stock line carries its design and colour, where the item has them.
    const it = l.item as EnquiryLine['item'] & { designNo?: string | null; color?: string | null }
    const shade = [it.designNo && `D.${it.designNo.replace(/^d\.?\s*/i, '')}`, it.color].filter(Boolean).join(' / ')
    return {
      key: l.id,
      cells: {
        sn: <span style={NUM}>{i + 1}</span>,
        sku: <span style={{ ...CODE, fontSize: '8.5px', letterSpacing: 0 }}>{l.item.code}</span>,
        item: (
          <>
            <div style={{ fontWeight: 700 }}>{l.item.name}</div>
            {shade && <SubLine>{shade}</SubLine>}
            {l.description && <SubLine>{l.description}</SubLine>}
          </>
        ),
        hsn: <span style={NUM}>{l.hsnCode || <Dash />}</span>,
        qty: (
          <>
            <strong>{qty(pack.qty)}</strong>
            {pack.pieces && <SubLine>= {pack.pieces}</SubLine>}
          </>
        ),
        unit: pack.unit || <Dash />,
      },
    }
  })

  return (
    <DocumentSheet
      company={co}
      title="Purchase Requisition"
      number={e.enquiryNumber}
      hideNumber
      backHref="/purchase/enquiries"
      backLabel="Enquiries"
      copies={1}
      fileName={'Requisition ' + e.enquiryNumber + (to ? ' ' + to.name : '')}
      options={
        // The only thing that changes between copies, chosen here and never
        // printed. One supplier: nothing to choose, so it just says whose
        // copy this is.
        data.recipients.length > 0 ? (
          <>
            <span style={{ fontWeight: 600 }}>Vendor on this sheet</span>
            {data.recipients.length > 1 ? (
              <SmartSelect
                value={picked}
                onChange={(ev) => setPicked(ev.target.value)}
                aria-label="Supplier this copy is addressed to"
                style={{ minWidth: 240 }}
              >
                {data.recipients.map((r) => (
                  <option key={r.quoteId} value={r.quoteId}>
                    {r.name}
                  </option>
                ))}
              </SmartSelect>
            ) : (
              <strong>{to?.name}</strong>
            )}
            <span style={{ fontSize: '12px' }}>
              {data.recipients.length > 1
                ? `Asked ${data.recipients.length} suppliers — pick one, print, then pick the next. Each copy carries its own supplier's address.`
                : 'The To block carries this supplier’s address.'}
            </span>
          </>
        ) : undefined
      }
    >
      {/* "To," the supplier this copy is for, with the requisition's own facts beside it. */}
      <PartyBlock
        name={to ? to.name : <Dash />}
        meta={[
          ['Requisition No', e.enquiryNumber, true],
          ['Date', shortDate(e.enquiryDate), true],
          ['Required by', shortDate(e.requiredDate), true],
          ['Reference', e.reference || null, true],
        ]}
      >
        {to ? (
          <>
            <PartyLine label="Address-" value={supplierAddress || null} />
            <PartyLine
              label="GST No"
              value={to.gstin ? to.gstin + (to.stateCode ? ' · State code ' + to.stateCode : '') : null}
              mono
            />
            <PartyLine label="Contact No" value={to.phone} mono />
            <PartyLine label="Email" value={to.email} />
          </>
        ) : (
          <div style={{ fontSize: '9.5px', marginTop: '2px' }}>No supplier has been added to this requisition yet.</div>
        )}
      </PartyBlock>

      <BoxRow>
        <Box title="Bill to">
          <div style={PARTY_NAME}>{BILL_TO.name}</div>
          {BILL_TO.lines.map((line) => (
            <div key={line}>{line}</div>
          ))}
        </Box>
        <Box title="Ship to">
          <div style={PARTY_NAME}>{co.legalName || co.name}</div>
          {co.address && <div>{co.address}</div>}
          {companyPlace && <div>{companyPlace}</div>}
          {companyTax && <div style={{ marginTop: '1px', ...CODE }}>{companyTax}</div>}
        </Box>
      </BoxRow>

      <DocTable columns={COLUMNS} rows={rows} />

      {/* What we need back. */}
      <Box title="Please send your proforma invoice (PI)" style={{ marginTop: '7px' }}>
        <div>
          Please send your proforma invoice for the items above, quoting our requisition no.{' '}
          <strong style={CODE}>{e.enquiryNumber}</strong>. Your PI should show:
        </div>
        <ul
          style={{
            margin: '3px 0 0',
            padding: '0 0 0 16px',
            listStyleType: 'disc',
            display: 'grid',
            gridTemplateColumns: 'repeat(3, minmax(0, 1fr))',
            gap: '1px 20px',
          }}
        >
          {PI_MUST_SHOW.map((q) => (
            <li key={q}>{q}</li>
          ))}
        </ul>
      </Box>

      {e.notes && (
        <Box title="Notes" style={{ marginTop: '7px' }}>
          <div style={{ whiteSpace: 'pre-line' }}>{e.notes}</div>
        </Box>
      )}

      <Terms text={e.terms} />

      {/* Who prepared it, who signs, and who to call — kept together at the
          foot of the last page. "Prepared by" prints whether or not the
          template wants a signature; on its own it keeps to half the width. */}
      <div className="doc-push" style={{ breakInside: 'avoid' }}>
        <div style={{ width: showSignature ? '100%' : '50%' }}>
          <Signatures
            company={co.name}
            roles={[
              {
                role: 'Prepared by',
                who: prep?.name ?? null,
                sub: prep ? [prep.phone, prep.email].filter(Boolean).join(' | ') || null : null,
              },
              ...(showSignature ? ['Authorised signatory'] : []),
            ]}
          />
        </div>

        <div
          style={{
            marginTop: '8px',
            border: LINE,
            padding: '5px 9px',
            display: 'grid',
            gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)',
            gap: '18px',
            fontSize: '8.5px',
            lineHeight: 1.45,
          }}
        >
          <span>
            This is a computer generated document and does not require a physical signature. It is a requisition, not
            a purchase order.
          </span>
          <span style={{ overflowWrap: 'anywhere' }}>
            For queries contact: <strong>{prep?.name ?? co.name}</strong>
            {[prep?.phone || co.phone, prep?.email || co.email]
              .filter(Boolean)
              .map((x) => ' | ' + x)
              .join('')}
          </span>
        </div>
      </div>
    </DocumentSheet>
  )
}
