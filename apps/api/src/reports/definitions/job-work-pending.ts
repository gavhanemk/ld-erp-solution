import type { Prisma } from '@prisma/client'
import type { Panel, ReportDefinition } from '../types'
import { dateRangeFilters, periodLabel, round2 } from './shared'
import { daysBetween, pctOf, rupees } from './inventory-shared'

const r3 = (n: number) => Math.round(n * 1000) / 1000

/**
 * Material with job workers: what went, what came back, what was lost.
 *
 * One row per item sent on a challan. Pending is what the job worker has not
 * yet accounted for; wastage is what they accounted for but could not
 * return. A unit losing five per cent every time, or holding cloth for two
 * months, is a conversation somebody needs to have — this is where it shows.
 */
export const jobWorkPending: ReportDefinition = {
  id: 'job-work-pending',
  module: 'inventory',
  title: 'Job Work Material',
  description:
    'Material sent to job workers — sent, accounted for, returned, wasted and still with them — with days out, overdue challans and wastage by job worker.',
  filters: [
    ...dateRangeFilters,
    { key: 'jobWorkerId', label: 'Job worker', type: 'select', optionsFrom: 'suppliers' },
    { key: 'all', label: 'Include settled challans', type: 'boolean' },
  ],
  columns: [
    { key: 'status', label: 'Status', type: 'badge', width: 14,
      badges: { OVERDUE: 'Overdue', OUT: 'With job worker', DONE: 'Settled' },
      badgeTones: { OVERDUE: 'bad', OUT: 'warn', DONE: 'good' } },
    { key: 'challanNumber', label: 'Challan', type: 'text', width: 16 },
    { key: 'challanDate', label: 'Sent On', type: 'date', width: 14 },
    { key: 'jobWorker', label: 'Job Worker', type: 'text', width: 24 },
    { key: 'process', label: 'Process', type: 'text', width: 16 },
    { key: 'itemCode', label: 'Item Code', type: 'text', width: 16 },
    { key: 'item', label: 'Item Sent', type: 'text', width: 28 },
    { key: 'uom', label: 'UOM', type: 'text', width: 8 },
    { key: 'sent', label: 'Sent', type: 'qty', total: 'sum' },
    { key: 'settled', label: 'Accounted For', type: 'qty', total: 'sum' },
    { key: 'wasted', label: 'Wasted', type: 'qty', total: 'sum' },
    { key: 'pending', label: 'Still With Them', type: 'qty', total: 'sum' },
    { key: 'wastage', label: 'Wastage %', type: 'percent', total: 'none' },
    { key: 'pendingValue', label: 'Value With Them', type: 'money', total: 'sum' },
    { key: 'expectedBack', label: 'Expected Back', type: 'date', width: 14 },
    { key: 'daysOut', label: 'Days Out', type: 'integer', total: 'none' },
  ],
  summary: {
    title: 'Most value still with job workers',
    columns: ['challanNumber', 'jobWorker', 'item', 'pending', 'pendingValue', 'daysOut'],
    by: 'pendingValue',
    limit: 12,
  },
  pivot: {
    rows: ['jobWorker', 'process'],
    values: ['sent', 'wasted', 'pending', 'pendingValue'],
    slicers: ['status'],
    note: 'Open a job worker to see each process they do for us.',
  },

  async run({ tx, params, rowCap }) {
    const from = params.from ? new Date(`${params.from}T00:00:00`) : undefined
    const to = params.to ? new Date(`${params.to}T23:59:59.999`) : undefined
    const now = new Date()

    const where: Prisma.JobWorkChallanLineWhereInput = {
      challan: {
        status: { not: 'CANCELLED' },
        ...(params.jobWorkerId ? { jobWorkerId: params.jobWorkerId } : {}),
        ...(from || to ? { challanDate: { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) } } : {}),
      },
    }
    const lines = await tx.jobWorkChallanLine.findMany({
      where,
      orderBy: { challan: { challanDate: 'asc' } },
      select: {
        qty: true,
        unitRate: true,
        item: { select: { code: true, name: true, uom: { select: { symbol: true } } } },
        challan: {
          select: { challanNumber: true, challanDate: true, process: true, expectedBackOn: true, jobWorker: { select: { name: true } } },
        },
        returnLines: { select: { consumedQty: true, wastedQty: true, jobWorkReturn: { select: { returnDate: true } } } },
      },
    })

    const all = lines.map((l) => {
      const sent = Number(l.qty)
      const settled = l.returnLines.reduce((s, r) => s + Number(r.consumedQty), 0)
      const wasted = l.returnLines.reduce((s, r) => s + Number(r.wastedQty), 0)
      const pending = Math.max(0, sent - settled)
      const lastBack = l.returnLines.reduce<Date | null>((m, r) => (!m || r.jobWorkReturn.returnDate > m ? r.jobWorkReturn.returnDate : m), null)
      const open = pending > 0.0005
      const overdue = open && l.challan.expectedBackOn != null && l.challan.expectedBackOn < now
      return {
        status: overdue ? 'OVERDUE' : open ? 'OUT' : 'DONE',
        challanNumber: l.challan.challanNumber,
        challanDate: l.challan.challanDate,
        jobWorker: l.challan.jobWorker.name,
        process: l.challan.process,
        itemCode: l.item.code,
        item: l.item.name,
        uom: l.item.uom?.symbol ?? '',
        sent: r3(sent),
        settled: r3(settled),
        wasted: r3(wasted),
        pending: r3(pending),
        wastage: settled > 0 ? wasted / settled : null,
        pendingValue: round2(pending * Number(l.unitRate ?? 0)),
        expectedBack: l.challan.expectedBackOn,
        daysOut: daysBetween(l.challan.challanDate, open ? now : (lastBack ?? now)),
        wastedValue: round2(wasted * Number(l.unitRate ?? 0)),
      }
    })
    const shown = all.filter((r) => params.all || r.status !== 'DONE')
    const rows = shown.slice(0, rowCap).map(({ wastedValue: _w, ...r }) => r)

    const open = all.filter((r) => r.status !== 'DONE')
    const withThem = round2(open.reduce((s, r) => s + r.pendingValue, 0))
    const overdue = all.filter((r) => r.status === 'OVERDUE')
    const settledAll = all.reduce((s, r) => s + r.settled, 0)
    const wastedAll = all.reduce((s, r) => s + r.wasted, 0)
    const wastedValue = round2(all.reduce((s, r) => s + r.wastedValue, 0))

    const workers = [...new Set(all.map((r) => r.jobWorker))]
    const perWorker = workers.map((w) => {
      const mine = all.filter((r) => r.jobWorker === w)
      const s = mine.reduce((t, r) => t + r.settled, 0)
      return {
        w,
        value: round2(mine.filter((r) => r.status !== 'DONE').reduce((t, r) => t + r.pendingValue, 0)),
        wastage: s > 0 ? mine.reduce((t, r) => t + r.wasted, 0) / s : 0,
      }
    })
    const bands = [
      { label: 'Up to 15 days', max: 15 },
      { label: '16–30 days', max: 30 },
      { label: '31–60 days', max: 60 },
      { label: 'Over 60 days', max: Infinity },
    ]

    const insights: string[] = []
    if (withThem) insights.push(`${rupees(withThem)} of our material is with ${new Set(open.map((r) => r.jobWorker)).size} job workers right now.`)
    if (overdue.length) insights.push(`${overdue.length} lines are past their expected return date, holding ${rupees(overdue.reduce((s, r) => s + r.pendingValue, 0))}.`)
    if (settledAll > 0) insights.push(`Overall wastage is ${pctOf(wastedAll, settledAll)} of material accounted for, worth ${rupees(wastedValue)}.`)
    const worst = [...perWorker].filter((p) => p.wastage > 0).sort((a, b) => b.wastage - a.wastage)[0]
    if (worst && perWorker.length > 1) insights.push(`${worst.w} has the highest wastage at ${(worst.wastage * 100).toFixed(1)}%.`)

    return {
      rows,
      totalRows: shown.length > rowCap ? shown.length : undefined,
      analysis: {
        headline: all.length
          ? withThem
            ? `${rupees(withThem)} of material is still with job workers; ${overdue.length} lines overdue.`
            : 'Everything sent to job workers has been accounted for.'
          : `No job work was sent, ${periodLabel(params).toLowerCase()}.`,
        kpis: [
          { label: 'Value with job workers', value: all.length ? withThem : null, format: 'money', basis: `${open.length} lines still out` },
          { label: 'Challans open', value: all.length ? new Set(open.map((r) => r.challanNumber)).size : null, format: 'integer', basis: `of ${new Set(all.map((r) => r.challanNumber)).size} sent` },
          { label: 'Wastage', value: settledAll ? wastedAll / settledAll : null, format: 'percent', basis: 'of material accounted for' },
          { label: 'Value wasted', value: wastedValue || null, format: 'money', basis: 'at the rate it was sent at' },
        ],
        exceptions: overdue.length
          ? [{ label: 'Overdue with job workers', value: round2(overdue.reduce((s, r) => s + r.pendingValue, 0)), format: 'money', basis: `${overdue.length} lines past the expected date — chase them`, tone: 'bad' }]
          : [],
        panels: (
          [
            { title: 'Value still with each job worker', question: 'ranking', format: 'money', points: perWorker.map((p) => ({ label: p.w, value: p.value })).sort((a, b) => b.value - a.value) },
            {
              title: 'How long material has been out',
              question: 'ageing',
              format: 'money',
              points: bands.map((b, i) => ({
                label: b.label,
                value: round2(open.filter((r) => r.daysOut <= b.max && r.daysOut > (i ? bands[i - 1].max : -1)).reduce((s, r) => s + r.pendingValue, 0)),
                tone: i >= 2 ? 'bad' : i === 1 ? 'warn' : 'normal',
              })),
            },
            { title: 'Wastage by job worker', question: 'comparison', format: 'percent', points: perWorker.map((p) => ({ label: p.w, value: round2(p.wastage * 10000) / 10000 })) },
          ] as Panel[]
        ).filter((p) => p.points.some((x) => x.value > 0)),
        insights,
        caveats: [
          'Accounted for is what the job worker settled on a return — whether it came back as itself, as a new item, or was wasted.',
          'Wastage % is wasted ÷ accounted for, so a challan still out does not dilute it.',
          'Values are at the rate the material was carried at when it left. Cancelled challans are left out.',
          'The period is the date the challan was sent.',
        ],
      },
    }
  },
}
