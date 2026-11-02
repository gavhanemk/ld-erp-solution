import { prisma } from '@ld-erp/database'
import type { LedgerNature, LedgerParty, Prisma } from '@prisma/client'
import { financialYearOf } from '../../lib/docNumber'

/**
 * The chart of accounts: the groups every Indian set of books starts with,
 * the ledgers the posting rules reach for, and one ledger for every party and
 * bank account the rest of the ERP already knows.
 *
 * The groups are the ones an accountant who has used SAB or Tally expects to
 * find, under the same names, so a trial balance from the old books lines up
 * against this one without a mapping sheet. Each carries a systemKey: the
 * posting rules find a group or a ledger by its key, never by its name, so
 * renaming "Sales" to "Sales – Garments" breaks nothing.
 *
 * Nothing here is seeded by a script. `ensureChart` makes whatever is missing
 * the first time Accounts is opened on a database — live, demo or test — and
 * is cheap to run again: it only ever adds.
 */

type Tx = Prisma.TransactionClient

interface GroupSpec {
  key: string
  name: string
  nature: LedgerNature
  parent?: string
  /** Above gross profit, in the trading account. */
  gp?: boolean
}

/** In the order they are listed, top level first, then what sits under each. */
export const STANDARD_GROUPS: GroupSpec[] = [
  { key: 'CAPITAL', name: 'Capital Account', nature: 'LIABILITY' },
  { key: 'RESERVES', name: 'Reserves & Surplus', nature: 'LIABILITY', parent: 'CAPITAL' },
  { key: 'LOANS', name: 'Loans (Liability)', nature: 'LIABILITY' },
  { key: 'SECURED_LOANS', name: 'Secured Loans', nature: 'LIABILITY', parent: 'LOANS' },
  { key: 'UNSECURED_LOANS', name: 'Unsecured Loans', nature: 'LIABILITY', parent: 'LOANS' },
  { key: 'BANK_OD', name: 'Bank OD & CC Accounts', nature: 'LIABILITY', parent: 'LOANS' },
  { key: 'CURRENT_LIABILITIES', name: 'Current Liabilities', nature: 'LIABILITY' },
  { key: 'DUTIES_TAXES', name: 'Duties & Taxes', nature: 'LIABILITY', parent: 'CURRENT_LIABILITIES' },
  { key: 'PROVISIONS', name: 'Provisions', nature: 'LIABILITY', parent: 'CURRENT_LIABILITIES' },
  { key: 'SUNDRY_CREDITORS', name: 'Sundry Creditors', nature: 'LIABILITY', parent: 'CURRENT_LIABILITIES' },
  { key: 'BROKERS', name: 'Brokers', nature: 'LIABILITY', parent: 'SUNDRY_CREDITORS' },
  { key: 'CONTRACTORS', name: 'Contractors', nature: 'LIABILITY', parent: 'SUNDRY_CREDITORS' },
  { key: 'SUSPENSE', name: 'Suspense Account', nature: 'LIABILITY' },
  { key: 'FIXED_ASSETS', name: 'Fixed Assets', nature: 'ASSET' },
  { key: 'INVESTMENTS', name: 'Investments', nature: 'ASSET' },
  { key: 'CURRENT_ASSETS', name: 'Current Assets', nature: 'ASSET' },
  { key: 'BANK_ACCOUNTS', name: 'Bank Accounts', nature: 'ASSET', parent: 'CURRENT_ASSETS' },
  { key: 'CASH_IN_HAND', name: 'Cash-in-Hand', nature: 'ASSET', parent: 'CURRENT_ASSETS' },
  { key: 'DEPOSITS', name: 'Deposits (Asset)', nature: 'ASSET', parent: 'CURRENT_ASSETS' },
  { key: 'LOANS_ADVANCES', name: 'Loans & Advances (Asset)', nature: 'ASSET', parent: 'CURRENT_ASSETS' },
  { key: 'STOCK_IN_HAND', name: 'Stock-in-Hand', nature: 'ASSET', parent: 'CURRENT_ASSETS' },
  { key: 'SUNDRY_DEBTORS', name: 'Sundry Debtors', nature: 'ASSET', parent: 'CURRENT_ASSETS' },
  { key: 'MISC_EXPENSES', name: 'Misc. Expenses (Asset)', nature: 'ASSET' },
  { key: 'SALES_ACCOUNTS', name: 'Sales Accounts', nature: 'INCOME', gp: true },
  { key: 'DIRECT_INCOMES', name: 'Direct Incomes', nature: 'INCOME', gp: true },
  { key: 'INDIRECT_INCOMES', name: 'Indirect Incomes', nature: 'INCOME' },
  { key: 'PURCHASE_ACCOUNTS', name: 'Purchase Accounts', nature: 'EXPENSE', gp: true },
  { key: 'DIRECT_EXPENSES', name: 'Direct Expenses', nature: 'EXPENSE', gp: true },
  { key: 'INDIRECT_EXPENSES', name: 'Indirect Expenses', nature: 'EXPENSE' },
]

/** The ledgers a posting rule or a report reaches for by key. */
export const SYSTEM_LEDGERS: Array<{ key: string; name: string; group: string }> = [
  { key: 'CASH', name: 'Cash', group: 'CASH_IN_HAND' },
  // Where each year's profit is carried. Its balance on the balance sheet is
  // its opening plus every closed year's profit, worked out — no closing entry.
  { key: 'PROFIT_LOSS', name: 'Profit & Loss A/c', group: 'RESERVES' },
  { key: 'SALES', name: 'Sales', group: 'SALES_ACCOUNTS' },
  { key: 'SALES_JOB_WORK', name: 'Job Work Income', group: 'SALES_ACCOUNTS' },
  { key: 'PURCHASE', name: 'Purchases', group: 'PURCHASE_ACCOUNTS' },
  { key: 'OUTPUT_CGST', name: 'Output CGST', group: 'DUTIES_TAXES' },
  { key: 'OUTPUT_SGST', name: 'Output SGST', group: 'DUTIES_TAXES' },
  { key: 'OUTPUT_IGST', name: 'Output IGST', group: 'DUTIES_TAXES' },
  { key: 'INPUT_CGST', name: 'Input CGST', group: 'DUTIES_TAXES' },
  { key: 'INPUT_SGST', name: 'Input SGST', group: 'DUTIES_TAXES' },
  { key: 'INPUT_IGST', name: 'Input IGST', group: 'DUTIES_TAXES' },
  { key: 'TDS_RECEIVABLE', name: 'TDS Receivable', group: 'LOANS_ADVANCES' },
  { key: 'ROUND_OFF', name: 'Round Off', group: 'INDIRECT_EXPENSES' },
  { key: 'BANK_CHARGES', name: 'Bank Charges', group: 'INDIRECT_EXPENSES' },
]

/** The voucher types typed in Accounts, and the number series each is issued from. */
export const VOUCHER_SERIES = {
  PAYMENT: 'PV',
  RECEIPT: 'RV',
  CONTRA: 'CV',
  JOURNAL: 'JV',
} as const

/** Where a party's ledger is filed, and whether its bills are kept one by one. */
const PARTY_HOME: Record<LedgerParty, { group: string; billWise: boolean }> = {
  CUSTOMER: { group: 'SUNDRY_DEBTORS', billWise: true },
  SUPPLIER: { group: 'SUNDRY_CREDITORS', billWise: true },
  BROKER: { group: 'BROKERS', billWise: true },
  // Paid by the piece, week by week, rather than bill by bill.
  CONTRACTOR: { group: 'CONTRACTORS', billWise: false },
  BANK: { group: 'BANK_ACCOUNTS', billWise: false },
}

/**
 * A ledger name nobody else has. Two masters can share a name — LD Silk Mills
 * sells to us and buys from us — and a ledger name has to be unique to be
 * picked by typing it, so the second one carries its code.
 */
function freeName(wanted: string, code: string | null, taken: Set<string>): string {
  const plain = wanted.trim()
  const lower = (s: string) => s.toLowerCase()
  if (!taken.has(lower(plain))) return plain
  const withCode = code ? `${plain} (${code})` : plain
  if (!taken.has(lower(withCode))) return withCode
  for (let i = 2; ; i++) {
    const n = `${withCode} ${i}`
    if (!taken.has(lower(n))) return n
  }
}

/** "HDFC Bank A/c 4471" — the bank and the end of the number, as a cashier says it. */
export function bankLedgerName(b: { bankName: string; accountNumber: string; accountName: string }) {
  const tail = b.accountNumber.replace(/\s+/g, '').slice(-4)
  return tail ? `${b.bankName.trim()} A/c ${tail}` : b.accountName.trim()
}

async function ensureGroups(tx: Tx): Promise<Map<string, string>> {
  const existing = await tx.ledgerGroup.findMany({ select: { id: true, systemKey: true, name: true } })
  const byKey = new Map(existing.filter((g) => g.systemKey).map((g) => [g.systemKey as string, g.id]))
  const names = new Set(existing.map((g) => g.name.toLowerCase()))
  let order = 0
  for (const g of STANDARD_GROUPS) {
    order += 10
    if (byKey.has(g.key)) continue
    const parentId = g.parent ? byKey.get(g.parent) ?? null : null
    const name = names.has(g.name.toLowerCase()) ? `${g.name} (standard)` : g.name
    const made = await tx.ledgerGroup.create({
      data: { name, systemKey: g.key, nature: g.nature, affectsGrossProfit: !!g.gp, parentId, sortOrder: order },
      select: { id: true },
    })
    byKey.set(g.key, made.id)
    names.add(name.toLowerCase())
  }
  return byKey
}

async function ensureSystemLedgers(tx: Tx, groups: Map<string, string>) {
  const existing = await tx.ledger.findMany({ select: { systemKey: true, name: true } })
  const keys = new Set(existing.map((l) => l.systemKey).filter(Boolean))
  const taken = new Set(existing.map((l) => l.name.toLowerCase()))
  for (const l of SYSTEM_LEDGERS) {
    if (keys.has(l.key)) continue
    const name = freeName(l.name, null, taken)
    await tx.ledger.create({ data: { name, systemKey: l.key, groupId: groups.get(l.group)! } })
    taken.add(name.toLowerCase())
  }
}

/**
 * One ledger for every customer, supplier, broker, contractor and bank
 * account that has none yet; and a party renamed in its master is renamed
 * here too, where the new name is free. A party switched off in its master is
 * switched off here — its balance stays, it just stops being offered.
 */
async function syncPartyLedgers(tx: Tx, groups: Map<string, string>) {
  const [ledgers, customers, suppliers, brokers, contractors, banks] = await Promise.all([
    tx.ledger.findMany({
      select: { id: true, name: true, isActive: true, partyType: true, customerId: true, supplierId: true, brokerId: true, contractorId: true, bankAccountId: true },
    }),
    tx.customer.findMany({ select: { id: true, code: true, name: true, isActive: true } }),
    tx.supplier.findMany({ select: { id: true, code: true, name: true, isActive: true } }),
    tx.broker.findMany({ select: { id: true, code: true, name: true, isActive: true } }),
    tx.contractor.findMany({ select: { id: true, code: true, name: true, isActive: true } }),
    tx.bankAccount.findMany({ select: { id: true, bankName: true, accountNumber: true, accountName: true, accountType: true, isActive: true } }),
  ])
  const taken = new Set(ledgers.map((l) => l.name.toLowerCase()))

  type Party = { type: LedgerParty; id: string; code: string | null; name: string; isActive: boolean; group?: string }
  const parties: Party[] = [
    ...customers.map((c) => ({ type: 'CUSTOMER' as const, id: c.id, code: c.code, name: c.name, isActive: c.isActive })),
    ...suppliers.map((s) => ({ type: 'SUPPLIER' as const, id: s.id, code: s.code, name: s.name, isActive: s.isActive })),
    ...brokers.map((b) => ({ type: 'BROKER' as const, id: b.id, code: b.code, name: b.name, isActive: b.isActive })),
    ...contractors.map((c) => ({ type: 'CONTRACTOR' as const, id: c.id, code: c.code, name: c.name, isActive: c.isActive })),
    ...banks.map((b) => ({
      type: 'BANK' as const,
      id: b.id,
      code: null,
      name: bankLedgerName(b),
      isActive: b.isActive,
      // A cash-credit or overdraft account is a loan the bank has given, not money we hold.
      group: ['CC', 'OD'].includes((b.accountType ?? '').toUpperCase()) ? 'BANK_OD' : undefined,
    })),
  ]

  const field: Record<LedgerParty, 'customerId' | 'supplierId' | 'brokerId' | 'contractorId' | 'bankAccountId'> = {
    CUSTOMER: 'customerId',
    SUPPLIER: 'supplierId',
    BROKER: 'brokerId',
    CONTRACTOR: 'contractorId',
    BANK: 'bankAccountId',
  }
  const mine = new Map(ledgers.filter((l) => l.partyType).map((l) => [`${l.partyType}:${l[field[l.partyType as LedgerParty]]}`, l]))

  for (const p of parties) {
    const have = mine.get(`${p.type}:${p.id}`)
    if (!have) {
      const home = PARTY_HOME[p.type]
      const name = freeName(p.name, p.code, taken)
      await tx.ledger.create({
        data: {
          name,
          groupId: groups.get(p.group ?? home.group)!,
          partyType: p.type,
          billWise: home.billWise,
          isActive: p.isActive,
          [field[p.type]]: p.id,
        },
      })
      taken.add(name.toLowerCase())
      continue
    }
    const data: Prisma.LedgerUpdateInput = {}
    if (have.isActive !== p.isActive) data.isActive = p.isActive
    const wanted = p.name.trim()
    const startsRight = have.name === wanted || have.name.startsWith(`${wanted} (`)
    if (!startsRight && !taken.has(wanted.toLowerCase())) {
      taken.delete(have.name.toLowerCase())
      data.name = wanted
      taken.add(wanted.toLowerCase())
    }
    if (Object.keys(data).length) await tx.ledger.update({ where: { id: have.id }, data })
  }
}

/** One cost centre per brand, so profit can be read brand by brand. */
async function syncCostCentres(tx: Tx) {
  const [brands, centres] = await Promise.all([
    tx.brand.findMany({ select: { id: true, name: true, isActive: true } }),
    tx.costCentre.findMany({ select: { id: true, name: true, brandId: true, isActive: true } }),
  ])
  const taken = new Set(centres.map((c) => c.name.toLowerCase()))
  for (const b of brands) {
    const have = centres.find((c) => c.brandId === b.id)
    if (!have) {
      const name = freeName(b.name, null, taken)
      await tx.costCentre.create({ data: { name, brandId: b.id, isActive: b.isActive } })
      taken.add(name.toLowerCase())
    } else if (have.isActive !== b.isActive) {
      await tx.costCentre.update({ where: { id: have.id }, data: { isActive: b.isActive } })
    }
  }
}

/**
 * A number series for each voucher type typed here, for the year we are in.
 * Vouchers are internal documents, so unlike an invoice series nobody has to
 * decide a prefix before the first one can be saved; the prefix can be
 * changed in Settings like any other.
 */
async function ensureVoucherSeries(tx: Tx) {
  const company = await tx.company.findFirst({ select: { id: true, fyStartMonth: true } })
  if (!company) return
  const fy = financialYearOf(new Date(), company.fyStartMonth ?? 4)
  for (const docType of Object.values(VOUCHER_SERIES)) {
    const have = await tx.numberSeries.findFirst({ where: { companyId: company.id, docType }, select: { id: true } })
    if (have) continue
    await tx.numberSeries.create({
      data: { companyId: company.id, docType, prefix: docType, separator: '-', financialYear: fy, lastNumber: 0, padding: 4 },
    })
  }
}

let running: Promise<void> | null = null
let doneAt = 0
/** Parties added elsewhere get their ledger within this long of Accounts being opened. */
const FRESH_FOR_MS = 20_000

/**
 * Makes sure the chart is complete. Run before Accounts answers anything that
 * lists ledgers; one run at a time, and not again for a few seconds after.
 */
export async function ensureChart(force = false): Promise<void> {
  if (running) return running
  if (!force && Date.now() - doneAt < FRESH_FOR_MS) return
  running = (async () => {
    try {
      await prisma.$transaction(
        async (tx) => {
          const groups = await ensureGroups(tx)
          await ensureSystemLedgers(tx, groups)
          await syncPartyLedgers(tx, groups)
          await syncCostCentres(tx)
          await ensureVoucherSeries(tx)
        },
        { timeout: 60_000 },
      )
      doneAt = Date.now()
    } finally {
      running = null
    }
  })()
  return running
}

/** The id of a system ledger, for the posting rules. */
export async function systemLedgerId(tx: Tx, key: string): Promise<string> {
  const l = await tx.ledger.findUnique({ where: { systemKey: key }, select: { id: true } })
  if (l) return l.id
  await ensureChart(true)
  const again = await tx.ledger.findUnique({ where: { systemKey: key }, select: { id: true } })
  if (!again) throw new Error(`The ${key} ledger is missing from the chart of accounts`)
  return again.id
}
