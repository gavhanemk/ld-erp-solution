'use client'

import { Printer, ArrowLeft } from 'lucide-react'
import Link from 'next/link'

/**
 * The shared skeleton of a printed document.
 *
 * Every commercial paper this mill sends out is the same shape: letterhead,
 * heading, who it is for, a grid of lines, totals, terms, signature. Only the
 * middle changes. Keeping it in one place means a correction to the letterhead
 * reaches the invoice, the purchase order and both challans at once.
 */

export const money = (v: string | number) =>
  Number(v).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

export interface Column {
  key: string
  label: string
  /**
   * Relative share of the row. Turned into a percentage against the other
   * columns, so the widths always add up to the full width of the sheet
   * whichever columns happen to be shown. Fixed pixel widths left the table
   * about half the width of the page and out of line with everything above
   * and below it.
   */
  weight?: number
  align?: 'left' | 'right' | 'center'
}

export interface Row {
  key: string
  cells: Record<string, React.ReactNode>
}

/**
 * The line grid.
 *
 * Column widths live in a colgroup rather than on the header cells. With widths
 * on the cells, a padding row with empty cells can be measured differently from
 * a row with content, and the header drifts out of line with the body — which
 * is exactly what happened on the first printed order.
 */
export function DocumentTable({
  columns,
  rows,
  minRows = 8,
}: {
  columns: Column[]
  rows: Row[]
  /** Blank rows so a short document does not look like a torn-off stub. */
  minRows?: number
}) {
  const padding = Math.max(0, minRows - rows.length)

  // Percentages against the total weight, so they always add up to the whole
  // width no matter which optional columns are showing.
  const totalWeight = columns.reduce((s, c) => s + (c.weight ?? 10), 0)

  return (
    <table className="grid lines" style={{ width: '100%' }}>
      <colgroup>
        {columns.map((c) => (
          <col key={c.key} style={{ width: `${(((c.weight ?? 10) / totalWeight) * 100).toFixed(3)}%` }} />
        ))}
      </colgroup>
      <thead>
        <tr>
          {columns.map((c) => (
            <th key={c.key} style={{ textAlign: c.align ?? 'left' }}>
              {c.label}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={row.key}>
            {columns.map((c) => (
              <td key={c.key} style={{ textAlign: c.align ?? 'left' }} className={c.align === 'right' ? 'num' : undefined}>
                {row.cells[c.key]}
              </td>
            ))}
          </tr>
        ))}
        {Array.from({ length: padding }).map((_, i) => (
          <tr key={`pad-${i}`}>
            {columns.map((c, j) => (
              <td key={c.key}>{j === 0 ? ' ' : ''}</td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  )
}

export function PrintToolbar({
  backHref,
  backLabel,
  copies,
}: {
  backHref: string
  backLabel: string
  copies: number
}) {
  return (
    <div className="no-print print-toolbar">
      <Link href={backHref} className="tb-btn">
        <ArrowLeft size={15} /> {backLabel}
      </Link>
      <span className="tb-hint">
        Choose &ldquo;Save as PDF&rdquo; in the print box to keep a copy.
        {copies > 1 && ` ${copies} copies print, one per page.`}
      </span>
      <button className="tb-btn tb-primary" onClick={() => window.print()}>
        <Printer size={15} /> Print
      </button>
    </div>
  )
}

interface Meta {
  label: string
  value: string
  strong?: boolean
}

export function PrintSheet({
  company,
  title,
  copyLabel,
  partyHeading,
  party,
  meta,
  children,
  amountInWords,
  terms,
  note,
  totals,
  grandTotal,
  taxNote,
  declaration,
  showSignature,
  showBank,
  preparedBy,
  footerNote,
  afterTotals,
}: {
  company: Record<string, string | null>
  title: string
  copyLabel: string
  partyHeading: string
  party: Record<string, string | null>
  meta: Meta[]
  children: React.ReactNode
  amountInWords: string | null
  terms: string | null
  note: string | null
  totals: { label: string; value: string }[]
  grandTotal: string
  taxNote?: string | null
  declaration: string | null
  showSignature: boolean
  showBank?: boolean
  preparedBy: string | null
  footerNote: string | null
  /**
   * Anything that belongs below the totals and above the signatures — in
   * practice the HSN-wise tax summary, which every supplier's own invoice
   * carries and which the bill has to be checked against line for line.
   */
  afterTotals?: React.ReactNode
}) {
  const companyName = company.legalName || company.name || ''

  return (
    <>
      <style>{PRINT_CSS}</style>

      <div className="sheet">
        <div className="letterhead">
          {company.logoUrl && (
            // A data URL, so next/image would add nothing and needs configuring.
            // eslint-disable-next-line @next/next/no-img-element
            <img src={company.logoUrl} alt="" className="logo" />
          )}
          <div className="lh-text">
            <div className="lh-name">{companyName}</div>
            <div>
              {[company.address, company.city, company.state, company.pincode]
                .filter(Boolean)
                .join(', ')}
            </div>
            <div>
              {[company.gstin && `GSTIN: ${company.gstin}`, company.pan && `PAN: ${company.pan}`]
                .filter(Boolean)
                .join(' ')}
            </div>
            <div>{[company.phone, company.email, company.website].filter(Boolean).join(' ')}</div>
          </div>
          {copyLabel && <div className="copy-label">{copyLabel}</div>}
        </div>

        <div className="doc-title">{title}</div>

        <table className="grid" style={{ width: '100%' }}>
          <colgroup>
            <col style={{ width: '58%' }} />
            <col style={{ width: '42%' }} />
          </colgroup>
          <tbody>
            <tr>
              <td>
                <div className="box-heading">{partyHeading}</div>
                <div className="party-name">{party.name}</div>
                <div>
                  {[party.address, party.city, party.state, party.pincode].filter(Boolean).join(', ')}
                </div>
                {party.gstin && <div>GSTIN: {party.gstin}</div>}
                {party.phone && <div>Phone: {party.phone}</div>}
              </td>
              <td>
                <table className="meta" style={{ width: '100%' }}>
                  <tbody>
                    {meta.map((m) => (
                      <tr key={m.label}>
                        <td>{m.label}</td>
                        <td style={{ textAlign: 'right', fontWeight: m.strong ? 700 : 400 }}>
                          {m.value}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </td>
            </tr>
          </tbody>
        </table>

        {children}

        <table className="foot" style={{ width: '100%' }}>
          <colgroup>
            <col style={{ width: '58%' }} />
            <col />
          </colgroup>
          <tbody>
            <tr>
              <td className="foot-left">
                {amountInWords && (
                  <div className="boxed">
                    <div className="box-heading">Amount in words</div>
                    <div style={{ fontWeight: 600 }}>{amountInWords}</div>
                  </div>
                )}

                {showBank && company.bankName && (
                  <div className="boxed">
                    <div className="box-heading">Bank details</div>
                    <div>
                      {company.bankName}
                      {company.bankBranch ? `, ${company.bankBranch}` : ''}
                    </div>
                    {company.bankAccount && <div>A/c: {company.bankAccount}</div>}
                    {company.bankIFSC && <div>IFSC: {company.bankIFSC}</div>}
                    {company.upiId && <div>UPI: {company.upiId}</div>}
                  </div>
                )}

                {terms && (
                  <div className="boxed">
                    <div className="box-heading">Terms &amp; Conditions</div>
                    <ol className="terms">
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

                {note && (
                  <div className="note">
                    <strong>Note:</strong> {note}
                  </div>
                )}
              </td>

              <td className="foot-right">
                <table className="grid totals" style={{ width: '100%' }}>
                  <tbody>
                    {totals.map((t) => (
                      <tr key={t.label}>
                        <td>{t.label}</td>
                        <td className="num">{t.value}</td>
                      </tr>
                    ))}
                    <tr className="grand">
                      <td>TOTAL</td>
                      <td className="num">₹{grandTotal}</td>
                    </tr>
                  </tbody>
                </table>
                {taxNote && <div className="tax-note">{taxNote}</div>}
              </td>
            </tr>
          </tbody>
        </table>

        {afterTotals}

        {/* 58% matches the supplier box and the totals block, so the three
            splits down the sheet fall on the same line. */}
        <table className="signblock" style={{ width: '100%' }}>
          <colgroup>
            <col style={{ width: '58%' }} />
            <col />
          </colgroup>
          <tbody>
            <tr>
              <td>
                {declaration && <div className="declaration">{declaration}</div>}
                {preparedBy && <div>Raised by: {preparedBy}</div>}
              </td>
              <td className="sign">
                {showSignature && (
                  <>
                    <div>For {companyName}</div>
                    {company.signatureUrl ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={company.signatureUrl} alt="" className="sig" />
                    ) : (
                      <div className="sig-space" />
                    )}
                    <div className="sig-line">Authorised Signatory</div>
                  </>
                )}
              </td>
            </tr>
          </tbody>
        </table>

        {footerNote && <div className="footer-note">{footerNote}</div>}
      </div>
    </>
  )
}

const PRINT_CSS = `
.print-toolbar {
  width: 210mm; margin: 0 auto 14px; display: flex; align-items: center; gap: 12px;
  font-family: "Helvetica Neue", Arial, sans-serif;
}
.tb-hint { flex: 1; text-align: center; font-size: 12px; color: #e6e6e8; }
.tb-btn {
  display: inline-flex; align-items: center; gap: 6px; padding: 8px 14px; border-radius: 6px;
  background: #fff; color: #17191e; border: 0; font-size: 13px; font-weight: 600;
  cursor: pointer; text-decoration: none;
}
.tb-primary { background: #14b8a6; color: #04231f; }

.sheet {
  background: #fff; color: #000; width: 210mm; min-height: 297mm;
  margin: 0 auto 14px; padding: 12mm; box-sizing: border-box;
  font-family: "Helvetica Neue", Arial, sans-serif; font-size: 10.5px; line-height: 1.45;
  box-shadow: 0 2px 18px rgba(0,0,0,.35);
}
/* The outer boxes — supplier, totals, signature — keep automatic layout. They
   hold a one-word supplier or a four-line address, and letting the browser
   measure them is what produced a sane sheet in the first place. */
.sheet table { border-collapse: collapse; width: 100%; }

.sheet .grid > thead > tr > th,
.sheet .grid > tbody > tr > td { border: 0.6px solid #000; padding: 4px 6px; vertical-align: top; }
.sheet .grid > thead > tr > th {
  background: #eee; font-weight: 700; font-size: 9px; text-transform: uppercase; letter-spacing: .03em;
}
/* Figures never wrap; a total split across two lines is unreadable. */
.sheet .num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
.sheet .grid > thead > tr > th { white-space: nowrap; }

/* ── the line grid ──────────────────────────────────────────────
   The one table whose proportions are decided by us rather than by whatever
   happens to be in it.

   Under automatic layout a colgroup width is only a suggestion, and the
   browser drops it the moment content wants more room — so the percentages
   worked out in DocumentTable had no effect at all, and a long item name
   simply took the width and squeezed every other column. Fixed layout makes
   those percentages binding, which is the entire point of computing them.

   Safe here in a way it was not on the supplier box: under fixed layout a
   column's width no longer depends on how narrow its content can be squeezed,
   which is what once collapsed a supplier name to a single letter.

   These rules must stay AFTER the .grid rules above. They carry the same
   weight as those rules, so they win on order alone — placed earlier, as they
   first were, the nowrap heading rule beat them and the headings spilled
   across their own borders. */
.sheet .lines { table-layout: fixed; }
.sheet .lines > tbody > tr > td { overflow-wrap: break-word; }
/* A heading that cannot wrap spills into the next column rather than widening
   its own, so headings here wrap like any other text. */
.sheet .lines > thead > tr > th { white-space: normal; }

.letterhead { display: flex; align-items: flex-start; gap: 10px; }
.letterhead .logo { max-width: 80px; max-height: 58px; object-fit: contain; }
.lh-text { flex: 1; }
.lh-name { font-size: 17px; font-weight: 800; letter-spacing: -.01em; }
.lh-text div { font-size: 10px; }
.copy-label { font-size: 9px; font-weight: 700; text-transform: uppercase; text-align: right; width: 130px; }

.doc-title {
  text-align: center; font-size: 14px; font-weight: 800; letter-spacing: .08em;
  margin: 9px 0 7px; padding: 4px 0; border-top: 1.2px solid #000; border-bottom: 1.2px solid #000;
}

.box-heading { font-size: 9px; font-weight: 700; text-transform: uppercase; }
.party-name { font-weight: 700; margin-top: 2px; }
.meta { width: 100%; }
.meta td { border: 0 !important; padding: 1px 0 !important; font-size: 9.5px; }

.lines { margin-top: -0.6px; }

.foot { margin-top: 7px; }
.foot > tbody > tr > td { vertical-align: top; border: 0; }
.foot-left { padding-right: 8px; }
.boxed { border: 0.6px solid #000; padding: 5px 6px; margin-bottom: 6px; }
.terms { margin: 3px 0 0 14px; padding: 0; font-size: 9.5px; }
.note { font-size: 9.5px; }
.totals .grand td { font-weight: 800; }
.totals .grand td.num { font-size: 12px; }

/* The HSN-wise tax summary. Full width rather than tucked beside the totals:
   it is a table in its own right and a clerk reads down its columns. */
.hsn { margin-top: 6px; }
.hsn th { text-align: center; font-size: 9px; }
.hsn th.num, .hsn td.num { text-align: right; }
.hsn td { font-size: 9.5px; }
.hsn .grand td { font-weight: 800; }
.tax-note { font-size: 9px; margin-top: 4px; }

.signblock { margin-top: 10px; }
.signblock td { border: 0; vertical-align: bottom; font-size: 9px; }
.declaration { margin-bottom: 6px; }
.sign { text-align: center; }
.sign > div:first-child { font-size: 9.5px; }
.sig { max-height: 38px; margin: 4px auto; display: block; }
.sig-space { height: 38px; }
.sig-line { border-top: 0.6px solid #000; padding-top: 3px; font-size: 9px; }
.footer-note { text-align: center; font-size: 8.5px; margin-top: 8px; }

@media print {
  .no-print { display: none !important; }
  @page { size: A4; margin: 0; }
  html, body { background: #fff !important; }
  .sheet {
    margin: 0; box-shadow: none; page-break-after: always;
  }
  .sheet:last-of-type { page-break-after: auto; }
  /* Grey table headings must actually print, not be dropped as a background. */
  .sheet .grid > thead > tr > th { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
}
`
