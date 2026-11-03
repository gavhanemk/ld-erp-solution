import type { Prisma } from '@prisma/client'
import { AppError } from '../../middleware/errorHandler'
import { chargeShares } from '../salesCharges'
import { uqcOf } from '../../reports/definitions/itc04-shared'
import { istDay, r2 } from './books.service'

/**
 * GST returns from the documents: GSTR-1 (outward supplies, and the file the
 * portal takes), the GSTR-3B working (tax on sales, input credit on
 * purchases, how the credit pays the tax and what is left to pay in cash),
 * and GSTR-2B matching (what suppliers filed against what was booked).
 *
 * The figures come from the invoices, credit notes, bills and notes
 * themselves, at the rates and values frozen on them — the same documents
 * the books are posted from, so the returns and the ledgers agree.
 */

type Tx = Prisma.TransactionClient

const B2CL_LIMIT = 100_000
const range = (from: string, to: string) => ({ gte: new Date(`${from}T00:00:00+05:30`), lte: new Date(`${to}T23:59:59.999+05:30`) })
/** "2026-10-07" → "07-10-2026", as the portal writes dates. */
const portalDate = (ymd: string) => `${ymd.slice(8, 10)}-${ymd.slice(5, 7)}-${ymd.slice(0, 4)}`

async function company(tx: Tx) {
  const c = await tx.company.findFirst({ select: { gstin: true, stateCode: true, legalName: true, name: true } })
  if (!c?.gstin || !c.stateCode) throw new AppError("The company's GSTIN and state are needed first (Settings → Company).", 409, 'NO_GSTIN')
  return { gstin: c.gstin, state: c.stateCode.padStart(2, '0'), name: c.legalName || c.name }
}

interface Tax {
  taxable: number
  igst: number
  cgst: number
  sgst: number
}
const zero = (): Tax => ({ taxable: 0, igst: 0, cgst: 0, sgst: 0 })
const addTo = (t: Tax, v: Tax, sign = 1) => {
  t.taxable = r2(t.taxable + sign * v.taxable)
  t.igst = r2(t.igst + sign * v.igst)
  t.cgst = r2(t.cgst + sign * v.cgst)
  t.sgst = r2(t.sgst + sign * v.sgst)
}

interface RateRow extends Tax {
  rate: number
}
interface HsnRow extends Tax {
  hsn: string
  desc: string
  uqc: string
  qty: number
  rate: number
}

interface OutDoc {
  id: string
  number: string
  date: string
  value: number
  customer: string
  gstin: string | null
  pos: string
  inter: boolean
  rates: RateRow[]
  hsn: HsnRow[]
  /** For a credit note: the invoice it is against. */
  invoice?: { number: string; date: string; value: number } | null
}

/** The rate rows and HSN rows of one document, charges folded in at the goods' rate. */
function shape(
  lines: Array<{ hsnCode: string | null; gstRate: unknown; qty: unknown; taxableValue: unknown; cgst: unknown; sgst: unknown; igst: unknown; item: { name: string; uom: { symbol: string } | null } }>,
  charges: Array<{ name: string; gstRate: number; amount: number; cgst: number; sgst: number; igst: number }>,
) {
  const rates = new Map<number, RateRow>()
  const hsn = new Map<string, HsnRow>()
  const goods = lines.map((l) => ({ hsnCode: l.hsnCode, gstRate: Number(l.gstRate), taxable: Number(l.taxableValue), cgst: Number(l.cgst), sgst: Number(l.sgst), igst: Number(l.igst) }))
  const rateOf = (rate: number) => rates.get(rate) ?? (rates.set(rate, { rate, ...zero() }), rates.get(rate)!)
  lines.forEach((l, i) => {
    const g = goods[i]
    addTo(rateOf(g.gstRate), g)
    const uqc = uqcOf(l.item.uom?.symbol)
    const key = `${l.hsnCode ?? '—'}|${g.gstRate}|${uqc}`
    const h = hsn.get(key) ?? { hsn: l.hsnCode ?? '', desc: l.item.name, uqc, qty: 0, rate: g.gstRate, ...zero() }
    h.qty = r2(h.qty + Number(l.qty))
    addTo(h, g)
    hsn.set(key, h)
  })
  for (const c of charges) addTo(rateOf(c.gstRate), { taxable: c.amount, igst: c.igst, cgst: c.cgst, sgst: c.sgst })
  for (const sh of chargeShares(goods, charges)) {
    const key = [...hsn.keys()].find((k) => k.startsWith(`${sh.hsn}|${sh.rate}|`)) ?? `${sh.hsn}|${sh.rate}|OTH`
    const h = hsn.get(key) ?? { hsn: sh.charge ? '' : sh.hsn, desc: sh.hsn, uqc: 'OTH', qty: 0, rate: sh.rate, ...zero() }
    addTo(h, { taxable: sh.taxable, igst: sh.igst, cgst: sh.cgst, sgst: sh.sgst })
    hsn.set(key, h)
  }
  return { rates: [...rates.values()], hsn: [...hsn.values()] }
}

/** Every invoice and credit note in the period, with what each is made of. */
async function outward(tx: Tx, from: string, to: string, ourState: string) {
  const lineSelect = { hsnCode: true, gstRate: true, qty: true, taxableValue: true, cgst: true, sgst: true, igst: true, item: { select: { name: true, uom: { select: { symbol: true } } } } } as const
  const [invoices, notes] = await Promise.all([
    tx.salesInvoice.findMany({
      where: { invoiceDate: range(from, to) },
      orderBy: [{ invoiceDate: 'asc' }, { invoiceNumber: 'asc' }],
      select: {
        id: true,
        invoiceNumber: true,
        invoiceDate: true,
        totalAmount: true,
        status: true,
        placeOfSupplyCode: true,
        customer: { select: { name: true, gstin: true, billingStateCode: true } },
        lines: { select: lineSelect },
        charges: { select: { amount: true, gstRate: true, cgst: true, sgst: true, igst: true, chargeType: { select: { name: true } } } },
      },
    }),
    tx.creditNote.findMany({
      where: { noteDate: range(from, to), status: { in: ['ISSUED', 'CANCELLED'] } },
      orderBy: [{ noteDate: 'asc' }, { noteNumber: 'asc' }],
      select: {
        id: true,
        noteNumber: true,
        noteDate: true,
        totalAmount: true,
        status: true,
        placeOfSupplyCode: true,
        customer: { select: { name: true, gstin: true, billingStateCode: true } },
        invoice: { select: { invoiceNumber: true, invoiceDate: true, totalAmount: true, placeOfSupplyCode: true } },
        lines: { select: lineSelect },
      },
    }),
  ])
  const posOf = (p: string | null | undefined, c: { billingStateCode: string | null; gstin: string | null }) => (p || c.billingStateCode || c.gstin?.slice(0, 2) || ourState).padStart(2, '0')
  const docs: OutDoc[] = []
  const cancelled: string[] = []
  for (const inv of invoices) {
    if (inv.status === 'CANCELLED') {
      cancelled.push(inv.invoiceNumber)
      continue
    }
    const pos = posOf(inv.placeOfSupplyCode, inv.customer)
    const charges = inv.charges.filter((c) => Number(c.amount) > 0).map((c) => ({ name: c.chargeType.name, gstRate: Number(c.gstRate), amount: Number(c.amount), cgst: Number(c.cgst), sgst: Number(c.sgst), igst: Number(c.igst) }))
    docs.push({
      id: inv.id,
      number: inv.invoiceNumber,
      date: istDay(inv.invoiceDate),
      value: Number(inv.totalAmount),
      customer: inv.customer.name,
      gstin: inv.customer.gstin?.trim().toUpperCase() || null,
      pos,
      inter: pos !== ourState,
      ...shape(inv.lines, charges),
    })
  }
  const credit: OutDoc[] = []
  const cancelledNotes: string[] = []
  for (const n of notes) {
    if (n.status === 'CANCELLED') {
      cancelledNotes.push(n.noteNumber)
      continue
    }
    const pos = posOf(n.placeOfSupplyCode ?? n.invoice?.placeOfSupplyCode, n.customer)
    credit.push({
      id: n.id,
      number: n.noteNumber,
      date: istDay(n.noteDate),
      value: Number(n.totalAmount),
      customer: n.customer.name,
      gstin: n.customer.gstin?.trim().toUpperCase() || null,
      pos,
      inter: pos !== ourState,
      invoice: n.invoice ? { number: n.invoice.invoiceNumber, date: istDay(n.invoice.invoiceDate), value: Number(n.invoice.totalAmount) } : null,
      ...shape(n.lines, []),
    })
  }
  return { docs, credit, cancelled, cancelledNotes, issued: invoices.map((i) => i.invoiceNumber), notesIssued: notes.map((x) => x.noteNumber) }
}

/** Number ranges by series: "INV-2627-0001" to "-0042", 42 issued, 1 cancelled. */
function series(numbers: string[], cancelled: string[]) {
  const groups = new Map<string, string[]>()
  for (const num of numbers) {
    const prefix = num.replace(/\d+$/, '')
    groups.set(prefix, [...(groups.get(prefix) ?? []), num])
  }
  const cut = new Set(cancelled)
  return [...groups.entries()].map(([prefix, nums]) => {
    const sorted = [...nums].sort()
    const c = nums.filter((n) => cut.has(n)).length
    return { prefix, from: sorted[0], to: sorted[sorted.length - 1], total: nums.length, cancelled: c, net: nums.length - c }
  })
}

// ═══════════════════════════════════════════
// GSTR-1
// ═══════════════════════════════════════════

export async function gstr1(tx: Tx, from: string, to: string) {
  const co = await company(tx)
  const { docs, credit, cancelled, cancelledNotes, issued, notesIssued } = await outward(tx, from, to, co.state)
  const taxed = (d: OutDoc) => d.rates.filter((r) => r.rate > 0)
  const b2b = docs.filter((d) => d.gstin)
  const b2cl = docs.filter((d) => !d.gstin && d.inter && d.value > B2CL_LIMIT)
  const small = docs.filter((d) => !d.gstin && !(d.inter && d.value > B2CL_LIMIT))
  const cdnr = credit.filter((d) => d.gstin)
  const cdnur = credit.filter((d) => !d.gstin && d.inter && (d.invoice?.value ?? d.value) > B2CL_LIMIT)
  const smallNotes = credit.filter((d) => !d.gstin && !(d.inter && (d.invoice?.value ?? d.value) > B2CL_LIMIT))

  // B2CS: one row per place of supply and rate, small sales less their credit notes.
  const b2csMap = new Map<string, RateRow & { pos: string; inter: boolean }>()
  const intoB2cs = (d: OutDoc, sign: number) => {
    for (const r of taxed(d)) {
      const key = `${d.pos}|${r.rate}`
      const e = b2csMap.get(key) ?? { pos: d.pos, inter: d.inter, rate: r.rate, ...zero() }
      addTo(e, r, sign)
      b2csMap.set(key, e)
    }
  }
  small.forEach((d) => intoB2cs(d, 1))
  smallNotes.forEach((d) => intoB2cs(d, -1))

  // Nil-rated: every rate-0 row, by registered or not and inside the state or across it.
  const nil = new Map<string, number>()
  for (const d of docs) for (const r of d.rates.filter((x) => x.rate === 0)) {
    const k = `${d.inter ? 'INTR' : 'INTRA'}${d.gstin ? 'B2B' : 'B2C'}`
    nil.set(k, r2((nil.get(k) ?? 0) + r.taxable))
  }

  // HSN summary, sales to the registered apart from the rest, credit notes taken off.
  const hsnOf = (list: OutDoc[], notes: OutDoc[]) => {
    const m = new Map<string, HsnRow>()
    const add = (h: HsnRow, sign: number) => {
      const key = `${h.hsn}|${h.rate}|${h.uqc}`
      const e = m.get(key) ?? { ...h, qty: 0, ...zero() }
      e.qty = r2(e.qty + sign * h.qty)
      addTo(e, h, sign)
      m.set(key, e)
    }
    list.forEach((d) => d.hsn.forEach((h) => add(h, 1)))
    notes.forEach((d) => d.hsn.forEach((h) => add(h, -1)))
    return [...m.values()].filter((h) => h.taxable !== 0 || h.qty !== 0).sort((a, b) => a.hsn.localeCompare(b.hsn) || a.rate - b.rate)
  }
  const hsnB2b = hsnOf(b2b, cdnr)
  const hsnB2c = hsnOf(docs.filter((d) => !d.gstin), credit.filter((d) => !d.gstin))

  const sum = (rows: Tax[]) => rows.reduce((t, r) => (addTo(t, r), t), zero())
  const docTotal = (list: OutDoc[]) => sum(list.flatMap(taxed))
  return {
    gstin: co.gstin,
    period: { from, to, fp: `${to.slice(5, 7)}${to.slice(0, 4)}` },
    b2b,
    b2cl,
    b2cs: [...b2csMap.values()].filter((r) => r.taxable !== 0).sort((a, b) => a.pos.localeCompare(b.pos) || a.rate - b.rate),
    cdnr,
    cdnur,
    nil: [...nil.entries()].map(([type, amount]) => ({ type, amount })),
    hsnB2b,
    hsnB2c,
    docs: { invoices: series(issued, cancelled), notes: series(notesIssued, cancelledNotes) },
    totals: {
      b2b: { count: b2b.length, ...docTotal(b2b) },
      b2cl: { count: b2cl.length, ...docTotal(b2cl) },
      b2cs: { ...sum([...b2csMap.values()]) },
      cdnr: { count: cdnr.length, ...docTotal(cdnr) },
      cdnur: { count: cdnur.length, ...docTotal(cdnur) },
      // Net outward supply: what GSTR-3B 3.1(a) carries.
      net: (() => {
        const t = docTotal(docs)
        addTo(t, docTotal(credit), -1)
        return t
      })(),
    },
  }
}

const itm = (rows: RateRow[], inter: boolean) =>
  rows
    .filter((r) => r.rate > 0)
    .map((r, i) => ({ num: i + 1, itm_det: inter ? { txval: r2(r.taxable), rt: r.rate, iamt: r2(r.igst), csamt: 0 } : { txval: r2(r.taxable), rt: r.rate, camt: r2(r.cgst), samt: r2(r.sgst), csamt: 0 } }))

/** GSTR-1 as the portal takes it (the offline tool's JSON). */
export function gstr1Json(g: Awaited<ReturnType<typeof gstr1>>) {
  const byCtin = <T>(list: OutDoc[], each: (d: OutDoc) => T) => {
    const m = new Map<string, T[]>()
    for (const d of list) m.set(d.gstin!, [...(m.get(d.gstin!) ?? []), each(d)])
    return [...m.entries()]
  }
  const hsn = (rows: HsnRow[]) =>
    rows.map((h, i) => ({
      num: i + 1,
      hsn_sc: h.hsn,
      desc: h.desc.slice(0, 30),
      uqc: h.uqc || 'OTH',
      qty: r2(h.qty),
      rt: h.rate,
      txval: r2(h.taxable),
      iamt: r2(h.igst),
      camt: r2(h.cgst),
      samt: r2(h.sgst),
      csamt: 0,
    }))
  const docDet = [
    ...(g.docs.invoices.length ? [{ doc_num: 1, doc_typ: 'Invoices for outward supply', docs: g.docs.invoices.map((s, i) => ({ num: i + 1, from: s.from, to: s.to, totnum: s.total, cancel: s.cancelled, net_issue: s.net })) }] : []),
    ...(g.docs.notes.length ? [{ doc_num: 5, doc_typ: 'Credit Note', docs: g.docs.notes.map((s, i) => ({ num: i + 1, from: s.from, to: s.to, totnum: s.total, cancel: s.cancelled, net_issue: s.net })) }] : []),
  ]
  return {
    gstin: g.gstin,
    fp: g.period.fp,
    ...(g.b2b.length ? { b2b: byCtin(g.b2b, (d) => ({ inum: d.number, idt: portalDate(d.date), val: r2(d.value), pos: d.pos, rchrg: 'N', inv_typ: 'R', itms: itm(d.rates, d.inter) })).map(([ctin, inv]) => ({ ctin, inv })) } : {}),
    ...(g.b2cl.length
      ? {
          b2cl: [...new Set(g.b2cl.map((d) => d.pos))].map((pos) => ({
            pos,
            inv: g.b2cl.filter((d) => d.pos === pos).map((d) => ({ inum: d.number, idt: portalDate(d.date), val: r2(d.value), itms: itm(d.rates, true) })),
          })),
        }
      : {}),
    ...(g.b2cs.length
      ? {
          b2cs: g.b2cs.map((r) =>
            r.inter
              ? { sply_ty: 'INTER', pos: r.pos, typ: 'OE', rt: r.rate, txval: r2(r.taxable), iamt: r2(r.igst), csamt: 0 }
              : { sply_ty: 'INTRA', pos: r.pos, typ: 'OE', rt: r.rate, txval: r2(r.taxable), camt: r2(r.cgst), samt: r2(r.sgst), csamt: 0 },
          ),
        }
      : {}),
    ...(g.cdnr.length
      ? { cdnr: byCtin(g.cdnr, (d) => ({ ntty: 'C', nt_num: d.number, nt_dt: portalDate(d.date), val: r2(d.value), pos: d.pos, rchrg: 'N', inv_typ: 'R', itms: itm(d.rates, d.inter) })).map(([ctin, nt]) => ({ ctin, nt })) }
      : {}),
    ...(g.cdnur.length ? { cdnur: g.cdnur.map((d) => ({ typ: 'B2CL', ntty: 'C', nt_num: d.number, nt_dt: portalDate(d.date), val: r2(d.value), pos: d.pos, itms: itm(d.rates, true) })) } : {}),
    ...(g.nil.length
      ? { nil: { inv: g.nil.map((x) => ({ sply_ty: x.type, nil_amt: x.amount, expt_amt: 0, ngsup_amt: 0 })) } }
      : {}),
    hsn: { ...(g.hsnB2b.length ? { hsn_b2b: hsn(g.hsnB2b) } : {}), ...(g.hsnB2c.length ? { hsn_b2c: hsn(g.hsnB2c) } : {}) },
    ...(docDet.length ? { doc_issue: { doc_det: docDet } } : {}),
  }
}

// ═══════════════════════════════════════════
// GSTR-3B
// ═══════════════════════════════════════════

const GST_COUNTS = new Set(['GST_CREDIT_NOTE', 'GST_DEBIT_NOTE', 'ITC_REVERSAL_ONLY'])

export async function gstr3b(tx: Tx, from: string, to: string) {
  const g = await gstr1(tx, from, to)
  // 3.1(a): taxable outward supplies, less credit notes; (c): nil-rated.
  const outward = g.totals.net
  const nilRated = r2(g.nil.reduce((t, x) => t + x.amount, 0))
  // 3.2: inter-state supplies to the unregistered, by place of supply.
  const toUnregistered = new Map<string, { pos: string; taxable: number; igst: number }>()
  for (const r of g.b2cs.filter((x) => x.inter)) {
    const e = toUnregistered.get(r.pos) ?? { pos: r.pos, taxable: 0, igst: 0 }
    e.taxable = r2(e.taxable + r.taxable)
    e.igst = r2(e.igst + r.igst)
    toUnregistered.set(r.pos, e)
  }
  for (const d of [...g.b2cl, ...g.cdnur]) {
    const sign = g.cdnur.includes(d) ? -1 : 1
    const e = toUnregistered.get(d.pos) ?? { pos: d.pos, taxable: 0, igst: 0 }
    for (const r of d.rates) {
      e.taxable = r2(e.taxable + sign * r.taxable)
      e.igst = r2(e.igst + sign * r.igst)
    }
    toUnregistered.set(d.pos, e)
  }

  const [bills, notes] = await Promise.all([
    tx.purchaseInvoice.findMany({
      where: { billDate: range(from, to), status: { not: 'CANCELLED' } },
      select: { taxableAmount: true, cgst: true, sgst: true, igst: true, isReverseCharge: true, supplier: { select: { gstin: true } } },
    }),
    tx.purchaseNote.findMany({
      where: { noteDate: range(from, to), status: 'POSTED' },
      select: { effect: true, gstTreatment: true, taxableAmount: true, cgst: true, sgst: true, igst: true },
    }),
  ])
  const rcm = zero()
  const itcOther = zero()
  for (const b of bills) {
    const t = { taxable: Number(b.taxableAmount), igst: Number(b.igst), cgst: Number(b.cgst), sgst: Number(b.sgst) }
    if (b.isReverseCharge) addTo(rcm, t)
    else if (b.supplier.gstin && t.igst + t.cgst + t.sgst > 0) addTo(itcOther, t)
  }
  const reversed = zero()
  for (const n of notes) {
    if (!GST_COUNTS.has(n.gstTreatment)) continue
    const t = { taxable: Number(n.taxableAmount), igst: Number(n.igst), cgst: Number(n.cgst), sgst: Number(n.sgst) }
    if (n.effect === 'REDUCES_PAYABLE') addTo(reversed, t)
    else addTo(itcOther, t)
  }
  const itc = { igst: r2(rcm.igst + itcOther.igst - reversed.igst), cgst: r2(rcm.cgst + itcOther.cgst - reversed.cgst), sgst: r2(rcm.sgst + itcOther.sgst - reversed.sgst) }
  const setOff = setOffCredit({ igst: outward.igst, cgst: outward.cgst, sgst: outward.sgst }, itc)

  // What the books say for the same period, to see the return and the ledgers agree.
  const ledgerMove = async (keys: string[]) => {
    const rows = await tx.voucherLine.groupBy({
      by: ['ledgerId'],
      where: { ledger: { systemKey: { in: keys } }, voucher: { status: 'POSTED', date: range(from, to) } },
      _sum: { debit: true, credit: true },
    })
    const ledgers = await tx.ledger.findMany({ where: { systemKey: { in: keys } }, select: { id: true, systemKey: true } })
    const k = new Map(ledgers.map((l) => [l.id, l.systemKey!]))
    const out: Record<string, number> = {}
    for (const r of rows) out[k.get(r.ledgerId)!] = r2(Number(r._sum.credit ?? 0) - Number(r._sum.debit ?? 0))
    return out
  }
  const [outputBooks, inputBooks] = await Promise.all([ledgerMove(['OUTPUT_IGST', 'OUTPUT_CGST', 'OUTPUT_SGST']), ledgerMove(['INPUT_IGST', 'INPUT_CGST', 'INPUT_SGST'])])

  return {
    gstin: g.gstin,
    period: g.period,
    outward,
    nilRated,
    rcmInward: rcm,
    toUnregistered: [...toUnregistered.values()].filter((x) => x.taxable !== 0),
    itc: { rcm: { igst: rcm.igst, cgst: rcm.cgst, sgst: rcm.sgst }, other: { igst: itcOther.igst, cgst: itcOther.cgst, sgst: itcOther.sgst }, reversed: { igst: reversed.igst, cgst: reversed.cgst, sgst: reversed.sgst }, net: itc },
    setOff,
    /** Reverse-charge tax is paid in cash, never from credit. */
    rcmCash: { igst: rcm.igst, cgst: rcm.cgst, sgst: rcm.sgst },
    books: {
      output: { igst: outputBooks.OUTPUT_IGST ?? 0, cgst: outputBooks.OUTPUT_CGST ?? 0, sgst: outputBooks.OUTPUT_SGST ?? 0 },
      input: { igst: -(inputBooks.INPUT_IGST ?? 0), cgst: -(inputBooks.INPUT_CGST ?? 0), sgst: -(inputBooks.INPUT_SGST ?? 0) },
    },
  }
}

type Heads = { igst: number; cgst: number; sgst: number }

/**
 * Input credit set against tax, in the order the law lays down (rule 88A):
 * IGST credit first against IGST, then against CGST and SGST; only then CGST
 * credit against CGST and then IGST, and SGST credit against SGST and then
 * IGST. CGST credit never pays SGST, nor SGST credit CGST. What is left of the
 * tax is paid in cash; what is left of the credit carries to next month.
 */
export function setOffCredit(liability: Heads, credit: Heads) {
  const due = { ...liability }
  const left = { ...credit }
  const paid = { igst: { igst: 0, cgst: 0, sgst: 0 }, cgst: { igst: 0, cgst: 0 }, sgst: { igst: 0, sgst: 0 } }
  const use = (from: keyof Heads, to: keyof Heads, cap = Infinity) => {
    const a = r2(Math.max(0, Math.min(left[from], due[to], cap)))
    left[from] = r2(left[from] - a)
    due[to] = r2(due[to] - a)
    return a
  }
  paid.igst.igst = use('igst', 'igst')
  // IGST credit to CGST and SGST where their own credit falls short.
  const needC = Math.max(0, due.cgst - left.cgst)
  const needS = Math.max(0, due.sgst - left.sgst)
  paid.igst.cgst = use('igst', 'cgst', needC)
  paid.igst.sgst = use('igst', 'sgst', needS)
  paid.igst.cgst = r2(paid.igst.cgst + use('igst', 'cgst'))
  paid.igst.sgst = r2(paid.igst.sgst + use('igst', 'sgst'))
  paid.cgst.cgst = use('cgst', 'cgst')
  paid.cgst.igst = use('cgst', 'igst')
  paid.sgst.sgst = use('sgst', 'sgst')
  paid.sgst.igst = use('sgst', 'igst')
  return { liability, credit, paid, cash: due, carried: left }
}

// ═══════════════════════════════════════════
// GSTR-2B MATCHING
// ═══════════════════════════════════════════

interface TwoB {
  gstin: string
  name: string
  number: string
  date: string
  kind: 'invoice' | 'credit' | 'debit'
  taxable: number
  igst: number
  cgst: number
  sgst: number
  itcAvailable: boolean
}

const key = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, '').replace(/^0+/, '')
const ymdOf = (d: string) => (/^\d{2}-\d{2}-\d{4}$/.test(d) ? `${d.slice(6)}-${d.slice(3, 5)}-${d.slice(0, 2)}` : d.slice(0, 10))

/** The documents in a GSTR-2B file downloaded from the portal (its JSON). */
export function read2b(raw: unknown): TwoB[] {
  const root = (raw as { data?: { docdata?: unknown } })?.data?.docdata ?? (raw as { docdata?: unknown })?.docdata
  if (!root || typeof root !== 'object') throw new AppError('That is not a GSTR-2B file. Download the JSON of GSTR-2B from the GST portal and upload it as it is.', 400, 'NOT_2B')
  const out: TwoB[] = []
  type Money = { txval?: number; igst?: number; cgst?: number; sgst?: number; items?: Money[] }
  const money = (x: Money) => {
    const items = x.items?.length ? x.items : [x]
    return {
      taxable: r2(items.reduce((t, i) => t + Number(i.txval ?? 0), 0)),
      igst: r2(items.reduce((t, i) => t + Number(i.igst ?? 0), 0)),
      cgst: r2(items.reduce((t, i) => t + Number(i.cgst ?? 0), 0)),
      sgst: r2(items.reduce((t, i) => t + Number(i.sgst ?? 0), 0)),
    }
  }
  const d = root as { b2b?: Array<{ ctin: string; trdnm?: string; inv?: Array<Money & { inum: string; dt: string; itcavl?: string }> }>; cdnr?: Array<{ ctin: string; trdnm?: string; nt?: Array<Money & { ntnum: string; dt: string; typ?: string; itcavl?: string }> }> }
  for (const s of d.b2b ?? []) for (const inv of s.inv ?? []) {
    out.push({ gstin: s.ctin.toUpperCase(), name: s.trdnm ?? '', number: inv.inum, date: ymdOf(inv.dt), kind: 'invoice', itcAvailable: inv.itcavl !== 'N', ...money(inv) })
  }
  for (const s of d.cdnr ?? []) for (const nt of s.nt ?? []) {
    out.push({ gstin: s.ctin.toUpperCase(), name: s.trdnm ?? '', number: nt.ntnum, date: ymdOf(nt.dt), kind: nt.typ === 'D' ? 'debit' : 'credit', itcAvailable: nt.itcavl !== 'N', ...money(nt) })
  }
  return out
}

/**
 * Each supplier invoice in GSTR-2B set against the purchase bills booked
 * here: by the supplier's GSTIN and their invoice number. A bill booked in
 * the period that no supplier filed shows too — its credit is not yet safe
 * to claim.
 */
export async function match2b(tx: Tx, entries: TwoB[], from: string, to: string) {
  const gstins = [...new Set(entries.map((e) => e.gstin))]
  const bills = await tx.purchaseInvoice.findMany({
    where: { status: { not: 'CANCELLED' }, OR: [{ supplier: { gstin: { in: gstins } } }, { billDate: range(from, to) }] },
    select: {
      id: true,
      billNumber: true,
      supplierInvoiceNo: true,
      supplierInvoiceDate: true,
      billDate: true,
      taxableAmount: true,
      cgst: true,
      sgst: true,
      igst: true,
      isReverseCharge: true,
      supplier: { select: { name: true, gstin: true } },
    },
  })
  const pool = new Map<string, (typeof bills)[number]>()
  for (const b of bills) if (b.supplier.gstin && b.supplierInvoiceNo) pool.set(`${b.supplier.gstin.toUpperCase()}|${key(b.supplierInvoiceNo)}`, b)
  const used = new Set<string>()
  const rows = entries
    .filter((e) => e.kind === 'invoice')
    .map((e) => {
      const b = pool.get(`${e.gstin}|${key(e.number)}`)
      if (b) used.add(b.id)
      const books = b ? { taxable: Number(b.taxableAmount), igst: Number(b.igst), cgst: Number(b.cgst), sgst: Number(b.sgst) } : null
      const taxDiff = books ? r2(e.igst + e.cgst + e.sgst - (books.igst + books.cgst + books.sgst)) : null
      const taxableDiff = books ? r2(e.taxable - books.taxable) : null
      const status = !b ? 'only-2b' : Math.abs(taxDiff!) <= 1 && Math.abs(taxableDiff!) <= 1 ? 'matched' : 'differs'
      return {
        status,
        supplier: b?.supplier.name ?? e.name,
        gstin: e.gstin,
        number: e.number,
        date: e.date,
        twoB: { taxable: e.taxable, igst: e.igst, cgst: e.cgst, sgst: e.sgst },
        books,
        bill: b ? { id: b.id, billNumber: b.billNumber, billDate: istDay(b.billDate) } : null,
        taxDiff,
        itcAvailable: e.itcAvailable,
      }
    })
  const onlyBooks = bills
    .filter((b) => !used.has(b.id) && b.supplier.gstin && !b.isReverseCharge && Number(b.cgst) + Number(b.sgst) + Number(b.igst) > 0 && istDay(b.billDate) >= from && istDay(b.billDate) <= to)
    .map((b) => ({
      status: 'only-books' as const,
      supplier: b.supplier.name,
      gstin: b.supplier.gstin!,
      number: b.supplierInvoiceNo ?? b.billNumber,
      date: istDay(b.supplierInvoiceDate ?? b.billDate),
      twoB: null,
      books: { taxable: Number(b.taxableAmount), igst: Number(b.igst), cgst: Number(b.cgst), sgst: Number(b.sgst) },
      bill: { id: b.id, billNumber: b.billNumber, billDate: istDay(b.billDate) },
      taxDiff: null,
      itcAvailable: false,
    }))
  const all = [...rows, ...onlyBooks]
  const tax = (x: { igst: number; cgst: number; sgst: number } | null) => (x ? r2(x.igst + x.cgst + x.sgst) : 0)
  const count = (s: string) => all.filter((r) => r.status === s).length
  return {
    rows: all,
    notes: entries.filter((e) => e.kind !== 'invoice'),
    summary: {
      matched: count('matched'),
      differs: count('differs'),
      only2b: count('only-2b'),
      onlyBooks: count('only-books'),
      taxIn2b: r2(rows.reduce((t, r) => t + tax(r.twoB), 0)),
      taxInBooks: r2(all.reduce((t, r) => t + tax(r.books), 0)),
      taxSafe: r2(all.filter((r) => r.status === 'matched' && r.itcAvailable).reduce((t, r) => t + tax(r.books), 0)),
    },
  }
}
