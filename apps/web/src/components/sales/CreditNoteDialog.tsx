'use client'

import { useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { AlertCircle, FileText, Info, Loader2, ReceiptText, RotateCcw, Save, Undo2, X } from 'lucide-react'
import { api, ApiError, type Paginated } from '@/lib/api'
import { formatDate, formatRupees } from '@/lib/utils'
import { Section } from '@/components/purchase/Section'
import { SmartSelect } from '@/components/ui/SmartSelect'
import { StepInput } from '@/components/ui/StepInput'

interface Prepared {
  invoice: {
    id: string
    invoiceNumber: string
    invoiceDate: string
    totalAmount: number
    balanceAmount: number
    customer: { id: string; name: string }
    dcNumber: string | null
    isIntraState: boolean | null
  }
  stores: Array<{ id: string; name: string }>
  defaultStoreId: string | null
  lines: Array<{
    invoiceLineId: string
    item: { code: string; name: string; color: string | null }
    hsnCode: string | null
    qty: number
    perPiece: number
    taxableValue: number
    gstRate: number
    returned: number
    credited: number
    sizes: Array<{ sizeId: string; code: string; invoiced: number; returned: number }>
  }>
}

interface InvoiceOption {
  id: string
  invoiceNumber: string
  invoiceDate: string
  status: string
  totalAmount: string | number
  customer: { name: string }
}

type Draft = Record<string, { sizes: Record<string, string>; qty: string; amount: string }>

const round2 = (n: number) => Math.round(n * 100) / 100
const inr = (n: number) => n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const pcs = (n: number) => n.toLocaleString('en-IN', { maximumFractionDigits: 2 })

/**
 * A credit note: an invoice reduced, always against that invoice.
 *
 * A return brings goods back. For each invoice line, size by size, it shows
 * what was invoiced and what has already come back, with a box for what
 * comes back now, and a store for the goods. Each piece is credited at what
 * the invoice charged for it, its discounts already in, with the same GST.
 * An adjustment moves no goods: an amount off a line, for a rate difference
 * or a discount given after the invoice.
 *
 * It reduces what the invoice still owes; anything more — the invoice was
 * already paid — stays with the customer as credit. Final when issued.
 */
export function CreditNoteDialog({
  open,
  invoiceId: presetInvoice,
  onClose,
  onSaved,
}: {
  open: boolean
  invoiceId?: string | null
  onClose: () => void
  onSaved: (message: string, id: string) => void
}) {
  const [mounted, setMounted] = useState(false)
  useEffect(() => setMounted(true), [])
  const [invoices, setInvoices] = useState<InvoiceOption[]>([])
  const [invoiceId, setInvoiceId] = useState('')
  const [prep, setPrep] = useState<Prepared | null>(null)
  const [type, setType] = useState<'RETURN' | 'ADJUSTMENT'>('RETURN')
  const [warehouseId, setWarehouseId] = useState('')
  const [reason, setReason] = useState('')
  const [notes, setNotes] = useState('')
  const [draft, setDraft] = useState<Draft>({})
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !saving) onClose()
    }
    window.addEventListener('keydown', onKey)
    const previous = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      window.removeEventListener('keydown', onKey)
      document.body.style.overflow = previous
    }
  }, [open, onClose, saving])

  useEffect(() => {
    if (!open) return
    setError(null)
    setPrep(null)
    setType('RETURN')
    setReason('')
    setNotes('')
    setDraft({})
    setInvoiceId(presetInvoice ?? '')
    api
      .get<Paginated<InvoiceOption>>('/sales/invoices?limit=200')
      .then((res) => setInvoices(res.data.filter((i) => i.status !== 'CANCELLED')))
      .catch(() => {})
  }, [open, presetInvoice])

  useEffect(() => {
    if (!open || !invoiceId) {
      setPrep(null)
      return
    }
    let alive = true
    setLoading(true)
    setDraft({})
    api
      .get<{ data: Prepared }>(`/sales/credit-notes/prepare?invoiceId=${invoiceId}`)
      .then((res) => {
        if (!alive) return
        setPrep(res.data)
        setWarehouseId(res.data.defaultStoreId ?? '')
      })
      .catch((err) => alive && setError(err instanceof ApiError ? err.message : 'Could not open that invoice.'))
      .finally(() => alive && setLoading(false))
    return () => {
      alive = false
    }
  }, [open, invoiceId])

  const rows = useMemo(
    () =>
      (prep?.lines ?? []).map((l) => {
        const d = draft[l.invoiceLineId] ?? { sizes: {}, qty: '', amount: '' }
        const qty = l.sizes.length ? l.sizes.reduce((t, s) => t + (Number(d.sizes[s.sizeId]) || 0), 0) : Number(d.qty) || 0
        const overSize = l.sizes.find((s) => (Number(d.sizes[s.sizeId]) || 0) > s.invoiced - s.returned)
        const taxable = type === 'RETURN' ? round2(qty * l.perPiece) : round2(Number(d.amount) || 0)
        const room = round2(l.taxableValue - l.credited)
        const over = type === 'RETURN' ? !!overSize || qty > l.qty - l.returned : taxable > room
        return { l, d, qty, taxable, gst: round2((taxable * l.gstRate) / 100), over, room }
      }),
    [prep, draft, type]
  )
  const taxable = round2(rows.reduce((t, r) => t + r.taxable, 0))
  const gst = round2(rows.reduce((t, r) => t + r.gst, 0))
  const total = Math.round(taxable + gst)
  const beyond = prep ? Math.max(0, total - prep.invoice.balanceAmount) : 0

  const setRow = (id: string, patch: Partial<Draft[string]>) =>
    setDraft((d) => ({ ...d, [id]: { ...(d[id] ?? { sizes: {}, qty: '', amount: '' }), ...patch } }))

  const blocker = !invoiceId
    ? 'Pick the invoice to credit.'
    : !prep
      ? null
      : type === 'RETURN' && !warehouseId
        ? 'Say which store the goods come back into.'
        : rows.find((r) => r.over)
          ? `${rows.find((r) => r.over)!.l.item.code}: more than can be ${type === 'RETURN' ? 'returned' : 'credited'}.`
          : taxable <= 0
            ? type === 'RETURN'
              ? 'Put the pieces coming back against at least one line.'
              : 'Put the amount to credit against at least one line.'
            : reason.trim().length < 3
              ? 'Say why, in a few words.'
              : null

  const save = async () => {
    if (blocker || !prep) return
    setSaving(true)
    setError(null)
    try {
      const res = await api.post<{ message?: string; data: { id: string } }>('/sales/credit-notes', {
        invoiceId,
        type,
        warehouseId: type === 'RETURN' ? warehouseId : null,
        reason: reason.trim(),
        notes: notes.trim() || null,
        lines: rows
          .filter((r) => r.taxable > 0)
          .map((r) =>
            type === 'RETURN'
              ? {
                  invoiceLineId: r.l.invoiceLineId,
                  sizes: r.l.sizes.length ? r.l.sizes.map((s) => ({ sizeId: s.sizeId, qty: Number(r.d.sizes[s.sizeId]) || 0 })).filter((s) => s.qty > 0) : undefined,
                  qty: r.l.sizes.length ? undefined : r.qty,
                }
              : { invoiceLineId: r.l.invoiceLineId, amount: r.taxable }
          ),
      })
      onSaved(res.message ?? 'Credit note issued.', res.data.id)
      onClose()
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not issue the credit note.')
    } finally {
      setSaving(false)
    }
  }

  if (!open || !mounted) return null

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-stretch justify-center bg-black/60 p-2 backdrop-blur-sm sm:left-[var(--sidebar-current-width)] sm:p-3">
      <div className="glass-card po-form flex h-full max-h-full w-full flex-col overflow-hidden" role="dialog" aria-modal="true" aria-labelledby="cn-title">
        <div className="border-border flex shrink-0 items-center justify-between gap-4 border-b px-5 py-3.5">
          <div className="flex min-w-0 items-center gap-3">
            <div className="bg-primary/10 border-primary/20 flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border">
              <Undo2 size={19} className="text-primary" />
            </div>
            <div className="min-w-0">
              <h2 id="cn-title" className="text-foreground truncate text-xl font-semibold tracking-tight">
                Credit Note
              </h2>
              <p className="text-muted-foreground mt-0.5 truncate text-[13px]">{prep ? `Against ${prep.invoice.invoiceNumber} · ${prep.invoice.customer.name}` : 'Goods returned, or an invoice reduced'}</p>
            </div>
          </div>
          <button onClick={onClose} className="btn-ghost p-2" aria-label="Close" disabled={saving}>
            <X size={18} />
          </button>
        </div>

        <div className="flex-1 space-y-3 overflow-y-auto px-4 py-3">
          {error && (
            <div className="border-destructive/40 bg-destructive/5 flex items-start gap-3 rounded-lg border p-3">
              <AlertCircle size={16} className="text-destructive mt-0.5 shrink-0" />
              <p className="text-destructive text-sm">{error}</p>
            </div>
          )}
          <Section icon={FileText} title="Basic Details">
            <div className="grid grid-cols-1 gap-x-4 gap-y-3 sm:grid-cols-2 lg:grid-cols-4">
              <div className="min-w-0 sm:col-span-2">
                <label className="form-label" htmlFor="cn-invoice">
                  Invoice<span className="text-destructive ml-0.5">*</span>
                </label>
                <SmartSelect id="cn-invoice" className="form-input" value={invoiceId} onChange={(e) => setInvoiceId(e.target.value)}>
                  <option value="">Choose the invoice</option>
                  {invoices.map((i) => (
                    <option key={i.id} value={i.id} data-sub={`${i.customer.name} · ${formatDate(i.invoiceDate)} · ${formatRupees(Number(i.totalAmount))}`}>
                      {i.invoiceNumber}
                    </option>
                  ))}
                </SmartSelect>
              </div>
              <div className="min-w-0">
                <span className="form-label">Kind</span>
                <div className="border-border bg-secondary flex rounded-lg border p-1" role="tablist">
                  {(
                    [
                      ['RETURN', 'Goods returned', RotateCcw],
                      ['ADJUSTMENT', 'Amount only', ReceiptText],
                    ] as const
                  ).map(([v, label, Icon]) => (
                    <button
                      key={v}
                      type="button"
                      role="tab"
                      aria-selected={type === v}
                      onClick={() => {
                        setType(v)
                        setDraft({})
                      }}
                      className={`flex flex-1 items-center justify-center gap-1.5 rounded-md px-2 py-1 text-xs transition-colors ${type === v ? 'bg-card text-foreground font-medium shadow-sm' : 'text-muted-foreground'}`}
                    >
                      <Icon size={13} /> {label}
                    </button>
                  ))}
                </div>
              </div>
              {type === 'RETURN' && prep && (
                <div className="min-w-0">
                  <label className="form-label" htmlFor="cn-store">
                    Back into store<span className="text-destructive ml-0.5">*</span>
                  </label>
                  <SmartSelect id="cn-store" className="form-input" value={warehouseId} onChange={(e) => setWarehouseId(e.target.value)}>
                    <option value="">Choose a store</option>
                    {prep.stores.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name}
                      </option>
                    ))}
                  </SmartSelect>
                </div>
              )}
              <div className="min-w-0 sm:col-span-2 lg:col-span-4">
                <label className="form-label" htmlFor="cn-reason">
                  Reason<span className="text-destructive ml-0.5">*</span>
                </label>
                <input id="cn-reason" className="form-input" maxLength={300} value={reason} placeholder={type === 'RETURN' ? 'Stitching fault / wrong size sent' : 'Rate agreed lower after dispatch'} onChange={(e) => setReason(e.target.value)} />
              </div>
            </div>
            {prep && (
              <div className="border-border bg-secondary/30 mt-3 flex flex-wrap gap-x-5 gap-y-1 rounded-lg border px-3 py-2 text-xs">
                <span className="text-foreground font-medium">{prep.invoice.customer.name}</span>
                <span className="text-muted-foreground">
                  {prep.invoice.invoiceNumber} of {formatDate(prep.invoice.invoiceDate)} · {formatRupees(prep.invoice.totalAmount)}
                </span>
                <span className="text-muted-foreground">Still owed {formatRupees(prep.invoice.balanceAmount)}</span>
                {prep.invoice.dcNumber && <span className="text-muted-foreground">Sent on {prep.invoice.dcNumber}</span>}
              </div>
            )}
          </Section>

          {invoiceId && (
            <Section icon={type === 'RETURN' ? RotateCcw : ReceiptText} title={type === 'RETURN' ? 'Pieces coming back' : 'Amount off each line'}>
              {loading || !prep ? (
                <div className="skeleton h-32 w-full rounded-lg" />
              ) : (
                <div className="space-y-3">
                  {rows.map(({ l, d, qty, taxable: t, over, room }) => (
                    <div key={l.invoiceLineId} className="border-border bg-card rounded-lg border p-3">
                      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                        <p className="text-foreground text-sm font-medium">
                          <span className="font-mono text-xs">{l.item.code}</span> — {l.item.name}
                          {l.item.color && <span className="text-muted-foreground font-normal"> · {l.item.color}</span>}
                        </p>
                        <p className="text-muted-foreground text-xs tabular-nums">
                          Invoiced {pcs(l.qty)} at ₹{inr(l.perPiece)}/pc · GST {l.gstRate}%{l.returned > 0 ? ` · ${pcs(l.returned)} already back` : ''}
                          {l.credited > 0 ? ` · ₹${inr(l.credited)} credited` : ''}
                        </p>
                      </div>
                      {type === 'RETURN' ? (
                        <div className="mt-2 flex flex-wrap items-end gap-3">
                          {l.sizes.length ? (
                            l.sizes.map((s) => (
                              <label key={s.sizeId} className="flex w-16 flex-col items-center gap-0.5" title={`${s.invoiced - s.returned} can come back`}>
                                <span className="text-muted-foreground text-[10px] font-medium">
                                  {s.code} · {pcs(s.invoiced - s.returned)}
                                </span>
                                <StepInput
                                  className={`form-input h-8 w-16 px-1 text-center text-xs tabular-nums ${(Number(d.sizes[s.sizeId]) || 0) > s.invoiced - s.returned ? 'border-destructive/60' : ''}`}
                                  value={d.sizes[s.sizeId] ?? ''}
                                  placeholder="0"
                                  max={s.invoiced - s.returned}
                                  onValueChange={(v) => setRow(l.invoiceLineId, { sizes: { ...d.sizes, [s.sizeId]: v } })}
                                  aria-label={`${l.item.code} size ${s.code} returned`}
                                />
                              </label>
                            ))
                          ) : (
                            <label className="flex flex-col gap-0.5">
                              <span className="text-muted-foreground text-[10px] font-medium">Pieces · up to {pcs(l.qty - l.returned)}</span>
                              <StepInput className="form-input h-8 w-24 text-right text-xs tabular-nums" value={d.qty} placeholder="0" max={l.qty - l.returned} onValueChange={(v) => setRow(l.invoiceLineId, { qty: v })} aria-label={`${l.item.code} returned`} />
                            </label>
                          )}
                          <span className="text-foreground ml-auto text-xs font-semibold tabular-nums">
                            {pcs(qty)} pcs · ₹{inr(t)}
                          </span>
                        </div>
                      ) : (
                        <div className="mt-2 flex flex-wrap items-end gap-3">
                          <label className="flex flex-col gap-0.5">
                            <span className="text-muted-foreground text-[10px] font-medium">Credit before GST · up to ₹{inr(room)}</span>
                            <StepInput decimals className={`form-input h-8 w-32 text-right text-xs tabular-nums ${over ? 'border-destructive/60' : ''}`} value={d.amount} placeholder="0.00" onValueChange={(v) => setRow(l.invoiceLineId, { amount: v })} aria-label={`${l.item.code} credit`} />
                          </label>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </Section>
          )}

          {prep && (
            <Section icon={ReceiptText} title="Credit">
              <div className="grid grid-cols-1 gap-3 lg:grid-cols-[minmax(0,1fr)_360px]">
                <label className="block">
                  <span className="form-label">Notes (printed)</span>
                  <textarea className="form-input min-h-[5rem]" rows={3} maxLength={1000} value={notes} onChange={(e) => setNotes(e.target.value)} />
                </label>
                <div className="space-y-1.5 text-sm">
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Taxable value</span>
                    <span className="tabular-nums">{inr(taxable)}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">{prep.invoice.isIntraState === false ? 'IGST' : 'CGST + SGST'}</span>
                    <span className="tabular-nums">{inr(gst)}</span>
                  </div>
                  <div className="border-primary/20 bg-primary/5 flex items-center justify-between rounded-lg border px-3 py-2.5">
                    <span className="text-foreground font-semibold">Credit</span>
                    <span className="text-foreground text-lg font-semibold tabular-nums">{formatRupees(total)}</span>
                  </div>
                  {beyond > 0 && (
                    <p className="text-muted-foreground flex items-start gap-1.5 text-xs">
                      <Info size={13} className="mt-px shrink-0" />
                      {formatRupees(beyond)} is more than the invoice still owes, and stays with the customer as credit.
                    </p>
                  )}
                </div>
              </div>
            </Section>
          )}
        </div>

        <div className="border-border flex shrink-0 flex-wrap items-center justify-end gap-2 border-t px-3 py-2.5 sm:gap-3 sm:px-5 sm:py-3.5">
          {blocker && (
            <p className="warn-text mr-auto flex max-w-xl items-start gap-1.5 text-xs">
              <AlertCircle size={13} className="mt-px shrink-0" />
              <span>{blocker}</span>
            </p>
          )}
          <button type="button" onClick={onClose} className="btn-secondary hidden sm:inline-flex" disabled={saving}>
            Cancel
          </button>
          <button type="button" className="btn-primary" onClick={() => void save()} disabled={saving || loading || !!blocker}>
            {saving ? <Loader2 size={15} className="animate-spin" /> : <Save size={15} />} Issue credit note
          </button>
        </div>
      </div>
    </div>,
    document.body
  )
}
