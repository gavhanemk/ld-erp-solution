'use client'

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import {
  AlertCircle,
  ArrowLeft,
  ArrowRight,
  ArrowUpRight,
  Ban,
  BarChart3,
  Box,
  CheckCircle2,
  ChevronRight,
  CircleCheck,
  ClipboardList,
  Clock,
  Copy,
  Factory,
  Info,
  Layers,
  ListChecks,
  ListOrdered,
  Loader2,
  Lock,
  MapPin,
  MessageSquare,
  Pencil,
  Plus,
  Route,
  Shirt,
  Trash2,
  X,
} from 'lucide-react'
import { api, ApiError, can } from '@/lib/api'
import { cn } from '@/lib/utils'
import { RoutingFormDialog, type Routing } from '@/components/masters/RoutingFormDialog'
import { ActionMenu, type RowAction } from '@/components/tables/ActionMenu'
import { moStatus } from '@/components/production/status'
import { changed, describe, pcs, STEP_STATE, STYLE_STATE, when, type StepState, type StyleDetail, type TrackStep } from './track'

/** One order of the style on its own, as GET /masters/style-orders/:styleId gives it. */
interface StageOrder {
  lineId: string
  moId: string
  moNumber: string
  status: string
  color: string
  planned: number
  staged: boolean
  finished: boolean
  counted: boolean
  done: number
  total: number
  at: { key: string; name: string; completed: number; state: StepState } | null
  steps: Array<{
    key: string
    name: string
    kind: string
    isQcStep: boolean
    execution: 'IN_HOUSE' | 'OUTSOURCED'
    department: string | null
    workstation: string | null
    ratePerPiece: number | null
    state: StepState
    completed: number
  }>
}

/** A step as the list shows it, for all the orders together or for one. */
interface ViewStep {
  key: string
  name: string
  again: boolean
  department: string | null
  workstation: string | null
  execution: 'IN_HOUSE' | 'OUTSOURCED'
  isQcStep: boolean
  optional: boolean
  ratePerPiece: number | null
  instructions: string | null
  state: StepState
  completed: number
  note: string | null
  noteAt: string | null
  /** The style's own step, for its note: only while all orders are shown. */
  track: TrackStep | null
}

/**
 * One style's page under Masters → Routings: the routing it follows — its
 * fabric, who changed it last, to edit or delete — and each step with where
 * it stands and the pieces completed there, beside the style's orders. Both
 * come from the floor's own records, across every order for the style;
 * nothing here is pressed or typed but a note on a step.
 *
 * Laid out to be read at a glance: who the style is and where it stands at
 * the top, four figures under it, then the steps — one compact row each, with
 * its line or outside unit, rate, pieces through it and state — and the
 * orders side by side on a wide screen.
 *
 * The figures are every order of the style together until an order is
 * picked: then the steps and figures are that order's alone, on the route it
 * was planned with, and each order's row says where it is.
 *
 * Until 15 Oct 2026 each step had a Start and a Stop pressed by hand, and a
 * timer; the business took them off.
 */
export function StyleTracker({ styleId }: { styleId: string }) {
  const [d, setD] = useState<StyleDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [busyKey, setBusyKey] = useState<string | null>(null)
  const [noteFor, setNoteFor] = useState<string | null>(null)
  const [noteText, setNoteText] = useState('')
  const [form, setForm] = useState<{ record: Routing | null; preset: { styleId: string; from: Routing | null } | null } | null>(null)
  const [deleting, setDeleting] = useState(false)
  /** Each order on its own; null until read, or when it could not be. */
  const [orders, setOrders] = useState<StageOrder[] | null>(null)
  /** The order line picked to be shown alone. */
  const [focus, setFocus] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const [res, per] = await Promise.all([
        api.get<{ data: StyleDetail }>(`/masters/style-tracking/${styleId}`),
        // The page stands without it: then the orders show as before, all together.
        api.get<{ data: StageOrder[] }>(`/masters/style-orders/${styleId}`).catch(() => null),
      ])
      setD(res.data)
      setOrders(per?.data ?? null)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not reach the server. Is the API running?')
    } finally {
      setLoading(false)
    }
  }, [styleId])

  useEffect(() => {
    void load()
  }, [load])

  const canNote = can('production', 'create')
  const canEditRouting = can('masters', 'edit')
  const canNewRouting = can('masters', 'create')
  const canDeleteRouting = can('masters', 'delete')

  const saveNote = async (s: TrackStep) => {
    setBusyKey(s.key)
    setError(null)
    try {
      const res = await api.patch<{ message?: string; data: StyleDetail }>(`/masters/style-tracking/${styleId}/steps/${s.operationId}/${s.occurrence}/note`, { note: noteText.trim() || null })
      setD(res.data)
      setMessage(res.message ?? null)
      setNoteFor(null)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save the note.')
      // The routing may have changed under us: show it as it is now.
      if (err instanceof ApiError && err.status === 404) void load()
    } finally {
      setBusyKey(null)
    }
  }

  const deleteRouting = async (r: Routing) => {
    if (!confirm(`Delete "${r.name}" for good? Its steps go with it. This cannot be undone.`)) return
    setDeleting(true)
    setError(null)
    setMessage(null)
    try {
      const res = await api.delete<{ message?: string }>(`/masters/routings/${r.id}`)
      setMessage(res.message ?? 'Deleted.')
      await load()
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not delete it. Is the API running?')
    } finally {
      setDeleting(false)
    }
  }

  if (loading && !d) {
    return (
      <div className="space-y-4">
        <div className="skeleton h-36 w-full rounded-xl" />
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="skeleton h-24 rounded-xl" />
          ))}
        </div>
        <div className="skeleton h-72 w-full rounded-xl" />
      </div>
    )
  }

  if (!d) {
    return (
      <div className="space-y-4">
        <Link href="/masters/routings" className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1 text-xs">
          <ArrowLeft size={13} /> Routings
        </Link>
        <div className="border-destructive/40 bg-destructive/5 flex items-start gap-3 rounded-lg border p-3">
          <AlertCircle size={16} className="text-destructive mt-0.5 shrink-0" />
          <p className="text-destructive text-sm">{error ?? 'This style could not be found.'}</p>
        </div>
      </div>
    )
  }

  const look = STYLE_STATE[d.overall.state]
  const planned = d.production.planned
  const routing = d.routing
  const ownRouting = routing && d.applies === 'STYLE'
  const usedBy = routing ? (routing._count?.mos ?? 0) + (routing._count?.boms ?? 0) : 0
  const stamp = routing ? changed(routing) : null
  // The step the style is at: the first not yet done. Its number is filled in.
  const current = d.steps.find((s) => s.state !== 'DONE' && s.state !== 'SKIPPED')
  // Colours with orders running stand out among the style's colours.
  const ordered = new Set(d.production.orders.filter((o) => o.status !== 'CLOSED').map((o) => o.color))
  const appliesNote =
    d.applies === 'STYLE'
      ? d.alternatives > 0
        ? `Its own routing. ${d.alternatives} more ${d.alternatives === 1 ? 'is' : 'are'} for this style; this page follows the one changed most recently.`
        : 'Its own routing.'
      : d.applies === 'CATEGORY'
        ? `Shared by every ${routing?.category} style — it has none of its own.`
        : 'Shared by any style without one of its own — it has none of its own.'

  // One order picked: the page reads for it alone, on its own route.
  const fo = focus && orders ? (orders.find((o) => o.lineId === focus) ?? null) : null
  const countedOrders = (orders ?? []).filter((o) => o.counted)
  const fromTrack = (s: TrackStep): ViewStep => ({
    key: s.key,
    name: s.name,
    again: s.occurrence > 1,
    department: s.department?.name ?? null,
    workstation: s.workstation?.name ?? null,
    execution: s.execution,
    isQcStep: s.isQcStep,
    optional: s.skip === 'OPTIONAL',
    ratePerPiece: s.ratePerPiece == null ? null : Number(s.ratePerPiece),
    instructions: s.instructions,
    state: s.state,
    completed: s.completed,
    note: s.note,
    noteAt: s.noteAt,
    track: s,
  })
  const viewSteps: ViewStep[] = !fo
    ? d.steps.map(fromTrack)
    : fo.staged
      ? fo.steps.map((s) => ({ ...s, again: !s.key.endsWith('#1'), optional: false, instructions: null, note: null, noteAt: null, track: null }))
      : d.steps.map((s) => ({ ...fromTrack(s), state: (fo.finished ? 'DONE' : 'NOT_STARTED') as StepState, completed: 0, note: null, noteAt: null, track: null }))
  // The order's own route against the routing as it is now: it may have been planned before a change.
  const routeDiffers = !!fo && fo.staged && fo.steps.map((s) => s.key).join('|') !== d.steps.map((s) => s.key).join('|')
  const viewLive = viewSteps.filter((s) => s.state !== 'SKIPPED')
  const viewDone = fo ? viewLive.filter((s) => s.state === 'DONE').length : d.overall.done
  const viewTotal = fo ? viewLive.length : d.overall.total
  // All orders together: how many are not yet through the step the style is at.
  const behind = current
    ? countedOrders.filter((o) => {
        if (o.finished) return false
        if (!o.staged) return true
        const here = o.steps.find((x) => x.key === current.key)
        return !!here && here.state !== 'DONE' && here.state !== 'SKIPPED'
      }).length
    : 0
  const view = {
    steps: viewSteps,
    current: viewSteps.find((s) => s.state !== 'DONE' && s.state !== 'SKIPPED') ?? null,
    planned: fo ? fo.planned : planned,
    done: viewDone,
    total: viewTotal,
    pct: viewTotal ? Math.round((viewDone / viewTotal) * 100) : 0,
    last: viewLive[viewLive.length - 1] ?? null,
    atLabel: fo ? 'This order is at' : 'Earliest open step',
    atValue: fo
      ? fo.finished
        ? 'All steps done'
        : !fo.staged
          ? 'Not started'
          : (fo.at?.name ?? 'All steps done')
      : d.overall.state === 'DONE'
        ? 'All done'
        : (d.overall.step ?? '—'),
    atSub: fo
      ? fo.finished
        ? 'Completed'
        : !fo.staged
          ? 'Its stages are not loaded yet'
          : fo.at
            ? `${pcs(fo.at.completed)} of ${pcs(fo.planned)} pcs through it`
            : 'Every step done'
      : d.overall.state === 'IN_PROGRESS'
        ? orders
          ? `${behind} of ${countedOrders.length} ${countedOrders.length === 1 ? 'order is' : 'orders are'} not through it yet`
          : 'The first step not every order is through'
        : describe(d.overall),
  }

  // The orders table: one row an order line, with where it is when that is known.
  const rows = orders
    ? orders.map((o) => ({ key: o.lineId, moId: o.moId, moNumber: o.moNumber, status: o.status, color: o.color, planned: o.planned, staged: o.staged, order: o as StageOrder | null }))
    : d.production.orders.map((o, i) => ({ key: `${o.moId}-${o.color}-${i}`, moId: o.moId, moNumber: o.moNumber, status: o.status, color: o.color, planned: o.planned, staged: o.staged, order: null as StageOrder | null }))
  const whereIs = (r: (typeof rows)[number]) => {
    const o = r.order
    if (!o) return r.staged ? 'Loaded' : <span className="text-muted-foreground">Not loaded yet</span>
    if (o.finished || (o.staged && !o.at)) {
      return (
        <span className="inline-flex items-center gap-1 text-emerald-500">
          <CheckCircle2 size={12} /> {o.staged ? 'All steps done' : 'Completed, steps not recorded'}
        </span>
      )
    }
    if (!o.staged || !o.at) return <span className="text-muted-foreground">Not started · stages not loaded</span>
    const share = o.planned ? Math.min(100, Math.round((o.at.completed / o.planned) * 100)) : 0
    return (
      <div>
        <div className="flex items-baseline justify-between gap-2">
          <span className="text-foreground font-medium">At {o.at.name}</span>
          <span className="text-muted-foreground font-mono text-[10px] tabular-nums">
            {pcs(o.at.completed)}/{pcs(o.planned)}
          </span>
        </div>
        <div className="bg-secondary mt-1 h-1 w-full overflow-hidden rounded-full" aria-hidden>
          <div className="bg-primary h-full rounded-full" style={{ width: `${share}%` }} />
        </div>
      </div>
    )
  }
  /** Picks an order to show alone, or back to all of them; on a narrow screen, up to its steps. */
  const pick = (key: string) => {
    if (!orders) return
    const next = focus === key ? null : key
    setFocus(next)
    setNoteFor(null)
    if (next && window.innerWidth < 1536) document.getElementById('style-steps')?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }

  // What the ⋯ beside Edit holds: a copy to start another routing from, and the screens around this one.
  const more: RowAction[] = [
    ...(routing && canNewRouting
      ? [{ key: 'copy', label: ownRouting ? 'Copy as a new routing' : 'Make it its own routing', icon: <Copy size={14} />, onClick: () => setForm({ record: null, preset: { styleId: d.style.id, from: routing } }) }]
      : []),
    { key: 'all', label: 'All routings', icon: <ListOrdered size={14} />, href: '/masters/routings' },
    { key: 'mos', label: 'Manufacturing orders', icon: <Factory size={14} />, href: '/production/orders' },
  ]

  const figure = (icon: React.ReactNode, label: string, value: React.ReactNode, sub: React.ReactNode) => (
    <div className="glass-card flex gap-3 p-4">
      <div className="text-primary mt-0.5 shrink-0">{icon}</div>
      <div className="min-w-0 flex-1">
        <p className="text-foreground text-sm font-medium">{label}</p>
        <div className="text-foreground mt-1 text-2xl font-semibold tabular-nums">{value}</div>
        <div className="text-muted-foreground mt-0.5 text-sm">{sub}</div>
      </div>
    </div>
  )

  return (
    <div className="space-y-4">
      <nav className="text-muted-foreground flex items-center gap-1 text-xs" aria-label="Breadcrumb">
        <Link href="/masters/routings" className="hover:text-foreground inline-flex items-center gap-1">
          <ArrowLeft size={13} /> Routings
        </Link>
        <ChevronRight size={12} aria-hidden />
        <span className="text-foreground font-mono font-semibold">{d.style.code}</span>
      </nav>

      {/* Who the style is, where it stands, and the routing it follows. */}
      <div className="glass-card p-4 sm:p-5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="flex min-w-0 items-start gap-4">
            <div className="bg-primary/10 border-primary/20 flex h-14 w-14 shrink-0 items-center justify-center rounded-2xl border">
              <Shirt size={26} className="text-primary" />
            </div>
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
                <h1 className="text-foreground text-xl font-semibold tracking-tight sm:text-2xl">
                  <span className="text-primary font-mono">{d.style.code}</span> {d.style.name}
                </h1>
                {d.style.colors.length > 0 && (
                  <div className="flex flex-wrap gap-1.5">
                    {d.style.colors.map((c) => (
                      <span key={c} className={ordered.has(c) ? 'badge-info' : 'badge-neutral'} title={ordered.has(c) ? 'Has orders' : undefined}>
                        {c}
                      </span>
                    ))}
                  </div>
                )}
              </div>
              <p className="text-muted-foreground mt-1 text-sm">
                {[d.style.category, d.style.season, d.style.sizeGroup ? `sizes ${d.style.sizeGroup.name}` : null].filter(Boolean).join(' • ') || 'No category set'}
                {!d.style.isActive && ' • no longer in use'}
              </p>
            </div>
          </div>
          <div className="flex flex-col items-end gap-1.5">
            <span className={cn(look.badge, 'inline-flex items-center gap-1.5 px-3 py-1')}>
              <span className={cn('h-2 w-2 rounded-full', look.dot)} aria-hidden />
              {look.label}
            </span>
            <p className="text-foreground flex items-center gap-1.5 text-sm">
              <BarChart3 size={14} className="text-muted-foreground" aria-hidden />
              {d.overall.state === 'IN_PROGRESS' ? `All orders: earliest open step ${d.overall.step}` : describe(d.overall)}
            </p>
          </div>
        </div>

        <div className="border-border mt-4 flex flex-wrap items-center justify-between gap-3 border-t pt-3">
          {routing ? (
            <div className="text-muted-foreground flex min-w-0 flex-wrap items-center gap-x-4 gap-y-1 text-xs">
              <span className="text-foreground inline-flex items-center gap-1.5 font-semibold">
                <Route size={14} className="text-primary shrink-0" /> {routing.name}
              </span>
              <span className="inline-flex items-center gap-1.5">
                <ListOrdered size={13} className="shrink-0" aria-hidden />
                Version {routing.version} • {routing.steps?.length ?? 0} steps
              </span>
              <span className="inline-flex items-center gap-1.5">
                <Layers size={13} className="shrink-0" aria-hidden />
                {routing.fabric ? <span className="text-foreground">{routing.fabric.name}</span> : 'No fabric set'}
              </span>
              {stamp && (
                <span className="inline-flex items-center gap-1.5">
                  <Clock size={13} className="shrink-0" aria-hidden /> {stamp}
                </span>
              )}
              {routing.isLocked && (
                <span className="inline-flex items-center gap-1.5">
                  <Lock size={13} className="shrink-0" aria-hidden /> Locked
                </span>
              )}
              <span className="inline-flex items-center gap-1.5">
                <Info size={13} className="shrink-0" aria-hidden /> {appliesNote}
              </span>
            </div>
          ) : (
            <p className="warn-text text-xs">No routing yet. Make one: cutting first, then each process in order, to the last check.</p>
          )}
          <div className="flex flex-wrap items-center gap-2">
            {ownRouting && canEditRouting && (
              <button className="btn-secondary h-8 px-3 text-xs" onClick={() => setForm({ record: routing, preset: null })}>
                <Pencil size={13} /> Edit routing
              </button>
            )}
            {!ownRouting && canNewRouting && (
              <button className="btn-primary h-8 px-3 text-xs" onClick={() => setForm({ record: null, preset: { styleId: d.style.id, from: routing } })}>
                {routing ? <Copy size={13} /> : <Plus size={13} />} {routing ? 'Make it its own routing' : 'Make its routing'}
              </button>
            )}
            <ActionMenu label="More for this routing" items={more} compact />
            {ownRouting && canDeleteRouting && (
              <button
                className="border-destructive/40 bg-destructive/5 text-destructive hover:bg-destructive/10 inline-flex h-8 items-center gap-1.5 rounded-lg border px-3 text-xs font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-40"
                onClick={() => void deleteRouting(routing)}
                disabled={deleting || usedBy > 0 || routing.isLocked}
                title={usedBy > 0 ? 'Orders or BOMs use it, so it is kept. Stop using it under All routings instead.' : routing.isLocked ? 'Unlock it first' : 'Delete for good'}
              >
                {deleting ? <Loader2 size={13} className="animate-spin" /> : <Trash2 size={13} />} Delete
              </button>
            )}
          </div>
        </div>
      </div>

      {error && (
        <div className="border-destructive/40 bg-destructive/5 flex items-start gap-3 rounded-lg border p-3">
          <AlertCircle size={16} className="text-destructive mt-0.5 shrink-0" />
          <p className="text-destructive text-sm">{error}</p>
        </div>
      )}
      {message && (
        <div className="border-primary/40 bg-primary/5 rounded-lg border p-3">
          <p className="text-primary text-sm">{message}</p>
        </div>
      )}

      {routing && (
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          {figure(
            <ListChecks size={22} />,
            fo ? 'Steps done — this order' : 'Steps done — all orders',
            <>
              {view.done} <span className="text-muted-foreground text-base font-normal">of {view.total}</span>
            </>,
            <div className="mt-1.5 flex items-center gap-2">
              <div className="bg-secondary h-1.5 flex-1 overflow-hidden rounded-full" aria-hidden>
                <div className="bg-primary h-full rounded-full" style={{ width: `${view.pct}%` }} />
              </div>
              <span className="text-xs tabular-nums">{view.pct}%</span>
            </div>,
          )}
          {figure(<MapPin size={22} />, view.atLabel, view.atValue, view.atSub)}
          {figure(<Box size={22} />, fo ? 'Units on this order' : 'Units planned', pcs(view.planned), fo ? `${fo.moNumber} · ${fo.color}` : `${countedOrders.length || d.production.orders.length} order ${(countedOrders.length || d.production.orders.length) === 1 ? 'line' : 'lines'}`)}
          {figure(<CircleCheck size={22} />, 'Through the last step', view.last ? pcs(view.last.completed) : '—', view.last ? `completed at ${view.last.name}` : 'No steps yet')}
        </div>
      )}

      <div className={cn('grid gap-4', routing && '2xl:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)]')}>
        {routing && (
          <section id="style-steps" className="glass-card min-w-0 scroll-mt-4 p-4" aria-label="Steps">
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
              <h2 className="text-foreground flex items-center gap-2 text-lg font-semibold">
                <ListOrdered size={18} className="text-primary" /> Steps
              </h2>
              {fo ? (
                <span className="border-primary/40 bg-primary/5 text-foreground inline-flex items-center gap-2 rounded-full border py-0.5 pl-3 pr-1 text-xs">
                  Showing <span className="font-mono font-semibold">{fo.moNumber}</span> alone · {pcs(fo.planned)} pcs
                  <button type="button" className="btn-ghost h-6 px-2 text-xs" onClick={() => setFocus(null)}>
                    <X size={12} /> All orders
                  </button>
                </span>
              ) : (
                <span className="text-muted-foreground text-xs">
                  All {countedOrders.length || d.production.orders.length} orders together · {pcs(planned)} pcs. Pick an order to see it alone.
                </span>
              )}
            </div>
            {fo && !fo.staged && (
              <p className="text-muted-foreground mb-2 text-xs">
                {fo.finished
                  ? `${fo.moNumber} was completed without its stages being loaded, so the floor recorded nothing step by step for it.`
                  : `${fo.moNumber}'s stages are not loaded yet, so nothing has been recorded on the floor for it.`}
              </p>
            )}
            {fo && fo.staged && routeDiffers && (
              <p className="text-muted-foreground mb-2 text-xs">
                This order keeps the route it was planned with, so its steps differ from the routing as it is now.
              </p>
            )}
            <ol className="space-y-2">
              {view.steps.map((s, i) => {
                const st = STEP_STATE[s.state]
                const busy = !!s.track && busyKey === s.key
                const share = view.planned ? Math.min(100, Math.round((s.completed / view.planned) * 100)) : 0
                const isCurrent = view.current?.key === s.key
                return (
                  <li key={s.key} className={cn('border-border bg-card rounded-xl border px-3 py-2.5', s.state === 'SKIPPED' && 'opacity-75')}>
                    <div className="grid grid-cols-[2.25rem_minmax(0,1fr)_auto] items-center gap-x-3 gap-y-2 sm:grid-cols-[2.25rem_minmax(0,1.3fr)_4.5rem_minmax(7rem,1fr)_auto]">
                      <span
                        className={cn(
                          'flex h-8 w-8 items-center justify-center rounded-full border-2 text-sm font-semibold',
                          s.state === 'DONE'
                            ? 'border-emerald-500 bg-emerald-500/10 text-emerald-500'
                            : isCurrent
                              ? 'border-primary bg-primary text-primary-foreground'
                              : s.state === 'SKIPPED'
                                ? 'border-border text-muted-foreground border-dashed'
                                : 'border-border text-muted-foreground',
                        )}
                        aria-hidden
                      >
                        {s.state === 'DONE' ? <CheckCircle2 size={16} /> : s.state === 'SKIPPED' ? <Ban size={14} /> : i + 1}
                      </span>

                      <div className="min-w-0">
                        <p className="text-foreground truncate text-sm font-semibold" title={s.instructions ? `Instructions: ${s.instructions}` : undefined}>
                          {s.name}
                          {s.again && <span className="text-muted-foreground font-normal"> (again)</span>}
                          {s.instructions && <Info size={12} className="text-muted-foreground ml-1 inline" aria-label="has instructions" />}
                        </p>
                        <p className="text-muted-foreground mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
                          {s.department && <span>{s.department}</span>}
                          {s.execution === 'OUTSOURCED' ? (
                            <span className="badge-purple">Outside unit{s.workstation ? `: ${s.workstation}` : ''}</span>
                          ) : s.workstation ? (
                            <span>Line: {s.workstation}</span>
                          ) : null}
                          {s.isQcStep && <span className="badge-info">Check</span>}
                          {s.optional && <span>Optional</span>}
                          {/* On a phone the rate sits here; on a wide screen it has its own column. */}
                          {s.ratePerPiece != null && <span className="tabular-nums sm:hidden">₹{s.ratePerPiece.toLocaleString('en-IN')} / pc</span>}
                        </p>
                      </div>

                      <span className="text-muted-foreground hidden text-xs tabular-nums sm:block">
                        {s.ratePerPiece != null ? `₹${s.ratePerPiece.toLocaleString('en-IN')} / pc` : '—'}
                      </span>

                      <div className="col-span-3 min-w-0 sm:col-span-1">
                        <p className="text-muted-foreground text-right font-mono text-[11px] tabular-nums">
                          {pcs(s.completed)}
                          {view.planned > 0 && <> of {pcs(view.planned)}</>}
                        </p>
                        <div className="bg-secondary mt-1 h-1.5 w-full overflow-hidden rounded-full" aria-hidden>
                          <div className={cn('h-full rounded-full', s.state === 'DONE' ? 'bg-emerald-500' : 'bg-primary')} style={{ width: `${share}%` }} />
                        </div>
                        <p className="text-muted-foreground mt-0.5 text-right text-[11px] tabular-nums">{s.state === 'SKIPPED' ? 'left out' : `${share}%`}</p>
                      </div>

                      <div className="col-start-3 row-start-1 flex items-center justify-end gap-1 sm:col-start-auto sm:row-start-auto">
                        <span className={cn(st.badge, 'whitespace-nowrap')}>{s.state === 'NOT_STARTED' ? 'Pending' : st.label}</span>
                        {canNote && s.track && (
                          <button
                            className={cn('btn-ghost h-7 w-7 justify-center p-0', s.note && 'text-primary')}
                            onClick={() => {
                              setNoteFor(noteFor === s.key ? null : s.key)
                              setNoteText(s.note ?? '')
                            }}
                            disabled={busy}
                            aria-label={s.note ? `Edit the note on ${s.name}` : `Add a note on ${s.name}`}
                            title={s.note ? 'Edit note' : 'Add note'}
                          >
                            <MessageSquare size={14} />
                          </button>
                        )}
                      </div>
                    </div>

                    {s.note && noteFor !== s.key && (
                      <p className="text-foreground mt-2 flex items-start gap-1.5 pl-12 text-xs">
                        <MessageSquare size={12} className="text-muted-foreground mt-0.5 shrink-0" />
                        <span>
                          {s.note}
                          {s.noteAt && <span className="text-muted-foreground"> — {when(s.noteAt)}</span>}
                        </span>
                      </p>
                    )}
                    {s.track && noteFor === s.key && (
                      <div className="mt-2 space-y-2 pl-12">
                        <textarea
                          className="form-input text-xs"
                          rows={2}
                          maxLength={300}
                          value={noteText}
                          placeholder="Anything to remember about this step for this style"
                          onChange={(e) => setNoteText(e.target.value)}
                          autoFocus
                        />
                        <div className="flex items-center gap-2">
                          <button className="btn-primary h-7 px-2.5 text-xs" onClick={() => void saveNote(s.track!)} disabled={busy}>
                            Save note
                          </button>
                          <button className="btn-ghost h-7 px-2.5 text-xs" onClick={() => setNoteFor(null)} disabled={busy}>
                            Cancel
                          </button>
                          {busy && <Loader2 size={14} className="text-muted-foreground animate-spin" />}
                        </div>
                      </div>
                    )}
                  </li>
                )
              })}
            </ol>
          </section>
        )}

        <section className="glass-card min-w-0 self-start p-4" aria-label="Orders">
          <div className="mb-3 flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
            <h2 className="text-foreground flex items-center gap-2 text-lg font-semibold">
              <ClipboardList size={18} className="text-primary" /> Orders for this style
            </h2>
            <Link href="/production/orders" className="border-primary/30 bg-primary/5 text-primary hover:bg-primary/10 inline-flex items-center gap-1 rounded-full border px-3 py-1 text-xs font-medium">
              Open manufacturing orders <ArrowRight size={12} />
            </Link>
            <p className="text-muted-foreground w-full text-[11px]">
              Where each order is comes from the production floor&apos;s records. Pick an order to see its steps alone; pick it again to see all orders together.
            </p>
          </div>
          {rows.length === 0 ? (
            <p className="text-muted-foreground text-sm">No manufacturing orders for this style yet. Units completed appear here once an order&apos;s stages are loaded and work is recorded on its sheets.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="data-table table-compact w-full">
                <thead>
                  <tr>
                    <th>Order</th>
                    <th>Colour</th>
                    <th className="whitespace-nowrap !text-right">Pieces</th>
                    <th>Status</th>
                    <th className="whitespace-nowrap">Where it is</th>
                    <th className="sr-only">Open</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((o) => {
                    const mo = moStatus(o.status)
                    const picked = focus === o.key
                    return (
                      <tr
                        key={o.key}
                        onClick={() => pick(o.key)}
                        className={cn('cursor-pointer', picked && 'bg-primary/10')}
                        aria-selected={picked}
                        title={picked ? 'Showing this order alone — pick it again for all orders' : 'Show this order alone'}
                      >
                        <td className={cn('whitespace-nowrap font-mono text-xs', picked && 'text-primary font-semibold')}>{o.moNumber}</td>
                        <td className="whitespace-nowrap text-xs">{o.color}</td>
                        <td className="whitespace-nowrap text-right font-mono text-xs tabular-nums">{pcs(o.planned)}</td>
                        <td className="whitespace-nowrap text-xs">
                          <span className={mo.cls}>{mo.label}</span>
                          {o.status === 'CLOSED' && <span className="text-muted-foreground"> not counted</span>}
                        </td>
                        <td className="min-w-[9rem] text-xs">{whereIs(o)}</td>
                        <td className="text-right">
                          <Link
                            href={`/production/orders?open=${o.moId}`}
                            onClick={(e) => e.stopPropagation()}
                            className="text-muted-foreground hover:text-primary inline-flex h-7 w-7 items-center justify-center rounded-md"
                            aria-label={`Open ${o.moNumber}`}
                            title={`Open ${o.moNumber}`}
                          >
                            <ArrowUpRight size={14} />
                          </Link>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </div>

      <RoutingFormDialog
        open={!!form}
        record={form?.record ?? null}
        preset={form?.preset ?? null}
        onClose={() => setForm(null)}
        onSaved={(m) => {
          setMessage(m)
          void load()
        }}
      />
    </div>
  )
}
