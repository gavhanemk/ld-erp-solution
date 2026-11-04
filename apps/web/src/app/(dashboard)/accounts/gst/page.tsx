'use client'

import { Fragment, useCallback, useEffect, useState } from 'react'
import { AlertCircle, CheckCircle2, FileJson, FileUp, Loader2, RefreshCw, Scale, Upload } from 'lucide-react'
import { api, apiErrorMessage, tokens } from '@/lib/api'
import { ExportButton } from '@/components/tables/ExportButton'
import { downloadRows, type ExportColumn, type ExportFormat } from '@/lib/export'
import { amountOrBlank, day, inr, todayIst } from '@/components/accounts/books'

type Tab = 'gstr1' | 'gstr3b' | 'gstr2b'
interface Tax {
  taxable: number
  igst: number
  cgst: number
  sgst: number
}
interface RateRow extends Tax {
  rate: number
}
interface Doc {
  id: string
  number: string
  date: string
  value: number
  customer: string
  gstin: string | null
  pos: string
  inter: boolean
  rates: RateRow[]
  invoice?: { number: string; date: string; value: number } | null
}
interface HsnRow extends Tax {
  hsn: string
  desc: string
  uqc: string
  qty: number
  rate: number
}
interface Series {
  prefix: string
  from: string
  to: string
  total: number
  cancelled: number
  net: number
}
interface G1 {
  gstin: string
  period: { from: string; to: string; fp: string }
  b2b: Doc[]
  b2cl: Doc[]
  b2cs: Array<RateRow & { pos: string; inter: boolean }>
  cdnr: Doc[]
  cdnur: Doc[]
  nil: Array<{ type: string; amount: number }>
  hsnB2b: HsnRow[]
  hsnB2c: HsnRow[]
  docs: { invoices: Series[]; notes: Series[] }
  totals: Record<'b2b' | 'b2cl' | 'cdnr' | 'cdnur', Tax & { count: number }> & { b2cs: Tax; net: Tax }
}
type Heads = { igst: number; cgst: number; sgst: number }
interface G3 {
  period: { from: string; to: string }
  outward: Tax
  nilRated: number
  rcmInward: Tax
  toUnregistered: Array<{ pos: string; taxable: number; igst: number }>
  itc: { rcm: Heads; other: Heads; reversed: Heads; net: Heads }
  setOff: { liability: Heads; credit: Heads; paid: { igst: Heads; cgst: { igst: number; cgst: number }; sgst: { igst: number; sgst: number } }; cash: Heads; carried: Heads }
  rcmCash: Heads
  books: { output: Heads; input: Heads }
}
interface MatchRow {
  status: 'matched' | 'differs' | 'only-2b' | 'only-books'
  supplier: string
  gstin: string
  number: string
  date: string
  twoB: Tax | null
  books: Tax | null
  bill: { id: string; billNumber: string; billDate: string } | null
  taxDiff: number | null
  itcAvailable: boolean
}
interface Match {
  rows: MatchRow[]
  summary: { matched: number; differs: number; only2b: number; onlyBooks: number; taxIn2b: number; taxInBooks: number; taxSafe: number }
}

const lastMonth = () => {
  const t = todayIst()
  const y = Number(t.slice(0, 4))
  const m = Number(t.slice(5, 7))
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`
}
const tax = (t: Heads) => t.igst + t.cgst + t.sgst
/** "2026-10" → "October 2026". */
const monthLabel = (m: string) => new Date(`${m}-01T00:00:00Z`).toLocaleDateString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' })
const STATUS: Record<MatchRow['status'], { label: string; badge: string }> = {
  matched: { label: 'Matched', badge: 'badge-success' },
  differs: { label: 'Differs', badge: 'badge-warning' },
  'only-2b': { label: 'Not booked here', badge: 'badge-danger' },
  'only-books': { label: 'Supplier has not filed', badge: 'badge-neutral' },
}

/** A table of tax heads, the same five columns everywhere on this page. */
function TaxCells({ t, bold = false }: { t: Tax; bold?: boolean }) {
  const c = `text-right tabular-nums ${bold ? 'font-semibold' : ''}`
  return (
    <>
      <td className={c}>{amountOrBlank(t.taxable)}</td>
      <td className={c}>{amountOrBlank(t.igst)}</td>
      <td className={c}>{amountOrBlank(t.cgst)}</td>
      <td className={c}>{amountOrBlank(t.sgst)}</td>
    </>
  )
}
const TaxHead = () => (
  <>
    <th className="w-32 text-right">Taxable ₹</th>
    <th className="w-28 text-right">IGST</th>
    <th className="w-28 text-right">CGST</th>
    <th className="w-28 text-right">SGST</th>
  </>
)

function Card({ title, children, extra }: { title: string; children: React.ReactNode; extra?: React.ReactNode }) {
  return (
    <div className="glass-card overflow-hidden p-0">
      <div className="border-border flex flex-wrap items-center justify-between gap-2 border-b px-4 py-2.5">
        <p className="text-foreground text-sm font-semibold">{title}</p>
        {extra}
      </div>
      <div className="overflow-x-auto">{children}</div>
    </div>
  )
}

/**
 * GST returns, from the invoices, credit notes, bills and notes themselves.
 *
 * GSTR-1: every outward supply sorted the way the return asks — registered
 * buyers invoice by invoice, large inter-state sales to the unregistered,
 * the rest by state and rate, credit notes, the HSN summary and documents
 * issued — and the JSON file the GST portal takes. GSTR-3B: the month's tax,
 * the input credit, how the credit pays the tax in the legal order, and what
 * is left to pay in cash; beside it what the GST ledgers say. GSTR-2B: the
 * portal's file of what suppliers filed, set against the bills booked here.
 */
export default function GstPage() {
  const [tab, setTab] = useState<Tab>('gstr1')
  const [month, setMonth] = useState(lastMonth())
  const [g1, setG1] = useState<G1 | null>(null)
  const [g3, setG3] = useState<G3 | null>(null)
  const [match, setMatch] = useState<Match | null>(null)
  const [matchFilter, setMatchFilter] = useState<MatchRow['status'] | ''>('')
  const [loading, setLoading] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const t = new URLSearchParams(window.location.search).get('tab')
    if (t === 'gstr3b' || t === 'gstr2b') setTab(t)
  }, [])

  const load = useCallback(async () => {
    if (tab === 'gstr2b') return
    setLoading(true)
    setError(null)
    try {
      if (tab === 'gstr1') setG1((await api.get<{ data: G1 }>(`/accounts/gst/gstr1?month=${month}`)).data)
      else setG3((await api.get<{ data: G3 }>(`/accounts/gst/gstr3b?month=${month}`)).data)
    } catch (err) {
      setError(apiErrorMessage(err, 'Could not work out the return.'))
    } finally {
      setLoading(false)
    }
  }, [tab, month])

  useEffect(() => {
    void load()
  }, [load])
  useEffect(() => setMatch(null), [month])

  const downloadJson = async () => {
    setError(null)
    try {
      const base = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:5000/api'
      const res = await fetch(`${base}/accounts/gst/gstr1.json?month=${month}`, { headers: { Authorization: `Bearer ${tokens.access() ?? ''}` } })
      if (!res.ok) throw new Error((await res.json().catch(() => ({})))?.message ?? `The file could not be made (${res.status}).`)
      const name = /filename="([^"]+)"/.exec(res.headers.get('Content-Disposition') ?? '')?.[1] ?? 'GSTR1.json'
      const url = URL.createObjectURL(await res.blob())
      const a = document.createElement('a')
      a.href = url
      a.download = name
      document.body.appendChild(a)
      a.click()
      a.remove()
      setTimeout(() => URL.revokeObjectURL(url), 1000)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The file could not be made.')
    }
  }

  const upload2b = async (file: File) => {
    setUploading(true)
    setError(null)
    try {
      const data = await new Promise<string>((resolve, reject) => {
        const r = new FileReader()
        r.onload = () => resolve(String(r.result).replace(/^data:.*?;base64,/, ''))
        r.onerror = () => reject(new Error('The file could not be read.'))
        r.readAsDataURL(file)
      })
      setMatch((await api.post<{ data: Match }>('/accounts/gst/2b', { fileName: file.name, file: data, month })).data)
    } catch (err) {
      setError(apiErrorMessage(err, 'Could not read that file.'))
    } finally {
      setUploading(false)
    }
  }

  const exportIt = async (format: ExportFormat) => {
    if (tab === 'gstr1' && g1) {
      type Row = { table: string; party: string; gstin: string; number: string; date: string; pos: string; rate: number | null } & Tax
      const rows: Row[] = []
      const docRows = (table: string, list: Doc[]) =>
        list.forEach((d) => d.rates.forEach((r) => rows.push({ table, party: d.customer, gstin: d.gstin ?? '', number: d.number, date: d.date, pos: d.pos, rate: r.rate, taxable: r.taxable, igst: r.igst, cgst: r.cgst, sgst: r.sgst })))
      docRows('B2B', g1.b2b)
      docRows('B2CL', g1.b2cl)
      g1.b2cs.forEach((r) => rows.push({ table: 'B2CS', party: '', gstin: '', number: '', date: '', pos: r.pos, rate: r.rate, taxable: r.taxable, igst: r.igst, cgst: r.cgst, sgst: r.sgst }))
      docRows('CDNR', g1.cdnr)
      docRows('CDNUR', g1.cdnur)
      ;[...g1.hsnB2b.map((h) => ({ ...h, t: 'HSN B2B' })), ...g1.hsnB2c.map((h) => ({ ...h, t: 'HSN B2C' }))].forEach((h) =>
        rows.push({ table: h.t, party: `${h.desc} (${h.uqc} ${h.qty})`, gstin: '', number: h.hsn, date: '', pos: '', rate: h.rate, taxable: h.taxable, igst: h.igst, cgst: h.cgst, sgst: h.sgst }),
      )
      const columns: ExportColumn<Row>[] = [
        { header: 'Table', value: (r) => r.table },
        { header: 'Party / description', value: (r) => r.party },
        { header: 'GSTIN', value: (r) => r.gstin },
        { header: 'Number / HSN', value: (r) => r.number },
        { header: 'Date', value: (r) => r.date },
        { header: 'Place of supply', value: (r) => r.pos },
        { header: 'Rate %', value: (r) => r.rate },
        { header: 'Taxable', value: (r) => r.taxable },
        { header: 'IGST', value: (r) => r.igst },
        { header: 'CGST', value: (r) => r.cgst },
        { header: 'SGST', value: (r) => r.sgst },
      ]
      await downloadRows({ rows, columns, name: `GSTR1-${month}`, sheet: 'GSTR-1', format })
    } else if (tab === 'gstr2b' && match) {
      const columns: ExportColumn<MatchRow>[] = [
        { header: 'Status', value: (r) => STATUS[r.status].label },
        { header: 'Supplier', value: (r) => r.supplier },
        { header: 'GSTIN', value: (r) => r.gstin },
        { header: 'Invoice', value: (r) => r.number },
        { header: 'Date', value: (r) => r.date },
        { header: 'Tax in 2B', value: (r) => (r.twoB ? tax(r.twoB) : null) },
        { header: 'Tax booked', value: (r) => (r.books ? tax(r.books) : null) },
        { header: 'Difference', value: (r) => r.taxDiff },
        { header: 'Our bill', value: (r) => r.bill?.billNumber ?? '' },
      ]
      await downloadRows({ rows: match.rows, columns, name: `GSTR2B-match-${month}`, sheet: '2B match', format })
    }
  }

  const docTable = (list: Doc[], showInvoice = false) => (
    <table className="data-table table-compact table-totals w-full min-w-[900px]">
      <thead>
        <tr>
          <th>Party</th>
          <th className="w-36">{showInvoice ? 'Note' : 'Invoice'}</th>
          <th className="w-14 text-right">POS</th>
          <th className="w-16 text-right">Rate</th>
          <TaxHead />
        </tr>
      </thead>
      <tbody>
        {list.flatMap((d) =>
          d.rates.map((r, i) => (
            <tr key={`${d.id}-${r.rate}`}>
              <td>
                {i === 0 && (
                  <>
                    <span className="text-foreground">{d.customer}</span>
                    {d.gstin && <span className="text-muted-foreground block font-mono text-[11px]">{d.gstin}</span>}
                  </>
                )}
              </td>
              <td>
                {i === 0 && (
                  <>
                    <span className="font-mono text-xs">{d.number}</span>
                    <span className="text-muted-foreground block text-[11px]">
                      {day(d.date)} · ₹{inr(d.value)}
                      {showInvoice && d.invoice && ` · on ${d.invoice.number}`}
                    </span>
                  </>
                )}
              </td>
              <td className="text-right tabular-nums">{d.pos}</td>
              <td className="text-right tabular-nums">{r.rate}%</td>
              <TaxCells t={r} />
            </tr>
          )),
        )}
      </tbody>
    </table>
  )

  const hsnTable = (rows: HsnRow[]) => (
    <table className="data-table table-compact w-full min-w-[820px]">
      <thead>
        <tr>
          <th className="w-24">HSN</th>
          <th>Description</th>
          <th className="w-20">Unit</th>
          <th className="w-24 text-right">Qty</th>
          <th className="w-16 text-right">Rate</th>
          <TaxHead />
        </tr>
      </thead>
      <tbody>
        {rows.map((h) => (
          <tr key={`${h.hsn}-${h.rate}-${h.uqc}`}>
            <td className="font-mono text-xs">{h.hsn || '—'}</td>
            <td className="text-muted-foreground max-w-[260px] truncate">{h.desc}</td>
            <td className="text-xs">{h.uqc}</td>
            <td className="text-right tabular-nums">{h.qty}</td>
            <td className="text-right tabular-nums">{h.rate}%</td>
            <TaxCells t={h} />
          </tr>
        ))}
      </tbody>
    </table>
  )

  const shown = (match?.rows ?? []).filter((r) => !matchFilter || r.status === matchFilter)

  return (
    <div className="space-y-5">
      <div className="page-header gap-3">
        <div className="flex min-w-0 flex-wrap items-center gap-4">
          <div className="min-w-0">
            <h1 className="page-title text-xl sm:text-2xl">GST Returns</h1>
            <p className="page-subtitle hidden sm:block">From the invoices, notes and bills themselves</p>
          </div>
          <div className="border-border bg-secondary flex rounded-lg border p-1" role="tablist">
            {(
              [
                { key: 'gstr1', label: 'GSTR-1' },
                { key: 'gstr3b', label: 'GSTR-3B' },
                { key: 'gstr2b', label: 'GSTR-2B match' },
              ] as const
            ).map((t) => (
              <button
                key={t.key}
                type="button"
                role="tab"
                aria-selected={tab === t.key}
                onClick={() => setTab(t.key)}
                className={`rounded-md px-3 py-1.5 text-sm transition-colors ${tab === t.key ? 'bg-card text-foreground font-medium shadow-sm' : 'text-muted-foreground hover:text-foreground'}`}
              >
                {t.label}
              </button>
            ))}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <button className="btn-ghost" onClick={() => void load()} disabled={loading} aria-label="Refresh">
            <RefreshCw size={15} className={loading ? 'animate-spin' : undefined} />
          </button>
          {tab !== 'gstr3b' && <ExportButton onExport={exportIt} disabled={loading || (tab === 'gstr1' ? !g1 : !match)} />}
          {tab === 'gstr1' && (
            <button className="btn-primary" onClick={() => void downloadJson()} disabled={!g1}>
              <FileJson size={15} /> <span className="hidden sm:inline">File for the portal</span>
            </button>
          )}
        </div>
      </div>

      <div className="glass-card flex flex-wrap items-center gap-2 p-3">
        <label className="text-muted-foreground flex items-center gap-2 text-sm">
          Return for
          <input type="month" className="form-input h-9 w-[170px]" value={month} max={todayIst().slice(0, 7)} onChange={(e) => setMonth(e.target.value || lastMonth())} />
        </label>
        {tab === 'gstr1' && g1 && <span className="text-muted-foreground ml-auto font-mono text-xs">GSTIN {g1.gstin}</span>}
      </div>

      {error && (
        <div className="border-destructive/40 bg-destructive/5 flex items-start gap-3 rounded-lg border p-3">
          <AlertCircle size={16} className="text-destructive mt-0.5 shrink-0" />
          <p className="text-destructive text-sm">{error}</p>
        </div>
      )}
      {loading && <div className="skeleton h-48 w-full rounded-xl" />}

      {tab === 'gstr1' && g1 && !loading && (
        <>
          <div className="grid grid-cols-2 gap-2 lg:grid-cols-5">
            {[
              { label: `B2B — ${g1.totals.b2b.count} invoices`, t: g1.totals.b2b },
              { label: `B2C large — ${g1.totals.b2cl.count}`, t: g1.totals.b2cl },
              { label: 'B2C others', t: g1.totals.b2cs },
              { label: `Credit notes — ${g1.totals.cdnr.count + g1.totals.cdnur.count}`, t: { taxable: g1.totals.cdnr.taxable + g1.totals.cdnur.taxable, igst: g1.totals.cdnr.igst + g1.totals.cdnur.igst, cgst: g1.totals.cdnr.cgst + g1.totals.cdnur.cgst, sgst: g1.totals.cdnr.sgst + g1.totals.cdnur.sgst } },
              { label: 'Net outward supply', t: g1.totals.net },
            ].map((c) => (
              <div key={c.label} className="glass-card p-3">
                <p className="text-muted-foreground text-[11px]">{c.label}</p>
                <p className="text-foreground mt-0.5 text-lg font-semibold tabular-nums">₹{inr(c.t.taxable)}</p>
                <p className="text-muted-foreground text-[11px] tabular-nums">tax ₹{inr(tax(c.t))}</p>
              </div>
            ))}
          </div>
          {g1.b2b.length > 0 && <Card title={`4A — B2B: ${g1.b2b.length} invoices to registered buyers`}>{docTable(g1.b2b)}</Card>}
          {g1.b2cl.length > 0 && <Card title={`5 — B2C large: inter-state invoices over ₹1 lakh to the unregistered`}>{docTable(g1.b2cl)}</Card>}
          {g1.b2cs.length > 0 && (
            <Card title="7 — B2C others, by place of supply and rate (credit notes taken off)">
              <table className="data-table table-compact w-full min-w-[640px]">
                <thead>
                  <tr>
                    <th>Place of supply</th>
                    <th className="w-16 text-right">Rate</th>
                    <TaxHead />
                  </tr>
                </thead>
                <tbody>
                  {g1.b2cs.map((r) => (
                    <tr key={`${r.pos}-${r.rate}`}>
                      <td>
                        {r.pos} <span className="text-muted-foreground text-[11px]">{r.inter ? 'inter-state' : 'within the state'}</span>
                      </td>
                      <td className="text-right tabular-nums">{r.rate}%</td>
                      <TaxCells t={r} />
                    </tr>
                  ))}
                </tbody>
              </table>
            </Card>
          )}
          {g1.cdnr.length + g1.cdnur.length > 0 && <Card title="9B — Credit notes">{docTable([...g1.cdnr, ...g1.cdnur], true)}</Card>}
          {g1.hsnB2b.length > 0 && <Card title="12 — HSN summary, sales to registered buyers">{hsnTable(g1.hsnB2b)}</Card>}
          {g1.hsnB2c.length > 0 && <Card title="12 — HSN summary, sales to the unregistered">{hsnTable(g1.hsnB2c)}</Card>}
          <Card title="13 — Documents issued">
            <table className="data-table table-compact w-full">
              <thead>
                <tr>
                  <th>Kind</th>
                  <th>From</th>
                  <th>To</th>
                  <th className="text-right">Issued</th>
                  <th className="text-right">Cancelled</th>
                  <th className="text-right">Net</th>
                </tr>
              </thead>
              <tbody>
                {[...g1.docs.invoices.map((s) => ({ ...s, kind: 'Invoices' })), ...g1.docs.notes.map((s) => ({ ...s, kind: 'Credit notes' }))].map((s) => (
                  <tr key={`${s.kind}-${s.prefix}`}>
                    <td>{s.kind}</td>
                    <td className="font-mono text-xs">{s.from}</td>
                    <td className="font-mono text-xs">{s.to}</td>
                    <td className="text-right tabular-nums">{s.total}</td>
                    <td className="text-right tabular-nums">{s.cancelled || ''}</td>
                    <td className="text-right tabular-nums">{s.net}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
          <p className="text-muted-foreground text-xs">
            &quot;File for the portal&quot; is GSTR-1 in the GST offline tool&apos;s JSON, to upload on the GST portal. Check it with your CA the first time it is filed from here.
          </p>
        </>
      )}

      {tab === 'gstr3b' && g3 && !loading && (
        <>
          <Card title="3.1 — Outward supplies and inward supplies on reverse charge">
            <table className="data-table table-compact table-totals w-full min-w-[760px]">
              <thead>
                <tr>
                  <th>Nature of supply</th>
                  <TaxHead />
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td>(a) Outward taxable supplies, less credit notes</td>
                  <TaxCells t={g3.outward} />
                </tr>
                <tr>
                  <td>(c) Nil-rated and exempt</td>
                  <TaxCells t={{ taxable: g3.nilRated, igst: 0, cgst: 0, sgst: 0 }} />
                </tr>
                <tr>
                  <td>(d) Inward supplies liable to reverse charge</td>
                  <TaxCells t={g3.rcmInward} />
                </tr>
              </tbody>
              <tfoot>
                <tr>
                  <td className="text-muted-foreground text-xs">The output GST ledgers took, for the same month</td>
                  <td />
                  <td className="text-muted-foreground text-right text-xs tabular-nums">{inr(g3.books.output.igst)}</td>
                  <td className="text-muted-foreground text-right text-xs tabular-nums">{inr(g3.books.output.cgst)}</td>
                  <td className="text-muted-foreground text-right text-xs tabular-nums">{inr(g3.books.output.sgst)}</td>
                </tr>
              </tfoot>
            </table>
          </Card>
          {g3.toUnregistered.length > 0 && (
            <Card title="3.2 — Inter-state supplies to the unregistered">
              <table className="data-table table-compact w-full">
                <thead>
                  <tr>
                    <th>Place of supply</th>
                    <th className="w-32 text-right">Taxable ₹</th>
                    <th className="w-28 text-right">IGST</th>
                  </tr>
                </thead>
                <tbody>
                  {g3.toUnregistered.map((x) => (
                    <tr key={x.pos}>
                      <td>{x.pos}</td>
                      <td className="text-right tabular-nums">{inr(x.taxable)}</td>
                      <td className="text-right tabular-nums">{inr(x.igst)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Card>
          )}
          <Card title="4 — Input tax credit">
            <table className="data-table table-compact table-totals w-full min-w-[640px]">
              <thead>
                <tr>
                  <th>Details</th>
                  <th className="w-28 text-right">IGST</th>
                  <th className="w-28 text-right">CGST</th>
                  <th className="w-28 text-right">SGST</th>
                </tr>
              </thead>
              <tbody>
                {[
                  { label: '(A)(3) Inward supplies liable to reverse charge', h: g3.itc.rcm },
                  { label: '(A)(5) All other input credit', h: g3.itc.other },
                  { label: '(B) Reversed — purchase notes that cut the credit', h: g3.itc.reversed },
                ].map((r) => (
                  <tr key={r.label}>
                    <td>{r.label}</td>
                    <td className="text-right tabular-nums">{amountOrBlank(r.h.igst)}</td>
                    <td className="text-right tabular-nums">{amountOrBlank(r.h.cgst)}</td>
                    <td className="text-right tabular-nums">{amountOrBlank(r.h.sgst)}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <td className="font-semibold">(C) Net input credit</td>
                  <td className="text-right font-semibold tabular-nums">{inr(g3.itc.net.igst)}</td>
                  <td className="text-right font-semibold tabular-nums">{inr(g3.itc.net.cgst)}</td>
                  <td className="text-right font-semibold tabular-nums">{inr(g3.itc.net.sgst)}</td>
                </tr>
                <tr>
                  <td className="text-muted-foreground text-xs">The input GST ledgers took, for the same month</td>
                  <td className="text-muted-foreground text-right text-xs tabular-nums">{inr(g3.books.input.igst)}</td>
                  <td className="text-muted-foreground text-right text-xs tabular-nums">{inr(g3.books.input.cgst)}</td>
                  <td className="text-muted-foreground text-right text-xs tabular-nums">{inr(g3.books.input.sgst)}</td>
                </tr>
              </tfoot>
            </table>
          </Card>
          <Card title="6.1 — Payment of tax: credit used, and cash to pay">
            <table className="data-table table-compact table-totals w-full min-w-[820px]">
              <thead>
                <tr>
                  <th>Tax</th>
                  <th className="w-28 text-right">Payable</th>
                  <th className="w-28 text-right">By IGST credit</th>
                  <th className="w-28 text-right">By CGST credit</th>
                  <th className="w-28 text-right">By SGST credit</th>
                  <th className="w-28 text-right">In cash</th>
                </tr>
              </thead>
              <tbody>
                {(['igst', 'cgst', 'sgst'] as const).map((h) => (
                  <tr key={h}>
                    <td className="uppercase">{h}</td>
                    <td className="text-right tabular-nums">{inr(g3.setOff.liability[h])}</td>
                    <td className="text-right tabular-nums">{amountOrBlank(g3.setOff.paid.igst[h])}</td>
                    <td className="text-right tabular-nums">{h === 'sgst' ? '—' : amountOrBlank(g3.setOff.paid.cgst[h])}</td>
                    <td className="text-right tabular-nums">{h === 'cgst' ? '—' : amountOrBlank(g3.setOff.paid.sgst[h as 'igst' | 'sgst'])}</td>
                    <td className="text-right font-medium tabular-nums">{inr(g3.setOff.cash[h] + g3.rcmCash[h])}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <td className="font-semibold" colSpan={5}>
                    Cash to pay with the return
                  </td>
                  <td className="text-right font-semibold tabular-nums">₹{inr(tax(g3.setOff.cash) + tax(g3.rcmCash))}</td>
                </tr>
              </tfoot>
            </table>
            <p className="border-border text-muted-foreground border-t px-4 py-2.5 text-xs">
              Credit is used in the order the law lays down: IGST credit first, then CGST and SGST credit; CGST credit never pays SGST. Tax on reverse charge
              {tax(g3.rcmCash) ? ` (₹${inr(tax(g3.rcmCash))})` : ''} is paid in cash. Credit carried to next month: IGST ₹{inr(g3.setOff.carried.igst)}, CGST ₹{inr(g3.setOff.carried.cgst)}, SGST ₹{inr(g3.setOff.carried.sgst)}. Credit here is what the bills claim; check it against GSTR-2B before filing.
            </p>
          </Card>
        </>
      )}

      {tab === 'gstr2b' && (
        <>
          <div className="glass-card flex flex-col gap-3 p-5 sm:flex-row sm:items-center">
            <div className="flex-1">
              <p className="text-foreground flex items-center gap-2 font-semibold">
                <Scale size={16} /> What suppliers filed, against what was booked
              </p>
              <p className="text-muted-foreground mt-1 text-sm">
                On the GST portal open Returns → GSTR-2B for {monthLabel(month)}, download it as JSON, and upload that file here. Each supplier invoice is matched to a purchase bill by the supplier&apos;s GSTIN and invoice number.
              </p>
            </div>
            <label className="btn-primary cursor-pointer">
              {uploading ? <Loader2 size={15} className="animate-spin" /> : <Upload size={15} />} Upload GSTR-2B
              <input type="file" accept=".json,application/json" className="hidden" disabled={uploading} onChange={(e) => e.target.files?.[0] && void upload2b(e.target.files[0])} />
            </label>
          </div>
          {match && (
            <>
              <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
                {(
                  [
                    ['matched', match.summary.matched],
                    ['differs', match.summary.differs],
                    ['only-2b', match.summary.only2b],
                    ['only-books', match.summary.onlyBooks],
                  ] as const
                ).map(([k, n]) => (
                  <button
                    key={k}
                    type="button"
                    onClick={() => setMatchFilter(matchFilter === k ? '' : k)}
                    aria-pressed={matchFilter === k}
                    className={`glass-card p-3 text-left ${matchFilter === k ? 'ring-primary bg-primary/5 ring-2' : 'hover:bg-secondary/40'}`}
                  >
                    <p className="text-muted-foreground text-[11px]">{STATUS[k].label}</p>
                    <p className="text-foreground mt-0.5 text-lg font-semibold tabular-nums">{n}</p>
                  </button>
                ))}
              </div>
              <p className="text-muted-foreground flex items-center gap-1.5 text-xs">
                <CheckCircle2 size={13} /> Credit safe to claim (matched, and available in 2B): ₹{inr(match.summary.taxSafe)} of ₹{inr(match.summary.taxInBooks)} booked; suppliers filed ₹{inr(match.summary.taxIn2b)}.
              </p>
              <Card title={`${shown.length} invoices`}>
                <table className="data-table table-compact w-full min-w-[900px]">
                  <thead>
                    <tr>
                      <th className="w-40">Status</th>
                      <th>Supplier</th>
                      <th className="w-36">Their invoice</th>
                      <th className="w-28 text-right">Tax in 2B</th>
                      <th className="w-28 text-right">Tax booked</th>
                      <th className="w-28 text-right">Difference</th>
                      <th className="w-32">Our bill</th>
                    </tr>
                  </thead>
                  <tbody>
                    {shown.map((r, i) => (
                      <Fragment key={`${r.gstin}-${r.number}-${i}`}>
                        <tr>
                          <td>
                            <span className={STATUS[r.status].badge}>{STATUS[r.status].label}</span>
                            {r.twoB && !r.itcAvailable && <span className="text-destructive block text-[11px]">credit not available</span>}
                          </td>
                          <td>
                            {r.supplier}
                            <span className="text-muted-foreground block font-mono text-[11px]">{r.gstin}</span>
                          </td>
                          <td>
                            <span className="font-mono text-xs">{r.number}</span>
                            <span className="text-muted-foreground block text-[11px]">{day(r.date)}</span>
                          </td>
                          <td className="text-right tabular-nums">{r.twoB ? inr(tax(r.twoB)) : ''}</td>
                          <td className="text-right tabular-nums">{r.books ? inr(tax(r.books)) : ''}</td>
                          <td className={`text-right tabular-nums ${r.taxDiff ? 'text-accent' : ''}`}>{r.taxDiff ? inr(r.taxDiff) : ''}</td>
                          <td className="font-mono text-xs">{r.bill?.billNumber ?? ''}</td>
                        </tr>
                      </Fragment>
                    ))}
                  </tbody>
                </table>
              </Card>
            </>
          )}
          {!match && (
            <p className="text-muted-foreground flex items-center gap-1.5 text-sm">
              <FileUp size={15} /> Nothing uploaded for {monthLabel(month)} yet.
            </p>
          )}
        </>
      )}
    </div>
  )
}
