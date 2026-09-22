/**
 * What a report is allowed to say about itself.
 *
 * A report never builds a file. It describes its columns and its filters,
 * and its `run` returns rows plus an analysis. One engine turns that into the
 * picker, the permissions, the CSV and the workbook — so adding a report is
 * one file and one registry line, and the screen and the spreadsheet are the
 * same analysis rendered twice rather than two implementations that drift.
 */

import type { Prisma, PrismaClient } from '@prisma/client'

/** Reports inherit their module's permission rather than inventing one. */
export type ReportModule = 'purchase' | 'sales' | 'inventory' | 'production' | 'accounts' | 'hr'

/**
 * How a column is read, which decides its cell type, its number format and
 * whether the engine will offer to total it.
 *
 * `money` is rupees. `qty` is a quantity in whatever the row's unit is, so it
 * carries no currency symbol. `integer` is a count of things.
 */
export type ColumnType = 'text' | 'money' | 'qty' | 'integer' | 'percent' | 'date' | 'badge'

export interface ReportColumn {
  key: string
  label: string
  type: ColumnType
  /**
   * Printed inside the cell for a quantity — "1,250 mtr" rather than a bare
   * number in a column somebody has to remember the unit of. Ignored for
   * every other type.
   */
  unit?: string
  /** For `badge`: the word to print for each stored value. */
  badges?: Record<string, string>
  /**
   * Whether the Data sheet's last row totals this column.
   *
   * `sum` for money and quantities that add up. `none` for anything that does
   * not — a rate, a percentage, a balance already counted elsewhere. There is
   * no `average`: a mean of a column nobody weighted is a number that looks
   * like an answer and is not one.
   */
  total?: 'sum' | 'none'
  /** Column width in characters. The engine measures if this is absent. */
  width?: number
}

export type FilterType = 'date' | 'select' | 'text' | 'boolean'

export interface ReportFilter {
  key: string
  label: string
  type: FilterType
  required?: boolean
  /** For `select`: where the picker gets its options. */
  optionsFrom?: 'suppliers' | 'customers' | 'items' | 'warehouses' | 'itemCategories'
  /** For `select` with a fixed list. */
  options?: Array<{ value: string; label: string }>
  help?: string
}

// ── The analysis ────────────────────────────────────────────────────────────

/**
 * One headline figure.
 *
 * `value` is null when the figure cannot be computed — no rows, or a division
 * by zero. The engine prints a dash for that and never a nought, because a
 * nought is a claim and a dash is an absence, and an empty period reading
 * "₹0 average" is a lie about a month nobody traded in.
 *
 * `basis` is the denominator, and it is not optional by accident: a figure
 * without one invites the reader to supply their own. "across 47 bills" is
 * the difference between a number and a fact.
 */
export interface Kpi {
  label: string
  value: number | null
  format: 'money' | 'qty' | 'integer' | 'percent' | 'days'
  unit?: string
  /** What the figure is out of. Printed under the value. */
  basis: string
  /** Green for good, amber for watch, red for an exception. Absent is neutral. */
  tone?: 'good' | 'warn' | 'bad'
}

export interface TrendPoint {
  label: string
  value: number
  /** The same measure a year or a period earlier, where there is one. */
  compare?: number | null
}

export interface Trend {
  title: string
  valueLabel: string
  format: 'money' | 'qty' | 'integer'
  points: TrendPoint[]
  compareLabel?: string
  averageLabel?: string
}

/**
 * What question a panel answers, which is what decides its chart.
 *
 * Chosen here, by the report, and never inferred from the data by the
 * builder. Picking a shape from label length or category count means the same
 * question draws two different ways in one workbook, and the reader learns
 * nothing from the shape because the shape means nothing.
 *
 *   trend        movement over time            → line
 *   comparison   fixed categories side by side → clustered column
 *   ranking      who is biggest                → horizontal bar
 *   ageing       how overdue                   → horizontal bar
 *   funnel       stages of one process         → horizontal bar
 *   composition  shares of one whole           → doughnut, 2-5 slices
 */
export type PanelQuestion = 'trend' | 'comparison' | 'ranking' | 'ageing' | 'funnel' | 'composition'

export interface PanelPoint {
  label: string
  value: number
  /** Marks this point as the exception. The only thing that draws red. */
  exception?: boolean
}

export interface Panel {
  title: string
  question: PanelQuestion
  format: 'money' | 'qty' | 'integer' | 'percent'
  points: PanelPoint[]
  /** Printed under the chart. Where a caveat about this panel belongs. */
  note?: string
}

/**
 * The PivotTable a report offers.
 *
 * Declared by the report, for the same reason a panel declares its question:
 * a builder that picked the row field by counting distinct values would group
 * one report by supplier and the next by GSTIN, and the reader would have to
 * work out each time what they were looking at.
 *
 * A report with no `pivot` gets no Pivot sheet. That is the right answer for
 * anything whose rows are already one-per-thing — a pivot over a list with no
 * repeating key is the list again, with a Grand Total nobody asked for.
 */
export interface PivotSpec {
  /** Column key down the left. A `text` or `badge` column. */
  rows: string
  /** Column keys totalled in the body, in order. Each becomes a "Sum of …". */
  values: string[]
  /**
   * Column keys the reader can filter by.
   *
   * These become slicers — the button panels beside the table. Keep it to
   * three or four: a slicer for every column is a wall of buttons that hides
   * the figures it was meant to sit beside.
   */
  slicers?: string[]
  /** One sentence above the table saying what it is for. */
  note?: string
}

/** A grid of figures, drawn as cells rather than as a chart. */
export interface Matrix {
  title: string
  rowLabel: string
  columns: string[]
  rows: Array<{ label: string; values: Array<number | null> }>
  format: 'money' | 'qty' | 'integer' | 'percent'
}

export interface ReportAnalysis {
  /** One sentence naming what the period actually did. */
  headline?: string
  kpis: Kpi[]
  trend?: Trend
  panels: Panel[]
  matrix?: Matrix
  /** What the figures show. Written by the report, not inferred. */
  insights: string[]
  /**
   * What the figures do not show.
   *
   * Never optional and never empty in practice: every report here excludes
   * something — cancelled documents, a period boundary, a status that has no
   * date. A caveat nobody reads is a caveat that did not happen, so they are
   * printed on the Dashboard rather than buried in Notes alone.
   */
  caveats: string[]
}

// ── Running one ─────────────────────────────────────────────────────────────

/** Whatever the picker sent. Validated by the definition, not by the engine. */
export type ReportParams = Record<string, string | undefined>

export interface ReportResult {
  /** One object per row, keyed by column key. */
  rows: Array<Record<string, unknown>>
  analysis: ReportAnalysis
  /**
   * Rows the query found before the cap was applied.
   *
   * Set only when more were found than returned. The engine puts `_PARTIAL`
   * in the file name and the count on the Notes sheet — truncation is allowed,
   * truncating quietly is not.
   */
  totalRows?: number
}

export interface ReportContext {
  prisma: PrismaClient
  /** Everything is read inside one transaction, so the file is one moment. */
  tx: Prisma.TransactionClient
  params: ReportParams
  /** The hard ceiling on rows. A report must not return more. */
  rowCap: number
}

export interface ReportDefinition {
  id: string
  module: ReportModule
  title: string
  description: string
  columns: ReportColumn[]
  filters: ReportFilter[]
  /** The Pivot sheet, where the rows repeat a key worth grouping by. */
  pivot?: PivotSpec
  run: (ctx: ReportContext) => Promise<ReportResult>
}

/**
 * The row ceiling, applied from the first day rather than added after a report
 * fell over.
 *
 * Ten thousand rows of twenty columns is roughly 30MB as plain objects and
 * several times that inside ExcelJS's own model, against a 512MB instance that
 * also serves every other request. The cap is not a business rule and the file
 * says so on its own face when it bites.
 */
export const ROW_CAP = 10_000
