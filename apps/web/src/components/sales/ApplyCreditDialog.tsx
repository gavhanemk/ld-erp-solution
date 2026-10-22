'use client'

import { useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { HandCoins, Loader2, Wand2 } from 'lucide-react'
import { api, ApiError } from '@/lib/api'
import { formatDate, formatRupees } from '@/lib/utils'
import { useEscape } from '@/lib/useEscape'
import { StepInput } from '@/components/ui/StepInput'

const round2 = (n: number) => Math.round(n * 100) / 100
const inr = (n: number) => n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

interface OpenInvoice {
  id: string
  invoiceNumber: string
  invoiceDate: string
  dueDate: string | null
  balanceAmount: string | number
  daysOverdue: number
}

/** A credit note holding credit, to set against the customer's invoices. */
export interface CreditToApply {
  id: string
  noteNumber: string
  customerId: string
  customerName: string
  held: number
}

/**
 * Apply credit: what a credit note left with the customer — the goods came
 * back after the invoice was paid — set against their invoices still owed,
 * the way an advance is applied. Each invoice owes that much less; the note
 * holds that much less.
 */
export function ApplyCreditDialog({ note, onClose, onSaved }: { note: CreditToApply; onClose: () => void; onSaved: (message: string) => void }) {
  const [invoices, setInvoices] = useState<OpenInvoice[]>([])
  const [loading, setLoading] = useState(true)
  const [amounts, setAmounts] = useState<Record<string, string>>({})
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  useEscape(() => {
    if (!saving) onClose()
  })

  useEffect(() => {
    let alive = true
    api
      .get<{ data: { invoices: OpenInvoice[] } }>(`/sales/receipts/open-invoices?customerId=${note.customerId}`)
      .then((res) => alive && setInvoices(res.data.invoices))
      .catch((err) => alive && setError(err instanceof ApiError ? err.message : 'Could not load the invoices.'))
      .finally(() => alive && setLoading(false))
    return () => {
      alive = false
    }
  }, [note.customerId])

  const rows = useMemo(
    () =>
      invoices.map((inv) => {
        const owed = Number(inv.balanceAmount)
        const value = Number(amounts[inv.id]) || 0
        return { inv, owed, value, over: value > owed + 0.005 }
      }),
    [invoices, amounts]
  )
  const applied = round2(rows.reduce((s, r) => s + r.value, 0))
  const left = round2(note.held - applied)
  const overRow = rows.find((r) => r.over)
  const blocker = overRow
    ? `${overRow.inv.invoiceNumber}: more than the ₹${inr(overRow.owed)} still owed on it.`
    : left < -0.005
      ? `₹${inr(applied)} is more than the ₹${inr(note.held)} ${note.noteNumber} holds.`
      : applied <= 0
        ? 'Put an amount against at least one invoice.'
        : null

  /** The credit spread over the invoices, oldest first, until it runs out. */
  const oldestFirst = () => {
    let credit = note.held
    const next: Record<string, string> = {}
    for (const r of rows) {
      const take = round2(Math.max(0, Math.min(r.owed, credit)))
      next[r.inv.id] = take > 0 ? String(take) : ''
      credit = round2(credit - take)
    }
    setAmounts(next)
  }

  const save = async () => {
    if (blocker) return
    setSaving(true)
    setError(null)
    try {
      const res = await api.post<{ message?: string }>(`/sales/credit-notes/${note.id}/apply`, {
        allocations: rows.filter((r) => r.value > 0).map((r) => ({ invoiceId: r.inv.id, amount: r.value })),
      })
      onSaved(res.message ?? `Credit from ${note.noteNumber} applied.`)
      onClose()
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not apply the credit.')
    } finally {
      setSaving(false)
    }
  }

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm" onClick={() => !saving && onClose()}>
      <div
        className="glass-card flex max-h-[90vh] w-full max-w-2xl flex-col p-5"
        role="dialog"
        aria-modal="true"
        aria-labelledby="apply-credit-title"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start gap-3">
          <div className="bg-primary/10 border-primary/20 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border">
            <HandCoins size={18} className="text-primary" />
          </div>
          <div className="min-w-0 flex-1">
            <h2 id="apply-credit-title" className="text-foreground text-base font-semibold">
              Apply credit from {note.noteNumber}
            </h2>
            <p className="text-muted-foreground mt-1 text-sm">
              {formatRupees(note.held)} is held for {note.customerName}. Set it against invoices they still owe: each owes that much less.
            </p>
          </div>
        </div>

        <div className="mt-4 min-h-0 flex-1 overflow-y-auto">
          {loading ? (
            <div className="skeleton h-24 w-full rounded-lg" />
          ) : invoices.length === 0 ? (
            <p className="text-muted-foreground text-sm">Nothing is owed by {note.customerName} now. The credit stays held for their next invoice.</p>
          ) : (
            <div className="border-border overflow-x-auto rounded-lg border">
              <table className="data-table w-full min-w-[520px]">
                <thead>
                  <tr className="bg-secondary">
                    <th>Invoice</th>
                    <th>Due</th>
                    <th style={{ textAlign: 'right' }}>Still owed</th>
                    <th style={{ textAlign: 'right' }}>Credit ₹</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.inv.id}>
                      <td className="whitespace-nowrap">
                        <span className="text-foreground font-mono text-xs font-semibold">{r.inv.invoiceNumber}</span>
                        <div className="text-muted-foreground text-[11px]">{formatDate(r.inv.invoiceDate)}</div>
                      </td>
                      <td className="whitespace-nowrap text-xs">
                        {r.inv.dueDate ? formatDate(r.inv.dueDate) : '—'}
                        {r.inv.daysOverdue > 0 && <div className="text-destructive text-[11px] font-medium">{r.inv.daysOverdue} days late</div>}
                      </td>
                      <td className="text-right font-semibold tabular-nums">{inr(r.owed)}</td>
                      <td className="w-32 text-right">
                        <StepInput
                          decimals
                          className={`form-input h-8 w-28 px-2 text-right text-xs tabular-nums ${r.over ? 'border-destructive/60' : ''}`}
                          value={amounts[r.inv.id] ?? ''}
                          placeholder="0.00"
                          onValueChange={(v) => setAmounts((s) => ({ ...s, [r.inv.id]: v }))}
                          aria-label={`Credit against ${r.inv.invoiceNumber}`}
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {error && <p className="text-destructive mt-3 text-sm">{error}</p>}

        <div className="mt-4 flex flex-wrap items-center justify-between gap-2">
          <div className="text-muted-foreground text-xs">
            Applied <span className="text-foreground font-medium tabular-nums">{formatRupees(applied)}</span> · still held{' '}
            <span className={`font-medium tabular-nums ${left < 0 ? 'text-destructive' : 'text-foreground'}`}>{formatRupees(Math.max(0, left))}</span>
          </div>
          <div className="flex gap-2">
            {invoices.length > 0 && (
              <button type="button" className="btn-secondary" onClick={oldestFirst} disabled={saving}>
                <Wand2 size={14} /> Oldest first
              </button>
            )}
            <button type="button" className="btn-secondary" onClick={onClose} disabled={saving}>
              Cancel
            </button>
            <button type="button" className="btn-primary" onClick={() => void save()} disabled={saving || loading || !!blocker} title={blocker ?? undefined}>
              {saving && <Loader2 size={15} className="animate-spin" />}
              Apply credit
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body
  )
}
