'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { AlertCircle, ArrowRight, ChevronRight, Search } from 'lucide-react'
import { api, ApiError, type Paginated } from '@/lib/api'
import { formatDate } from '@/lib/utils'
import { useAppSettings } from '@/lib/appSettings'
import { Pagination } from '@/components/tables/Pagination'
import { SmartSelect } from '@/components/ui/SmartSelect'
import { pcs, type Stage, type StepFigures } from './types'

/**
 * One stage's work: a row for each job card at that stage, saying in plain
 * words what is waiting there — pieces to count in, to work on, to send on,
 * to decide on — with its figures. A row opens the job card's sheet for the
 * stage, where the work is recorded.
 */

export interface StageRow {
  card: {
    id: string
    jobCardNumber: string
    designNo: string | null
    line: { id: string; color: string; totalQty: number; style: { code: string; name: string } }
    mo: { id: string; moNumber: string; held: boolean; due: string | null; so: { soNumber: string; customer: { name: string } } | null }
  }
  step: { id: string; name: string; kind: string; isQcStep: boolean; execution: string; department: { name: string }; unit: { name: string } | null; skipped: boolean; last: boolean }
  stage: Stage
  from: string[]
  next: { id: string; name: string; execution: string } | null
  figures: StepFigures
  withCutters: number
  toCountIn: number
  active: boolean
}

type Tone = 'act' | 'warn' | 'info' | 'done' | 'muted'
const DOT: Record<Tone, string> = { act: 'bg-primary', warn: 'bg-destructive', info: 'bg-foreground/50', done: 'bg-primary/50', muted: 'bg-muted-foreground/40' }

/** What is waiting at this stage for this job card, in words, most urgent first. */
export function whatWaits(r: StageRow): Array<{ text: string; tone: Tone }> {
  const f = r.figures
  const out: Array<{ text: string; tone: Tone }> = []
  const check = r.stage === 'QC'
  if (r.toCountIn) out.push({ text: `${r.toCountIn} ${r.toCountIn === 1 ? 'transfer' : 'transfers'} from ${r.from.join(' / ') || 'the stage before'} to count in (${pcs(f.inTransit)} pcs)`, tone: 'act' })
  if (r.stage === 'CUTTING') {
    const left = Math.max(0, r.card.line.totalQty - f.completed - r.withCutters)
    if (r.withCutters) out.push({ text: `${pcs(r.withCutters)} pcs with cutting contractors — receive them when cut`, tone: 'info' })
    if (f.waiting) out.push({ text: `${pcs(f.waiting)} pcs cut, ready to transfer on`, tone: 'act' })
    if (left && f.state !== 'DONE') out.push({ text: `${pcs(left)} pcs still to issue for cutting`, tone: 'info' })
  } else {
    if (f.atVendor) out.push({ text: `${pcs(f.atVendor)} pcs with ${r.step.unit?.name ?? 'the outside unit'} — record them when they come back`, tone: 'info' })
    if (f.inHand && r.step.execution !== 'OUTSOURCED') {
      out.push({ text: check ? `${pcs(f.inHand)} pcs to check` : `${pcs(f.inHand)} pcs here to work on and send on`, tone: 'act' })
    }
    if (f.waiting) out.push({ text: `${pcs(f.waiting)} pcs ${check ? 'passed' : 'done'}, ready to ${r.step.last ? 'go into finished goods' : 'transfer on'}`, tone: 'act' })
    if (f.damagedNow + f.rejectedNow) out.push({ text: `${pcs(f.damagedNow + f.rejectedNow)} pcs ${check ? 'failed or damaged' : 'damaged'} — decide what happens to them`, tone: 'warn' })
    if (f.inRework) out.push({ text: `${pcs(f.inRework)} pcs in rework`, tone: 'warn' })
    if (f.short) out.push({ text: `${pcs(f.short)} pcs short on a transfer — settle it`, tone: 'warn' })
  }
  if (!out.length) {
    if (f.state === 'DONE') out.push({ text: 'All done here', tone: 'done' })
    else if (r.step.skipped) out.push({ text: 'Left out of this order', tone: 'muted' })
    else if (!f.received && !f.completed) out.push({ text: `Nothing here yet — waiting for ${r.from.join(' / ') || 'cutting'}`, tone: 'muted' })
    else out.push({ text: 'Nothing waiting here now', tone: 'muted' })
  }
  return out
}

export function StageList({ operationId, stage, onOpen, refreshKey }: { operationId: string; stage: Stage; onOpen: (row: StageRow) => void; refreshKey: number }) {
  const { rowsPerPage } = useAppSettings()
  const [rows, setRows] = useState<StageRow[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [show, setShow] = useState('active')
  const [search, setSearch] = useState('')
  const [debounced, setDebounced] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const latest = useRef(0)

  useEffect(() => {
    const t = setTimeout(() => setDebounced(search), 350)
    return () => clearTimeout(t)
  }, [search])
  useEffect(() => setPage(1), [debounced, show, operationId])

  const load = useCallback(async () => {
    const ticket = ++latest.current
    setLoading(true)
    setError(null)
    try {
      const qs = new URLSearchParams({ operationId, page: String(page), limit: String(rowsPerPage), show })
      if (debounced) qs.set('q', debounced)
      const res = await api.get<Paginated<StageRow>>(`/production/stage-sheets?${qs}`)
      if (ticket !== latest.current) return
      setRows(res.data)
      setTotal(res.pagination.total)
    } catch (err) {
      if (ticket === latest.current) setError(err instanceof ApiError ? err.message : 'Could not load this stage.')
    } finally {
      if (ticket === latest.current) setLoading(false)
    }
  }, [operationId, page, rowsPerPage, show, debounced])

  useEffect(() => {
    void load()
  }, [load, refreshKey])

  const cutting = stage === 'CUTTING'
  return (
    <div className="glass-card overflow-hidden p-0">
      <div className="border-border flex flex-wrap items-center gap-2 border-b px-4 py-3">
        <div className="bg-field border-field-edge flex min-w-[200px] max-w-sm flex-1 items-center gap-2 rounded-lg border px-3 py-1.5">
          <Search size={14} className="text-muted-foreground" />
          <input
            className="text-foreground placeholder:text-muted-foreground flex-1 border-0 bg-transparent text-sm outline-none"
            placeholder="Job card, order, design, colour, customer…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            aria-label="Search"
          />
        </div>
        <SmartSelect className="form-input h-8 w-48 py-0 text-xs" value={show} onChange={(e) => setShow(e.target.value)} aria-label="Show">
          <option value="active">Work here now</option>
          <option value="waiting">Not reached here yet</option>
          <option value="done">Finished here</option>
          <option value="all">Everything</option>
        </SmartSelect>
        <span className="text-muted-foreground ml-auto text-xs">
          {total} {total === 1 ? 'job card' : 'job cards'}
        </span>
      </div>

      {error && (
        <div className="border-destructive/40 bg-destructive/5 m-4 flex items-start gap-3 rounded-lg border p-3">
          <AlertCircle size={16} className="text-destructive mt-0.5 shrink-0" />
          <p className="text-destructive text-sm">{error}</p>
        </div>
      )}

      {loading && !rows.length ? (
        <div className="space-y-2 p-4">
          {[0, 1, 2].map((i) => (
            <div key={i} className="skeleton h-20 w-full rounded-lg" />
          ))}
        </div>
      ) : !rows.length ? (
        <p className="text-muted-foreground px-4 py-10 text-center text-sm">
          {show === 'active'
            ? cutting
              ? 'Nothing to cut right now. A job card shows here once its order’s materials are issued and its stages are loaded.'
              : 'No work here right now. Job cards show here when pieces are transferred to this stage.'
            : 'Nothing to show.'}
        </p>
      ) : (
        <div className="divide-border/60 divide-y">
          {rows.map((r) => {
            const f = r.figures
            const waits = whatWaits(r)
            const figures: Array<[string, number]> = cutting
              ? [
                  ['To make', r.card.line.totalQty],
                  ['With cutters', r.withCutters],
                  ['Cut', f.completed],
                  ['Sent on', f.sentOn],
                ]
              : [
                  ['Received', f.received],
                  [r.stage === 'QC' ? 'Passed' : 'Processed', f.completed],
                  ['Sent on', f.sentOn + f.packed],
                  ['Damaged', f.damaged + f.rejected],
                  [r.step.execution === 'OUTSOURCED' ? 'With unit' : 'Here now', r.step.execution === 'OUTSOURCED' ? f.atVendor : f.inHand + f.waiting],
                ]
            return (
              <button key={`${r.card.id}|${r.step.id}`} type="button" onClick={() => onOpen(r)} className="hover:bg-secondary/60 block w-full px-4 py-3 text-left">
                <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
                  <div className="min-w-0 flex-1">
                    <p className="text-foreground text-sm">
                      <span className="text-primary font-mono text-xs">{r.card.jobCardNumber}</span>{' '}
                      <span className="font-semibold">
                        {r.card.line.style.code} · {r.card.line.color}
                      </span>
                      {r.card.designNo ? <span className="text-muted-foreground"> · design {r.card.designNo}</span> : null}
                      {r.card.mo.held && <span className="badge-warning ml-2">On hold</span>}
                    </p>
                    <p className="text-muted-foreground mt-0.5 text-xs">
                      {r.card.mo.moNumber}
                      {r.card.mo.so ? ` · ${r.card.mo.so.customer.name}` : ''} · {pcs(r.card.line.totalQty)} pcs
                      {r.card.mo.due ? ` · due ${formatDate(r.card.mo.due)}` : ''}
                    </p>
                    <p className="text-muted-foreground mt-0.5 flex flex-wrap items-center gap-1 text-[11px]">
                      {r.from.length ? r.from.join(' / ') : 'Start'} <ArrowRight size={10} /> <span className="text-foreground font-medium">{r.step.name}</span> <ArrowRight size={10} />{' '}
                      {r.next?.name ?? 'Finished goods'}
                    </p>
                    <ul className="mt-1.5 space-y-0.5">
                      {waits.map((w) => (
                        <li key={w.text} className={`flex items-center gap-2 text-xs ${w.tone === 'act' ? 'text-foreground font-medium' : w.tone === 'warn' ? 'text-destructive' : 'text-muted-foreground'}`}>
                          <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${DOT[w.tone]}`} aria-hidden />
                          {w.text}
                        </li>
                      ))}
                    </ul>
                  </div>
                  <div className="flex items-center gap-3">
                    <dl className="hidden gap-3 text-right sm:flex">
                      {figures.map(([label, n]) => (
                        <div key={label} className="min-w-[56px]">
                          <dt className="text-muted-foreground text-[10px]">{label}</dt>
                          <dd className={`text-sm font-semibold tabular-nums ${label === 'Damaged' && n ? 'text-destructive' : 'text-foreground'}`}>{n ? pcs(n) : '—'}</dd>
                        </div>
                      ))}
                    </dl>
                    <span className="btn-secondary h-8 px-3 text-xs">
                      Open <ChevronRight size={14} />
                    </span>
                  </div>
                </div>
              </button>
            )
          })}
        </div>
      )}
      <Pagination page={page} pages={Math.ceil(total / rowsPerPage) || 1} onPageChange={setPage} busy={loading} />
    </div>
  )
}
