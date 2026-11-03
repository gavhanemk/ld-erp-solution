'use client'

import { Fragment, useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { AlertCircle, ChevronDown, ChevronRight, FileSignature, HandCoins, Printer, RefreshCw, Search, Wallet } from 'lucide-react'
import { api, apiErrorMessage } from '@/lib/api'
import { ExportButton } from '@/components/tables/ExportButton'
import { asDate, asNumber, downloadRows, type ExportColumn, type ExportFormat } from '@/lib/export'
import { SOURCE_LABEL, amountOrBlank, day, inr, todayIst } from '@/components/accounts/books'

type Side = 'receivable' | 'payable'
type Bucket = 'notDue' | 'd30' | 'd60' | 'd90' | 'over90'
const BUCKETS: Array<[Bucket, string]> = [
  ['notDue', 'Not yet due'],
  ['d30', '1–30 days'],
  ['d60', '31–60 days'],
  ['d90', '61–90 days'],
  ['over90', 'Over 90 days'],
]

interface Bill {
  billNo: string
  billDate: string
  dueDate: string | null
  days: number
  amount: number
  kind: 'bill' | 'advance' | 'unsplit'
  raisedBy: string | null
}

interface Party {
  ledgerId: string
  name: string
  partyType: string | null
  partyCode: string | null
  group: string
  bills: Bill[]
  buckets: Record<Bucket, number>
  due: number
  overdue: number
  advance: number
  net: number
}

interface Data {
  side: Side
  asOn: string
  parties: Party[]
  summary: { parties: number; due: number; overdue: number; advance: number; net: number; buckets: Record<Bucket, number> }
}

/** Where a bill came from, in words. */
const origin = (b: Bill) =>
  b.kind === 'unsplit'
    ? 'Opening balance'
    : b.raisedBy === 'ACCOUNTS'
      ? 'Accounts voucher'
      : b.raisedBy
        ? SOURCE_LABEL[b.raisedBy] ?? 'Document'
        : b.kind === 'advance'
          ? 'Old advance'
          : 'Old bill'

/**
 * What customers owe, and what is owed to suppliers and brokers, bill by bill
 * and aged — from the books, so the bills brought in from the old books are
 * here beside this ERP's own.
 *
 * Each row is a party: what is due in each age, any advance, and the net,
 * which is its ledger balance. Open a row for its bills; the name opens its
 * ledger.
 */
export default function OutstandingPage() {
  const [side, setSide] = useState<Side>('receivable')
  const [asOn, setAsOn] = useState(todayIst())
  const [data, setData] = useState<Data | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [overdueOnly, setOverdueOnly] = useState(false)
  const [open, setOpen] = useState<string | null>(null)

  useEffect(() => {
    const p = new URLSearchParams(window.location.search)
    if (p.get('side') === 'payable') setSide('payable')
  }, [])

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      setData((await api.get<{ data: Data }>(`/accounts/outstanding?side=${side}&asOn=${asOn}`)).data)
    } catch (err) {
      setError(apiErrorMessage(err, 'Could not work out what is outstanding.'))
    } finally {
      setLoading(false)
    }
  }, [side, asOn])

  useEffect(() => {
    void load()
  }, [load])

  const shown = useMemo(() => {
    const q = search.trim().toLowerCase()
    return (data?.parties ?? []).filter((p) => (!q || p.name.toLowerCase().includes(q) || (p.partyCode ?? '').toLowerCase().includes(q)) && (!overdueOnly || p.overdue > 0))
  }, [data, search, overdueOnly])

  const exportIt = async (format: ExportFormat) => {
    type Row = { party: string; code: string; bill: string; date: string; due: string | null; days: number | null; amount: number; from: string }
    const rows: Row[] = shown.flatMap((p) =>
      p.bills.map((b) => ({ party: p.name, code: p.partyCode ?? '', bill: b.billNo, date: b.billDate, due: b.dueDate, days: b.kind === 'bill' ? b.days : null, amount: b.amount, from: origin(b) })),
    )
    const columns: ExportColumn<Row>[] = [
      { header: 'Party', value: (r) => r.party },
      { header: 'Code', value: (r) => r.code },
      { header: 'Bill', value: (r) => r.bill },
      { header: 'Bill date', value: (r) => asDate(r.date) },
      { header: 'Due date', value: (r) => asDate(r.due) },
      { header: 'Days past due', value: (r) => r.days },
      { header: side === 'receivable' ? 'Owed to us' : 'Owed by us', value: (r) => asNumber(r.amount) },
      { header: 'From', value: (r) => r.from },
    ]
    await downloadRows({ rows, columns, name: `${side}-as-on-${asOn}`, sheet: side === 'receivable' ? 'Receivables' : 'Payables', format })
  }

  const s = data?.summary
  const label = side === 'receivable' ? { due: 'Owed to us', advance: 'Paid to us in advance', who: 'customers' } : { due: 'Owed by us', advance: 'Paid by us in advance', who: 'suppliers and brokers' }
  const total = (k: 'due' | 'overdue' | 'advance' | 'net') => shown.reduce((t, p) => t + p[k], 0)
  const totalBucket = (k: Bucket) => shown.reduce((t, p) => t + p.buckets[k], 0)

  return (
    <div className="space-y-5">
      <div className="page-header gap-3">
        <div className="flex min-w-0 flex-wrap items-center gap-4">
          <div className="min-w-0">
            <h1 className="page-title text-xl sm:text-2xl">Outstanding</h1>
            <p className="page-subtitle hidden sm:block">Bill by bill and aged, old bills included</p>
          </div>
          <div className="border-border bg-secondary flex rounded-lg border p-1" role="tablist">
            {(
              [
                { key: 'receivable', label: 'Receivable', icon: HandCoins },
                { key: 'payable', label: 'Payable', icon: Wallet },
              ] as const
            ).map((t) => (
              <button
                key={t.key}
                type="button"
                role="tab"
                aria-selected={side === t.key}
                onClick={() => {
                  setSide(t.key)
                  setOpen(null)
                }}
                className={`flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm transition-colors ${
                  side === t.key ? 'bg-card text-foreground font-medium shadow-sm' : 'text-muted-foreground hover:text-foreground'
                }`}
              >
                <t.icon size={15} />
                {t.label}
              </button>
            ))}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <button className="btn-ghost" onClick={() => void load()} disabled={loading} aria-label="Refresh">
            <RefreshCw size={15} className={loading ? 'animate-spin' : undefined} />
          </button>
          <ExportButton onExport={exportIt} disabled={loading || !data} />
        </div>
      </div>

      {error && (
        <div className="border-destructive/40 bg-destructive/5 flex items-start gap-3 rounded-lg border p-3">
          <AlertCircle size={16} className="text-destructive mt-0.5 shrink-0" />
          <p className="text-destructive text-sm">{error}</p>
        </div>
      )}

      {s && (
        <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
          {[
            { label: label.due, value: `₹${inr(s.due)}`, tone: 'text-foreground', press: () => setOverdueOnly(false) },
            { label: 'Past the due date', value: `₹${inr(s.overdue)}`, tone: s.overdue > 0 ? 'text-destructive' : 'text-muted-foreground', press: () => setOverdueOnly(!overdueOnly) },
            { label: label.advance, value: `₹${inr(s.advance)}`, tone: 'text-foreground', press: undefined },
            { label: `Net, ${s.parties} ${label.who}`, value: `₹${inr(s.net)}${s.net < 0 ? ' the other way' : ''}`, tone: 'text-foreground', press: undefined },
          ].map((c) => (
            <button
              key={c.label}
              type="button"
              onClick={c.press}
              disabled={!c.press}
              aria-pressed={c.label === 'Past the due date' ? overdueOnly : undefined}
              className={`glass-card p-3 text-left ${c.press ? 'hover:bg-secondary/40 cursor-pointer' : 'cursor-default'} ${c.label === 'Past the due date' && overdueOnly ? 'ring-primary bg-primary/5 ring-2' : ''}`}
            >
              <p className="text-muted-foreground text-[11px] leading-tight">{c.label}</p>
              <p className={`mt-0.5 text-lg font-semibold tabular-nums leading-tight ${c.tone}`}>{c.value}</p>
            </button>
          ))}
        </div>
      )}

      <div className="glass-card overflow-hidden p-0">
        <div className="border-border flex flex-col gap-2 border-b px-3 py-2 sm:flex-row sm:flex-wrap sm:items-center">
          <div className="border-field-edge bg-field flex min-w-0 flex-1 items-center gap-2 rounded-lg border px-2.5 py-1.5 sm:max-w-[280px]">
            <Search size={14} className="text-muted-foreground shrink-0" />
            <input
              className="text-foreground placeholder:text-muted-foreground w-full bg-transparent text-sm outline-none"
              placeholder="Party or code"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              data-hotkey="search"
              aria-label="Search parties"
            />
          </div>
          <label className="text-muted-foreground flex items-center gap-2 text-xs">
            As on
            <input type="date" className="form-input h-9 w-[150px]" value={asOn} max={todayIst()} onChange={(e) => setAsOn(e.target.value || todayIst())} />
          </label>
          <label className="text-muted-foreground flex items-center gap-1.5 text-xs">
            <input type="checkbox" checked={overdueOnly} onChange={(e) => setOverdueOnly(e.target.checked)} />
            Only those past due
          </label>
        </div>

        {loading && !data ? (
          <div className="space-y-2 p-4">
            {Array.from({ length: 6 }).map((_, i) => (
              <div key={i} className="skeleton h-10 w-full rounded-lg" />
            ))}
          </div>
        ) : shown.length === 0 ? (
          <p className="text-muted-foreground px-4 py-14 text-center text-sm">Nothing outstanding{overdueOnly ? ' past its due date' : ''} as on {day(asOn)}.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="data-table table-totals w-full min-w-[980px]">
              <thead>
                <tr>
                  <th>Party</th>
                  {BUCKETS.map(([k, l]) => (
                    <th key={k} className="w-28 text-right">
                      {l}
                    </th>
                  ))}
                  <th className="w-28 text-right">Advance</th>
                  <th className="w-32 text-right">Net</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((p, i) => {
                  const isOpen = open === p.ledgerId
                  return (
                    <Fragment key={p.ledgerId}>
                      <tr data-row tabIndex={i === 0 ? 0 : -1} className="cursor-pointer" onClick={() => setOpen(isOpen ? null : p.ledgerId)}>
                        <td>
                          <span className="flex items-center gap-1.5">
                            {isOpen ? <ChevronDown size={14} className="text-muted-foreground" /> : <ChevronRight size={14} className="text-muted-foreground" />}
                            <Link
                              href={`/accounts/ledger?id=${p.ledgerId}&to=${asOn}`}
                              className="text-primary hover:underline"
                              onClick={(e) => e.stopPropagation()}
                            >
                              {p.name}
                            </Link>
                          </span>
                          <span className="text-muted-foreground block pl-5 text-[11px]">
                            {[p.partyCode, p.group, `${p.bills.length} ${p.bills.length === 1 ? 'item' : 'items'}`].filter(Boolean).join(' · ')}
                          </span>
                        </td>
                        {BUCKETS.map(([k]) => (
                          <td key={k} className={`text-right tabular-nums ${k === 'over90' && p.buckets[k] > 0 ? 'text-destructive' : ''}`}>
                            {amountOrBlank(p.buckets[k])}
                          </td>
                        ))}
                        <td className="text-muted-foreground text-right tabular-nums">{amountOrBlank(p.advance)}</td>
                        <td className="whitespace-nowrap text-right font-semibold tabular-nums">{inr(p.net)}{p.net < 0 ? ' ↺' : ''}</td>
                      </tr>
                      {isOpen && (
                        <tr>
                          <td colSpan={8} className="bg-secondary/30 pt-0">
                            <table className="subtable w-full">
                              <thead>
                                <tr>
                                  <th>Bill</th>
                                  <th>Dated</th>
                                  <th>Due</th>
                                  <th className="text-right">Days past due</th>
                                  <th>From</th>
                                  <th className="text-right">Amount ₹</th>
                                </tr>
                              </thead>
                              <tbody>
                                {p.bills.map((b) => (
                                  <tr key={b.billNo}>
                                    <td className="font-mono text-xs">{b.billNo}</td>
                                    <td className="tabular-nums">{b.kind === 'unsplit' ? '—' : day(b.billDate)}</td>
                                    <td className="tabular-nums">{b.dueDate ? day(b.dueDate) : '—'}</td>
                                    <td className={`text-right tabular-nums ${b.kind === 'bill' && b.days > 90 ? 'text-destructive' : ''}`}>{b.kind === 'bill' && b.days > 0 ? b.days : ''}</td>
                                    <td className="text-muted-foreground">{origin(b)}</td>
                                    <td className="text-right tabular-nums">
                                      {inr(b.amount)}
                                      {b.amount < 0 ? ' advance' : ''}
                                    </td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                            <div className="flex flex-wrap items-center gap-2 px-2 pb-2 pt-1">
                              <a className="btn-secondary h-8 px-3 text-xs" href={`/print/ledger-statement/${p.ledgerId}?to=${asOn}`} target="_blank" rel="noreferrer">
                                <Printer size={13} /> Print statement
                              </a>
                              <a
                                className="btn-secondary h-8 px-3 text-xs"
                                href={`/print/ledger-statement/${p.ledgerId}?to=${asOn}&confirm=1`}
                                target="_blank"
                                rel="noreferrer"
                                title="The statement with a request to sign and return the balance"
                              >
                                <FileSignature size={13} /> Confirmation letter
                              </a>
                            </div>
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  )
                })}
              </tbody>
              <tfoot>
                <tr>
                  <td className="font-semibold">Total of {shown.length === 1 ? '1 party' : `${shown.length} parties`}</td>
                  {BUCKETS.map(([k]) => (
                    <td key={k} className="text-right font-semibold tabular-nums">
                      {amountOrBlank(totalBucket(k))}
                    </td>
                  ))}
                  <td className="text-right font-semibold tabular-nums">{amountOrBlank(total('advance'))}</td>
                  <td className="text-right font-semibold tabular-nums">{inr(total('net'))}</td>
                </tr>
              </tfoot>
            </table>
          </div>
        )}
      </div>
      <p className="text-muted-foreground text-xs">
        Days are counted from the due date, or the bill date where there is none. A net marked ↺ runs the other way: the party holds more advance than it owes.
        {side === 'receivable' ? ' Old bills are settled from an Accounts Receipt; invoices from Sales → Payments Received.' : ' Old bills are settled from an Accounts Payment; bills from Purchase → Supplier Payments.'}
      </p>
    </div>
  )
}
