'use client'

/**
 * The dashboard, on screen.
 *
 * Reads the very same `analysis` the workbook is built from — one `run()` on
 * the server, rendered twice. Two code paths computing one total is how two
 * screens end up disagreeing with nothing on either to say which is right.
 *
 * The rules the engine enforces are enforced here too, for the same reasons:
 * one category is a card rather than a chart, the shape follows the question
 * and never the data, colour carries status, and a figure that cannot be
 * computed shows a dash rather than a nought.
 */

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
  question: 'trend' | 'comparison' | 'ranking' | 'ageing' | 'funnel' | 'composition'
  format: 'money' | 'qty' | 'integer' | 'percent'
  points: Array<{ label: string; value: number; exception?: boolean }>
  note?: string
}

export interface Analysis {
  headline?: string
  kpis: Kpi[]
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

/** One hue shaded by rank. Red only where the report marked an exception. */
const SHADES = ['bg-teal-800', 'bg-teal-700', 'bg-teal-600', 'bg-teal-500', 'bg-teal-400']
const shadeFor = (i: number, exception?: boolean) =>
  exception ? 'bg-red-600' : SHADES[Math.min(i, SHADES.length - 1)]

/** Time on the x-axis, so a trend is a line. */
function TrendChart({ trend }: { trend: NonNullable<Analysis['trend']> }) {
  const pts = trend.points
  const all = pts.flatMap((p) => [p.value, ...(p.compare != null ? [p.compare] : [])])
  const max = Math.max(...all, 1)
  const W = 100
  const H = 40
  const x = (i: number) => (pts.length === 1 ? W / 2 : (i / (pts.length - 1)) * W)
  const y = (v: number) => H - (v / max) * (H - 4)
  const path = (pick: (p: TrendPoint) => number | null | undefined) => {
    const d = pts
      .map((p, i) => {
        const v = pick(p)
        return v == null ? null : `${x(i)},${y(v)}`
      })
      .filter(Boolean)
    return d.length ? `M${d.join(' L')}` : ''
  }

  return (
    <div className="glass-card p-4">
      <h3 className="text-foreground text-sm font-semibold">{trend.title}</h3>
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="mt-3 h-40 w-full">
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
        {pts.some((p) => p.compare != null) && (
          <path
            d={path((p) => p.compare)}
            fill="none"
            className="stroke-muted-foreground"
            strokeWidth="0.6"
            strokeDasharray="1.5 1.5"
            vectorEffect="non-scaling-stroke"
          />
        )}
        <path
          d={path((p) => p.value)}
          fill="none"
          className="stroke-primary"
          strokeWidth="1"
          vectorEffect="non-scaling-stroke"
        />
        {pts.map((p, i) => (
          <circle key={p.label} cx={x(i)} cy={y(p.value)} r="0.8" className="fill-primary" />
        ))}
      </svg>
      <div className="text-muted-foreground mt-2 flex justify-between text-[10px]">
        {pts.map((p) => (
          <span key={p.label}>{p.label}</span>
        ))}
      </div>
      <p className="text-muted-foreground mt-2 text-xs">
        {trend.valueLabel}
        {pts.some((p) => p.compare != null) &&
          ` · dashed is ${trend.compareLabel ?? 'the previous period'}`}
      </p>
    </div>
  )
}

/**
 * A panel.
 *
 * Every shape here is drawn as bars, because on screen a horizontal bar reads
 * a ranking, an ageing and a funnel equally well and the label has room. What
 * does not change between here and the workbook is which panels become charts
 * at all, and what each one is called.
 */
function PanelCard({ panel }: { panel: Panel }) {
  const max = Math.max(...panel.points.map((p) => Math.abs(p.value)), 1)
  const total = panel.points.reduce((s, p) => s + p.value, 0)

  return (
    <div className="glass-card p-4">
      <h3 className="text-foreground text-sm font-semibold">{panel.title}</h3>
      <div className="mt-3 space-y-2">
        {panel.points.map((p, i) => (
          <div key={p.label}>
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
                className={`h-full rounded-full ${shadeFor(i, p.exception)}`}
                style={{ width: `${Math.max(2, (Math.abs(p.value) / max) * 100)}%` }}
              />
            </div>
          </div>
        ))}
      </div>
      {panel.note && <p className="text-muted-foreground mt-3 text-[11px] italic">{panel.note}</p>}
    </div>
  )
}

export function ReportDashboard({ analysis }: { analysis: Analysis }) {
  // One bar is not a chart. The same rule the workbook applies.
  const cards = analysis.panels.filter((p) => p.points.length < 2)
  const charts = analysis.panels.filter((p) => p.points.length >= 2)

  return (
    <div className="space-y-5">
      {analysis.headline && (
        <p className="text-primary text-base font-semibold">{analysis.headline}</p>
      )}

      {analysis.kpis.length > 0 && (
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          {analysis.kpis.map((k) => (
            <div key={k.label} className="glass-card p-3">
              <p className="text-muted-foreground text-xs">{k.label}</p>
              <p
                className={`mt-1 text-lg font-semibold tabular-nums ${k.tone ? TONE_TEXT[k.tone] : 'text-foreground'}`}
              >
                {kpiText(k)}
              </p>
              {/* The denominator, always. A figure without one invites the
                reader to supply their own. */}
              <p className="text-muted-foreground mt-0.5 text-[11px] leading-snug">{k.basis}</p>
            </div>
          ))}
        </div>
      )}

      {analysis.trend && analysis.trend.points.length > 1 && <TrendChart trend={analysis.trend} />}

      {charts.length > 0 && (
        <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
          {charts.map((p) => (
            <PanelCard key={p.title} panel={p} />
          ))}
        </div>
      )}

      {cards.length > 0 && (
        <div className="glass-card divide-border divide-y p-0">
          {cards.map((p) => (
            <div key={p.title} className="flex items-center justify-between gap-3 px-4 py-2.5">
              <span className="text-foreground text-sm">
                {p.title}
                {p.points[0] && (
                  <span className="text-muted-foreground"> · {p.points[0].label}</span>
                )}
              </span>
              <span className="text-foreground shrink-0 text-sm font-medium tabular-nums">
                {p.points[0] ? short(p.points[0].value, p.format) : '—'}
              </span>
            </div>
          ))}
        </div>
      )}

      {analysis.matrix && (
        <div className="glass-card overflow-hidden p-0">
          <h3 className="border-border text-foreground border-b px-4 py-2.5 text-sm font-semibold">
            {analysis.matrix.title}
          </h3>
          <div className="overflow-x-auto">
            <table className="subtable w-full">
              <thead>
                <tr>
                  <th>{analysis.matrix.rowLabel}</th>
                  {analysis.matrix.columns.map((c) => (
                    <th key={c} className="text-right">
                      {c}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {analysis.matrix.rows.map((r) => (
                  <tr key={r.label}>
                    <td>{r.label}</td>
                    {r.values.map((v, i) => (
                      <td key={i} className="text-right tabular-nums">
                        {v == null ? '—' : short(v, analysis.matrix!.format)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
        {analysis.insights.length > 0 && (
          <div className="glass-card p-4">
            <h3 className="text-muted-foreground text-[11px] font-semibold uppercase tracking-wide">
              What the figures show
            </h3>
            <ul className="mt-2 space-y-1.5">
              {analysis.insights.map((line) => (
                <li key={line} className="text-foreground text-sm leading-snug">
                  {line}
                </li>
              ))}
            </ul>
          </div>
        )}
        {/* Caveats sit beside the insights, not below the fold. A caveat
          nobody reads is a caveat that did not happen. */}
        {analysis.caveats.length > 0 && (
          <div className="glass-card p-4">
            <h3 className="text-muted-foreground text-[11px] font-semibold uppercase tracking-wide">
              What they do not show
            </h3>
            <ul className="mt-2 space-y-1.5">
              {analysis.caveats.map((line) => (
                <li key={line} className="text-sm leading-snug text-amber-400/90">
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
