'use client'

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { AlertCircle, AlertTriangle, ChevronDown, ChevronRight, Landmark, RefreshCw } from 'lucide-react'
import { api, apiErrorMessage } from '@/lib/api'
import { ExportButton } from '@/components/tables/ExportButton'
import { downloadRows, type ExportColumn, type ExportFormat } from '@/lib/export'
import { day, drCr, inr, todayIst } from '@/components/accounts/books'

interface Row {
  id: string
  name: string
  kind: 'group' | 'ledger' | 'line'
  amount: number
  note?: string
  children: Row[]
}

interface Bs {
  asOn: string
  fyStart: string
  liabilities: Row[]
  assets: Row[]
  liabilitiesTotal: number
  assetsTotal: number
  openingDifference: number
  netProfit: number
}

const money = (n: number) => (n < 0 ? `− ${inr(n)}` : inr(n))

/**
 * The balance sheet on a day: what the mill owes and is owned by on one
 * side — capital, reserves, this year's profit, loans, creditors, duties —
 * and what it owns on the other — fixed assets, stock, debtors, bank, cash.
 *
 * Each group opens to what is under it; a ledger opens its entries. Stock is
 * at its value that day. The two sides agree; if the opening balances from
 * the old books do not, the gap shows on its own line.
 */
export default function BalanceSheetPage() {
  const [asOn, setAsOn] = useState(todayIst())
  const [bs, setBs] = useState<Bs | null>(null)
  const [open, setOpen] = useState<Set<string>>(new Set())
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      setBs((await api.get<{ data: Bs }>(`/accounts/balance-sheet?asOn=${asOn}`)).data)
    } catch (err) {
      setError(apiErrorMessage(err, 'Could not draw up the balance sheet.'))
    } finally {
      setLoading(false)
    }
  }, [asOn])

  useEffect(() => {
    void load()
  }, [load])

  const toggle = (id: string) =>
    setOpen((s) => {
      const n = new Set(s)
      n.has(id) ? n.delete(id) : n.add(id)
      return n
    })

  const rows = (list: Row[], depth: number): React.ReactNode[] =>
    list.flatMap((r) => {
      const isOpen = open.has(r.id)
      const canOpen = r.kind === 'group' && r.children.length > 0
      const line = (
        <tr key={r.id} data-row tabIndex={-1} className={canOpen ? 'cursor-pointer' : undefined} onClick={canOpen ? () => toggle(r.id) : undefined}>
          <td>
            <span className="flex items-center gap-1.5" style={{ paddingLeft: `${depth * 16}px` }}>
              {canOpen ? isOpen ? <ChevronDown size={14} className="text-muted-foreground shrink-0" /> : <ChevronRight size={14} className="text-muted-foreground shrink-0" /> : <span className="w-[14px] shrink-0" />}
              {r.kind === 'ledger' ? (
                <Link href={`/accounts/ledger?id=${r.id}&to=${bs!.asOn}`} className="text-primary hover:underline" onClick={(e) => e.stopPropagation()}>
                  {r.name}
                </Link>
              ) : (
                <span className={depth === 0 ? 'text-foreground font-semibold' : 'text-foreground font-medium'}>
                  {r.id === 'profit' ? `${bs!.netProfit >= 0 ? 'Profit' : 'Loss'} for ${day(bs!.fyStart)} to ${day(bs!.asOn)}` : r.name}
                </span>
              )}
            </span>
            {r.note && <span className="text-muted-foreground block text-[11px]" style={{ paddingLeft: `${depth * 16 + 20}px` }}>{r.note}</span>}
          </td>
          <td className={`text-right tabular-nums ${depth === 0 ? 'font-semibold' : ''}`}>{money(r.amount)}</td>
        </tr>
      )
      return [line, ...(isOpen ? rows(r.children, depth + 1) : [])]
    })

  const side = (title: string, list: Row[], total: number, extra?: React.ReactNode) => (
    <div className="glass-card overflow-hidden p-0">
      <table className="data-table table-totals w-full">
        <thead>
          <tr>
            <th>{title}</th>
            <th className="w-40 text-right">₹</th>
          </tr>
        </thead>
        <tbody>
          {rows(list, 0)}
          {extra}
        </tbody>
        <tfoot>
          <tr>
            <td className="font-semibold">Total</td>
            <td className="text-right font-semibold tabular-nums">{money(total)}</td>
          </tr>
        </tfoot>
      </table>
    </div>
  )

  const exportIt = async (format: ExportFormat) => {
    if (!bs) return
    type Flat = { side: string; level: number; name: string; amount: number }
    const out: Flat[] = []
    const walk = (s: string, list: Row[], level: number) =>
      list.forEach((r) => {
        out.push({ side: s, level, name: r.name, amount: r.amount })
        walk(s, r.children, level + 1)
      })
    walk('Liabilities', bs.liabilities, 0)
    walk('Assets', bs.assets, 0)
    const columns: ExportColumn<Flat>[] = [
      { header: 'Side', value: (r) => r.side },
      { header: 'Particulars', value: (r) => `${'    '.repeat(r.level)}${r.name}` },
      { header: 'Amount', value: (r) => r.amount },
    ]
    await downloadRows({ rows: out, columns, name: `balance-sheet-${bs.asOn}`, sheet: 'Balance Sheet', format })
  }

  const diff = bs?.openingDifference ?? 0
  // The gap goes on whichever side it makes up.
  const diffRow = (onLiabilities: boolean) =>
    diff !== 0 && (diff > 0) === onLiabilities ? (
      <tr>
        <td className="text-accent italic">Difference in opening balances</td>
        <td className="text-accent text-right tabular-nums">{inr(diff)}</td>
      </tr>
    ) : null

  return (
    <div className="space-y-5">
      <div className="page-header gap-3">
        <div className="min-w-0">
          <h1 className="page-title text-xl sm:text-2xl">Balance Sheet</h1>
          <p className="page-subtitle hidden sm:block">What the mill owes and what it owns, on a day</p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <button className="btn-ghost" onClick={() => void load()} disabled={loading} aria-label="Refresh">
            <RefreshCw size={15} className={loading ? 'animate-spin' : undefined} />
          </button>
          <ExportButton onExport={exportIt} disabled={loading || !bs} />
        </div>
      </div>

      <div className="glass-card flex flex-wrap items-center gap-2 p-3">
        <label className="text-muted-foreground flex items-center gap-2 text-sm">
          <Landmark size={15} /> As on
          <input type="date" className="form-input h-9 w-[150px]" value={asOn} max={todayIst()} onChange={(e) => setAsOn(e.target.value || todayIst())} />
        </label>
        {bs && (
          <div className="ml-auto flex items-center gap-2">
            <button type="button" className="btn-ghost h-9 px-2 text-xs" onClick={() => setOpen(new Set([...bs.liabilities, ...bs.assets].map((r) => r.id)))}>
              Open the main groups
            </button>
            <button type="button" className="btn-ghost h-9 px-2 text-xs" onClick={() => setOpen(new Set())}>
              Close all
            </button>
          </div>
        )}
      </div>

      {error && (
        <div className="border-destructive/40 bg-destructive/5 flex items-start gap-3 rounded-lg border p-3">
          <AlertCircle size={16} className="text-destructive mt-0.5 shrink-0" />
          <p className="text-destructive text-sm">{error}</p>
        </div>
      )}
      {bs && diff !== 0 && (
        <div className="border-accent/40 bg-accent/5 flex items-start gap-3 rounded-lg border p-3">
          <AlertTriangle size={16} className="text-accent mt-0.5 shrink-0" />
          <p className="text-sm">
            The opening balances brought in from the old books are out by <span className="font-semibold tabular-nums">{drCr(diff)}</span>, so the two sides differ by that much. Put the opening balances right under Chart of Accounts → Opening.
          </p>
        </div>
      )}

      {loading && !bs && <div className="skeleton h-72 w-full rounded-xl" />}
      {bs && (
        <>
          <div className="grid gap-4 lg:grid-cols-2">
            {side('Liabilities and capital', bs.liabilities, bs.liabilitiesTotal + (diff > 0 ? diff : 0), diffRow(true))}
            {side('Assets', bs.assets, bs.assetsTotal + (diff < 0 ? -diff : 0), diffRow(false))}
          </div>
          <p className="text-muted-foreground text-xs">
            On {day(bs.asOn)}. The year&apos;s {bs.netProfit >= 0 ? 'profit' : 'loss'} from {day(bs.fyStart)} is on its own line; earlier years&apos; is in the Profit &amp; Loss A/c under Reserves &amp; Surplus. A figure with a minus runs the other way to its side: a bank overdrawn, a supplier paid in advance.
          </p>
        </>
      )}
    </div>
  )
}
