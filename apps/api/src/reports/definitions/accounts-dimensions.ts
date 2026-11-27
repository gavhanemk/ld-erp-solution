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
      }>
    >(
      `${TOP_GROUP}
       SELECT v.date, v."voucherNo", v.kind::text AS kind, v."sourceType", led.name AS ledger,
              (led."costCentreId" IS NOT NULL OR led."departmentId" IS NOT NULL) AS "ledgerHasDefault",
              g.name AS grp, t.key AS top, g.nature::text AS nature,
              (l.debit - l.credit)::float8 AS amount, cc.name AS brand, d.name AS department,
              COALESCE(l.narration, v.narration) AS narration
         FROM ld_erp.acc_voucher_lines l
         JOIN ld_erp.acc_vouchers v ON v.id = l."voucherId"
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
        const action = r.sourceType
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
