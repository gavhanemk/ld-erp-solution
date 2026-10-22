'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import {
  AlertCircle,
  ClipboardCheck,
  ClipboardList,
  ExternalLink,
  Gavel,
  Info,
  ListChecks,
  PackageCheck,
  PackageOpen,
  Scale,
  Scissors,
  Send,
  Undo2,
  Wrench,
  type LucideIcon,
} from 'lucide-react'
import { api, ApiError, can, type Paginated } from '@/lib/api'
import { formatDate } from '@/lib/utils'
import { useAppSettings } from '@/lib/appSettings'
import { FormFrame } from '@/components/ui/FormFrame'
import { ReasonDialog } from '@/components/ui/ReasonDialog'
import { Pagination } from '@/components/tables/Pagination'
import { CountInDialog } from './CountInDialog'
import { SettleDialog } from './SettleDialog'
import { SendOnDialog } from './SendOnDialog'
import { SheetView } from './SheetView'
import { RouteStrip } from './RouteStrip'
import type { TransferRow } from './TransferDetailDialog'
import { useJobCard } from './useFlow'
import { isCheck, pcs, type FlowTransfer, type StepFigures } from './types'

/**
 * The board: every open job card with its route drawn as a line of stages —
 * how many pieces sit at each, on their way, or out at a unit — and, under it,
 * what to do next in plain words, each with the one button that does it.
 * The stages run strictly in the route's order, so the next stage is always
 * named; nobody has to work out where pieces go. A stage opens its sheet.
 */

interface BoardStep {
  id: string
  name: string
  kind: string
  isQcStep: boolean
  execution: 'IN_HOUSE' | 'OUTSOURCED'
  department: { id: string; name: string }
  unit: { id: string; name: string } | null
  skipped: boolean
  last: boolean
  next: { id: string; name: string; execution: string } | null
  figures: StepFigures
}

interface Passed {
  id: string
  transferNumber: string
  from: string
  to: string
  toStepId: string
  passed: string[]
  pcs: number
}

export interface BoardCard {
  id: string
  jobCardNumber: string
  designNo: string | null
  line: { id: string; color: string; totalQty: number; style: { code: string; name: string } }
  mo: { id: string; moNumber: string; held: boolean; due: string | null; so: { soNumber: string; customer: { name: string } } | null }
  state: 'NO_STAGES' | 'DONE' | 'IN_PROGRESS' | 'NOT_STARTED'
  withCutters: number
  cut: number
  packed: number
  steps: BoardStep[]
  toCountIn: Array<{ id: string; transferNumber: string; from: string; toStepId: string; pcs: number; dispatchDate: string; issuedBy: string | null }>
  short: Array<{ id: string; transferNumber: string; toStepId: string; pcs: number }>
  passed: Passed[]
}

type Open =
  | { kind: 'sheet'; jobCardId: string; stepId: string | null }
  | { kind: 'send'; jobCardId: string; stepId: string }
  | { kind: 'count'; transfer: TransferRow }
  | { kind: 'settle'; transfer: TransferRow }
  | { kind: 'takeBack'; item: Passed }

interface Todo {
  key: string
  tone: 'act' | 'warn' | 'info'
  text: React.ReactNode
  action?: { label: string; icon: LucideIcon; run: () => void; primary?: boolean }
}

interface Handlers {
  sheet: (stepId: string | null) => void
  send: (stepId: string) => void
  count: (transferId: string) => void
  settle: (transferId: string) => void
  takeBack: (item: Passed) => void
  intoGoods: () => void
}

const todayIso = () => new Date().toISOString().slice(0, 10)

/** Everything waiting on one job card, stage by stage in the route's order, each with its button. */
export function todosOf(c: BoardCard, h: Handlers): Todo[] {
  const mayCreate = can('production', 'create') && !c.mo.held
  const mayEdit = can('production', 'edit') && !c.mo.held
  const out: Todo[] = []
  for (const p of c.passed) {
    out.push({
      key: `passed-${p.id}`,
      tone: 'warn',
      text: (
        <>
          <span className="font-mono text-xs">{p.transferNumber}</span> took {pcs(p.pcs)} pcs from {p.from} straight to {p.to}, past {p.passed.join(', ')}. Take it back to {p.from}, then send the pieces on in order.
        </>
      ),
      action: mayEdit ? { label: 'Take back', icon: Undo2, run: () => h.takeBack(p) } : undefined,
    })
  }
  // Pieces that reached a stage past others wait there until their card is taken back.
  const wrongPlace = new Set(c.passed.map((p) => p.toStepId))
  for (const s of c.steps) {
    if (s.skipped) continue
    const f = s.figures
    const to = s.next ? `${s.next.name}${s.next.execution === 'OUTSOURCED' ? ' (outside unit)' : ''}` : ''
    const send = (n: number, what: string) =>
      !wrongPlace.has(s.id) &&
      out.push(
        s.last
          ? { key: `fg-${s.id}`, tone: 'act', text: `Put ${pcs(n)} ${what} pcs from ${s.name} into finished goods`, action: mayCreate ? { label: 'Into finished goods', icon: PackageCheck, primary: true, run: h.intoGoods } : undefined }
          : { key: `send-${s.id}`, tone: 'act', text: `Send ${pcs(n)} ${what} pcs from ${s.name} to ${to}`, action: mayCreate && s.next ? { label: `Send to ${s.next.name}`, icon: Send, primary: true, run: () => h.send(s.id) } : undefined },
      )
    for (const t of c.short.filter((x) => x.toStepId === s.id)) {
      out.push({
        key: `short-${t.id}`,
        tone: 'warn',
        text: (
          <>
            {pcs(t.pcs)} pcs short on <span className="font-mono text-xs">{t.transferNumber}</span> at {s.name} — say where they went
          </>
        ),
        action: mayEdit ? { label: 'Settle short', icon: Scale, run: () => h.settle(t.id) } : undefined,
      })
    }
    for (const t of c.toCountIn.filter((x) => x.toStepId === s.id)) {
      out.push({
        key: `count-${t.id}`,
        tone: 'act',
        text: (
          <>
            Count in {pcs(t.pcs)} pcs at {s.name} — <span className="font-mono text-xs">{t.transferNumber}</span> from {t.from}
            <span className="text-muted-foreground">, sent {formatDate(t.dispatchDate)}{t.issuedBy ? ` by ${t.issuedBy}` : ''}</span>
          </>
        ),
        action: mayCreate ? { label: 'Count in', icon: ClipboardCheck, primary: true, run: () => h.count(t.id) } : undefined,
      })
    }
    if (s.kind === 'CUTTING') {
      if (c.withCutters) out.push({ key: `cutters-${s.id}`, tone: 'info', text: `${pcs(c.withCutters)} pcs with cutting contractors — receive them when cut`, action: { label: 'Cutting sheet', icon: Scissors, run: () => h.sheet(s.id) } })
      const left = Math.max(0, c.line.totalQty - c.cut - c.withCutters)
      if (left && f.state !== 'DONE') out.push({ key: `issue-${s.id}`, tone: 'info', text: `${pcs(left)} pcs still to issue for cutting`, action: { label: 'Cutting sheet', icon: Scissors, run: () => h.sheet(s.id) } })
      if (f.waiting) send(f.waiting, 'cut')
    } else if (s.execution === 'OUTSOURCED') {
      if (f.atVendor) out.push({ key: `unit-${s.id}`, tone: 'info', text: `${pcs(f.atVendor)} pcs at ${s.unit?.name ?? 'the outside unit'} for ${s.name} — record them when they come back`, action: { label: `${s.name} sheet`, icon: PackageOpen, run: () => h.sheet(s.id) } })
      if (f.waiting) send(f.waiting, 'returned')
    } else if (isCheck(s)) {
      if (f.inHand) out.push({ key: `check-${s.id}`, tone: 'act', text: `Check ${pcs(f.inHand)} pcs at ${s.name}`, action: { label: 'Record the check', icon: ClipboardList, run: () => h.sheet(s.id) } })
      if (f.waiting) send(f.waiting, 'passed')
    } else if (f.inHand + f.waiting) {
      send(f.inHand + f.waiting, 'worked')
    }
    if (f.damagedNow + f.rejectedNow) {
      out.push({ key: `decide-${s.id}`, tone: 'warn', text: `${pcs(f.damagedNow + f.rejectedNow)} pcs ${isCheck(s) ? 'failed or damaged' : 'damaged'} at ${s.name} — decide: rework, B-grade or write off`, action: { label: 'Decide', icon: Gavel, run: () => h.sheet(s.id) } })
    }
    if (f.inRework) out.push({ key: `rework-${s.id}`, tone: 'info', text: `${pcs(f.inRework)} pcs in rework at ${s.name} — mark them when put right`, action: { label: 'Rework done', icon: Wrench, run: () => h.sheet(s.id) } })
  }
  return out
}

/** One job card on the board: who it is for, its route, and what to do next. */
function BoardRow({ c, h }: { c: BoardCard; h: Handlers }) {
  const todos = todosOf(c, h)
  const late = !!c.mo.due && c.mo.due.slice(0, 10) < todayIso() && c.state !== 'DONE'
  const idle =
    c.state === 'DONE'
      ? 'All through: every piece has been packed or settled.'
      : c.steps.some((s) => s.figures.inTransit + s.figures.atVendor > 0)
        ? 'Nothing to do here right now — pieces are on their way to the next stage.'
        : 'Nothing waiting right now.'
  return (
    <div className="glass-card space-y-3 p-3 sm:p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="text-foreground font-mono text-sm font-semibold">{c.jobCardNumber}</span>
            <span className="text-foreground text-sm font-medium">
              {c.line.style.code} · {c.line.color} · {pcs(c.line.totalQty)} pcs
            </span>
            {c.mo.held && <span className="badge-warning">On hold</span>}
            {late && <span className="badge-danger">Late</span>}
            {c.state === 'DONE' && <span className="badge-success">All through</span>}
          </p>
          <p className="text-muted-foreground mt-0.5 text-xs">
            {c.mo.moNumber}
            {c.mo.so ? ` · ${c.mo.so.soNumber} · ${c.mo.so.customer.name}` : ''}
            {c.mo.due ? ` · due ${formatDate(c.mo.due)}` : ''} · cut {pcs(c.cut)} · packed {pcs(c.packed)} of {pcs(c.line.totalQty)}
          </p>
        </div>
        <button type="button" className="btn-secondary h-8 px-3 text-xs" onClick={() => h.sheet(null)}>
          <ExternalLink size={14} /> Open sheets
        </button>
      </div>

      <RouteStrip steps={c.steps} onPick={(id) => h.sheet(id)} withCutters={c.withCutters} label={`${c.jobCardNumber} route`} />

      <div className="border-primary/30 bg-primary/5 rounded-lg border p-2.5">
        <p className="text-primary mb-1.5 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide">
          <ListChecks size={13} /> Next to do
        </p>
        {c.mo.held && <p className="warn-text mb-1.5 text-sm">{c.mo.moNumber} is on hold: nothing can be recorded until it is resumed.</p>}
        {!todos.length ? (
          <p className="text-muted-foreground text-sm">{idle}</p>
        ) : (
          <ul className="space-y-1.5">
            {todos.map((t) => (
              <li key={t.key} className="flex flex-wrap items-center justify-between gap-2">
                <span className={`flex min-w-0 items-start gap-2 text-sm ${t.tone === 'warn' ? 'text-destructive' : t.tone === 'info' ? 'text-muted-foreground' : 'text-foreground'}`}>
                  <span className={`mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full ${t.tone === 'warn' ? 'bg-destructive' : t.tone === 'info' ? 'bg-muted-foreground/50' : 'bg-primary'}`} aria-hidden />
                  <span className="min-w-0">{t.text}</span>
                </span>
                {t.action && (
                  <button type="button" className={`${t.action.primary ? 'btn-primary' : 'btn-secondary'} h-8 px-3 text-xs`} onClick={t.action.run}>
                    <t.action.icon size={14} /> {t.action.label}
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}

/** The transfer form for one stage of a job card, once the job card is loaded. */
function SendLauncher({ jobCardId, stepId, onClose, onSaved }: { jobCardId: string; stepId: string; onClose: () => void; onSaved: (message: string, transferId: string) => void }) {
  const { detail, error } = useJobCard(jobCardId)
  if (detail) return <SendOnDialog flow={detail} fromStepId={stepId} onClose={onClose} onSaved={onSaved} />
  return (
    <FormFrame
      icon={Send}
      title="Process transfer"
      primary={
        <button type="button" className="btn-primary" disabled>
          <Send size={15} /> Send
        </button>
      }
      footer={
        <button type="button" className="btn-secondary" onClick={onClose}>
          Cancel
        </button>
      }
      error={error}
      onClose={onClose}
      width="max-w-4xl"
    >
      <div className="skeleton h-40 w-full rounded-xl" />
    </FormFrame>
  )
}

export function BoardView({ search, refreshKey, onSaved }: { search: string; refreshKey: number; onSaved: (message: string) => void }) {
  const { rowsPerPage } = useAppSettings()
  const [rows, setRows] = useState<BoardCard[] | null>(null)
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [showDone, setShowDone] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [open, setOpen] = useState<Open | null>(null)
  const [busy, setBusy] = useState(false)
  const latest = useRef(0)

  useEffect(() => setPage(1), [search, showDone])

  const load = useCallback(async () => {
    const ticket = ++latest.current
    setLoading(true)
    try {
      const qs = new URLSearchParams({ page: String(page), limit: String(rowsPerPage), show: showDone ? 'all' : 'open' })
      if (search) qs.set('q', search)
      const res = await api.get<Paginated<BoardCard>>(`/production/board?${qs}`)
      if (ticket !== latest.current) return
      setRows(res.data)
      setTotal(res.pagination.total)
      setError(null)
    } catch (err) {
      if (ticket === latest.current) setError(err instanceof ApiError ? err.message : 'Could not load the job cards.')
    } finally {
      if (ticket === latest.current) setLoading(false)
    }
  }, [page, rowsPerPage, search, showDone])

  useEffect(() => {
    void load()
  }, [load, refreshKey])

  const saved = (message: string) => {
    setOpen(null)
    onSaved(message)
    void load()
  }
  const withTransfer = async (id: string, kind: 'count' | 'settle') => {
    try {
      const res = await api.get<{ data: TransferRow }>(`/production/transfers/${id}`)
      setOpen({ kind, transfer: res.data })
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not open that transfer.')
    }
  }
  const takeBack = async (item: Passed, reason: string) => {
    setBusy(true)
    try {
      const res = await api.post<{ message?: string }>(`/production/transfers/${item.id}/cancel`, { reason })
      saved(res.message ?? 'Taken back.')
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not take it back.')
      setOpen(null)
    } finally {
      setBusy(false)
    }
  }

  const handlers = (c: BoardCard): Handlers => ({
    sheet: (stepId) => setOpen({ kind: 'sheet', jobCardId: c.id, stepId }),
    send: (stepId) => setOpen({ kind: 'send', jobCardId: c.id, stepId }),
    count: (id) => void withTransfer(id, 'count'),
    settle: (id) => void withTransfer(id, 'settle'),
    takeBack: (item) => setOpen({ kind: 'takeBack', item }),
    intoGoods: () => window.location.assign(`/inventory/finished-goods?mo=${c.mo.id}`),
  })

  return (
    <div className="space-y-3 p-3 sm:p-4">
      {error && (
        <div className="border-destructive/40 bg-destructive/5 flex items-start gap-3 rounded-lg border p-3">
          <AlertCircle size={16} className="text-destructive mt-0.5 shrink-0" />
          <p className="text-destructive text-sm">{error}</p>
        </div>
      )}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-muted-foreground flex items-start gap-1.5 text-xs">
          <Info size={13} className="mt-px shrink-0" aria-hidden />
          Each job card&apos;s stages in the route&apos;s order. Pieces always go to the next stage; click a stage to open its sheet.
        </p>
        <label className="text-muted-foreground flex items-center gap-2 text-xs">
          <input type="checkbox" className="accent-primary" checked={showDone} onChange={(e) => setShowDone(e.target.checked)} />
          Show finished job cards too
        </label>
      </div>

      {loading && !rows ? (
        <div className="space-y-3">
          {[0, 1].map((i) => (
            <div key={i} className="skeleton h-40 w-full rounded-xl" />
          ))}
        </div>
      ) : !rows?.length ? (
        <p className="text-muted-foreground px-4 py-10 text-center text-sm">
          {search ? 'No job card matches that search.' : 'No job card is in production. Once an order’s stages are loaded, its job cards show here with their route.'}
        </p>
      ) : (
        rows.map((c) => <BoardRow key={c.id} c={c} h={handlers(c)} />)
      )}
      {total > rowsPerPage && <Pagination page={page} pages={Math.ceil(total / rowsPerPage) || 1} onPageChange={setPage} busy={loading} />}

      {open?.kind === 'sheet' && (
        <SheetView
          jobCardId={open.jobCardId}
          stepId={open.stepId}
          onClose={() => {
            setOpen(null)
            void load()
          }}
          onChanged={(m) => m && onSaved(m)}
        />
      )}
      {open?.kind === 'send' && (
        <SendLauncher
          jobCardId={open.jobCardId}
          stepId={open.stepId}
          onClose={() => setOpen(null)}
          onSaved={(m, transferId) => {
            saved(m)
            if (transferId) window.open(`/print/transfer/${transferId}`, '_blank', 'noopener')
          }}
        />
      )}
      {open?.kind === 'count' && <CountInDialog transfer={open.transfer as unknown as FlowTransfer} moNumber={open.transfer.mo.moNumber} onClose={() => setOpen(null)} onSaved={saved} />}
      {open?.kind === 'settle' && <SettleDialog transfer={open.transfer as unknown as FlowTransfer} onClose={() => setOpen(null)} onSaved={saved} />}
      {open?.kind === 'takeBack' && (
        <ReasonDialog
          title={`Take back ${open.item.transferNumber}?`}
          description={`The ${pcs(open.item.pcs)} pcs go back to ${open.item.from}, as if never sent. From there, send them on to the next stage in order. Refused if ${open.item.to} has already worked on them.`}
          confirmLabel="Take it back"
          danger
          busy={busy}
          onCancel={() => setOpen(null)}
          onConfirm={(reason) => void takeBack(open.item, reason)}
        />
      )}
    </div>
  )
}
