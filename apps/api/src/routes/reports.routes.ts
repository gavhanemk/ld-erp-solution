import { Router } from 'express'
import { prisma } from '@ld-erp/database'
import { AppError } from '../middleware/errorHandler'
import { userCan, type AuthRequest } from '../middleware/auth'
import { REPORTS, findReport } from '../reports/registry'
import { ROW_CAP, type ReportParams, type ReportResult } from '../reports/types'
import { periodLabel } from '../reports/definitions/shared'
import { buildCsv } from '../reports/workbook'
import { describeFilters, type AppliedFilter } from '../reports/filters'
import { countsInWords } from '../reports/wording'
import {
  COMPANY_SELECT,
  letterhead,
  registerTotals,
  resolveColumns,
  resolveRegister,
  type RegisterCompany,
} from '../reports/register'
import { buildRegisterWorkbook } from '../reports/workbook/register'
import { summaryGrids } from '../reports/summary'

const router = Router()

/**
 * The picker.
 *
 * Only the reports whose module this person may view. A report inherits its
 * module's permission rather than carrying one of its own — a purchase clerk
 * who can see purchase orders can see a report about them, and nobody has to
 * remember to grant a second thing.
 */
router.get('/', async (req: AuthRequest, res) => {
  const allowed = REPORTS.filter((r) => userCan(req.user, r.module, 'view'))

  res.json({
    success: true,
    data: allowed.map((r) => ({
      id: r.id,
      module: r.module,
      title: r.title,
      description: r.description,
      filters: r.filters,
      columns: r.columns.map((c) => ({ key: c.key, label: c.label, type: c.type, unit: c.unit })),
      /** Read by the on-screen pivot table for which fields to default to. */
      pivot: r.pivot ? { rows: r.pivot.rows, values: r.pivot.values } : undefined,
    })),
  })
})

/**
 * Runs one report inside a single transaction.
 *
 * The transaction is the point. A report assembled from many reads of a live
 * table is true of no single moment — a row inserted halfway through can be
 * counted twice and one deleted can vanish from a total it was part of, and
 * nothing in the finished file would say so.
 */
async function runReport(
  id: string,
  params: ReportParams
): Promise<{ result: ReportResult; applied: AppliedFilter[]; company: RegisterCompany | null }> {
  const def = findReport(id)
  if (!def) throw new AppError('No such report', 404, 'NOT_FOUND')

  for (const f of def.filters) {
    if (f.required && !params[f.key]) {
      throw new AppError(`${f.label} is required for this report`, 400, 'FILTER_REQUIRED')
    }
  }

  // The filter names are resolved inside the same transaction as the rows, so
  // the caption cannot describe a supplier who was renamed halfway through.
  const out = await prisma.$transaction(
    async (tx) => ({
      result: await def.run({ prisma, tx, params, rowCap: ROW_CAP }),
      applied: await describeFilters(def, params, tx),
      // Every report prints under the letterhead, as the old ERP's registers did.
      company: await tx.company.findFirst({ select: COMPANY_SELECT }),
    }),
    { timeout: 120_000, maxWait: 15_000 }
  )
  // "across 1 bills" reads as "across 1 bill", on screen and in the workbook alike.
  out.result.analysis = countsInWords(out.result.analysis)
  return out
}

function guard(id: string, req: AuthRequest) {
  const def = findReport(id)
  if (!def) throw new AppError('No such report', 404, 'NOT_FOUND')
  if (!userCan(req.user, def.module, 'view')) {
    throw new AppError(`Your role does not allow viewing ${def.module} reports.`, 403, 'FORBIDDEN')
  }
  return def
}

/** The analysis on its own, for the screen. Same `run`, so no second total. */
router.get('/:id/run', async (req: AuthRequest, res) => {
  const def = guard(req.params.id, req)
  const params = req.query as ReportParams
  const { result, applied, company } = await runReport(def.id, params)
  const columns = resolveColumns(def)
  const spec = resolveRegister(def, columns)
  const totals = registerTotals(def, result.rows, columns, spec)

  res.json({
    success: true,
    data: {
      report: { id: def.id, title: def.title, description: def.description },
      periodLabel: periodLabel(params),
      appliedFilters: applied,
      /** The Summary tab: KPIs, charts and the rest of the dashboard. */
      analysis: result.analysis,
      rowCount: result.rows.length,
      totalRows: result.totalRows ?? result.rows.length,
      truncated: Boolean(result.totalRows && result.totalRows > result.rows.length),
      columns,
      /**
       * The Report tab: how the register prints, and its totals — worked out
       * here, once, so the screen, the PDF and the workbook all print the
       * same figures.
       */
      register: {
        spec,
        totals,
        /** The Summary tab's tables — the same ones the workbook's Summary sheet holds. */
        summary: summaryGrids(def, result.rows, columns, spec, totals.grand),
        letterhead: letterhead(company),
        generatedAt: new Date().toISOString(),
        generatedBy: req.user?.name ?? null,
      },
      /**
       * Every row the query returned, capped the same way the export is.
       *
       * The register prints all of them, and the Summary tab's totals by
       * group regroup over the same rows — a cross-tab built from the first
       * hundred of a register sorted by date would silently answer for a
       * fortnight while claiming to answer for the quarter that was asked for.
       */
      rows: result.rows,
    },
  })
})

/**
 * The files.
 *
 * `xlsx` is the workbook of two sheets — Summary, the report screen's
 * Summary tab in figures, and Data, the detailed report — and nothing else.
 * `csv` is the rows for another system.
 */
router.get('/:id/export', async (req: AuthRequest, res) => {
  const def = guard(req.params.id, req)
  const format = req.query.format === 'csv' ? 'csv' : 'xlsx'
  const params = req.query as ReportParams
  const { result, applied, company } = await runReport(def.id, params)

  const stamp = new Date().toISOString().slice(0, 10)
  const partial = Boolean(result.totalRows && result.totalRows > result.rows.length)
  const name = `${def.id}${partial ? '_PARTIAL' : ''}-${stamp}.${format}`

  if (format === 'csv') {
    res.setHeader('Content-Type', 'text/csv; charset=utf-8')
    res.setHeader('Content-Disposition', `attachment; filename="${name}"`)
    res.send(buildCsv(def, result.rows))
    return
  }

  const columns = resolveColumns(def)
  const spec = resolveRegister(def, columns)
  const totals = registerTotals(def, result.rows, columns, spec)
  const buffer = await buildRegisterWorkbook({
    def,
    columns,
    spec,
    rows: result.rows,
    totals,
    analysis: result.analysis,
    grids: summaryGrids(def, result.rows, columns, spec, totals.grand),
    company,
    periodLabel: periodLabel(params),
    appliedFilters: applied,
    runBy: req.user?.name ?? 'Unknown',
    truncatedFrom: partial ? result.totalRows : undefined,
  })
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
  res.setHeader('Content-Disposition', `attachment; filename="${name}"`)
  // Measured off the finished file, not predicted from the row count.
  res.setHeader('Content-Length', String(buffer.length))
  res.setHeader('X-Report-Charts', '0')
  res.setHeader('X-Report-Pivots', '0')
  res.setHeader('X-Report-Rows', String(result.rows.length))
  res.send(buffer)
})

export default router
