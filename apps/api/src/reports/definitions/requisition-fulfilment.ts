import type { Prisma } from '@prisma/client'
import type { Panel, ReportDefinition } from '../types'
import { dateRangeFilters, periodLabel, round2 } from './shared'
import { daysBetween, pctOf, warehouseFilter } from './inventory-shared'

const r3 = (n: number) => Math.round(n * 1000) / 1000

const STATE = {
  FULL: 'Fully issued',
  PART: 'Part issued',
  WAITING: 'Not issued yet',
  SHORT: 'Closed short',
  REJECTED: 'Rejected',
} as const
type State = keyof typeof STATE

/**
 * How well the stores serve the floor.
 *
 * One row per item asked for: how much was asked, how much was issued, how
 * long the first issue took, and whether it is late against the date it was
 * needed by. The question it answers is not "what is pending" — the
 * Requisitions screen shows that — but how reliably and how quickly the
 * stores deliver, department by department.
 */
export const requisitionFulfilment: ReportDefinition = {
  id: 'requisition-fulfilment',
  module: 'inventory',
  title: 'Requisition Fulfilment',
  description:
    'Each item asked for on a requisition — asked, issued, still owed, days to first issue, late or on time — to measure how fully and how quickly the stores serve each department.',
  filters: [
    ...dateRangeFilters,
    warehouseFilter,
    { key: 'open', label: 'Only lines still owed', type: 'boolean' },
  ],
  columns: [
    { key: 'state', label: 'Status', type: 'badge', width: 14, badges: STATE,
      badgeTones: { FULL: 'good', PART: 'warn', WAITING: 'warn', SHORT: 'neutral', REJECTED: 'bad' } },
    { key: 'mrNumber', label: 'Requisition', type: 'text', width: 16 },
    { key: 'requestDate', label: 'Asked On', type: 'date', width: 14 },
    { key: 'neededBy', label: 'Needed By', type: 'date', width: 14 },
    { key: 'department', label: 'Department', type: 'text', width: 18 },
    { key: 'itemCode', label: 'Item Code', type: 'text', width: 16 },
    { key: 'item', label: 'Item', type: 'text', width: 30 },
    { key: 'styleNo', label: 'Style No.', type: 'text', width: 14 },
    { key: 'store', label: 'Store', type: 'text', width: 18 },
    { key: 'uom', label: 'UOM', type: 'text', width: 8 },
    { key: 'asked', label: 'Asked', type: 'qty', total: 'sum' },
    { key: 'issued', label: 'Issued', type: 'qty', total: 'sum' },
    { key: 'owed', label: 'Still Owed', type: 'qty', total: 'sum' },
    { key: 'filled', label: 'Filled', type: 'percent', total: 'none' },
    { key: 'daysToIssue', label: 'Days to First Issue', type: 'integer', total: 'none' },
    { key: 'daysLate', label: 'Days Late', type: 'integer', total: 'none' },
  ],
  summary: {
    title: 'Latest lines still owed',
    columns: ['mrNumber', 'department', 'item', 'asked', 'owed', 'daysLate'],
    by: 'daysLate',
    limit: 12,
  },
  pivot: {
    rows: ['department', 'state'],
    values: ['asked', 'issued', 'owed'],
    slicers: ['store'],
    note: 'Open a department to see how its lines were served.',
  },

  async run({ tx, params, rowCap }) {
    const from = params.from ? new Date(`${params.from}T00:00:00`) : undefined
    const to = params.to ? new Date(`${params.to}T23:59:59.999`) : undefined
    const now = new Date()

    const where: Prisma.MaterialRequisitionLineWhereInput = {
      ...(params.warehouseId ? { warehouseId: params.warehouseId } : {}),
      mr: from || to ? { requestDate: { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) } } : {},
    }
    const lines = await tx.materialRequisitionLine.findMany({
      where,
      orderBy: [{ mr: { requestDate: 'asc' } }, { mr: { mrNumber: 'asc' } }],
      select: {
        mrId: true,
        itemId: true,
        requestedQty: true,
        issuedQty: true,
        styleNo: true,
        item: { select: { code: true, name: true, uom: { select: { symbol: true } } } },
        warehouse: { select: { name: true } },
        mr: {
          select: {
            mrNumber: true,
            requestDate: true,
            requiredDate: true,
            status: true,
            closedAt: true,
            department: { select: { name: true } },
          },
        },
      },
    })

    // When each requisition's item was first issued.
    const firsts = await tx.stockLedger.groupBy({
      by: ['referenceId', 'itemId'],
      where: { referenceType: 'MATERIAL_REQUISITION', referenceId: { in: [...new Set(lines.map((l) => l.mrId))] }, outQty: { gt: 0 } },
      _min: { transactionDate: true },
    })
    const firstIssue = new Map(firsts.map((f) => [`${f.referenceId}|${f.itemId}`, f._min.transactionDate]))

    const all = lines.map((l) => {
      const asked = Number(l.requestedQty)
      const issued = Number(l.issuedQty)
      const owed = Math.max(0, asked - issued)
      const closed = Boolean(l.mr.closedAt)
      let state: State
      if (l.mr.status === 'REJECTED') state = 'REJECTED'
      else if (owed <= 0.0005) state = 'FULL'
      else if (closed) state = 'SHORT'
      else if (issued > 0) state = 'PART'
      else state = 'WAITING'
      const first = firstIssue.get(`${l.mrId}|${l.itemId}`) ?? null
      const stillOwed = state === 'PART' || state === 'WAITING'
      // Late is measured to when it was fully served, or to today if it is still owed.
      const due = l.mr.requiredDate
      const doneBy = stillOwed ? now : first
      const daysLate = due && doneBy && doneBy > due ? daysBetween(due, doneBy) : 0
      return {
        state,
        mrNumber: l.mr.mrNumber,
        requestDate: l.mr.requestDate,
        neededBy: due,
        department: l.mr.department?.name ?? '',
        itemCode: l.item.code,
        item: l.item.name,
        styleNo: l.styleNo ?? '',
        store: l.warehouse.name,
        uom: l.item.uom?.symbol ?? '',
        asked: r3(asked),
        issued: r3(issued),
        owed: state === 'SHORT' || state === 'REJECTED' ? 0 : r3(owed),
        filled: asked > 0 ? Math.min(1, issued / asked) : 0,
        daysToIssue: first ? daysBetween(l.mr.requestDate, first) : null,
        daysLate,
        stillOwed,
      }
    })
    const shown = all.filter((r) => !params.open || r.stillOwed)
    const rows = shown.slice(0, rowCap).map(({ stillOwed: _s, ...r }) => r)

    const live = all.filter((r) => r.state !== 'REJECTED')
    const full = live.filter((r) => r.state === 'FULL').length
    const owedLines = all.filter((r) => r.stillOwed)
    const late = owedLines.filter((r) => r.daysLate > 0)
    const timed = live.filter((r) => r.daysToIssue !== null)
    const avgDays = timed.length ? round2(timed.reduce((s, r) => s + (r.daysToIssue ?? 0), 0) / timed.length) : null
    const onTime = live.filter((r) => r.neededBy && r.state === 'FULL')
    const onTimeShare = onTime.length ? onTime.filter((r) => r.daysLate === 0).length / onTime.length : null

    const depts = [...new Set(live.map((r) => r.department || 'No department'))]
    const deptStats = depts.map((d) => {
      const mine = live.filter((r) => (r.department || 'No department') === d)
      const t = mine.filter((r) => r.daysToIssue !== null)
      return {
        d,
        fill: mine.length ? mine.filter((r) => r.state === 'FULL').length / mine.length : 0,
        days: t.length ? t.reduce((s, r) => s + (r.daysToIssue ?? 0), 0) / t.length : 0,
        owed: mine.filter((r) => r.stillOwed).length,
      }
    })

    const insights: string[] = []
    if (live.length) insights.push(`${pctOf(full, live.length)} of the ${live.length} lines asked for were issued in full.`)
    if (avgDays !== null) insights.push(`The first issue took ${avgDays} days on average from the day it was asked.`)
    if (late.length) insights.push(`${late.length} lines still owed are past the date they were needed by, the oldest by ${Math.max(...late.map((r) => r.daysLate))} days.`)
    const slowest = [...deptStats].sort((a, b) => b.days - a.days)[0]
    if (slowest && deptStats.length > 1 && slowest.days > 0) insights.push(`${slowest.d} waits longest, ${slowest.days.toFixed(1)} days to a first issue.`)

    return {
      rows,
      totalRows: shown.length > rowCap ? shown.length : undefined,
      analysis: {
        headline: live.length
          ? `${pctOf(full, live.length)} of requisition lines filled in full, ${periodLabel(params).toLowerCase()}; ${owedLines.length} still owed.`
          : 'No requisitions were raised in this period.',
        kpis: [
          { label: 'Fill rate', value: live.length ? full / live.length : null, format: 'percent', basis: `lines issued in full, of ${live.length}` },
          { label: 'Days to first issue', value: avgDays, format: 'days', basis: `average over ${timed.length} lines` },
          { label: 'Issued on time', value: onTimeShare, format: 'percent', basis: 'by the needed-by date, where one was given' },
          { label: 'Lines still owed', value: owedLines.length, format: 'integer', basis: 'part issued or waiting' },
        ],
        exceptions: late.length
          ? [{ label: 'Owed and late', value: late.length, format: 'integer', basis: 'past their needed-by date', tone: 'bad' }]
          : [],
        panels: (
          [
            {
              title: 'Requisition lines by status',
              question: 'funnel',
              format: 'integer',
              points: (['FULL', 'PART', 'WAITING', 'SHORT', 'REJECTED'] as State[]).map((s) => ({
                label: STATE[s],
                value: all.filter((r) => r.state === s).length,
                tone: s === 'FULL' ? 'good' : s === 'REJECTED' ? 'bad' : s === 'SHORT' ? 'neutral' : 'warn',
              })),
            },
            {
              title: 'Fill rate by department',
              question: 'comparison',
              format: 'percent',
              points: deptStats.map((d) => ({ label: d.d, value: round2(d.fill * 100) / 100 })),
            },
            {
              title: 'Average days to first issue, by department',
              question: 'ranking',
              format: 'integer',
              points: deptStats.map((d) => ({ label: d.d, value: round2(d.days) })).sort((a, b) => b.value - a.value),
            },
          ] as Panel[]
        ).filter((p) => p.points.some((x) => x.value > 0)),
        insights,
        caveats: [
          'The period is the date the requisition was raised.',
          'Rejected requisitions are counted in the status chart but left out of the fill rate.',
          '"Closed short" lines were closed with something still owed, on purpose; they are not counted as owed.',
          'Days late runs to the day the item was first issued, or to today if it is still owed.',
        ],
      },
    }
  },
}
