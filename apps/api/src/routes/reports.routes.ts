import { Router } from 'express'
import { prisma } from '@ld-erp/database'
import { AppError } from '../middleware/errorHandler'
import { userCan, type AuthRequest } from '../middleware/auth'
import { REPORTS, findReport } from '../reports/registry'
import { ROW_CAP, type ReportParams, type ReportResult } from '../reports/types'
import { periodLabel } from '../reports/definitions/shared'
import { buildCsv, buildWorkbook } from '../reports/workbook'
import { describeFilters, type AppliedFilter } from '../reports/filters'

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
): Promise<{ result: ReportResult; applied: AppliedFilter[] }> {
  const def = findReport(id)
  if (!def) throw new AppError('No such report', 404, 'NOT_FOUND')

  for (const f of def.filters) {
    if (f.required && !params[f.key]) {
      throw new AppError(`${f.label} is required for this report`, 400, 'FILTER_REQUIRED')
    }
  }

  // The filter names are resolved inside the same transaction as the rows, so
  // the caption cannot describe a supplier who was renamed halfway through.
  return prisma.$transaction(
    async (tx) => ({
      result: await def.run({ prisma, tx, params, rowCap: ROW_CAP }),
      applied: await describeFilters(def, params, tx),
    }),
    { timeout: 120_000, maxWait: 15_000 }
  )
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
  const { result, applied } = await runReport(def.id, params)

  res.json({
    success: true,
    data: {
      report: { id: def.id, title: def.title, description: def.description },
      periodLabel: periodLabel(params),
      appliedFilters: applied,
      analysis: result.analysis,
      rowCount: result.rows.length,
      totalRows: result.totalRows ?? result.rows.length,
      truncated: Boolean(result.totalRows && result.totalRows > result.rows.length),
      columns: def.columns,
      /** The first 100, for the plain table underneath. */
      preview: result.rows.slice(0, 100),
      /**
       * Every row the query returned, capped the same way the export is.
       *
       * The on-screen pivot table regroups over this rather than the preview
       * — a cross-tab built from the first 100 rows of a register sorted by
       * date would silently answer for a fortnight while claiming to answer
       * for the quarter that was actually asked for.
       */
      rows: result.rows,
    },
  })
})

router.get('/:id/export', async (req: AuthRequest, res) => {
  const def = guard(req.params.id, req)
  const format = req.query.format === 'csv' ? 'csv' : 'xlsx'
  const params = req.query as ReportParams
  const { result, applied } = await runReport(def.id, params)

  const stamp = new Date().toISOString().slice(0, 10)
  const partial = Boolean(result.totalRows && result.totalRows > result.rows.length)
  const name = `${def.id}${partial ? '_PARTIAL' : ''}-${stamp}.${format}`

  if (format === 'csv') {
    res.setHeader('Content-Type', 'text/csv; charset=utf-8')
    res.setHeader('Content-Disposition', `attachment; filename="${name}"`)
    res.send(buildCsv(def, result.rows))
    return
  }

  const { buffer, chartCount, pivotCount } = await buildWorkbook({
    def,
    result,
    params,
    runBy: req.user?.name ?? 'Unknown',
    periodLabel: periodLabel(params),
    appliedFilters: applied,
  })

  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
  res.setHeader('Content-Disposition', `attachment; filename="${name}"`)
  // Measured off the finished file, not predicted from the row count.
  res.setHeader('Content-Length', String(buffer.length))
  res.setHeader('X-Report-Charts', String(chartCount))
  res.setHeader('X-Report-Pivots', String(pivotCount))
  res.setHeader('X-Report-Rows', String(result.rows.length))
  res.send(buffer)
})

export default router
