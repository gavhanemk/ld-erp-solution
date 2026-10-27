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
  /**
   * For a `qty` whose unit changes from row to row — metres on one line,
   * pieces on the next: the column holding each row's unit.
   *
   * A register's totals add such a quantity up unit by unit, never into one
   * figure. Ignored for every other type.
   */
  unitKey?: string
  /** For `badge`: the word to print for each stored value. */
  badges?: Record<string, string>
  /**
   * For `badge`: what each stored value means, which tints its cell.
   *
   * Declared, never inferred from the word. "Closed" is good on an order and
   * bad on a complaint, and a builder guessing from the text would be right
   * until the day it silently was not.
   */
  badgeTones?: Record<string, Tone>
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
  /** For `select`: what choosing nothing means, when it is not "All …". */
  emptyLabel?: string
  /** For `select`: a box wide enough for long choices. */
  wide?: boolean
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
 *   split        what each category is made of → stacked bar
 *   pareto       how few names make up the most→ column plus a running share
 */
export type PanelQuestion =
  | 'trend'
  | 'comparison'
  | 'ranking'
  | 'ageing'
  | 'funnel'
  | 'composition'
  | 'split'
  | 'pareto'

/**
 * What a bar, a slice or a segment MEANS — which is the only thing allowed to
 * decide its colour.
 *
 * One hue everywhere is drab; a different hue per chart is noise. Both were
 * tried here. The way out is that colour carries meaning and is constant
 * across every report in the ERP, so a reader learns it once:
 *
 *   good     finished, received, settled, in stock
 *   normal   the ordinary measure — the house teal
 *   info     a neutral stage or a total being broken down
 *   warn     pending, outstanding, waiting on somebody
 *   bad      overdue, refused, cancelled — an exception needing a decision
 *   neutral  a remainder, an "everyone else", a draft
 *
 * Absent means `normal`. A ranking of suppliers is a list of equals and stays
 * one colour on purpose: colouring it by rank would encode the bar's own
 * length a second time.
 */
export type Tone = 'good' | 'normal' | 'info' | 'warn' | 'bad' | 'neutral'

export interface PanelPoint {
  label: string
  value: number
  /** What this point means. Decides its colour. */
  tone?: Tone
  /**
   * Marks this point as the exception.
   *
   * Kept as a shorthand for `tone: 'bad'` because it reads better at the call
   * site for the thing it is usually used for — the one overdue band in an
   * ageing chart.
   */
  exception?: boolean
}

export interface Panel {
  title: string
  question: PanelQuestion
  format: 'money' | 'qty' | 'integer' | 'percent'
  points: PanelPoint[]
  /**
   * For `split`: what each category divides into, drawn as stacked segments.
   *
   * `points[i].value` stays the category's total, so a panel whose split
   * cannot be computed still draws as a plain bar of totals rather than as
   * nothing at all. The segments must be in a fixed order decided by the
   * report — segments ordered by size would reshuffle between two periods and
   * the colours would stop meaning anything.
   */
  series?: Array<{ name: string; values: Array<number | null>; tone?: Tone }>
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
  /**
   * Column key(s) down the left, outermost first.
   *
   * More than one nests them, so the reader can collapse the outer level and
   * read a subtotal off it — a date with suppliers under it, rather than a
   * flat list of every supplier-day.
   */
  rows: string | string[]
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

/**
 * One line of the Needs Attention block.
 *
 * The difference between this and a KPI is what the reader is meant to do.
 * A KPI is the position — ₹32 lakh billed, 47 bills. An exception is a
 * decision somebody has to take: money past its due date, goods refused at
 * the gate, an order nobody has chased in two months. A dashboard where both
 * sit in the same band makes the reader work out which is which every time,
 * and on a busy morning they will not.
 *
 * `value` is null when the figure cannot be computed. An exception with
 * nothing in it is not listed at all — a block of noughts trains the reader
 * that the block is decorative.
 */
export interface Exception {
  label: string
  value: number | null
  format: 'money' | 'qty' | 'integer' | 'percent' | 'days'
  unit?: string
  /** What it is out of, or what to do about it. */
  basis: string
  /** Amber for watch, red for act. Nothing here is neutral. */
  tone: 'warn' | 'bad'
}

export interface ReportAnalysis {
  /** One sentence naming what the period actually did. */
  headline?: string
  kpis: Kpi[]
  /**
   * What needs a decision rather than a reading.
   *
   * Printed in its own block, above the charts on screen and on the sheet —
   * a reader who looks at nothing else should still see these.
   */
  exceptions?: Exception[]
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
  /**
   * The dashboard's figures. A register has none: it is read as a ledger,
   * and its only figures are the totals at the foot of its columns.
   */
  analysis?: ReportAnalysis
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

/**
 * The management table at the foot of the Dashboard.
 *
 * Not the first twenty rows — the biggest twenty. A manager reading a single
 * page wants the orders that account for the money, and the first rows of a
 * date-sorted register are just the oldest ones. Every row is still on the
 * Data sheet; this is the extract that fits on the page somebody prints.
 *
 * `columns` has to fit across twelve, so it is chosen rather than inherited:
 * a register with twenty columns would run off the sheet and wrap into
 * something unreadable.
 */
export interface SummaryTable {
  /** Heading above it. Says what "top" means here. */
  title: string
  /** Column keys, in order. Six or seven at most. */
  columns: string[]
  /** Column key to order by, biggest first. */
  by: string
  /** How many rows. Twelve unless said otherwise. */
  limit?: number
}

/**
 * One printed column of a register: a figure, with a second one set small
 * under it where the two are read together — the date under a bill number,
 * the GSTIN under a supplier.
 *
 * Stacking is what lets a register with a dozen money columns fit across one
 * landscape page without shrinking every figure to nothing.
 */
export interface RegisterColumn {
  key: string
  /** Printed under it, one small line each; an empty one is skipped. */
  sub?: string[]
  /**
   * A second figure of equal weight printed under this one, at full size —
   * SGST under CGST, which are always the same amount on the same bill. A
   * total adds each up on its own line.
   */
  under?: string
  underLabel?: string
  /** The heading. Defaults to the column's own label. */
  label?: string
  subLabel?: string
  /**
   * A name that may run onto a second line. Everything else — figures,
   * dates, numbers, codes — stays on one: "PB-2627-" over "0002" is two
   * halves of a number nobody can search for.
   */
  wrap?: boolean
  /** A party's or an item's name: given room for a few words before it wraps. */
  wide?: boolean
}

/**
 * How a report prints as a register — the accounts team's ledger page, and
 * the first thing every report opens on.
 *
 * A register's rows are lines. Where several lines belong to one document —
 * the items of one bill — what belongs to the line (the item, its quantity
 * and rate) prints on every line, and what belongs to the document (its
 * number, party and totals) prints once, on its first line, so a bill of four
 * items reads as one bill.
 *
 * Every report has one. A report says only what differs from the plain
 * default, in which each row stands alone, every column prints, an item's
 * code sits under its name and a quantity carries its unit; `resolveRegister`
 * fills in the rest. Its export is the register on one sheet and its PDF is
 * the same sheet printed; the dashboard is a second tab, for whoever wants it.
 */
export interface RegisterOptions {
  /** The column all of one document's lines share. Absent: every row stands alone. */
  documentKey?: string
  /** What one document is called on the totals line: "1 bill", "47 bills". */
  noun?: { one: string; many: string }
  /**
   * The columns that belong to the document, printed on its first line only.
   * Ignored without a `documentKey`.
   */
  documentColumns?: string[]
  /**
   * Or the other way round: the columns that belong to the line, every other
   * column belonging to the document. Takes precedence over `documentColumns`.
   */
  lineKeys?: string[]
  /** What prints, left to right, on screen and on paper. Absent: worked out from the columns. */
  print?: RegisterColumn[]
  /** A text column printed as a note under a document's lines, when it has one. */
  noteKey?: string
  /**
   * The badge value marking a void document — cancelled, say. It is listed,
   * so the numbering has no gaps, and carries no figures, so no total can
   * count it.
   */
  void?: { key: string; value: string; word: string }
  /**
   * The date column whose months the register subtotals by. Absent: the
   * first column, when that is a date. `false`: no month totals.
   */
  monthKey?: string | false
}

/** A register with every default filled in — what the engine and the screen work from. */
export interface RegisterSpec {
  /** Empty when every row stands alone. */
  documentKey: string
  noun: { one: string; many: string }
  lineKeys: string[]
  print: RegisterColumn[]
  noteKey?: string
  void?: { key: string; value: string; word: string }
  /** Empty when the register has no month totals. */
  monthKey: string
}

export interface ReportDefinition {
  id: string
  module: ReportModule
  title: string
  description: string
  columns: ReportColumn[]
  /** The extract printed at the foot of the Dashboard sheet. */
  summary?: SummaryTable
  filters: ReportFilter[]
  /** The Pivot sheet, where the rows repeat a key worth grouping by. */
  pivot?: PivotSpec
  /** How the report prints as a register, where it differs from the default. */
  register?: RegisterOptions
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
