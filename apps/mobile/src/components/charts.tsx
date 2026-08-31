import { useMemo } from 'react'
import { useColorScheme, View, Text } from 'react-native'
import Svg, {
  Path, Line, Circle, Rect, Defs, LinearGradient, Stop, G,
} from 'react-native-svg'
import { shortMoney } from '@/lib/format'
import { useDrawInValue } from './motion'

/**
 * The charts.
 *
 * Colours are not chosen by eye. The five below were run through the palette
 * validator and pass on both the dark card and the white one: every step sits
 * inside the lightness band, carries enough chroma not to read grey, clears the
 * contrast floor, and no adjacent pair collapses under colour blindness.
 *
 * The order is fixed and must stay fixed. Amber and red are too close to sit
 * next to each other — emerald between them is what separates the pair — and
 * colour follows the thing it names, never its position in a sorted list, so a
 * status keeps its colour when the counts change.
 *
 * Never add a sixth by picking something that looks about right. Re-run the
 * validator, or fold the tail into "Other".
 */
export const SERIES = ['#0d9488', '#d97706', '#059669', '#ef4444', '#8b5cf6'] as const

/** Ink and rules, which follow the theme rather than the data. */
function useChartInk() {
  const dark = useColorScheme() === 'dark'
  return {
    dark,
    // Gridlines sit one shade off the surface, solid — never dashed, which
    // reads as a threshold when it is only a grid.
    grid: dark ? '#1e293b' : '#e8ebef',
    label: dark ? '#64748b' : '#6b7280',
    ink: dark ? '#e2e8f0' : '#1f2937',
    surface: dark ? '#0f172a' : '#ffffff',
  }
}

/** A rupee figure short enough for an axis: 8.7L, 45K. */
const axisMoney = (n: number) => shortMoney(n).replace('₹', '')

// ─────────────────────────────────────────────────────────────
// Money in against money out, by month
// ─────────────────────────────────────────────────────────────

export interface TrendPoint {
  label: string
  revenue: number
  expenses: number
}

/**
 * Two series, one axis, one unit.
 *
 * Both are rupees, so they share a scale — a second y-axis would invent a
 * relationship between them that the figures do not contain.
 */
export function TrendChart({
  data,
  height = 150,
  width,
}: {
  data: TrendPoint[]
  height?: number
  width: number
}) {
  const ink = useChartInk()

  /**
   * The lines grow up out of the baseline rather than appearing finished.
   *
   * The scale is worked out from the full figures and held still, so the chart
   * does not rescale while it animates — only the marks move, which is what
   * makes the growth readable instead of dizzying.
   */
  const t = useDrawInValue(120, 800)

  const geom = useMemo(() => {
    const padL = 40
    const padR = 14
    const padT = 10
    const padB = 22
    const w = Math.max(0, width - padL - padR)
    const h = Math.max(0, height - padT - padB)

    const values = data.flatMap((d) => [d.revenue, d.expenses])
    // Always include zero: a truncated baseline exaggerates every movement.
    const max = Math.max(1, ...values)

    const x = (i: number) => padL + (data.length <= 1 ? w / 2 : (i / (data.length - 1)) * w)
    const y = (v: number) => padT + h - ((v * t) / max) * h

    const line = (key: 'revenue' | 'expenses') =>
      data.map((d, i) => `${i === 0 ? 'M' : 'L'}${x(i)},${y(d[key])}`).join(' ')

    const area =
      data.length > 0
        ? `${line('revenue')} L${x(data.length - 1)},${padT + h} L${x(0)},${padT + h} Z`
        : ''

    return { padL, padT, padB, w, h, max, x, y, line, area }
  }, [data, width, height, t])

  if (!data.length || width <= 0) return null

  const last = data.length - 1
  // Three hairlines is enough to read a level against; more is noise.
  const ticks = [0, 0.5, 1]

  return (
    <View>
      {/* Two series, so a legend is not optional. */}
      <View className="mb-2 flex-row items-center gap-4">
        {[
          { label: 'Invoiced', colour: SERIES[0] },
          { label: 'Bills', colour: SERIES[1] },
        ].map((s) => (
          <View key={s.label} className="flex-row items-center gap-1.5">
            <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: s.colour }} />
            <Text className="text-xs text-muted-foreground">{s.label}</Text>
          </View>
        ))}
      </View>

      <Svg width={width} height={height}>
        <Defs>
          <LinearGradient id="revFill" x1="0" y1="0" x2="0" y2="1">
            <Stop offset="0" stopColor={SERIES[0]} stopOpacity="0.22" />
            <Stop offset="1" stopColor={SERIES[0]} stopOpacity="0" />
          </LinearGradient>
        </Defs>

        {ticks.map((t) => {
          const yy = geom.padT + geom.h - t * geom.h
          return (
            <G key={t}>
              <Line
                x1={geom.padL}
                y1={yy}
                x2={geom.padL + geom.w}
                y2={yy}
                stroke={ink.grid}
                strokeWidth={1}
              />
            </G>
          )
        })}

        <Path d={geom.area} fill="url(#revFill)" />
        <Path
          d={geom.line('revenue')}
          stroke={SERIES[0]}
          strokeWidth={2}
          fill="none"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <Path
          d={geom.line('expenses')}
          stroke={SERIES[1]}
          strokeWidth={2}
          fill="none"
          strokeLinecap="round"
          strokeLinejoin="round"
        />

        {/* Only the last point is marked. A dot on every month is chaos and
            goes unread. The ring is the surface colour so the two markers stay
            separate where the lines cross. */}
        {(['revenue', 'expenses'] as const).map((k, i) => (
          <Circle
            key={k}
            cx={geom.x(last)}
            cy={geom.y(data[last][k])}
            r={4.5}
            fill={SERIES[i]}
            stroke={ink.surface}
            strokeWidth={2}
          />
        ))}
      </Svg>

      {/* Axis labels as real text, so they scale with the phone's font setting
          rather than being baked into the drawing. */}
      <View
        className="flex-row justify-between"
        style={{ marginLeft: geom.padL, marginRight: 14, marginTop: -18 }}
      >
        <Text className="text-xs text-muted-foreground">{data[0]?.label}</Text>
        {data.length > 2 ? (
          <Text className="text-xs text-muted-foreground">
            {data[Math.floor(last / 2)]?.label}
          </Text>
        ) : null}
        <Text className="text-xs text-muted-foreground">{data[last]?.label}</Text>
      </View>

      <View className="mt-2 flex-row justify-between">
        <Text className="text-xs text-muted-foreground">
          Highest {axisMoney(geom.max)}
        </Text>
        <Text className="text-xs" style={{ color: SERIES[0] }}>
          {data[last]?.label} · {shortMoney(data[last]?.revenue ?? 0)}
        </Text>
      </View>
    </View>
  )
}

// ─────────────────────────────────────────────────────────────
// A count per category, as bars
// ─────────────────────────────────────────────────────────────

export interface BarRow {
  label: string
  value: number
  /** Index into SERIES. Fixed per meaning, never per position in the list. */
  colour: number
  hint?: string
}

/**
 * Horizontal bars, not a donut.
 *
 * On a phone a donut asks the eye to compare angles in a 120px circle and to
 * match each slice back to a legend. A bar carries its own name, and length is
 * the one thing people judge accurately.
 */
export function BarList({ rows, width }: { rows: BarRow[]; width: number }) {
  const max = Math.max(1, ...rows.map((r) => r.value))
  const track = Math.max(0, width - 8)
  // Bars run out from the baseline. One shared clock, so they move as a set
  // rather than a queue of separate little animations.
  const t = useDrawInValue(180, 700)

  return (
    <View className="gap-3">
      {rows.map((r) => {
        const w = Math.max(r.value > 0 ? 6 : 0, (r.value / max) * track) * t
        return (
          <View key={r.label}>
            <View className="mb-1 flex-row items-center justify-between">
              <Text className="text-xs text-foreground">{r.label}</Text>
              <Text className="text-xs font-semibold text-foreground">{r.value}</Text>
            </View>
            <Svg width={track} height={8}>
              <Rect x={0} y={0} width={track} height={8} rx={4} fill="#94a3b833" />
              {/* 4px rounded end, anchored to the baseline at x=0. */}
              <Rect x={0} y={0} width={w} height={8} rx={4} fill={SERIES[r.colour % SERIES.length]} />
            </Svg>
            {r.hint ? (
              <Text className="mt-1 text-xs text-muted-foreground">{r.hint}</Text>
            ) : null}
          </View>
        )
      })}
    </View>
  )
}

// ─────────────────────────────────────────────────────────────
// Done against planned
// ─────────────────────────────────────────────────────────────

/**
 * One measure against the target it was set, which is a bullet rather than a
 * chart: the number is the story and the bar only says how far along it is.
 */
export function ProgressRow({
  label,
  achieved,
  target,
  width,
  hint,
}: {
  label: string
  achieved: number
  target: number
  width: number
  hint?: string
}) {
  const pct = target > 0 ? Math.min(1, achieved / target) : 0
  const track = Math.max(0, width - 8)
  const t = useDrawInValue(180, 700)
  // Behind, close, met — the three states anyone actually acts on.
  const colour = target === 0 ? SERIES[0] : pct >= 1 ? SERIES[2] : pct >= 0.8 ? SERIES[1] : SERIES[3]

  return (
    <View>
      <View className="mb-1 flex-row items-center justify-between">
        <Text className="text-xs text-foreground">{label}</Text>
        <Text className="text-xs font-semibold text-foreground">
          {achieved.toLocaleString('en-IN')}
          {target > 0 ? (
            <Text className="text-xs font-normal text-muted-foreground">
              {' '}
              / {target.toLocaleString('en-IN')}
            </Text>
          ) : null}
        </Text>
      </View>
      <Svg width={track} height={8}>
        <Rect x={0} y={0} width={track} height={8} rx={4} fill="#94a3b833" />
        <Rect
          x={0}
          y={0}
          width={Math.max(pct > 0 ? 6 : 0, pct * track) * t}
          height={8}
          rx={4}
          fill={colour}
        />
      </Svg>
      {/* Said in words as well as colour, so the state does not depend on being
          able to tell amber from red. */}
      <Text className="mt-1 text-xs text-muted-foreground">
        {hint ?? (target > 0 ? `${Math.round(pct * 100)}% of target` : 'no target set')}
      </Text>
    </View>
  )
}
