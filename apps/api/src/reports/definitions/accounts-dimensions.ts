import type { ReportDefinition, ReportParams } from '../types'
import { dateRangeFilters, periodLabel } from './shared'
import { SOURCE_LABEL, type SourceType } from '../../services/accounts/posting.service'

const r2 = (n: number) => Math.round(n * 100) / 100

/**
 * The period a report covers, as the books keep days: a voucher is dated at
 * the start of its day, so the range runs from the first day to the end of
 * the last, in India.
 */
function period(params: ReportParams) {
  const from = params.from ? new Date(`${params.from}T00:00:00+05:30`) : new Date('2000-01-01T00:00:00Z')
  const to = params.to ? new Date(`${params.to}T23:59:59.999+05:30`) : new Date('2100-01-01T00:00:00Z')
  return { from, to }
}

/**
 * Each ledger group's standard group at the top of its tree — Sales Accounts,
 * Direct Expenses, Purchase Accounts — worked out in the query.
 */
const TOP_GROUP = `
  WITH RECURSIVE tree AS (
    SELECT id, id AS top, "parentId", "systemKey" AS key FROM ld_erp.ledger_groups WHERE "parentId" IS NULL
    UNION ALL
    SELECT g.id, t.top, g."parentId", t.key FROM ld_erp.ledger_groups g JOIN tree t ON g."parentId" = t.id
  )`

/** What a voucher's source is called, or what kind of voucher it is when typed in Accounts. */
const sourceWords = (sourceType: string | null, kind: string) =>
  sourceType ? (SOURCE_LABEL[sourceType as SourceType] ?? sourceType) : `${kind.charAt(0)}${kind.slice(1).toLowerCase().replace(/_/g, ' ')} voucher`

/**
 * Income and expense lines that do not say whose they are.
 *
 * Income should carry both a brand (profit centre) and a department (cost
 * centre); an expense a department — its brand may be blank, which means it
 * is shared and waits for the monthly allocation. Purchases of stock are left
 * out: stock bought for the store belongs to no brand until it moves to one.
 * Each line says what it lacks and how to put it right; the summary gathers
 * them by ledger, since a ledger's own default often settles a whole row.
 */
export const unallocatedEntries: ReportDefinition = {
  id: 'unallocated-entries',
  module: 'accounts',
  title: 'Unallocated Entries',
  description:
    'Income lines without a brand or a department, and expense lines without a department — what the profit-centre and cost-centre reports cannot place, and how to put each right.',
  filters: [
    ...dateRangeFilters,
    {
      key: 'missing',
      label: 'Missing',
      type: 'select',
      emptyLabel: 'A brand or a department',
      options: [
        { value: 'brand', label: 'A brand (income)' },
        { value: 'department', label: 'A department' },
      ],
    },
  ],
  columns: [
    { key: 'date', label: 'Date', type: 'date', width: 12 },
    { key: 'voucherNo', label: 'Voucher', type: 'text', width: 16 },
    { key: 'source', label: 'From', type: 'text', width: 18 },
    { key: 'ledger', label: 'Ledger', type: 'text', width: 28 },
    { key: 'group', label: 'Group', type: 'text', width: 18 },
    { key: 'amount', label: 'Amount (Dr +, Cr −)', type: 'money', total: 'sum' },
    { key: 'brand', label: 'Brand', type: 'text', width: 16 },
    { key: 'department', label: 'Department', type: 'text', width: 18 },
    {
      key: 'missing',
      label: 'Missing',
      type: 'badge',
      width: 14,
      badges: { BRAND: 'Brand', DEPARTMENT: 'Department', BOTH: 'Both' },
      badgeTones: { BRAND: 'warn', DEPARTMENT: 'warn', BOTH: 'bad' },
    },
    { key: 'narration', label: 'Narration', type: 'text', width: 40 },
    { key: 'action', label: 'What to do', type: 'text', width: 48 },
  ],
  summary: {
    title: 'Unallocated, by ledger',
    columns: ['ledger', 'group', 'missing', 'amount'],
    by: 'amount',
    limit: 20,
  },

  async run({ tx, params, rowCap }) {
    const { from, to } = period(params)
    const want = (params.missing as string | undefined) || ''
    const rows = await tx.$queryRawUnsafe<
      Array<{
        date: Date
        voucherNo: string
        kind: string
        sourceType: string | null
        ledger: string
        ledgerHasDefault: boolean
        grp: string
        top: string | null
        nature: string
        amount: number
        brand: string | null
        department: string | null
        narration: string | null
        legacy: boolean
      }>
    >(
      `${TOP_GROUP}
       SELECT v.date, v."voucherNo", v.kind::text AS kind, v."sourceType", led.name AS ledger,
              (led."costCentreId" IS NOT NULL OR led."departmentId" IS NOT NULL) AS "ledgerHasDefault",
              g.name AS grp, t.key AS top, g.nature::text AS nature,
              (l.debit - l.credit)::float8 AS amount, cc.name AS brand, d.name AS department,
              COALESCE(l.narration, v.narration) AS narration,
              (v."legacyImport" OR COALESCE(pi."legacyImport", false)) AS legacy
         FROM ld_erp.acc_voucher_lines l
         JOIN ld_erp.acc_vouchers v ON v.id = l."voucherId"
         LEFT JOIN ld_erp.purchase_invoices pi ON v."sourceType" = 'PURCHASE_BILL' AND pi.id = v."sourceId"
         JOIN ld_erp.ledgers led ON led.id = l."ledgerId"
         JOIN ld_erp.ledger_groups g ON g.id = led."groupId"
         JOIN tree t ON t.id = g.id
         LEFT JOIN ld_erp.cost_centres cc ON cc.id = l."costCentreId"
         LEFT JOIN ld_erp.departments d ON d.id = l."departmentId"
        WHERE v.status = 'POSTED' AND v.date >= $1 AND v.date <= $2
          AND g.nature::text IN ('INCOME', 'EXPENSE')
          AND COALESCE(t.key, '') <> 'PURCHASE_ACCOUNTS'
          AND COALESCE(led."systemKey", '') <> 'ROUND_OFF'
          AND (
            (g.nature::text = 'INCOME' AND (l."costCentreId" IS NULL OR l."departmentId" IS NULL))
            OR (g.nature::text = 'EXPENSE' AND l."departmentId" IS NULL)
          )
        ORDER BY v.date, v."voucherNo"`,
      from,
      to,
    )
    const shaped = rows
      .map((r) => {
        const income = r.nature === 'INCOME'
        const noBrand = income && !r.brand
        const noDept = !r.department
        const missing = noBrand && noDept ? 'BOTH' : noBrand ? 'BRAND' : 'DEPARTMENT'
        const action = r.legacy
          ? `Brought in from the old books without departments (a legacy import). Give ${r.ledger} a usual ${noBrand && noDept ? 'brand and department' : noBrand ? 'brand' : 'department'} and post again, or leave it as imported.`
          : r.sourceType
          ? `Give ${r.ledger} a usual ${noBrand && noDept ? 'brand and department' : noBrand ? 'brand' : 'department'} in Chart of Accounts, then post again (Accounts → Books → Post again)${r.sourceType === 'PURCHASE_BILL' ? ', or pick it on the bill line' : ''}.`
          : `Open the voucher and pick the ${noBrand && noDept ? 'brand and department' : noBrand ? 'brand' : 'department'} on this line.`
        return {
          date: r.date,
          voucherNo: r.voucherNo,
          source: sourceWords(r.sourceType, r.kind),
          ledger: r.ledger,
          group: r.grp,
          amount: r2(r.amount),
          brand: r.brand ?? (income ? '' : 'Shared'),
          department: r.department ?? '',
          missing,
          narration: r.narration ?? '',
          action,
        }
      })
      .filter((r) => (want === 'brand' ? r.missing !== 'DEPARTMENT' : want === 'department' ? r.missing !== 'BRAND' : true))
    const total = r2(shaped.reduce((s, r) => s + Math.abs(r.amount), 0))
    const ledgers = new Set(shaped.map((r) => r.ledger)).size
    return {
      rows: shaped.slice(0, rowCap),
      ...(shaped.length > rowCap ? { totalRows: shaped.length } : {}),
      analysis: {
        headline: shaped.length
          ? `${shaped.length} ${shaped.length === 1 ? 'line does' : 'lines do'} not say whose ${shaped.length === 1 ? 'it is' : 'they are'}, on ${ledgers} ${ledgers === 1 ? 'ledger' : 'ledgers'}: ${periodLabel(params)}.`
          : `Every income and expense line says whose it is: ${periodLabel(params)}.`,
        kpis: [
          { label: 'Lines', value: shaped.length, format: 'integer', basis: 'income without a brand or department; expenses without a department', tone: shaped.length ? 'warn' : 'good' },
          { label: 'Amount', value: total, format: 'money', basis: 'their debits and credits, ignoring sign' },
          { label: 'Ledgers', value: ledgers, format: 'integer', basis: 'a usual brand or department on each would settle most' },
        ],
        panels: [],
        insights: shaped.length ? ['A ledger with a usual brand and department fills every line of it that its document leaves blank, once posted again.'] : [],
        caveats: [
          'Purchases of stock are left out: stock bought for the store is central until it moves to a brand.',
          'An expense with no brand is shared, not missing: it waits for the monthly allocation.',
          'Bank, party and tax lines never carry a brand or a department, so they are never listed.',
          'Round off (the paise on a bill) is left out; give the Round Off ledger a usual department if it should carry one.',
        ],
      },
    }
  },
}

/**
 * What each department (cost centre) spent, by ledger and by brand.
 *
 * Every expense line of the period, gathered by department, ledger and brand.
 * A department rolls up under its parent where the Departments master gives
 * one. Lines with no department are listed too, as "No department", so the
 * report adds up to the expenses in the books.
 */
export const costCentreExpenses: ReportDefinition = {
  id: 'cost-centre-expenses',
  module: 'accounts',
  title: 'Cost Centre Expenses',
  description: 'Expenses by department (cost centre), ledger and brand for a period, adding up to the expenses in the books.',
  filters: [...dateRangeFilters],
  columns: [
    { key: 'parent', label: 'Rolls Up To', type: 'text', width: 18 },
    { key: 'department', label: 'Department', type: 'text', width: 20 },
    { key: 'ledger', label: 'Ledger', type: 'text', width: 28 },
    { key: 'group', label: 'Group', type: 'text', width: 18 },
    { key: 'brand', label: 'Brand', type: 'text', width: 16 },
    { key: 'lines', label: 'Lines', type: 'integer', total: 'sum' },
    { key: 'amount', label: 'Amount', type: 'money', total: 'sum' },
  ],
  summary: {
    title: 'Spent, by department',
    columns: ['department', 'ledger', 'brand', 'amount'],
    by: 'amount',
    limit: 20,
  },
  pivot: undefined,

  async run({ tx, params, rowCap }) {
    const { from, to } = period(params)
    const rows = await tx.$queryRawUnsafe<
      Array<{ parent: string | null; department: string | null; ledger: string; grp: string; brand: string | null; lines: number; amount: number }>
    >(
      `SELECT pd.name AS parent, d.name AS department, led.name AS ledger, g.name AS grp, cc.name AS brand,
              COUNT(*)::int AS lines, SUM(l.debit - l.credit)::float8 AS amount
         FROM ld_erp.acc_voucher_lines l
         JOIN ld_erp.acc_vouchers v ON v.id = l."voucherId"
         JOIN ld_erp.ledgers led ON led.id = l."ledgerId"
         JOIN ld_erp.ledger_groups g ON g.id = led."groupId"
         LEFT JOIN ld_erp.departments d ON d.id = l."departmentId"
         LEFT JOIN ld_erp.departments pd ON pd.id = d."parentId"
         LEFT JOIN ld_erp.cost_centres cc ON cc.id = l."costCentreId"
        WHERE v.status = 'POSTED' AND v.date >= $1 AND v.date <= $2 AND g.nature::text = 'EXPENSE'
        GROUP BY pd.name, d.name, led.name, g.name, cc.name
       HAVING SUM(l.debit - l.credit) <> 0
        ORDER BY COALESCE(pd.name, d.name, 'zzz'), d.name NULLS LAST, SUM(l.debit - l.credit) DESC`,
      from,
      to,
    )
    const shaped = rows.map((r) => ({
      parent: r.parent ?? '',
      department: r.department ?? 'No department',
      ledger: r.ledger,
      group: r.grp,
      brand: r.brand ?? 'Shared',
      lines: r.lines,
      amount: r2(r.amount),
    }))
    const total = r2(shaped.reduce((s, r) => s + r.amount, 0))
    const none = r2(shaped.filter((r) => r.department === 'No department').reduce((s, r) => s + r.amount, 0))
    const byDept = new Map<string, number>()
    for (const r of shaped) byDept.set(r.department, r2((byDept.get(r.department) ?? 0) + r.amount))
    const top = [...byDept.entries()].sort((a, b) => b[1] - a[1])
    return {
      rows: shaped.slice(0, rowCap),
      ...(shaped.length > rowCap ? { totalRows: shaped.length } : {}),
      analysis: {
        headline: shaped.length
          ? `₹${total.toLocaleString('en-IN')} spent: ${periodLabel(params)}${top[0] ? `; most by ${top[0][0]}` : ''}.`
          : `No expenses: ${periodLabel(params)}.`,
        kpis: [
          { label: 'Expenses', value: total, format: 'money', basis: 'every expense line in the books for the period' },
          { label: 'Departments', value: [...byDept.keys()].filter((d) => d !== 'No department').length, format: 'integer', basis: 'that carry any of it' },
          { label: 'No department', value: none, format: 'money', basis: 'see Unallocated Entries', tone: none ? 'warn' : 'good' },
        ],
        panels: top.length
          ? [{ title: 'Spent by department', question: 'ranking', format: 'money', points: top.slice(0, 12).map(([label, value]) => ({ label, value, ...(label === 'No department' ? { tone: 'warn' as const } : {}) })) }]
          : [],
        insights: [],
        caveats: [
          'Purchases of stock are included under their Purchase ledgers; stock still in the store is in the closing stock, not spent.',
          'An expense with no brand shows as Shared: it waits for the monthly allocation.',
        ],
      },
    }
  },
}

/**
 * Each month's split of shared expenses between the brands, run by run.
 *
 * One row per brand's share of a shared amount: the rule that split it, on
 * what basis, at what percentage. Only posted runs count in the books; a
 * reversed run is listed as reversed, and a run not yet posted as it stands.
 */
export const expenseAllocationRegister: ReportDefinition = {
  id: 'expense-allocation-register',
  module: 'accounts',
  title: 'Expense Allocation Register',
  description: 'Shared expenses split between the brands, month by month: each run, rule, ledger, department and brand share.',
  filters: [...dateRangeFilters],
  columns: [
    { key: 'month', label: 'Month', type: 'text', width: 10 },
    { key: 'runNumber', label: 'Run', type: 'text', width: 14 },
    { key: 'status', label: 'Status', type: 'text', width: 10 },
    { key: 'rule', label: 'Rule', type: 'text', width: 22 },
    { key: 'basis', label: 'Basis', type: 'text', width: 18 },
    { key: 'ledger', label: 'Ledger', type: 'text', width: 24 },
    { key: 'department', label: 'Department', type: 'text', width: 18 },
    { key: 'brand', label: 'Brand', type: 'text', width: 16 },
    { key: 'sharedAmount', label: 'Shared Amount', type: 'money' },
    { key: 'percent', label: 'Share %', type: 'percent', total: 'none' },
    { key: 'amount', label: 'Brand’s Part', type: 'money', total: 'sum' },
  ],
  summary: {
    title: 'Allocated, by brand',
    columns: ['month', 'runNumber', 'brand', 'amount'],
    by: 'amount',
    limit: 20,
  },
  pivot: undefined,

  async run({ tx, params, rowCap }) {
    const fromMonth = params.from ? String(params.from).slice(0, 7) : '0000-00'
    const toMonth = params.to ? String(params.to).slice(0, 7) : '9999-99'
    const BASIS: Record<string, string> = {
      REVENUE: 'Sales',
      PRODUCTION_QTY: 'Pieces produced',
      MATERIAL_CONSUMPTION: 'Material consumed',
      MACHINE_HOURS: 'Machine hours',
      FIXED_PERCENT: 'Fixed %',
      MANUAL: 'Typed %',
    }
    const rows = await tx.$queryRawUnsafe<
      Array<{ period: string; runNumber: string; status: string; rule: string; basis: string; ledger: string; department: string | null; brand: string; sharedAmount: number; percent: number; amount: number }>
    >(
      `SELECT r.period, r."runNumber", r.status::text AS status, ru.name AS rule, ru.basis::text AS basis, led.name AS ledger, d.name AS department,
              cc.name AS brand, l."sharedAmount"::float8 AS "sharedAmount", l.percent::float8 AS percent, l.amount::float8 AS amount
         FROM ld_erp.acc_allocation_run_lines l
         JOIN ld_erp.acc_allocation_runs r ON r.id = l."runId"
         JOIN ld_erp.acc_allocation_rules ru ON ru.id = l."ruleId"
         JOIN ld_erp.ledgers led ON led.id = l."ledgerId"
         LEFT JOIN ld_erp.departments d ON d.id = l."departmentId"
         JOIN ld_erp.cost_centres cc ON cc.id = l."costCentreId"
        WHERE r.status::text <> 'DISCARDED' AND r.period >= $1 AND r.period <= $2
        ORDER BY r.period DESC, r."runNumber" DESC, led.name, d.name NULLS FIRST, l.amount DESC`,
      fromMonth,
      toMonth,
    )
    const STATUS: Record<string, string> = { DRAFT: 'Draft', APPROVED: 'Approved', POSTED: 'Posted', REVERSED: 'Reversed' }
    const shaped = rows.map((r) => ({
      month: r.period,
      runNumber: r.runNumber,
      status: STATUS[r.status] ?? r.status,
      rule: r.rule,
      basis: BASIS[r.basis] ?? r.basis,
      ledger: r.ledger,
      department: r.department ?? 'No department',
      brand: r.brand,
      sharedAmount: r2(r.sharedAmount),
      percent: Math.round(r.percent * 10000) / 1000000,
      amount: r2(r.amount),
    }))
    const posted = shaped.filter((r) => r.status === 'Posted')
    const total = r2(posted.reduce((s, r) => s + r.amount, 0))
    const byBrand = new Map<string, number>()
    for (const r of posted) byBrand.set(r.brand, r2((byBrand.get(r.brand) ?? 0) + r.amount))
    const top = [...byBrand.entries()].sort((a, b) => b[1] - a[1])
    const waiting = new Set(shaped.filter((r) => r.status === 'Draft' || r.status === 'Approved').map((r) => r.runNumber)).size
    return {
      rows: shaped.slice(0, rowCap),
      ...(shaped.length > rowCap ? { totalRows: shaped.length } : {}),
      analysis: {
        headline: posted.length
          ? `₹${total.toLocaleString('en-IN')} of shared expenses split between the brands: ${periodLabel(params)}.`
          : `No posted split of shared expenses: ${periodLabel(params)}.`,
        kpis: [
          { label: 'Split (posted)', value: total, format: 'money', basis: 'posted runs; reversed and unposted runs left out' },
          { label: 'Posted runs', value: new Set(posted.map((r) => r.runNumber)).size, format: 'integer', basis: 'one a month at most' },
          { label: 'Waiting', value: waiting, format: 'integer', basis: 'runs drafted or approved, not yet posted', tone: waiting ? 'warn' : 'good' },
        ],
        panels: top.length ? [{ title: 'Allocated by brand', question: 'ranking', format: 'money', points: top.slice(0, 12).map(([label, value]) => ({ label, value })) }] : [],
        insights: [],
        caveats: [
          'Splitting moves shared expenses onto the brands only: each ledger’s and each department’s total, and the company’s, stay as booked.',
          'A reversed run is undone in the books by its own reversing journal (its number with -R).',
        ],
      },
    }
  },
}
