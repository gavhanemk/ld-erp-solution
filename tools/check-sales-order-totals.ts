// The sales order form's totals against the server's, on the real masters.
//
// The form shows its figures from orderTotals (apps/web/.../orderTotals.ts);
// the server saves what prepareOrder works out. They are meant to be the same
// figures, worked the same way. This prices a handful of orders both ways and
// compares every total — inside the state and across it, line and order
// discounts, charges at their own rates and with a rate typed over, other
// charges, job work with the SAC looked up in the HSN master, a line taxed at
// a typed rate, and an exempt one. Then it checks the rules the server adds:
// sizes for a garment made in sizes, and no shipment date before the order.
//
// Read-only: nothing is saved, no number is taken. Run it from apps/api:
//
//   cd apps/api
//   npx tsx ../../tools/check-sales-order-totals.ts
import { prisma } from '../packages/database/src/index'
import { createSalesOrderSchema, prepareOrder } from '../apps/api/src/routes/sales.routes'
import { withHsnRates } from '../apps/api/src/lib/hsn'
import { orderTotals } from '../apps/web/src/components/sales/orderTotals'

let pass = 0
let fail = 0
const check = (label: string, ok: boolean, extra = '') => {
  ok ? pass++ : fail++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${extra ? ' — ' + extra : ''}`)
}

async function main() {
  const company = await prisma.company.findFirst({ select: { stateCode: true, gstin: true } })
  const home = company?.stateCode || company?.gstin?.slice(0, 2) || '27'
  const away = home === '29' ? '27' : '29'
  const customer = await prisma.customer.findFirst({ where: { isActive: true }, select: { id: true } })
  const brand = await prisma.brand.findFirst({ where: { isActive: true }, select: { id: true } })
  const raw = await prisma.item.findMany({
    where: { type: 'FINISHED_GOOD', isActive: true },
    select: {
      id: true,
      code: true,
      hsnCode: true,
      taxRate: { select: { rate: true } },
      style: { select: { sizeGroup: { select: { sizes: { select: { id: true }, orderBy: { sequence: 'asc' } } } } } },
    },
    take: 50,
  })
  const items = (await withHsnRates(prisma, raw)) as Array<
    (typeof raw)[number] & { hsn: { gstRate: string | number; priceLimit: string | number | null; rateAbove: string | number | null } | null }
  >
  const priced = items.filter((i) => i.hsn || i.taxRate)
  const charges = await prisma.chargeType.findMany({ where: { isActive: true, applyOnSale: true }, select: { id: true, defaultGstRate: true }, take: 2 })
  const hsnRows = await prisma.hsnCode.findMany({ where: { isActive: true }, select: { code: true, gstRate: true } })
  const hsnIndex = new Map(hsnRows.map((h) => [h.code.replace(/\s+/g, ''), h]))
  if (!customer || !brand || priced.length < 2) throw new Error('needs a customer, a brand and two finished goods with GST')
  const [A, B] = priced

  type Line = { item: (typeof priced)[number]; qty: number; rate: number; disc: number; exempt?: boolean; jobHsn?: string; jobGst?: string }
  const sizesFor = (item: (typeof priced)[number], qty: number) => {
    const sizes = item.style?.sizeGroup?.sizes ?? []
    if (!sizes.length) return undefined
    // Split across the run: what is left goes on the first size.
    const each = Math.floor(qty / sizes.length)
    return sizes.map((z, i) => ({ sizeId: z.id, qty: i === 0 ? qty - each * (sizes.length - 1) : each })).filter((z) => z.qty > 0)
  }

  async function compare(
    label: string,
    o: { lines: Line[]; isJobWork?: boolean; pos: string; discount?: number; charges?: Array<{ id: string; amount: number; gstRate?: number }>; other?: number },
  ) {
    const server = await prisma.$transaction((tx) =>
      prepareOrder(
        tx,
        createSalesOrderSchema.parse({
          customerId: customer!.id,
          brandId: brand!.id,
          isJobWork: !!o.isJobWork,
          placeOfSupplyCode: o.pos,
          discountAmount: o.discount ?? 0,
          otherCharges: o.other ?? 0,
          charges: (o.charges ?? []).map((c) => ({ chargeTypeId: c.id, amount: c.amount, gstRate: c.gstRate ?? null })),
          lines: o.lines.map((l) => ({
            itemId: l.item.id,
            totalQty: l.qty,
            unitPrice: l.rate,
            discount: l.disc,
            taxExempt: !!l.exempt,
            jobHsnCode: l.jobHsn ?? null,
            jobGstRate: l.jobGst ? Number(l.jobGst) : null,
            sizes: sizesFor(l.item, l.qty),
          })),
        }),
      ),
    )
    const h = server.header
    const typeRate = (id: string) => Number(charges.find((c) => c.id === id)!.defaultGstRate)
    const form = orderTotals({
      lines: o.lines.map((l) => ({
        qty: l.qty,
        rate: l.rate,
        disc: l.disc,
        taxExempt: !!l.exempt,
        jobGst: l.jobGst ?? '',
        jobHsn: l.jobHsn ?? '',
        hsn: l.item.hsn,
        itemRate: l.item.taxRate ? Number(l.item.taxRate.rate) : null,
      })),
      isJobWork: !!o.isJobWork,
      hsnIndex,
      billDiscount: o.discount ?? 0,
      charges: (o.charges ?? []).map((c) => ({ amount: c.amount, gstRate: c.gstRate ?? typeRate(c.id) })),
      intra: o.pos === home,
      otherCharges: o.other ?? 0,
      brokerPct: 0,
    })
    const pairs: Array<[string, number, number]> = [
      ['value', Number(h.subtotal), form.subtotal],
      ['order discount', Number(h.discountAmount), form.discount],
      ['taxable', Number(h.taxableAmount), form.taxable],
      ['CGST', Number(h.cgst), form.cgst],
      ['SGST', Number(h.sgst), form.sgst],
      ['IGST', Number(h.igst), form.igst],
      ['rounding', Number(h.roundOff), form.roundOff],
      ['total', Number(h.totalAmount), form.total],
    ]
    const off = pairs.filter(([, a, b]) => Math.abs(a - b) > 0.001)
    check(`${label}: form and server agree (total ₹${form.total})`, !off.length, off.map(([n, a, b]) => `${n} server ${a} form ${b}`).join('; '))
    // Each line's GST rate the same both ways.
    const rateOff = server.lines.map((l, i) => [Number(l.gstRate), form.lines[i].gst] as const).filter(([a, b]) => a !== b)
    check(`${label}: every line's GST rate agrees`, !rateOff.length, JSON.stringify(rateOff))
    // The summary by rate adds up to the tax.
    const byRate = form.gstByRate.reduce((s, r) => s + r.tax, 0)
    check(`${label}: GST by rate adds up to the tax (to the paisa)`, Math.abs(byRate - form.taxTotal) <= 0.02, `${byRate.toFixed(2)} vs ${form.taxTotal}`)
  }

  const C = charges.map((c) => c.id)
  await compare('own order, inside the state', {
    pos: home,
    lines: [
      { item: A, qty: 37, rate: 333.33, disc: 7.5 },
      { item: B, qty: 120, rate: 1249.99, disc: 0 },
    ],
    discount: 1234.56,
    charges: C.length ? [{ id: C[0], amount: 777.77 }, ...(C[1] ? [{ id: C[1], amount: 450, gstRate: 12 }] : [])] : [],
    other: 99.5,
  })
  await compare('own order, across states', {
    pos: away,
    lines: [
      { item: A, qty: 37, rate: 333.33, disc: 7.5 },
      { item: B, qty: 120, rate: 1249.99, disc: 0 },
    ],
    discount: 1234.56,
    charges: C.length ? [{ id: C[0], amount: 777.77 }] : [],
  })
  // Just above the price per piece where a garment's code changes rate, when it has one.
  const above = priced.find((i) => i.hsn?.priceLimit != null && i.hsn?.rateAbove != null)
  if (above) {
    await compare(`above the garment price threshold (₹${Number(above.hsn!.priceLimit)}/pc)`, {
      pos: home,
      lines: [{ item: above, qty: 10, rate: Number(above.hsn!.priceLimit) + 100, disc: 0 }],
    })
  }
  await compare('job work: SAC looked up, a typed rate, an exempt line', {
    pos: home,
    isJobWork: true,
    lines: [
      { item: A, qty: 300, rate: 12.75, disc: 0 },
      { item: B, qty: 200, rate: 18.4, disc: 2, jobHsn: '998821', jobGst: '18' },
      ...(priced[2] ? [{ item: priced[2], qty: 50, rate: 10, disc: 0, exempt: true }] : []),
    ],
    charges: C.length ? [{ id: C[0], amount: 300 }] : [],
  })

  // The server's own rules.
  const sized = priced.find((i) => i.style?.sizeGroup?.sizes.length)
  if (sized) {
    const refused = await prisma
      .$transaction((tx) =>
        prepareOrder(
          tx,
          createSalesOrderSchema.parse({ customerId: customer.id, brandId: brand.id, lines: [{ itemId: sized.id, totalQty: 10, unitPrice: 100 }] }),
        ),
      )
      .then(() => null)
      .catch((e: { code?: string }) => e.code)
    check('a garment made in sizes is refused without its sizes', refused === 'NEEDS_SIZES', String(refused))
    const quote = await prisma
      .$transaction((tx) =>
        prepareOrder(tx, createSalesOrderSchema.parse({ customerId: customer.id, brandId: brand.id, lines: [{ itemId: sized.id, totalQty: 10, unitPrice: 100 }] }), {
          piecesOnly: true,
        }),
      )
      .then(() => 'ok')
      .catch((e: { code?: string }) => e.code)
    check('a quotation is still priced by the piece', quote === 'ok', String(quote))
  }
  const early = await prisma
    .$transaction((tx) =>
      prepareOrder(
        tx,
        createSalesOrderSchema.parse({
          customerId: customer.id,
          brandId: brand.id,
          orderDate: '2026-10-12',
          deliveryDate: '2026-10-11',
          lines: [{ itemId: A.id, totalQty: 10, unitPrice: 100, sizes: sizesFor(A, 10) }],
        }),
      ),
    )
    .then(() => null)
    .catch((e: { code?: string }) => e.code)
  check('no shipment date before the order date', early === 'BAD_DATE', String(early))

  // The brand, which the form no longer asks for: from the garments' styles.
  const brands = await prisma.brand.findMany({ where: { isActive: true }, select: { id: true, name: true, type: true } })
  const own = brands.find((b) => b.type === 'LD_COTTON_MILLS')
  const vhagar = brands.find((b) => b.type === 'VHAGAR')
  const brandFor = (o: { isJobWork?: boolean; brandId?: string; lines: Array<{ itemId: string; styleCode?: string }> }) =>
    prisma
      .$transaction((tx) =>
        prepareOrder(
          tx,
          createSalesOrderSchema.parse({
            customerId: customer.id,
            brandId: o.brandId,
            isJobWork: !!o.isJobWork,
            lines: o.lines.map((l) => ({ itemId: l.itemId, styleCode: l.styleCode ?? null, totalQty: 10, unitPrice: 100 })),
          }),
          { piecesOnly: true },
        ),
      )
      .then((r) => r.header.brandId)
  // Styles typed on the lines, so the check does not hang on which items have styles.
  const [vStyles, lStyles] = await Promise.all([
    prisma.style.findMany({ where: { brandType: 'VHAGAR' }, select: { code: true }, take: 1 }),
    prisma.style.findMany({ where: { brandType: 'LD_COTTON_MILLS' }, select: { code: true }, take: 1 }),
  ])
  const l = lStyles[0]?.code
  if (l) check(`no brand sent, our style (${l}): ${own?.name}`, (await brandFor({ lines: [{ itemId: A.id, styleCode: l }] })) === own?.id)
  if (vhagar && vStyles.length && l) {
    const v = vStyles[0].code
    check(`every garment a VHAGAR style (${v}): ${vhagar.name}`, (await brandFor({ lines: [{ itemId: A.id, styleCode: v }, { itemId: B.id, styleCode: v }] })) === vhagar.id)
    check("a VHAGAR style beside one of ours: the mill's own", (await brandFor({ lines: [{ itemId: A.id, styleCode: v }, { itemId: B.id, styleCode: l }] })) === own?.id)
    check('job work in a VHAGAR style: the mill\'s own', (await brandFor({ isJobWork: true, lines: [{ itemId: A.id, styleCode: v }] })) === own?.id)
  } else console.log('SKIP no VHAGAR brand or style to try')
  if (vhagar) check('a brand sent is kept', (await brandFor({ brandId: vhagar.id, lines: [{ itemId: A.id }] })) === vhagar.id)

  console.log(`\n${pass} passed, ${fail} failed`)
}

main()
  .catch((e) => {
    console.error(e)
    process.exitCode = 1
  })
  .finally(() => prisma.$disconnect())
