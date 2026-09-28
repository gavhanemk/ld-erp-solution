import type { Prisma } from '@prisma/client'
import type { Panel, ReportContext, ReportDefinition, Tone } from '../types'
import {
  byMonth,
  dateRangeFilters,
  dayRange,
  itemFilter,
  ratio,
  round2,
  searchFilter,
  supplierFilter,
  topWithRest,
} from './shared'
import { readQc, QC_RESULT_WORDS } from '../../services/grnQc.service'

const RESULT_TONE: Record<string, Tone> = {
  PASS: 'good',
  CONDITIONAL_PASS: 'warn',
  FAIL: 'bad',
  CANCELLED: 'neutral',
}

const RESULT_WORDS: Record<string, string> = { ...QC_RESULT_WORDS, CANCELLED: 'Cancelled' }

const DAY = 86_400_000

/**
 * Every line of every quality check in the period, with what came back from
 * the reject godown since.
 *
 * Shared by the two QC reports: the register reads every row, the rejection
 * report only the ones with something rejected on a check that still stands.
 * "Sent back" is counted off return challans against the bill line the
 * receipt line was billed on — the only way rejected goods leave the mill.
 */
async function qcRows({ tx, params, rowCap }: ReportContext) {
  const range = dayRange(params)
  const contains = (v: string) => ({ contains: v, mode: 'insensitive' as const })
  // Supplier and item both narrow the receipt, so they share one clause —
  // two `grn` keys spread side by side would leave only the second.
  const grnWhere: Prisma.GRNWhereInput = {
    ...(params.supplierId ? { po: { supplierId: params.supplierId } } : {}),
    ...(params.itemId ? { lines: { some: { itemId: params.itemId } } } : {}),
  }
  const where: Prisma.InwardQCWhereInput = {
    ...(range ? { inspectionDate: range } : {}),
    ...(Object.keys(grnWhere).length ? { grn: grnWhere } : {}),
    ...(params.q
      ? {
          OR: [
            { grn: { grnNumber: contains(params.q) } },
            { grn: { challanNo: contains(params.q) } },
            { grn: { po: { poNumber: contains(params.q) } } },
            { grn: { po: { supplier: { name: contains(params.q) } } } },
          ],
        }
      : {}),
  }

  const totalRows = await tx.inwardQC.count({ where })
  const checks = await tx.inwardQC.findMany({
    where,
    take: rowCap,
    orderBy: [{ inspectionDate: 'asc' }, { createdAt: 'asc' }],
    select: {
      id: true,
      inspectionDate: true,
      inspectedBy: true,
      result: true,
      checklistData: true,
      grn: {
        select: {
          grnNumber: true,
          grnDate: true,
          challanNo: true,
          po: { select: { poNumber: true, supplier: { select: { name: true } } } },
          lines: {
            select: {
              id: true,
              unitRate: true,
              item: { select: { code: true, name: true, uom: { select: { symbol: true } } } },
              warehouse: { select: { name: true } },
            },
          },
        },
      },
    },
  })

  const rejectGodowns = new Map(
    (await tx.warehouse.findMany({ select: { id: true, name: true } })).map((w) => [w.id, w.name])
  )

  // What has gone back on a return challan, per receipt line.
  const grnLineIds = checks.flatMap((c) => c.grn.lines.map((l) => l.id))
  const returned = new Map<string, { qty: number; numbers: Set<string> }>()
  if (grnLineIds.length) {
    const back = await tx.purchaseReturnLine.findMany({
      where: {
        billLine: { grnLineId: { in: grnLineIds } },
        purchaseReturn: { status: { not: 'CANCELLED' } },
      },
      select: {
        qty: true,
        billLine: { select: { grnLineId: true } },
        purchaseReturn: { select: { returnNumber: true } },
      },
    })
    for (const b of back) {
      const id = b.billLine.grnLineId
      if (!id) continue
      const e = returned.get(id) ?? { qty: 0, numbers: new Set<string>() }
      e.qty += Number(b.qty)
      e.numbers.add(b.purchaseReturn.returnNumber)
      returned.set(id, e)
    }
  }

  const today = new Date()
  const startOfToday = new Date(today.getFullYear(), today.getMonth(), today.getDate())

  const rows = checks.flatMap((c) => {
    const d = readQc(c.checklistData)
    if (!d) return []
    const lineInfo = new Map(c.grn.lines.map((l) => [l.id, l]))
    const status = d.cancelled ? 'CANCELLED' : c.result
    const qcDay = new Date(
      c.inspectionDate.getFullYear(),
      c.inspectionDate.getMonth(),
      c.inspectionDate.getDate()
    )
    return d.lines
      .map((l) => {
        const info = lineInfo.get(l.grnLineId)
        const back = returned.get(l.grnLineId)
        const rate = Number(info?.unitRate ?? 0)
        // A return challan can also carry goods that were never rejected on
        // QC, so what counts against the rejection is capped at it.
        const sentBack = d.cancelled ? 0 : round2(Math.min(l.rejectedQty, back?.qty ?? 0))
        const toReturn = d.cancelled ? 0 : round2(Math.max(0, l.rejectedQty - sentBack))
        return {
          qcDate: c.inspectionDate,
          grnNumber: c.grn.grnNumber,
          grnDate: c.grn.grnDate,
          poNumber: c.grn.po?.poNumber ?? '',
          supplier: c.grn.po?.supplier?.name ?? '',
          challanNo: c.grn.challanNo ?? '',
          itemCode: info?.item.code ?? '',
          item: info?.item.name ?? '',
          itemId: l.itemId,
          uom: info?.item.uom?.symbol ?? '',
          received: l.receivedQty,
          approved: l.approvedQty,
          rejected: l.rejectedQty,
          rejectRate: l.receivedQty > 0 ? l.rejectedQty / l.receivedQty : 0,
          rejectedValue: round2(l.rejectedQty * rate),
          reason: l.reason ?? '',
          godown: info?.warehouse.name ?? '',
          rejectGodown:
            l.rejectedQty > 0 && d.rejectWarehouseId
              ? (rejectGodowns.get(d.rejectWarehouseId) ?? '')
              : '',
          sentBack,
          toReturn,
          toReturnValue: round2(toReturn * rate),
          returnNumbers: back ? [...back.numbers].join(', ') : '',
          daysWaiting:
            toReturn > 0
              ? Math.max(0, Math.floor((startOfToday.getTime() - qcDay.getTime()) / DAY))
              : 0,
          inspectedBy: c.inspectedBy ?? '',
          status,
        }
      })
      .filter((r) => !params.itemId || r.itemId === params.itemId)
  })

  return { rows, totalRows }
}

const common = {
  module: 'purchase' as const,
  filters: [
    ...dateRangeFilters,
    supplierFilter,
    itemFilter,
    { ...searchFilter, help: 'GRN, challan or order number, or supplier name' },
  ],
}

/** Every quality check, line by line — the old system's "Done GRN QC Report". */
export const grnQcRegister: ReportDefinition = {
  id: 'grn-qc-register',
  ...common,
  title: 'GRN QC Register',
  description:
    'Every quality check done on a goods receipt — per item, what was received, passed and rejected, why, and who checked it.',
  columns: [
    { key: 'qcDate', label: 'QC Date', type: 'date', width: 13 },
    { key: 'grnNumber', label: 'GRN No.', type: 'text', width: 14 },
    { key: 'grnDate', label: 'Received On', type: 'date', width: 13 },
    { key: 'poNumber', label: 'Order No.', type: 'text', width: 14 },
    { key: 'supplier', label: 'Supplier', type: 'text', width: 28 },
    { key: 'itemCode', label: 'Item Code', type: 'text', width: 16 },
    { key: 'item', label: 'Item', type: 'text', width: 30 },
    { key: 'uom', label: 'UOM', type: 'text', width: 8 },
    { key: 'received', label: 'Received', type: 'qty', total: 'sum' },
    { key: 'approved', label: 'Approved', type: 'qty', total: 'sum' },
    { key: 'rejected', label: 'Rejected', type: 'qty', total: 'sum' },
    { key: 'rejectRate', label: 'Reject %', type: 'percent', total: 'none' },
    { key: 'reason', label: 'Rejection Reason', type: 'text', width: 30 },
    { key: 'godown', label: 'Received Into', type: 'text', width: 20 },
    { key: 'inspectedBy', label: 'Checked By', type: 'text', width: 18 },
    {
      key: 'status',
      label: 'Result',
      type: 'badge',
      badges: RESULT_WORDS,
      badgeTones: RESULT_TONE,
      width: 14,
    },
  ],
  summary: {
    title: 'Worst rejections in this period',
    columns: ['qcDate', 'grnNumber', 'supplier', 'item', 'received', 'rejected', 'reason'],
    by: 'rejected',
    limit: 12,
  },
  pivot: {
    rows: ['supplier', 'item'],
    values: ['received', 'approved', 'rejected'],
    slicers: ['status', 'uom'],
    note: 'Open a supplier to see which items were rejected. Pick a UOM before reading a quantity total.',
  },

  async run(ctx) {
    const { rows, totalRows } = await qcRows(ctx)
    const live = rows.filter((r) => r.status !== 'CANCELLED')
    const cancelledChecks = new Set(
      rows.filter((r) => r.status === 'CANCELLED').map((r) => r.grnNumber + r.qcDate.toISOString())
    ).size
    const checks = new Set(live.map((r) => r.grnNumber)).size
    const received = round2(live.reduce((s, r) => s + r.received, 0))
    const rejected = round2(live.reduce((s, r) => s + r.rejected, 0))
    const rejectedValue = round2(live.reduce((s, r) => s + r.rejectedValue, 0))
    const failedLines = live.filter((r) => r.rejected > 0).length

    const bySupplier = new Map<string, number>()
    for (const r of live)
      if (r.rejected > 0)
        bySupplier.set(r.supplier, (bySupplier.get(r.supplier) ?? 0) + r.rejectedValue)
    const byReason = new Map<string, number>()
    for (const r of live)
      if (r.rejected > 0)
        byReason.set(
          r.reason || 'No reason given',
          (byReason.get(r.reason || 'No reason given') ?? 0) + r.rejectedValue
        )

    const monthly = byMonth(
      live,
      (r) => r.qcDate,
      (r) => r.rejectedValue
    )
    const rate = ratio(rejected, received)

    const insights: string[] = []
    if (live.length) {
      insights.push(
        `${checks} receipt${checks === 1 ? '' : 's'} checked; ${failedLines} of ${live.length} item lines had something rejected.`
      )
      const worst = [...bySupplier].sort((a, b) => b[1] - a[1])[0]
      if (worst)
        insights.push(
          `Most rejected by value: ${worst[0]} — ₹${round2(worst[1]).toLocaleString('en-IN')}.`
        )
    }

    return {
      rows,
      totalRows,
      analysis: {
        headline:
          live.length === 0
            ? 'No quality checks were recorded in this period.'
            : `${checks} receipts checked, ₹${rejectedValue.toLocaleString('en-IN')} of goods rejected.`,
        exceptions: [
          {
            label: 'Reject rate above 2%',
            value: rate != null && rate > 0.02 ? rate : null,
            format: 'percent',
            basis: `${rejected.toLocaleString('en-IN')} of ${received.toLocaleString('en-IN')} received`,
            tone: 'bad',
          },
        ],
        kpis: [
          {
            label: 'Receipts checked',
            value: live.length ? checks : null,
            format: 'integer',
            basis: `${live.length} item lines`,
          },
          {
            label: 'Lines with rejects',
            value: live.length ? failedLines : null,
            format: 'integer',
            basis: `of ${live.length}`,
            tone: failedLines ? 'warn' : 'good',
          },
          {
            label: 'Reject rate',
            value: rate,
            format: 'percent',
            basis: 'by quantity, across items',
            tone: rate && rate > 0.02 ? 'bad' : undefined,
          },
          {
            label: 'Rejected value',
            value: live.length ? rejectedValue : null,
            format: 'money',
            basis: 'at the receipt rate, before tax',
          },
        ],
        trend:
          monthly.length > 1
            ? {
                title: 'Value rejected on QC, by month',
                valueLabel: 'Rejected',
                format: 'money',
                points: monthly,
              }
            : undefined,
        panels: (
          [
            {
              title: 'Results of the checks',
              question: 'composition',
              format: 'integer',
              points: (['PASS', 'CONDITIONAL_PASS', 'FAIL'] as const).map((s) => ({
                label: RESULT_WORDS[s],
                value: new Set(live.filter((r) => r.status === s).map((r) => r.grnNumber)).size,
                tone: RESULT_TONE[s],
              })),
              note: 'Counted in receipts checked.',
            },
            {
              title: 'Rejected value by supplier',
              question: 'ranking',
              format: 'money',
              points: topWithRest(
                [...bySupplier].map(([label, value]) => ({ label, value: round2(value) })),
                8
              ),
            },
            {
              title: 'Why goods were rejected',
              question: 'ranking',
              format: 'money',
              points: topWithRest(
                [...byReason].map(([label, value]) => ({ label, value: round2(value) })),
                8
              ),
            },
          ] as Panel[]
        ).filter((p) => p.points.some((x) => x.value > 0)),
        insights,
        caveats: [
          cancelledChecks > 0
            ? `${cancelledChecks} cancelled check${cancelledChecks === 1 ? '' : 's'} appear on the Data sheet as Cancelled and are counted nowhere on this Dashboard.`
            : 'No cancelled checks fell in this period.',
          'QC is optional — receipts nobody checked are not listed. See the Goods Receipt Register for every delivery.',
          'Quantities are in each item’s own unit. Values are at the receipt rate before tax.',
        ],
      },
    }
  },
}

/** What QC rejected and whether it has gone back — the old "Reject Quantity on QC". */
export const qcRejections: ReportDefinition = {
  id: 'qc-rejections',
  ...common,
  title: 'Rejected on QC',
  description:
    'Everything rejected on a quality check — how much, why, where it is waiting, and how much has gone back to the supplier on a return challan.',
  columns: [
    { key: 'qcDate', label: 'QC Date', type: 'date', width: 13 },
    { key: 'grnNumber', label: 'GRN No.', type: 'text', width: 14 },
    { key: 'poNumber', label: 'Order No.', type: 'text', width: 14 },
    { key: 'supplier', label: 'Supplier', type: 'text', width: 28 },
    { key: 'itemCode', label: 'Item Code', type: 'text', width: 16 },
    { key: 'item', label: 'Item', type: 'text', width: 30 },
    { key: 'uom', label: 'UOM', type: 'text', width: 8 },
    { key: 'received', label: 'Received', type: 'qty', total: 'sum' },
    { key: 'rejected', label: 'Rejected', type: 'qty', total: 'sum' },
    { key: 'reason', label: 'Rejection Reason', type: 'text', width: 30 },
    { key: 'rejectGodown', label: 'Waiting In', type: 'text', width: 20 },
    { key: 'sentBack', label: 'Sent Back', type: 'qty', total: 'sum' },
    { key: 'toReturn', label: 'Still to Send Back', type: 'qty', total: 'sum' },
    { key: 'toReturnValue', label: 'Value Still Here', type: 'money', total: 'sum' },
    { key: 'returnNumbers', label: 'Return Challan(s)', type: 'text', width: 18 },
    { key: 'daysWaiting', label: 'Days Waiting', type: 'integer', width: 12 },
  ],
  summary: {
    title: 'Rejected goods waiting longest to go back',
    columns: [
      'qcDate',
      'grnNumber',
      'supplier',
      'item',
      'toReturn',
      'toReturnValue',
      'daysWaiting',
    ],
    by: 'daysWaiting',
    limit: 12,
  },
  pivot: {
    rows: 'supplier',
    values: ['toReturnValue', 'rejected', 'sentBack', 'toReturn'],
    slicers: ['rejectGodown', 'uom'],
    note: 'The value is in rupees and adds across items. Pick a UOM before reading a quantity total.',
  },

  async run(ctx) {
    const { rows: all } = await qcRows(ctx)
    const rows = all.filter((r) => r.status !== 'CANCELLED' && r.rejected > 0)
    const rejectedValue = round2(rows.reduce((s, r) => s + r.rejectedValue, 0))
    const waiting = rows.filter((r) => r.toReturn > 0)
    const waitingValue = round2(waiting.reduce((s, r) => s + r.toReturnValue, 0))
    const old = waiting.filter((r) => r.daysWaiting > 15)
    const oldValue = round2(old.reduce((s, r) => s + r.toReturnValue, 0))

    const bySupplier = new Map<string, number>()
    for (const r of waiting)
      bySupplier.set(r.supplier, (bySupplier.get(r.supplier) ?? 0) + r.toReturnValue)

    const insights: string[] = []
    if (rows.length) {
      insights.push(
        waiting.length
          ? `₹${waitingValue.toLocaleString('en-IN')} of rejected goods is still at the mill, on ${waiting.length} line${waiting.length === 1 ? '' : 's'}.`
          : 'Everything rejected on QC has gone back to the supplier.'
      )
      const top = [...bySupplier].sort((a, b) => b[1] - a[1])[0]
      if (top)
        insights.push(
          `The most is waiting to go back to ${top[0]} — ₹${round2(top[1]).toLocaleString('en-IN')}.`
        )
    }

    return {
      rows,
      totalRows: undefined,
      analysis: {
        headline:
          rows.length === 0
            ? 'Nothing was rejected on QC in this period.'
            : `${rows.length} rejected line${rows.length === 1 ? '' : 's'}, ₹${waitingValue.toLocaleString('en-IN')} still to go back.`,
        exceptions: [
          {
            label: 'Waiting over 15 days to go back',
            value: oldValue || null,
            format: 'money',
            basis: `${old.length} line${old.length === 1 ? '' : 's'} — raise the return challan from the bill`,
            tone: 'bad',
          },
        ],
        kpis: [
          {
            label: 'Rejected lines',
            value: rows.length || null,
            format: 'integer',
            basis: `worth ₹${rejectedValue.toLocaleString('en-IN')}`,
          },
          {
            label: 'Sent back in full',
            value: ratio(rows.length - waiting.length, rows.length),
            format: 'percent',
            basis: `${rows.length - waiting.length} of ${rows.length} lines`,
          },
          {
            label: 'Value still here',
            value: rows.length ? waitingValue : null,
            format: 'money',
            basis: 'rejected and not yet returned',
            tone: waitingValue > 0 ? 'warn' : 'good',
          },
          {
            label: 'Longest wait',
            value: waiting.length ? Math.max(...waiting.map((r) => r.daysWaiting)) : null,
            format: 'days',
            basis: 'since the check',
          },
        ],
        panels: (
          [
            {
              title: 'Rejected goods still at the mill, by supplier',
              question: 'ranking',
              format: 'money',
              points: topWithRest(
                [...bySupplier].map(([label, value]) => ({ label, value: round2(value) })),
                8
              ),
            },
            {
              title: 'Sent back against still here',
              question: 'composition',
              format: 'money',
              points: [
                {
                  label: 'Sent back',
                  value: round2(rejectedValue - waitingValue),
                  tone: 'good' as Tone,
                },
                { label: 'Still here', value: waitingValue, tone: 'warn' as Tone },
              ],
            },
          ] as Panel[]
        ).filter((p) => p.points.some((x) => x.value > 0)),
        insights,
        caveats: [
          'Only checks that still stand. A cancelled check moved its goods back and has nothing waiting.',
          '"Sent back" counts return challans against the bill line this receipt line was billed on, capped at what QC rejected. Goods returned before they were billed cannot be matched here.',
          'Values are at the receipt rate before tax.',
        ],
      },
    }
  },
}
