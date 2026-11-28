/**
 * Decision 5, in numbers: what valuing each brand's share of a stock balance
 * at its own moving average does to the company's figures, against one
 * average per balance as today.
 *
 * The same movements are valued both ways with the stock writer's own
 * arithmetic (stock.service recordMovement): stock comes in at its rate and
 * leaves at value ÷ quantity, rounded to the paisa.
 *
 *   pooled     one average per balance (item, store, owner, size, grade);
 *              brand shares tracked by quantity only, each valued at it
 *   per share  each brand's share, and central stock, keeps its own average;
 *              an earmark or a move between brands goes out of one share and
 *              into the other at the giving share's average
 *
 * For each scenario it prints, both ways: what was issued (the cost of what
 * production and sales took), the closing stock, the company's profit and
 * each brand's, and checks the identities that must hold — opening +
 * purchases = issued + closing, the brands plus central = the company, and
 * earmarks and store transfers never change the company's stock value.
 *
 * Pure arithmetic: it reads and writes no database. From apps/api:
 *
 *   npx tsx ../../tools/valuation-impact.ts            tables
 *   npx tsx ../../tools/valuation-impact.ts --json     the figures, for the plan page
 */

type Share = string // 'central' or a brand
type Kind = 'BUY' | 'EARMARK' | 'MOVE' | 'ISSUE' | 'RETURN' | 'TRANSFER'
interface Step {
  kind: Kind
  label: string
  qty: number
  /** BUY: the rate it came in at. A RETURN comes back at the rate of the share's last issue. */
  rate?: number
  /** BUY, ISSUE, RETURN: the share; EARMARK/MOVE: the giving share. */
  share: Share
  /** EARMARK, MOVE: the receiving share. */
  to?: Share
  /** TRANSFER: the stores; every other step happens in the first store. */
  store?: string
  toStore?: string
  /** ISSUE: what the brand sells the goods made from it for (for its profit). */
  sales?: number
}

const r2 = (n: number) => Math.round(n * 100) / 100
const r3 = (n: number) => Math.round(n * 1000) / 1000
const STORE = 'Fabric store'

/** A balance as the stock writer keeps it: quantity and value, read back as a running average. */
class Pot {
  qty = 0
  value = 0
  get avg() {
    return this.qty > 0 ? r2(this.value / this.qty) : 0
  }
  in(qty: number, rate: number) {
    this.qty = r3(this.qty + qty)
    this.value = r2(this.value + qty * r2(rate))
  }
  out(qty: number) {
    if (qty > this.qty + 1e-9) throw new Error(`only ${this.qty} on hand, ${qty} asked`)
    const rate = this.avg
    this.qty = r3(this.qty - qty)
    this.value = r2(this.value - qty * rate)
    return r2(qty * rate)
  }
}

interface Result {
  issued: number
  issuedBy: Record<Share, number>
  closing: number
  closingBy: Record<Share, number>
  purchases: number
  /** Value handed between brands by earmarks and moves (+ received, − given). */
  movedBy: Record<Share, number>
  sales: Record<Share, number>
  earmarkChangedCompanyValue: boolean
  transferChangedCompanyValue: boolean
}

function run(steps: Step[], method: 'pooled' | 'per-share'): Result {
  // Per share: one pot per store and share. Pooled: one pot per store, and shares by quantity.
  const pots = new Map<string, Pot>()
  const pot = (store: string, share: Share) => {
    const k = method === 'pooled' ? store : `${store}|${share}`
    if (!pots.has(k)) pots.set(k, new Pot())
    return pots.get(k)!
  }
  const shareQty = new Map<string, number>()
  const addQty = (store: string, share: Share, q: number) => shareQty.set(`${store}|${share}`, r3((shareQty.get(`${store}|${share}`) ?? 0) + q))
  const companyValue = () => r2([...pots.values()].reduce((t, p) => t + p.value, 0))

  const lastIssueRate = new Map<string, number>()
  const res: Result = { issued: 0, issuedBy: {}, closing: 0, closingBy: {}, purchases: 0, movedBy: {}, sales: {}, earmarkChangedCompanyValue: false, transferChangedCompanyValue: false }
  const add = (m: Record<Share, number>, s: Share, v: number) => (m[s] = r2((m[s] ?? 0) + v))

  for (const st of steps) {
    const store = st.store ?? STORE
    if ((shareQty.get(`${store}|${st.share}`) ?? 0) < st.qty - 1e-9 && st.kind !== 'BUY' && st.kind !== 'RETURN') {
      throw new Error(`${st.label}: ${st.share} has only ${shareQty.get(`${store}|${st.share}`) ?? 0}`)
    }
    if (st.kind === 'BUY' || st.kind === 'RETURN') {
      // A return from the floor comes back at what it was issued at, as the stock writer does.
      const rate = st.kind === 'BUY' ? st.rate! : (lastIssueRate.get(`${store}|${st.share}`) ?? 0)
      pot(store, st.share).in(st.qty, rate)
      addQty(store, st.share, st.qty)
      if (st.kind === 'BUY') res.purchases = r2(res.purchases + st.qty * rate)
      else add(res.issuedBy, st.share, -r2(st.qty * rate))
    } else if (st.kind === 'ISSUE') {
      // Per share: at the share's own average. Pooled: at the balance's average.
      lastIssueRate.set(`${store}|${st.share}`, pot(store, st.share).avg)
      const v = pot(store, st.share).out(st.qty)
      addQty(store, st.share, -st.qty)
      add(res.issuedBy, st.share, v)
      if (st.sales) add(res.sales, st.share, st.sales)
    } else if (st.kind === 'EARMARK' || st.kind === 'MOVE') {
      const before = companyValue()
      if (method === 'per-share') {
        const giving = pot(store, st.share)
        const rate = giving.avg
        const v = giving.out(st.qty)
        pot(store, st.to!).in(st.qty, rate)
        add(res.movedBy, st.share, -v)
        add(res.movedBy, st.to!, v)
      } else {
        // Pooled: the quantity changes hands; its value is the one average either side.
        const v = r2(st.qty * pot(store, st.share).avg)
        add(res.movedBy, st.share, -v)
        add(res.movedBy, st.to!, v)
      }
      addQty(store, st.share, -st.qty)
      addQty(store, st.to!, st.qty)
      if (Math.abs(companyValue() - before) > 0.005) res.earmarkChangedCompanyValue = true
    } else if (st.kind === 'TRANSFER') {
      const before = companyValue()
      const from = pot(store, st.share)
      const rate = from.avg
      from.out(st.qty)
      pot(st.toStore!, st.share).in(st.qty, rate)
      addQty(store, st.share, -st.qty)
      addQty(st.toStore!, st.share, st.qty)
      if (Math.abs(companyValue() - before) > 0.005) res.transferChangedCompanyValue = true
    }
  }
  res.issued = r2(Object.values(res.issuedBy).reduce((t, v) => t + v, 0))
  res.closing = companyValue()
  // Each share's closing value: its own pot per share; pooled, its quantity at its store's average.
  for (const [k, q] of shareQty) {
    const [store, share] = k.split('|')
    if (q <= 0) continue
    add(res.closingBy, share, method === 'per-share' ? pot(store, share).value : r2(q * pot(store, share).avg))
  }
  return res
}

const SCENARIOS: Array<{ id: string; title: string; story: string; steps: Step[] }> = [
  {
    id: 'same-price',
    title: '1. Everything bought centrally at one price',
    story: 'The mill buys 1,000 m at ₹100 for no brand. LD Cotton Mills and Stich Code each take some for their MOs.',
    steps: [
      { kind: 'BUY', label: 'Central purchase', share: 'central', qty: 1000, rate: 100 },
      { kind: 'EARMARK', label: 'Earmark for LD Cotton Mills', share: 'central', to: 'LD Cotton Mills', qty: 350 },
      { kind: 'EARMARK', label: 'Earmark for Stich Code', share: 'central', to: 'Stich Code', qty: 250 },
      { kind: 'ISSUE', label: 'LD Cotton Mills MO', share: 'LD Cotton Mills', qty: 300, sales: 60000 },
      { kind: 'ISSUE', label: 'Stich Code MO', share: 'Stich Code', qty: 200, sales: 45000 },
    ],
  },
  {
    id: 'brand-price',
    title: '2. A brand buys the same cloth at its own price',
    story: 'Central stock is 1,000 m at ₹100. Stich Code orders 500 m at ₹130 on its own PO. LD Cotton Mills earmarks 400 m of central stock. Each brand issues to its MO.',
    steps: [
      { kind: 'BUY', label: 'Central purchase', share: 'central', qty: 1000, rate: 100 },
      { kind: 'BUY', label: 'Stich Code PO', share: 'Stich Code', qty: 500, rate: 130 },
      { kind: 'EARMARK', label: 'Earmark for LD Cotton Mills', share: 'central', to: 'LD Cotton Mills', qty: 400 },
      { kind: 'ISSUE', label: 'LD Cotton Mills MO', share: 'LD Cotton Mills', qty: 300, sales: 60000 },
      { kind: 'ISSUE', label: 'Stich Code MO', share: 'Stich Code', qty: 400, sales: 90000 },
    ],
  },
  {
    id: 'brand-price-all-used',
    title: '3. The same, carried on until every metre is used',
    story: 'Scenario 2, then the rest goes to production: central stock to LD Cotton Mills through its MO, and each brand uses up its own.',
    steps: [
      { kind: 'BUY', label: 'Central purchase', share: 'central', qty: 1000, rate: 100 },
      { kind: 'BUY', label: 'Stich Code PO', share: 'Stich Code', qty: 500, rate: 130 },
      { kind: 'EARMARK', label: 'Earmark for LD Cotton Mills', share: 'central', to: 'LD Cotton Mills', qty: 400 },
      { kind: 'ISSUE', label: 'LD Cotton Mills MO', share: 'LD Cotton Mills', qty: 300, sales: 60000 },
      { kind: 'ISSUE', label: 'Stich Code MO', share: 'Stich Code', qty: 400, sales: 90000 },
      { kind: 'EARMARK', label: 'Automatic: central to LD Cotton Mills for its next MO', share: 'central', to: 'LD Cotton Mills', qty: 600 },
      { kind: 'ISSUE', label: 'LD Cotton Mills next MO', share: 'LD Cotton Mills', qty: 700, sales: 140000 },
      { kind: 'ISSUE', label: 'Stich Code next MO', share: 'Stich Code', qty: 100, sales: 22500 },
    ],
  },
  {
    id: 'price-change',
    title: '4. The price changes after an earmark',
    story: 'LD Cotton Mills earmarks 500 m bought at ₹100. The mill then buys 1,000 m more at ₹120 for central stock. LD Cotton Mills issues its 500 m.',
    steps: [
      { kind: 'BUY', label: 'Central purchase', share: 'central', qty: 1000, rate: 100 },
      { kind: 'EARMARK', label: 'Earmark for LD Cotton Mills', share: 'central', to: 'LD Cotton Mills', qty: 500 },
      { kind: 'BUY', label: 'Central purchase at the new price', share: 'central', qty: 1000, rate: 120 },
      { kind: 'ISSUE', label: 'LD Cotton Mills MO', share: 'LD Cotton Mills', qty: 500, sales: 80000 },
    ],
  },
  {
    id: 'move-and-transfer',
    title: '5. A move between brands, a store transfer and a return from the floor',
    story: 'Stich Code bought 300 m at ₹130 and LD Cotton Mills earmarked 300 m of central stock at ₹100. Stich Code hands 100 m to LD Cotton Mills (approved), LD Cotton Mills moves 200 m to the cutting floor, issues 150 m there and returns 20 m unused.',
    steps: [
      { kind: 'BUY', label: 'Central purchase', share: 'central', qty: 600, rate: 100 },
      { kind: 'BUY', label: 'Stich Code PO', share: 'Stich Code', qty: 300, rate: 130 },
      { kind: 'EARMARK', label: 'Earmark for LD Cotton Mills', share: 'central', to: 'LD Cotton Mills', qty: 300 },
      { kind: 'MOVE', label: 'Stich Code → LD Cotton Mills (approved)', share: 'Stich Code', to: 'LD Cotton Mills', qty: 100 },
      { kind: 'TRANSFER', label: 'LD Cotton Mills: store → cutting floor', share: 'LD Cotton Mills', qty: 200, toStore: 'Cutting floor' },
      { kind: 'ISSUE', label: 'LD Cotton Mills MO, on the floor', share: 'LD Cotton Mills', qty: 150, store: 'Cutting floor', sales: 40000 },
      { kind: 'RETURN', label: 'Unused back from the MO', share: 'LD Cotton Mills', qty: 20, store: 'Cutting floor' },
    ],
  },
]

function profitBy(res: Result) {
  const brands = [...new Set([...Object.keys(res.sales), ...Object.keys(res.issuedBy)])].filter((b) => b !== 'central')
  return Object.fromEntries(brands.map((b) => [b, r2((res.sales[b] ?? 0) - (res.issuedBy[b] ?? 0))]))
}

const json = process.argv.includes('--json')
const out: unknown[] = []
let problems = 0
const money = (n: number) => `₹${n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

for (const sc of SCENARIOS) {
  const P = run(sc.steps, 'pooled')
  const S = run(sc.steps, 'per-share')
  const sales = r2(Object.values(S.sales).reduce((t, v) => t + v, 0))
  const checks = [
    { what: 'purchases = issued + closing (one average per balance)', ok: Math.abs(P.purchases - (P.issued + P.closing)) < 0.01 },
    { what: 'purchases = issued + closing (each share its own average)', ok: Math.abs(S.purchases - (S.issued + S.closing)) < 0.01 },
    { what: 'the brands plus central = the company (closing stock)', ok: Math.abs(Object.values(S.closingBy).reduce((t, v) => t + v, 0) - S.closing) < 0.01 },
    { what: 'earmarks and moves never change the company’s stock value', ok: !S.earmarkChangedCompanyValue && !P.earmarkChangedCompanyValue },
    { what: 'store transfers never change the company’s stock value', ok: !S.transferChangedCompanyValue && !P.transferChangedCompanyValue },
    { what: 'what moves between brands nets to nothing', ok: Math.abs(Object.values(S.movedBy).reduce((t, v) => t + v, 0)) < 0.01 },
  ]
  problems += checks.filter((c) => !c.ok).length
  const brands = [...new Set([...Object.keys(S.closingBy), ...Object.keys(S.issuedBy), ...Object.keys(P.closingBy)])].sort((a, b) => (a === 'central' ? 1 : b === 'central' ? -1 : a.localeCompare(b)))
  const row = {
    id: sc.id,
    title: sc.title,
    story: sc.story,
    purchases: S.purchases,
    sales,
    pooled: { issued: P.issued, closing: P.closing, profit: r2(sales - P.issued), issuedBy: P.issuedBy, closingBy: P.closingBy, profitBy: profitBy(P) },
    perShare: { issued: S.issued, closing: S.closing, profit: r2(sales - S.issued), issuedBy: S.issuedBy, closingBy: S.closingBy, profitBy: profitBy(S), movedBy: S.movedBy },
    difference: { issued: r2(S.issued - P.issued), closing: r2(S.closing - P.closing), profit: r2(sales - S.issued - (sales - P.issued)) },
    brands,
    checks,
  }
  out.push(row)
  if (!json) {
    console.log(`\n${sc.title}\n${sc.story}`)
    console.log(`  Purchases ${money(S.purchases)}   Sales of what was made ${money(sales)}`)
    console.log(`  ${''.padEnd(34)}${'one average'.padStart(16)}${'own average'.padStart(16)}${'difference'.padStart(14)}`)
    const line = (label: string, a: number, b: number) => console.log(`  ${label.padEnd(34)}${money(a).padStart(16)}${money(b).padStart(16)}${money(r2(b - a)).padStart(14)}`)
    line('Issued to production (COGS)', P.issued, S.issued)
    line('Closing stock', P.closing, S.closing)
    line('Company profit', sales - P.issued, sales - S.issued)
    for (const b of brands) {
      if (b === 'central') line('  closing stock, central', P.closingBy[b] ?? 0, S.closingBy[b] ?? 0)
      else {
        line(`  ${b}: material cost`, P.issuedBy[b] ?? 0, S.issuedBy[b] ?? 0)
        line(`  ${b}: closing stock`, P.closingBy[b] ?? 0, S.closingBy[b] ?? 0)
      }
    }
    for (const c of checks) console.log(`  ${c.ok ? 'PASS' : 'FAIL'}  ${c.what}`)
  }
}
if (json) console.log(JSON.stringify(out, null, 1))
else console.log(`\n${problems ? `${problems} identities failed` : 'Every identity holds in every scenario.'}`)
process.exitCode = problems ? 1 : 0
