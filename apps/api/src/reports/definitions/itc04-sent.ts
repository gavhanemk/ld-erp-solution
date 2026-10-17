import type { ReportDefinition } from '../types'
import { findHsn, gstRateFor, loadHsnIndex, splitGstRate } from '../../lib/hsn'
import { round2 } from './shared'
import { rupees } from './inventory-shared'
import { party, periodFilter, periodOf, uqcOf } from './itc04-shared'

const r3 = (n: number) => Math.round(n * 1000) / 1000

/**
 * ITC-04, Table 4: our own inputs sent to job workers in the period.
 *
 * One row per item on each challan, in the form's order of columns — job
 * worker (GSTIN, or state when unregistered), challan, type of goods,
 * description, UQC, quantity, taxable value and the tax rates — so the
 * accountant copies it into the GST offline tool and checks it there.
 *
 * Two kinds of challan send goods out: the store's job-work challans, and
 * production's challans to an outside stage. A customer's material on either
 * is left out: it is the customer's to declare as principal, not ours.
 * Production's pieces carry no value in the ERP, so their value and rate are
 * left for the accountant and the row says so.
 */
export const itc04Sent: ReportDefinition = {
  id: 'itc04-sent',
  module: 'inventory',
  title: 'ITC-04 Table 4: Sent to Job Workers',
  description:
    'For the GST return ITC-04: our own inputs sent to job workers in the period — job worker, challan, goods, UQC, quantity, taxable value and tax rates, in the form’s order — ready to check and copy into the GST offline tool.',
  filters: [periodFilter],
  columns: [
    { key: 'jwGstin', label: 'GSTIN of Job Worker', type: 'text', width: 18 },
    { key: 'jwState', label: 'State (if Unregistered)', type: 'text', width: 20 },
    { key: 'jwType', label: "Job Worker's Type", type: 'text', width: 13 },
    { key: 'jobWorker', label: 'Job Worker', type: 'text', width: 24 },
    { key: 'challanNumber', label: 'Challan No.', type: 'text', width: 18 },
    { key: 'challanDate', label: 'Challan Date', type: 'date', width: 13 },
    { key: 'goodsType', label: 'Type of Goods', type: 'text', width: 10 },
    { key: 'description', label: 'Description of Goods', type: 'text', width: 30 },
    { key: 'uqc', label: 'UQC', type: 'text', width: 7 },
    { key: 'qty', label: 'Quantity', type: 'qty', total: 'none' },
    { key: 'taxableValue', label: 'Taxable Value', type: 'money', total: 'sum' },
    { key: 'igstRate', label: 'Integrated Tax %', type: 'qty', total: 'none' },
    { key: 'cgstRate', label: 'Central Tax %', type: 'qty', total: 'none' },
    { key: 'sgstRate', label: 'State/UT Tax %', type: 'qty', total: 'none' },
    { key: 'cess', label: 'Cess', type: 'money', total: 'sum' },
    { key: 'hsn', label: 'HSN (for reference)', type: 'text', width: 12 },
    { key: 'process', label: 'Work', type: 'text', width: 16 },
    { key: 'source', label: 'From', type: 'text', width: 12 },
    { key: 'check', label: 'To Check', type: 'text', width: 34 },
  ],
  summary: {
    title: 'Biggest values sent',
    columns: ['challanNumber', 'jobWorker', 'description', 'qty', 'uqc', 'taxableValue'],
    by: 'taxableValue',
    limit: 12,
  },
  pivot: {
    rows: ['jobWorker', 'challanNumber'],
    values: ['taxableValue'],
    slicers: ['source', 'jwType'],
    note: 'Open a job worker to see each challan.',
  },

  async run({ tx, params, rowCap }) {
    const period = periodOf(params)
    const company = await tx.company.findFirst({ select: { stateCode: true, gstin: true } })
    const ourState = company?.stateCode || company?.gstin?.slice(0, 2) || null
    const hsnIndex = await loadHsnIndex(tx)

    const lines = await tx.jobWorkChallanLine.findMany({
      where: { challan: { status: { not: 'CANCELLED' }, challanDate: { gte: period.from, lte: period.to } } },
      orderBy: [{ challan: { challanDate: 'asc' } }, { challan: { challanNumber: 'asc' } }],
      select: {
        qty: true,
        unitRate: true,
        hsnCode: true,
        ownership: true,
        item: { select: { name: true, hsnCode: true, uom: { select: { symbol: true } }, taxRate: { select: { rate: true } } } },
        challan: {
          select: { challanNumber: true, challanDate: true, process: true, jobWorker: { select: { name: true, gstin: true, state: true, stateCode: true } } },
        },
      },
    })
    const theirs = lines.filter((l) => l.ownership === 'CUSTOMER_OWNED').length

    const fromStore = lines
      .filter((l) => l.ownership !== 'CUSTOMER_OWNED')
      .map((l) => {
        const p = party(l.challan.jobWorker)
        const qty = Number(l.qty)
        const rate = l.unitRate == null ? null : Number(l.unitRate)
        const hsnCode = l.hsnCode || l.item.hsnCode || null
        const hsn = findHsn(hsnIndex, hsnCode)
        const gst = hsn ? gstRateFor(hsn, rate) : l.item.taxRate ? Number(l.item.taxRate.rate) : null
        const intra = ourState && p.stateCode ? ourState === p.stateCode : null
        const split = gst != null && intra != null ? splitGstRate(gst, intra) : null
        const check = [
          !p.gstin && !p.stateLabel ? 'Job worker has no GSTIN or state' : '',
          rate == null || rate === 0 ? 'No value on the challan' : '',
          gst == null ? 'No GST rate: add the HSN to the HSN master' : '',
          gst != null && intra == null ? 'State unknown: cannot split the tax' : '',
        ].filter(Boolean)
        return {
          jwGstin: p.gstin ?? '',
          jwState: p.stateLabel,
          jwType: p.type,
          jobWorker: p.name,
          challanNumber: l.challan.challanNumber,
          challanDate: l.challan.challanDate,
          goodsType: 'Inputs',
          description: l.item.name,
          uqc: uqcOf(l.item.uom?.symbol),
          qty: r3(qty),
          taxableValue: rate == null ? null : round2(qty * rate),
          igstRate: split ? split.igst : null,
          cgstRate: split ? split.cgst : null,
          sgstRate: split ? split.sgst : null,
          cess: 0,
          hsn: hsnCode ?? '',
          process: l.challan.process,
          source: 'Store challan',
          check: check.join('; '),
        }
      })

    // Production's challans to outside stages: our own orders' pieces only.
    const transfers = await tx.processTransfer.findMany({
      where: { vendorId: { not: null }, cancelledAt: null, dispatchDate: { gte: period.from, lte: period.to } },
      orderBy: [{ dispatchDate: 'asc' }, { transferNumber: 'asc' }],
      select: {
        transferNumber: true,
        dispatchDate: true,
        vendor: { select: { name: true, gstin: true, state: true, stateCode: true } },
        toStep: { select: { name: true } },
        mo: { select: { moNumber: true, so: { select: { isJobWork: true } }, lines: { select: { style: { select: { name: true } } } } } },
        lines: { select: { dispatchedQty: true } },
      },
    })
    const theirPieces = transfers.filter((t) => t.mo.so?.isJobWork).length
    const fromFloor = transfers
      .filter((t) => !t.mo.so?.isJobWork && t.vendor)
      .map((t) => {
        const p = party(t.vendor!)
        const styles = [...new Set(t.mo.lines.map((l) => l.style.name))].join(', ')
        return {
          jwGstin: p.gstin ?? '',
          jwState: p.stateLabel,
          jwType: p.type,
          jobWorker: p.name,
          challanNumber: t.transferNumber,
          challanDate: t.dispatchDate,
          goodsType: 'Inputs',
          description: `${styles || 'Garment'} pieces — ${t.mo.moNumber}`,
          uqc: 'PCS',
          qty: t.lines.reduce((s, l) => s + l.dispatchedQty, 0),
          taxableValue: null,
          igstRate: null,
          cgstRate: null,
          sgstRate: null,
          cess: 0,
          hsn: '',
          process: t.toStep.name,
          source: 'Production',
          check: [!p.gstin && !p.stateLabel ? 'Job worker has no GSTIN or state' : '', 'Value and tax rate to fill: pieces in production carry no value in the ERP']
            .filter(Boolean)
            .join('; '),
        }
      })

    const all = [...fromStore, ...fromFloor].sort((a, b) => a.challanDate.getTime() - b.challanDate.getTime() || a.challanNumber.localeCompare(b.challanNumber))
    const rows = all.slice(0, rowCap)
    const value = round2(all.reduce((s, r) => s + (r.taxableValue ?? 0), 0))
    const toCheck = all.filter((r) => r.check)
    const challans = new Set(all.map((r) => r.challanNumber)).size
    const workers = new Set(all.map((r) => r.jobWorker)).size

    const insights: string[] = []
    if (all.length) insights.push(`${challans} ${challans === 1 ? 'challan' : 'challans'} to ${workers} ${workers === 1 ? 'job worker' : 'job workers'}, ${rupees(value)} of our inputs.`)
    insights.push(period.kind === 'FY' ? `The yearly return for ${period.label} is due by ${period.due}.` : `The half-yearly return for ${period.label} is due by ${period.due}.`)
    if (toCheck.length) insights.push(`${toCheck.length} ${toCheck.length === 1 ? 'line needs' : 'lines need'} a look before filing — see To Check.`)
    if (theirs || theirPieces)
      insights.push(
        `Left out as the customers' to declare: ${[theirs ? `${theirs} store challan ${theirs === 1 ? 'line' : 'lines'}` : '', theirPieces ? `${theirPieces} production ${theirPieces === 1 ? 'challan' : 'challans'}` : ''].filter(Boolean).join(' and ')} of customers' material.`,
      )

    return {
      rows,
      totalRows: all.length > rowCap ? all.length : undefined,
      analysis: {
        headline: all.length
          ? `${period.label}: ${all.length} ${all.length === 1 ? 'line' : 'lines'} for Table 4, ${rupees(value)} of inputs sent to job workers${toCheck.length ? `; ${toCheck.length} to check` : ''}.`
          : `${period.label}: none of our own inputs went to job workers — Table 4 is empty.`,
        kpis: [
          { label: 'Challans', value: all.length ? challans : null, format: 'integer', basis: `to ${workers} job ${workers === 1 ? 'worker' : 'workers'}` },
          { label: 'Taxable value sent', value: all.length ? value : null, format: 'money', basis: 'at the rate each item left at' },
          { label: 'Lines', value: all.length || null, format: 'integer', basis: `${fromStore.length} store, ${fromFloor.length} production` },
          { label: 'To check', value: all.length ? toCheck.length : null, format: 'integer', basis: 'before filing', tone: toCheck.length ? 'warn' : 'good' },
        ],
        exceptions: toCheck.length
          ? [{ label: 'Lines to check before filing', value: toCheck.length, format: 'integer', basis: 'missing GSTIN or state, value or tax rate', tone: 'warn' }]
          : [],
        panels: [],
        insights,
        caveats: [
          `Period ${period.label}${period.chosen ? '' : ' — the half-year we are in, as no period was picked'}: challans dated in it.`,
          "Only our own inputs. A customer's material sent on is theirs to declare as principal, so it is left out.",
          'A registered job worker is named by GSTIN; an unregistered one by state code and name.',
          'Tax rates come from the HSN master (else the item’s own rate), split into Central and State tax when the job worker is in our state, Integrated tax when not. Cess is nil.',
          'Production pieces have no value in the ERP: fill their value and rate before filing.',
          'This is the form’s content, not the GST offline tool’s file: copy it into ITC_04_Offline.xls and let the tool check it.',
        ],
      },
    }
  },
}
