'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { AlertCircle, BookText, FileSignature, Printer, RefreshCw } from 'lucide-react'
import { api, apiErrorMessage } from '@/lib/api'
import { ExportButton } from '@/components/tables/ExportButton'
import { asDate, asNumber, downloadRows, type ExportColumn, type ExportFormat } from '@/lib/export'
import { SmartSelect } from '@/components/ui/SmartSelect'
import { VoucherDialog } from '@/components/accounts/VoucherDialog'
import { VoucherView } from '@/components/accounts/VoucherView'
import { BILL_KIND_LABEL, KIND_BADGE, amountOrBlank, day, drCr, fyStartOf, inr, todayIst, type BillKind, type BooksSummary, type Ledger, type ManualKind, type VoucherKind } from '@/components/accounts/books'

interface StatementRow {
  lineId: string
  voucherId: string
  date: string
  kind: VoucherKind
  kindLabel: string
  voucherNo: string
  fromModule: boolean
  particulars: string
  narration: string | null
  chequeNo: string | null
  referenceNo: string | null
  costCentre: string | null
  bills: Array<{ kind: BillKind; billNo: string; amount: number }>
  debit: number
  credit: number
  balance: number
}

interface Statement {
  ledger: { id: string; name: string; billWise: boolean; partyType: string | null; group: { id: string; name: string; nature: string } }
  period: { from: string; to: string }
  opening: number
  totals: { dr: number; cr: number }
  closing: number
  rows: StatementRow[]
}

/**
 * One ledger, line by line: what it stood at when the period opened, every
 * voucher that touched it with the ledgers on the other side, the balance
 * after each, and where it closed. The cash book and every bank book are
 * this page for the cash ledger and each bank.
 *
 * ?id=<ledger>&from=&to= opens a ledger for a period; a row opens its voucher.
 */
export default function LedgerPage() {
  const [summary, setSummary] = useState<BooksSummary | null>(null)
  const [ledgers, setLedgers] = useState<Ledger[]>([])
  const [ledgerId, setLedgerId] = useState('')
  const [from, setFrom] = useState('')
  const [to, setTo] = useState(todayIst())
  const [data, setData] = useState<Statement | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [viewing, setViewing] = useState<string | null>(null)
  const [form, setForm] = useState<{ open: boolean; kind: ManualKind; id: string | null }>({ open: false, kind: 'PAYMENT', id: null })

  useEffect(() => {
    const p = new URLSearchParams(window.location.search)
    ;(async () => {
      try {
        const [s, l] = await Promise.all([api.get<{ data: BooksSummary }>('/accounts/summary'), api.get<{ data: Ledger[] }>('/accounts/ledgers')])
        setSummary(s.data)
        setLedgers(l.data)
        const start = s.data.booksStart && s.data.booksStart > s.data.fyStart ? s.data.booksStart : s.data.fyStart
        setFrom(p.get('from') ?? start)
        if (p.get('to')) setTo(p.get('to')!)
        setLedgerId(p.get('id') ?? l.data.find((x) => x.systemKey === 'CASH')?.id ?? '')
      } catch (err) {
        setError(apiErrorMessage(err, 'Could not load the ledgers.'))
      }
    })()
  }, [])

  const load = useCallback(async () => {
    if (!ledgerId || !from) return
    setLoading(true)
    setError(null)
    try {
      const res = await api.get<{ data: Statement }>(`/accounts/ledgers/${ledgerId}/statement?from=${from}&to=${to}`)
      setData(res.data)
      window.history.replaceState(null, '', `/accounts/ledger?id=${ledgerId}&from=${from}&to=${to}`)
    } catch (err) {
      setError(apiErrorMessage(err, 'Could not load the ledger.'))
      setData(null)
    } finally {
      setLoading(false)
    }
  }, [ledgerId, from, to])

  useEffect(() => {
    void load()
  }, [load])

  const grouped = useMemo(() => {
    const m = new Map<string, Ledger[]>()
    for (const l of ledgers) m.set(l.group.name, [...(m.get(l.group.name) ?? []), l])
    return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0]))
  }, [ledgers])

  const exportIt = async (format: ExportFormat) => {
    if (!data) return
    const columns: ExportColumn<StatementRow>[] = [
      { header: 'Date', value: (r) => asDate(r.date) },
      { header: 'Particulars', value: (r) => r.particulars },
      { header: 'Type', value: (r) => r.kindLabel },
      { header: 'Voucher No.', value: (r) => r.voucherNo },
      { header: 'Narration', value: (r) => r.narration ?? '' },
      { header: 'Debit', value: (r) => asNumber(r.debit) },
      { header: 'Credit', value: (r) => asNumber(r.credit) },
      { header: 'Balance', value: (r) => drCr(r.balance) },
    ]
    await downloadRows({ rows: data.rows, columns, name: `ledger-${data.ledger.name}-${from}-to-${to}`, sheet: 'Ledger', format })
  }

  const fyStart = summary ? fyStartOf(to, summary.fyStartMonth) : ''

  return (
    <div className="space-y-5">
      <div className="page-header gap-3">
        <div className="min-w-0">
          <h1 className="page-title text-xl sm:text-2xl">Ledger</h1>
          <p className="page-subtitle hidden sm:block">One account, voucher by voucher, with its running balance</p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <button className="btn-ghost" onClick={() => void load()} disabled={loading} aria-label="Refresh">
            <RefreshCw size={15} className={loading ? 'animate-spin' : undefined} />
          </button>
          {data && (
            <a className="btn-secondary" href={`/print/ledger-statement/${data.ledger.id}?from=${from}&to=${to}`} target="_blank" rel="noreferrer" title="This account for the period, to print or send">
              <Printer size={15} /> Print
            </a>
          )}
          {data?.ledger.partyType && (
            <a
              className="btn-secondary"
              href={`/print/ledger-statement/${data.ledger.id}?from=${from}&to=${to}&confirm=1`}
              target="_blank"
              rel="noreferrer"
              title="The statement with a request to sign and return the balance — what auditors ask for at the year end"
            >
              <FileSignature size={15} /> Confirmation
            </a>
          )}
          <ExportButton onExport={exportIt} disabled={loading || !data} />
        </div>
      </div>

      <div className="glass-card flex flex-col gap-2 p-3 sm:flex-row sm:flex-wrap sm:items-center">
        <SmartSelect className="form-input h-9 min-w-0 sm:w-[340px]" value={ledgerId} onChange={(e) => setLedgerId(e.target.value)}  aria-label="Ledger">
          <option value="">Choose a ledger</option>
          {grouped.map(([g, ls]) => (
            <optgroup key={g} label={g}>
              {ls.map((l) => (
                <option key={l.id} value={l.id} data-sub={l.partyCode ?? undefined}>
                  {l.name}
                </option>
              ))}
            </optgroup>
          ))}
        </SmartSelect>
        <div className="flex flex-wrap items-center gap-2">
          <input type="date" className="form-input h-9 w-[150px]" value={from} max={to} onChange={(e) => setFrom(e.target.value)} aria-label="From" />
          <span className="text-muted-foreground text-xs">to</span>
          <input type="date" className="form-input h-9 w-[150px]" value={to} min={from} onChange={(e) => setTo(e.target.value || todayIst())} aria-label="To" />
          {fyStart && from !== fyStart && (
            <button type="button" className="btn-ghost h-9 px-2 text-xs" onClick={() => setFrom(fyStart)}>
              From 1 April
            </button>
          )}
        </div>
      </div>

      {error && (
        <div className="border-destructive/40 bg-destructive/5 flex items-start gap-3 rounded-lg border p-3">
          <AlertCircle size={16} className="text-destructive mt-0.5 shrink-0" />
          <p className="text-destructive text-sm">{error}</p>
        </div>
      )}

      {data && (
        <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
          {[
            { label: `Opening on ${day(data.period.from)}`, value: drCr(data.opening) },
            { label: 'Debits in the period', value: `₹${inr(data.totals.dr)}` },
            { label: 'Credits in the period', value: `₹${inr(data.totals.cr)}` },
            { label: `Closing on ${day(data.period.to)}`, value: drCr(data.closing) },
          ].map((c) => (
            <div key={c.label} className="glass-card p-3">
              <p className="text-muted-foreground text-[11px] leading-tight">{c.label}</p>
              <p className="text-foreground mt-0.5 text-lg font-semibold tabular-nums leading-tight">{c.value}</p>
            </div>
          ))}
        </div>
      )}

      <div className="glass-card overflow-hidden p-0">
        {data && (
          <div className="border-border flex flex-wrap items-center justify-between gap-2 border-b px-4 py-2.5">
            <p className="text-foreground text-sm font-semibold">
              {data.ledger.name} <span className="text-muted-foreground font-normal">· {data.ledger.group.name}</span>
            </p>
            <p className="text-muted-foreground text-xs">{data.rows.length} entries</p>
          </div>
        )}
        {!ledgerId ? (
          <div className="flex flex-col items-center gap-2 px-4 py-14 text-center">
            <BookText size={28} className="text-muted-foreground" />
            <p className="text-foreground text-sm font-medium">Choose a ledger to see its entries</p>
          </div>
        ) : loading && !data ? (
          <div className="space-y-2 p-4">
            {Array.from({ length: 6 }).map((_, i) => (
              <div key={i} className="skeleton h-10 w-full rounded-lg" />
            ))}
          </div>
        ) : data ? (
          <div className="overflow-x-auto">
            <table className="data-table table-totals w-full">
              <thead>
                <tr>
                  <th className="w-28">Date</th>
                  <th>Particulars</th>
                  <th className="w-40">Voucher</th>
                  <th className="w-32 text-right">Debit ₹</th>
                  <th className="w-32 text-right">Credit ₹</th>
                  <th className="w-40 text-right">Balance</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td className="whitespace-nowrap tabular-nums">{day(data.period.from)}</td>
                  <td className="text-muted-foreground italic" colSpan={4}>
                    Opening balance
                  </td>
                  <td className="text-right font-medium tabular-nums">{drCr(data.opening)}</td>
                </tr>
                {data.rows.map((r, i) => (
                  <tr key={r.lineId} data-row tabIndex={i === 0 ? 0 : -1} className="cursor-pointer" onClick={() => setViewing(r.voucherId)}>
                    <td className="whitespace-nowrap tabular-nums">{day(r.date)}</td>
                    <td className="max-w-[360px]">
                      <p className="text-foreground truncate">{r.particulars}</p>
                      {(r.narration || r.chequeNo || r.bills.length > 0 || r.costCentre) && (
                        <p className="text-muted-foreground truncate text-[11px]">
                          {[
                            r.narration,
                            r.chequeNo ? `Chq ${r.chequeNo}` : null,
                            r.costCentre,
                            r.bills.map((b) => `${BILL_KIND_LABEL[b.kind]} ${b.billNo}`).join(', ') || null,
                          ]
                            .filter(Boolean)
                            .join(' · ')}
                        </p>
                      )}
                    </td>
                    <td>
                      <span className="text-foreground font-mono text-xs">{r.voucherNo}</span>
                      <div className="mt-0.5">
                        <span className={KIND_BADGE[r.kind]}>{r.kindLabel}</span>
                      </div>
                    </td>
                    <td className="text-right tabular-nums">{amountOrBlank(r.debit)}</td>
                    <td className="text-right tabular-nums">{amountOrBlank(r.credit)}</td>
                    <td className="text-right tabular-nums">{drCr(r.balance)}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <td />
                  <td className="text-muted-foreground text-xs">Total for the period</td>
                  <td />
                  <td className="text-right font-semibold tabular-nums">{inr(data.totals.dr)}</td>
                  <td className="text-right font-semibold tabular-nums">{inr(data.totals.cr)}</td>
                  <td className="text-right font-semibold tabular-nums">{drCr(data.closing)}</td>
                </tr>
              </tfoot>
            </table>
          </div>
        ) : null}
      </div>

      <VoucherView
        voucherId={viewing}
        onClose={() => setViewing(null)}
        onAlter={(id, k) => {
          setViewing(null)
          setForm({ open: true, kind: k, id })
        }}
        onChanged={() => void load()}
        onOpenLedger={(id) => {
          setViewing(null)
          setLedgerId(id)
        }}
      />
      <VoucherDialog
        open={form.open}
        kind={form.kind}
        voucherId={form.id}
        booksStart={summary?.booksStart ?? null}
        onClose={() => setForm((f) => ({ ...f, open: false, id: null }))}
        onSaved={() => void load()}
      />
    </div>
  )
}
