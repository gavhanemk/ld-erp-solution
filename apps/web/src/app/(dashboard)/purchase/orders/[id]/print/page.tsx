'use client'

import { useCallback, useEffect, useState } from 'react'
import { useParams } from 'next/navigation'
import { Printer, ArrowLeft, AlertCircle } from 'lucide-react'
import Link from 'next/link'
import { api, ApiError } from '@/lib/api'
import { formatDate } from '@/lib/utils'

/**
 * The printed purchase order.
 *
 * Rendered as an ordinary page with a print stylesheet rather than drawn into a
 * PDF in code. An Indian commercial document is a grid of bordered boxes, which
 * is exactly what HTML tables are for — and it means changing the wording later
 * is an edit here, not a re-plot of coordinates.
 *
 * The page paints its own black-on-white regardless of the app's theme. Without
 * that, printing while the ERP is in dark mode produces a black sheet.
 */

interface PrintPayload {
  company: Record<string, string | null>
  template: {
    title: string
    termsText: string | null
    declaration: string | null
    footerNote: string | null
    showHsn: boolean
    showAmountInWords: boolean
    showBankDetails: boolean
    showSignature: boolean
    copies: string[]
  }
  order: {
    poNumber: string
    poDate: string
    deliveryDate: string | null
    notes: string | null
    terms: string | null
    subtotal: string
    discountAmount: string
    taxableAmount: string
    cgst: string
    sgst: string
    igst: string
    roundOff: string
    totalAmount: string
    supplier: Record<string, string | null>
    deliveryWarehouse: { name: string; address: string | null } | null
    createdBy: { name: string } | null
    lines: Array<{
      id: string
      description: string | null
      hsnCode: string | null
      qty: string
      unitRate: string
      discount: string
      gstRate: string
      amount: string
      item: { code: string; name: string; uom?: { symbol: string } | null }
    }>
  }
  totalInWords: string
  taxMode: 'IGST' | 'CGST_SGST' | 'NONE'
}

const money = (v: string | number) =>
  Number(v).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

export default function PrintPurchaseOrderPage() {
  const { id } = useParams<{ id: string }>()
  const [data, setData] = useState<PrintPayload | null>(null)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      const res = await api.get<{ success: boolean; data: PrintPayload }>(
        `/purchase/orders/${id}/print`,
      )
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
      <div className="flex items-start gap-3 p-4 rounded-lg border border-red-500/40 bg-red-500/5">
        <AlertCircle size={16} className="text-red-400 mt-0.5" />
        <p className="text-sm text-red-400">{error}</p>
      </div>
    )
  }

  if (!data) return <p className="text-sm text-muted-foreground">Loading...</p>

  const { company, template, order, taxMode } = data
  const copies = template.copies.length ? template.copies : ['']
  const terms = order.terms || template.termsText

  return (
    <>
      <style>{`
        .sheet {
          background: #fff;
          color: #000;
          width: 210mm;
          min-height: 297mm;
          margin: 0 auto 12mm;
          padding: 12mm;
          box-sizing: border-box;
          font-family: "Helvetica Neue", Arial, sans-serif;
          font-size: 10.5px;
          line-height: 1.45;
        }
        .sheet table { border-collapse: collapse; width: 100%; }
        .sheet .grid td, .sheet .grid th { border: 0.6px solid #000; padding: 4px 6px; vertical-align: top; }
        .sheet .grid th { background: #f0f0f0; font-weight: 700; font-size: 9.5px; text-transform: uppercase; letter-spacing: .03em; }
        .sheet .num { text-align: right; font-variant-numeric: tabular-nums; }
        .sheet .rule { border-top: 0.6px solid #000; }
        .no-print { }

        @media print {
          .no-print { display: none !important; }
          @page { size: A4; margin: 0; }
          body { background: #fff !important; }
          .sheet { margin: 0; box-shadow: none; page-break-after: always; }
          .sheet:last-child { page-break-after: auto; }
        }
      `}</style>

      <div className="no-print flex items-center justify-between mb-5">
        <Link href="/purchase/orders" className="btn-ghost text-sm">
          <ArrowLeft size={15} /> Back to orders
        </Link>
        <button className="btn-primary" onClick={() => window.print()}>
          <Printer size={15} /> Print
        </button>
      </div>

      <div className="no-print mb-4 text-xs text-muted-foreground text-center">
        Choose &ldquo;Save as PDF&rdquo; in the print box to keep a copy.
        {copies.length > 1 && ` ${copies.length} copies will print, one per page.`}
      </div>

      {copies.map((copyLabel, copyIndex) => (
        <div className="sheet shadow-lg" key={copyIndex}>
          {/* Letterhead */}
          <table>
            <tbody>
              <tr>
                {company.logoUrl && (
                  <td style={{ width: '90px', verticalAlign: 'top', paddingRight: '8px' }}>
                    {/* A data URL: next/image would add nothing and needs configuring. */}
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={company.logoUrl} alt="" style={{ maxWidth: '80px', maxHeight: '60px' }} />
                  </td>
                )}
                <td style={{ verticalAlign: 'top' }}>
                  <div style={{ fontSize: '17px', fontWeight: 800, letterSpacing: '-.01em' }}>
                    {company.legalName || company.name}
                  </div>
                  <div style={{ fontSize: '10px', marginTop: '2px' }}>
                    {[company.address, company.city, company.state, company.pincode]
                      .filter(Boolean)
                      .join(', ')}
                  </div>
                  <div style={{ fontSize: '10px' }}>
                    {[
                      company.gstin && `GSTIN: ${company.gstin}`,
                      company.pan && `PAN: ${company.pan}`,
                    ]
                      .filter(Boolean)
                      .join('   ')}
                  </div>
                  <div style={{ fontSize: '10px' }}>
                    {[company.phone, company.email, company.website].filter(Boolean).join('   ')}
                  </div>
                </td>
                <td style={{ verticalAlign: 'top', textAlign: 'right', width: '150px' }}>
                  {copyLabel && (
                    <div style={{ fontSize: '9px', fontWeight: 700, textTransform: 'uppercase' }}>
                      {copyLabel}
                    </div>
                  )}
                </td>
              </tr>
            </tbody>
          </table>

          <div
            style={{
              textAlign: 'center',
              fontSize: '14px',
              fontWeight: 800,
              letterSpacing: '.08em',
              margin: '10px 0 8px',
              padding: '4px 0',
              borderTop: '1.2px solid #000',
              borderBottom: '1.2px solid #000',
            }}
          >
            {template.title}
          </div>

          {/* Who and when */}
          <table className="grid">
            <tbody>
              <tr>
                <td style={{ width: '55%' }}>
                  <strong style={{ fontSize: '9.5px', textTransform: 'uppercase' }}>Supplier</strong>
                  <div style={{ fontWeight: 700, marginTop: '2px' }}>{order.supplier.name}</div>
                  <div>
                    {[
                      order.supplier.address,
                      order.supplier.city,
                      order.supplier.state,
                      order.supplier.pincode,
                    ]
                      .filter(Boolean)
                      .join(', ')}
                  </div>
                  {order.supplier.gstin && <div>GSTIN: {order.supplier.gstin}</div>}
                  {order.supplier.phone && <div>Phone: {order.supplier.phone}</div>}
                </td>
                <td>
                  <table style={{ width: '100%' }}>
                    <tbody>
                      <Kv label="Order No." value={order.poNumber} strong />
                      <Kv label="Date" value={formatDate(order.poDate)} />
                      <Kv
                        label="Wanted by"
                        value={order.deliveryDate ? formatDate(order.deliveryDate) : '—'}
                      />
                      <Kv
                        label="Deliver to"
                        value={order.deliveryWarehouse?.name || company.city || '—'}
                      />
                    </tbody>
                  </table>
                </td>
              </tr>
            </tbody>
          </table>

          {/* Lines */}
          <table className="grid" style={{ marginTop: '-0.6px' }}>
            <thead>
              <tr>
                <th style={{ width: '26px' }}>#</th>
                <th>Description</th>
                {template.showHsn && <th style={{ width: '58px' }}>HSN</th>}
                <th className="num" style={{ width: '58px' }}>Qty</th>
                <th style={{ width: '34px' }}>Unit</th>
                <th className="num" style={{ width: '62px' }}>Rate</th>
                {taxMode !== 'NONE' && <th className="num" style={{ width: '44px' }}>GST %</th>}
                <th className="num" style={{ width: '76px' }}>Amount</th>
              </tr>
            </thead>
            <tbody>
              {order.lines.map((line, i) => (
                <tr key={line.id}>
                  <td className="num">{i + 1}</td>
                  <td>
                    <div style={{ fontWeight: 600 }}>{line.item.name}</div>
                    <div style={{ fontSize: '9px' }}>
                      {line.item.code}
                      {line.description ? ` — ${line.description}` : ''}
                    </div>
                  </td>
                  {template.showHsn && <td>{line.hsnCode || '—'}</td>}
                  <td className="num">{money(line.qty)}</td>
                  <td>{line.item.uom?.symbol || ''}</td>
                  <td className="num">{money(line.unitRate)}</td>
                  {taxMode !== 'NONE' && <td className="num">{Number(line.gstRate)}</td>}
                  <td className="num">{money(line.amount)}</td>
                </tr>
              ))}
              {/* Keeps a short order from looking like a stub of a page. */}
              {order.lines.length < 8 &&
                Array.from({ length: 8 - order.lines.length }).map((_, i) => (
                  <tr key={`pad-${i}`}>
                    <td>&nbsp;</td>
                    <td />
                    {template.showHsn && <td />}
                    <td />
                    <td />
                    <td />
                    {taxMode !== 'NONE' && <td />}
                    <td />
                  </tr>
                ))}
            </tbody>
          </table>

          {/* Totals */}
          <table style={{ marginTop: '6px' }}>
            <tbody>
              <tr>
                <td style={{ width: '58%', verticalAlign: 'top', paddingRight: '8px' }}>
                  {template.showAmountInWords && (
                    <div style={{ border: '0.6px solid #000', padding: '5px 6px', marginBottom: '6px' }}>
                      <strong style={{ fontSize: '9px', textTransform: 'uppercase' }}>
                        Amount in words
                      </strong>
                      <div style={{ fontWeight: 600 }}>{data.totalInWords}</div>
                    </div>
                  )}

                  {terms && (
                    <div style={{ border: '0.6px solid #000', padding: '5px 6px', marginBottom: '6px' }}>
                      <strong style={{ fontSize: '9px', textTransform: 'uppercase' }}>
                        Terms &amp; Conditions
                      </strong>
                      <ol style={{ margin: '3px 0 0 14px', padding: 0, fontSize: '9.5px' }}>
                        {terms
                          .split('\n')
                          .map((t) => t.trim())
                          .filter(Boolean)
                          .map((t, i) => (
                            <li key={i}>{t}</li>
                          ))}
                      </ol>
                    </div>
                  )}

                  {order.notes && (
                    <div style={{ fontSize: '9.5px' }}>
                      <strong>Note:</strong> {order.notes}
                    </div>
                  )}
                </td>

                <td style={{ verticalAlign: 'top' }}>
                  <table className="grid">
                    <tbody>
                      <Total label="Subtotal" value={order.subtotal} />
                      {Number(order.discountAmount) > 0 && (
                        <Total label="Discount" value={`-${money(order.discountAmount)}`} raw />
                      )}
                      <Total label="Taxable value" value={order.taxableAmount} />
                      {taxMode === 'CGST_SGST' && (
                        <>
                          <Total label="CGST" value={order.cgst} />
                          <Total label="SGST" value={order.sgst} />
                        </>
                      )}
                      {taxMode === 'IGST' && <Total label="IGST" value={order.igst} />}
                      {Number(order.roundOff) !== 0 && (
                        <Total label="Rounding" value={order.roundOff} />
                      )}
                      <tr>
                        <td style={{ fontWeight: 800 }}>TOTAL</td>
                        <td className="num" style={{ fontWeight: 800, fontSize: '12px' }}>
                          ₹{money(order.totalAmount)}
                        </td>
                      </tr>
                    </tbody>
                  </table>

                  {taxMode === 'NONE' && (
                    <div style={{ fontSize: '9px', marginTop: '4px' }}>
                      Supplier is not registered under GST.
                    </div>
                  )}
                </td>
              </tr>
            </tbody>
          </table>

          {/* Foot */}
          <table style={{ marginTop: '10px' }}>
            <tbody>
              <tr>
                <td style={{ verticalAlign: 'bottom', fontSize: '9px', width: '60%' }}>
                  {template.declaration && <div style={{ marginBottom: '6px' }}>{template.declaration}</div>}
                  {order.createdBy && <div>Raised by: {order.createdBy.name}</div>}
                </td>
                <td style={{ textAlign: 'center', verticalAlign: 'bottom' }}>
                  {template.showSignature && (
                    <>
                      <div style={{ fontSize: '9.5px' }}>For {company.legalName || company.name}</div>
                      {company.signatureUrl ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img
                          src={company.signatureUrl}
                          alt=""
                          style={{ maxHeight: '38px', margin: '4px auto' }}
                        />
                      ) : (
                        <div style={{ height: '38px' }} />
                      )}
                      <div className="rule" style={{ paddingTop: '3px', fontSize: '9px' }}>
                        Authorised Signatory
                      </div>
                    </>
                  )}
                </td>
              </tr>
            </tbody>
          </table>

          {template.footerNote && (
            <div style={{ textAlign: 'center', fontSize: '8.5px', marginTop: '8px' }}>
              {template.footerNote}
            </div>
          )}
        </div>
      ))}
    </>
  )
}

function Kv({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <tr>
      <td style={{ border: 0, padding: '1px 0', fontSize: '9.5px' }}>{label}</td>
      <td style={{ border: 0, padding: '1px 0', textAlign: 'right', fontWeight: strong ? 700 : 400 }}>
        {value}
      </td>
    </tr>
  )
}

function Total({ label, value, raw }: { label: string; value: string | number; raw?: boolean }) {
  return (
    <tr>
      <td>{label}</td>
      <td className="num">{raw ? String(value) : money(value)}</td>
    </tr>
  )
}
