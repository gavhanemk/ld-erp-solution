'use client'

import { Fragment, useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { AlertCircle, AlertTriangle, ChevronDown, ChevronRight, RefreshCw, Scale } from 'lucide-react'
import { api, apiErrorMessage } from '@/lib/api'
import { ExportButton } from '@/components/tables/ExportButton'
import { downloadRows, type ExportColumn, type ExportFormat } from '@/lib/export'
import { amountOrBlank, day, drCr, fyStartOf, inr, r2, reportStart, todayIst, type BooksSummary, type Nature } from '@/components/accounts/books'

interface Figures {
  opening: number
  dr: number
  cr: number
  closing: number
}
interface GroupRow extends Figures {
  id: string
  name: string
  parentId: string | null
  nature: Nature
  sortOrder: number
  ledgerCount: number
}
interface LedgerRow extends Figures {
  id: string
  name: string
  groupId: string
  nature: Nature
}
interface TB {
  period: { from: string; to: string }
  groups: GroupRow[]
  ledgers: LedgerRow[]
  totals: { openingDr: number; openingCr: number; dr: number; cr: number; closingDr: number; closingCr: number }
  openingDifference: number
}

const moved = (f: Figures) => r2(f.opening) !== 0 || r2(f.dr) !== 0 || r2(f.cr) !== 0

/** One side of a signed balance, for the Dr and Cr columns. */
const side = (n: number, which: 'dr' | 'cr') => (which === 'dr' ? (n > 0 ? inr(n) : '') : n < 0 ? inr(n) : '')

/**
 * The trial balance, group by group as the books are kept: open a group to
 * see the groups and ledgers under it, open a ledger to see its entries.
 *
 * Opening, the period's debits and credits, and closing — each balance on its
 * own side. The two sides agree; when the opening balances entered from the
 * old books do not, the gap shows as its own line rather than being hidden.
 */
export default function TrialBalancePage() {
  const [summary, setSummary] = useState<BooksSummary | null>(null)
  const [from, setFrom] = useState('')
  const [to, setTo] = useState(todayIst())
  const [tb, setTb] = useState<TB | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [open, setOpen] = useState<Set<string>>(new Set())
  const [showEmpty, setShowEmpty] = useState(false)

  useEffect(() => {
    api
      .get<{ data: BooksSummary }>('/accounts/summary')
      .then((r) => {
        setSummary(r.data)
        setFrom(reportStart(r.data))
      })
      .catch((err) => setError(apiErrorMessage(err, 'Could not load the books.')))
  }, [])

  const load = useCallback(async () => {
    if (!from) return
    setLoading(true)
    setError(null)
    try {
      setTb((await api.get<{ data: TB }>(`/accounts/trial-balance?from=${from}&to=${to}`)).data)
    } catch (err) {
      setError(apiErrorMessage(err, 'Could not work out the trial balance.'))
    } finally {
      setLoading(false)
    }
  }, [from, to])

  useEffect(() => {
    void load()
  }, [load])

  const tree = useMemo(() => {
    if (!tb) return { top: [] as GroupRow[], kids: new Map<string, GroupRow[]>(), leaves: new Map<string, LedgerRow[]>() }
    const kids = new Map<string, GroupRow[]>()
    for (const g of tb.groups) if (g.parentId) kids.set(g.parentId, [...(kids.get(g.parentId) ?? []), g])
    const leaves = new Map<string, LedgerRow[]>()
    for (const l of tb.ledgers) leaves.set(l.groupId, [...(leaves.get(l.groupId) ?? []), l])
    return { top: tb.groups.filter((g) => !g.parentId), kids, leaves }
  }, [tb])

  const toggle = (id: string) =>
    setOpen((s) => {
      const n = new Set(s)
      n.has(id) ? n.delete(id) : n.add(id)
      return n
    })

  const expandAll = () => setOpen(new Set(tb?.groups.map((g) => g.id) ?? []))

  const exportIt = async (format: ExportFormat) => {
    if (!tb) return
    type Row = { level: number; name: string } & Figures
    const out: Row[] = []
    const walk = (g: GroupRow, level: number) => {
      if (!showEmpty && !moved(g)) return
      out.push({ level, ...g })
      for (const c of tree.kids.get(g.id) ?? []) walk(c, level + 1)
      for (const l of tree.leaves.get(g.id) ?? []) if (showEmpty || moved(l)) out.push({ level: level + 1, ...l })
    }
    for (const g of tree.top) walk(g, 0)
    const columns: ExportColumn<Row>[] = [
      { header: 'Particulars', value: (r) => `${'    '.repeat(r.level)}${r.name}` },
      { header: 'Opening Dr', value: (r) => (r.opening > 0 ? r.opening : null) },
      { header: 'Opening Cr', value: (r) => (r.opening < 0 ? -r.opening : null) },
      { header: 'Debit', value: (r) => r.dr || null },
      { header: 'Credit', value: (r) => r.cr || null },
      { header: 'Closing Dr', value: (r) => (r.closing > 0 ? r.closing : null) },
      { header: 'Closing Cr', value: (r) => (r.closing < 0 ? -r.closing : null) },
    ]
    await downloadRows({ rows: out, columns, name: `trial-balance-${from}-to-${to}`, sheet: 'Trial Balance', format })
  }

  const renderGroup = (g: GroupRow, level: number): React.ReactNode => {
    if (!showEmpty && !moved(g)) return null
    const isOpen = open.has(g.id)
    const subGroups = tree.kids.get(g.id) ?? []
    const ledgers = (tree.leaves.get(g.id) ?? []).filter((l) => showEmpty || moved(l))
    return (
      <Fragment key={g.id}>
        <tr data-row tabIndex={level === 0 && g === tree.top[0] ? 0 : -1} className="cursor-pointer" onClick={() => toggle(g.id)}>
          <td>
            <span className="flex items-center gap-1.5" style={{ paddingLeft: `${level * 18}px` }}>
              {isOpen ? <ChevronDown size={14} className="text-muted-foreground" /> : <ChevronRight size={14} className="text-muted-foreground" />}
              <span className={level === 0 ? 'text-foreground font-semibold' : 'text-foreground font-medium'}>{g.name}</span>
            </span>
          </td>
          <td className="text-right tabular-nums">{side(g.opening, 'dr')}</td>
          <td className="text-right tabular-nums">{side(g.opening, 'cr')}</td>
          <td className="text-right tabular-nums">{amountOrBlank(g.dr)}</td>
          <td className="text-right tabular-nums">{amountOrBlank(g.cr)}</td>
          <td className="text-right font-medium tabular-nums">{side(g.closing, 'dr')}</td>
          <td className="text-right font-medium tabular-nums">{side(g.closing, 'cr')}</td>
        </tr>
        {isOpen && (
          <>
            {subGroups.map((c) => renderGroup(c, level + 1))}
            {ledgers.map((l) => (
              <tr key={l.id} data-row tabIndex={-1}>
                <td>
                  <span style={{ paddingLeft: `${(level + 1) * 18 + 20}px` }} className="block">
                    <Link href={`/accounts/ledger?id=${l.id}&from=${from}&to=${to}`} className="text-primary hover:underline" data-row-open>
                      {l.name}
                    </Link>
                  </span>
                </td>
                <td className="text-muted-foreground text-right tabular-nums">{side(l.opening, 'dr')}</td>
                <td className="text-muted-foreground text-right tabular-nums">{side(l.opening, 'cr')}</td>
                <td className="text-muted-foreground text-right tabular-nums">{amountOrBlank(l.dr)}</td>
                <td className="text-muted-foreground text-right tabular-nums">{amountOrBlank(l.cr)}</td>
                <td className="text-right tabular-nums">{side(l.closing, 'dr')}</td>
                <td className="text-right tabular-nums">{side(l.closing, 'cr')}</td>
              </tr>
            ))}
          </>
        )}
      </Fragment>
    )
  }

  const fyStart = summary ? fyStartOf(to, summary.fyStartMonth) : ''
  const diff = tb?.openingDifference ?? 0

  return (
    <div className="space-y-5">
      <div className="page-header gap-3">
        <div className="min-w-0">
          <h1 className="page-title text-xl sm:text-2xl">Trial Balance</h1>
          <p className="page-subtitle hidden sm:block">Every group and ledger, with its opening, movement and closing</p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <button className="btn-ghost" onClick={() => void load()} disabled={loading} aria-label="Refresh">
            <RefreshCw size={15} className={loading ? 'animate-spin' : undefined} />
          </button>
          <ExportButton onExport={exportIt} disabled={loading || !tb} />
        </div>
      </div>

      <div className="glass-card flex flex-wrap items-center gap-2 p-3">
        <input type="date" className="form-input h-9 w-[150px]" value={from} max={to} onChange={(e) => setFrom(e.target.value)} aria-label="From" />
        <span className="text-muted-foreground text-xs">to</span>
        <input type="date" className="form-input h-9 w-[150px]" value={to} min={from} onChange={(e) => setTo(e.target.value || todayIst())} aria-label="To" />
        {fyStart && from !== fyStart && (
          <button type="button" className="btn-ghost h-9 px-2 text-xs" onClick={() => setFrom(fyStart)}>
            From 1 April
          </button>
        )}
        <div className="ml-auto flex items-center gap-2">
          <button type="button" className="btn-ghost h-9 px-2 text-xs" onClick={expandAll}>
            Open every group
          </button>
          <button type="button" className="btn-ghost h-9 px-2 text-xs" onClick={() => setOpen(new Set())}>
            Close all
          </button>
          <label className="text-muted-foreground flex items-center gap-1.5 text-xs">
            <input type="checkbox" checked={showEmpty} onChange={(e) => setShowEmpty(e.target.checked)} />
            Show ledgers with nothing
          </label>
        </div>
      </div>

      {error && (
        <div className="border-destructive/40 bg-destructive/5 flex items-start gap-3 rounded-lg border p-3">
          <AlertCircle size={16} className="text-destructive mt-0.5 shrink-0" />
          <p className="text-destructive text-sm">{error}</p>
        </div>
      )}
      {diff !== 0 && (
        <div className="border-accent/40 bg-accent/5 flex items-start gap-3 rounded-lg border p-3">
          <AlertTriangle size={16} className="text-accent mt-0.5 shrink-0" />
          <p className="text-sm">
            The opening balances do not agree: they are out by <span className="font-semibold tabular-nums">{drCr(diff)}</span>. Check the opening
            balances entered from the old books under Chart of Accounts.
          </p>
        </div>
      )}

      <div className="glass-card overflow-hidden p-0">
        {loading && !tb ? (
          <div className="space-y-2 p-4">
            {Array.from({ length: 8 }).map((_, i) => (
              <div key={i} className="skeleton h-9 w-full rounded-lg" />
            ))}
          </div>
        ) : tb ? (
          <div className="overflow-x-auto">
            <table className="data-table table-totals w-full min-w-[860px]">
              <thead>
                <tr>
                  <th rowSpan={2}>
                    <span className="flex items-center gap-1.5">
                      <Scale size={14} /> {day(tb.period.from)} to {day(tb.period.to)}
                    </span>
                  </th>
                  <th colSpan={2} className="text-center">
                    Opening
                  </th>
                  <th colSpan={2} className="text-center">
                    In the period
                  </th>
                  <th colSpan={2} className="text-center">
                    Closing
                  </th>
                </tr>
                <tr>
                  <th className="w-32 text-right">Dr ₹</th>
                  <th className="w-32 text-right">Cr ₹</th>
                  <th className="w-32 text-right">Debit ₹</th>
                  <th className="w-32 text-right">Credit ₹</th>
                  <th className="w-32 text-right">Dr ₹</th>
                  <th className="w-32 text-right">Cr ₹</th>
                </tr>
              </thead>
              <tbody>
                {tree.top.map((g) => renderGroup(g, 0))}
                {diff !== 0 && (
                  <tr>
                    <td className="text-accent italic">Difference in opening balances</td>
                    <td className="text-right tabular-nums">{diff < 0 ? inr(diff) : ''}</td>
                    <td className="text-right tabular-nums">{diff > 0 ? inr(diff) : ''}</td>
                    <td />
                    <td />
                    <td className="text-right tabular-nums">{diff < 0 ? inr(diff) : ''}</td>
                    <td className="text-right tabular-nums">{diff > 0 ? inr(diff) : ''}</td>
                  </tr>
                )}
              </tbody>
              <tfoot>
                <tr>
                  <td className="font-semibold">Grand total</td>
                  <td className="text-right font-semibold tabular-nums">{inr(Math.max(tb.totals.openingDr, tb.totals.openingCr))}</td>
                  <td className="text-right font-semibold tabular-nums">{inr(Math.max(tb.totals.openingDr, tb.totals.openingCr))}</td>
                  <td className="text-right font-semibold tabular-nums">{inr(tb.totals.dr)}</td>
                  <td className="text-right font-semibold tabular-nums">{inr(tb.totals.cr)}</td>
                  <td className="text-right font-semibold tabular-nums">{inr(Math.max(tb.totals.closingDr, tb.totals.closingCr))}</td>
                  <td className="text-right font-semibold tabular-nums">{inr(Math.max(tb.totals.closingDr, tb.totals.closingCr))}</td>
                </tr>
              </tfoot>
            </table>
          </div>
        ) : null}
      </div>
    </div>
  )
}
