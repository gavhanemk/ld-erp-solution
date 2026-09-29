import { PrismaClient } from '@prisma/client'
import { seedCore } from './seed-core'
import { loadEnv } from './load-env'

// Before anything reaches Prisma. A script run through tsx does not read .env
// by itself, and which folder the command was typed in should not decide
// whether it can find the database.
loadEnv(__dirname)

/**
 * A database full of believable make-believe, for showing the ERP to people.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THIS WIPES THE DATABASE FIRST. Never point it at one anyone is working in.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Everything below is invented. None of it came from Absolute ERP and none of
 * it is a real firm's details:
 *
 *   · every GSTIN carries the PAN block DEMOC, which is not an issued series,
 *     so no demo record can collide with a real business
 *   · every email is on example.com, a domain reserved by RFC 2606 and
 *     therefore incapable of reaching anybody
 *   · every party name is fictional
 *
 * The one exception is the company itself — LD Cotton Mills' own registered
 * address and GSTIN are real, because they print on documents and the whole
 * point of a demonstration is that the letterhead looks right.
 *
 * The figures are chosen to look like a Bhiwandi shirting unit rather than to
 * be tidy: fabric rates in the ₹90–420 band, lead times of a week to a
 * fortnight, brokerage between 1.25% and 2.5%.
 */

const prisma = new PrismaClient()

/**
 * Wipe order matters: a row cannot go while something still points at it.
 * These run children-first, so each delete finds nothing holding on to it.
 *
 * Deliberately kept: the company, users, roles, permissions, tax rates,
 * number series, document templates, app settings (the Gemini key lives
 * there) and the audit log. Deleting an audit trail to tidy up is a habit
 * worth not starting, and it records that these demo documents existed.
 */
async function wipe() {
  console.log('🧹 Clearing existing data...')

  const order: Array<[string, () => Promise<{ count: number }>]> = [
    // Production
    ['cartons', () => prisma.carton.deleteMany()],
    ['packing orders', () => prisma.packingOrder.deleteMany()],
    ['production QC', () => prisma.productionQC.deleteMany()],
    ['production entries', () => prisma.productionEntry.deleteMany()],
    ['cutting orders', () => prisma.cuttingOrder.deleteMany()],
    ['MO line sizes', () => prisma.mOLineSize.deleteMany()],
    ['MO lines', () => prisma.mOLine.deleteMany()],
    ['manufacturing orders', () => prisma.manufacturingOrder.deleteMany()],
    ['requisition lines', () => prisma.materialRequisitionLine.deleteMany()],
    ['requisitions', () => prisma.materialRequisition.deleteMany()],

    // Sales
    ['invoice charges', () => prisma.salesInvoiceCharge.deleteMany()],
    ['invoice lines', () => prisma.salesInvoiceLine.deleteMany()],
    ['credit note lines', () => prisma.creditNoteLine.deleteMany()],
    ['credit notes', () => prisma.creditNote.deleteMany()],
    ['receipts', () => prisma.paymentReceipt.deleteMany()],
    ['sales invoices', () => prisma.salesInvoice.deleteMany()],
    ['challan lines', () => prisma.deliveryChallanLine.deleteMany()],
    ['challans', () => prisma.deliveryChallan.deleteMany()],
    ['SO line sizes', () => prisma.salesOrderLineSize.deleteMany()],
    ['SO lines', () => prisma.salesOrderLine.deleteMany()],
    ['sales orders', () => prisma.salesOrder.deleteMany()],

    // Purchase
    ['bill charges', () => prisma.purchaseInvoiceCharge.deleteMany()],
    ['bill lines', () => prisma.purchaseInvoiceLine.deleteMany()],
    ['debit note lines', () => prisma.debitNoteLine.deleteMany()],
    ['debit notes', () => prisma.debitNote.deleteMany()],
    ['supplier payments', () => prisma.supplierPayment.deleteMany()],
    ['purchase bills', () => prisma.purchaseInvoice.deleteMany()],
    ['inward QC', () => prisma.inwardQC.deleteMany()],
    ['GRN lines', () => prisma.gRNLine.deleteMany()],
    ['GRNs', () => prisma.gRN.deleteMany()],
    ['PO lines', () => prisma.purchaseOrderLine.deleteMany()],
    ['purchase orders', () => prisma.purchaseOrder.deleteMany()],

    // Stock and books
    ['stock ledger', () => prisma.stockLedger.deleteMany()],
    ['voucher lines', () => prisma.voucherLine.deleteMany()],
    ['vouchers', () => prisma.voucher.deleteMany()],
    ['bank accounts', () => prisma.bankAccount.deleteMany()],
    ['ledger accounts', () => prisma.account.deleteMany()],

    // People
    ['attendance', () => prisma.attendance.deleteMany()],
    ['payroll', () => prisma.payrollRecord.deleteMany()],
    ['employees', () => prisma.employee.deleteMany()],
    ['salary structures', () => prisma.salaryStructure.deleteMany()],

    // Machines
    ['breakdowns', () => prisma.machineBreakdown.deleteMany()],
    ['maintenance', () => prisma.maintenanceSchedule.deleteMany()],
    ['machines', () => prisma.machine.deleteMany()],

    ['notifications', () => prisma.notification.deleteMany()],

    // Masters
    ['routing steps', () => prisma.routingStep.deleteMany()],
    ['routings', () => prisma.routing.deleteMany()],
    ['BOM lines', () => prisma.bOMLine.deleteMany()],
    ['BOMs', () => prisma.bOM.deleteMany()],
    ['workstations', () => prisma.workstation.deleteMany()],
    ['styles', () => prisma.style.deleteMany()],
    ['items', () => prisma.item.deleteMany()],
    ['customers', () => prisma.customer.deleteMany()],
    ['suppliers', () => prisma.supplier.deleteMany()],
    ['brokers', () => prisma.broker.deleteMany()],
    ['warehouses', () => prisma.warehouse.deleteMany()],
    ['sizes', () => prisma.size.deleteMany()],
    ['size groups', () => prisma.sizeGroup.deleteMany()],
    ['charge types', () => prisma.chargeType.deleteMany()],
    ['item categories', () => prisma.itemCategory.deleteMany()],
    ['units', () => prisma.uOM.deleteMany()],
    ['operations', () => prisma.operation.deleteMany()],
    ['departments', () => prisma.department.deleteMany()],
    ['brands', () => prisma.brand.deleteMany()],
  ]

  let total = 0
  for (const [label, run] of order) {
    const { count } = await run()
    total += count
    if (count > 0) console.log(`   − ${String(count).padStart(4)} ${label}`)
  }

  // Every document that used a number is gone, so the counters go back to zero
  // and PO-2526-0001 is free again. Leaving them at 4 would make the demo start
  // at PO-2526-0005 with nothing before it, which reads like a gap.
  await prisma.numberSeries.updateMany({ data: { lastNumber: 0 } })

  console.log(`   ${total} rows cleared, number series reset.`)
}

async function main() {
  await wipe()

  // Rebuild the foundation the same way a real install gets it — the demo data
  // then hangs off exactly the records a customer would have, not special ones.
  const { company, departments } = await seedCore(prisma)

  console.log('')
  console.log('🎭 Adding demo master data...')

  const dept = (code: string) => departments.get(code)!

  const uoms = new Map(
    (await prisma.uOM.findMany()).map((u) => [u.symbol, u.id] as const),
  )
  const cats = new Map(
    (await prisma.itemCategory.findMany()).map((c) => [c.name, c.id] as const),
  )
  const taxes = new Map(
    (await prisma.taxRate.findMany()).map((t) => [Number(t.rate), t.id] as const),
  )
  const sizeGroups = new Map(
    (await prisma.sizeGroup.findMany()).map((g) => [g.name, g.id] as const),
  )

  // ───────────────────────────────────────────────────────────────────────
  // Warehouses
  //
  // Fabric, trims and finished shirts do not sit in the same place and are not
  // counted by the same person, so one "Main Warehouse" would make every stock
  // figure meaningless the day stock goes live.
  // ───────────────────────────────────────────────────────────────────────
  const warehouseData = [
    { code: 'WH-FAB', name: 'Fabric Godown', address: 'Ground floor, Kalher unit' },
    { code: 'WH-TRIM', name: 'Trims & Accessories Store', address: '1st floor, Kalher unit' },
    { code: 'WH-FG', name: 'Finished Goods Store', address: 'Packing hall, Kalher unit' },
    {
      code: 'WH-JW',
      name: 'Job Work Godown',
      address: 'Goods lying with outside stitching and washing units',
    },
  ]

  for (const w of warehouseData) {
    await prisma.warehouse.upsert({
      where: { code: w.code },
      update: { name: w.name },
      create: { ...w, companyId: company.id },
    })
  }

  // ───────────────────────────────────────────────────────────────────────
  // Brokers
  //
  // Commission is deducted at source under section 194H, so the TDS section
  // and rate belong on the agent rather than being remembered each month.
  // ───────────────────────────────────────────────────────────────────────
  const brokerData = [
    { code: 'BRK-001', name: 'Hemant Shah & Co', city: 'Mumbai', stateCode: '27', pct: 1.5 },
    { code: 'BRK-002', name: 'Jayesh Textile Agency', city: 'Surat', stateCode: '24', pct: 2.0 },
    { code: 'BRK-003', name: 'R K Marketing', city: 'Bhiwandi', stateCode: '27', pct: 1.25 },
    { code: 'BRK-004', name: 'Southern Sales Associates', city: 'Chennai', stateCode: '33', pct: 2.5 },
    { code: 'BRK-005', name: 'North India Agencies', city: 'Delhi', stateCode: '07', pct: 1.75 },
  ]

  const brokers = new Map<string, string>()
  for (const [i, b] of brokerData.entries()) {
    const row = await prisma.broker.upsert({
      where: { code: b.code },
      update: {},
      create: {
        code: b.code,
        name: b.name,
        phone: `98200 1${String(1000 + i)}`,
        email: `${b.code.toLowerCase()}@example.com`,
        gstin: `${b.stateCode}DEMOC${4000 + i}A1Z5`,
        pan: `DEMOC${4000 + i}A`,
        city: b.city,
        stateCode: b.stateCode,
        brokeragePercent: b.pct,
        tdsSection: '194H',
        tdsRate: 5,
      },
    })
    brokers.set(b.code, row.id)
  }

  // ───────────────────────────────────────────────────────────────────────
  // Suppliers
  //
  // The mix is the point: cloth, thread, buttons, labels, packing, transport
  // and the outside units that do the stitching, embroidery and washing. A
  // shirt unit's payables are spread across all seven, not just fabric.
  // ───────────────────────────────────────────────────────────────────────
  const supplierData = [
    { code: 'SUP-FAB-001', name: 'Sanskar Textiles Trading', category: 'FABRIC', city: 'Ahmedabad', state: 'Gujarat', stateCode: '24', pin: '380025', lead: 12, credit: 45, rating: 5, preferred: true },
    { code: 'SUP-FAB-002', name: 'Bhiwandi Powerloom Fabrics', category: 'FABRIC', city: 'Bhiwandi', state: 'Maharashtra', stateCode: '27', pin: '421302', lead: 5, credit: 30, rating: 4, msme: true },
    { code: 'SUP-FAB-003', name: 'LD Silk Mills', category: 'FABRIC', city: 'Bhiwandi', state: 'Maharashtra', stateCode: '27', pin: '421302', lead: 7, credit: 30, rating: 5, preferred: true, group: true, notes: 'Same owners, separate GSTIN. Buys and sells at arm’s length — exclude from group turnover.' },
    { code: 'SUP-FAB-004', name: 'Kongu Cotton Weavers', category: 'FABRIC', city: 'Coimbatore', state: 'Tamil Nadu', stateCode: '33', pin: '641029', lead: 15, credit: 45, rating: 4 },
    { code: 'SUP-THR-001', name: 'Anantha Thread Agency', category: 'THREAD', city: 'Mumbai', state: 'Maharashtra', stateCode: '27', pin: '400002', lead: 3, credit: 30, rating: 5, preferred: true },
    { code: 'SUP-THR-002', name: 'Satluj Thread Distributors', category: 'THREAD', city: 'Ludhiana', state: 'Punjab', stateCode: '03', pin: '141003', lead: 8, credit: 30, rating: 3 },
    { code: 'SUP-BTN-001', name: 'Shree Button House', category: 'BUTTON', city: 'Mumbai', state: 'Maharashtra', stateCode: '27', pin: '400003', lead: 4, credit: 21, rating: 4, msme: true },
    { code: 'SUP-BTN-002', name: 'Capital Fasteners & Snaps', category: 'BUTTON', city: 'Delhi', state: 'Delhi', stateCode: '07', pin: '110006', lead: 9, credit: 30, rating: 3 },
    { code: 'SUP-LBL-001', name: 'Precision Woven Labels', category: 'LABEL', city: 'Tirupur', state: 'Tamil Nadu', stateCode: '33', pin: '641604', lead: 14, credit: 30, rating: 5, preferred: true },
    { code: 'SUP-LBL-002', name: 'Artcard Tags & Printing', category: 'LABEL', city: 'Mumbai', state: 'Maharashtra', stateCode: '27', pin: '400013', lead: 6, credit: 21, rating: 4, msme: true },
    { code: 'SUP-PKG-001', name: 'Sai Packaging Industries', category: 'PACKAGING', city: 'Bhiwandi', state: 'Maharashtra', stateCode: '27', pin: '421302', lead: 3, credit: 15, rating: 4, msme: true },
    { code: 'SUP-TRM-001', name: 'Nova Trims & Interlining', category: 'TRIM', city: 'Surat', state: 'Gujarat', stateCode: '24', pin: '395002', lead: 10, credit: 30, rating: 4 },
    { code: 'SUP-TRN-001', name: 'Konkan Roadways Cargo', category: 'TRANSPORT', city: 'Bhiwandi', state: 'Maharashtra', stateCode: '27', pin: '421302', lead: 1, credit: 15, rating: 4 },
    { code: 'SUP-JW-001', name: 'Ambika Stitching Unit', category: 'SERVICE', city: 'Bhiwandi', state: 'Maharashtra', stateCode: '27', pin: '421305', lead: 7, credit: 15, rating: 4, msme: true, notes: 'Outside stitching. 60 machines.' },
    { code: 'SUP-JW-002', name: 'Noor Embroidery Works', category: 'SERVICE', city: 'Bhiwandi', state: 'Maharashtra', stateCode: '27', pin: '421302', lead: 5, credit: 15, rating: 5, msme: true, notes: 'Computerised embroidery, 12 heads.' },
    { code: 'SUP-JW-003', name: 'Crystal Washing & Finishing', category: 'SERVICE', city: 'Bhiwandi', state: 'Maharashtra', stateCode: '27', pin: '421308', lead: 4, credit: 21, rating: 3, notes: 'Enzyme and silicone wash.' },
    { code: 'SUP-OTH-001', name: 'Sunrise Machine Spares', category: 'OTHER', city: 'Mumbai', state: 'Maharashtra', stateCode: '27', pin: '400011', lead: 2, credit: 7, rating: 4 },
  ]

  const suppliers = new Map<string, string>()
  for (const [i, s] of supplierData.entries()) {
    const row = await prisma.supplier.upsert({
      where: { code: s.code },
      update: { name: s.name },
      create: {
        code: s.code,
        name: s.name,
        category: s.category as never,
        gstin: `${s.stateCode}DEMOC${2000 + i}B1Z${i % 10}`,
        pan: `DEMOC${2000 + i}B`,
        phone: `98200 2${String(1000 + i)}`,
        email: `${s.code.toLowerCase()}@example.com`,
        address: `Plot ${10 + i}, Industrial Estate`,
        city: s.city,
        state: s.state,
        stateCode: s.stateCode,
        pincode: s.pin,
        creditDays: s.credit,
        leadTimeDays: s.lead,
        paymentTerms: `${s.credit} days from bill date`,
        rating: s.rating,
        isPreferred: s.preferred ?? false,
        isMsme: s.msme ?? false,
        // MSME suppliers must be paid within 45 days by law, so the number is
        // on the record rather than in someone's head at month end.
        msmeNumber: s.msme ? `UDYAM-MH-26-${String(1000000 + i)}` : null,
        isGroupCompany: s.group ?? false,
        notes: s.notes ?? null,
      },
    })
    suppliers.set(s.code, row.id)
  }

  // ───────────────────────────────────────────────────────────────────────
  // Customers
  //
  // Spread across states on purpose. Maharashtra buyers are taxed CGST+SGST
  // and everyone else IGST, so a demo with only local buyers would never show
  // the tax split working.
  // ───────────────────────────────────────────────────────────────────────
  const customerData = [
    { code: 'CUS-001', name: 'Rajmandir Garments', type: 'DOMESTIC', city: 'Mumbai', state: 'Maharashtra', stateCode: '27', pin: '400002', limit: 2500000, credit: 45, broker: 'BRK-001' },
    { code: 'CUS-002', name: 'Kanha Apparels Pvt Ltd', type: 'DOMESTIC', city: 'Surat', state: 'Gujarat', stateCode: '24', pin: '395003', limit: 1800000, credit: 30, broker: 'BRK-002' },
    { code: 'CUS-003', name: 'Southern Style Retail', type: 'DOMESTIC', city: 'Chennai', state: 'Tamil Nadu', stateCode: '33', pin: '600001', limit: 1200000, credit: 30, broker: 'BRK-004' },
    { code: 'CUS-004', name: 'Metro Menswear Wholesale', type: 'DOMESTIC', city: 'Delhi', state: 'Delhi', stateCode: '07', pin: '110006', limit: 2000000, credit: 45, broker: 'BRK-005' },
    { code: 'CUS-005', name: 'Ganga Readymade Stores', type: 'DOMESTIC', city: 'Kanpur', state: 'Uttar Pradesh', stateCode: '09', pin: '208001', limit: 900000, credit: 30, broker: 'BRK-005' },
    { code: 'CUS-006', name: 'Deccan Fashion Distributors', type: 'DOMESTIC', city: 'Hyderabad', state: 'Telangana', stateCode: '36', pin: '500003', limit: 1500000, credit: 45, broker: 'BRK-004' },
    { code: 'CUS-007', name: 'Bengal Trend House', type: 'DOMESTIC', city: 'Kolkata', state: 'West Bengal', stateCode: '19', pin: '700007', limit: 800000, credit: 30, broker: 'BRK-003' },
    { code: 'CUS-008', name: 'Marwar Clothing Co', type: 'DOMESTIC', city: 'Jaipur', state: 'Rajasthan', stateCode: '08', pin: '302003', limit: 700000, credit: 30, broker: 'BRK-005' },
    { code: 'CUS-009', name: 'Nithya Exports LLP', type: 'EXPORT', city: 'Tirupur', state: 'Tamil Nadu', stateCode: '33', pin: '641604', limit: 3500000, credit: 60, broker: 'BRK-004' },
    { code: 'CUS-010', name: 'Orient Overseas Sourcing', type: 'EXPORT', city: 'Mumbai', state: 'Maharashtra', stateCode: '27', pin: '400021', limit: 4000000, credit: 60, broker: 'BRK-001' },
    { code: 'CUS-011', name: 'Vasant Apparel', type: 'JOB_WORK', city: 'Bhiwandi', state: 'Maharashtra', stateCode: '27', pin: '421302', limit: 600000, credit: 21, broker: 'SELF', notes: 'Sends their own fabric. Stock stays customer-owned until dispatch.' },
    { code: 'CUS-012', name: 'Trueline Garments', type: 'JOB_WORK', city: 'Thane', state: 'Maharashtra', stateCode: '27', pin: '400604', limit: 500000, credit: 21, broker: 'SELF', notes: 'Cut-make-trim only. We supply nothing but labour.' },
    { code: 'CUS-013', name: 'VHAGAR Flagship — Mumbai', type: 'VHAGAR_DEALER', city: 'Mumbai', state: 'Maharashtra', stateCode: '27', pin: '400013', limit: 1000000, credit: 15, broker: 'SELF' },
    { code: 'CUS-014', name: 'VHAGAR Dealer — Pune', type: 'VHAGAR_DEALER', city: 'Pune', state: 'Maharashtra', stateCode: '27', pin: '411001', limit: 600000, credit: 15, broker: 'SELF' },
    { code: 'CUS-015', name: 'VHAGAR Dealer — Bengaluru', type: 'VHAGAR_DEALER', city: 'Bengaluru', state: 'Karnataka', stateCode: '29', pin: '560001', limit: 600000, credit: 15, broker: 'SELF' },
    { code: 'CUS-016', name: 'Cotton County Retail', type: 'DOMESTIC', city: 'Ludhiana', state: 'Punjab', stateCode: '03', pin: '141001', limit: 1100000, credit: 30, broker: 'BRK-003' },
  ]

  const selfBroker = await prisma.broker.findUnique({ where: { code: 'SELF' } })
  const customers = new Map<string, string>()

  for (const [i, c] of customerData.entries()) {
    const brokerId = c.broker === 'SELF' ? selfBroker?.id : brokers.get(c.broker)
    const row = await prisma.customer.upsert({
      where: { code: c.code },
      update: { name: c.name },
      create: {
        code: c.code,
        name: c.name,
        type: c.type as never,
        gstin: `${c.stateCode}DEMOC${3000 + i}C1Z${i % 10}`,
        pan: `DEMOC${3000 + i}C`,
        phone: `98200 3${String(1000 + i)}`,
        email: `${c.code.toLowerCase()}@example.com`,
        billingAddress: `${20 + i}, Cloth Market Road`,
        billingCity: c.city,
        billingState: c.state,
        billingStateCode: c.stateCode,
        billingPincode: c.pin,
        // Delivery is the same as billing for most buyers; where it differs
        // the shipping state code is what decides the tax, not the billing one.
        shippingAddress: `${20 + i}, Cloth Market Road`,
        shippingCity: c.city,
        shippingState: c.state,
        shippingStateCode: c.stateCode,
        shippingPincode: c.pin,
        creditLimit: c.limit,
        creditDays: c.credit,
        paymentTerms: `${c.credit} days from invoice`,
        brokerId: brokerId ?? null,
        brokeragePercent: c.broker === 'SELF' ? 0 : undefined,
        bankName: 'Demo Bank of India',
        bankAccount: `0000${String(100000 + i)}`,
        bankIFSC: 'DEMO0000001',
        notes: c.notes ?? null,
      },
    })
    customers.set(c.code, row.id)
  }

  // ───────────────────────────────────────────────────────────────────────
  // Items
  //
  // HSN and GST rate sit on the item, not on the person typing the invoice.
  // That is the single biggest source of GST notices in a garment unit: cloth
  // at 5%, thread at 12%, buttons and packing at 18%, all on one bill.
  // ───────────────────────────────────────────────────────────────────────
  type ItemSeed = {
    code: string
    name: string
    type: string
    cat: string
    uom: string
    hsn: string
    gst: number
    rate: number
    reorder?: number
    desc?: string
  }

  const itemData: ItemSeed[] = [
    // Fabric — 5%
    { code: 'FAB-COT-001', name: 'Cotton Poplin 40s — White', type: 'RAW_MATERIAL', cat: 'Fabric', uom: 'mtr', hsn: '5208', gst: 5, rate: 118, reorder: 3000, desc: '58" width, 120 gsm' },
    { code: 'FAB-COT-002', name: 'Cotton Poplin 40s — Sky Blue', type: 'RAW_MATERIAL', cat: 'Fabric', uom: 'mtr', hsn: '5208', gst: 5, rate: 122, reorder: 2000 },
    { code: 'FAB-COT-003', name: 'Cotton Oxford 20s — Navy', type: 'RAW_MATERIAL', cat: 'Fabric', uom: 'mtr', hsn: '5209', gst: 5, rate: 165, reorder: 1500 },
    { code: 'FAB-COT-004', name: 'Cotton Twill 2/60s — Beige', type: 'RAW_MATERIAL', cat: 'Fabric', uom: 'mtr', hsn: '5209', gst: 5, rate: 178, reorder: 1200 },
    { code: 'FAB-CHK-001', name: 'Yarn Dyed Check — Blue', type: 'RAW_MATERIAL', cat: 'Fabric', uom: 'mtr', hsn: '5208', gst: 5, rate: 152, reorder: 1800 },
    { code: 'FAB-CHK-002', name: 'Yarn Dyed Stripe — Grey', type: 'RAW_MATERIAL', cat: 'Fabric', uom: 'mtr', hsn: '5208', gst: 5, rate: 148, reorder: 1800 },
    { code: 'FAB-LIN-001', name: 'Linen Blend 60/40 — Ecru', type: 'RAW_MATERIAL', cat: 'Fabric', uom: 'mtr', hsn: '5309', gst: 5, rate: 245, reorder: 800 },
    { code: 'FAB-SLK-001', name: 'Silk Blend Shirting — Maroon', type: 'RAW_MATERIAL', cat: 'Fabric', uom: 'mtr', hsn: '5007', gst: 5, rate: 420, reorder: 400, desc: 'Bought from LD Silk Mills' },
    { code: 'FAB-PC-001', name: 'Poly Cotton 65/35 — White', type: 'RAW_MATERIAL', cat: 'Fabric', uom: 'mtr', hsn: '5407', gst: 5, rate: 96, reorder: 2500 },
    { code: 'FAB-DEN-001', name: 'Denim 10 oz — Indigo', type: 'RAW_MATERIAL', cat: 'Fabric', uom: 'mtr', hsn: '5209', gst: 5, rate: 210, reorder: 900 },

    // Thread — 12%
    { code: 'THR-PC-001', name: 'Poly Cotton Thread 40/2 — White', type: 'RAW_MATERIAL', cat: 'Thread', uom: 'roll', hsn: '5401', gst: 12, rate: 82, reorder: 200, desc: '5000 m cone' },
    { code: 'THR-PC-002', name: 'Poly Cotton Thread 40/2 — Navy', type: 'RAW_MATERIAL', cat: 'Thread', uom: 'roll', hsn: '5401', gst: 12, rate: 82, reorder: 150 },
    { code: 'THR-PC-003', name: 'Poly Cotton Thread 40/2 — Black', type: 'RAW_MATERIAL', cat: 'Thread', uom: 'roll', hsn: '5401', gst: 12, rate: 82, reorder: 150 },
    { code: 'THR-EMB-001', name: 'Embroidery Thread Viscose — Gold', type: 'RAW_MATERIAL', cat: 'Thread', uom: 'roll', hsn: '5401', gst: 12, rate: 145, reorder: 60 },

    // Buttons and fasteners — 18%
    { code: 'BTN-PLY-001', name: 'Polyester Button 18L — White', type: 'TRIM', cat: 'Buttons & Fasteners', uom: 'pcs', hsn: '9606', gst: 18, rate: 0.65, reorder: 50000 },
    { code: 'BTN-PLY-002', name: 'Polyester Button 18L — Navy', type: 'TRIM', cat: 'Buttons & Fasteners', uom: 'pcs', hsn: '9606', gst: 18, rate: 0.65, reorder: 30000 },
    { code: 'BTN-HRN-001', name: 'Horn Finish Button 24L — Brown', type: 'TRIM', cat: 'Buttons & Fasteners', uom: 'pcs', hsn: '9606', gst: 18, rate: 2.4, reorder: 10000 },
    { code: 'BTN-SNP-001', name: 'Metal Snap Button 15 mm', type: 'TRIM', cat: 'Buttons & Fasteners', uom: 'pcs', hsn: '9606', gst: 18, rate: 3.1, reorder: 8000 },

    // Trims — 12/18%
    { code: 'TRM-INT-001', name: 'Fusible Interlining 40 gsm', type: 'RAW_MATERIAL', cat: 'Trims & Accessories', uom: 'mtr', hsn: '5903', gst: 12, rate: 38, reorder: 2000 },
    { code: 'TRM-COL-001', name: 'Collar Bone 2.5"', type: 'TRIM', cat: 'Trims & Accessories', uom: 'pcs', hsn: '3926', gst: 18, rate: 1.2, reorder: 20000 },
    { code: 'TRM-ZIP-001', name: 'Nylon Zipper 6" — Grey', type: 'TRIM', cat: 'Trims & Accessories', uom: 'pcs', hsn: '9607', gst: 18, rate: 8.5, reorder: 5000 },
    { code: 'TRM-ELS-001', name: 'Elastic Tape 40 mm', type: 'TRIM', cat: 'Trims & Accessories', uom: 'mtr', hsn: '5604', gst: 12, rate: 14, reorder: 3000 },

    // Labels and tags
    { code: 'LBL-MAIN-001', name: 'Woven Main Label — LD Cotton Mills', type: 'TRIM', cat: 'Labels & Tags', uom: 'pcs', hsn: '5807', gst: 12, rate: 1.85, reorder: 25000 },
    { code: 'LBL-MAIN-002', name: 'Woven Main Label — VHAGAR', type: 'TRIM', cat: 'Labels & Tags', uom: 'pcs', hsn: '5807', gst: 12, rate: 2.1, reorder: 15000 },
    { code: 'LBL-CARE-001', name: 'Care Label — Satin Printed', type: 'TRIM', cat: 'Labels & Tags', uom: 'pcs', hsn: '5807', gst: 12, rate: 0.55, reorder: 40000 },
    { code: 'LBL-SIZE-001', name: 'Size Label Set S–3XL', type: 'TRIM', cat: 'Labels & Tags', uom: 'set', hsn: '5807', gst: 12, rate: 0.4, reorder: 40000 },
    { code: 'TAG-HANG-001', name: 'Hang Tag — VHAGAR Art Card', type: 'PACKING_MATERIAL', cat: 'Labels & Tags', uom: 'pcs', hsn: '4821', gst: 18, rate: 3.2, reorder: 12000 },
    { code: 'TAG-PRC-001', name: 'Price Tag — String Attached', type: 'PACKING_MATERIAL', cat: 'Labels & Tags', uom: 'pcs', hsn: '4821', gst: 18, rate: 0.9, reorder: 20000 },

    // Packing — 18%
    { code: 'PKG-POLY-001', name: 'Poly Bag 10x14 Self Seal', type: 'PACKING_MATERIAL', cat: 'Packing Material', uom: 'pcs', hsn: '3923', gst: 18, rate: 1.15, reorder: 30000 },
    { code: 'PKG-POLY-002', name: 'Poly Bag 12x16 Self Seal', type: 'PACKING_MATERIAL', cat: 'Packing Material', uom: 'pcs', hsn: '3923', gst: 18, rate: 1.45, reorder: 20000 },
    { code: 'PKG-BOX-001', name: 'Carton Box 5 Ply 24x16x12', type: 'PACKING_MATERIAL', cat: 'Packing Material', uom: 'pcs', hsn: '4819', gst: 18, rate: 62, reorder: 800 },
    { code: 'PKG-TAPE-001', name: 'BOPP Tape 2" x 65 m', type: 'PACKING_MATERIAL', cat: 'Packing Material', uom: 'roll', hsn: '3919', gst: 18, rate: 28, reorder: 300 },
    { code: 'PKG-CLIP-001', name: 'Collar Clip — Butterfly', type: 'PACKING_MATERIAL', cat: 'Packing Material', uom: 'pcs', hsn: '3926', gst: 18, rate: 0.35, reorder: 25000 },
    { code: 'PKG-PIN-001', name: 'Pin Box — 1000 pcs', type: 'PACKING_MATERIAL', cat: 'Packing Material', uom: 'box', hsn: '7319', gst: 18, rate: 45, reorder: 150 },
    { code: 'PKG-TISS-001', name: 'Tissue Paper — Shirt Insert', type: 'PACKING_MATERIAL', cat: 'Packing Material', uom: 'pcs', hsn: '4803', gst: 18, rate: 0.6, reorder: 25000 },

    // Consumables
    { code: 'CON-NDL-001', name: 'Machine Needle DBx1 #14 — Box of 100', type: 'CONSUMABLE', cat: 'Trims & Accessories', uom: 'box', hsn: '8452', gst: 18, rate: 320, reorder: 40 },
    { code: 'CON-OIL-001', name: 'Sewing Machine Oil — 5 L', type: 'CONSUMABLE', cat: 'Trims & Accessories', uom: 'pcs', hsn: '2710', gst: 18, rate: 780, reorder: 12 },
    { code: 'CON-CHK-001', name: 'Tailor Chalk — Box of 50', type: 'CONSUMABLE', cat: 'Trims & Accessories', uom: 'box', hsn: '9609', gst: 18, rate: 110, reorder: 20 },

    // Finished goods — 5% below ₹1000, which is why the linen shirt is 12%
    { code: 'FG-SHRT-001', name: "Men's Formal Shirt — Full Sleeve", type: 'FINISHED_GOOD', cat: 'Finished Goods', uom: 'pcs', hsn: '6205', gst: 5, rate: 745 },
    { code: 'FG-SHRT-002', name: "Men's Casual Check Shirt", type: 'FINISHED_GOOD', cat: 'Finished Goods', uom: 'pcs', hsn: '6205', gst: 5, rate: 690 },
    { code: 'FG-SHRT-003', name: "Men's Linen Shirt — VHAGAR", type: 'FINISHED_GOOD', cat: 'Finished Goods', uom: 'pcs', hsn: '6205', gst: 12, rate: 1250 },
    { code: 'FG-TRSR-001', name: "Men's Cotton Trouser", type: 'FINISHED_GOOD', cat: 'Finished Goods', uom: 'pcs', hsn: '6203', gst: 5, rate: 980 },
  ]

  const items = new Map<string, string>()
  for (const it of itemData) {
    const row = await prisma.item.upsert({
      where: { code: it.code },
      update: { name: it.name, standardRate: it.rate },
      create: {
        code: it.code,
        name: it.name,
        description: it.desc ?? null,
        type: it.type as never,
        categoryId: cats.get(it.cat)!,
        uomId: uoms.get(it.uom)!,
        hsnCode: it.hsn,
        standardRate: it.rate,
        taxRateId: taxes.get(it.gst) ?? null,
        reorderLevel: it.reorder ?? null,
        minStock: it.reorder ? Math.round(it.reorder * 0.5) : null,
        maxStock: it.reorder ? it.reorder * 4 : null,
      },
    })
    items.set(it.code, row.id)
  }

  // ───────────────────────────────────────────────────────────────────────
  // Styles
  //
  // A style is the design; the item is the thing in the godown. They are kept
  // apart because one style is made in six sizes and three colours and would
  // otherwise become eighteen item codes nobody can maintain.
  // ───────────────────────────────────────────────────────────────────────
  const SHIRT_COLLAR = sizeGroups.get("Men's Shirt (Collar)")!
  const SHIRT_ALPHA = sizeGroups.get("Men's Shirt (Alpha)")!
  const TROUSER = sizeGroups.get("Men's Trouser (Waist)")!

  const styleData = [
    { code: 'LD-SH-2601', name: 'Aspen Formal Shirt — Full Sleeve', brandType: 'LD_COTTON_MILLS', season: 'SS-26', category: 'Shirt', collarType: 'Cutaway', sleeveType: 'Full', fit: 'Slim', fabricType: 'Cotton Poplin', gsm: 120, sizeGroupId: SHIRT_COLLAR, colors: ['White', 'Sky Blue', 'Lavender'] },
    { code: 'LD-SH-2602', name: 'Denver Oxford Shirt — Half Sleeve', brandType: 'LD_COTTON_MILLS', season: 'SS-26', category: 'Shirt', collarType: 'Button Down', sleeveType: 'Half', fit: 'Regular', fabricType: 'Cotton Oxford', gsm: 140, sizeGroupId: SHIRT_COLLAR, colors: ['Navy', 'White'] },
    { code: 'LD-SH-2603', name: 'Cortland Check Shirt — Full Sleeve', brandType: 'LD_COTTON_MILLS', season: 'AW-26', category: 'Shirt', collarType: 'Spread', sleeveType: 'Full', fit: 'Regular', fabricType: 'Yarn Dyed Check', gsm: 125, sizeGroupId: SHIRT_ALPHA, colors: ['Blue Check', 'Green Check'] },
    { code: 'LD-SH-2604', name: 'Bexley Stripe Shirt — Full Sleeve', brandType: 'LD_COTTON_MILLS', season: 'AW-26', category: 'Shirt', collarType: 'Spread', sleeveType: 'Full', fit: 'Slim', fabricType: 'Yarn Dyed Stripe', gsm: 125, sizeGroupId: SHIRT_ALPHA, colors: ['Grey Stripe', 'Blue Stripe'] },
    { code: 'LD-SH-2605', name: 'Sterling Denim Shirt — Full Sleeve', brandType: 'LD_COTTON_MILLS', season: 'AW-26', category: 'Shirt', collarType: 'Classic', sleeveType: 'Full', fit: 'Regular', fabricType: 'Denim 10 oz', gsm: 290, sizeGroupId: SHIRT_ALPHA, colors: ['Indigo'] },
    { code: 'LD-TR-2601', name: 'Halden Cotton Trouser', brandType: 'LD_COTTON_MILLS', season: 'SS-26', category: 'Trouser', collarType: null, sleeveType: null, fit: 'Regular', fabricType: 'Cotton Twill', gsm: 240, sizeGroupId: TROUSER, colors: ['Beige', 'Navy'] },
    { code: 'LD-TR-2602', name: 'Kingsley Twill Chino', brandType: 'LD_COTTON_MILLS', season: 'SS-26', category: 'Trouser', collarType: null, sleeveType: null, fit: 'Slim', fabricType: 'Cotton Twill', gsm: 240, sizeGroupId: TROUSER, colors: ['Khaki', 'Olive'] },
    { code: 'VH-SH-2601', name: 'VHAGAR Riviera Linen Shirt', brandType: 'VHAGAR', season: 'SS-26', category: 'Shirt', collarType: 'Cuban', sleeveType: 'Half', fit: 'Relaxed', fabricType: 'Linen Blend', gsm: 150, sizeGroupId: SHIRT_ALPHA, colors: ['Ecru', 'Sage'] },
    { code: 'VH-SH-2602', name: 'VHAGAR Noir Silk Shirt', brandType: 'VHAGAR', season: 'AW-26', category: 'Shirt', collarType: 'Classic', sleeveType: 'Full', fit: 'Slim', fabricType: 'Silk Blend', gsm: 110, sizeGroupId: SHIRT_ALPHA, colors: ['Maroon', 'Black'] },
    { code: 'VH-SH-2603', name: 'VHAGAR Coastal Camp Shirt', brandType: 'VHAGAR', season: 'SS-26', category: 'Shirt', collarType: 'Camp', sleeveType: 'Half', fit: 'Relaxed', fabricType: 'Poly Cotton', gsm: 130, sizeGroupId: SHIRT_ALPHA, colors: ['White', 'Sky Blue'] },
  ]

  const styles = new Map<string, string>()
  for (const s of styleData) {
    const row = await prisma.style.upsert({
      where: { code: s.code },
      update: { name: s.name },
      create: s as never,
    })
    styles.set(s.code, row.id)
  }

  // ───────────────────────────────────────────────────────────────────────
  // Bills of material
  //
  // Wastage is a separate column from quantity on purpose. "1.65 metres" and
  // "1.5 metres plus 10% wastage" cost the same but tell you different things
  // when the cutting master starts getting 12%.
  // ───────────────────────────────────────────────────────────────────────
  type BomSeed = { style: string; notes: string; lines: Array<[string, number, number]> }

  const bomData: BomSeed[] = [
    {
      style: 'LD-SH-2601',
      notes: 'Full sleeve formal shirt, 58" fabric.',
      lines: [
        ['FAB-COT-001', 1.55, 8],
        ['TRM-INT-001', 0.18, 5],
        ['THR-PC-001', 0.02, 3],
        ['BTN-PLY-001', 11, 4],
        ['TRM-COL-001', 2, 2],
        ['LBL-MAIN-001', 1, 1],
        ['LBL-CARE-001', 1, 1],
        ['LBL-SIZE-001', 1, 1],
        ['PKG-POLY-001', 1, 2],
        ['PKG-CLIP-001', 1, 2],
        ['PKG-TISS-001', 2, 2],
        ['TAG-PRC-001', 1, 1],
      ],
    },
    {
      style: 'LD-SH-2603',
      notes: 'Check shirt. Extra fabric allowance because checks have to match at the pocket and yoke.',
      lines: [
        ['FAB-CHK-001', 1.7, 12],
        ['TRM-INT-001', 0.18, 5],
        ['THR-PC-002', 0.02, 3],
        ['BTN-HRN-001', 11, 4],
        ['LBL-MAIN-001', 1, 1],
        ['LBL-CARE-001', 1, 1],
        ['LBL-SIZE-001', 1, 1],
        ['PKG-POLY-001', 1, 2],
        ['PKG-TISS-001', 2, 2],
      ],
    },
    {
      style: 'VH-SH-2601',
      notes: 'VHAGAR linen. Higher wastage — linen shrinks after wash and cannot be cut tight.',
      lines: [
        ['FAB-LIN-001', 1.6, 14],
        ['THR-PC-001', 0.02, 3],
        ['BTN-HRN-001', 9, 4],
        ['LBL-MAIN-002', 1, 1],
        ['LBL-CARE-001', 1, 1],
        ['LBL-SIZE-001', 1, 1],
        ['TAG-HANG-001', 1, 1],
        ['PKG-POLY-002', 1, 2],
        ['PKG-TISS-001', 2, 2],
      ],
    },
    {
      style: 'LD-TR-2601',
      notes: 'Cotton trouser.',
      lines: [
        ['FAB-COT-004', 1.35, 10],
        ['TRM-INT-001', 0.12, 5],
        ['THR-PC-003', 0.03, 3],
        ['TRM-ZIP-001', 1, 2],
        ['BTN-SNP-001', 1, 2],
        ['BTN-PLY-002', 2, 4],
        ['LBL-MAIN-001', 1, 1],
        ['LBL-CARE-001', 1, 1],
        ['PKG-POLY-002', 1, 2],
      ],
    },
  ]

  // How much more cloth each step up the size run takes. Only the fabric
  // varies — buttons, care labels and poly bags are the same on a 3XL as on
  // an S, which is why most lines below carry no size rows at all.
  const SIZE_STEP = 0.04

  // Which department draws each kind of material from the store. Fabric goes to
  // Cutting and interlining to Fusing; thread, labels and zips are sewn in at
  // Stitching; buttons go on at Kaj Button; tags and collar stays at Finishing;
  // poly bags, clips and tissue at Packing. Keyed on the item-code prefix,
  // because that is how the demo items happen to be grouped.
  const processByPrefix: Array<[string, string]> = [
    ['FAB-', 'CUT'],
    ['TRM-INT-', 'FUS'],
    ['TRM-COL-', 'FIN'],
    ['TRM-ZIP-', 'STI'],
    ['THR-', 'STI'],
    ['LBL-', 'STI'],
    ['BTN-', 'KAJ'],
    ['TAG-', 'FIN'],
    ['PKG-', 'PKG'],
  ]
  const processFor = (itemCode: string) => {
    const hit = processByPrefix.find(([prefix]) => itemCode.startsWith(prefix))
    return hit ? dept(hit[1]) : null
  }

  for (const b of bomData) {
    const styleId = styles.get(b.style)!
    await prisma.bOM.deleteMany({ where: { styleId } })

    const style = await prisma.style.findUnique({
      where: { id: styleId },
      select: { sizeGroupId: true, colors: true },
    })
    const runSizes = style?.sizeGroupId
      ? await prisma.size.findMany({
          where: { sizeGroupId: style.sizeGroupId },
          orderBy: { sequence: 'asc' },
          select: { id: true },
        })
      : []
    // The middle of the run, which is the size a pattern is actually cut to.
    const baseIndex = runSizes.length > 0 ? Math.floor((runSizes.length - 1) / 2) : -1
    const baseSizeId = baseIndex >= 0 ? runSizes[baseIndex].id : null

    const lines = b.lines.map(([itemCode, qty, wastage], i) => {
      const item = itemData.find((x) => x.code === itemCode)!
      const factor = 1 + wastage / 100
      const effectiveQty = Number((qty * factor).toFixed(4))

      const sizes =
        itemCode.startsWith('FAB-') && baseIndex >= 0
          ? runSizes.map((sz, si) => {
              const sizeQty = Number((qty + SIZE_STEP * (si - baseIndex)).toFixed(4))
              const sizeEffective = Number((sizeQty * factor).toFixed(4))
              return {
                sizeId: sz.id,
                qtyPerUnit: sizeQty,
                effectiveQty: sizeEffective,
                totalCost: Number((sizeEffective * item.rate).toFixed(2)),
              }
            })
          : []

      return {
        componentItemId: items.get(itemCode)!,
        departmentId: processFor(itemCode),
        qtyPerUnit: qty,
        wastagePercent: wastage,
        effectiveQty,
        unitCost: item.rate,
        // Two places, off the rounded quantity — the same arithmetic the API
        // does, so a reseeded BOM agrees with one typed in by hand.
        totalCost: Number((effectiveQty * item.rate).toFixed(2)),
        sortOrder: i,
        ...(sizes.length > 0 ? { sizes: { create: sizes } } : {}),
      }
    })

    const totalCost = Number(lines.reduce((sum, l) => sum + Number(l.totalCost), 0).toFixed(2))

    // One BOM per colour, the way the production team makes them. The demo
    // keeps one fabric item for every colour, which a real mill would not —
    // a dusty blue shirt's BOM names the dusty blue cloth.
    const colours = style?.colors?.length ? style.colors : [null]
    for (const color of colours) {
      await prisma.bOM.create({
        data: {
          styleId,
          color,
          version: '1.0',
          // Demo BOMs are the ones orders get costed against, so they are
          // approved rather than left as drafts nothing can use.
          status: 'APPROVED',
          approvedAt: new Date(),
          baseSizeId,
          isActive: true,
          notes: b.notes,
          totalCost,
          lines: { create: lines },
        },
      })
    }
  }

  // ───────────────────────────────────────────────────────────────────────
  // Operations — put real minutes and job-work rates on the core operations
  //
  // The core seed leaves SMV blank on purpose: it is measured on the floor,
  // not guessed. These are demo figures so a routing has something to add up.
  // ───────────────────────────────────────────────────────────────────────
  const opRates: Array<[string, number, number]> = [
    // code, SMV (minutes per piece), job work rate (₹ per piece)
    ['OP-CUT', 1.8, 3.5],
    ['OP-CUTQC', 0.6, 1.0],
    ['OP-FUS', 0.9, 1.5],
    ['OP-EMB', 4.5, 18.0],
    ['OP-EMBQC', 0.7, 1.0],
    ['OP-STI', 16.5, 42.0],
    ['OP-LINEQC', 1.2, 2.0],
    ['OP-KAJ', 2.4, 5.0],
    ['OP-WSH', 3.0, 12.0],
    ['OP-FIN', 4.2, 9.0],
    ['OP-FINQC', 1.5, 2.5],
    ['OP-PKG', 2.0, 4.0],
    ['OP-JW', 0, 0],
  ]

  const operations = new Map<string, string>()
  for (const [code, smv, rate] of opRates) {
    const op = await prisma.operation.update({
      where: { code },
      data: { smv: smv || null, jobWorkRate: rate || null },
    })
    operations.set(code, op.id)
  }

  // ───────────────────────────────────────────────────────────────────────
  // Workstations — the outside units
  //
  // The core seed puts in the six in-house benches. Most of LD's stitching,
  // embroidery and washing happens outside, and linking a workstation to its
  // supplier is what makes that unit's monthly job-work bill addable.
  // ───────────────────────────────────────────────────────────────────────
  const jobWorkStations = [
    { code: 'JW-STI-01', name: 'Ambika Stitching — Line A', deptCode: 'STI', supplier: 'SUP-JW-001', capacity: 450, contact: 'Line supervisor' },
    { code: 'JW-STI-02', name: 'Ambika Stitching — Line B', deptCode: 'STI', supplier: 'SUP-JW-001', capacity: 400, contact: 'Line supervisor' },
    { code: 'JW-EMB-01', name: 'Noor Embroidery — 12 Head', deptCode: 'EMB', supplier: 'SUP-JW-002', capacity: 700, contact: 'Unit in-charge' },
    { code: 'JW-WSH-01', name: 'Crystal Washing — Drum 1', deptCode: 'WSH', supplier: 'SUP-JW-003', capacity: 1200, contact: 'Wash master' },
    { code: 'JW-FIN-01', name: 'Crystal Finishing — Press Line', deptCode: 'FIN', supplier: 'SUP-JW-003', capacity: 900, contact: 'Press in-charge' },
  ]

  const workstations = new Map<string, string>()
  for (const [i, w] of jobWorkStations.entries()) {
    const row = await prisma.workstation.upsert({
      where: { code: w.code },
      update: { name: w.name },
      create: {
        code: w.code,
        name: w.name,
        departmentId: dept(w.deptCode),
        type: 'JOB_WORK',
        supplierId: suppliers.get(w.supplier)!,
        capacityPerDay: w.capacity,
        contactPerson: w.contact,
        phone: `98200 4${String(1000 + i)}`,
        address: 'Bhiwandi, Thane',
      },
    })
    workstations.set(w.code, row.id)
  }

  for (const ws of await prisma.workstation.findMany({ where: { type: 'IN_HOUSE' } })) {
    workstations.set(ws.code, ws.id)
  }

  // ───────────────────────────────────────────────────────────────────────
  // Routings
  //
  // No two styles take the same path. A plain shirt skips washing; the denim
  // one washes and presses; the embroidered VHAGAR shirt adds two steps before
  // stitching ever starts. That is why the route is a record and not a rule.
  // ───────────────────────────────────────────────────────────────────────
  type RouteSeed = {
    code: string
    name: string
    style: string
    steps: Array<{ op: string; dept: string; ws?: string; qc?: boolean }>
  }

  const routingData: RouteSeed[] = [
    {
      code: 'RT-SH-PLAIN',
      name: 'Plain shirt — cut, stitch, kaj, finish, pack',
      style: 'LD-SH-2601',
      steps: [
        { op: 'OP-CUT', dept: 'CUT', ws: 'WS-CUT-01' },
        { op: 'OP-CUTQC', dept: 'CUTQC', qc: true },
        { op: 'OP-FUS', dept: 'FUS', ws: 'WS-FUS-01' },
        { op: 'OP-STI', dept: 'STI', ws: 'JW-STI-01' },
        { op: 'OP-LINEQC', dept: 'LINEQC', qc: true },
        { op: 'OP-KAJ', dept: 'KAJ', ws: 'WS-KAJ-01' },
        { op: 'OP-FIN', dept: 'FIN', ws: 'WS-FIN-01' },
        { op: 'OP-FINQC', dept: 'FINQC', qc: true },
        { op: 'OP-PKG', dept: 'PKG', ws: 'WS-PKG-01' },
      ],
    },
    {
      code: 'RT-SH-CHECK',
      name: 'Check shirt — same as plain, second cutting table',
      style: 'LD-SH-2603',
      steps: [
        { op: 'OP-CUT', dept: 'CUT', ws: 'WS-CUT-02' },
        { op: 'OP-CUTQC', dept: 'CUTQC', qc: true },
        { op: 'OP-FUS', dept: 'FUS', ws: 'WS-FUS-01' },
        { op: 'OP-STI', dept: 'STI', ws: 'JW-STI-02' },
        { op: 'OP-LINEQC', dept: 'LINEQC', qc: true },
        { op: 'OP-KAJ', dept: 'KAJ', ws: 'WS-KAJ-01' },
        { op: 'OP-FIN', dept: 'FIN', ws: 'WS-FIN-01' },
        { op: 'OP-FINQC', dept: 'FINQC', qc: true },
        { op: 'OP-PKG', dept: 'PKG', ws: 'WS-PKG-01' },
      ],
    },
    {
      code: 'RT-SH-EMB',
      name: 'VHAGAR linen — embroidery before stitching',
      style: 'VH-SH-2601',
      steps: [
        { op: 'OP-CUT', dept: 'CUT', ws: 'WS-CUT-01' },
        { op: 'OP-CUTQC', dept: 'CUTQC', qc: true },
        { op: 'OP-EMB', dept: 'EMB', ws: 'JW-EMB-01' },
        { op: 'OP-EMBQC', dept: 'EMBQC', qc: true },
        { op: 'OP-FUS', dept: 'FUS', ws: 'WS-FUS-01' },
        { op: 'OP-STI', dept: 'STI', ws: 'JW-STI-01' },
        { op: 'OP-LINEQC', dept: 'LINEQC', qc: true },
        { op: 'OP-KAJ', dept: 'KAJ', ws: 'WS-KAJ-01' },
        { op: 'OP-FIN', dept: 'FIN', ws: 'JW-FIN-01' },
        { op: 'OP-FINQC', dept: 'FINQC', qc: true },
        { op: 'OP-PKG', dept: 'PKG', ws: 'WS-PKG-01' },
      ],
    },
    {
      code: 'RT-SH-WASH',
      name: 'Denim shirt — washed after stitching',
      style: 'LD-SH-2605',
      steps: [
        { op: 'OP-CUT', dept: 'CUT', ws: 'WS-CUT-02' },
        { op: 'OP-CUTQC', dept: 'CUTQC', qc: true },
        { op: 'OP-STI', dept: 'STI', ws: 'JW-STI-02' },
        { op: 'OP-WSH', dept: 'WSH', ws: 'JW-WSH-01' },
        { op: 'OP-LINEQC', dept: 'LINEQC', qc: true },
        { op: 'OP-KAJ', dept: 'KAJ', ws: 'WS-KAJ-01' },
        { op: 'OP-FIN', dept: 'FIN', ws: 'JW-FIN-01' },
        { op: 'OP-FINQC', dept: 'FINQC', qc: true },
        { op: 'OP-PKG', dept: 'PKG', ws: 'WS-PKG-01' },
      ],
    },
    {
      code: 'RT-TR-BASIC',
      name: 'Cotton trouser — cut, stitch, finish, pack',
      style: 'LD-TR-2601',
      steps: [
        { op: 'OP-CUT', dept: 'CUT', ws: 'WS-CUT-01' },
        { op: 'OP-CUTQC', dept: 'CUTQC', qc: true },
        { op: 'OP-FUS', dept: 'FUS', ws: 'WS-FUS-01' },
        { op: 'OP-STI', dept: 'STI', ws: 'JW-STI-01' },
        { op: 'OP-LINEQC', dept: 'LINEQC', qc: true },
        { op: 'OP-FIN', dept: 'FIN', ws: 'WS-FIN-01' },
        { op: 'OP-FINQC', dept: 'FINQC', qc: true },
        { op: 'OP-PKG', dept: 'PKG', ws: 'WS-PKG-01' },
      ],
    },
  ]

  const smvOf = new Map(opRates.map(([c, smv, rate]) => [c, { smv, rate }] as const))

  for (const r of routingData) {
    await prisma.routing.deleteMany({ where: { code: r.code } })
    await prisma.routing.create({
      data: {
        code: r.code,
        name: r.name,
        styleId: styles.get(r.style)!,
        steps: {
          create: r.steps.map((s, i) => ({
            sequence: i + 1,
            operationId: operations.get(s.op)!,
            departmentId: dept(s.dept),
            workstationId: s.ws ? workstations.get(s.ws) ?? null : null,
            smv: smvOf.get(s.op)!.smv || null,
            ratePerPiece: smvOf.get(s.op)!.rate || null,
            isQcStep: s.qc ?? false,
          })),
        },
      },
    })
  }

  // The routings exist now, so each style BOM can point at one, and its rated
  // steps become the BOM's labour rows — the same thing the costing migration
  // (20260928100000) does to a live database. It happens here rather than up
  // with the BOM itself because a BOM cannot reference a routing that is not
  // created yet.
  for (const r of routingData) {
    const styleId = styles.get(r.style)
    if (!styleId) continue

    const routing = await prisma.routing.findUnique({
      where: { code: r.code },
      select: {
        id: true,
        steps: {
          orderBy: { sequence: 'asc' },
          select: {
            departmentId: true,
            ratePerPiece: true,
            operation: { select: { name: true } },
          },
        },
      },
    })
    if (!routing) continue

    const labourRows = routing.steps
      .filter((st) => Number(st.ratePerPiece ?? 0) > 0)
      .map((st, i) => ({
        kind: 'LABOUR' as const,
        name: st.operation.name,
        departmentId: st.departmentId,
        basis: 'PER_PIECE' as const,
        value: Number(st.ratePerPiece),
        amount: Number(st.ratePerPiece),
        sortOrder: i,
      }))
    const labourCost = Number(labourRows.reduce((sum, row) => sum + row.amount, 0).toFixed(2))

    const boms = await prisma.bOM.findMany({ where: { styleId }, select: { id: true, totalCost: true } })
    for (const bom of boms) {
      await prisma.bOMCostLine.deleteMany({ where: { bomId: bom.id } })
      if (labourRows.length > 0) {
        await prisma.bOMCostLine.createMany({
          data: labourRows.map((row) => ({ ...row, bomId: bom.id })),
        })
      }
      await prisma.bOM.update({
        where: { id: bom.id },
        data: {
          routingId: routing.id,
          labourCost,
          overheadCost: 0,
          costPerPiece: Number((Number(bom.totalCost ?? 0) + labourCost).toFixed(2)),
        },
      })
    }
  }

  // ───────────────────────────────────────────────────────────────────────
  // Machines
  // ───────────────────────────────────────────────────────────────────────
  const machineData = [
    { no: 'M-SNLS-01', name: 'Single Needle Lock Stitch 1', type: 'Lock Stitch', brand: 'Juki', model: 'DDL-8700', dept: 'STI' },
    { no: 'M-SNLS-02', name: 'Single Needle Lock Stitch 2', type: 'Lock Stitch', brand: 'Juki', model: 'DDL-8700', dept: 'STI' },
    { no: 'M-SNLS-03', name: 'Single Needle Lock Stitch 3', type: 'Lock Stitch', brand: 'Jack', model: 'A4', dept: 'STI' },
    { no: 'M-SNLS-04', name: 'Single Needle Lock Stitch 4', type: 'Lock Stitch', brand: 'Jack', model: 'A4', dept: 'STI', status: 'UNDER_MAINTENANCE' },
    { no: 'M-OVER-01', name: 'Overlock 5 Thread 1', type: 'Overlock', brand: 'Jack', model: 'C4', dept: 'STI' },
    { no: 'M-OVER-02', name: 'Overlock 5 Thread 2', type: 'Overlock', brand: 'Jack', model: 'C4', dept: 'STI' },
    { no: 'M-FLAT-01', name: 'Flat Lock', type: 'Flat Lock', brand: 'Siruba', model: 'F007', dept: 'STI' },
    { no: 'M-KAJ-01', name: 'Buttonhole Machine', type: 'Buttonhole', brand: 'Juki', model: 'LBH-1790', dept: 'KAJ' },
    { no: 'M-BTN-01', name: 'Button Attaching Machine', type: 'Button Attach', brand: 'Juki', model: 'MB-1800', dept: 'KAJ' },
    { no: 'M-FUS-01', name: 'Continuous Fusing Machine', type: 'Fusing', brand: 'Hashima', model: 'HP-600LFS', dept: 'FUS' },
    { no: 'M-CUT-01', name: 'Straight Knife Cutter 8"', type: 'Cutting', brand: 'Eastman', model: '629X', dept: 'CUT' },
    { no: 'M-CUT-02', name: 'End Cutter', type: 'Cutting', brand: 'Eastman', model: 'Chickadee', dept: 'CUT' },
    { no: 'M-PRS-01', name: 'Steam Press with Vacuum Table', type: 'Pressing', brand: 'Ramsons', model: 'RS-VT', dept: 'FIN' },
    { no: 'M-PRS-02', name: 'Steam Boiler 50 kg', type: 'Boiler', brand: 'Ramsons', model: 'RS-50', dept: 'FIN', status: 'BREAKDOWN' },
  ]

  for (const [i, m] of machineData.entries()) {
    await prisma.machine.upsert({
      where: { machineNo: m.no },
      update: { name: m.name },
      create: {
        machineNo: m.no,
        name: m.name,
        type: m.type,
        brand: m.brand,
        model: m.model,
        departmentId: dept(m.dept),
        status: (m.status ?? 'OPERATIONAL') as never,
        purchaseDate: new Date(2023, i % 12, 5 + (i % 20)),
        warrantyExpiry: new Date(2026, i % 12, 5 + (i % 20)),
      },
    })
  }

  // ───────────────────────────────────────────────────────────────────────
  // Salary structures and employees
  //
  // Three of these are daily-wage, which is how a cutting or packing hand is
  // actually engaged in Bhiwandi. Payroll that only understands monthly staff
  // would be wrong for most of the floor.
  // ───────────────────────────────────────────────────────────────────────
  const structureData = [
    { name: 'Staff Grade A', basic: 32000, hra: 12800, da: 3200, conveyance: 1600, specialAllowance: 4000, pf: true, esic: false },
    { name: 'Staff Grade B', basic: 21000, hra: 8400, da: 2100, conveyance: 1600, specialAllowance: 2500, pf: true, esic: true },
    { name: 'Supervisor', basic: 17000, hra: 6800, da: 1700, conveyance: 1200, specialAllowance: 1800, pf: true, esic: true },
    { name: 'Operator', basic: 13500, hra: 5400, da: 1350, conveyance: 1000, specialAllowance: 1000, pf: true, esic: true },
    { name: 'Helper / Daily Wage', basic: 11000, hra: 4400, da: 1100, conveyance: 800, specialAllowance: 0, pf: false, esic: true },
  ]

  const structures = new Map<string, string>()
  for (const s of structureData) {
    const row = await prisma.salaryStructure.upsert({
      where: { name: s.name },
      update: {},
      create: {
        name: s.name,
        basic: s.basic,
        hra: s.hra,
        da: s.da,
        conveyance: s.conveyance,
        specialAllowance: s.specialAllowance,
        pfApplicable: s.pf,
        esicApplicable: s.esic,
      },
    })
    structures.set(s.name, row.id)
  }

  const employeeData = [
    { code: 'EMP-001', name: 'Ramesh Patil', dept: 'CUT', designation: 'Cutting Master', structure: 'Supervisor', type: 'PERMANENT', join: '2019-06-10' },
    { code: 'EMP-002', name: 'Suresh Jadhav', dept: 'CUT', designation: 'Cutting Assistant', structure: 'Helper / Daily Wage', type: 'DAILY_WAGE', join: '2023-01-15' },
    { code: 'EMP-003', name: 'Anil Kadam', dept: 'FUS', designation: 'Fusing Operator', structure: 'Operator', type: 'PERMANENT', join: '2021-03-02' },
    { code: 'EMP-004', name: 'Farhan Ansari', dept: 'STI', designation: 'Line Supervisor', structure: 'Supervisor', type: 'PERMANENT', join: '2018-08-20' },
    { code: 'EMP-005', name: 'Kavita More', dept: 'LINEQC', designation: 'Line QC Checker', structure: 'Operator', type: 'PERMANENT', join: '2022-11-07' },
    { code: 'EMP-006', name: 'Imran Shaikh', dept: 'KAJ', designation: 'Kaj Button Operator', structure: 'Operator', type: 'PERMANENT', join: '2020-02-11' },
    { code: 'EMP-007', name: 'Sunita Gaikwad', dept: 'FINQC', designation: 'Final QC In-charge', structure: 'Staff Grade B', type: 'PERMANENT', join: '2017-05-04' },
    { code: 'EMP-008', name: 'Deepak Bhoir', dept: 'FIN', designation: 'Pressing Hand', structure: 'Helper / Daily Wage', type: 'DAILY_WAGE', join: '2024-04-01' },
    { code: 'EMP-009', name: 'Pooja Sawant', dept: 'PKG', designation: 'Packing In-charge', structure: 'Operator', type: 'PERMANENT', join: '2021-09-13' },
    { code: 'EMP-010', name: 'Ravi Yadav', dept: 'PKG', designation: 'Packing Helper', structure: 'Helper / Daily Wage', type: 'DAILY_WAGE', join: '2024-10-01' },
    { code: 'EMP-011', name: 'Nitin Chavan', dept: 'STR', designation: 'Store Keeper', structure: 'Staff Grade B', type: 'PERMANENT', join: '2019-01-21' },
    { code: 'EMP-012', name: 'Meena Joshi', dept: 'ACC', designation: 'Accounts Executive', structure: 'Staff Grade B', type: 'PERMANENT', join: '2020-07-06' },
    { code: 'EMP-013', name: 'Vijay Salvi', dept: 'ACC', designation: 'Accounts Manager', structure: 'Staff Grade A', type: 'PERMANENT', join: '2016-04-18' },
    { code: 'EMP-014', name: 'Asha Pawar', dept: 'HR', designation: 'HR & Admin Executive', structure: 'Staff Grade B', type: 'PERMANENT', join: '2022-02-14' },
    { code: 'EMP-015', name: 'Sandeep Rane', dept: 'JW', designation: 'Job Work Coordinator', structure: 'Supervisor', type: 'CONTRACT', join: '2023-06-01' },
  ]

  for (const [i, e] of employeeData.entries()) {
    await prisma.employee.upsert({
      where: { employeeCode: e.code },
      update: { name: e.name },
      create: {
        employeeCode: e.code,
        name: e.name,
        email: `${e.code.toLowerCase()}@example.com`,
        phone: `98200 5${String(1000 + i)}`,
        departmentId: dept(e.dept),
        designation: e.designation,
        employmentType: e.type as never,
        joinDate: new Date(e.join),
        salaryStructureId: structures.get(e.structure)!,
        pan: `DEMOC${5000 + i}D`,
        aadhaar: `9999 ${String(1000 + i)} ${String(2000 + i)}`,
        bankName: 'Demo Bank of India',
        bankAccount: `0000${String(200000 + i)}`,
        bankIFSC: 'DEMO0000001',
        pfNumber: `MH/BHW/${String(90000 + i)}`,
        esicNumber: `31${String(10000000 + i)}`,
      },
    })
  }

  // ───────────────────────────────────────────────────────────────────────
  // Chart of accounts
  //
  // Grouped the way a Tally-trained accountant expects to find them, because
  // that is who will be reading this on day one.
  // ───────────────────────────────────────────────────────────────────────
  const accountData: Array<[string, string, string, number]> = [
    // code, name, group, opening balance
    ['1000', 'Cash in Hand', 'Current Assets', 45000],
    ['1010', 'Bank — Current Account', 'Bank Accounts', 1850000],
    ['1020', 'Bank — Cash Credit', 'Bank OD / CC', -2400000],
    ['1100', 'Sundry Debtors', 'Current Assets', 6820000],
    ['1200', 'Closing Stock — Fabric', 'Current Assets', 3150000],
    ['1210', 'Closing Stock — Trims & Accessories', 'Current Assets', 480000],
    ['1220', 'Closing Stock — Work in Progress', 'Current Assets', 1240000],
    ['1230', 'Closing Stock — Finished Goods', 'Current Assets', 2760000],
    ['1300', 'GST Input Credit', 'Duties & Taxes', 385000],
    ['1400', 'Advance to Suppliers', 'Loans & Advances', 260000],
    ['1500', 'Plant & Machinery', 'Fixed Assets', 5600000],
    ['1510', 'Furniture & Fixtures', 'Fixed Assets', 340000],
    ['1520', 'Computers & Software', 'Fixed Assets', 410000],

    ['2000', 'Sundry Creditors', 'Current Liabilities', -4180000],
    ['2100', 'GST Output Payable', 'Duties & Taxes', -520000],
    ['2110', 'TDS Payable', 'Duties & Taxes', -86000],
    ['2200', 'Salary & Wages Payable', 'Current Liabilities', -740000],
    ['2210', 'PF Payable', 'Current Liabilities', -96000],
    ['2220', 'ESIC Payable', 'Current Liabilities', -31000],
    ['2300', 'Partners Capital', 'Capital Account', -8000000],

    ['3000', 'Sales — Domestic', 'Sales Accounts', 0],
    ['3010', 'Sales — Export', 'Sales Accounts', 0],
    ['3020', 'Job Work Income', 'Sales Accounts', 0],
    ['3030', 'Sales — VHAGAR', 'Sales Accounts', 0],

    ['4000', 'Purchase — Fabric', 'Purchase Accounts', 0],
    ['4010', 'Purchase — Trims & Accessories', 'Purchase Accounts', 0],
    ['4020', 'Purchase — Packing Material', 'Purchase Accounts', 0],
    ['4100', 'Job Work Charges Paid', 'Direct Expenses', 0],
    ['4110', 'Wages — Factory', 'Direct Expenses', 0],
    ['4120', 'Power & Fuel', 'Direct Expenses', 0],
    ['4130', 'Freight Inward', 'Direct Expenses', 0],

    ['5000', 'Salaries — Staff', 'Indirect Expenses', 0],
    ['5010', 'Rent', 'Indirect Expenses', 0],
    ['5020', 'Brokerage & Commission', 'Indirect Expenses', 0],
    ['5030', 'Freight Outward', 'Indirect Expenses', 0],
    ['5040', 'Telephone & Internet', 'Indirect Expenses', 0],
    ['5050', 'Repairs & Maintenance', 'Indirect Expenses', 0],
    ['5060', 'Bank Charges & Interest', 'Indirect Expenses', 0],
    ['5070', 'Professional Fees', 'Indirect Expenses', 0],
    ['5080', 'Depreciation', 'Indirect Expenses', 0],
  ]

  for (const [code, name, groupType, opening] of accountData) {
    await prisma.account.upsert({
      where: { code },
      update: { name, groupType },
      create: { code, name, groupType, openingBalance: opening },
    })
  }

  const bankData = [
    { accountName: 'LD Cotton Mills — Current', bankName: 'Demo Bank of India', accountNumber: '000012345678', ifscCode: 'DEMO0000001', branch: 'Bhiwandi', accountType: 'CURRENT', opening: 1850000 },
    { accountName: 'LD Cotton Mills — Cash Credit', bankName: 'Demo Bank of India', accountNumber: '000098765432', ifscCode: 'DEMO0000001', branch: 'Bhiwandi', accountType: 'CC', opening: -2400000 },
    { accountName: 'LD Cotton Mills — Export EEFC', bankName: 'Demo Overseas Bank', accountNumber: '000055554444', ifscCode: 'DEMO0000002', branch: 'Fort, Mumbai', accountType: 'CURRENT', opening: 620000 },
  ]

  for (const b of bankData) {
    const existing = await prisma.bankAccount.findFirst({
      where: { accountNumber: b.accountNumber },
    })
    if (existing) continue
    await prisma.bankAccount.create({
      data: {
        accountName: b.accountName,
        bankName: b.bankName,
        accountNumber: b.accountNumber,
        ifscCode: b.ifscCode,
        branch: b.branch,
        accountType: b.accountType,
        openingBalance: b.opening,
        currentBalance: b.opening,
      },
    })
  }

  // ───────────────────────────────────────────────────────────────────────
  // Opening stock
  //
  // Normally the only thing allowed to write a stock movement is
  // stock.service.ts in the API. This is the one exception, and it is the
  // trivial case: one OPENING row per item and store, against an empty ledger.
  // There is no prior balance to go negative, nothing to average against, and
  // the closing balance is the quantity itself — so none of the rules the
  // service exists to enforce have anything to do here.
  //
  // Quantities are set as a multiple of each item's reorder level so the stock
  // screen shows a believable spread: most items comfortable, a few sitting
  // below their reorder mark, which is what a real godown looks like on any
  // given Tuesday.
  // ───────────────────────────────────────────────────────────────────────
  const stores = new Map(
    (await prisma.warehouse.findMany()).map((w) => [w.code, w.id] as const),
  )

  /** Which store an item naturally lives in. */
  const storeFor = (cat: string): string => {
    if (cat === 'Fabric') return stores.get('WH-FAB')!
    if (cat === 'Finished Goods') return stores.get('WH-FG')!
    return stores.get('WH-TRIM')!
  }

  // A fixed pattern rather than Math.random, so two people running the seed get
  // the same demo and can talk about the same numbers.
  const SPREAD = [2.4, 0.8, 3.1, 1.6, 0.45, 2.0, 1.2, 4.0, 0.7, 1.9, 2.7, 0.35]

  await prisma.stockLedger.deleteMany()

  const openingDate = new Date()
  openingDate.setMonth(openingDate.getMonth() - 1, 1)

  let stockRows = 0
  for (const [i, it] of itemData.entries()) {
    // Finished goods are made, not opened with — they arrive from production.
    if (it.type === 'FINISHED_GOOD') continue

    const base = it.reorder ?? 100
    const qty = Math.round(base * SPREAD[i % SPREAD.length])
    if (qty <= 0) continue

    const warehouseId = storeFor(it.cat)

    await prisma.stockLedger.create({
      data: {
        itemId: items.get(it.code)!,
        warehouseId,
        transactionType: 'OPENING',
        referenceType: 'OPENING_STOCK',
        referenceId: 'DEMO-OPENING',
        ownership: 'OWNED',
        inQty: qty,
        outQty: 0,
        closingStock: qty,
        unitRate: it.rate,
        transactionDate: openingDate,
        notes: 'Opening stock',
      },
    })
    stockRows += 1
  }

  // One line of somebody else's fabric, because job work is real at LD and a
  // demo where every roll in the godown is ours would hide the distinction the
  // ledger exists to make.
  await prisma.stockLedger.create({
    data: {
      itemId: items.get('FAB-PC-001')!,
      warehouseId: stores.get('WH-JW')!,
      transactionType: 'OPENING',
      referenceType: 'OPENING_STOCK',
      referenceId: 'DEMO-OPENING',
      ownership: 'CUSTOMER_OWNED',
      ownerCustomerId: customers.get('CUS-011')!,
      inQty: 1800,
      outQty: 0,
      closingStock: 1800,
      // Not ours, so it carries no value to us. It is in our godown and on our
      // insurance, but it is not on our balance sheet.
      unitRate: 0,
      transactionDate: openingDate,
      notes: 'Fabric sent in by Vasant Apparel for job work',
    },
  })
  stockRows += 1

  // ───────────────────────────────────────────────────────────────────────
  const counts = {
    customers: await prisma.customer.count(),
    suppliers: await prisma.supplier.count(),
    brokers: await prisma.broker.count(),
    items: await prisma.item.count(),
    styles: await prisma.style.count(),
    boms: await prisma.bOM.count(),
    routings: await prisma.routing.count(),
    warehouses: await prisma.warehouse.count(),
    workstations: await prisma.workstation.count(),
    machines: await prisma.machine.count(),
    employees: await prisma.employee.count(),
    ledgerAccounts: await prisma.account.count(),
    bankAccounts: await prisma.bankAccount.count(),
    departments: await prisma.department.count(),
    operations: await prisma.operation.count(),
    sizes: await prisma.size.count(),
    openingStockLines: stockRows,
  }

  console.log('')
  console.log('✅ Demo masters ready:')
  for (const [k, v] of Object.entries(counts)) {
    console.log(`   ${String(v).padStart(4)}  ${k}`)
  }
  console.log('')
  console.log('   Masters and opening stock only. No orders or invoices —')
  console.log('   those come from the modules as they are built.')
}

main()
  .catch((e) => {
    console.error(e)
    process.exit(1)
  })
  .finally(() => prisma.$disconnect())
