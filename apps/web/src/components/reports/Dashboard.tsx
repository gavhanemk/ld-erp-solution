'use client'

import { AlertTriangle, Info, Lightbulb } from 'lucide-react'

/**
 * The dashboard, on screen.
 *
 * Reads the very same `analysis` the workbook is built from — one `run()` on
 * the server, rendered twice. Two code paths computing one total is how two
 * screens end up disagreeing with nothing on either to say which is right.
 *
 * The rules the engine enforces are enforced here too, for the same reasons:
 * a single category is a figure rather than a chart, a panel that would only
 * repeat its neighbour is dropped, the shape follows the question and never
 * the data, and a figure that cannot be computed shows a dash, never a nought.
 *
 * Colour is decided by three rules, each of which was got wrong first:
 *
 *   - It carries MEANING, and the same meaning on every report — finished is
 *     green, waiting is amber, overdue is red. One hue everywhere is drab; a
 *     different hue per chart is noise. Both were tried.
 *   - Where there is no meaning, one series is one colour. Shading a ranking
 *     of supplier names darker-where-bigger encodes the bar's own length a
 *     second time and spends the only free channel saying nothing new.
 *   - A ramp is only for categories that really are ordered — an ageing band —
 *     and it is one hue light to dark, never a rainbow.
 *
 * Amber is spent carefully. It means something needs attention, so it is not
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

/** The exact figure, for the hover. The bar shows a rounded one. */
function exact(v: number, format: Panel['format']): string {
  if (format === 'percent') return `${(v * 100).toFixed(2)}%`
  if (format === 'money') return `₹${inr(v)}`
  return v.toLocaleString('en-IN', { maximumFractionDigits: 3 })
}

const TONE_TEXT = {
  good: 'text-emerald-400',
  warn: 'text-amber-400',
  bad: 'text-red-400',
} as const

const TONE_EDGE = {
  good: 'border-emerald-500/30',
  warn: 'border-amber-500/30',
  bad: 'border-red-500/30',
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

/** Categories that genuinely have an order, and so may wear a ramp. */
const ORDERED = new Set(['ageing', 'funnel'])
const RAMP = [1, 2, 3, 4, 5, 6].map((n) => `var(--viz-ramp-${n})`)
const SERIES = ['var(--viz-1)', 'var(--viz-2)', 'var(--viz-3)']

function fillFor(
  panel: Panel,
  i: number,
  point?: { tone?: Tone; exception?: boolean }
): string {
  // What the bar MEANS wins over everything else.
  if (point?.exception) return TONE.bad
  if (point?.tone) return TONE[point.tone]
  if (!ORDERED.has(panel.question)) return SERIES[0]
  // An ordered ramp runs dark for the first band to light for the last, so
  // "oldest" is heaviest wherever the report chose to put it.
  const step = Math.round((i / Math.max(1, panel.points.length - 1)) * (RAMP.length - 1))
  return RAMP[RAMP.length - 1 - step]
}

/**
 * One panel.
 *
 * Deliberately not stretched to its neighbour's height. In a grid every card
 * in a row grows to match the tallest, so a two-bar ranking beside a
 * three-bar funnel got padded with an inch of nothing — which reads as a card
 * that failed to load rather than as a short list. It is laid out in columns
 * instead (see the panel grid), where a short card is simply short and the
 * next one starts under it.
 */
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

function Card({ title, note, children }: { title: string; note?: string; children: React.ReactNode }) {
  return (
    <div className="glass-card mb-3 break-inside-avoid p-4">
      <h3 className="text-foreground text-sm font-semibold">{title}</h3>
      <div className="mt-3">{children}</div>
      {note && <p className="text-muted-foreground mt-3 text-[11px] italic leading-snug">{note}</p>}
    </div>
  )
}

/** Named, because identity must never rest on colour alone. */
function Legend({ series }: { series: Array<{ name: string; tone?: Tone }> }) {
  return (
    <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1.5">
      {series.map((s, i) => (
        <span key={s.name} className="text-muted-foreground flex items-center gap-1.5 text-[11px]">
          <span
            className="h-2.5 w-2.5 shrink-0 rounded-[3px]"
            style={{ background: s.tone ? TONE[s.tone] : SERIES[i % SERIES.length] }}
          />
          {s.name}
        </span>
      ))}
    </div>
  )
}

function BarPanel({ panel }: { panel: Panel }) {
  const max = Math.max(...panel.points.map((p) => Math.abs(p.value)), 1)
  const total = panel.points.reduce((s, p) => s + p.value, 0)

  return (
    <div className="space-y-2">
      {panel.points.map((p, i) => (
        <div key={p.label} title={`${p.label} — ${exact(p.value, panel.format)}`}>
          <div className="flex items-baseline justify-between gap-3 text-xs">
            <span className="text-foreground min-w-0 truncate">{p.label}</span>
            <span className="text-muted-foreground shrink-0 tabular-nums">
              {short(p.value, panel.format)}
              {panel.question === 'composition' && total > 0 && (
                <span className="ml-1 opacity-70">({Math.round((p.value / total) * 100)}%)</span>
              )}
            </span>
          </div>
          <div className="bg-secondary mt-1 h-2 w-full overflow-hidden rounded-full">
            <div
              className="h-full rounded-full"
              style={{
                width: `${Math.max(2, (Math.abs(p.value) / max) * 100)}%`,
                background: fillFor(panel, i, p),
              }}
            />
          </div>
        </div>
      ))}
    </div>
  )
}

/**
 * A stack: one bar per category, divided into its parts.
 *
 * A 2px gap between segments rather than a hairline border — a border is drawn
 * inside the segment and eats the smallest ones entirely.
 */
function SplitPanel({ panel }: { panel: Panel }) {
  const series = panel.series ?? []
  const max = Math.max(...panel.points.map((p) => Math.abs(p.value)), 1)

  return (
    <>
      <div className="space-y-2.5">
        {panel.points.map((p, row) => {
          const parts = series
            .map((s, i) => ({ name: s.name, value: s.values[row] ?? 0, i, tone: s.tone }))
            .filter((s) => s.value > 0)
          return (
            <div key={p.label}>
              <div className="flex items-baseline justify-between gap-3 text-xs">
                <span className="text-foreground min-w-0 truncate">{p.label}</span>
                <span className="text-muted-foreground shrink-0 tabular-nums">
                  {short(p.value, panel.format)}
                </span>
              </div>
              <div
                className="mt-1 flex h-2.5 w-full gap-[2px] overflow-hidden rounded-full"
                style={{ width: `${Math.max(4, (Math.abs(p.value) / max) * 100)}%` }}
              >
                {parts.length === 0 ? (
                  <div className="bg-secondary h-full w-full rounded-full" />
                ) : (
                  parts.map((s) => (
                    <div
                      key={s.name}
                      title={`${p.label} · ${s.name} — ${exact(s.value, panel.format)}`}
                      className="h-full first:rounded-l-full last:rounded-r-full"
                      style={{
                        flexGrow: s.value,
                        background: s.tone ? TONE[s.tone] : SERIES[s.i % SERIES.length],
                      }}
                    />
                  ))
                )}
              </div>
            </div>
          )
        })}
      </div>
      <Legend series={series} />
    </>
  )
}

/**
 * A Pareto: how few names make up the most of it.
 *
 * Deliberately not the workbook's shape. Excel draws the classic combination —
 * bars on rupees, the running share on a second axis — which is a named form
 * its readers know. In a card this wide a second scale would be two axes whose
 * alignment means nothing, so the share is put where it can be read directly:
 * on each row, with the point it crosses four-fifths called out. Same figures,
 * one scale.
 */
function ParetoPanel({ panel }: { panel: Panel }) {
  const total = panel.points.reduce((s, p) => s + p.value, 0)
  const max = Math.max(...panel.points.map((p) => Math.abs(p.value)), 1)

  let running = 0
  const rows = panel.points.map((p) => {
    running += p.value
    return { ...p, share: total > 0 ? running / total : null }
  })
  // How many names it takes to reach four fifths — the sentence the chart
  // exists to produce, rather than something the reader has to add up.
  const eighty = rows.findIndex((r) => r.share != null && r.share >= 0.8)

  return (
    <>
      <div className="space-y-2">
        {rows.map((p) => (
          <div key={p.label} title={`${p.label} — ${exact(p.value, panel.format)}`}>
            <div className="flex items-baseline justify-between gap-3 text-xs">
              <span className="text-foreground min-w-0 truncate">{p.label}</span>
              <span className="text-muted-foreground shrink-0 tabular-nums">
                {short(p.value, panel.format)}
                {p.share != null && (
                  <span className="text-primary ml-2 font-medium">
                    {Math.round(p.share * 100)}%
                  </span>
                )}
              </span>
            </div>
            <div className="bg-secondary mt-1 h-2 w-full overflow-hidden rounded-full">
              <div
                className="h-full rounded-full"
                style={{
                  width: `${Math.max(2, (Math.abs(p.value) / max) * 100)}%`,
                  background: SERIES[0],
                }}
              />
            </div>
          </div>
        ))}
      </div>
      {eighty >= 0 && (
        <p className="border-border text-foreground mt-3 border-t pt-2.5 text-xs">
          The top{' '}
          <span className="text-primary font-semibold">
            {eighty + 1} of {rows.length}
          </span>{' '}
          make up {Math.round((rows[eighty].share ?? 0) * 100)}% of the total.
        </p>
      )}
    </>
  )
}

/** Shares of one whole, where there are enough slices for a ring to read. */
function DonutPanel({ panel }: { panel: Panel }) {
  const total = panel.points.reduce((s, p) => s + p.value, 0)
  if (total <= 0) return <BarPanel panel={panel} />

  const R = 16
  const C = 2 * Math.PI * R
  let offset = 0

  return (
    <div className="flex items-center gap-4">
      <svg viewBox="0 0 44 44" className="h-28 w-28 shrink-0 -rotate-90">
        {panel.points.map((p, i) => {
          const frac = p.value / total
          const dash = frac * C
          const el = (
            <circle
              key={p.label}
              cx="22"
              cy="22"
              r={R}
              fill="none"
              strokeWidth="8"
              stroke={fillFor(panel, i, p)}
              strokeDasharray={`${Math.max(0, dash - 1)} ${C - Math.max(0, dash - 1)}`}
              strokeDashoffset={-offset}
            >
              <title>{`${p.label} — ${exact(p.value, panel.format)}`}</title>
            </circle>
          )
          offset += dash
          return el
        })}
      </svg>
      <div className="min-w-0 flex-1 space-y-1.5">
        {panel.points.map((p, i) => (
          <div key={p.label} className="flex items-baseline gap-2 text-xs">
            <span
              className="mt-1 h-2.5 w-2.5 shrink-0 rounded-[3px]"
              style={{ background: fillFor(panel, i, p) }}
            />
            <span className="text-foreground min-w-0 flex-1 truncate">{p.label}</span>
            <span className="text-muted-foreground shrink-0 tabular-nums">
              {Math.round((p.value / total) * 100)}%
            </span>
          </div>
        ))}
      </div>
    </div>
  )
}

function PanelCard({ panel }: { panel: Panel }) {
  const body =
    panel.question === 'split' && (panel.series?.length ?? 0) > 1 ? (
      <SplitPanel panel={panel} />
    ) : panel.question === 'pareto' && panel.points.length >= 3 ? (
      <ParetoPanel panel={panel} />
    ) : panel.question === 'composition' && panel.points.length >= 3 ? (
      <DonutPanel panel={panel} />
    ) : (
      <BarPanel panel={panel} />
    )

  return (
    <Card title={panel.title} note={panel.note}>
      {body}
    </Card>
  )
}

/** Time on the x-axis, so a trend is a line. */
function TrendChart({ trend }: { trend: NonNullable<Analysis['trend']> }) {
  const pts = trend.points
  const all = pts.flatMap((p) => [p.value, ...(p.compare != null ? [p.compare] : [])])
  const max = Math.max(...all, 1)
  const W = 100
  const H = 40
  const x = (i: number) => (pts.length === 1 ? W / 2 : (i / (pts.length - 1)) * W)
  const y = (v: number) => H - (v / max) * (H - 4)
  const line = (pick: (p: TrendPoint) => number | null | undefined) => {
    const d = pts
      .map((p, i) => {
        const v = pick(p)
        return v == null ? null : `${x(i)},${y(v)}`
      })
      .filter(Boolean)
    return d.length ? `M${d.join(' L')}` : ''
  }
  const area = `${line((p) => p.value)} L${x(pts.length - 1)},${H} L${x(0)},${H} Z`
  const hasCompare = pts.some((p) => p.compare != null)

  return (
    <div className="glass-card p-4">
      <h3 className="text-foreground text-sm font-semibold">{trend.title}</h3>
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="mt-3 h-40 w-full">
        <defs>
          <linearGradient id="trendFill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--viz-1)" stopOpacity="0.28" />
            <stop offset="100%" stopColor="var(--viz-1)" stopOpacity="0" />
          </linearGradient>
        </defs>
        {[0.25, 0.5, 0.75].map((f) => (
          <line
            key={f}
            x1="0"
            x2={W}
            y1={H * f}
            y2={H * f}
            className="stroke-border"
            strokeWidth="0.2"
          />
        ))}
        {pts.length > 1 && <path d={area} fill="url(#trendFill)" stroke="none" />}
        {hasCompare && (
          <path
            d={line((p) => p.compare)}
            fill="none"
            className="stroke-muted-foreground"
            strokeWidth="0.6"
            strokeDasharray="1.5 1.5"
            vectorEffect="non-scaling-stroke"
          />
        )}
        <path
          d={line((p) => p.value)}
          fill="none"
          stroke="var(--viz-1)"
          strokeWidth="1"
          vectorEffect="non-scaling-stroke"
        />
        {pts.map((p, i) => (
          <circle key={p.label} cx={x(i)} cy={y(p.value)} r="0.9" fill="var(--viz-1)">
            <title>{`${p.label} — ${exact(p.value, trend.format)}`}</title>
          </circle>
        ))}
      </svg>
      <div className="text-muted-foreground mt-2 flex justify-between text-[10px]">
        {pts.map((p) => (
          <span key={p.label}>{p.label}</span>
        ))}
      </div>
      <p className="text-muted-foreground mt-2 text-xs">
        {trend.valueLabel}
        {hasCompare && ` · dashed is ${trend.compareLabel ?? 'the previous period'}`}
      </p>
    </div>
  )
}

/**
 * The grid, shaded by size.
 *
 * A block of forty numbers is a block of forty numbers: the eye reads every
 * one before it finds the big month. Shaded, the shape of the year is there
 * before a single figure is read. One hue, and a cell that could not be
 * computed stays empty rather than being shaded as nought.
 */
function MatrixHeat({ matrix }: { matrix: NonNullable<Analysis['matrix']> }) {
  const all = matrix.rows.flatMap((r) => r.values.filter((v): v is number => v != null))
  const max = Math.max(...all, 1)

  return (
    <div className="glass-card overflow-hidden p-0">
      <div className="border-border flex flex-wrap items-center justify-between gap-2 border-b px-4 py-2.5">
        <h3 className="text-foreground text-sm font-semibold">{matrix.title}</h3>
        <span className="text-muted-foreground flex items-center gap-1.5 text-[11px]">
          Low
          <span className="flex">
            {RAMP.map((c) => (
              <span key={c} className="h-2.5 w-4" style={{ background: c }} />
            ))}
          </span>
          High
        </span>
      </div>
      <div className="overflow-x-auto">
        <table className="subtable w-full">
          <thead>
            <tr>
              <th>{matrix.rowLabel}</th>
              {matrix.columns.map((c) => (
                <th key={c} className="text-right">
                  {c}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {matrix.rows.map((r) => (
              <tr key={r.label}>
                <td className="whitespace-nowrap">{r.label}</td>
                {r.values.map((v, i) => (
                  <td
                    key={i}
                    className="text-right tabular-nums"
                    title={
                      v == null
                        ? `${r.label} · ${matrix.columns[i]} — nothing`
                        : `${r.label} · ${matrix.columns[i]} — ${exact(v, matrix.format)}`
                    }
                    style={
                      v == null
                        ? undefined
                        : {
                            background: `color-mix(in srgb, var(--viz-1) ${Math.round((v / max) * 70)}%, transparent)`,
                          }
                    }
                  >
                    {v == null ? '—' : short(v, matrix.format)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

export function ReportDashboard({
  analysis,
  rowCount,
}: {
  analysis: Analysis
  rowCount?: number
}) {
  /*
   * The same three rules the workbook applies.
   *
   * A single category is a figure, not a chart: one bar against an axis is a
   * number wearing a chart's costume, and a screen full of them reads as a
   * dashboard that has failed rather than a business with one supplier.
   *
   * A Pareto over fewer than three names is dropped outright rather than
   * falling back to bars — the bars it would draw are the ones the ranking
   * panel beside it already drew, and the same information twice is worse
   * than not drawing it.
   */
  const usable = analysis.panels.filter(
    (p) => !(p.question === 'pareto' && p.points.length < 3)
  )
  const cards = usable.filter((p) => p.points.length < 2)
  const charts = usable.filter((p) => p.points.length >= 2)

  return (
    <div className="space-y-5">
      {/* The headline, given the weight it is worth.
        It was a line of 16px teal text above a grey notice, which put the one
        sentence summarising the whole period at the same size as the caveat
        under it and below the visual weight of nine identical white boxes. A
        reader scanning the page found no entry point. Here it is the entry
        point: the largest type on the screen, on its own tinted ground, with
        a rule down the left in the measure colour the charts below use. */}
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

      {/* Says so when there is barely anything to look at, rather than leaving
        the reader to decide whether the report is broken or the period empty. */}
      {/* Quiet, not amber. A thin period is a fact about the data, not a
        fault needing attention — and a yellow band across the top of every
        report on a young system trains the reader to ignore yellow. */}
      {rowCount != null && rowCount > 0 && rowCount < 5 && (
        <p className="border-border bg-secondary/40 text-muted-foreground flex items-start gap-2 rounded-lg border px-3 py-2 text-xs">
          <Info size={14} className="mt-px shrink-0" />
          This period holds {rowCount} {rowCount === 1 ? 'row' : 'rows'}, so most panels below are
          shown as single figures rather than charts. They become charts as more documents are
          raised — nothing here is broken.
        </p>
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
              /* A rail in the tone's colour, and the figure a size up.
                These were flat white boxes, indistinguishable from the
                collapsed panels further down — so nine things competed at one
                weight and none of them led. The rail is the whole difference:
                it is the only place on the card carrying colour, so a tone
                means something at a glance instead of being a border tint
                nobody notices. An untoned KPI gets the measure colour, which
                is what the charts use for the ordinary case. */
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

      {/* Above the charts, because a reader who looks at nothing else should
        still see these. A KPI is the position; this is what somebody has to
        decide about. Only lines with something in them — a block of noughts
        teaches the reader the block is decorative. */}
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

      {analysis.trend && analysis.trend.points.length > 1 && <TrendChart trend={analysis.trend} />}

      {/* Columns, not a grid.
        A grid row stretches every card to the tallest in it, so one long
        panel put an inch of white under each short one beside it, and an odd
        number of panels left half the last row empty. Columns let each card
        be its own height and the next one start directly under it, which is
        the whole of the empty space this used to have. */}
      {charts.length > 0 && (
        <section>
          <SectionRule>Analysis</SectionRule>
          <div className="gap-3 lg:columns-2 [&>*]:break-inside-avoid">
            {charts.map((p) => (
              <PanelCard key={p.title} panel={p} />
            ))}
          </div>
        </section>
      )}

      {/* One category is a figure. Laid out as the KPI band is, because that
        is what it is — not a chart frame with a single bar in it. */}
      {cards.length > 0 && (
        <section>
          <SectionRule>
            Single figures
            <span className="text-muted-foreground/70 ml-2 font-normal normal-case tracking-normal">
              one of something, so a number rather than a chart
            </span>
          </SectionRule>
          {/* Deliberately quieter than the KPIs above.
            These used to be the same box at the same size, so the period's
            headline figures and a chart that happened to collapse looked
            equally important — and with five of them they outnumbered and
            outweighed the four that actually matter. Smaller type, no rail,
            and the category's own colour carried by the dot. */}
          <div className="flex flex-wrap gap-2.5">
            {cards.map((p) => {
              const pt = p.points[0]
              return (
                <div
                  key={p.title}
                  className="border-border bg-secondary/30 min-w-0 flex-1 basis-[12rem] rounded-lg border px-3 py-2.5"
                >
                  <p className="text-muted-foreground text-[11px] leading-snug">{p.title}</p>
                  {pt ? (
                    <>
                      <p className="text-foreground mt-1 text-base font-semibold tabular-nums leading-none">
                        {short(pt.value, p.format)}
                      </p>
                      <p className="text-muted-foreground mt-1.5 flex items-center gap-1.5 text-[11px]">
                        <span
                          className="h-2 w-2 shrink-0 rounded-full"
                          style={{ background: fillFor(p, 0, pt) }}
                        />
                        <span className="truncate">{pt.label}</span>
                      </p>
                    </>
                  ) : (
                    // An empty chart frame is indistinguishable from a broken
                    // one, so it says which in words.
                    <p className="text-muted-foreground mt-1 text-sm italic">
                      No data for this period
                    </p>
                  )}
                </div>
              )
            })}
          </div>
        </section>
      )}

      {analysis.matrix && <MatrixHeat matrix={analysis.matrix} />}

      {/* Also wrapping: a report with insights and no caveats, or the other
        way round, left the other half of the row empty. */}
      <div className="flex flex-wrap items-start gap-3">
        {analysis.insights.length > 0 && (
          <div className="glass-card min-w-0 flex-1 basis-[22rem] p-4">
            <h3 className="text-foreground flex items-center gap-2 text-sm font-semibold">
              <Lightbulb size={14} className="text-primary" />
              What the figures show
            </h3>
            <ul className="mt-2.5 space-y-2">
              {analysis.insights.map((line) => (
                <li key={line} className="text-foreground flex gap-2 text-sm leading-snug">
                  <span className="bg-primary mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full" />
                  {line}
                </li>
              ))}
            </ul>
          </div>
        )}
        {/* Caveats sit beside the insights, not below the fold. A caveat
          nobody reads is a caveat that did not happen. */}
        {/* Set in ordinary text, not amber.
          Amber means something needs attention. A caveat is scope — what the
          figures were not counting — and four lines of warning colour for
          scope both shouts at the reader and spends the one colour that was
          supposed to mean "look here" on something that never does. The
          heading carries the signal; the sentences carry the meaning. */}
        {analysis.caveats.length > 0 && (
          <div className="glass-card min-w-0 flex-1 basis-[22rem] p-4">
            <h3 className="text-foreground flex items-center gap-2 text-sm font-semibold">
              <Info size={14} className="text-muted-foreground" />
              What they do not show
            </h3>
            <ul className="mt-2.5 space-y-2">
              {analysis.caveats.map((line) => (
                <li
                  key={line}
                  className="text-muted-foreground flex gap-2 text-sm leading-snug"
                >
                  <span className="bg-muted-foreground/40 mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full" />
                  {line}
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </div>
  )
}
