'use client'

import { useEffect, useState } from 'react'
import { AlertTriangle, ArrowDownToLine, ArrowUpFromLine, CheckCircle2, Loader2, PackageCheck, Printer, Scissors, Wrench } from 'lucide-react'
import { api, ApiError } from '@/lib/api'
import { KpiTile, TONE } from '@/components/dashboard/DashKit'
import { pcs } from './types'

interface Row {
  id: string
  at: string
  type: string
  mo: string
  jobCard: string | null
  bundles: string[]
  sizes: string[]
  received: number
  cut: number
  done: number
  sentOn: number
  packed: number
  onTheWay: number
  damaged: number
  failed: number
  rework: number
  bGrade: number
  scrapped: number
  short: number
  from: string | null
  to: string | null
  unit: string | null
  isRework: boolean
  reason: string | null
  notes: string | null
  by: string | null
  document: string | null
}
interface Report {
  rows: Row[]
  totals: Record<'received' | 'cut' | 'done' | 'sentOn' | 'packed' | 'damaged' | 'failed' | 'rework' | 'bGrade' | 'scrapped' | 'short', number>
  mos: string[]
}

const IST = { timeZone: 'Asia/Kolkata' } as const
const day = (d: string) => new Date(d).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', ...IST })
const time = (d: string) => new Date(d).toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit', ...IST })
const isoDay = (d: Date) => d.toLocaleDateString('en-CA', IST)

/** What one entry was, in a few words. */
function what(r: Row, check: boolean) {
  if (r.type === 'CUT') return 'Cut'
  if (r.type === 'RECEIVE') return `Counted in${r.from ? ` from ${r.from}` : ''}`
  if (r.type === 'EXCESS') return `Counted in, more than sent${r.from ? `, from ${r.from}` : ''}`
  if (r.type === 'SETTLE') return 'Short settled'
  if (r.type === 'DISPATCH') {
    if (r.sentOn) return `Sent on to ${r.to ?? 'the next step'}`
    if (r.rework) return `Back to ${r.unit ?? 'the unit'} to put right`
    if (r.received) return `Given to ${r.unit ?? 'an outside unit'}${r.from ? ` from ${r.from}` : ''}`
    return `On the way here${r.from ? ` from ${r.from}` : ''}`
  }
  if (r.type === 'VENDOR_RETURN') return `Back from ${r.unit ?? 'the unit'}`
  if (r.type === 'PROCESS') return check ? 'Checked' : 'Work recorded'
  if (r.type === 'DECIDE') return 'Decision on damaged pieces'
  if (r.type === 'REWORK_DONE') return 'Rework put right'
  if (r.type === 'PACK') return 'Into finished goods'
  if (r.type === 'SHORT') return 'Found short'
  return r.type
}

/**
 * One stage's report, across every job card: what came in and from where,
 * what was done or passed, what was sent on and to where, and every damaged
 * or failed piece with the reason given — dated, timed and signed. For a
 * date range, and one order if wanted; prints as it stands.
 */
export function StageReport({ operationId, name, check }: { operationId: string; name: string; check: boolean }) {
  const today = new Date()
  const [from, setFrom] = useState(isoDay(new Date(today.getTime() - 30 * 86400000)))
  const [to, setTo] = useState(isoDay(today))
  const [mo, setMo] = useState('')
  const [onlyDamage, setOnlyDamage] = useState(false)
  const [data, setData] = useState<Report | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let live = true
    setLoading(true)
    setError(null)
    const qs = new URLSearchParams({ operationId, ...(from ? { from } : {}), ...(to ? { to } : {}) })
    api
      .get<{ data: Report }>(`/production/stage-report?${qs}`)
      .then((r) => live && setData(r.data))
      .catch((err) => live && setError(err instanceof ApiError ? err.message : 'Could not load the report.'))
      .finally(() => live && setLoading(false))
    return () => {
      live = false
    }
  }, [operationId, from, to])

  const rows = (data?.rows ?? []).filter((r) => (!mo || r.mo === mo) && (!onlyDamage || r.damaged + r.failed + r.rework + r.bGrade + r.scrapped + r.short > 0))
  const t = rows.reduce(
    (s, r) => ({
      in: s.in + r.received + r.cut,
      done: s.done + r.done,
      out: s.out + r.sentOn + r.packed,
      bad: s.bad + r.damaged + r.failed,
      rework: s.rework + r.rework,
    }),
    { in: 0, done: 0, out: 0, bad: 0, rework: 0 },
  )

  return (
    <div className="space-y-3">
      <div className="glass-card flex flex-wrap items-center gap-2 p-2 print:hidden">
        <span className="text-muted-foreground px-1 text-xs font-semibold uppercase tracking-wide">{name} report</span>
        <input type="date" className="form-input h-9 w-[8.5rem] px-2 py-0 text-xs" value={from} max={to || undefined} onChange={(e) => setFrom(e.target.value)} aria-label="From" />
        <span className="text-muted-foreground text-xs">to</span>
        <input type="date" className="form-input h-9 w-[8.5rem] px-2 py-0 text-xs" value={to} min={from || undefined} onChange={(e) => setTo(e.target.value)} aria-label="To" />
        <select className="form-input h-9 w-44 px-2 py-0 text-sm" value={mo} onChange={(e) => setMo(e.target.value)} aria-label="Order">
          <option value="">All orders</option>
          {data?.mos.map((m) => (
            <option key={m} value={m}>
              {m}
            </option>
          ))}
        </select>
        <label className="flex items-center gap-1.5 px-1 text-xs">
          <input type="checkbox" className="accent-primary" checked={onlyDamage} onChange={(e) => setOnlyDamage(e.target.checked)} />
          Only damage, failures and rework
        </label>
        {loading && <Loader2 size={14} className="text-muted-foreground animate-spin" />}
        <button type="button" className="btn-secondary ml-auto h-9" onClick={() => window.print()}>
          <Printer size={14} /> Print
        </button>
      </div>

      {error && <p className="text-destructive text-sm">{error}</p>}

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        <KpiTile icon={name.toLowerCase().includes('cut') ? Scissors : ArrowDownToLine} tone={TONE.sky} label={t.in && rows.some((r) => r.cut) ? 'Cut' : 'Received in'} value={pcs(t.in)} sub="pieces" />
        <KpiTile icon={CheckCircle2} tone={TONE.emerald} label={check ? 'Passed' : 'Done'} value={pcs(t.done)} sub="pieces" />
        <KpiTile icon={rows.some((r) => r.packed) ? PackageCheck : ArrowUpFromLine} tone={TONE.violet} label={rows.some((r) => r.packed) ? 'Sent on / into FG' : 'Sent on'} value={pcs(t.out)} sub="pieces" />
        <KpiTile icon={AlertTriangle} tone={TONE.rose} label={check ? 'Failed / damaged' : 'Damaged'} value={pcs(t.bad)} valueClass={t.bad ? 'text-red-500' : 'text-foreground'} sub="with the reason below" />
        <KpiTile icon={Wrench} tone={TONE.amber} label="For rework" value={pcs(t.rework)} sub="pieces" />
      </div>

      <div className="glass-card overflow-hidden p-0">
        {!rows.length ? (
          <p className="text-muted-foreground p-6 text-center text-sm">{loading ? 'Loading…' : `Nothing recorded at ${name} in these dates.`}</p>
        ) : (
          <div className="max-h-[65vh] overflow-auto print:max-h-none">
            <table className="data-table table-compact min-w-full">
              <thead className="sticky top-0 z-10 [&_th]:bg-secondary">
                <tr>
                  <th>Date</th>
                  <th>What</th>
                  <th>Job card</th>
                  <th>Bundles · sizes</th>
                  <th style={{ textAlign: 'right' }}>In</th>
                  <th style={{ textAlign: 'right' }}>{check ? 'Passed' : 'Done'}</th>
                  <th style={{ textAlign: 'right' }}>Out</th>
                  <th style={{ textAlign: 'right' }}>Damaged / failed</th>
                  <th>Reason</th>
                  <th>By</th>
                  <th>Document</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const bad = r.damaged + r.failed
                  const flagged = bad + r.rework + r.bGrade + r.scrapped + r.short > 0
                  return (
                    <tr key={r.id} className={flagged ? 'bg-red-500/5' : ''}>
                      <td className="whitespace-nowrap text-xs">
                        {day(r.at)}
                        <div className="text-muted-foreground">{time(r.at)}</div>
                      </td>
                      <td className="text-sm">
                        <span className="text-foreground font-medium">{what(r, check)}</span>
                        {r.unit && !what(r, check).includes(r.unit) && <div className="text-muted-foreground text-xs">{r.unit}</div>}
                      </td>
                      <td className="whitespace-nowrap font-mono text-xs">{r.jobCard ?? r.mo}</td>
                      <td className="text-xs">
                        {r.bundles.length} {r.bundles.length === 1 ? 'bundle' : 'bundles'}
                        {r.sizes.length ? <span className="text-muted-foreground"> · {r.sizes.join(', ')}</span> : null}
                      </td>
                      <td className="text-right tabular-nums">{r.received + r.cut ? pcs(r.received + r.cut) : <span className="text-muted-foreground">—</span>}</td>
                      <td className="text-right tabular-nums">{r.done ? pcs(r.done) : <span className="text-muted-foreground">—</span>}</td>
                      <td className="text-right tabular-nums">{r.sentOn + r.packed ? pcs(r.sentOn + r.packed) : <span className="text-muted-foreground">—</span>}</td>
                      <td className="text-right tabular-nums">
                        {bad ? <span className="font-semibold text-red-500">{pcs(bad)}</span> : <span className="text-muted-foreground">—</span>}
                        {r.rework ? <div className="text-xs text-amber-600">{pcs(r.rework)} for rework</div> : null}
                        {r.bGrade ? <div className="text-xs text-amber-600">{pcs(r.bGrade)} B-grade</div> : null}
                        {r.scrapped ? <div className="text-xs text-red-500">{pcs(r.scrapped)} written off</div> : null}
                        {r.short ? <div className="text-xs text-red-500">{pcs(r.short)} short</div> : null}
                      </td>
                      <td className="max-w-[16rem] text-sm">{r.reason ? <span className="text-foreground">{r.reason}</span> : flagged ? <span className="text-muted-foreground text-xs">No reason given</span> : ''}</td>
                      <td className="text-muted-foreground text-xs">{r.by ?? '—'}</td>
                      <td className="whitespace-nowrap font-mono text-[11px]">{r.document ?? ''}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  )
}
