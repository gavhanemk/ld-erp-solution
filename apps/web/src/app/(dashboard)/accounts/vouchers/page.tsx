'use client'

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { AlertCircle, BookOpen, FileInput, Loader2, Plus, RefreshCw, Search, Settings2 } from 'lucide-react'
import { api, apiErrorMessage, can } from '@/lib/api'
import { Pagination } from '@/components/tables/Pagination'
import { ExportButton } from '@/components/tables/ExportButton'
import { asDate, asNumber, downloadRows, fetchEveryPage, type ExportColumn, type ExportFormat } from '@/lib/export'
import { SmartSelect } from '@/components/ui/SmartSelect'
import { VoucherDialog } from '@/components/accounts/VoucherDialog'
import { VoucherView } from '@/components/accounts/VoucherView'
import { KIND_BADGE, KIND_LABEL, SOURCE_LABEL, day, inr, sourceLink, todayIst, type BooksSummary, type ManualKind, type VoucherKind } from '@/components/accounts/books'

interface Waiting {
  sourceType: string
  number: string
  date: string
  party: string
  amount: number
  reason: 'missing' | 'cancel' | 'reopen' | 'before-start'
}

const WHY: Record<Waiting['reason'], string> = {
  missing: 'not in the books',
  cancel: 'cancelled, voucher still standing',
  reopen: 'live again, voucher cancelled',
  'before-start': 'dated before the books start',
}

interface Row {
  id: string
  kind: VoucherKind
  kindLabel: string
  voucherNo: string
  date: string
  narration: string | null
  amount: number
  status: 'POSTED' | 'CANCELLED'
  sourceType: string | null
  chequeNo: string | null
  referenceNo: string | null
  createdBy: { name: string } | null
  lines: Array<{ ledgerId: string; ledger: string; debit: number; credit: number; costCentre: string | null }>
}

interface ListResponse {
  data: Row[]
  totalAmount: number
  period: { from: string; to: string }
  pagination: { page: number; limit: number; total: number; pages: number }
}

const LIMIT = 50
/** The first of last month: the day book opens on this month and the last, so the 1st of a month is not an empty page. */
const periodStart = () => {
  const t = todayIst()
  const y = Number(t.slice(0, 4))
  const m = Number(t.slice(5, 7))
  return m === 1 ? `${y - 1}-12-01` : `${y}-${String(m - 1).padStart(2, '0')}-01`
}

/**
 * The day book: every voucher in a period, as it went into the books, oldest
 * first. Each row names the ledgers it debited and credited; clicking one
 * opens it, with its history and, for one typed here, Alter and Cancel.
 *
 * New voucher (Alt+N) opens a Payment; F4–F7 in that window switch to Contra,
 * Payment, Receipt or Journal. Links in: ?new=RECEIPT opens that type,
 * ?open=<id> opens a voucher, ?ledger=<id> shows only that ledger's vouchers.
 */
export default function DayBookPage() {
  const [summary, setSummary] = useState<BooksSummary | null>(null)
  const [rows, setRows] = useState<Row[]>([])
  const [total, setTotal] = useState(0)
  const [totalAmount, setTotalAmount] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)

  const [from, setFrom] = useState(periodStart())
  const [to, setTo] = useState(todayIst())
  const [kind, setKind] = useState('')
  const [status, setStatus] = useState('')
  const [search, setSearch] = useState('')
  const [debounced, setDebounced] = useState('')
  const [ledgerId, setLedgerId] = useState('')
  const [page, setPage] = useState(1)

  const [form, setForm] = useState<{ open: boolean; kind: ManualKind; id: string | null }>({ open: false, kind: 'PAYMENT', id: null })
  const [viewing, setViewing] = useState<string | null>(null)
  const mayCreate = can('accounts', 'create')

  // Sales and Purchase documents whose voucher does not match them yet.
  const [waiting, setWaiting] = useState<{ count: number; pending: Waiting[] } | null>(null)
  const [showWaiting, setShowWaiting] = useState(false)
  const [bringing, setBringing] = useState(false)
  const loadWaiting = useCallback(() => {
    api
      .get<{ data: { count: number; pending: Waiting[] } }>('/accounts/posting')
      .then((r) => setWaiting(r.data))
      .catch(() => setWaiting(null))
  }, [])
  useEffect(() => loadWaiting(), [loadWaiting])

  useEffect(() => {
    const p = new URLSearchParams(window.location.search)
    const n = p.get('new') as ManualKind | null
    if (n && ['PAYMENT', 'RECEIPT', 'CONTRA', 'JOURNAL'].includes(n) && can('accounts', 'create')) setForm({ open: true, kind: n, id: null })
    if (p.get('open')) setViewing(p.get('open'))
    if (p.get('ledger')) setLedgerId(p.get('ledger')!)
    if (p.get('from')) setFrom(p.get('from')!)
    if (p.get('to')) setTo(p.get('to')!)
    api
      .get<{ data: BooksSummary }>('/accounts/summary')
      .then((r) => setSummary(r.data))
      .catch(() => undefined)
  }, [])

  useEffect(() => {
    const t = setTimeout(() => setDebounced(search), 350)
    return () => clearTimeout(t)
  }, [search])

  useEffect(() => setPage(1), [from, to, kind, status, debounced, ledgerId])

  const url = useCallback(
    (p: number, limit: number) => {
      const qs = new URLSearchParams({ from, to, page: String(p), limit: String(limit) })
      if (kind) qs.set('kind', kind)
      if (status) qs.set('status', status)
      if (debounced) qs.set('q', debounced)
      if (ledgerId) qs.set('ledgerId', ledgerId)
      return `/accounts/vouchers?${qs}`
    },
    [from, to, kind, status, debounced, ledgerId],
  )

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await api.get<ListResponse>(url(page, LIMIT))
      setRows(res.data)
      setTotal(res.pagination.total)
      setTotalAmount(res.totalAmount)
    } catch (err) {
      setError(apiErrorMessage(err, 'Could not load the day book.'))
      setRows([])
    } finally {
      setLoading(false)
    }
  }, [url, page])

  useEffect(() => {
    void load()
  }, [load])

  const COLUMNS: ExportColumn<Row>[] = [
    { header: 'Date', value: (r) => asDate(r.date) },
    { header: 'Voucher No.', value: (r) => r.voucherNo },
    { header: 'Type', value: (r) => r.kindLabel },
    { header: 'Debit', value: (r) => r.lines.filter((l) => l.debit > 0).map((l) => l.ledger).join(', ') },
    { header: 'Credit', value: (r) => r.lines.filter((l) => l.credit > 0).map((l) => l.ledger).join(', ') },
    { header: 'Narration', value: (r) => r.narration ?? '' },
    { header: 'Amount', value: (r) => asNumber(r.amount) },
    { header: 'Status', value: (r) => (r.status === 'CANCELLED' ? 'Cancelled' : 'Posted') },
  ]

  const exportList = async (format: ExportFormat) => {
    try {
      const { rows: all } = await fetchEveryPage<Row>((p) => url(p, 200))
      if (!all.length) {
        setMessage('Nothing to export — no vouchers in this period.')
        return
      }
      await downloadRows({ rows: all, columns: COLUMNS, name: `day-book-${from}-to-${to}`, sheet: 'Day Book', format })
    } catch (err) {
      setError(apiErrorMessage(err, 'Could not build the export.'))
    }
  }

  const pages = Math.ceil(total / LIMIT) || 1
  const notStarted = summary && !summary.booksStart

  const bringIn = async () => {
    setBringing(true)
    setError(null)
    try {
      const res = await api.post<{ message: string; data: { failed: Array<{ label: string; number: string; reason: string }> } }>('/accounts/posting/run', {})
      const failed = res.data.failed
      setMessage(failed.length ? `${res.message} First: ${failed[0].label} ${failed[0].number} — ${failed[0].reason}` : res.message)
      loadWaiting()
      void load()
    } catch (err) {
      setError(apiErrorMessage(err, 'Could not bring the documents into the books.'))
    } finally {
      setBringing(false)
    }
  }

  return (
    <div className="space-y-5">
      <div className="page-header gap-3">
        <div className="min-w-0">
          <h1 className="page-title text-xl sm:text-2xl">Day Book</h1>
          <p className="page-subtitle hidden sm:block">Every voucher, day by day, as it went into the books</p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <button className="btn-ghost" onClick={() => void load()} disabled={loading} aria-label="Refresh">
            <RefreshCw size={15} className={loading ? 'animate-spin' : undefined} />
          </button>
          <ExportButton onExport={exportList} disabled={loading} />
          {mayCreate && (
            <button className="btn-primary" onClick={() => setForm({ open: true, kind: 'PAYMENT', id: null })} data-hotkey="new" aria-keyshortcuts="Alt+N" disabled={!!notStarted}>
              <Plus size={15} /> <span className="hidden sm:inline">New voucher</span>
            </button>
          )}
        </div>
      </div>

      {notStarted && (
        <div className="border-accent/40 bg-accent/5 flex flex-wrap items-center justify-between gap-3 rounded-lg border p-3">
          <p className="text-sm">
            <span className="font-medium">The books have no start date yet.</span> Set the day they start before entering vouchers — nothing can be dated before it.
          </p>
          <Link href="/accounts/chart?tab=settings" className="btn-secondary h-8 px-3 text-xs">
            <Settings2 size={14} /> Set it
          </Link>
        </div>
      )}
      {!notStarted && waiting && waiting.count > 0 && (
        <div className="border-accent/40 bg-accent/5 rounded-lg border p-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-sm">
              <span className="font-medium">
                {waiting.count} {waiting.count === 1 ? 'document' : 'documents'} from Sales and Purchase {waiting.count === 1 ? 'is' : 'are'} not in the books yet.
              </span>{' '}
              Every new invoice, bill, receipt and payment goes in as it is saved; these were saved before, or while something was wrong.
            </p>
            <div className="flex items-center gap-2">
              <button type="button" className="btn-ghost h-8 px-2 text-xs" onClick={() => setShowWaiting((s) => !s)}>
                {showWaiting ? 'Hide them' : 'See which'}
              </button>
              {can('accounts', 'edit') && (
                <button type="button" className="btn-secondary h-8 px-3 text-xs" onClick={() => void bringIn()} disabled={bringing}>
                  {bringing ? <Loader2 size={14} className="animate-spin" /> : <FileInput size={14} />} Bring them in
                </button>
              )}
            </div>
          </div>
          {showWaiting && (
            <ul className="border-border mt-2 max-h-60 space-y-1 overflow-y-auto border-t pt-2 text-xs">
              {waiting.pending.map((w) => (
                <li key={`${w.sourceType}:${w.number}`} className="flex flex-wrap items-center gap-x-3 gap-y-0.5">
                  <span className="text-muted-foreground w-24 tabular-nums">{day(w.date)}</span>
                  <Link href={sourceLink(w.sourceType, w.number)} className="text-primary font-mono hover:underline">
                    {w.number}
                  </Link>
                  <span className="text-muted-foreground">{SOURCE_LABEL[w.sourceType] ?? w.sourceType}</span>
                  <span className="text-foreground">{w.party}</span>
                  <span className="tabular-nums">₹{inr(w.amount)}</span>
                  <span className="text-muted-foreground">— {WHY[w.reason]}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
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

      <div className="glass-card overflow-hidden p-0">
        <div className="border-border flex flex-col gap-2 border-b px-3 py-2 sm:flex-row sm:flex-wrap sm:items-center">
          <div className="border-field-edge bg-field flex min-w-0 flex-1 items-center gap-2 rounded-lg border px-2.5 py-1.5 sm:max-w-[280px]">
            <Search size={14} className="text-muted-foreground shrink-0" />
            <input
              className="text-foreground placeholder:text-muted-foreground w-full bg-transparent text-sm outline-none"
              placeholder="Voucher no., ledger, narration, cheque"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              data-hotkey="search"
              aria-label="Search vouchers"
            />
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <input type="date" className="form-input h-9 w-[150px]" value={from} max={to} onChange={(e) => setFrom(e.target.value || periodStart())} aria-label="From" />
            <span className="text-muted-foreground text-xs">to</span>
            <input type="date" className="form-input h-9 w-[150px]" value={to} min={from} max={todayIst()} onChange={(e) => setTo(e.target.value || todayIst())} aria-label="To" />
            <SmartSelect className="form-input h-9 w-[150px]" value={kind} onChange={(e) => setKind(e.target.value)} aria-label="Voucher type">
              <option value="">Every type</option>
              {(Object.keys(KIND_LABEL) as VoucherKind[]).map((k) => (
                <option key={k} value={k}>
                  {KIND_LABEL[k]}
                </option>
              ))}
            </SmartSelect>
            <SmartSelect className="form-input h-9 w-[150px]" value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Status">
              <option value="">In the books</option>
              <option value="all">With cancelled</option>
              <option value="cancelled">Cancelled only</option>
            </SmartSelect>
            {ledgerId && (
              <button type="button" className="btn-ghost h-9 px-2 text-xs" onClick={() => setLedgerId('')}>
                One ledger only ✕
              </button>
            )}
          </div>
          <p className="text-muted-foreground text-xs sm:ml-auto">
            {total} {total === 1 ? 'voucher' : 'vouchers'} · ₹{inr(totalAmount)}
          </p>
        </div>

        {loading && rows.length === 0 ? (
          <div className="space-y-2 p-4">
            {Array.from({ length: 6 }).map((_, i) => (
              <div key={i} className="skeleton h-10 w-full rounded-lg" />
            ))}
          </div>
        ) : rows.length === 0 ? (
          <div className="flex flex-col items-center gap-2 px-4 py-14 text-center">
            <BookOpen size={28} className="text-muted-foreground" />
            <p className="text-foreground text-sm font-medium">No vouchers from {day(from)} to {day(to)}</p>
            <p className="text-muted-foreground text-xs">Entered vouchers show here, day by day.</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="data-table w-full">
              <thead>
                <tr>
                  <th className="w-28">Date</th>
                  <th className="w-36">Voucher</th>
                  <th>Debit</th>
                  <th>Credit</th>
                  <th className="hidden lg:table-cell">Narration</th>
                  <th className="w-36 text-right">Amount ₹</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => {
                  const dr = r.lines.filter((l) => l.debit > 0)
                  const cr = r.lines.filter((l) => l.credit > 0)
                  const names = (ls: Row['lines']) => (ls.length <= 2 ? ls.map((l) => l.ledger).join(', ') : `${ls[0].ledger} + ${ls.length - 1} more`)
                  return (
                    <tr
                      key={r.id}
                      data-row
                      tabIndex={i === 0 ? 0 : -1}
                      onClick={() => setViewing(r.id)}
                      className={`cursor-pointer ${r.status === 'CANCELLED' ? 'opacity-60' : ''}`}
                    >
                      <td className="whitespace-nowrap tabular-nums">{day(r.date)}</td>
                      <td>
                        <span className="text-foreground font-mono text-xs">{r.voucherNo}</span>
                        <div className="mt-0.5 flex items-center gap-1">
                          <span className={KIND_BADGE[r.kind]}>{r.kindLabel}</span>
                          {r.status === 'CANCELLED' && <span className="badge-danger">Cancelled</span>}
                        </div>
                      </td>
                      <td className="max-w-[220px] truncate">{names(dr)}</td>
                      <td className="max-w-[220px] truncate">{names(cr)}</td>
                      <td className="text-muted-foreground hidden max-w-[280px] truncate lg:table-cell">{r.narration ?? ''}</td>
                      <td className={`text-right font-medium tabular-nums ${r.status === 'CANCELLED' ? 'line-through' : ''}`}>{inr(r.amount)}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
        <Pagination page={page} pages={pages} onPageChange={setPage} busy={loading} />
      </div>

      <VoucherDialog
        open={form.open}
        kind={form.kind}
        voucherId={form.id}
        booksStart={summary?.booksStart ?? null}
        onClose={() => setForm((f) => ({ ...f, open: false, id: null }))}
        onSaved={(msg) => {
          setMessage(msg)
          void load()
        }}
      />
      <VoucherView
        voucherId={viewing}
        onClose={() => setViewing(null)}
        onAlter={(id, k) => {
          setViewing(null)
          setForm({ open: true, kind: k, id })
        }}
        onChanged={(msg) => {
          setMessage(msg)
          void load()
        }}
        onOpenLedger={(id) => {
          window.location.href = `/accounts/ledger?id=${id}&from=${from}&to=${to}`
        }}
      />
    </div>
  )
}
