'use client'

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import {
  AlertCircle,
  ArrowLeft,
  Ban,
  CheckCircle2,
  ChevronRight,
  ClipboardList,
  Copy,
  History,
  ListOrdered,
  Loader2,
  Lock,
  MessageSquare,
  Pencil,
  Play,
  Plus,
  Route,
  Shirt,
  Square,
  Undo2,
} from 'lucide-react'
import { api, ApiError, can } from '@/lib/api'
import { cn } from '@/lib/utils'
import { RoutingFormDialog, type Routing } from '@/components/masters/RoutingFormDialog'
import { ReasonDialog } from '@/components/ui/ReasonDialog'
import { describe, pcs, STEP_STATE, STYLE_STATE, took, when, type StyleDetail, type TrackStep } from './track'

type Act = 'start' | 'stop' | 'leave-out' | 'undo'

/**
 * One style's page under Masters → Routings: the routing it follows, and each
 * step with a Start and a Stop — pressed by hand on the floor's word — the
 * time it took, and the pieces completed there, which come from the floor's
 * own records and are never typed here.
 *
 * A step starts once the one before it has started (steps overlap on the
 * floor). Each step is started and stopped once; a mistake is undone by a
 * production manager, with a reason, the last thing first.
 */
export function StyleTracker({ styleId }: { styleId: string }) {
  const [d, setD] = useState<StyleDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [busyKey, setBusyKey] = useState<string | null>(null)
  const [ask, setAsk] = useState<{ step: TrackStep; action: 'leave-out' | 'undo' } | null>(null)
  const [noteFor, setNoteFor] = useState<string | null>(null)
  const [noteText, setNoteText] = useState('')
  const [form, setForm] = useState<{ record: Routing | null; preset: { styleId: string; from: Routing | null } | null } | null>(null)
  // "Running for 2 hours" keeps counting while the page is open.
  const [, setTick] = useState(0)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const res = await api.get<{ data: StyleDetail }>(`/masters/style-tracking/${styleId}`)
      setD(res.data)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not reach the server. Is the API running?')
    } finally {
      setLoading(false)
    }
  }, [styleId])

  useEffect(() => {
    void load()
  }, [load])
  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), 60_000)
    return () => clearInterval(t)
  }, [])

  const canRecord = can('production', 'create')
  const canUndo = can('production', 'edit')
  const canApprove = can('production', 'approve')
  const canEditRouting = can('masters', 'edit')
  const canNewRouting = can('masters', 'create')

  const path = (s: TrackStep, action: string) => `/masters/style-tracking/${styleId}/steps/${s.operationId}/${s.occurrence}/${action}`

  const act = async (s: TrackStep, action: Act, body: Record<string, unknown> = {}) => {
    setBusyKey(s.key)
    setError(null)
    setMessage(null)
    try {
      const res = await api.post<{ message?: string; data: StyleDetail }>(path(s, action), body)
      setD(res.data)
      setMessage(res.message ?? null)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save that. Is the API running?')
      // The routing may have changed under us: show it as it is now.
      if (err instanceof ApiError && err.status === 404) void load()
    } finally {
      setBusyKey(null)
      setAsk(null)
    }
  }

  const saveNote = async (s: TrackStep) => {
    setBusyKey(s.key)
    setError(null)
    try {
      const res = await api.patch<{ message?: string; data: StyleDetail }>(path(s, 'note'), { note: noteText.trim() || null })
      setD(res.data)
      setMessage(res.message ?? null)
      setNoteFor(null)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save the note.')
    } finally {
      setBusyKey(null)
    }
  }

  if (loading && !d) {
    return (
      <div className="space-y-4">
        <div className="skeleton h-28 w-full rounded-xl" />
        <div className="skeleton h-20 w-full rounded-xl" />
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
  const live = d.steps.filter((s) => s.state !== 'SKIPPED')
  const going = d.steps.filter((s) => s.state === 'IN_PROGRESS')
  const lastLive = live[live.length - 1]
  const pct = d.overall.total ? Math.round((d.overall.done / d.overall.total) * 100) : 0
  const routing = d.routing
  const ownRouting = routing && d.applies === 'STYLE'

  const tile = (label: string, value: React.ReactNode, sub?: React.ReactNode) => (
    <div className="glass-card p-3">
      <p className="text-muted-foreground text-xs">{label}</p>
      <div className="text-foreground mt-1 text-lg font-semibold tabular-nums">{value}</div>
      {sub && <div className="text-muted-foreground mt-0.5 text-xs">{sub}</div>}
    </div>
  )

  const undoWhat = (s: TrackStep) => (s.run?.skippedAt ? 'leaving out' : s.run?.stoppedAt ? 'stop' : 'start')

  return (
    <div className="space-y-4">
      <nav className="text-muted-foreground flex items-center gap-1 text-xs" aria-label="Breadcrumb">
        <Link href="/masters/routings" className="hover:text-foreground inline-flex items-center gap-1">
          <ArrowLeft size={13} /> Routings
        </Link>
        <ChevronRight size={12} aria-hidden />
        <span className="text-foreground font-mono">{d.style.code}</span>
      </nav>

      {/* Who the style is, where it stands, and the routing it follows. */}
      <div className="glass-card p-4 sm:p-5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="flex min-w-0 items-start gap-3">
            <div className="bg-primary/10 border-primary/20 flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border">
              <Shirt size={20} className="text-primary" />
            </div>
            <div className="min-w-0">
              <h1 className="page-title text-xl sm:text-2xl">
                <span className="text-primary font-mono">{d.style.code}</span> {d.style.name}
              </h1>
              <p className="text-muted-foreground mt-1 text-xs">
                {[d.style.category, d.style.season, d.style.sizeGroup ? `sizes ${d.style.sizeGroup.name}` : null].filter(Boolean).join(' · ') || 'No category set'}
                {!d.style.isActive && ' · no longer in use'}
              </p>
              {d.style.colors.length > 0 && (
                <div className="mt-2 flex flex-wrap gap-1">
                  {d.style.colors.map((c) => (
                    <span key={c} className="badge-neutral">
                      {c}
                    </span>
                  ))}
                </div>
              )}
            </div>
          </div>
          <div className="text-right">
            <span className={look.badge}>{look.label}</span>
            <p className="text-muted-foreground mt-1.5 text-xs">{describe(d.overall)}</p>
          </div>
        </div>

        <div className="border-border mt-4 flex flex-wrap items-center justify-between gap-3 border-t pt-3">
          {routing ? (
            <div className="min-w-0 text-xs">
              <p className="text-foreground flex flex-wrap items-center gap-1.5">
                <Route size={13} className="text-primary shrink-0" />
                <span className="font-mono">{routing.code}</span>
                <span className="text-muted-foreground">—</span>
                <span>{routing.name}</span>
                <span className="text-muted-foreground">
                  · version {routing.version} · {routing.steps?.length ?? 0} steps
                </span>
                {routing.isLocked && (
                  <span className="text-muted-foreground inline-flex items-center gap-1">
                    · <Lock size={11} /> locked
                  </span>
                )}
              </p>
              <p className="text-muted-foreground mt-0.5">
                {d.applies === 'STYLE'
                  ? d.alternatives > 0
                    ? `Its own routing. ${d.alternatives} more ${d.alternatives === 1 ? 'is' : 'are'} for this style; this page follows the one changed most recently.`
                    : 'Its own routing.'
                  : d.applies === 'CATEGORY'
                    ? `Shared by every ${routing.category} style — it has none of its own.`
                    : 'Shared by any style without one of its own — it has none of its own.'}
              </p>
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
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            {tile(
              'Steps done',
              <>
                {d.overall.done} <span className="text-muted-foreground text-sm font-normal">of {d.overall.total}</span>
              </>,
              <div className="bg-secondary mt-1 h-1.5 w-full overflow-hidden rounded-full" aria-hidden>
                <div className="bg-primary h-full rounded-full" style={{ width: `${pct}%` }} />
              </div>,
            )}
            {tile('In progress', going.length ? <span className="text-base">{going.map((s) => s.name).join(', ')}</span> : '—', going.length ? `since ${when(going[0].run!.startedAt!)}` : 'Nothing under way')}
            {tile('Units planned', pcs(d.production.planned), `${d.production.orders.length} order ${d.production.orders.length === 1 ? 'line' : 'lines'}`)}
            {tile('Through the last step', lastLive ? pcs(lastLive.completed) : '—', lastLive ? `completed at ${lastLive.name}` : undefined)}
          </div>

          <section className="glass-card p-4 sm:p-5" aria-label="Steps">
            <div className="mb-4 flex flex-wrap items-end justify-between gap-2">
              <h2 className="text-foreground flex items-center gap-2 text-lg font-semibold">
                <ListOrdered size={18} className="text-primary" /> Steps
              </h2>
              <p className="text-muted-foreground text-xs">A step starts once the one before it has started. Units completed come from the production floor&apos;s records.</p>
            </div>

            <ol>
              {d.steps.map((s, i) => {
                const r = s.run
                const st = STEP_STATE[s.state]
                const busy = busyKey === s.key
                const last = i === d.steps.length - 1
                return (
                  <li key={s.key} className="flex gap-3">
                    {/* The rail: a numbered dot per step, joined by a line that fills as steps finish. */}
                    <div className="flex flex-col items-center">
                      <span
                        className={cn(
                          'flex h-8 w-8 shrink-0 items-center justify-center rounded-full border-2 text-xs font-semibold',
                          s.state === 'DONE'
                            ? 'border-emerald-500 bg-emerald-500/10 text-emerald-500'
                            : s.state === 'IN_PROGRESS'
                              ? 'border-primary bg-primary/10 text-primary'
                              : s.state === 'SKIPPED'
                                ? 'border-border text-muted-foreground border-dashed'
                                : 'border-border text-muted-foreground',
                        )}
                        aria-hidden
                      >
                        {s.state === 'DONE' ? <CheckCircle2 size={16} /> : s.state === 'SKIPPED' ? <Ban size={14} /> : i + 1}
                      </span>
                      {!last && <span className={cn('my-1 w-0.5 flex-1', s.state === 'DONE' ? 'bg-emerald-500/50' : 'bg-border')} aria-hidden />}
                    </div>

                    <div className={cn('mb-3 min-w-0 flex-1 rounded-xl border p-3', s.state === 'IN_PROGRESS' ? 'border-primary/50 bg-primary/5' : 'border-border bg-card', s.state === 'SKIPPED' && 'opacity-75')}>
                      <div className="flex flex-wrap items-start justify-between gap-2">
                        <div className="min-w-0">
                          <p className="text-foreground text-sm font-semibold">
                            <span className="text-muted-foreground mr-1 font-mono text-xs">{i + 1}.</span>
                            {s.name}
                            {s.occurrence > 1 && <span className="text-muted-foreground font-normal"> (again)</span>}
                          </p>
                          <p className="text-muted-foreground mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
                            {s.department && <span>{s.department.name}</span>}
                            {s.execution === 'OUTSOURCED' ? (
                              <span className="badge-purple">Outside unit{s.workstation ? `: ${s.workstation.name}` : ''}</span>
                            ) : s.workstation ? (
                              <span>Line: {s.workstation.name}</span>
                            ) : null}
                            {s.isQcStep && <span className="badge-info">Check</span>}
                            {s.skip === 'OPTIONAL' && <span>Optional</span>}
                            {s.ratePerPiece != null && <span className="tabular-nums">₹{Number(s.ratePerPiece).toLocaleString('en-IN')} / pc</span>}
                          </p>
                        </div>
                        <span className={st.badge}>{st.label}</span>
                      </div>

                      <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 text-xs sm:grid-cols-4">
                        <div>
                          <dt className="text-muted-foreground">Started</dt>
                          <dd className="text-foreground">{r?.startedAt ? when(r.startedAt) : '—'}</dd>
                          {r?.startedAt && r.startedBy && <dd className="text-muted-foreground">by {r.startedBy.name}</dd>}
                        </div>
                        <div>
                          <dt className="text-muted-foreground">Stopped</dt>
                          <dd className="text-foreground">{r?.stoppedAt ? when(r.stoppedAt) : '—'}</dd>
                          {r?.stoppedAt && r.stoppedBy && <dd className="text-muted-foreground">by {r.stoppedBy.name}</dd>}
                        </div>
                        <div>
                          <dt className="text-muted-foreground">{s.state === 'IN_PROGRESS' ? 'Running for' : 'Took'}</dt>
                          <dd className="text-foreground">{r?.startedAt ? took(r.startedAt, r.stoppedAt ?? new Date()) : '—'}</dd>
                        </div>
                        <div>
                          <dt className="text-muted-foreground">Units completed</dt>
                          <dd className="text-foreground font-mono tabular-nums">
                            {pcs(s.completed)}
                            {d.production.planned > 0 && <span className="text-muted-foreground"> of {pcs(d.production.planned)}</span>}
                          </dd>
                        </div>
                      </dl>

                      {s.state === 'SKIPPED' && r?.skippedAt && (
                        <p className="text-muted-foreground mt-2 text-xs">
                          Left out {when(r.skippedAt)}
                          {r.skippedBy ? ` by ${r.skippedBy.name}` : ''}
                          {r.skipReason ? `: ${r.skipReason}` : ''}
                        </p>
                      )}
                      {s.instructions && (
                        <p className="text-muted-foreground mt-2 text-xs">
                          <span className="text-foreground font-medium">Instructions:</span> {s.instructions}
                        </p>
                      )}

                      {noteFor === s.key ? (
                        <div className="mt-2 space-y-2">
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
                            <button className="btn-primary h-7 px-2.5 text-xs" onClick={() => void saveNote(s)} disabled={busy}>
                              Save note
                            </button>
                            <button className="btn-ghost h-7 px-2.5 text-xs" onClick={() => setNoteFor(null)} disabled={busy}>
                              Cancel
                            </button>
                          </div>
                        </div>
                      ) : (
                        r?.note && (
                          <p className="text-foreground mt-2 flex items-start gap-1.5 text-xs">
                            <MessageSquare size={12} className="text-muted-foreground mt-0.5 shrink-0" />
                            <span>{r.note}</span>
                          </p>
                        )
                      )}

                      <div className="mt-3 flex flex-wrap items-center gap-2">
                        {canRecord && s.state === 'NOT_STARTED' && (
                          <button className="btn-primary h-8 px-3 text-xs disabled:cursor-not-allowed disabled:opacity-40 disabled:shadow-none" onClick={() => void act(s, 'start')} disabled={busy || !!s.startBlockedBy}>
                            <Play size={13} /> Start
                          </button>
                        )}
                        {canRecord && s.state === 'IN_PROGRESS' && (
                          <button className="btn-primary h-8 px-3 text-xs disabled:cursor-not-allowed disabled:opacity-40 disabled:shadow-none" onClick={() => void act(s, 'stop')} disabled={busy}>
                            <Square size={13} /> Stop
                          </button>
                        )}
                        {s.state === 'NOT_STARTED' && s.startBlockedBy && <span className="text-muted-foreground text-xs">Starts once {s.startBlockedBy} has started.</span>}
                        {canRecord && s.state === 'NOT_STARTED' && s.skip !== 'NEVER' && (s.skip === 'OPTIONAL' || canApprove) && (
                          <button className="btn-ghost h-8 px-2.5 text-xs" onClick={() => setAsk({ step: s, action: 'leave-out' })} disabled={busy}>
                            <Ban size={13} /> Leave out
                          </button>
                        )}
                        {canRecord && noteFor !== s.key && (
                          <button
                            className="btn-ghost h-8 px-2.5 text-xs"
                            onClick={() => {
                              setNoteFor(s.key)
                              setNoteText(r?.note ?? '')
                            }}
                            disabled={busy}
                          >
                            <MessageSquare size={13} /> {r?.note ? 'Edit note' : 'Add note'}
                          </button>
                        )}
                        {busy && <Loader2 size={14} className="text-muted-foreground animate-spin" />}
                        {canUndo && r && (r.startedAt || r.skippedAt) && (
                          <button className="btn-ghost text-muted-foreground ml-auto h-8 px-2.5 text-xs" onClick={() => setAsk({ step: s, action: 'undo' })} disabled={busy}>
                            <Undo2 size={13} /> Undo {undoWhat(s)}
                          </button>
                        )}
                      </div>
                    </div>
                  </li>
                )
              })}
            </ol>
          </section>
        </>
      )}

      <section className="glass-card p-4 sm:p-5" aria-label="Orders">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-foreground flex items-center gap-2 text-lg font-semibold">
            <ClipboardList size={18} className="text-primary" /> Orders for this style
          </h2>
          <Link href="/production/orders" className="text-primary text-xs hover:underline">
            Open manufacturing orders
          </Link>
        </div>
        {d.production.orders.length === 0 ? (
          <p className="text-muted-foreground text-sm">No manufacturing orders for this style yet. Units completed appear here once an order&apos;s stages are loaded and work is recorded on its sheets.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="data-table table-compact">
              <thead>
                <tr>
                  <th>Order</th>
                  <th>Colour</th>
                  <th className="!text-right">Pieces planned</th>
                  <th>Status</th>
                  <th>Stages</th>
                </tr>
              </thead>
              <tbody>
                {d.production.orders.map((o, i) => (
                  <tr key={`${o.moId}-${o.color}-${i}`}>
                    <td className="font-mono text-xs">{o.moNumber}</td>
                    <td className="text-xs">{o.color}</td>
                    <td className="text-right font-mono text-xs tabular-nums">{pcs(o.planned)}</td>
                    <td className="text-xs">{o.status.charAt(0) + o.status.slice(1).toLowerCase()}</td>
                    <td className="text-xs">{o.staged ? 'Loaded' : <span className="text-muted-foreground">Not loaded yet</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {d.history.length > 0 && (
        <section className="glass-card p-4 sm:p-5" aria-label="No longer on the routing">
          <h2 className="text-foreground mb-2 flex items-center gap-2 text-lg font-semibold">
            <History size={18} className="text-primary" /> No longer on the routing
          </h2>
          <p className="text-muted-foreground mb-3 text-xs">Steps that were started or left out before the routing changed. Kept for the record.</p>
          <ul className="space-y-1.5 text-xs">
            {d.history.map((h) => (
              <li key={h.id} className="border-border rounded-lg border px-3 py-2">
                <span className="text-foreground font-medium">{h.stepName}</span>
                <span className="text-muted-foreground">
                  {h.skippedAt ? ` — left out ${when(h.skippedAt)}` : ''}
                  {h.startedAt ? ` — started ${when(h.startedAt)}` : ''}
                  {h.stoppedAt ? `, stopped ${when(h.stoppedAt)}` : ''}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {ask && (
        <ReasonDialog
          title={
            ask.action === 'leave-out'
              ? `Leave ${ask.step.name} out for ${d.style.code}?`
              : `Undo the ${undoWhat(ask.step)} of ${ask.step.name}?`
          }
          description={
            ask.action === 'leave-out'
              ? `${ask.step.name} will show as left out, and the step after it can start without it. ${ask.step.skip === 'WITH_APPROVAL' ? 'It is a required step, so this is recorded as a manager’s decision.' : ''}`
              : ask.step.run?.skippedAt
                ? `${ask.step.name} goes back on the route as not started.`
                : ask.step.run?.stoppedAt
                  ? `${ask.step.name} goes back to in progress; its stop time is cleared.`
                  : `${ask.step.name} goes back to not started; its start time is cleared.`
          }
          confirmLabel={ask.action === 'leave-out' ? 'Leave it out' : 'Undo'}
          danger={ask.action === 'undo'}
          busy={busyKey === ask.step.key}
          onConfirm={(reason) => void act(ask.step, ask.action, { reason })}
          onCancel={() => setAsk(null)}
        />
      )}

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
