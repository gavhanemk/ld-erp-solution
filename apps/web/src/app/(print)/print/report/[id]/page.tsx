'use client'

import { Suspense, useEffect, useMemo, useRef, useState } from 'react'
import { useParams, useSearchParams } from 'next/navigation'
import { api, ApiError } from '@/lib/api'
import { PrintToolbar, printAs } from '@/components/print/PrintSheet'
import { RegisterSheet, stampOf, type RegisterData } from '@/components/reports/RegisterSheet'

/**
 * A register, printed — and saved as the PDF.
 *
 * The same sheet the report screen shows, laid on a landscape A4. The browser
 * saves a PDF by printing to one, so the PDF is this page and nothing else:
 * there is no second, slightly different document to keep in step with it.
 *
 * Opened with `print=1` — which is what Export → PDF does — the print box
 * comes up by itself once the register has loaded.
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
          setError('This report is not a register, so it has no printed page. Use Export → Excel instead.')
          return
        }
        setData(r.data)
      })
      .catch((e) => setError(e instanceof ApiError ? e.message : 'Could not load the report.'))
  }, [id, filters])

  const fileName = data
    ? fileNameFor(data.report.title, search.get('from'), search.get('to'))
    : undefined

  // Once, after the sheet has been laid out — a print box opened before the
  // rows are on the page would print the loading message.
  useEffect(() => {
    if (!data || !autoPrint || printed.current) return
    printed.current = true
    const t = window.setTimeout(() => printAs(fileName), 400)
    return () => window.clearTimeout(t)
  }, [data, autoPrint, fileName])

  if (error) {
    return (
      <div style={{ maxWidth: '297mm', margin: '40px auto', background: '#fff', padding: '24px' }}>
        <p style={{ color: '#a03030', margin: 0 }}>{error}</p>
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

  const { letterhead, generatedAt, generatedBy } = data.register
  const running = [letterhead.name, data.report.title, data.periodLabel].filter(Boolean).join('  ·  ')
  const footer = `Generated on ${stampOf(generatedAt)}${generatedBy ? ` by ${generatedBy}` : ''}`

  /*
   * The page furniture lives in the page margins, which only CSS can reach:
   * the page number, the date it was made, and — from the second page on — a
   * line saying whose register it is, for the page that gets separated from
   * the rest of the stack. The column headings repeat by themselves, because
   * they are the table's head.
   */
  const pageCss = `
@page {
  size: A4 landscape;
  margin: 10mm 6mm 11mm;
  @top-left { content: ${cssText(running)}; font: 6.5pt Helvetica, Arial, sans-serif; color: #555; vertical-align: bottom; padding-bottom: 2mm; }
  @bottom-left { content: ${cssText(footer)}; font: 6.5pt Helvetica, Arial, sans-serif; color: #555; vertical-align: top; padding-top: 2mm; }
  @bottom-right { content: "Page " counter(page) " of " counter(pages); font: 6.5pt Helvetica, Arial, sans-serif; color: #555; vertical-align: top; padding-top: 2mm; }
}
@page :first { @top-left { content: none; } }

.register-page {
  width: 297mm; margin: 0 auto 14px; padding: 10mm 6mm; box-sizing: border-box;
  background: #fff; box-shadow: 0 2px 18px rgba(0,0,0,.35);
}
.print-toolbar {
  display: flex; align-items: center; gap: 14px; max-width: 297mm; margin: 0 auto 12px;
  padding: 8px 12px; background: #fff; border-radius: 6px;
  font: 13px Inter, system-ui, sans-serif; color: #1f2b3d;
}
.print-toolbar .tb-hint { color: #5a6880; font-size: 12px; margin-right: auto; }
.print-toolbar .tb-btn {
  display: inline-flex; align-items: center; gap: 6px; padding: 6px 12px; border-radius: 6px;
  border: 1px solid #b9c4d4; background: #fff; color: #173a6c; font-weight: 600; cursor: pointer;
  text-decoration: none;
}
.print-toolbar .tb-primary { background: #173a6c; border-color: #173a6c; color: #fff; }

@media print {
  .no-print, .print-toolbar { display: none !important; }
  html, body { background: #fff !important; }
  .register-page { width: auto; margin: 0; padding: 0; box-shadow: none; }
}
`

  return (
    <>
      <style>{pageCss}</style>
      <PrintToolbar
        backHref={`/reports/${id}${filters ? `?${filters}` : ''}`}
        backLabel="Back to the register"
        copies={1}
        fileName={fileName}
      />
      <div className="register-page">
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
