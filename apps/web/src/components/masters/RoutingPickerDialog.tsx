'use client'

import { useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  ArrowLeft,
  ArrowRight,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Copy,
  GitCompareArrows,
  Loader2,
  Route,
  Search,
  X,
} from 'lucide-react'
import { compareRoutings, type ComparableRouting } from '@ld-erp/shared'
import { useDialogFocus } from '@/lib/keys'
import { useEscape } from '@/lib/useEscape'
import type { Routing, RoutingStep } from './RoutingFormDialog'

type Current = ComparableRouting & {
  steps: RoutingStep[]
  style?: { code: string; name: string }
  fabric?: { code: string; name: string }
}
export const routingTarget = (r: Pick<Routing, 'style' | 'styleId' | 'category'>) =>
  r.styleId
    ? `${r.style?.code ?? 'Selected style'}${r.style?.name ? ` · ${r.style.name}` : ''}`
    : r.category
      ? `Category · ${r.category}`
      : 'Any style'
const fabricName = (r: Routing) => (r.fabric ? r.fabric.name : 'Any fabric')
const number = (n: unknown) =>
  n == null || n === '' ? '—' : Number(n).toLocaleString('en-IN', { maximumFractionDigits: 3 })
const skip = (v?: string) =>
  v === 'OPTIONAL'
    ? 'Optional (legacy)'
    : v === 'WITH_APPROVAL'
      ? 'Manager approval'
      : 'Never skipped'
const location = (s: RoutingStep) =>
  s.workstation?.name ??
  (s.workstationId || (s.execution === 'OUTSOURCED' ? 'Outside unit' : 'Our floor'))

function StepPreview({ step }: { step: RoutingStep }) {
  return (
    <details className="border-border/60 group border-b last:border-0">
      <summary className="hover:bg-secondary/40 grid cursor-pointer list-none grid-cols-[1.5rem_minmax(0,1fr)_4.5rem_1rem] items-center gap-2 px-3 py-2 [&::-webkit-details-marker]:hidden">
        <span className="text-muted-foreground text-xs tabular-nums">{step.sequence}</span>
        <div className="min-w-0">
          <p className="truncate text-sm font-medium">{step.operation?.name ?? step.operationId}</p>
          <p className="text-muted-foreground truncate text-[11px]">
            {location(step)}
            {step.isQcStep ? ' · QC' : ''}
          </p>
        </div>
        <span className="text-right text-xs tabular-nums">
          {number(step.smv)} <span className="text-muted-foreground">min</span>
        </span>
        <ChevronDown
          size={13}
          className="text-muted-foreground transition-transform group-open:rotate-180"
        />
      </summary>
      <div className="bg-secondary/25 grid gap-x-6 gap-y-2 px-4 py-3 text-xs sm:grid-cols-2">
        <p>
          <span className="text-muted-foreground">Done at </span>
          {step.execution === 'OUTSOURCED' ? 'Outside unit' : 'Our floor'}
        </p>
        <p>
          <span className="text-muted-foreground">Skipping </span>
          {skip(step.skip)}
        </p>
        <p>
          <span className="text-muted-foreground">Contractor </span>
          {step.contractor?.name ?? step.contractorId ?? 'None'}
        </p>
        <p>
          <span className="text-muted-foreground">Rate / pc </span>₹{number(step.ratePerPiece)}
        </p>
        {step.instructions && (
          <p className="whitespace-pre-wrap sm:col-span-2">{step.instructions}</p>
        )}
      </div>
    </details>
  )
}

function ComparisonStep({ step }: { step?: RoutingStep }) {
  if (!step) return <span className="text-muted-foreground">—</span>
  return (
    <div className="space-y-1 break-words text-xs">
      <p className="font-medium">
        {step.sequence}. {step.operation?.name ?? step.operationId}
      </p>
      <p className="text-muted-foreground">
        {step.execution === 'OUTSOURCED' ? 'Outside' : 'Our floor'} · {location(step)}
      </p>
      <p>
        {number(step.smv)} min · ₹{number(step.ratePerPiece)} / pc
      </p>
      <p className="text-muted-foreground">
        {skip(step.skip)}
        {step.isQcStep ? ' · QC' : ''}
      </p>
      {(step.contractorId || step.contractor?.name) && (
        <p>Contractor: {step.contractor?.name ?? step.contractorId}</p>
      )}
      {step.instructions && <p className="whitespace-pre-wrap">{step.instructions}</p>}
    </div>
  )
}

export function RoutingPickerDialog({
  current,
  results,
  selected,
  onSelect,
  query,
  onQuery,
  page,
  pages,
  onPage,
  searching,
  error,
  compare,
  onCompare,
  suggestions,
  onBrowse,
  onClose,
  onCopy,
  disabled,
}: {
  current: Current
  results: Routing[]
  selected: Routing | null
  onSelect: (routing: Routing) => void
  query: string
  onQuery: (value: string) => void
  page: number
  pages: number
  onPage: (value: number) => void
  searching: boolean
  error: string
  compare: boolean
  onCompare: (value: boolean) => void
  suggestions: boolean
  onBrowse: () => void
  onClose: () => void
  onCopy: (routing: Routing) => void
  disabled: boolean
}) {
  const ref = useRef<HTMLDivElement>(null)
  const titleId = useId()
  const [mobilePreview, setMobilePreview] = useState(suggestions && !!selected)
  const [changesOnly, setChangesOnly] = useState(false)
  useEscape(onClose)
  useDialogFocus(ref)
  const comparison = selected
    ? compareRoutings(
        { ...current, steps: current.steps.filter((s) => s.operationId) },
        { ...selected, steps: selected.steps ?? [] }
      )
    : null
  const differences = comparison?.rows.filter((r) => !changesOnly || r.kind !== 'unchanged') ?? []
  return createPortal(
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 p-2 backdrop-blur-sm sm:left-[var(--sidebar-current-width)] sm:p-4">
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="border-border bg-card text-foreground flex h-[min(760px,calc(100dvh-32px))] w-full max-w-6xl flex-col overflow-hidden rounded-2xl border shadow-2xl"
      >
        <header className="border-border flex shrink-0 items-center justify-between gap-3 border-b px-4 py-3 sm:px-5">
          <div className="flex min-w-0 items-center gap-3">
            <span className="bg-primary/10 text-primary hidden rounded-xl p-2.5 sm:block">
              <Copy size={19} />
            </span>
            <div>
              <h2 id={titleId} className="text-base font-semibold">
                {suggestions ? 'Review similar routings' : 'Create from Existing Routing'}
              </h2>
              <p className="text-muted-foreground text-xs">Choose a route to make your own.</p>
            </div>
          </div>
          <button
            type="button"
            className="btn-ghost p-2"
            aria-label="Close routing picker"
            onClick={onClose}
          >
            <X size={18} />
          </button>
        </header>
        <div className="grid min-h-0 flex-1 grid-cols-1 overflow-hidden md:grid-cols-[19rem_minmax(0,1fr)]">
          <aside
            className={`${mobilePreview ? 'hidden md:flex' : 'flex'} border-border bg-secondary/15 min-h-0 flex-col md:border-r`}
          >
            <div className="shrink-0 space-y-2 p-3">
              {suggestions ? (
                <div className="flex items-center justify-between text-xs">
                  <span className="text-muted-foreground">{results.length} suggested routings</span>
                  <button
                    type="button"
                    className="text-primary font-medium hover:underline"
                    onClick={onBrowse}
                  >
                    Search all
                  </button>
                </div>
              ) : (
                <label className="relative block">
                  <Search size={14} className="text-muted-foreground absolute left-3 top-3" />
                  <input
                    aria-label="Search existing routings"
                    className="form-input h-9 pl-9 text-sm"
                    placeholder="Search route, style, fabric…"
                    value={query}
                    onChange={(e) => {
                      onQuery(e.target.value)
                      setMobilePreview(false)
                    }}
                  />
                </label>
              )}
            </div>
            <div
              className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-2 pb-2"
              aria-label="Available routings"
              aria-busy={searching}
            >
              {searching ? (
                <p
                  role="status"
                  className="text-muted-foreground flex items-center gap-2 p-3 text-xs"
                >
                  <Loader2 size={14} className="animate-spin" />
                  Searching…
                </p>
              ) : (
                results.map((r) => (
                  <button
                    key={r.id}
                    type="button"
                    aria-pressed={selected?.id === r.id}
                    onClick={() => {
                      onSelect(r)
                      setMobilePreview(true)
                    }}
                    className={`mb-1 flex w-full items-start gap-2 rounded-lg border px-3 py-2 text-left transition-colors ${selected?.id === r.id ? 'border-primary/25 bg-primary/10' : 'hover:bg-secondary/60 border-transparent'}`}
                  >
                    <div className="min-w-0 flex-1">
                      <p className="line-clamp-2 text-sm font-medium">{r.name}</p>
                      <p className="text-muted-foreground mt-1 truncate text-[11px]">
                        {r.code} · v{r.version} · {r.steps?.length ?? 0} steps
                      </p>
                      <p className="text-muted-foreground truncate text-[11px]">
                        {r.style?.code ?? r.category ?? 'Any style'}
                        {!r.isActive ? ' · Stopped' : ''}
                      </p>
                    </div>
                    {selected?.id === r.id && (
                      <Check size={14} className="text-primary mt-1 shrink-0" />
                    )}
                  </button>
                ))
              )}
              {!searching && !results.length && (
                <p className="text-muted-foreground p-4 text-sm">{error || 'No routings found.'}</p>
              )}
            </div>
            {!suggestions && (
              <div className="border-border flex shrink-0 items-center justify-between border-t px-3 py-2 text-xs">
                <span className="text-muted-foreground">
                  {page} / {pages}
                </span>
                <div className="flex gap-1">
                  <button
                    type="button"
                    className="btn-ghost p-2"
                    aria-label="Previous routing page"
                    disabled={page <= 1 || searching}
                    onClick={() => onPage(page - 1)}
                  >
                    <ChevronLeft size={16} />
                  </button>
                  <button
                    type="button"
                    className="btn-ghost p-2"
                    aria-label="Next routing page"
                    disabled={page >= pages || searching}
                    onClick={() => onPage(page + 1)}
                  >
                    <ChevronRight size={16} />
                  </button>
                </div>
              </div>
            )}
          </aside>
          <div className={`${mobilePreview ? 'flex' : 'hidden md:flex'} min-h-0 min-w-0 flex-col`}>
            <button
              type="button"
              className="text-primary flex shrink-0 items-center gap-1 px-4 pt-3 text-xs md:hidden"
              onClick={() => setMobilePreview(false)}
            >
              <ArrowLeft size={14} />
              All routings
            </button>
            {selected ? (
              <>
                <div className="shrink-0 px-4 pb-3 pt-4 sm:px-5">
                  <h3 className="line-clamp-2 text-base font-semibold">{selected.name}</h3>
                  <p
                    className="text-muted-foreground mt-1 truncate text-xs"
                    title={routingTarget(selected)}
                  >
                    {routingTarget(selected)} · {fabricName(selected)}
                  </p>
                  <div className="mt-2 flex flex-wrap items-center gap-2 text-[11px]">
                    <span className="bg-secondary rounded px-1.5 py-0.5">v{selected.version}</span>
                    <span
                      className={`rounded px-1.5 py-0.5 ${selected.isActive ? 'bg-primary/10 text-primary' : 'bg-secondary text-muted-foreground'}`}
                    >
                      {selected.isActive ? 'Active' : 'Stopped'}
                      {selected.isLocked ? ' · Locked' : ''}
                    </span>
                    <span className="text-muted-foreground">
                      {selected.steps?.length ?? 0} steps ·{' '}
                      {number(selected.steps?.reduce((n, s) => n + Number(s.smv ?? 0), 0))} min / pc
                    </span>
                  </div>
                </div>
                <div className="border-border flex shrink-0 items-center justify-between gap-2 border-b px-4 sm:px-5">
                  <div className="flex gap-5" role="tablist" aria-label="Routing details">
                    <button
                      type="button"
                      role="tab"
                      aria-selected={!compare}
                      onClick={() => onCompare(false)}
                      className={`border-b-2 pb-2 text-xs font-medium ${!compare ? 'border-primary text-primary' : 'text-muted-foreground border-transparent'}`}
                    >
                      Steps & details
                    </button>
                    <button
                      type="button"
                      role="tab"
                      aria-selected={compare}
                      onClick={() => onCompare(true)}
                      className={`flex items-center gap-1.5 border-b-2 pb-2 text-xs font-medium ${compare ? 'border-primary text-primary' : 'text-muted-foreground border-transparent'}`}
                    >
                      <GitCompareArrows size={13} />
                      Compare Routings
                    </button>
                  </div>
                  {compare && (
                    <label className="text-muted-foreground flex items-center gap-1 text-[11px]">
                      <input
                        type="checkbox"
                        checked={changesOnly}
                        onChange={(e) => setChangesOnly(e.target.checked)}
                      />
                      Changes only
                    </label>
                  )}
                </div>
                <div
                  className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-3 sm:p-4"
                  role="tabpanel"
                  aria-label={compare ? 'Routing comparison' : 'Routing preview'}
                >
                  {compare && comparison ? (
                    <>
                      <div className="border-border mb-3 grid grid-cols-2 gap-3 border-b pb-3 text-xs">
                        <div>
                          <p className="mb-1 font-semibold">Your routing</p>
                          <p
                            className={
                              comparison.differences.includes('Applicability')
                                ? 'rounded bg-amber-500/10 p-1'
                                : 'text-muted-foreground'
                            }
                          >
                            {current.styleId
                              ? (current.style?.code ?? 'Selected style')
                              : (current.category ?? 'Any style')}
                          </p>
                          <p
                            className={
                              comparison.differences.includes('Fabric')
                                ? 'rounded bg-amber-500/10 p-1'
                                : 'text-muted-foreground'
                            }
                          >
                            {current.fabric?.name ?? 'Any fabric'}
                          </p>
                        </div>
                        <div>
                          <p className="mb-1 font-semibold">Existing routing</p>
                          <p
                            className={
                              comparison.differences.includes('Applicability')
                                ? 'rounded bg-amber-500/10 p-1'
                                : 'text-muted-foreground'
                            }
                          >
                            {selected.style?.code ?? selected.category ?? 'Any style'}
                          </p>
                          <p
                            className={
                              comparison.differences.includes('Fabric')
                                ? 'rounded bg-amber-500/10 p-1'
                                : 'text-muted-foreground'
                            }
                          >
                            {fabricName(selected)}
                          </p>
                        </div>
                      </div>
                      <p className="text-muted-foreground mb-3 text-xs">
                        {comparison.matched}/{comparison.total} processes match ·{' '}
                        {comparison.unchanged} unchanged
                      </p>
                      {differences.map((r, i) => (
                        <div
                          key={i}
                          className={`border-border/60 border-b p-3 ${r.kind === 'added' ? 'bg-emerald-500/10' : r.kind === 'removed' ? 'bg-red-500/10' : r.kind === 'modified' ? 'bg-amber-500/10' : ''}`}
                        >
                          <p className="text-muted-foreground mb-2 text-[10px] font-medium uppercase tracking-wide">
                            {r.changes.join(' · ') || 'Unchanged'}
                          </p>
                          <div className="grid grid-cols-2 gap-4">
                            <ComparisonStep step={r.current as RoutingStep} />
                            <ComparisonStep step={r.existing as RoutingStep} />
                          </div>
                        </div>
                      ))}
                      {!differences.length && (
                        <p className="text-muted-foreground py-4 text-center text-sm">
                          No step differences.
                        </p>
                      )}
                    </>
                  ) : (
                    <>
                      <div className="border-border overflow-hidden rounded-lg border">
                        {selected.steps?.map((s) => (
                          <StepPreview key={`${selected.id}:${s.sequence}`} step={s} />
                        ))}
                      </div>
                      {selected.notes && (
                        <details
                          key={selected.id}
                          className="border-border mt-3 rounded-lg border px-3 py-2 text-xs"
                        >
                          <summary className="text-muted-foreground cursor-pointer">
                            Routing notes
                          </summary>
                          <p className="whitespace-pre-wrap pt-2">{selected.notes}</p>
                        </details>
                      )}
                      <p className="text-muted-foreground mt-3 text-[11px]">
                        {selected.code}
                        {selected.updatedAt
                          ? ` · Updated ${new Date(selected.updatedAt).toLocaleDateString('en-IN')}`
                          : ''}
                        {selected.updatedBy?.name ? ` by ${selected.updatedBy.name}` : ''}
                      </p>
                    </>
                  )}
                </div>
              </>
            ) : (
              <div className="text-muted-foreground flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center">
                <Route size={30} className="opacity-30" />
                <p className="text-sm">Select a routing to preview its steps.</p>
              </div>
            )}
          </div>
        </div>
        <footer className="border-border flex shrink-0 items-center justify-end gap-2 border-t px-4 py-3 sm:px-5">
          <span className="text-muted-foreground mr-auto hidden text-xs sm:block">
            Copies into your form for editing.
          </span>
          <button type="button" className="btn-secondary" onClick={onClose}>
            Back
          </button>
          <button
            type="button"
            className="btn-primary"
            disabled={!selected || disabled || searching}
            onClick={() => selected && onCopy(selected)}
          >
            Use Existing Routing
            <ArrowRight size={15} />
          </button>
        </footer>
      </div>
    </div>,
    document.body
  )
}
