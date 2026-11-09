// The sales pricing engine (packages/shared priceSale / priceSaleCharge),
// checked on its own: no database, no server. The quotation form, the order
// form and the server all call this one function, so what is checked here is
// what every one of them shows and saves.
//
// Covers the business's own case (₹3,02,400 of shirts at 5% and ₹1,200 of
// transport, GST included: ₹3,18,720, nothing added on top), GST added on
// top, no GST, goods at two rates, a garment's price band, several charges
// with different treatments, CGST + SGST and IGST, line and order discounts,
// a charge at its own rate, and odd amounts where the paisa must still add
// back to exactly the figure typed.
//
// With OLD=<folder holding the previous orderTotals.ts and chargeShare.ts>,
// it also prices a few hundred random orders both ways and checks that a
// charge with GST added on top — how every charge was priced before — comes
// out to the paisa exactly as it did.
//
//   npx tsx tools/check-sale-pricing.ts
//   OLD="C:\path\to\old" npx tsx tools/check-sale-pricing.ts
import { pathToFileURL } from 'node:url'
import { priceSale, priceSaleCharge, type ChargeTaxTreatment, type SaleChargeInput } from '../packages/shared/src/index'

let pass = 0
let fail = 0
const check = (name: string, ok: boolean, detail?: unknown) => {
  if (ok) pass++
  else fail++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || detail === undefined ? '' : ` — ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`}`)
}
const near = (a: number, b: number, tol = 0.001) => Math.abs(a - b) <= tol
const charge = (amount: number, treatment: ChargeTaxTreatment, extra: Partial<SaleChargeInput> = {}): SaleChargeInput => ({
  key: extra.key ?? treatment,
  amount,
  treatment,
  followsGoodsRate: extra.followsGoodsRate ?? true,
  ownRate: extra.ownRate ?? 5,
})
const shirts = [{ qty: 800, price: 378, rate: 5 }]

async function main() {
  // ── 1. Goods at 5%, no charges ──
  const g = priceSale({ lines: shirts, intra: true })
  check('1. goods at 5%, no charges: ₹3,02,400 + ₹15,120 = ₹3,17,520', g.goodsTaxable === 302400 && g.tax === 15120 && g.cgst === 7560 && g.sgst === 7560 && g.total === 317520, g)

  // ── 2. The business's case: ₹1,200 transport, GST included ──
  const inc = priceSale({ lines: shirts, charges: [charge(1200, 'INCLUSIVE')], intra: true })
  const t = inc.charges[0]
  check('2. ₹1,200 transport with GST included: net total ₹3,18,720', inc.total === 318720, inc.total)
  check('2. nothing is added on top: the transport adds exactly ₹1,200 to the bill', t.payable === 1200 && inc.total - (inc.goodsTaxable + inc.goodsTax) === 1200, t)
  check('2. the GST inside the ₹1,200 is worked out: ₹57.14 (₹28.57 CGST + ₹28.57 SGST), value ₹1,142.86', t.tax === 57.14 && t.cgst === 28.57 && t.sgst === 28.57 && t.net === 1142.86, t)
  check('2. the document reports it: taxable ₹3,03,542.86, CGST = SGST = ₹7,588.57, GST ₹15,177.14', inc.taxable === 303542.86 && inc.cgst === 7588.57 && inc.sgst === 7588.57 && inc.tax === 15177.14, inc)
  check('2. taxable + GST = the total, to the paisa (no round-off needed)', near(inc.taxable + inc.tax, 318720) && inc.roundOff === 0, inc)

  // ── 3. GST added on top: the old behaviour, still there when chosen ──
  const exc = priceSale({ lines: shirts, charges: [charge(1200, 'EXCLUSIVE')], intra: true })
  check('3. ₹1,200 transport with GST added on top: ₹60 more, total ₹3,18,780 (as before)', exc.total === 318780 && exc.charges[0].tax === 60 && exc.charges[0].payable === 1260 && exc.cgst === 7590 && exc.sgst === 7590 && exc.taxable === 303600, exc)

  // ── 4. No GST ──
  const non = priceSale({ lines: shirts, charges: [charge(1200, 'NON_TAXABLE')], intra: true })
  check('4. ₹1,200 with no GST: added as it is, outside the taxable value, no GST on it', non.total === 318720 && non.tax === 15120 && non.taxable === 302400 && non.chargeUntaxed === 1200 && non.charges[0].tax === 0, non)
  check('4. not the same as GST included: same total, but no GST in it to report (₹15,120 vs ₹15,177.14)', non.total === inc.total && non.tax !== inc.tax)

  // ── 5. Goods at two rates; a garment's price band ──
  const band = { gstRate: 5, priceLimit: 1000, rateAbove: 12 }
  const two = priceSale({
    lines: [
      { qty: 100, price: 900, band },
      { qty: 50, price: 1500, band },
    ],
    charges: [charge(1200, 'INCLUSIVE')],
    intra: true,
  })
  check('5. the band: ₹900 a piece at 5%, ₹1,500 a piece at 12%', two.lines[0].gstRate === 5 && two.lines[1].gstRate === 12, two.lines)
  const parts = two.charges[0].parts
  check('5. the transport is shared by the goods\' value (₹90,000 at 5%, ₹75,000 at 12%), each share keeping its own GST inside', parts.length === 2 && parts.some((p) => p.gstRate === 5) && parts.some((p) => p.gstRate === 12) && near(parts.reduce((s, p) => s + p.amount, 0), 1200), parts)
  check('5. every share\'s value + GST = its share, and the charge still adds exactly ₹1,200', parts.every((p) => near(p.net + p.tax, p.amount)) && two.charges[0].payable === 1200, parts)
  check('5. GST by rate: 5% and 12% rows, each with its goods and its share of the transport', two.byRate.length === 2 && near(two.byRate.reduce((s, r) => s + r.tax, 0), two.tax, 0.02), two.byRate)

  // ── 6. Several charges, each its own way ──
  const many = priceSale({
    lines: shirts,
    charges: [charge(1200, 'INCLUSIVE', { key: 'transport' }), charge(500, 'EXCLUSIVE', { key: 'packing' }), charge(300, 'NON_TAXABLE', { key: 'courier' })],
    intra: true,
  })
  const want6 = 302400 + 15120 + 1200 + (500 + 25) + 300
  check(`6. transport ₹1,200 incl. + packing ₹500 + 5% + courier ₹300 no GST: ₹${want6.toLocaleString('en-IN')}`, many.total === want6, many.total)
  check('6. GST on them: ₹57.14 inside transport, ₹25 on packing, none on courier', many.charges.map((c) => c.tax).join() === '57.14,25,0', many.charges.map((c) => c.tax))
  check('6. taxable value: goods + transport\'s value + packing (courier left out)', many.taxable === 302400 + 1142.86 + 500 && many.chargeUntaxed === 300, many)

  // ── 7 / 8. CGST + SGST within the state; IGST across ──
  check('7. within the state: CGST = SGST, no IGST', inc.cgst === inc.sgst && inc.igst === 0)
  const igst = priceSale({ lines: shirts, charges: [charge(1200, 'INCLUSIVE')], intra: false })
  check('8. across states: IGST ₹15,177.14 (₹57.14 of it inside the transport), no CGST or SGST, total still ₹3,18,720', igst.igst === 15177.14 && igst.cgst === 0 && igst.sgst === 0 && igst.charges[0].igst === 57.14 && igst.total === 318720, igst)
  const exIgst = priceSale({ lines: shirts, charges: [charge(1200, 'EXCLUSIVE')], intra: false })
  check('8. across states with GST added on top: IGST ₹15,180, total ₹3,18,780', exIgst.igst === 15180 && exIgst.total === 318780, exIgst)

  // ── 9. A line's own discount ──
  const disc = priceSale({ lines: [{ qty: 800, price: 378, rate: 5, discountPct: 10 }], charges: [charge(1200, 'INCLUSIVE')], intra: true })
  check('9. 10% off the line: taxable ₹2,72,160, GST ₹13,608 + ₹57.14, total ₹2,86,968', disc.goodsTaxable === 272160 && disc.lineDiscount === 30240 && disc.total === 272160 + 13608 + 1200, disc)

  // ── 10. A discount on the whole order ──
  const off = priceSale({ lines: shirts, orderDiscount: 2400, charges: [charge(1200, 'INCLUSIVE')], intra: true })
  check('10. ₹2,400 off the order: taxable ₹3,00,000, GST ₹15,000 + ₹57.14, total ₹3,16,200', off.goodsTaxable === 300000 && off.discount === 2400 && off.total === 316200, off)

  // ── A charge at its own rate, a supply of its own ──
  const own = priceSaleCharge(charge(1180, 'INCLUSIVE', { followsGoodsRate: false, ownRate: 18 }), [{ taxable: 302400, gstRate: 5 }], true)
  check('own rate: ₹1,180 of dyeing at its own 18%, GST included: value ₹1,000, GST ₹180, not the goods\' 5%', own.gstRate === 18 && own.net === 1000 && own.tax === 180 && own.payable === 1180, own)
  const ownEx = priceSaleCharge(charge(1000, 'EXCLUSIVE', { followsGoodsRate: false, ownRate: 18 }), [{ taxable: 302400, gstRate: 5 }], true)
  check('own rate, GST added on top: ₹1,000 + ₹180', ownEx.tax === 180 && ownEx.payable === 1180, ownEx)
  const noGoods = priceSaleCharge(charge(1050, 'INCLUSIVE', { ownRate: 5 }), [], true)
  check('no goods to follow: the charge\'s own rate', noGoods.gstRate === 5 && noGoods.net === 1000 && noGoods.tax === 50, noGoods)

  // ── Odd amounts: the paisa always add back ──
  let oddOk = true
  for (const amount of [999.99, 1, 0.01, 1234.57, 47.62, 100000.03, 7.77]) {
    for (const rate of [5, 12, 18, 28, 3, 0.25]) {
      for (const intra of [true, false, undefined]) {
        const c = priceSaleCharge(charge(amount, 'INCLUSIVE', { followsGoodsRate: false, ownRate: rate }), [], intra)
        const halvesEqual = intra ? c.cgst === c.sgst : true
        if (!(near(c.net + c.tax, amount, 0.0001) && c.payable === amount && halvesEqual && c.tax >= 0 && c.net >= 0)) {
          oddOk = false
          console.log('   odd case', { amount, rate, intra, c })
        }
      }
    }
  }
  check('odd amounts and rates: value + GST = the figure typed, to the paisa, CGST always = SGST', oddOk)

  // ── No customer yet: the tax shown whole ──
  const open = priceSale({ lines: shirts, charges: [charge(1200, 'INCLUSIVE')], intra: undefined })
  check('no customer yet: GST shown whole (₹15,177.14), not split, total ₹3,18,720', open.tax === 15177.14 && open.cgst === 0 && open.igst === 0 && open.total === 318720, open)

  // ── The old formula, for GST added on top ──
  const oldDir = process.env.OLD
  if (oldDir) {
    const old = (await import(pathToFileURL(`${oldDir}/orderTotals.ts`).href)) as typeof import('../apps/web/src/components/sales/orderTotals')
    let same = 0
    const diffs: unknown[] = []
    let seed = 7
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647)
    for (let n = 0; n < 400; n++) {
      const lines = Array.from({ length: 1 + Math.floor(rnd() * 4) }, () => ({
        qty: 1 + Math.floor(rnd() * 900),
        rate: Math.round(rnd() * 300000) / 100,
        disc: rnd() < 0.3 ? Math.round(rnd() * 2500) / 100 : 0,
        gst: [0, 5, 12, 18][Math.floor(rnd() * 4)],
      }))
      const charges = Array.from({ length: Math.floor(rnd() * 3) }, () => ({ amount: Math.round(rnd() * 500000) / 100, fallbackRate: [5, 12, 18][Math.floor(rnd() * 3)] }))
      const intra = [true, false, undefined][Math.floor(rnd() * 3)]
      const billDiscount = rnd() < 0.3 ? Math.round(rnd() * 100000) / 100 : 0
      const otherCharges = rnd() < 0.2 ? Math.round(rnd() * 20000) / 100 : 0
      const was = old.orderTotals({
        lines: lines.map((l) => ({ qty: l.qty, rate: l.rate, disc: l.disc, taxExempt: false, jobGst: '', jobHsn: '', itemRate: l.gst })),
        isJobWork: false,
        hsnIndex: new Map(),
        billDiscount,
        charges,
        intra,
        otherCharges,
        brokerPct: 2,
      })
      const now = priceSale({
        lines: lines.map((l) => ({ qty: l.qty, price: l.rate, discountPct: l.disc, rate: l.gst })),
        orderDiscount: billDiscount,
        charges: charges.map((c, i) => ({ key: String(i), amount: c.amount, treatment: 'EXCLUSIVE' as const, followsGoodsRate: true, ownRate: c.fallbackRate })),
        otherCharges,
        intra,
        brokeragePct: 2,
      })
      const pairs: Array<[string, number, number]> = [
        ['total', was.total, now.total],
        ['roundOff', was.roundOff, now.roundOff],
        ['cgst', was.cgst, now.cgst],
        ['sgst', was.sgst, now.sgst],
        ['igst', was.igst, now.igst],
        ['tax', was.taxTotal, now.tax],
        ['taxable', was.taxable, now.goodsTaxable],
        ['charges', was.chargeTotal, now.chargeNet],
        ['brokerage', was.brokerage, now.brokerage],
      ]
      const off = pairs.filter(([, a, b]) => !near(a, b, 0.0001))
      if (off.length) diffs.push({ n, off })
      else same++
    }
    check(`GST added on top: 400 random orders price exactly as the old formula did (${same}/400)`, same === 400, diffs.slice(0, 3))
  } else console.log('(OLD not set: the comparison with the old formula was skipped)')

  console.log(`\n${pass} passed, ${fail} failed`)
  process.exitCode = fail ? 1 : 0
}
main()
