'use client'

import { Fragment, useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { AlertCircle, ChevronDown, ChevronRight, Loader2, Package, RefreshCw, Save, Undo2 } from 'lucide-react'
import { api, apiErrorMessage, can } from '@/lib/api'
import { ExportButton } from '@/components/tables/ExportButton'
import { downloadRows, type ExportColumn, type ExportFormat } from '@/lib/export'
import { StepInput } from '@/components/ui/StepInput'
import { day, fyStartOf, inr, todayIst, type BooksSummary } from '@/components/accounts/books'

type BlockKey = 'SALES_ACCOUNTS' | 'DIRECT_INCOMES' | 'PURCHASE_ACCOUNTS' | 'DIRECT_EXPENSES' | 'INDIRECT_INCOMES' | 'INDIRECT_EXPENSES'
interface Line {
  id: string
  name: string
  group: string
  amount: number
  centres: Record<string, number>
  departments?: Record<string, number>
}
interface Block {
  key: BlockKey
  title: string
  total: number
  centres: Record<string, number>
  departments?: Record<string, number>
  lines: Line[]
}
interface Stock {
  day: string
  value: number
  source: 'books' | 'set' | 'inventory'
  inventory: number | null
  set: { value: number; notes: string | null; by: string | null } | null
}
interface Pl {
  period: { from: string; to: string; asked: string | null }
  blocks: Block[]
  openingStock: Stock
  closingStock: Stock
  grossProfit: number
  netProfit: number
  columns: Array<{ id: string; name: string }>
  /** By brand: each brand's own stock and what moved between the shares (multi-brand phase 6). */
  brand: Array<{
    id: string
    name: string
    openingStock?: number
    closingStock?: number
    transfersIn?: number
    transfersOut?: number
    stockChange: number
    grossProfit: number
    netProfit: number
  }>
  /** By department (cost centre): its columns and each one's figures. */
  deptColumns?: Array<{ id: string; name: string; parent: string | null }>
  department?: Array<{ id: string; name: string; stockChange: number; grossProfit: number; netProfit: number }>
}

/** Whose profit and loss is shown: the company's, one brand's (profit centre) or one department's (cost centre). */
type Mode = 'company' | 'brand' | 'department'

const SOURCE: Record<Stock['source'], string> = {
  books: 'brought in with the opening balances',
  set: 'as valued by the accountant',
  inventory: 'from inventory',
}

/** A figure, with a minus for one that runs the other way; blank for none. */
const money = (n: number | null | undefined) => (n === null || n === undefined ? '' : n < 0 ? `− ${inr(n)}` : inr(n))
const r2 = (n: number) => Math.round(n * 100) / 100

/** One row of one side of an account: a head with its figure, a ledger under it, a result, or room. */
interface Row {
  key: string
  label: string
  /** A ledger's figure, in the inner column. */
  sub?: number
  /** A head's or a result's figure, in the outer column. */
  amount?: number
  kind: 'head' | 'ledger' | 'result' | 'blank'
  /** The block it opens, for a head that has ledgers. */
  block?: BlockKey
  ledgerCount?: number
  href?: string
  note?: string
}

/**
 * Profit and loss the way SAB and Tally lay it out: two sides, To on the
 * left and By on the right. The Trading Account carries opening stock,
 * purchases and direct expenses against sales, direct incomes and closing
 * stock down to gross profit; the Profit & Loss Account carries indirect
 * expenses against gross profit and indirect incomes down to net profit.
 * Each side of each account totals the same.
 *
 * It is the company's, or one brand's (its sales, purchases and expenses,
 * and its own earmarked stock, with what moved between it and other shares),
 * or one department's. A head opens to its ledgers; a ledger opens its
 * statement. Closing stock comes from inventory unless the accountant values
 * the day themselves.
 */
export default function ProfitLossPage() {
  const [summary, setSummary] = useState<BooksSummary | null>(null)
  const [from, setFrom] = useState('')
  const [to, setTo] = useState(todayIst())
  const [pl, setPl] = useState<Pl | null>(null)
  const [mode, setMode] = useState<Mode>('company')
  const [who, setWho] = useState<string | null>(null)
  const [open, setOpen] = useState<Set<string>>(new Set())
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [stockForm, setStockForm] = useState<{ value: string; notes: string } | null>(null)
  const [savingStock, setSavingStock] = useState(false)

  useEffect(() => {
    api
      .get<{ data: BooksSummary }>('/accounts/summary')
      .then((r) => {
        setSummary(r.data)
        setFrom(fyStartOf(todayIst(), r.data.fyStartMonth))
      })
      .catch((err) => setError(apiErrorMessage(err, 'Could not load the books.')))
  }, [])

  const load = useCallback(async () => {
    if (!from) return
    setLoading(true)
    setError(null)
    try {
      setPl((await api.get<{ data: Pl }>(`/accounts/profit-loss?from=${from}&to=${to}`)).data)
    } catch (err) {
      setError(apiErrorMessage(err, 'Could not work out the profit and loss.'))
    } finally {
      setLoading(false)
    }
  }, [from, to])

  useEffect(() => {
    void load()
  }, [load])

  // The brands or departments to pick from; the first is picked when the mode changes.
  const choices: Array<{ id: string; name: string }> = mode === 'brand' ? (pl?.columns ?? []) : mode === 'department' ? (pl?.deptColumns ?? []) : []
  useEffect(() => {
    if (mode === 'company') {
      setWho(null)
      return
    }
    if (!choices.some((c) => c.id === who)) setWho(choices[0]?.id ?? null)
  }, [mode, choices, who])

  const toggle = (k: string) =>
    setOpen((s) => {
      const n = new Set(s)
      n.has(k) ? n.delete(k) : n.add(k)
      return n
    })

  const saveStock = async (value: number | null) => {
    if (!pl) return
    setSavingStock(true)
    setError(null)
    try {
      const res = await api.patch<{ message: string }>('/accounts/stock-value', { on: pl.closingStock.day, value, notes: stockForm?.notes || null })
      setMessage(res.message)
      setStockForm(null)
      await load()
    } catch (err) {
      setError(apiErrorMessage(err, 'Could not set the stock value.'))
    } finally {
      setSavingStock(false)
    }
  }

  const scoped = mode !== 'company' && who !== null
  const whoName = choices.find((c) => c.id === who)?.name ?? ''

  /** A head's or a ledger's figure for the company, the brand or the department shown. */
  const fig = (x: { centres: Record<string, number>; departments?: Record<string, number> }, whole: number) =>
    !scoped ? whole : mode === 'brand' ? (x.centres[who!] ?? 0) : (x.departments?.[who!] ?? 0)
  const block = (k: BlockKey) => pl?.blocks.find((b) => b.key === k)
  const share = mode === 'brand' && scoped ? pl?.brand.find((b) => b.id === who) : undefined
  const stockOf = (which: 'openingStock' | 'closingStock') => {
    if (!pl) return 0
    if (!scoped) return pl[which].value
    // Each brand's own share of stock; stock carries no department, so it sits with "No department".
    if (mode === 'brand') return share?.[which] ?? (who === '' ? pl[which].value : 0)
    return who === '' ? pl[which].value : 0
  }
  const movedIn = share?.transfersIn ?? 0
  const movedOut = share?.transfersOut ?? 0

  /** A head of an account, with its ledgers under it when opened. */
  const head = (k: BlockKey, label: string): Row[] => {
    const b = block(k)
    const rows: Row[] = [{ key: k, label, amount: b ? fig(b, b.total) : 0, kind: 'head', block: b?.lines.length ? k : undefined, ledgerCount: b?.lines.length ?? 0 }]
    if (b && open.has(k))
      for (const l of b.lines) {
        const v = fig(l, l.amount)
        if (scoped && !v) continue
        rows.push({ key: `${k}:${l.id}`, label: l.name, sub: v, kind: 'ledger', href: `/accounts/ledger?id=${l.id}&from=${pl!.period.from}&to=${pl!.period.to}`, note: l.group })
      }
    return rows
  }
  const sumOf = (rows: Row[]) => r2(rows.reduce((t, r) => t + (r.kind === 'ledger' ? 0 : (r.amount ?? 0)), 0))

  // The Trading Account: what was spent on the goods against what they brought in, down to gross profit.
  const opening = stockOf('openingStock')
  const closing = stockOf('closingStock')
  const tradingDr: Row[] = [
    { key: 'opening', label: 'To Opening Stock', amount: opening, kind: 'head', note: pl ? `on ${day(pl.openingStock.day)}` : undefined },
    ...(movedIn ? [{ key: 'in', label: 'To Stock moved in', amount: movedIn, kind: 'head' as const, note: 'from central stock or another brand' }] : []),
    ...head('PURCHASE_ACCOUNTS', 'To Purchase Accounts'),
    ...head('DIRECT_EXPENSES', 'To Direct Expenses'),
  ]
  const tradingCr: Row[] = [
    ...head('SALES_ACCOUNTS', 'By Sales Accounts'),
    ...head('DIRECT_INCOMES', 'By Direct Incomes'),
    { key: 'closing', label: 'By Closing Stock', amount: closing, kind: 'head', note: pl ? `on ${day(pl.closingStock.day)}` : undefined },
    ...(movedOut ? [{ key: 'out', label: 'By Stock moved out', amount: movedOut, kind: 'head' as const, note: 'to central stock or another brand' }] : []),
  ]
  const gross = r2(sumOf(tradingCr) - sumOf(tradingDr))
  if (gross >= 0) tradingDr.push({ key: 'gp', label: 'To Gross Profit c/o', amount: gross, kind: 'result' })
  else tradingCr.push({ key: 'gl', label: 'By Gross Loss c/o', amount: -gross, kind: 'result' })

  // The Profit & Loss Account: gross profit and other income against overheads, down to net profit.
  const plDr: Row[] = [...(gross < 0 ? [{ key: 'glb', label: 'To Gross Loss b/f', amount: -gross, kind: 'result' as const }] : []), ...head('INDIRECT_EXPENSES', 'To Indirect Expenses')]
  const plCr: Row[] = [...(gross >= 0 ? [{ key: 'gpb', label: 'By Gross Profit b/f', amount: gross, kind: 'result' as const }] : []), ...head('INDIRECT_INCOMES', 'By Indirect Incomes')]
  const net = r2(sumOf(plCr) - sumOf(plDr))
  if (net >= 0) plDr.push({ key: 'np', label: 'To Net Profit', amount: net, kind: 'result' })
  else plCr.push({ key: 'nl', label: 'By Net Loss', amount: -net, kind: 'result' })
  const tradingTotal = sumOf(tradingDr)
  const plTotal = sumOf(plDr)

  const cell = (r: Row | undefined) => {
    if (!r || r.kind === 'blank')
      return (
        <>
          <td />
          <td />
          <td className="border-border border-r" />
        </>
      )
    const isOpen = r.block ? open.has(r.block) : false
    return (
      <>
        <td className={r.kind === 'ledger' ? 'pl-8' : ''}>
          {r.kind === 'ledger' ? (
            <>
              <Link href={r.href!} className="text-primary hover:underline">
                {r.label}
              </Link>
              {r.note && <span className="text-muted-foreground ml-2 text-[11px]">{r.note}</span>}
            </>
          ) : r.block ? (
            <button type="button" className="flex items-center gap-1.5 text-left" onClick={() => toggle(r.block!)} aria-expanded={isOpen}>
              {isOpen ? <ChevronDown size={14} className="text-muted-foreground" /> : <ChevronRight size={14} className="text-muted-foreground" />}
              <span className="text-foreground font-medium">{r.label}</span>
              <span className="text-muted-foreground text-[11px]">
                {r.ledgerCount} {r.ledgerCount === 1 ? 'ledger' : 'ledgers'}
              </span>
            </button>
          ) : (
            <span className={`block pl-5 ${r.kind === 'result' ? 'text-foreground font-semibold' : 'text-foreground font-medium'}`}>
              {r.label}
              {r.note && <span className="text-muted-foreground block text-[11px] font-normal">{r.note}</span>}
            </span>
          )}
        </td>
        <td className="text-muted-foreground w-28 text-right tabular-nums">{r.kind === 'ledger' ? money(r.sub) : ''}</td>
        <td className={`border-border w-32 border-r text-right tabular-nums ${r.kind === 'result' ? 'font-semibold' : ''}`}>{r.kind === 'ledger' ? '' : money(r.amount)}</td>
      </>
    )
  }

  /** One account: its two sides side by side, padded so the totals meet on one line. */
  const account = (title: string, dr: Row[], cr: Row[], total: number) => {
    const n = Math.max(dr.length, cr.length)
    return (
      <div className="glass-card overflow-hidden p-0">
        <div className="border-border border-b px-4 py-2.5">
          <h2 className="text-foreground text-sm font-semibold">
            {title}
            {scoped && <span className="text-primary"> — {whoName}</span>}
          </h2>
          {pl && (
            <p className="text-muted-foreground text-[11px]">
              {day(pl.period.from)} to {day(pl.period.to)}
            </p>
          )}
        </div>
        <div className="overflow-x-auto">
          <table className="data-table w-full min-w-[960px] table-fixed">
            <colgroup>
              <col />
              <col className="w-28" />
              <col className="w-32" />
              <col />
              <col className="w-28" />
              <col className="w-32" />
            </colgroup>
            <thead>
              <tr>
                <th>Dr · Particulars</th>
                <th className="text-right">₹</th>
                <th className="border-border border-r text-right">Amount ₹</th>
                <th>Cr · Particulars</th>
                <th className="text-right">₹</th>
                <th className="text-right">Amount ₹</th>
              </tr>
            </thead>
            <tbody>
              {Array.from({ length: n }, (_, i) => (
                <tr key={i}>
                  {cell(dr[i])}
                  <Fragment>{cell(cr[i])}</Fragment>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="bg-secondary/40">
                <td className="text-foreground px-4 py-2.5 font-semibold">Total</td>
                <td />
                <td className="border-border border-r px-4 py-2.5 text-right font-semibold tabular-nums">{money(total)}</td>
                <td className="text-foreground px-4 py-2.5 font-semibold">Total</td>
                <td />
                <td className="px-4 py-2.5 text-right font-semibold tabular-nums">{money(total)}</td>
              </tr>
            </tfoot>
          </table>
        </div>
      </div>
    )
  }

  const exportIt = async (format: ExportFormat) => {
    if (!pl) return
    type X = { account: string; drLabel: string; drSub: number | null; drAmount: number | null; crLabel: string; crSub: number | null; crAmount: number | null }
    const rows: X[] = []
    const add = (name: string, dr: Row[], cr: Row[], total: number) => {
      for (let i = 0; i < Math.max(dr.length, cr.length); i++) {
        const a = dr[i]
        const b = cr[i]
        rows.push({
          account: i === 0 ? name : '',
          drLabel: a?.label ?? '',
          drSub: a?.kind === 'ledger' ? (a.sub ?? null) : null,
          drAmount: a && a.kind !== 'ledger' ? (a.amount ?? null) : null,
          crLabel: b?.label ?? '',
          crSub: b?.kind === 'ledger' ? (b.sub ?? null) : null,
          crAmount: b && b.kind !== 'ledger' ? (b.amount ?? null) : null,
        })
      }
      rows.push({ account: '', drLabel: 'Total', drSub: null, drAmount: total, crLabel: 'Total', crSub: null, crAmount: total })
    }
    add('Trading Account', tradingDr, tradingCr, tradingTotal)
    add('Profit & Loss Account', plDr, plCr, plTotal)
    const columns: ExportColumn<X>[] = [
      { header: 'Account', value: (r) => r.account },
      { header: 'Dr Particulars', value: (r) => r.drLabel },
      { header: 'Dr ₹', value: (r) => r.drSub },
      { header: 'Dr Amount ₹', value: (r) => r.drAmount },
      { header: 'Cr Particulars', value: (r) => r.crLabel },
      { header: 'Cr ₹', value: (r) => r.crSub },
      { header: 'Cr Amount ₹', value: (r) => r.crAmount },
    ]
    const whose = scoped ? `-${whoName.toLowerCase().replace(/[^a-z0-9]+/g, '-')}` : ''
    await downloadRows({ rows, columns, name: `profit-and-loss${whose}-${pl.period.from}-to-${pl.period.to}`, sheet: 'Profit and Loss', format })
  }

  const may = can('accounts', 'edit')
  const tab = (active: boolean) => (active ? 'bg-primary text-primary-foreground rounded-lg px-3 py-1 text-xs font-semibold' : 'text-muted-foreground rounded-lg px-3 py-1 text-xs')

  return (
    <div className="space-y-5">
      <div className="page-header gap-3">
        <div className="min-w-0">
          <h1 className="page-title text-xl sm:text-2xl">Profit &amp; Loss</h1>
          <p className="page-subtitle hidden sm:block">Trading Account to gross profit, then the Profit &amp; Loss Account to net profit</p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <button className="btn-ghost" onClick={() => void load()} disabled={loading} aria-label="Refresh">
            <RefreshCw size={15} className={loading ? 'animate-spin' : undefined} />
          </button>
          <ExportButton onExport={exportIt} disabled={loading || !pl} />
        </div>
      </div>

      <div className="glass-card space-y-2 p-3">
        <div className="flex flex-wrap items-center gap-2">
          <input type="date" className="form-input h-9 w-[150px]" value={from} max={to} onChange={(e) => setFrom(e.target.value)} aria-label="From" />
          <span className="text-muted-foreground text-xs">to</span>
          <input type="date" className="form-input h-9 w-[150px]" value={to} min={from} max={todayIst()} onChange={(e) => setTo(e.target.value || todayIst())} aria-label="To" />
          <div className="border-border bg-secondary ml-auto flex gap-1 rounded-lg border p-1" role="radiogroup" aria-label="Whose profit and loss">
            {(
              [
                ['company', 'Company'],
                ['brand', 'Brand-wise'],
                ['department', 'Department-wise'],
              ] as const
            ).map(([k, label]) => (
              <button key={k} type="button" role="radio" aria-checked={mode === k} className={tab(mode === k)} onClick={() => setMode(k)}>
                {label}
              </button>
            ))}
          </div>
        </div>
        {mode !== 'company' && choices.length > 0 && (
          <div className="flex flex-wrap items-center gap-1" role="radiogroup" aria-label={mode === 'brand' ? 'Brand' : 'Department'}>
            <span className="text-muted-foreground mr-1 text-xs font-medium">{mode === 'brand' ? 'Brand' : 'Department'}</span>
            {choices.map((c) => (
              <button key={c.id || 'none'} type="button" role="radio" aria-checked={who === c.id} className={`btn-ghost h-8 px-2 text-xs ${who === c.id ? 'bg-primary/10 text-primary font-semibold' : ''}`} onClick={() => setWho(c.id)}>
                {c.name}
              </button>
            ))}
          </div>
        )}
      </div>

      {error && (
        <div className="border-destructive/40 bg-destructive/5 flex items-start gap-3 rounded-lg border p-3">
          <AlertCircle size={16} className="text-destructive mt-0.5 shrink-0" />
          <p className="text-destructive text-sm">{error}</p>
        </div>
      )}
      {message && (
        <div className="border-primary/40 bg-primary/5 rounded-lg border p-3">
          <p className="text-primary text-sm">{message}</p>
        </div>
      )}
      {summary && !summary.booksStart && <p className="text-muted-foreground text-sm">Set the day the books start (Chart of Accounts → Books) first.</p>}

      {pl && (
        <>
          {pl.period.asked && (
            <p className="text-muted-foreground text-xs">
              Shown from {day(pl.period.from)}: the old books&apos; figures to the day the books started here came in as one sum for the year, so a period cannot begin inside it.
            </p>
          )}
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
            <div className="glass-card p-3">
              <p className="text-muted-foreground text-[11px]">
                Gross {gross >= 0 ? 'profit' : 'loss'}
                {scoped ? ` · ${whoName}` : ''}
              </p>
              <p className={`mt-0.5 text-lg font-semibold tabular-nums ${gross < 0 ? 'text-destructive' : 'text-foreground'}`}>₹{inr(Math.abs(gross))}</p>
            </div>
            <div className="glass-card p-3">
              <p className="text-muted-foreground text-[11px]">
                Net {net >= 0 ? 'profit' : 'loss'}
                {scoped ? ` · ${whoName}` : ''}
              </p>
              <p className={`mt-0.5 text-lg font-semibold tabular-nums ${net < 0 ? 'text-destructive' : 'text-foreground'}`}>₹{inr(Math.abs(net))}</p>
            </div>
            <div className="glass-card p-3">
              <p className="text-muted-foreground flex items-center gap-1 text-[11px]">
                <Package size={12} /> Closing stock on {day(pl.closingStock.day)}
                {scoped ? ` · ${whoName}` : ''}
              </p>
              <div className="flex items-baseline justify-between gap-2">
                <p className="text-foreground mt-0.5 text-lg font-semibold tabular-nums">₹{inr(closing)}</p>
                {may && !scoped && pl.closingStock.source !== 'books' && !stockForm && (
                  <button type="button" className="btn-ghost h-7 px-2 text-xs" onClick={() => setStockForm({ value: String(pl.closingStock.value), notes: pl.closingStock.set?.notes ?? '' })}>
                    Value it
                  </button>
                )}
              </div>
              <p className="text-muted-foreground text-[11px]">
                {scoped && mode === 'brand' ? 'its own earmarked stock, at its own average' : SOURCE[pl.closingStock.source]}
                {!scoped && pl.closingStock.source === 'set' && pl.closingStock.inventory !== null && ` — inventory says ₹${inr(pl.closingStock.inventory)}`}
              </p>
            </div>
          </div>

          {stockForm && (
            <div className="glass-card flex flex-col gap-2 p-4 sm:flex-row sm:items-end">
              <div className="sm:w-56">
                <label className="form-label" htmlFor="stock-value">
                  Closing stock on {day(pl.closingStock.day)} ₹
                </label>
                <StepInput id="stock-value" decimals className="form-input text-right tabular-nums" value={stockForm.value} onValueChange={(v) => setStockForm((f) => f && { ...f, value: v })} />
              </div>
              <div className="flex-1">
                <label className="form-label" htmlFor="stock-notes">
                  How it was valued
                </label>
                <input id="stock-notes" className="form-input" maxLength={500} placeholder="Physical count on 31 March, work in progress at cost" value={stockForm.notes} onChange={(e) => setStockForm((f) => f && { ...f, notes: e.target.value })} />
              </div>
              <div className="flex gap-2">
                <button className="btn-ghost" onClick={() => setStockForm(null)} disabled={savingStock}>
                  Cancel
                </button>
                {pl.closingStock.source === 'set' && (
                  <button className="btn-secondary" onClick={() => void saveStock(null)} disabled={savingStock}>
                    <Undo2 size={15} /> Use inventory&apos;s value
                  </button>
                )}
                <button className="btn-primary" onClick={() => void saveStock(Number(stockForm.value) || 0)} disabled={savingStock}>
                  {savingStock ? <Loader2 size={15} className="animate-spin" /> : <Save size={15} />} Save value
                </button>
              </div>
            </div>
          )}

          {account('Trading Account', tradingDr, tradingCr, tradingTotal)}
          {account('Profit & Loss Account', plDr, plCr, plTotal)}

          {mode === 'brand' && (
            <p className="text-muted-foreground text-xs">
              A brand&apos;s sales carry the brand of their order; its purchases the brand of the order they were bought for; its expenses the brand picked on the bill or voucher, else the ledger&apos;s usual one. Its opening and closing stock are its own earmarked stock, at its own average. Stock it took from central stock or another brand is &quot;Stock moved in&quot;, and stock it gave up is &quot;Stock moved out&quot;, at the value it moved at, so moving stock never makes a profit or a loss. &quot;Not split&quot; is central stock and whatever no brand carries, such as shared expenses not yet allocated. The brands and Not split add up to the company.
            </p>
          )}
          {mode === 'department' && (
            <p className="text-muted-foreground text-xs">
              Each line sits with its department (cost centre): sales with Sales &amp; Marketing, job work with Production, purchases with the department whose indent they were for, expenses with the department picked or the expense head&apos;s usual one. Stock, and anything no department carries, sits under &quot;No department&quot; —{' '}
              <Link href="/reports/unallocated-entries" className="text-primary hover:underline">
                see Unallocated Entries
              </Link>
              .
            </p>
          )}
        </>
      )}
    </div>
  )
}
