'use client'

import { Suspense, useEffect, useMemo, useRef, useState } from 'react'
import { useParams, useSearchParams } from 'next/navigation'
import { api, ApiError } from '@/lib/api'
import { PrintToolbar, printAs } from '@/components/print/PrintSheet'
import { HEAVY, SANS } from '@/components/print/doc'
import { RegisterSheet, paperFor, stampOf, type RegisterData } from '@/components/reports/RegisterSheet'

/**
 * A report, printed — and saved as the PDF.
 *
 * The same sheet the report screen shows, laid on an A4: landscape for a
 * report too wide for a portrait page, which is most of them. The browser
 * saves a PDF by printing to one, so the PDF is this page and nothing else:
 * there is no second, slightly different document to keep in step with it.
 *
 * Opened with `print=1` — which is what Export → PDF does — the print box
 * comes up by itself once the register has loaded.
 *
 * Black on white since 27 Nov 2026, like every document the mill prints: the
 * letterhead is the document kit's — logo, name in capitals, address — and
 * only the logo keeps its colours. The register under it is the report
 * screen's own, so its colours are set to black here, for the paper only.
 */

/** A string as CSS will read it inside quotes. */
const cssText = (s: string) => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, ' ')}"`

const dmy = (iso: string) => {
  const [y, m, d] = iso.split('-')
  return d && m && y ? `${d}-${m}-${y}` : iso
}

/** What the saved PDF is called: "Purchase Register 01-04-2026 to 31-03-2027". */
function fileNameFor(title: string, from?: string | null, to?: string | null): string {
  if (from && to) return `${title} ${dmy(from)} to ${dmy(to)}`
  if (from) return `${title} from ${dmy(from)}`
  if (to) return `${title} to ${dmy(to)}`
  return title
}

/**
 * The letterhead, as the document kit sets it: the logo, the name in
 * capitals, the address lines under it, a heavy rule. The lines are the
 * server's — address, HO, GSTIN and phone — so they read as the workbook's do.
 */
function Letterhead({ name, lines, logoUrl }: { name: string; lines: string[]; logoUrl: string | null }) {
  if (!name && !lines.length && !logoUrl) return null
  return (
    <div style={{ marginBottom: '6px' }}>
      <div style={{ display: 'flex', gap: '14px', alignItems: 'flex-start' }}>
        {logoUrl && (
          // The one thing on the sheet in colour: the mark as uploaded. A data URL, so next/image would add nothing.
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={logoUrl}
            alt=""
            style={{ height: '50px', width: 'auto', maxWidth: '120px', objectFit: 'contain', flexShrink: 0 }}
          />
        )}
        <div style={{ flex: 1, minWidth: 0 }}>
          {name && (
            <div style={{ fontSize: '22px', fontWeight: 800, letterSpacing: '-.01em', textTransform: 'uppercase', lineHeight: 1.05 }}>
              {name}
            </div>
          )}
          {lines.map((l, i) => (
            <div key={l} style={{ fontSize: '9.5px', lineHeight: 1.5, marginTop: i === 0 && name ? '4px' : 0 }}>
              {/^HO:\s/.test(l) ? (
                <>
                  <span style={{ fontWeight: 700 }}>HO:</span> {l.replace(/^HO:\s*/, '')}
                </>
              ) : (
                l
              )}
            </div>
          ))}
        </div>
      </div>
      <div style={{ borderTop: HEAVY, marginTop: '6px' }} />
    </div>
  )
}

function RegisterPrint() {
  const { id } = useParams<{ id: string }>()
  const search = useSearchParams()
  const autoPrint = search.get('print') === '1'

  // The filters alone: `print` is an instruction to this page, not to the report.
  const filters = useMemo(() => {
    const q = new URLSearchParams(search.toString())
    q.delete('print')
    return q.toString()
  }, [search])

  const [data, setData] = useState<RegisterData | null>(null)
  const [error, setError] = useState<string | null>(null)
  // The logo, which the register's own letterhead does not carry. Open to
  // anyone signed in: it is on every paper the mill sends out. undefined
  // while it is on its way, null when there is none.
  const [logoUrl, setLogoUrl] = useState<string | null | undefined>(undefined)
  const printed = useRef(false)

  useEffect(() => {
    setData(null)
    setError(null)
    api
      .get<{ data: RegisterData & { register?: RegisterData['register'] } }>(
        `/reports/${id}/run${filters ? `?${filters}` : ''}`
      )
      .then((r) => {
        if (!r.data.register) {
          setError('This report has no printed page yet. Use Export → Excel instead.')
          return
        }
        setData(r.data)
      })
      .catch((e) => setError(e instanceof ApiError ? e.message : 'Could not load the report.'))
  }, [id, filters])

  useEffect(() => {
    let live = true
    api
      .get<{ data: { logoUrl: string | null } }>('/settings/app/logo')
      .then((r) => live && setLogoUrl(r.data?.logoUrl ?? null))
      // A register without its logo is still the register.
      .catch(() => live && setLogoUrl(null))
    return () => {
      live = false
    }
  }, [])

  const fileName = data
    ? fileNameFor(data.report.title, search.get('from'), search.get('to'))
    : undefined

  // Once, after the sheet has been laid out — a print box opened before the
  // rows are on the page would print the loading message, and one opened
  // before the logo has come would print the letterhead without it.
  const ready = Boolean(data) && logoUrl !== undefined
  useEffect(() => {
    if (!ready || !autoPrint || printed.current) return
    printed.current = true
    const t = window.setTimeout(() => printAs(fileName), 400)
    return () => window.clearTimeout(t)
  }, [ready, autoPrint, fileName])

  if (error) {
    return (
      <div style={{ maxWidth: '297mm', margin: '40px auto', background: '#fff', padding: '24px' }}>
        <p style={{ margin: 0 }}>{error}</p>
      </div>
    )
  }

  if (!data) {
    return (
      <div style={{ maxWidth: '297mm', margin: '40px auto', color: '#fff', textAlign: 'center' }}>
        Loading the register…
      </div>
    )
  }

  const { letterhead, generatedAt, generatedBy, spec } = data.register
  const paper = paperFor(spec.print.length)
  const width = paper.landscape ? '297mm' : '210mm'
  const running = [letterhead.name, data.report.title, data.periodLabel].filter(Boolean).join('  ·  ')
  const footer = `Generated on ${stampOf(generatedAt)}${generatedBy ? ` by ${generatedBy}` : ''}`

  /*
   * The page furniture lives in the page margins, which only CSS can reach:
   * the page number, the date it was made, and — from the second page on — a
   * line saying whose register it is, for the page that gets separated from
   * the rest of the stack. The column headings repeat by themselves, because
   * they are the table's head.
   *
   * Under that, the register set in black: its headings and totals unfilled,
   * its rules black, nothing grey. A cancelled bill, which the screen shows
   * greyed, prints in italics, as a cancelled line does on every document.
   */
  const pageCss = `
@page {
  size: A4 ${paper.landscape ? 'landscape' : 'portrait'};
  margin: 10mm 6mm 11mm;
  @top-left { content: ${cssText(running)}; font: 600 6.5pt/1.3 "Helvetica Neue", Arial, sans-serif; letter-spacing: .04em; color: #000; vertical-align: bottom; padding-bottom: 2mm; }
  @bottom-left { content: ${cssText(footer)}; font: 600 6.5pt/1.3 "Helvetica Neue", Arial, sans-serif; letter-spacing: .04em; color: #000; border-top: 0.75pt solid #000; vertical-align: top; padding-top: 2mm; }
  @bottom-right { content: "Page " counter(page) " of " counter(pages); font: 600 6.5pt/1.3 "Helvetica Neue", Arial, sans-serif; letter-spacing: .04em; color: #000; border-top: 0.75pt solid #000; vertical-align: top; text-align: right; padding-top: 2mm; }
}
@page :first { @top-left { content: none; } }

.register-page {
  width: ${width}; max-width: 100%; margin: 0 auto 14px; padding: 10mm 6mm; box-sizing: border-box;
  background: #fff; color: #000; font-family: ${SANS}; box-shadow: 0 2px 18px rgba(0,0,0,.35);
}
.print-toolbar {
  display: flex; align-items: center; gap: 12px; flex-wrap: wrap;
  width: ${width}; max-width: calc(100vw - 24px); box-sizing: border-box; margin: 0 auto 12px; padding: 8px 12px;
  background: #fff; border-radius: 6px; font: 13px "Helvetica Neue", Arial, sans-serif; color: #000;
}
.print-toolbar .tb-hint { color: #000; font-size: 12px; margin-right: auto; flex: 1; text-align: left; }
.print-toolbar .tb-btn {
  display: inline-flex; align-items: center; gap: 6px; padding: 6px 12px; border-radius: 6px;
  border: 1px solid #000; background: #fff; color: #000; font-size: 13px; font-weight: 600; cursor: pointer;
  text-decoration: none;
}
.print-toolbar .tb-primary { background: #000; border-color: #000; color: #fff; }

/* The letterhead above is the kit's; the register's own copy of it goes. */
.register-page .reg-company, .register-page .reg-address { display: none; }

.register-page .reg { background: #fff; color: #000; }
.register-page .reg-head { text-align: left; margin-bottom: 8px; }
.register-page .reg-title {
  margin-top: 5px; padding: 0; border: 0; font-size: 18px; font-weight: 800; letter-spacing: -.01em;
  text-transform: uppercase; line-height: 1.1;
}
.register-page .reg-title::before {
  content: "Report"; display: block; margin-bottom: 1px;
  font-size: 8.5px; font-weight: 700; letter-spacing: .08em; line-height: 1.3;
}
.register-page .reg-period { margin-top: 3px; font-size: 9.5px; font-weight: 700; }
.register-page .reg-filters { font-size: 9px; color: #000; }
.register-page .reg-meta { margin-top: 3px; font-size: 8.5px; color: #000; }
.register-page .reg-partial { margin-top: 5px; padding: 4px 8px; border: 1.25pt solid #000; font-size: 9.5px; font-weight: 800; color: #000; }

.register-page .reg-table th {
  background: none; color: #000; border-top: 0.75pt solid #000; border-bottom: 0.75pt solid #000;
}
.register-page .reg-table th + th, .register-page .reg-table td + td { border-left: 0.5pt solid #000; }
.register-page .reg-note td + td { border-left: 0; }
.register-page .reg-sub, .register-page .reg-table th .reg-sub { color: #000; }
.register-page .reg-doc tr.reg-first td { border-top: 0.5pt solid #000; }
.register-page .reg-doc:first-of-type tr.reg-first td { border-top: 0; }
.register-page .reg-void td { color: #000; font-style: italic; }
.register-page .reg-note td { color: #000; }
.register-page .reg-total td { background: none; border-top: 0.75pt solid #000; }
.register-page .reg-total .reg-count { color: #000; }
.register-page .reg-grand td { background: none; border-top: ${HEAVY}; border-bottom: 3px double #000; }
.register-page .reg-empty { color: #000; }

/* Black on white, enforced, as on every kit document: whatever the register
   sets, nothing inside the page prints in a colour, on a fill or faded. */
.register-page *:not(img) {
  color: #000 !important; border-color: #000 !important;
  background-color: transparent !important; background-image: none !important;
  box-shadow: none !important; text-shadow: none !important; opacity: 1 !important;
}

@media print {
  .no-print, .print-toolbar { display: none !important; }
  html, body { background: #fff !important; }
  .register-page { width: auto; max-width: none; margin: 0; padding: 0; box-shadow: none; }
}
`

  return (
    <>
      <style>{pageCss}</style>
      <PrintToolbar
        backHref={`/reports/${id}?${filters ? `${filters}&` : ''}tab=report`}
        backLabel="Back to the report"
        copies={1}
        fileName={fileName}
      />
      <div className="register-page">
        <Letterhead name={letterhead.name} lines={letterhead.lines} logoUrl={logoUrl ?? null} />
        <RegisterSheet data={data} mode="print" />
      </div>
    </>
  )
}

export default function RegisterPrintPage() {
  return (
    <Suspense fallback={null}>
      <RegisterPrint />
    </Suspense>
  )
}
