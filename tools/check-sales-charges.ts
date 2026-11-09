// Charges on quotations and sales orders, through the server's own pricing
// (prepareOrder, createQuote) against a real database, inside one
// transaction that always rolls back: nothing is kept, no number is used.
//
// The business's own case first — 800 shirts at ₹378 (5%) and ₹1,200 of
// transport typed as the final figure: the order totals ₹3,18,720, not
// ₹3,18,780, and the ₹57.14 of GST inside the transport is still worked out,
// stored and reported. Then GST added on top, no GST, across states, a
// charge at its own rate, discounts, a quotation saved with charges and read
// back, the order made from it priced to the same rupee, and a charge type's
// own setting deciding when the form sends none. Then the invoice for such
// an order: what its form is offered, what it bills, the voucher it posts
// (a books start set inside the transaction) and its GSTR-1 entry.
//
// Needs any active customer with a GSTIN, any active finished good whose HSN code taxes
// it at 5% at ₹378 a piece, and the Transport Charges and Packing Charges
// types. Refuses any database that is not on this machine. From apps/api:
//
//   DATABASE_URL="postgresql://postgres:demo@localhost:5433/lderp_demo?schema=ld_erp" \
//   npx tsx ../../tools/check-sales-charges.ts
import { prisma } from '../packages/database/src/index'
import { createSalesOrderSchema, prepareOrder } from '../apps/api/src/routes/sales.routes'
import { createQuote, quoteSchema } from '../apps/api/src/routes/quotation.routes'
import { findHsn, gstRateFor, loadHsnIndex } from '../apps/api/src/lib/hsn'
import { chargesStillToBill, createInvoice, invoiceSchema, loadBillable } from '../apps/api/src/routes/invoice.routes'
import { gstr1 } from '../apps/api/src/services/accounts/gst.service'
import { postDocument } from '../apps/api/src/services/accounts/posting.service'
import { chargeRowOf } from '../apps/api/src/services/salesCharges'

let pass = 0
let fail = 0
const check = (label: string, ok: boolean, extra: unknown = '') => {
  ok ? pass++ : fail++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${ok || extra === '' ? '' : ' — ' + (typeof extra === 'string' ? extra : JSON.stringify(extra))}`)
}
const N = (v: unknown) => Number(v)
const ROLLBACK = new Error('ROLLBACK')

function refuseUnlessLocal() {
  const url = process.env.DATABASE_URL ?? ''
  let host = ''
  try {
    host = new URL(url).hostname
  } catch {
    host = ''
  }
  if (!['localhost', '127.0.0.1'].includes(host)) throw new Error(`Refusing to run against ${host || 'an unknown database'}: this check is for a database on this machine only.`)
}

async function main() {
  refuseUnlessLocal()
  await prisma
    .$transaction(
      async (tx) => {
        // ── What the check works with ──
        const company = await tx.company.findFirst({ select: { stateCode: true, gstin: true } })
        const home = company?.stateCode || company?.gstin?.slice(0, 2) || '27'
        const away = home === '07' ? '29' : '07'
        const customer = await tx.customer.findFirst({ where: { isActive: true, gstin: { not: null } }, select: { id: true, name: true, gstin: true } })
        if (!customer) throw new Error('No active customer to price for')
        const index = await loadHsnIndex(tx)
        const items = await tx.item.findMany({ where: { isActive: true, type: 'FINISHED_GOOD', hsnCode: { not: null } }, select: { id: true, code: true, hsnCode: true } })
        const item = items.find((i) => {
          const h = findHsn(index, i.hsnCode)
          return h && gstRateFor(h, 378) === 5
        })
        if (!item) throw new Error('No finished good taxed at 5% at ₹378')
        const types = await tx.chargeType.findMany({ where: { name: { in: ['Transport Charges', 'Packing Charges'] }, isActive: true, applyOnSale: true } })
        const transport = types.find((t) => t.name === 'Transport Charges')
        const packing = types.find((t) => t.name === 'Packing Charges')
        if (!transport || !packing) throw new Error('Transport Charges and Packing Charges must be on for sales')
        check(
          `setup: ${item.code} at 5% for ₹378, ${customer.name}, Transport Charges starts GST-inclusive and follows the goods' rate`,
          transport.taxTreatment === 'INCLUSIVE' && transport.followsGoodsRate === true,
          { treatment: transport.taxTreatment, follows: transport.followsGoodsRate },
        )

        const order = (charges: unknown[], extra: Record<string, unknown> = {}) =>
          prepareOrder(
            tx,
            createSalesOrderSchema.parse({
              customerId: customer.id,
              placeOfSupplyCode: home,
              lines: [{ itemId: item.id, totalQty: 800, unitPrice: 378 }],
              charges,
              ...extra,
            }),
            { piecesOnly: true },
          )

        // ── The business's case: ₹1,200 of transport, GST included (the charge type's own setting) ──
        const a = await order([{ chargeTypeId: transport.id, amount: 1200 }])
        const ac = a.charges[0]
        check('order: ₹1,200 transport, no treatment sent: the charge type\'s GST-inclusive is used', ac.taxTreatment === 'INCLUSIVE', ac)
        check('order: total ₹3,18,720 — no ₹60 added on top', N(a.header.totalAmount) === 318720, a.header.totalAmount)
        check('order: the ₹1,200 is stored as typed, with its value ₹1,142.86 and the ₹57.14 GST inside it', N(ac.amount) === 1200 && N(ac.netAmount) === 1142.86 && N(ac.cgst) === 28.57 && N(ac.sgst) === 28.57 && N(ac.igst) === 0, ac)
        check('order: CGST = SGST = ₹7,588.57 (₹7,560 on the shirts + ₹28.57 inside the transport), goods taxable ₹3,02,400', N(a.header.cgst) === 7588.57 && N(a.header.sgst) === 7588.57 && N(a.header.taxableAmount) === 302400 && N(a.header.roundOff) === 0, a.header)

        // ── GST added on top, as before ──
        const b = await order([{ chargeTypeId: transport.id, amount: 1200, taxTreatment: 'EXCLUSIVE' }])
        check('order: GST added on top when the row says so: ₹3,18,780, ₹60 on the transport', N(b.header.totalAmount) === 318780 && N(b.charges[0].cgst) + N(b.charges[0].sgst) === 60 && N(b.charges[0].netAmount) === 1200, b.charges[0])

        // ── No GST ──
        const c = await order([{ chargeTypeId: transport.id, amount: 1200, taxTreatment: 'NON_TAXABLE' }])
        check('order: no GST: ₹3,18,720, CGST = SGST = ₹7,560 (none on the charge)', N(c.header.totalAmount) === 318720 && N(c.header.cgst) === 7560 && N(c.charges[0].cgst) === 0 && N(c.charges[0].netAmount) === 1200 && c.charges[0].taxTreatment === 'NON_TAXABLE', c.charges[0])

        // ── Across states ──
        const d = await order([{ chargeTypeId: transport.id, amount: 1200 }], { placeOfSupplyCode: away })
        check('order across states: IGST ₹15,177.14 (₹57.14 inside the transport), total ₹3,18,720', N(d.header.igst) === 15177.14 && N(d.header.cgst) === 0 && N(d.charges[0].igst) === 57.14 && N(d.header.totalAmount) === 318720, d.header)

        // ── Several charges, and discounts ──
        const e = await order(
          [
            { chargeTypeId: transport.id, amount: 1200 },
            { chargeTypeId: packing.id, amount: 500, taxTreatment: 'EXCLUSIVE' },
          ],
          { discountAmount: 2400 },
        )
        check('order: ₹2,400 off, transport incl. + packing ₹500 + 5%: ₹3,00,000 + ₹15,000 + ₹1,200 + ₹525 = ₹3,16,725', N(e.header.taxableAmount) === 300000 && N(e.header.totalAmount) === 316725, e.header)
        const f = await order([{ chargeTypeId: transport.id, amount: 1200 }], { lines: [{ itemId: item.id, totalQty: 800, unitPrice: 378, discount: 10 }] })
        check('order: 10% off the line: ₹2,72,160 + ₹13,608 + ₹1,200 = ₹2,86,968', N(f.header.taxableAmount) === 272160 && N(f.header.totalAmount) === 286968, f.header)

        // ── A charge type set to its own rate ──
        await tx.chargeType.update({ where: { id: packing.id }, data: { followsGoodsRate: false, defaultGstRate: 18, taxTreatment: 'INCLUSIVE' } })
        const g = await order([{ chargeTypeId: packing.id, amount: 1180 }])
        check('order: packing set to its own 18%, GST included: ₹1,180 holds ₹180 at 18% (not the shirts\' 5%), total ₹3,18,700', N(g.charges[0].gstRate) === 18 && N(g.charges[0].netAmount) === 1000 && N(g.charges[0].cgst) === 90 && N(g.header.totalAmount) === 302400 + 15120 + 1180, g.charges[0])

        // ── A quotation with charges, read back, and the order made from it ──
        const q = await createQuote(
          tx,
          quoteSchema.parse({
            customerId: customer.id,
            placeOfSupplyCode: home,
            lines: [{ itemId: item.id, qty: 800, unitPrice: 378 }],
            charges: [
              { chargeTypeId: transport.id, amount: 1200 },
              { chargeTypeId: packing.id, amount: 300, taxTreatment: 'NON_TAXABLE' },
            ],
          }),
          (await tx.user.findFirstOrThrow({ select: { id: true } })).id,
        )
        const qBack = await tx.salesQuotation.findUniqueOrThrow({ where: { id: q.id }, include: { charges: { orderBy: { sortOrder: 'asc' } } } })
        check('quotation: saved with its charges, each with its treatment, value and GST', qBack.charges.length === 2 && qBack.charges[0].taxTreatment === 'INCLUSIVE' && N(qBack.charges[0].netAmount) === 1142.86 && qBack.charges[1].taxTreatment === 'NON_TAXABLE' && N(qBack.charges[1].netAmount) === 300, qBack.charges)
        check('quotation: total ₹3,19,020 = ₹3,02,400 + ₹15,120 + ₹1,200 incl. + ₹300 no GST', N(qBack.totalAmount) === 319020 && N(qBack.cgst) === 7588.57, { total: qBack.totalAmount, cgst: qBack.cgst })
        const fromQuote = await order(qBack.charges.map((ch) => ({ chargeTypeId: ch.chargeTypeId, amount: N(ch.amount), taxTreatment: ch.taxTreatment })))
        check('order from the quotation: its charges carried as they were, the same total to the rupee', N(fromQuote.header.totalAmount) === N(qBack.totalAmount) && fromQuote.charges.map((x) => x.taxTreatment).join() === 'INCLUSIVE,NON_TAXABLE', { order: fromQuote.header.totalAmount, quote: qBack.totalAmount })

        // ── The invoice: the order billed whole, into the books and GSTR-1 ──
        // A books start set inside this transaction only, so the invoice is posted as it would be live.
        const userId = (await tx.user.findFirstOrThrow({ select: { id: true } })).id
        const co = await tx.company.findFirstOrThrow({ select: { id: true } })
        await tx.company.update({ where: { id: co.id }, data: { booksStartDate: new Date(Date.now() - 3 * 86_400_000), booksLockedUpTo: null } })
        const io = await order([
          { chargeTypeId: transport.id, amount: 1200 },
          { chargeTypeId: packing.id, amount: 300, taxTreatment: 'NON_TAXABLE' },
        ])
        const it = await tx.item.findUniqueOrThrow({ where: { id: item.id }, select: { name: true, uomId: true } })
        const stamp = Date.now()
        const so = await tx.salesOrder.create({
          data: { ...io.header, soNumber: `ZZCHECK-SO-${stamp}`, orderDate: new Date(), status: 'CONFIRMED', createdById: userId, lines: { create: io.lines }, charges: { create: io.charges } },
          include: { lines: true },
        })
        const dc = await tx.deliveryChallan.create({
          data: { dcNumber: `ZZCHECK-DC-${stamp}`, soId: so.id, status: 'DISPATCHED', lines: { create: [{ description: it.name, qty: 800, uomId: it.uomId, soLineId: so.lines[0].id, itemId: item.id }] } },
        })
        const offer = chargesStillToBill(await loadBillable(tx, dc.id))
        check(
          "invoice form: both charges offered as the order priced them (GST included, no GST)",
          offer.charges.length === 2 && offer.charges.find((x) => x.chargeTypeId === transport.id)?.taxTreatment === 'INCLUSIVE' && offer.charges.find((x) => x.chargeTypeId === packing.id)?.taxTreatment === 'NON_TAXABLE',
          offer.charges,
        )
        // Sent back as the form sends them, with no treatment: the order's decides.
        const inv = await createInvoice(tx, invoiceSchema.parse({ dcId: dc.id, charges: offer.charges.map((x) => ({ chargeTypeId: x.chargeTypeId, amount: x.amount })) }), userId)
        const it1 = inv.charges.find((x) => x.chargeTypeId === transport.id)
        const ip1 = inv.charges.find((x) => x.chargeTypeId === packing.id)
        check('invoice: total ₹3,19,020, CGST = SGST = ₹7,588.57, goods taxable ₹3,02,400 — the same as the order', N(inv.totalAmount) === 319020 && N(inv.totalAmount) === N(so.totalAmount) && N(inv.cgst) === 7588.57 && N(inv.sgst) === 7588.57 && N(inv.taxableAmount) === 302400, { total: inv.totalAmount, cgst: inv.cgst, taxable: inv.taxableAmount })
        check('invoice: transport ₹1,200 kept as typed, value ₹1,142.86, GST included; packing ₹300, no GST', it1?.taxTreatment === 'INCLUSIVE' && N(it1?.amount) === 1200 && N(it1?.netAmount) === 1142.86 && N(it1?.cgst) === 28.57 && ip1?.taxTreatment === 'NON_TAXABLE' && N(ip1?.netAmount) === 300 && N(ip1?.cgst) + N(ip1?.sgst) + N(ip1?.igst) === 0, inv.charges)

        const v = await tx.voucher.findUnique({
          where: { sourceType_sourceId: { sourceType: 'SALES_INVOICE', sourceId: inv.id } },
          include: { lines: { include: { ledger: { select: { name: true, systemKey: true } } } } },
        })
        const debit = Math.round((v?.lines ?? []).reduce((t, l) => t + N(l.debit), 0) * 100) / 100
        const credit = Math.round((v?.lines ?? []).reduce((t, l) => t + N(l.credit), 0) * 100) / 100
        const creditTo = (key: string) => N(v?.lines.find((l) => l.ledger.systemKey === key)?.credit)
        check('books: the invoice is posted, debits = credits = ₹3,19,020', !!v && debit === credit && debit === 319020, { debit, credit })
        check(
          'books: Transport Charges – Sales credited ₹1,142.86 (not ₹1,200), packing ₹300, sales ₹3,02,400, output CGST and SGST ₹7,588.57 each',
          creditTo(`SALES_CHARGE:${transport.id}`) === 1142.86 && creditTo(`SALES_CHARGE:${packing.id}`) === 300 && creditTo('SALES') === 302400 && creditTo('OUTPUT_CGST') === 7588.57 && creditTo('OUTPUT_SGST') === 7588.57,
          v?.lines.map((l) => [l.ledger.name, N(l.debit), N(l.credit)]),
        )

        const today = new Date(Date.now() + 5.5 * 3_600_000).toISOString().slice(0, 10)
        const g1 = await gstr1(tx, today, today)
        const doc = [...g1.b2b, ...g1.b2cl].find((d) => d.id === inv.id)
        const taxable = (doc?.rates ?? []).reduce((t, r) => t + r.taxable, 0)
        const gst = (doc?.rates ?? []).reduce((t, r) => t + r.cgst + r.sgst + r.igst, 0)
        check(
          'GSTR-1: the invoice at 5% on ₹3,03,542.86 (the goods + the transport without its GST; the packing outside), GST ₹15,177.14',
          !!doc && Math.abs(taxable - 303542.86) < 0.01 && Math.abs(gst - 15177.14) < 0.01 && (doc?.rates ?? []).every((r) => r.rate === 5),
          doc ? doc.rates : `not in B2B/B2CL (customer GSTIN ${customer.gstin ?? 'none'})`,
        )

        // ── The live site's present code, between the migration and the deploy ──
        // It saves a charge with only the columns it knows. The migration lets it
        // (the new columns have a default or may be empty), and the new code reads
        // that row as what it was: GST added on top, its value its amount.
        const oldType = await tx.chargeType.findFirstOrThrow({ where: { id: { notIn: [transport.id, packing.id] } }, select: { id: true } })
        const oldRowId = `zzcheck_${stamp}`
        await tx.$executeRaw`INSERT INTO sales_invoice_charges (id, "invoiceId", "chargeTypeId", amount, "gstRate", cgst, sgst, igst) VALUES (${oldRowId}, ${inv.id}, ${oldType.id}, 500, 5, 12.5, 12.5, 0)`
        const oldRow = await tx.salesInvoiceCharge.findUniqueOrThrow({ where: { id: oldRowId }, include: { chargeType: { select: { name: true } } } })
        check(
          'a charge saved the old way after the migration: GST added on top, value = its ₹500',
          oldRow.taxTreatment === 'EXCLUSIVE' && oldRow.netAmount === null && chargeRowOf(oldRow).netAmount === 500,
          { treatment: oldRow.taxTreatment, net: oldRow.netAmount },
        )
        // The invoice as the old code would have totalled it with that charge, posted again.
        await tx.salesInvoice.update({ where: { id: inv.id }, data: { totalAmount: 319545, balanceAmount: 319545, cgst: 7601.07, sgst: 7601.07 } })
        await postDocument(tx, 'SALES_INVOICE', inv.id, userId)
        const v2 = await tx.voucher.findUniqueOrThrow({ where: { sourceType_sourceId: { sourceType: 'SALES_INVOICE', sourceId: inv.id } }, include: { lines: { include: { ledger: { select: { systemKey: true } } } } } })
        const d2 = Math.round(v2.lines.reduce((t, l) => t + N(l.debit), 0) * 100) / 100
        const c2 = Math.round(v2.lines.reduce((t, l) => t + N(l.credit), 0) * 100) / 100
        check(
          'books: posted with it, the old-way charge credited its ₹500 and the entry still balances',
          d2 === c2 && d2 === 319545 && N(v2.lines.find((l) => l.ledger.systemKey === `SALES_CHARGE:${oldType.id}`)?.credit) === 500,
          { debit: d2, credit: c2 },
        )

        // ── A charge type switched to GST added on top decides when the form sends nothing ──
        await tx.chargeType.update({ where: { id: transport.id }, data: { taxTreatment: 'EXCLUSIVE' } })
        const h = await order([{ chargeTypeId: transport.id, amount: 1200 }])
        check('a charge type set to GST added on top: the order adds it (₹3,18,780) when the row sends no treatment', N(h.header.totalAmount) === 318780 && h.charges[0].taxTreatment === 'EXCLUSIVE', h.charges[0])

        throw ROLLBACK
      },
      { timeout: 120_000 },
    )
    .catch((e) => {
      if (e !== ROLLBACK) throw e
    })
  const left = await prisma.salesQuotationCharge.count()
  const transport = await prisma.chargeType.findFirst({ where: { name: 'Transport Charges' }, select: { taxTreatment: true } })
  check('nothing kept: no quotation charge saved, Transport Charges back to GST-inclusive', left === 0 && transport?.taxTreatment === 'INCLUSIVE', { left, transport })
  console.log(`\n${pass} passed, ${fail} failed`)
  await prisma.$disconnect()
  process.exitCode = fail ? 1 : 0
}
main().catch(async (e) => {
  console.error(e)
  await prisma.$disconnect()
  process.exit(1)
})
