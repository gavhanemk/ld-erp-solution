/**
 * Builds every report to disk so real Excel can be asked about them.
 *
 * This exists because a library round-trip proves nothing. Every workbook in
 * this folder was read back with a second library, which reported all five
 * charts present and every relationship resolving — and Excel then refused to
 * open the file at all. The fault was one wrong namespace on a `.rels` root,
 * and nothing short of Excel itself would have found it.
 *
 *     pnpm --filter api exec tsx src/reports/verify.ts ./out
 *
 * Then ask Excel, which is the only opinion that counts:
 *
 *     $xl = New-Object -ComObject Excel.Application
 *     $xl.Visible = $false
 *     $xl.DisplayAlerts = $false
 *     foreach ($f in Get-ChildItem .\out\*.xlsx) {
 *       try {
 *         $wb = $xl.Workbooks.Open($f.FullName, 0, $true)
 *         $n = 0; foreach ($ws in $wb.Worksheets) { $n += $ws.ChartObjects().Count }
 *         "{0,-28} charts={1}" -f $f.Name, $n
 *         $wb.Close($false)
 *       } catch { "{0,-28} REFUSED" -f $f.Name }
 *     }
 *     $xl.Quit()
 *
 * Zero charts on a file this script reported as carrying six is not "no data".
 * It is Excel having repaired the workbook by deleting the drawing, after
 * which the file opens looking merely empty. A REFUSED line is the same
 * illness caught one stage earlier.
 *
 * `--synthetic` adds a workbook holding one of every chart kind, because the
 * mill's own data will not always have enough of each to draw them — a panel
 * with one category becomes a card by design, and then nothing is tested.
 */
import { writeFileSync } from 'node:fs'
import { prisma } from '@ld-erp/database'
import { REPORTS } from './registry'
import { ROW_CAP, type ReportDefinition, type ReportResult } from './types'
import { periodLabel } from './definitions/shared'
import { buildWorkbook } from './workbook'

const SYNTHETIC: { def: ReportDefinition; result: ReportResult } = {
  def: {
    id: 'every-chart-kind',
    module: 'purchase',
    title: 'Every Chart Kind',
    description: 'One of each shape the engine can emit, so Excel can be asked about all of them.',
    filters: [],
    columns: [
      { key: 'month', label: 'Month', type: 'text' },
      { key: 'supplier', label: 'Supplier', type: 'text' },
      { key: 'qty', label: 'Quantity', type: 'qty', unit: 'mtr', total: 'sum' },
      { key: 'value', label: 'Value', type: 'money', total: 'sum' },
      { key: 'when', label: 'Booked', type: 'date' },
    ],
    // A supplier name here carries a comma and an ampersand, so the pivot's
    // shared items exercise XML escaping on the axis as well as in the rows.
    pivot: {
      rows: 'supplier',
      values: ['value', 'qty'],
      slicers: ['month'],
      note: 'Every supplier against every month, to prove the cache indexes both.',
    },
    run: async () => ({ rows: [], analysis: { kpis: [], panels: [], insights: [], caveats: [] } }),
  },
  result: (() => {
    const months = ['Apr 26', 'May 26', 'Jun 26', 'Jul 26', 'Aug 26', 'Sep 26']
    // A comma and an ampersand in a supplier name, because CSV quoting and XML
    // escaping both have to survive one.
    const suppliers = [
      'Ambika Stitching, Unit 2',
      'Shah & Co',
      'Nandi Textiles',
      'Vega Trims',
      'Rangoli Dyers',
    ]
    return {
      totalRows: 12_000,
      rows: months.flatMap((m, i) =>
        suppliers.map((s, j) => ({
          month: m,
          supplier: s,
          qty: 1200 + i * 140 + j * 37,
          value: 480000 + i * 95000 + j * 21000,
          when: new Date(2026, 3 + i, 5 + j),
        }))
      ),
      analysis: {
        headline: '₹1,42,80,000 billed across 30 bills from 5 suppliers.',
        kpis: [
          { label: 'Taxable value', value: 14280000, format: 'money', basis: 'across 30 bills' },
          {
            label: 'GST charged',
            value: 2570400,
            format: 'money',
            basis: 'on 30 bills carrying tax',
          },
          {
            label: 'Average bill',
            value: 476000,
            format: 'money',
            basis: '₹1,42,80,000 over 30 bills',
          },
          {
            label: 'Cannot be computed',
            value: null,
            format: 'percent',
            basis: 'nothing to divide by — this must print a dash, never a nought',
            tone: 'warn',
          },
        ],
        trend: {
          title: 'Taxable value booked, by month',
          valueLabel: 'Taxable value',
          format: 'money',
          compareLabel: 'Last year',
          points: months.map((m, i) => ({
            label: m,
            value: 1800000 + i * 260000,
            // The first point has no comparison, so the dashed line must open
            // with a gap rather than with a nought.
            compare: i === 0 ? null : 1500000 + i * 190000,
          })),
        },
        panels: [
          {
            title: 'Biggest suppliers by value billed',
            question: 'ranking',
            format: 'money',
            points: suppliers.map((s, i) => ({ label: s, value: 3400000 - i * 520000 })),
            note: 'Bill totals including tax.',
          },
          {
            title: 'Where the goods were taxed',
            question: 'composition',
            format: 'money',
            points: [
              { label: 'Within the state (CGST+SGST)', value: 9100000 },
              { label: 'Other state (IGST)', value: 3900000 },
              { label: 'No GST charged', value: 1280000 },
            ],
          },
          {
            // Colour by meaning. Read back off the finished file, these must
            // come out amber, blue and green — not three shades of one hue.
            title: 'Bills by settlement',
            question: 'comparison',
            format: 'integer',
            points: [
              { label: 'Unpaid', value: 11, tone: 'warn' },
              { label: 'Part paid', value: 7, tone: 'info' },
              { label: 'Paid', value: 12, tone: 'good' },
            ],
          },
          {
            title: 'Ordered, received, still due',
            question: 'funnel',
            format: 'qty',
            points: [
              { label: 'Ordered', value: 7500, tone: 'info' },
              { label: 'Received', value: 4800, tone: 'good' },
              { label: 'Still due', value: 2700, tone: 'warn' },
            ],
          },
          {
            // A split whose parts DO mean something, so it takes the tones
            // rather than the categorical three.
            title: 'Settled against still owed',
            question: 'split',
            format: 'money',
            points: suppliers.map((s, i) => ({ label: s, value: 3400000 - i * 520000 })),
            series: [
              {
                name: 'Paid',
                tone: 'good',
                values: suppliers.map((_, i) => 2000000 - i * 300000),
              },
              {
                name: 'Still owed',
                tone: 'warn',
                values: suppliers.map((_, i) => 1400000 - i * 220000),
              },
            ],
          },
          {
            title: 'What is owed, by age',
            question: 'ageing',
            format: 'money',
            points: [
              { label: 'Not yet due', value: 2100000 },
              { label: '1-30 days', value: 1450000 },
              { label: '31-60 days', value: 620000 },
              { label: 'Over 90 days', value: 310000, exception: true },
            ],
          },
          {
            title: 'What each supplier billed, split by tax',
            question: 'split',
            format: 'money',
            points: suppliers.map((s, i) => ({ label: s, value: 3400000 - i * 520000 })),
            series: [
              { name: 'CGST+SGST', values: suppliers.map((_, i) => 2100000 - i * 310000) },
              { name: 'IGST', values: suppliers.map((_, i) => 900000 - i * 150000) },
              // A hole in the middle segment, which must leave a gap in the
              // stack rather than closing it up as though it were nought.
              { name: 'No GST', values: suppliers.map((_, i) => (i === 2 ? null : 400000 - i * 60000)) },
            ],
          },
          {
            title: 'How few suppliers make up the spend',
            question: 'pareto',
            format: 'money',
            points: suppliers.map((s, i) => ({ label: s, value: 3400000 - i * 520000 })),
            note: 'The line is the share reached by that supplier and every bigger one.',
          },
          {
            // One point now draws a single bar rather than degrading to a
            // text row. This is the case that made every Dashboard on a new
            // mill come out with no chart on it at all.
            title: 'One category only — draws as a single bar',
            question: 'ranking',
            format: 'money',
            points: [{ label: 'Only supplier', value: 145000 }],
          },
          {
            title: 'Two slices only — falls back from doughnut to bars',
            question: 'composition',
            format: 'money',
            points: [
              { label: 'Within the state', value: 9100000 },
              { label: 'Other state', value: 3900000 },
            ],
          },
          {
            title: 'Nothing at all — the only shape that stays a card',
            question: 'ranking',
            format: 'money',
            points: [],
          },
        ],
        matrix: {
          title: 'Value by supplier and month',
          rowLabel: 'Supplier',
          columns: months,
          format: 'money',
          rows: suppliers.map((s, j) => ({
            label: s,
            // One hole, which must print as a dash.
            values: months.map((_, i) =>
              i === 2 && j === 1 ? null : 320000 + i * 41000 + j * 17000
            ),
          })),
        },
        insights: [
          'Ambika Stitching accounts for ₹34,00,000 of the ₹1,42,80,000 billed — 24% of the period.',
          '₹39,00,000 of taxable value came from outside the state and carries IGST.',
        ],
        caveats: [
          'Booked on the bill date, not the date goods arrived.',
          'Input credit shown is what the supplier charged. Reconcile against GSTR-2B before filing.',
        ],
      },
    }
  })(),
}

async function main() {
  const out = process.argv[2]
  if (!out) {
    console.error('usage: tsx src/reports/verify.ts <output-directory> [--synthetic]')
    process.exit(1)
  }

  for (const def of REPORTS) {
    const params = {}
    const result = await prisma.$transaction(
      async (tx) => def.run({ prisma, tx, params, rowCap: ROW_CAP }),
      { timeout: 120_000, maxWait: 15_000 }
    )
    const { buffer, chartCount, pivotCount, partial } = await buildWorkbook({
      def,
      result,
      params,
      runBy: 'Verification',
      periodLabel: periodLabel(params),
    })
    writeFileSync(`${out}/${def.id}.xlsx`, buffer)
    // The same rule the builder uses. Left at "two or more points" this
    // printed "charts=6 panels=6 (0 chartable)" on one line, which reads as a
    // failure report about a workbook that was fine.
    const chartable = result.analysis.panels.filter((p) => p.points.length > 0).length
    console.log(
      `${def.id.padEnd(26)} rows=${String(result.rows.length).padEnd(6)}` +
        `charts=${chartCount} pivots=${pivotCount}  panels=${result.analysis.panels.length} (${chartable} chartable)  ` +
        `partial=${partial}  ${(buffer.length / 1024).toFixed(0)}KB`
    )
  }

  if (process.argv.includes('--synthetic')) {
    const { buffer, chartCount, pivotCount } = await buildWorkbook({
      def: SYNTHETIC.def,
      result: SYNTHETIC.result,
      params: { from: '2026-04-01', to: '2026-09-22' },
      runBy: 'Verification',
      periodLabel: '1 Apr 2026 to 22 Sep 2026',
    })
    writeFileSync(`${out}/every-chart-kind.xlsx`, buffer)
    console.log(
      `${'every-chart-kind'.padEnd(26)} rows=${String(SYNTHETIC.result.rows.length).padEnd(6)}` +
        `charts=${chartCount} pivots=${pivotCount}  (line, bar, doughnut, column, bar)  ${(buffer.length / 1024).toFixed(0)}KB`
    )
  }

  await prisma.$disconnect()
}

void main()
