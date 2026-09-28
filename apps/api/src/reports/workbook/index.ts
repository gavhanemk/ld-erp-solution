import ExcelJS from 'exceljs'
import type { ReportAnalysis, ReportDefinition, ReportParams, ReportResult } from '../types'
import { buildDashboard } from './dashboard'
import { buildData } from './data'
import { buildNotes } from './notes'
import { buildPivot } from './pivot'
import { injectOoxml } from '../ooxml/inject'
import type { AppliedFilter } from '../filters'

/**
 * Turns one report's result into a workbook.
 *
 * The order is the whole design. Everything that writes *cells* happens first,
 * through ExcelJS. Only once the workbook is serialised does anything touch
 * XML, and then it adds parts rather than rewriting them — so no step after
 * the serialise can change a number, which is how a total ends up disagreeing
 * between the Data sheet and the Dashboard.
 */
export async function buildWorkbook(opts: {
  def: ReportDefinition
  result: ReportResult
  params: ReportParams
  runBy: string
  periodLabel: string
  /** What the reader asked for, already resolved to names. */
  appliedFilters?: AppliedFilter[]
}): Promise<{ buffer: Buffer; chartCount: number; pivotCount: number; partial: boolean }> {
  const { def, result, params, runBy, periodLabel, appliedFilters = [] } = opts
  const meta = {
    runBy,
    runAt: new Date(),
    periodLabel,
    appliedFilters,
    rowCount: result.rows.length,
    truncatedFrom:
      result.totalRows && result.totalRows > result.rows.length ? result.totalRows : undefined,
  }

  const wb = new ExcelJS.Workbook()
  wb.creator = 'LD Cotton Mills ERP'
  wb.created = meta.runAt

  // 1 — ordinary workbook building. Dashboard first, so it opens on it, then
  //     the Pivot to work in, then the rows it all comes from, then Notes.
  const specs = buildDashboard(wb, def, result.analysis, params, meta, result.rows)
  const pivot = buildPivot(wb, def, result.rows)
  buildData(wb, def, result.rows)
  buildNotes(wb, def, result.analysis, params, meta)

  // 2 — a real .xlsx buffer
  const serialised = Buffer.from(await wb.xlsx.writeBuffer())

  // 3 — open THAT zip and add the parts no library here can write
  const buffer = await injectOoxml(serialised, {
    chartSheet: 'Dashboard',
    charts: specs,
    pivots: pivot ? [pivot] : [],
  })

  return {
    buffer,
    chartCount: specs.length,
    pivotCount: pivot ? 1 : 0,
    partial: Boolean(meta.truncatedFrom),
  }
}

/**
 * The same rows as a CSV.
 *
 * Built from the same columns the workbook uses, so the two cannot describe
 * different tables. A BOM, because without it a rupee sign and any supplier
 * name outside plain ASCII open as mojibake on a Windows desk.
 */
export function buildCsv(def: ReportDefinition, rows: Array<Record<string, unknown>>): string {
  const cell = (v: unknown): string => {
    if (v == null) return ''
    if (v instanceof Date) {
      const pad = (n: number) => String(n).padStart(2, '0')
      return `${v.getFullYear()}-${pad(v.getMonth() + 1)}-${pad(v.getDate())}`
    }
    const s = String(v)
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
  }

  const lines = [
    def.columns.map((c) => cell(c.label)).join(','),
    ...rows.map((r) =>
      def.columns
        .map((c) =>
          cell(c.type === 'badge' ? (c.badges?.[String(r[c.key])] ?? r[c.key]) : r[c.key])
        )
        .join(',')
    ),
  ]
  return '﻿' + lines.join('\r\n')
}

export type { ReportAnalysis }
