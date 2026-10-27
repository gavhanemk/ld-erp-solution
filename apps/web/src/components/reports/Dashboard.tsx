'use client'

import { AlertTriangle } from 'lucide-react'

/**
 * A report's summary, on screen: figures, and no charts.
 *
 * The accounts team asked for the period at a glance in numbers — the
 * headline, the KPI cards, one table of totals under them, and what needs
 * attention — rather than a page of charts to read the numbers off. The
 * workbook behind "KPI summary" still draws its charts; this screen does not.
 *
 * It reads the very same `analysis` the workbook is built from — one `run()`
 * on the server, rendered twice — and a figure that cannot be computed shows
 * a dash, never a nought.
 *
 * Colour carries meaning, and the same meaning on every report — finished is
 * green, waiting is amber, overdue is red. Amber is spent carefully. It means something needs attention, so it is not
 * used for scope notes or for a quiet period: a report that shouts on every
 * screen teaches the reader to stop looking.
 */

/** Mirrors the server's `Tone`. What a bar means, which is what colours it. */
export type Tone = 'good' | 'normal' | 'info' | 'warn' | 'bad' | 'neutral'

export interface Kpi {
  label: string
  value: number | null
  format: 'money' | 'qty' | 'integer' | 'percent' | 'days'
  unit?: string
  basis: string
  tone?: 'good' | 'warn' | 'bad'
}

export interface TrendPoint {
  label: string
  value: number
  compare?: number | null
}

export interface Panel {
  title: string
  question:
    | 'trend'
    | 'comparison'
    | 'ranking'
    | 'ageing'
    | 'funnel'
    | 'composition'
    | 'split'
    | 'pareto'
  format: 'money' | 'qty' | 'integer' | 'percent'
  points: Array<{ label: string; value: number; tone?: Tone; exception?: boolean }>
  /** For `split`: what each bar divides into. */
  series?: Array<{ name: string; values: Array<number | null>; tone?: Tone }>
  note?: string
}

/** What needs a decision rather than a reading. */
export interface Exception {
  label: string
  value: number | null
  format: 'money' | 'qty' | 'integer' | 'percent' | 'days'
  unit?: string
  basis: string
  tone: 'warn' | 'bad'
}

export interface Analysis {
  headline?: string
  kpis: Kpi[]
  exceptions?: Exception[]
  trend?: {
    title: string
    valueLabel: string
    format: 'money' | 'qty' | 'integer'
    points: TrendPoint[]
    compareLabel?: string
  }
  panels: Panel[]
  matrix?: {
    title: string
    rowLabel: string
    columns: string[]
    rows: Array<{ label: string; values: Array<number | null> }>
    format: 'money' | 'qty' | 'integer' | 'percent'
  }
  insights: string[]
  caveats: string[]
}

const inr = (v: number) =>
  v.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

/** A dash, never a nought — a nought is a claim, a dash is an absence. */
function kpiText(k: Kpi): string {
  if (k.value == null) return '—'
  switch (k.format) {
    case 'money':
      return `₹${inr(k.value)}`
    case 'percent':
      return `${(k.value * 100).toFixed(1)}%`
    case 'days':
      return `${Math.round(k.value)} ${Math.round(k.value) === 1 ? 'day' : 'days'}`
    case 'qty':
      return `${k.value.toLocaleString('en-IN', { maximumFractionDigits: 3 })}${k.unit ? ` ${k.unit}` : ''}`
    default:
      return k.value.toLocaleString('en-IN')
  }
}

function short(v: number, format: Panel['format']): string {
  if (format === 'percent') return `${(v * 100).toFixed(1)}%`
  if (format !== 'money') return v.toLocaleString('en-IN', { maximumFractionDigits: 2 })
  if (Math.abs(v) >= 10_000_000) return `₹${(v / 10_000_000).toFixed(2)} cr`
  if (Math.abs(v) >= 100_000) return `₹${(v / 100_000).toFixed(2)} L`
  return `₹${v.toLocaleString('en-IN', { maximumFractionDigits: 0 })}`
}

const TONE_TEXT = {
  good: 'text-emerald-400',
  warn: 'text-amber-400',
  bad: 'text-red-400',
} as const

/**
 * Colour by meaning, and the same meaning on every report in the ERP:
 * finished is green, the ordinary measure teal, a neutral stage blue, waiting
 * amber, overdue or refused red, a remainder grey. A reader learns it once.
 *
 * Two pairs are measured and never touch — teal against green, amber against
 * red — each below the separation at which full colour vision tells them
 * apart. Green against amber is close enough to need the printed value beside
 * it, which every bar here has.
 */
export const TONE: Record<Tone, string> = {
  good: 'var(--tone-good)',
  normal: 'var(--tone-normal)',
  info: 'var(--tone-info)',
  warn: 'var(--tone-warn)',
  bad: 'var(--tone-bad)',
  neutral: 'var(--tone-neutral)',
}

/**
 * A heading with a hairline running off it, above each band of the dashboard.
 *
 * The page had none: headline, then boxes, then boxes, then charts, then more
 * boxes, with nothing saying which band was which or where one ended. Four
 * quiet rules turn a wall into sections, and cost a line of 10px text each —
 * the same device the exported sheet has always used, so the screen and the
 * workbook now read the same way round.
 */
function SectionRule({ children }: { children: React.ReactNode }) {
  return (
    <div className="mb-2.5 flex items-center gap-3">
      <h3 className="text-muted-foreground shrink-0 text-[10px] font-semibold uppercase tracking-wider">
        {children}
      </h3>
      <span className="bg-border h-px flex-1" aria-hidden />
    </div>
  )
}

export function ReportDashboard({
  analysis,
  children,
}: {
  analysis: Analysis
  /** The table of totals, set directly under the KPI cards. */
  children?: React.ReactNode
}) {
  return (
    <div className="space-y-5">
      {/* The headline, given the weight it is worth: the one sentence
        summarising the whole period, at the largest size on the screen. */}
      {analysis.headline && (
        <div className="border-border bg-card relative overflow-hidden rounded-xl border p-4 sm:p-5">
          <span
            className="absolute inset-y-0 left-0 w-1"
            style={{ background: 'var(--viz-1)' }}
            aria-hidden
          />
          <div
            className="pointer-events-none absolute inset-0 opacity-[0.06]"
            style={{ background: 'radial-gradient(60rem 12rem at 0% 0%, var(--viz-1), transparent)' }}
            aria-hidden
          />
          <p className="text-foreground relative pl-3 text-lg font-semibold leading-snug sm:text-xl">
            {analysis.headline}
          </p>
        </div>
      )}

      {/* Wrapping, not a fixed four columns.
        A report with two KPIs left half a row of nothing beside them and a
        report with five left three-quarters of a second row. They share the
        width they are given instead: two take a half each, three a third,
        five wrap to three and two. */}
      {analysis.kpis.length > 0 && (
        <section>
          <SectionRule>The period at a glance</SectionRule>
          <div className="flex flex-wrap gap-3">
            {analysis.kpis.map((k) => (
              /* A rail in the tone's colour, and the figure a size up. The
                rail is the only place on the card carrying colour, so a tone
                means something at a glance. An untoned KPI gets the measure
                colour. */
              <div
                key={k.label}
                className="glass-card relative min-w-0 flex-1 basis-[13rem] overflow-hidden p-3 pl-4"
              >
                <span
                  className="absolute inset-y-0 left-0 w-[3px]"
                  style={{ background: k.tone ? TONE[k.tone] : 'var(--viz-1)' }}
                  aria-hidden
                />
                <p className="text-muted-foreground text-[11px] font-medium uppercase tracking-wide">
                  {k.label}
                </p>
                <p
                  className={`mt-1.5 text-2xl font-semibold tabular-nums leading-none ${
                    k.tone ? TONE_TEXT[k.tone] : 'text-foreground'
                  }`}
                >
                  {kpiText(k)}
                </p>
                {/* The denominator, always. A figure without one invites the
                  reader to supply their own. */}
                <p className="text-muted-foreground mt-1.5 text-[11px] leading-snug">{k.basis}</p>
              </div>
            ))}
          </div>
        </section>
      )}

      {children}

      {/* A KPI is the position; this is what somebody has to decide about.
        Only lines with something in them — a block of noughts teaches the
        reader the block is decorative. */}
      {(() => {
        const live = (analysis.exceptions ?? []).filter((e) => e.value != null && e.value !== 0)
        if (!live.length) return null
        return (
          <div className="glass-card overflow-hidden p-0">
            <h3 className="border-border text-foreground flex items-center gap-2 border-b px-4 py-2.5 text-sm font-semibold">
              <AlertTriangle size={14} className="text-amber-400" />
              Needs attention
            </h3>
            <ul className="divide-border divide-y">
              {live.map((e) => (
                <li
                  key={e.label}
                  className="flex flex-wrap items-baseline gap-x-3 gap-y-1 px-4 py-2.5"
                >
                  <span
                    className="mt-1.5 h-2 w-2 shrink-0 rounded-full"
                    style={{ background: e.tone === 'bad' ? TONE.bad : TONE.warn }}
                  />
                  <span className="text-foreground text-sm font-medium">{e.label}</span>
                  <span
                    className="shrink-0 text-sm font-semibold tabular-nums"
                    style={{ color: e.tone === 'bad' ? TONE.bad : TONE.warn }}
                  >
                    {e.value == null
                      ? '—'
                      : e.format === 'days'
                        ? `${Math.round(e.value)} ${Math.round(e.value) === 1 ? 'day' : 'days'}`
                        : short(e.value, e.format)}
                  </span>
                  <span className="text-muted-foreground ml-auto text-xs">{e.basis}</span>
                </li>
              ))}
            </ul>
          </div>
        )
      })()}

    </div>
  )
}
