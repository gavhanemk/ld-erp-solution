'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { AlertCircle, Ban, CalendarDays, Info, Plus, Printer, RefreshCw, Search } from 'lucide-react'
import { api, ApiError, can, type Paginated } from '@/lib/api'
import { Pagination } from '@/components/tables/Pagination'
import { ActionMenu, type RowAction } from '@/components/tables/ActionMenu'
import { useAppSettings } from '@/lib/appSettings'
import { formatDate } from '@/lib/utils'
import { SmartSelect } from '@/components/ui/SmartSelect'
import { ReasonDialog } from '@/components/ui/ReasonDialog'
import { CreditNoteDialog } from '@/components/sales/CreditNoteDialog'

interface NoteRow {
  id: string
  noteNumber: string
  noteDate: string
  type: string
  status: string
  reason: string | null
  totalAmount: string | number
  onAccount: string | number
  cancelReason: string | null
  pieces: number
  customer: { id: string; name: string }
  invoice: { id: string; invoiceNumber: string } | null
  warehouse: { name: string } | null
}

const money = (v: string | number) => Number(v).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

/**
 * Sales returns and credit notes.
 *
 * Every credit note is against an invoice. "Goods returned" brings the pieces
 * back into a store, size by size, and credits them at what the invoice
 * charged; "Amount only" credits a rate difference or a later discount. Either
 * reduces what the invoice owes. Links in: ?invoice=<id> opens one for that
 * invoice, from the invoice list.
 */
export default function ReturnsPage() {
  const { rowsPerPage } = useAppSettings()
  const [rows, setRows] = useState<NoteRow[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [message, setMessage] = useState<{ text: string; id?: string } | null>(null)
  const [search, setSearch] = useState('')
  const [debounced, setDebounced] = useState('')
  const [type, setType] = useState('')
  const [status, setStatus] = useState('')
  const [page, setPage] = useState(1)
  const [form, setForm] = useState<{ open: boolean; invoiceId: string | null }>({ open: false, invoiceId: null })
  const [cancelling, setCancelling] = useState<NoteRow | null>(null)
  const [acting, setActing] = useState(false)

  useEffect(() => {
    const inv = new URLSearchParams(window.location.search).get('invoice')
    if (inv && can('sales', 'create')) setForm({ open: true, invoiceId: inv })
  }, [])
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
      if (type) qs.set('type', type)
      if (status) qs.set('status', status)
      const res = await api.get<Paginated<NoteRow>>(`/sales/credit-notes?${qs}`)
      if (ticket !== latest.current) return
      setRows(res.data)
      setTotal(res.pagination.total)
    } catch (err) {
      if (ticket !== latest.current) return
      setError(err instanceof ApiError ? (err.status === 403 ? 'Your role does not allow viewing credit notes.' : err.message) : 'Could not reach the server.')
    } finally {
      if (ticket === latest.current) setLoading(false)
    }
  }, [page, rowsPerPage, debounced, type, status])

  useEffect(() => {
    void load()
  }, [load])
  useEffect(() => setPage(1), [debounced, type, status])

  const cancel = async (reason: string) => {
    if (!cancelling) return
    setActing(true)
    try {
      const res = await api.post<{ message?: string }>(`/sales/credit-notes/${cancelling.id}/cancel`, { reason })
      setMessage({ text: res.message ?? `${cancelling.noteNumber} cancelled.` })
      setCancelling(null)
      void load()
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not cancel it.')
      setCancelling(null)
    } finally {
      setActing(false)
    }
  }

  const actions = (n: NoteRow): RowAction[] => {
    const items: RowAction[] = [{ key: 'print', label: 'Print credit note', icon: <Printer size={15} />, href: `/print/credit-note/${n.id}`, newTab: true }]
    if (n.status === 'ISSUED' && can('sales', 'approve')) items.push({ key: 'cancel', label: 'Cancel credit note', icon: <Ban size={15} />, danger: true, onClick: () => setCancelling(n) })
    return items
  }

  return (
    <div className="space-y-5">
      <div className="page-header gap-3">
        <div className="min-w-0">
          <h1 className="page-title text-xl sm:text-2xl">Returns &amp; Credit Notes</h1>
          <p className="page-subtitle hidden sm:block">Goods back from customers, and invoices reduced</p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <button className="btn-ghost" onClick={() => void load()} disabled={loading} aria-label="Refresh">
            <RefreshCw size={15} className={loading ? 'animate-spin' : undefined} />
          </button>
          {can('sales', 'create') && (
            <button className="btn-primary" onClick={() => setForm({ open: true, invoiceId: null })}>
              <Plus size={15} /> <span className="hidden sm:inline">New credit note</span>
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
        <div className="border-primary/40 bg-primary/5 flex flex-wrap items-center justify-between gap-2 rounded-lg border p-3">
          <p className="text-primary text-sm">{message.text}</p>
          {message.id && (
            <a href={`/print/credit-note/${message.id}`} target="_blank" rel="noreferrer" className="btn-secondary h-8 px-3 text-xs">
              <Printer size={14} /> Print
            </a>
          )}
        </div>
      )}

      <div className="glass-card overflow-hidden p-0">
        <div className="border-border flex flex-wrap items-center gap-2 border-b px-3 py-2">
          <div className="border-field-edge bg-field flex min-w-0 flex-1 items-center gap-2 rounded-lg border px-2.5 py-1.5 sm:max-w-[260px]">
            <Search size={14} className="text-muted-foreground shrink-0" />
            <input className="text-foreground placeholder:text-muted-foreground min-w-0 flex-1 border-0 bg-transparent text-sm outline-none" placeholder="Credit note, customer, invoice..." value={search} onChange={(e) => setSearch(e.target.value)} aria-label="Search" />
          </div>
          <SmartSelect className="form-input h-8 w-40 py-0 text-xs" value={type} onChange={(e) => setType(e.target.value)} aria-label="Filter by kind">
            <option value="">Returns and amounts</option>
            <option value="RETURN">Goods returned</option>
            <option value="ADJUSTMENT">Amount only</option>
          </SmartSelect>
          <SmartSelect className="form-input h-8 w-32 py-0 text-xs" value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Filter by status">
            <option value="">All</option>
            <option value="ISSUED">Issued</option>
            <option value="CANCELLED">Cancelled</option>
          </SmartSelect>
          <span className="text-muted-foreground ml-auto text-xs tabular-nums">
            {total} {total === 1 ? 'credit note' : 'credit notes'}
          </span>
        </div>
        {loading && rows.length === 0 ? (
          <div className="space-y-2 p-4">
            {Array.from({ length: 3 }).map((_, i) => (
              <div key={i} className="skeleton h-10 w-full rounded-lg" />
            ))}
          </div>
        ) : rows.length === 0 ? (
          <p className="text-muted-foreground px-4 py-10 text-center text-sm">{search || type || status ? 'Nothing matches.' : 'No credit notes yet. A return starts from New credit note, or Return / credit note on an invoice.'}</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="data-table w-full">
              <thead>
                <tr className="bg-secondary">
                  <th>Credit note</th>
                  <th>Customer</th>
                  <th>Invoice</th>
                  <th>Kind</th>
                  <th style={{ textAlign: 'right' }}>Credit</th>
                  <th className="col-wide">Reason</th>
                  <th>Status</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {rows.map((n) => (
                  <tr key={n.id} className={n.status === 'CANCELLED' ? 'opacity-70' : undefined}>
                    <td className="whitespace-nowrap">
                      <a href={`/print/credit-note/${n.id}`} target="_blank" rel="noreferrer" className="text-primary font-mono text-xs font-semibold hover:underline">
                        {n.noteNumber}
                      </a>
                      <div className="text-muted-foreground flex items-center gap-1 text-[11px]">
                        <CalendarDays size={11} />
                        {formatDate(n.noteDate)}
                      </div>
                    </td>
                    <td className="max-w-[15rem] truncate font-medium">{n.customer.name}</td>
                    <td className="font-mono text-xs">{n.invoice?.invoiceNumber ?? '—'}</td>
                    <td className="text-xs">
                      {n.type === 'RETURN' ? `${n.pieces.toLocaleString('en-IN')} pcs back${n.warehouse ? ` · ${n.warehouse.name}` : ''}` : 'Amount only'}
                    </td>
                    <td className="text-right font-semibold tabular-nums">
                      ₹{money(n.totalAmount)}
                      {Number(n.onAccount) > 0 && n.status === 'ISSUED' && <div className="text-muted-foreground text-[11px] font-normal">₹{money(n.onAccount)} held as credit</div>}
                    </td>
                    <td className="col-wide text-muted-foreground max-w-[16rem] truncate text-xs">{n.reason}</td>
                    <td>
                      <span className={n.status === 'CANCELLED' ? 'badge-neutral' : 'badge-success'} title={n.cancelReason ?? undefined}>
                        {n.status === 'CANCELLED' ? 'Cancelled' : 'Issued'}
                      </span>
                    </td>
                    <td className="text-right">
                      <ActionMenu label={`Actions for ${n.noteNumber}`} items={actions(n)} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <Pagination page={page} pages={Math.ceil(total / rowsPerPage) || 1} onPageChange={setPage} busy={loading} />
        <div className="border-border bg-secondary/40 flex items-start gap-2 border-t px-4 py-2">
          <Info size={14} className="text-primary mt-0.5 shrink-0" />
          <p className="text-muted-foreground text-xs">
            A credit note reduces what its invoice owes; beyond that it stays with the customer as credit and counts like an advance. Cancelling one takes returned goods back out of the store.
          </p>
        </div>
      </div>

      <CreditNoteDialog
        open={form.open}
        invoiceId={form.invoiceId}
        onClose={() => setForm({ open: false, invoiceId: null })}
        onSaved={(text, id) => {
          setMessage({ text, id })
          void load()
        }}
      />
      {cancelling && (
        <ReasonDialog
          title={`Cancel ${cancelling.noteNumber}?`}
          description={cancelling.type === 'RETURN' ? 'Its returned pieces go back out of the store, and the invoice owes what it did before.' : 'The invoice owes what it did before.'}
          confirmLabel="Cancel credit note"
          placeholder="Entered against the wrong invoice"
          danger
          busy={acting}
          onCancel={() => setCancelling(null)}
          onConfirm={(r) => void cancel(r)}
        />
      )}
    </div>
  )
}
