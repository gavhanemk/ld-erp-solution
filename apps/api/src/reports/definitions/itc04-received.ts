import type { ReportDefinition } from '../types'
import { party, periodFilter, periodOf, uqcOf } from './itc04-shared'

const r3 = (n: number) => Math.round(n * 1000) / 1000

/**
 * ITC-04, Table 5A: our own inputs received back from job workers in the
 * period, and the losses and wastes.
 *
 * One row per receipt line, in the form's order: job worker, the challan the
 * goods originally went out on, the job worker's own challan they came back
 * on, the nature of the work, what came back, and what was lost. Store
 * receipts name their challan line; production's returns are matched to the
 * challans their pieces went out on, oldest first, a return split across two
 * challans when it spans them. A customer's material is theirs to declare.
 */
export const itc04Received: ReportDefinition = {
  id: 'itc04-received',
  module: 'inventory',
  title: 'ITC-04 Table 5A: Received Back from Job Workers',
  description:
    'For the GST return ITC-04: our own inputs received back from job workers in the period, against the challans they went out on, with losses and wastes — in the form’s order, ready to check and copy into the GST offline tool.',
  filters: [periodFilter],
  columns: [
    { key: 'jwGstin', label: 'GSTIN of Job Worker', type: 'text', width: 18 },
    { key: 'jwState', label: 'State (if Unregistered)', type: 'text', width: 20 },
    { key: 'jwType', label: "Job Worker's Type", type: 'text', width: 13 },
    { key: 'jobWorker', label: 'Job Worker', type: 'text', width: 24 },
    { key: 'originalChallan', label: 'Original Challan No.', type: 'text', width: 18 },
    { key: 'originalDate', label: 'Original Challan Date', type: 'date', width: 13 },
    { key: 'theirChallan', label: "Job Worker's Challan No.", type: 'text', width: 18 },
    { key: 'theirDate', label: "Job Worker's Challan Date", type: 'date', width: 13 },
    { key: 'nature', label: 'Nature of Job Work', type: 'text', width: 18 },
    { key: 'description', label: 'Description of Goods', type: 'text', width: 30 },
    { key: 'uqc', label: 'UQC', type: 'text', width: 7 },
    { key: 'qty', label: 'Quantity', type: 'qty', total: 'none' },
    { key: 'lossUqc', label: 'Losses & Wastes UQC', type: 'text', width: 9 },
    { key: 'lossQty', label: 'Losses & Wastes Qty', type: 'qty', total: 'none' },
    { key: 'ourReceipt', label: 'Our Receipt', type: 'text', width: 16 },
    { key: 'source', label: 'From', type: 'text', width: 12 },
    { key: 'check', label: 'To Check', type: 'text', width: 30 },
  ],
  summary: {
    title: 'Largest losses at job workers',
    columns: ['originalChallan', 'jobWorker', 'description', 'lossQty', 'lossUqc'],
    by: 'lossQty',
    limit: 12,
  },
  pivot: {
    rows: ['jobWorker', 'originalChallan'],
    values: ['qty', 'lossQty'],
    slicers: ['source'],
    note: 'Open a job worker to see each original challan.',
  },

  async run({ tx, params, rowCap }) {
    const period = periodOf(params)

    // ── The store's receipts, line by line ──
    const lines = await tx.jobWorkReturnLine.findMany({
      where: { jobWorkReturn: { cancelledAt: null, returnDate: { gte: period.from, lte: period.to } }, challanLine: { challan: { status: { not: 'CANCELLED' } } } },
      orderBy: [{ jobWorkReturn: { returnDate: 'asc' } }, { jobWorkReturn: { returnNumber: 'asc' } }],
      select: {
        receivedQty: true,
        wastedQty: true,
        damagedQty: true,
        item: { select: { name: true, uom: { select: { symbol: true } } } },
        jobWorkReturn: { select: { returnNumber: true, returnDate: true, theirChallanNo: true } },
        challanLine: {
          select: {
            ownership: true,
            item: { select: { uom: { select: { symbol: true } } } },
            challan: { select: { challanNumber: true, challanDate: true, process: true, jobWorker: { select: { name: true, gstin: true, state: true, stateCode: true } } } },
          },
        },
      },
    })
    const theirs = lines.filter((l) => l.challanLine.ownership === 'CUSTOMER_OWNED').length
    const fromStore = lines
      .filter((l) => l.challanLine.ownership !== 'CUSTOMER_OWNED')
      .map((l) => {
        const p = party(l.challanLine.challan.jobWorker)
        const theirNo = l.jobWorkReturn.theirChallanNo?.trim() || ''
        return {
          jwGstin: p.gstin ?? '',
          jwState: p.stateLabel,
          jwType: p.type,
          jobWorker: p.name,
          originalChallan: l.challanLine.challan.challanNumber,
          originalDate: l.challanLine.challan.challanDate,
          theirChallan: theirNo,
          theirDate: l.jobWorkReturn.returnDate,
          nature: l.challanLine.challan.process,
          description: l.item.name,
          uqc: uqcOf(l.item.uom?.symbol),
          qty: r3(Number(l.receivedQty)),
          lossUqc: uqcOf(l.challanLine.item.uom?.symbol),
          lossQty: r3(Number(l.wastedQty) + Number(l.damagedQty)),
          ourReceipt: l.jobWorkReturn.returnNumber,
          source: 'Store challan',
          check: [!p.gstin && !p.stateLabel ? 'Job worker has no GSTIN or state' : '', !theirNo ? "Their challan no. missing: ask the job worker" : '']
            .filter(Boolean)
            .join('; '),
        }
      })

    // ── Production's returns from outside units, own orders only ──
    const touched = await tx.wipEvent.findMany({
      where: {
        type: 'VENDOR_RETURN',
        reversedAt: null,
        eventDate: { gte: period.from, lte: period.to },
        jobWorkOrderId: { not: null },
      },
      select: { jobWorkOrderId: true },
      distinct: ['jobWorkOrderId'],
    })
    const orders = touched.length
      ? await tx.jobWorkOrder.findMany({
          where: { id: { in: touched.map((t) => t.jobWorkOrderId!) } },
          select: {
            step: { select: { name: true } },
            vendor: { select: { name: true, gstin: true, state: true, stateCode: true } },
            mo: { select: { moNumber: true, so: { select: { isJobWork: true } }, lines: { select: { style: { select: { name: true } } } } } },
            transfers: {
              where: { cancelledAt: null },
              orderBy: { dispatchDate: 'asc' },
              select: { transferNumber: true, dispatchDate: true, lines: { select: { dispatchedQty: true } } },
            },
            wipEvents: {
              where: { type: 'VENDOR_RETURN', reversedAt: null },
              orderBy: { eventDate: 'asc' },
              select: { eventDate: true, theirChallanNo: true, entries: { select: { bucket: true, qty: true } } },
            },
          },
        })
      : []
    const theirOrders = orders.filter((o) => o.mo.so?.isJobWork).length
    const fromFloor = orders
      .filter((o) => !o.mo.so?.isJobWork)
      .flatMap((o) => {
        const p = party(o.vendor)
        const styles = [...new Set(o.mo.lines.map((l) => l.style.name))].join(', ')
        const row = (t: (typeof o.transfers)[number] | null, e: (typeof o.wipEvents)[number], qty: number, loss: number) => {
          const theirNo = e.theirChallanNo?.trim() || ''
          return {
            jwGstin: p.gstin ?? '',
            jwState: p.stateLabel,
            jwType: p.type,
            jobWorker: p.name,
            originalChallan: t?.transferNumber ?? '',
            originalDate: t?.dispatchDate ?? null,
            theirChallan: theirNo,
            theirDate: e.eventDate,
            nature: o.step.name,
            description: `${styles || 'Garment'} pieces — ${o.mo.moNumber}`,
            uqc: 'PCS',
            qty,
            lossUqc: loss ? 'PCS' : '',
            lossQty: loss,
            ourReceipt: '',
            source: 'Production',
            check: [
              !p.gstin && !p.stateLabel ? 'Job worker has no GSTIN or state' : '',
              !theirNo ? "Their challan no. missing: ask the job worker" : '',
              !t ? 'More came back than went out on challans' : '',
            ]
              .filter(Boolean)
              .join('; '),
          }
        }
        // What each challan still has out, oldest first: returns settle against them in turn.
        const pool = o.transfers.map((t) => ({ t, left: t.lines.reduce((s, l) => s + l.dispatchedQty, 0) }))
        const out: Array<ReturnType<typeof row>> = []
        for (const e of o.wipEvents) {
          const sum = (b: string) => e.entries.filter((x) => x.bucket === b && x.qty > 0).reduce((s, x) => s + x.qty, 0)
          let back = sum('DONE') + sum('REJECTED')
          let lost = sum('DAMAGED')
          const inPeriod = e.eventDate >= period.from && e.eventDate <= period.to
          for (const slot of pool) {
            if (back + lost <= 0) break
            if (slot.left <= 0) continue
            const take = Math.min(slot.left, back + lost)
            slot.left -= take
            const q = Math.min(take, back)
            back -= q
            const l = take - q
            lost -= l
            if (inPeriod) out.push(row(slot.t, e, q, l))
          }
          // More back than went out on challans: still shown, against no challan, to be looked at.
          if (back + lost > 0 && inPeriod) out.push(row(null, e, back, lost))
        }
        return out
      })

    const all = [...fromStore, ...fromFloor].sort((a, b) => a.theirDate.getTime() - b.theirDate.getTime())
    const rows = all.slice(0, rowCap)
    const toCheck = all.filter((r) => r.check)
    const withLoss = all.filter((r) => r.lossQty > 0)

    const insights: string[] = []
    insights.push(period.kind === 'FY' ? `The yearly return for ${period.label} is due by ${period.due}.` : `The half-yearly return for ${period.label} is due by ${period.due}.`)
    if (withLoss.length) insights.push(`${withLoss.length} ${withLoss.length === 1 ? 'line has' : 'lines have'} losses or wastes — wasted at the unit, or damaged there.`)
    if (toCheck.length) insights.push(`${toCheck.length} ${toCheck.length === 1 ? 'line needs' : 'lines need'} a look before filing — see To Check.`)
    if (theirs || theirOrders)
      insights.push(
        `Left out as the customers' to declare: ${[theirs ? `${theirs} store receipt ${theirs === 1 ? 'line' : 'lines'}` : '', theirOrders ? `returns on ${theirOrders} production job-work ${theirOrders === 1 ? 'order' : 'orders'}` : ''].filter(Boolean).join(' and ')} of customers' material.`,
      )

    return {
      rows,
      totalRows: all.length > rowCap ? all.length : undefined,
      analysis: {
        headline: all.length
          ? `${period.label}: ${all.length} ${all.length === 1 ? 'line' : 'lines'} for Table 5A${withLoss.length ? `, ${withLoss.length} with losses` : ''}${toCheck.length ? `; ${toCheck.length} to check` : ''}.`
          : `${period.label}: nothing of ours came back from job workers — Table 5A is empty.`,
        kpis: [
          { label: 'Lines received back', value: all.length || null, format: 'integer', basis: `${fromStore.length} store, ${fromFloor.length} production` },
          { label: 'Original challans', value: all.length ? new Set(all.map((r) => r.originalChallan).filter(Boolean)).size : null, format: 'integer', basis: 'goods came back against' },
          { label: 'Lines with losses', value: all.length ? withLoss.length : null, format: 'integer', basis: 'wasted or damaged at the unit' },
          { label: 'To check', value: all.length ? toCheck.length : null, format: 'integer', basis: 'before filing', tone: toCheck.length ? 'warn' : 'good' },
        ],
        exceptions: toCheck.length
          ? [{ label: 'Lines to check before filing', value: toCheck.length, format: 'integer', basis: "missing GSTIN or state, or the job worker's challan no.", tone: 'warn' }]
          : [],
        panels: [],
        insights,
        caveats: [
          `Period ${period.label}${period.chosen ? '' : ' — the half-year we are in, as no period was picked'}: receipts dated in it, against challans from any earlier period.`,
          "Only our own inputs; a customer's material is theirs to declare as principal.",
          "The job worker's challan date is the day we received the goods, as entered on our receipt.",
          'Losses & wastes are what the unit wasted plus what it damaged, in the unit the goods went out in.',
          "Production's returns are matched to the challans their pieces went out on, oldest first.",
          'This is the form’s content, not the GST offline tool’s file: copy it into ITC_04_Offline.xls and let the tool check it.',
        ],
      },
    }
  },
}
