import type { Prisma } from '@prisma/client'
import type { Panel, ReportDefinition } from '../types'
import { dateRangeFilters, periodLabel, round2 } from './shared'
import { daysBetween, pctOf, rupees } from './inventory-shared'

const r3 = (n: number) => Math.round(n * 1000) / 1000

/**
 * The GST limit. Inputs and part-made goods sent for job work have to come
 * back within a year of leaving (section 143), or they are treated as supplied
 * on the day they left and the tax falls due. Capital goods get three years;
 * nothing sent out here is capital goods.
 */
const GST_DAYS = 365
const GST_WARN = 60

/**
 * Material with job workers: what went, what came back, what was lost.
 *
 * Two ways goods reach an outside unit, both here:
 *
 *  - the store's job-work challans (Inventory → Job Work): one row per item
 *    sent on a challan;
 *  - production's outside stages (Production Stages): one row per job-work
 *    order — an order's stage at one unit — in pieces, across its challans.
 *
 * Pending is what the unit has not yet accounted for; wastage is what it
 * accounted for but could not return; damaged is spoiled at the unit and
 * chargeable to it. A unit losing five per cent every time, holding cloth for
 * two months, or close to the GST year, is a conversation somebody needs to
 * have — this is where it shows.
 */
export const jobWorkPending: ReportDefinition = {
  id: 'job-work-pending',
  module: 'inventory',
  title: 'Job Work Material',
  description:
    'Everything at outside units — sent by the store on job-work challans and by production from its outside stages — with what came back, wasted and damaged, what is still with them, days out and the GST one-year limit.',
  filters: [
    ...dateRangeFilters,
    { key: 'jobWorkerId', label: 'Job worker', type: 'select', optionsFrom: 'suppliers' },
    { key: 'all', label: 'Include settled challans', type: 'boolean' },
  ],
  columns: [
    { key: 'status', label: 'Status', type: 'badge', width: 14,
      badges: { OVERDUE: 'Overdue', OUT: 'With job worker', DONE: 'Settled' },
      badgeTones: { OVERDUE: 'bad', OUT: 'warn', DONE: 'good' } },
    { key: 'gst', label: 'GST Year', type: 'badge', width: 16,
      badges: { PAST: 'Past one year', NEAR: 'Within 60 days', OK: 'In time' },
      badgeTones: { PAST: 'bad', NEAR: 'warn', OK: 'good' } },
    { key: 'source', label: 'Sent By', type: 'text', width: 12 },
    { key: 'challanNumber', label: 'Challan', type: 'text', width: 18 },
    { key: 'challanDate', label: 'Sent On', type: 'date', width: 14 },
    { key: 'jobWorker', label: 'Job Worker', type: 'text', width: 24 },
    { key: 'process', label: 'Process', type: 'text', width: 16 },
    { key: 'owner', label: 'Whose', type: 'text', width: 20 },
    { key: 'itemCode', label: 'Item Code', type: 'text', width: 16 },
    { key: 'item', label: 'Item Sent', type: 'text', width: 28 },
    { key: 'uom', label: 'UOM', type: 'text', width: 8 },
    { key: 'sent', label: 'Sent', type: 'qty', total: 'sum' },
    { key: 'settled', label: 'Accounted For', type: 'qty', total: 'sum' },
    { key: 'wasted', label: 'Wasted', type: 'qty', total: 'sum' },
    { key: 'damaged', label: 'Damaged', type: 'qty', total: 'sum' },
    { key: 'damageNotCharged', label: 'Damage Not Charged', type: 'qty', total: 'sum' },
    { key: 'pending', label: 'Still With Them', type: 'qty', total: 'sum' },
    { key: 'wastage', label: 'Wastage %', type: 'percent', total: 'none' },
    { key: 'pendingValue', label: 'Value With Them', type: 'money', total: 'sum' },
    { key: 'expectedBack', label: 'Expected Back', type: 'date', width: 14 },
    { key: 'daysOut', label: 'Days Out', type: 'integer', total: 'none' },
    { key: 'gstDaysLeft', label: 'GST Days Left', type: 'integer', total: 'none' },
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
    slicers: ['status', 'source', 'gst'],
    note: 'Open a job worker to see each process they do for us.',
  },

  async run({ tx, params, rowCap }) {
    const from = params.from ? new Date(`${params.from}T00:00:00`) : undefined
    const to = params.to ? new Date(`${params.to}T23:59:59.999`) : undefined
    const now = new Date()
    // Late from the day after it was due, on the Indian calendar.
    const day = (d: Date) => d.toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' })
    const gstOf = (sentOn: Date, open: boolean) => {
      if (!open) return { gst: null, gstDaysLeft: null }
      const left = GST_DAYS - daysBetween(sentOn, now)
      return { gst: left < 0 ? 'PAST' : left <= GST_WARN ? 'NEAR' : 'OK', gstDaysLeft: left }
    }
    const liveNote = { status: { notIn: ['CANCELLED', 'REJECTED'] as Array<'CANCELLED' | 'REJECTED'> } }

    // ── The store's challans ──
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
        ownership: true,
        ownerCustomer: { select: { name: true } },
        item: { select: { code: true, name: true, uom: { select: { symbol: true } } } },
        challan: {
          select: { challanNumber: true, challanDate: true, process: true, expectedBackOn: true, jobWorker: { select: { name: true } } },
        },
        returnLines: {
          where: { jobWorkReturn: { cancelledAt: null } },
          select: {
            consumedQty: true,
            wastedQty: true,
            damagedQty: true,
            jobWorkReturn: { select: { returnDate: true, _count: { select: { debitNotes: { where: liveNote } } } } },
          },
        },
      },
    })

    const fromStore = lines.map((l) => {
      const sent = Number(l.qty)
      const settled = l.returnLines.reduce((s, r) => s + Number(r.consumedQty), 0)
      const wasted = l.returnLines.reduce((s, r) => s + Number(r.wastedQty), 0)
      const damaged = l.returnLines.reduce((s, r) => s + Number(r.damagedQty), 0)
      const damageNotCharged = l.returnLines.filter((r) => r.jobWorkReturn._count.debitNotes === 0).reduce((s, r) => s + Number(r.damagedQty), 0)
      const pending = Math.max(0, sent - settled)
      const lastBack = l.returnLines.reduce<Date | null>((m, r) => (!m || r.jobWorkReturn.returnDate > m ? r.jobWorkReturn.returnDate : m), null)
      const open = pending > 0.0005
      const overdue = open && l.challan.expectedBackOn != null && day(l.challan.expectedBackOn) < day(now)
      return {
        status: overdue ? 'OVERDUE' : open ? 'OUT' : 'DONE',
        ...gstOf(l.challan.challanDate, open),
        source: 'Store',
        challanNumber: l.challan.challanNumber,
        challanDate: l.challan.challanDate,
        jobWorker: l.challan.jobWorker.name,
        process: l.challan.process,
        owner: l.ownership === 'CUSTOMER_OWNED' ? (l.ownerCustomer?.name ?? 'A customer') : 'Ours',
        itemCode: l.item.code,
        item: l.item.name,
        uom: l.item.uom?.symbol ?? '',
        sent: r3(sent),
        settled: r3(settled),
        wasted: r3(wasted),
        damaged: r3(damaged),
        damageNotCharged: r3(damageNotCharged),
        pending: r3(pending),
        wastage: settled > 0 ? wasted / settled : null,
        pendingValue: round2(pending * Number(l.unitRate ?? 0)) as number | null,
        expectedBack: l.challan.expectedBackOn,
        daysOut: daysBetween(l.challan.challanDate, open ? now : (lastBack ?? now)),
        wastedValue: round2(wasted * Number(l.unitRate ?? 0)),
      }
    })

    // ── Production's outside stages, read as the Production Stages screen reads them ──
    const orders = await tx.jobWorkOrder.findMany({
      where: params.jobWorkerId ? { vendorId: params.jobWorkerId } : {},
      select: {
        stepId: true,
        vendorId: true,
        expectedBy: true,
        vendor: { select: { name: true } },
        step: { select: { name: true } },
        mo: {
          select: {
            moNumber: true,
            so: { select: { isJobWork: true, customer: { select: { name: true } } } },
            lines: { select: { style: { select: { code: true, name: true } } } },
          },
        },
        transfers: { where: { cancelledAt: null }, select: { transferNumber: true, dispatchDate: true }, orderBy: { dispatchDate: 'asc' } },
        wipEvents: {
          where: { type: { in: ['DISPATCH', 'VENDOR_RETURN'] }, reversedAt: null },
          select: { type: true, eventDate: true, entries: { select: { bucket: true, qty: true, vendorId: true } } },
        },
      },
    })
    const heldAt = orders.length
      ? await tx.wipEntry.groupBy({
          by: ['stepId', 'vendorId'],
          where: { stepId: { in: orders.map((o) => o.stepId) }, vendorId: { in: orders.map((o) => o.vendorId) } },
          _sum: { qty: true },
        })
      : []
    const fromFloor = orders.flatMap((o) => {
      const first = o.transfers[0]
      if (!first) return []
      if ((from && first.dispatchDate < from) || (to && first.dispatchDate > to)) return []
      const entries = o.wipEvents.flatMap((e) => e.entries.map((x) => ({ ...x, type: e.type })))
      const back = (bucket: string) => entries.filter((x) => x.type === 'VENDOR_RETURN' && x.bucket === bucket && x.qty > 0).reduce((s, x) => s + x.qty, 0)
      const sent = entries.filter((x) => x.type === 'DISPATCH' && x.bucket === 'WIP' && x.vendorId && x.qty > 0).reduce((s, x) => s + x.qty, 0)
      const damaged = back('DAMAGED')
      const settled = back('DONE') + back('REJECTED') + damaged
      const pending = Math.max(0, Number(heldAt.find((h) => h.stepId === o.stepId && h.vendorId === o.vendorId)?._sum.qty ?? 0))
      const lastBack = o.wipEvents.filter((e) => e.type === 'VENDOR_RETURN').reduce<Date | null>((m, e) => (!m || e.eventDate > m ? e.eventDate : m), null)
      const open = pending > 0
      const overdue = open && o.expectedBy != null && day(o.expectedBy) < day(now)
      const styles = [...new Map(o.mo.lines.map((l) => [l.style.code, l.style])).values()]
      return [
        {
          status: overdue ? 'OVERDUE' : open ? 'OUT' : 'DONE',
          ...gstOf(first.dispatchDate, open),
          source: 'Production',
          challanNumber: o.transfers.length > 1 ? `${first.transferNumber} +${o.transfers.length - 1}` : first.transferNumber,
          challanDate: first.dispatchDate,
          jobWorker: o.vendor.name,
          process: o.step.name,
          owner: o.mo.so?.isJobWork ? o.mo.so.customer.name : 'Ours',
          itemCode: styles.map((s) => s.code).join(', '),
          item: `${styles.map((s) => s.name).join(', ') || 'Pieces'} — ${o.mo.moNumber}`,
          uom: 'pcs',
          sent,
          settled,
          wasted: 0,
          damaged,
          // Production's damage is settled with the unit's bill, not a debit note here.
          damageNotCharged: null as number | null,
          pending,
          wastage: null as number | null,
          // Pieces in production carry no stock value of their own.
          pendingValue: null as number | null,
          expectedBack: o.expectedBy,
          daysOut: daysBetween(first.dispatchDate, open ? now : (lastBack ?? now)),
          wastedValue: 0,
        },
      ]
    })

    const all = [...fromStore, ...fromFloor].sort((a, b) => a.challanDate.getTime() - b.challanDate.getTime())
    const shown = all.filter((r) => params.all || r.status !== 'DONE')
    const rows = shown.slice(0, rowCap).map(({ wastedValue: _w, ...r }) => r)

    const open = all.filter((r) => r.status !== 'DONE')
    const withThem = round2(open.reduce((s, r) => s + (r.pendingValue ?? 0), 0))
    const overdue = all.filter((r) => r.status === 'OVERDUE')
    const gstNear = open.filter((r) => r.gst === 'NEAR')
    const gstPast = open.filter((r) => r.gst === 'PAST')
    const piecesOut = fromFloor.filter((r) => r.status !== 'DONE').reduce((s, r) => s + r.pending, 0)
    const storeLines = fromStore
    const settledAll = storeLines.reduce((s, r) => s + r.settled, 0)
    const wastedAll = storeLines.reduce((s, r) => s + r.wasted, 0)
    const wastedValue = round2(storeLines.reduce((s, r) => s + r.wastedValue, 0))
    const uncharged = storeLines.filter((r) => r.damageNotCharged > 0.0005)

    const workers = [...new Set(all.map((r) => r.jobWorker))]
    const perWorker = workers.map((w) => {
      const mine = storeLines.filter((r) => r.jobWorker === w)
      const s = mine.reduce((t, r) => t + r.settled, 0)
      return {
        w,
        value: round2(all.filter((r) => r.jobWorker === w && r.status !== 'DONE').reduce((t, r) => t + (r.pendingValue ?? 0), 0)),
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
    if (withThem) insights.push(`${rupees(withThem)} of material is with ${new Set(open.filter((r) => r.source === 'Store').map((r) => r.jobWorker)).size} job workers right now.`)
    if (piecesOut) insights.push(`${piecesOut.toLocaleString('en-IN')} pieces from production are at outside units.`)
    if (overdue.length) insights.push(`${overdue.length} lines are past their expected return date.`)
    if (gstPast.length || gstNear.length)
      insights.push(`${gstPast.length ? `${gstPast.length} past the GST one-year limit` : ''}${gstPast.length && gstNear.length ? ' and ' : ''}${gstNear.length ? `${gstNear.length} within ${GST_WARN} days of it` : ''}: bring them back, or the tax falls due.`)
    if (uncharged.length) insights.push(`${uncharged.length} ${uncharged.length === 1 ? 'line has' : 'lines have'} damage not yet charged to the job worker.`)
    if (settledAll > 0) insights.push(`Wastage on store challans is ${pctOf(wastedAll, settledAll)} of material accounted for, worth ${rupees(wastedValue)}.`)
    const worst = [...perWorker].filter((p) => p.wastage > 0).sort((a, b) => b.wastage - a.wastage)[0]
    if (worst && perWorker.length > 1) insights.push(`${worst.w} has the highest wastage at ${(worst.wastage * 100).toFixed(1)}%.`)

    const exceptions = [
      ...(gstPast.length ? [{ label: 'Past the GST one-year limit', value: gstPast.length, format: 'integer' as const, basis: 'tax falls due on these as if supplied the day they left', tone: 'bad' as const }] : []),
      ...(gstNear.length ? [{ label: 'Near the GST one-year limit', value: gstNear.length, format: 'integer' as const, basis: `lines within ${GST_WARN} days of a year out`, tone: 'warn' as const }] : []),
      ...(overdue.length ? [{ label: 'Overdue with job workers', value: overdue.length, format: 'integer' as const, basis: 'lines past the expected date — chase them', tone: 'bad' as const }] : []),
      ...(uncharged.length ? [{ label: 'Damage not charged', value: uncharged.length, format: 'integer' as const, basis: 'lines with damage and no debit note yet', tone: 'warn' as const }] : []),
    ]

    return {
      rows,
      totalRows: shown.length > rowCap ? shown.length : undefined,
      analysis: {
        headline: all.length
          ? open.length
            ? `${open.length} ${open.length === 1 ? 'line is' : 'lines are'} still with job workers${withThem ? ` (${rupees(withThem)} of material${piecesOut ? `, and ${piecesOut.toLocaleString('en-IN')} pieces from production` : ''})` : piecesOut ? ` (${piecesOut.toLocaleString('en-IN')} pieces from production)` : ''}; ${overdue.length} overdue.`
            : 'Everything sent to job workers has been accounted for.'
          : `Nothing was sent to job workers, ${periodLabel(params).toLowerCase()}.`,
        kpis: [
          { label: 'Value with job workers', value: all.length ? withThem : null, format: 'money', basis: `${open.filter((r) => r.source === 'Store').length} store lines still out` },
          { label: 'Pieces at outside units', value: fromFloor.length ? piecesOut : null, format: 'integer', basis: 'from production' },
          { label: 'Challans open', value: all.length ? new Set(open.map((r) => r.challanNumber)).size : null, format: 'integer', basis: `of ${new Set(all.map((r) => r.challanNumber)).size} sent` },
          { label: 'Wastage', value: settledAll ? wastedAll / settledAll : null, format: 'percent', basis: 'of store material accounted for' },
        ],
        exceptions,
        panels: (
          [
            { title: 'Value still with each job worker', question: 'ranking', format: 'money', points: perWorker.map((p) => ({ label: p.w, value: p.value })).sort((a, b) => b.value - a.value) },
            {
              title: 'How long lines have been out',
              question: 'ageing',
              format: 'integer',
              points: bands.map((b, i) => ({
                label: b.label,
                value: open.filter((r) => r.daysOut <= b.max && r.daysOut > (i ? bands[i - 1].max : -1)).length,
                tone: i >= 2 ? 'bad' : i === 1 ? 'warn' : 'normal',
              })),
            },
            { title: 'Wastage by job worker', question: 'comparison', format: 'percent', points: perWorker.map((p) => ({ label: p.w, value: round2(p.wastage * 10000) / 10000 })) },
          ] as Panel[]
        ).filter((p) => p.points.some((x) => x.value > 0)),
        insights,
        caveats: [
          'Sent By: Store is a job-work challan from Inventory → Job Work; Production is an outside stage on Production Stages, in pieces, one row per order, stage and unit across its challans.',
          'Accounted for is what the unit settled on a return — back as itself, as a new item, wasted or damaged. For production, accepted, rejected and damaged pieces back.',
          'Damaged is spoiled at the unit and chargeable to it. Damage not charged is damage on a receipt with no debit note yet.',
          `GST year: material sent for job work must come back within ${GST_DAYS} days of leaving, or tax falls due as if it was supplied that day. Production rows count from the first challan.`,
          'Wastage % is wasted ÷ accounted for on store challans, so a challan still out does not dilute it.',
          'Values are at the rate the material was carried at when it left. Pieces from production carry no value here. Cancelled challans are left out.',
          'The period is the date the challan was sent.',
        ],
      },
    }
  },
}
