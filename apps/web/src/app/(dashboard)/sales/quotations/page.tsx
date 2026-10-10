'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { AlertCircle, CalendarDays, Info, Pencil, Plus, Printer, RefreshCw, Search, Send, ShoppingBag, ThumbsDown } from 'lucide-react'
import { api, ApiError, can, type Paginated } from '@/lib/api'
import { Pagination } from '@/components/tables/Pagination'
import { ActionMenu, type RowAction } from '@/components/tables/ActionMenu'
import { useAppSettings } from '@/lib/appSettings'
import { formatCurrency, formatDate } from '@/lib/utils'
import { SmartSelect } from '@/components/ui/SmartSelect'
import { ReasonDialog } from '@/components/ui/ReasonDialog'
import { QuotationDialog } from '@/components/sales/QuotationDialog'

interface QuoteRow {
  id: string
  quoteNumber: string
  quoteDate: string
  validUntil: string | null
  status: string
  isJobWork: boolean
  customerRef: string | null
  taxableAmount: string | number
  totalAmount: string | number
  lostReason: string | null
  customer: { id: string; name: string; billingCity: string | null }
  brand: { name: string }
  orders: Array<{ id: string; soNumber: string }>
  pieces: number
  marginPercent: number | null
}

interface Summary {
  open: { count: number; value: number }
  expired: number
  won: number
  lost: number
  winRate: number | null
}

const money = (v: string | number) => Number(v).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const isExpired = (q: QuoteRow) => q.status === 'SENT' && !!q.validUntil && new Date(q.validUntil) < new Date(new Date().toDateString())

function look(q: QuoteRow) {
  if (isExpired(q)) return { label: 'Expired', cls: 'badge-neutral' }
  return (
    { DRAFT: { label: 'Draft', cls: 'badge-info' }, SENT: { label: 'Sent', cls: 'badge-warning' }, WON: { label: 'Won', cls: 'badge-success' }, LOST: { label: 'Lost', cls: 'badge-danger' } }[q.status] ?? {
      label: q.status,
      cls: 'badge-neutral',
    }
  )
}

/**
 * Quotations: prices offered before an order.
 *
 * Optional for regular buyers, the first step for new ones or when price or
 * terms change. A sent quotation the buyer accepts becomes a sales order —
 * Convert to order opens the order form filled in from it, and saving the
 * order marks the quotation won. One the buyer turns down is marked lost,
 * with why, for the win-loss figures.
 */
export default function QuotationsPage() {
  const { rowsPerPage } = useAppSettings()
  const [rows, setRows] = useState<QuoteRow[]>([])
  const [total, setTotal] = useState(0)
  const [summary, setSummary] = useState<Summary | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [debounced, setDebounced] = useState('')
  const [status, setStatus] = useState('')
  const [page, setPage] = useState(1)
  const [form, setForm] = useState<{ open: boolean; id: string | null }>({ open: false, id: null })
  const [losing, setLosing] = useState<QuoteRow | null>(null)
  const [acting, setActing] = useState(false)

  useEffect(() => {
    const t = setTimeout(() => setDebounced(search), 350)
    return () => clearTimeout(t)
  }, [search])

  const latest = useRef(0)
  const load = useCallback(async () => {
    const ticket = ++latest.current
    setLoading(true)
    try {
      const qs = new URLSearchParams({ page: String(page), limit: String(rowsPerPage) })
      if (debounced) qs.set('q', debounced)
      if (status) qs.set('status', status)
      const [res, sum] = await Promise.all([api.get<Paginated<QuoteRow>>(`/sales/quotations?${qs}`), api.get<{ data: Summary }>('/sales/quotations/summary')])
      if (ticket !== latest.current) return
      setRows(res.data)
      setTotal(res.pagination.total)
      setSummary(sum.data)
    } catch (err) {
      if (ticket !== latest.current) return
      setError(err instanceof ApiError ? (err.status === 403 ? 'Your role does not allow viewing quotations.' : err.message) : 'Could not reach the server.')
    } finally {
      if (ticket === latest.current) setLoading(false)
    }
  }, [page, rowsPerPage, debounced, status])

  useEffect(() => {
    void load()
  }, [load])
  useEffect(() => setPage(1), [debounced, status])

  const markSent = async (q: QuoteRow) => {
    setError(null)
    try {
      const res = await api.post<{ message?: string }>(`/sales/quotations/${q.id}/sent`, {})
      setMessage(res.message ?? `${q.quoteNumber} marked sent.`)
      void load()
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not update it.')
    }
  }

  const lose = async (reason: string) => {
    if (!losing) return
    setActing(true)
    try {
      const res = await api.post<{ message?: string }>(`/sales/quotations/${losing.id}/lost`, { reason })
      setMessage(res.message ?? `${losing.quoteNumber} marked lost.`)
      setLosing(null)
      void load()
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not update it.')
      setLosing(null)
    } finally {
      setActing(false)
    }
  }

  const actions = (q: QuoteRow): RowAction[] => {
    const items: RowAction[] = [{ key: 'print', label: 'Print quotation', icon: <Printer size={15} />, href: `/print/quotation/${q.id}`, newTab: true }]
    const open = q.status === 'DRAFT' || q.status === 'SENT'
    if (open && can('sales', 'edit')) items.push({ key: 'edit', label: 'Edit', icon: <Pencil size={15} />, onClick: () => setForm({ open: true, id: q.id }) })
    if (q.status === 'DRAFT' && can('sales', 'edit')) items.push({ key: 'sent', label: 'Mark sent', icon: <Send size={15} />, onClick: () => void markSent(q) })
    if (open && can('sales', 'create')) items.push({ key: 'convert', label: 'Convert to order', icon: <ShoppingBag size={15} />, href: `/sales/orders?fromQuote=${q.id}` })
    if (open && can('sales', 'edit')) items.push({ key: 'lost', label: 'Mark lost', icon: <ThumbsDown size={15} />, danger: true, onClick: () => setLosing(q) })
    return items
  }

  const cards = [
    { label: 'Open quotations', value: summary ? String(summary.open.count) : '—', sub: summary ? `${formatCurrency(summary.open.value)} before GST` : '', press: () => setStatus('SENT'), on: status === 'SENT' },
    { label: 'Expired, not answered', value: summary ? String(summary.expired) : '—', sub: 'past valid-until, still sent', press: () => setStatus(status === 'EXPIRED' ? '' : 'EXPIRED'), on: status === 'EXPIRED' },
    { label: 'Won · lost (3 months)', value: summary ? `${summary.won} · ${summary.lost}` : '—', sub: 'decided in the last three months', press: () => setStatus(status === 'WON' ? '' : 'WON'), on: status === 'WON' },
    { label: 'Win rate', value: summary?.winRate != null ? `${summary.winRate}%` : '—', sub: 'of quotations decided', press: () => setStatus(''), on: false },
  ]

  return (
    <div className="space-y-5">
      <div className="page-header gap-3">
        <div className="min-w-0">
          <h1 className="page-title text-xl sm:text-2xl">Quotations</h1>
          <p className="page-subtitle hidden sm:block">Prices offered before an order — optional for regular buyers</p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <button className="btn-ghost" onClick={() => void load()} disabled={loading} aria-label="Refresh">
            <RefreshCw size={15} className={loading ? 'animate-spin' : undefined} />
          </button>
          {can('sales', 'create') && (
            <button className="btn-primary" onClick={() => setForm({ open: true, id: null })}>
              <Plus size={15} /> <span className="hidden sm:inline">New quotation</span>
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
      {message && (
        <div className="border-primary/40 bg-primary/5 rounded-lg border p-3">
          <p className="text-primary text-sm">{message}</p>
        </div>
      )}

      <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
        {cards.map((c) => (
          <button key={c.label} type="button" onClick={c.press} aria-pressed={c.on} className={`glass-card p-3 text-left transition-colors ${c.on ? 'ring-primary bg-primary/5 ring-2' : 'hover:bg-secondary/40'}`}>
            <p className="text-muted-foreground text-[11px]">{c.label}</p>
            <p className="text-foreground mt-0.5 text-lg font-semibold tabular-nums">{c.value}</p>
            <p className="text-muted-foreground mt-0.5 truncate text-[11px]">{c.sub}</p>
          </button>
        ))}
      </div>

      <div className="glass-card overflow-hidden p-0">
        <div className="border-border flex flex-wrap items-center gap-2 border-b px-3 py-2">
          <div className="border-field-edge bg-field flex min-w-0 flex-1 items-center gap-2 rounded-lg border px-2.5 py-1.5 sm:max-w-[260px]">
            <Search size={14} className="text-muted-foreground shrink-0" />
            <input className="text-foreground placeholder:text-muted-foreground min-w-0 flex-1 border-0 bg-transparent text-sm outline-none" placeholder="Quotation, customer, style..." value={search} onChange={(e) => setSearch(e.target.value)} aria-label="Search quotations" />
          </div>
          <SmartSelect className="form-input h-8 w-36 py-0 text-xs" value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Filter by status">
            <option value="">All quotations</option>
            <option value="DRAFT">Draft</option>
            <option value="SENT">Sent</option>
            <option value="EXPIRED">Expired</option>
            <option value="WON">Won</option>
            <option value="LOST">Lost</option>
          </SmartSelect>
          <span className="text-muted-foreground ml-auto text-xs tabular-nums">
            {total} {total === 1 ? 'quotation' : 'quotations'}
          </span>
        </div>

        {loading && rows.length === 0 ? (
          <div className="space-y-2 p-4">
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="skeleton h-10 w-full rounded-lg" />
            ))}
          </div>
        ) : rows.length === 0 ? (
          <p className="text-muted-foreground px-4 py-10 text-center text-sm">{search || status ? 'No quotations match.' : 'No quotations yet. Press New quotation.'}</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="data-table w-full">
              <thead>
                <tr className="bg-secondary">
                  <th>Quotation</th>
                  <th>Customer</th>
                  <th style={{ textAlign: 'right' }}>Pieces</th>
                  <th style={{ textAlign: 'right' }}>Value before GST</th>
                  <th className="col-wide" style={{ textAlign: 'right' }}>
                    Margin
                  </th>
                  <th>Valid until</th>
                  <th>Status</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {rows.map((q) => {
                  const s = look(q)
                  return (
                    <tr key={q.id}>
                      <td className="whitespace-nowrap">
                        <a href={`/print/quotation/${q.id}`} target="_blank" rel="noreferrer" className="text-primary font-mono text-xs font-semibold hover:underline">
                          {q.quoteNumber}
                        </a>
                        <div className="text-muted-foreground flex items-center gap-1 text-[11px]">
                          <CalendarDays size={11} />
                          {formatDate(q.quoteDate)}
                        </div>
                      </td>
                      <td>
                        <div className="text-foreground max-w-[15rem] truncate font-medium">{q.customer.name}</div>
                        <div className="text-muted-foreground text-[11px]">
                          {q.brand.name}
                          {q.customerRef ? ` · ${q.customerRef}` : ''}
                          {q.isJobWork && <span className="badge-purple ml-1.5">Job work</span>}
                        </div>
                      </td>
                      <td className="text-right tabular-nums">{q.pieces.toLocaleString('en-IN')}</td>
                      <td className="text-right font-semibold tabular-nums">₹{money(q.taxableAmount)}</td>
                      <td className={`col-wide text-right text-xs tabular-nums ${q.marginPercent != null && q.marginPercent < 10 ? 'warn-text' : ''}`}>{q.marginPercent != null ? `${q.marginPercent}%` : '—'}</td>
                      <td className={`whitespace-nowrap text-xs ${isExpired(q) ? 'text-destructive' : ''}`}>{q.validUntil ? formatDate(q.validUntil) : '—'}</td>
                      <td>
                        <span className={s.cls} title={q.lostReason ?? undefined}>
                          {s.label}
                        </span>
                        {q.orders[0] && (
                          <a href={`/sales/orders?q=${encodeURIComponent(q.orders[0].soNumber)}`} className="text-primary mt-0.5 block font-mono text-[11px] hover:underline">
                            {q.orders[0].soNumber}
                          </a>
                        )}
                      </td>
                      <td className="text-right">
                        <ActionMenu label={`Actions for ${q.quoteNumber}`} items={actions(q)} />
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
        <Pagination page={page} pages={Math.ceil(total / rowsPerPage) || 1} onPageChange={setPage} busy={loading} />
        <div className="border-border bg-secondary/40 flex items-start gap-2 border-t px-4 py-2">
          <Info size={14} className="text-primary mt-0.5 shrink-0" />
          <p className="text-muted-foreground text-xs">Margin is over the BOM cost per piece, on the lines with a costed BOM. Convert to order opens the order form filled in; saving it marks the quotation won.</p>
        </div>
      </div>

      <QuotationDialog
        open={form.open}
        quoteId={form.id}
        onClose={() => setForm({ open: false, id: null })}
        onSaved={(msg) => {
          setMessage(msg)
          void load()
        }}
      />
      {losing && (
        <ReasonDialog
          title={`Mark ${losing.quoteNumber} lost?`}
          description="Why the buyer said no is kept for the win-loss figures."
          confirmLabel="Mark lost"
          placeholder="Price too high / went to another mill"
          minLength={3}
          danger
          busy={acting}
          onCancel={() => setLosing(null)}
          onConfirm={(r) => void lose(r)}
        />
      )}
    </div>
  )
}
