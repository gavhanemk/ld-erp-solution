'use client'

import { Fragment, useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { AlertCircle, ChevronDown, ChevronRight, Loader2, Package, RefreshCw, Save, TrendingUp, Undo2 } from 'lucide-react'
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
}
interface Block {
  key: BlockKey
  title: string
  total: number
  centres: Record<string, number>
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
  brand: Array<{ id: string; name: string; stockChange: number; grossProfit: number; netProfit: number }>
}

const SOURCE: Record<Stock['source'], string> = {
  books: 'brought in with the opening balances',
  set: 'as valued by the accountant',
  inventory: 'from inventory',
}

/** A figure, with a minus for one that runs the other way. */
const money = (n: number) => (n < 0 ? `− ${inr(n)}` : inr(n))

/**
 * Profit and loss, the way an Indian set of accounts lays it out: the
 * trading account (sales, purchases, direct costs and the change in stock)
 * down to gross profit, then other income and overheads down to net profit.
 *
 * Each heading opens to its ledgers, and a ledger opens its entries. "By
 * brand" splits every figure across LD Cotton Mills, VHAGAR and what no brand
 * carries. Closing stock comes from inventory unless the accountant values
 * the day themselves — a year-end count, work in progress taken in.
 */
export default function ProfitLossPage() {
  const [summary, setSummary] = useState<BooksSummary | null>(null)
  const [from, setFrom] = useState('')
  const [to, setTo] = useState(todayIst())
  const [pl, setPl] = useState<Pl | null>(null)
  const [byBrand, setByBrand] = useState(false)
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

  const block = (k: BlockKey) => pl?.blocks.find((b) => b.key === k)
  const cols = pl?.columns ?? []
  const brandOf = (id: string) => pl?.brand.find((b) => b.id === id)

  /** One figure, or a row of them by brand. */
  const figures = (total: number, centres?: Record<string, number>, bold = false, negate = false) => {
    const cls = `text-right tabular-nums ${bold ? 'font-semibold' : ''}`
    const v = (n: number) => money(negate ? -n : n)
    if (!byBrand) return <td className={cls}>{v(total)}</td>
    return (
      <>
        {cols.map((c) => (
          <td key={c.id || 'none'} className={cls}>
            {centres && centres[c.id] ? v(centres[c.id]) : ''}
          </td>
        ))}
        <td className={cls}>{v(total)}</td>
      </>
    )
  }

  const blockRows = (k: BlockKey, label: string, negate = false) => {
    const b = block(k)
    if (!b || (!b.lines.length && b.total === 0)) return null
    const isOpen = open.has(k)
    return (
      <Fragment key={k}>
        <tr data-row tabIndex={-1} className="cursor-pointer" onClick={() => toggle(k)}>
          <td>
            <span className="flex items-center gap-1.5">
              {isOpen ? <ChevronDown size={14} className="text-muted-foreground" /> : <ChevronRight size={14} className="text-muted-foreground" />}
              <span className="text-foreground font-medium">{label}</span>
              <span className="text-muted-foreground text-[11px]">{b.lines.length} {b.lines.length === 1 ? 'ledger' : 'ledgers'}</span>
            </span>
          </td>
          {figures(b.total, b.centres, false, negate)}
        </tr>
        {isOpen &&
          b.lines.map((l) => (
            <tr key={l.id}>
              <td className="pl-10">
                <Link href={`/accounts/ledger?id=${l.id}&from=${pl!.period.from}&to=${pl!.period.to}`} className="text-primary hover:underline">
                  {l.name}
                </Link>
                <span className="text-muted-foreground ml-2 text-[11px]">{l.group}</span>
              </td>
              {figures(l.amount, l.centres, false, negate)}
            </tr>
          ))}
      </Fragment>
    )
  }

  const stockRow = (label: string, st: Stock, negate: boolean) => (
    <tr>
      <td>
        <span className="text-foreground pl-5 font-medium">{label}</span>
        <span className="text-muted-foreground ml-2 text-[11px]">
          on {day(st.day)}, {SOURCE[st.source]}
        </span>
      </td>
      {byBrand ? (
        <>
          {cols.map((c) => (
            <td key={c.id || 'none'} className="text-right tabular-nums">
              {c.id === '' ? money(negate ? -st.value : st.value) : ''}
            </td>
          ))}
          <td className="text-right tabular-nums">{money(negate ? -st.value : st.value)}</td>
        </>
      ) : (
        <td className="text-right tabular-nums">{money(negate ? -st.value : st.value)}</td>
      )}
    </tr>
  )

  const resultRow = (label: string, value: number, key: 'grossProfit' | 'netProfit') => (
    <tr className="bg-secondary/40">
      <td className="text-foreground font-semibold">{value >= 0 ? label : label.replace('profit', 'loss')}</td>
      {byBrand ? (
        <>
          {cols.map((c) => (
            <td key={c.id || 'none'} className="text-right font-semibold tabular-nums">
              {money(brandOf(c.id)?.[key] ?? 0)}
            </td>
          ))}
          <td className="text-right font-semibold tabular-nums">{money(value)}</td>
        </>
      ) : (
        <td className={`text-right font-semibold tabular-nums ${value < 0 ? 'text-destructive' : ''}`}>{money(value)}</td>
      )}
    </tr>
  )

  const exportIt = async (format: ExportFormat) => {
    if (!pl) return
    type Row = { section: string; particulars: string; amount: number } & Record<string, unknown>
    const rows: Row[] = []
    const add = (section: string, particulars: string, amount: number, centres?: Record<string, number>) =>
      rows.push({ section, particulars, amount, ...Object.fromEntries(cols.map((c) => [`c:${c.id}`, centres?.[c.id] ?? null])) })
    for (const b of pl.blocks) {
      add(b.title, `${b.title} — total`, b.total, b.centres)
      for (const l of b.lines) add(b.title, l.name, l.amount, l.centres)
    }
    add('Stock', 'Opening stock', pl.openingStock.value)
    add('Stock', 'Closing stock', pl.closingStock.value)
    add('Result', 'Gross profit', pl.grossProfit, Object.fromEntries(pl.brand.map((b) => [b.id, b.grossProfit])))
    add('Result', 'Net profit', pl.netProfit, Object.fromEntries(pl.brand.map((b) => [b.id, b.netProfit])))
    const columns: ExportColumn<Row>[] = [
      { header: 'Section', value: (r) => r.section },
      { header: 'Particulars', value: (r) => r.particulars },
      ...(byBrand ? cols.map((c) => ({ header: c.name, value: (r: Row) => r[`c:${c.id}`] as number | null })) : []),
      { header: 'Amount', value: (r) => r.amount },
    ]
    await downloadRows({ rows, columns, name: `profit-and-loss-${pl.period.from}-to-${pl.period.to}`, sheet: 'Profit and Loss', format })
  }

  const may = can('accounts', 'edit')

  return (
    <div className="space-y-5">
      <div className="page-header gap-3">
        <div className="min-w-0">
          <h1 className="page-title text-xl sm:text-2xl">Profit &amp; Loss</h1>
          <p className="page-subtitle hidden sm:block">Trading account to gross profit, then overheads to net profit</p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <button className="btn-ghost" onClick={() => void load()} disabled={loading} aria-label="Refresh">
            <RefreshCw size={15} className={loading ? 'animate-spin' : undefined} />
          </button>
          <ExportButton onExport={exportIt} disabled={loading || !pl} />
        </div>
      </div>

      <div className="glass-card flex flex-wrap items-center gap-2 p-3">
        <input type="date" className="form-input h-9 w-[150px]" value={from} max={to} onChange={(e) => setFrom(e.target.value)} aria-label="From" />
        <span className="text-muted-foreground text-xs">to</span>
        <input type="date" className="form-input h-9 w-[150px]" value={to} min={from} max={todayIst()} onChange={(e) => setTo(e.target.value || todayIst())} aria-label="To" />
        <label className="text-muted-foreground ml-auto flex items-center gap-1.5 text-sm">
          <input type="checkbox" checked={byBrand} onChange={(e) => setByBrand(e.target.checked)} />
          By brand
        </label>
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
              <p className="text-muted-foreground text-[11px]">Gross {pl.grossProfit >= 0 ? 'profit' : 'loss'}</p>
              <p className={`mt-0.5 text-lg font-semibold tabular-nums ${pl.grossProfit < 0 ? 'text-destructive' : 'text-foreground'}`}>₹{inr(pl.grossProfit)}</p>
            </div>
            <div className="glass-card p-3">
              <p className="text-muted-foreground text-[11px]">Net {pl.netProfit >= 0 ? 'profit' : 'loss'}</p>
              <p className={`mt-0.5 text-lg font-semibold tabular-nums ${pl.netProfit < 0 ? 'text-destructive' : 'text-foreground'}`}>₹{inr(pl.netProfit)}</p>
            </div>
            <div className="glass-card p-3">
              <p className="text-muted-foreground flex items-center gap-1 text-[11px]">
                <Package size={12} /> Closing stock on {day(pl.closingStock.day)}
              </p>
              <div className="flex items-baseline justify-between gap-2">
                <p className="text-foreground mt-0.5 text-lg font-semibold tabular-nums">₹{inr(pl.closingStock.value)}</p>
                {may && pl.closingStock.source !== 'books' && !stockForm && (
                  <button type="button" className="btn-ghost h-7 px-2 text-xs" onClick={() => setStockForm({ value: String(pl.closingStock.value), notes: pl.closingStock.set?.notes ?? '' })}>
                    Value it
                  </button>
                )}
              </div>
              <p className="text-muted-foreground text-[11px]">
                {SOURCE[pl.closingStock.source]}
                {pl.closingStock.source === 'set' && pl.closingStock.inventory !== null && ` — inventory says ₹${inr(pl.closingStock.inventory)}`}
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

          <div className="glass-card overflow-hidden p-0">
            <div className="overflow-x-auto">
              <table className={`data-table table-totals w-full ${byBrand ? 'min-w-[900px]' : ''}`}>
                <thead>
                  <tr>
                    <th>
                      <span className="flex items-center gap-1.5">
                        <TrendingUp size={14} /> {day(pl.period.from)} to {day(pl.period.to)}
                      </span>
                    </th>
                    {byBrand && cols.map((c) => <th key={c.id || 'none'} className="w-36 text-right">{c.name}</th>)}
                    <th className="w-40 text-right">{byBrand ? 'Total ₹' : 'Amount ₹'}</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td colSpan={byBrand ? cols.length + 2 : 2} className="text-muted-foreground text-xs font-semibold uppercase tracking-wider">
                      Trading account
                    </td>
                  </tr>
                  {blockRows('SALES_ACCOUNTS', 'Sales')}
                  {blockRows('DIRECT_INCOMES', 'Direct income')}
                  {stockRow('Add closing stock', pl.closingStock, false)}
                  {stockRow('Less opening stock', pl.openingStock, false)}
                  {blockRows('PURCHASE_ACCOUNTS', 'Less purchases')}
                  {blockRows('DIRECT_EXPENSES', 'Less direct expenses')}
                  {resultRow('Gross profit', pl.grossProfit, 'grossProfit')}
                  <tr>
                    <td colSpan={byBrand ? cols.length + 2 : 2} className="text-muted-foreground text-xs font-semibold uppercase tracking-wider">
                      Profit and loss account
                    </td>
                  </tr>
                  {blockRows('INDIRECT_INCOMES', 'Add other income')}
                  {blockRows('INDIRECT_EXPENSES', 'Less indirect expenses')}
                </tbody>
                <tfoot>{resultRow('Net profit', pl.netProfit, 'netProfit')}</tfoot>
              </table>
            </div>
          </div>
          {byBrand && (
            <p className="text-muted-foreground text-xs">
              Sales carry the brand of their order; purchases and expenses the brand of the style they were for, or the one chosen on a voucher. Stock is valued for the mill as a whole, so its change, and anything no brand carries, sits under &quot;Not split&quot;.
            </p>
          )}
        </>
      )}
    </div>
  )
}
