'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { AlertCircle, Loader2, Receipt, X } from 'lucide-react'
import { api, apiErrorMessage } from '@/lib/api'
import type { EnquiryRecord } from '@/components/purchase/PurchaseEnquiryDialog'

/**
 * Recording what the supplier came back with.
 *
 * His proforma invoice is a document, not a set of numbers, and this form is
 * built around that: its number and date are required, because the purchase
 * order will quote them and a price with no document behind it cannot be
 * defended when the bill is queried.
 *
 * The rest is deliberately forgiving. Rates are optional per line — a supplier
 * who quotes one lump sum for a mixed enquiry is ordinary, and refusing his PI
 * because it does not break down per item would push the step back onto email.
 *
 * His total and ours are both shown when they disagree, and neither is corrected
 * into the other. A mismatch is usually a charge he has added or an arithmetic
 * slip worth a phone call, and silently replacing one with the other hides both.
 */

const money = (n: number) =>
  n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

const num = (v: string) => {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}

const iso = (d: string | null | undefined) => (d ? new Date(d).toISOString().slice(0, 10) : '')

export function RecordQuoteDialog({
  enquiry,
  onClose,
  onSaved,
}: {
  enquiry: EnquiryRecord
  onClose: () => void
  onSaved: (message: string) => void
}) {
  const revising = Boolean(enquiry.piNumber)

  const [piNumber, setPiNumber] = useState(enquiry.piNumber ?? '')
  const [piDate, setPiDate] = useState(iso(enquiry.piDate) || new Date().toISOString().slice(0, 10))
  const [validUntil, setValidUntil] = useState(iso(enquiry.piValidUntil))
  const [amount, setAmount] = useState(
    enquiry.piAmount == null ? '' : String(Number(enquiry.piAmount))
  )
  const [rates, setRates] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      enquiry.lines.map((l) => [l.id, l.quotedRate == null ? '' : String(Number(l.quotedRate))])
    )
  )
  const [gst, setGst] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      enquiry.lines.map((l) => [l.id, l.gstRate == null ? '' : String(Number(l.gstRate))])
    )
  )

  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  /** What his rates add up to, for comparison against the total he stated. */
  const fromRates = useMemo(
    () =>
      enquiry.lines.reduce((t, l) => {
        const r = rates[l.id]
        return r === '' || r == null ? t : t + Number(l.qty) * num(r)
      }, 0),
    [enquiry.lines, rates]
  )

  const stated = amount === '' ? null : num(amount)
  /*
   * A rupee of slack. His PI is rounded to the rupee and ours is built from
   * rates carrying paise, so the two disagreeing by fifty paise is arithmetic,
   * not a discrepancy worth a phone call.
   */
  const mismatch =
    stated != null && fromRates > 0 && Math.abs(stated - fromRates) > 1
      ? { stated, ours: fromRates }
      : null

  const priced = enquiry.lines.filter((l) => rates[l.id] !== '' && rates[l.id] != null).length

  const problems = useMemo(() => {
    const out: string[] = []
    if (!piNumber.trim()) out.push('The PI needs its number')
    if (!piDate) out.push('The PI needs its date')
    if (validUntil && piDate && validUntil < piDate) {
      out.push('The PI cannot expire before the date on it')
    }
    return out
  }, [piNumber, piDate, validUntil])

  const save = useCallback(async () => {
    if (problems.length) return
    setSaving(true)
    setError(null)
    try {
      const res = await api.patch<{ message: string }>(
        '/purchase/enquiries/' + enquiry.id + '/quote',
        {
          piNumber: piNumber.trim(),
          piDate,
          amount: amount === '' ? null : num(amount),
          validUntil: validUntil || null,
          rates: enquiry.lines.map((l) => ({
            lineId: l.id,
            quotedRate: rates[l.id] === '' || rates[l.id] == null ? null : num(rates[l.id]),
            gstRate: gst[l.id] === '' || gst[l.id] == null ? null : num(gst[l.id]),
          })),
        }
      )
      onSaved(res.message)
    } catch (err) {
      setError(apiErrorMessage(err, 'Could not record the PI.'))
    } finally {
      setSaving(false)
    }
  }, [problems, enquiry, piNumber, piDate, amount, validUntil, rates, gst, onSaved])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !saving) onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, saving])

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/60 p-4 backdrop-blur-sm">
      <div
        className="glass-card my-4 w-full max-w-3xl p-0"
        role="dialog"
        aria-modal="true"
        aria-labelledby="quote-dialog-title"
      >
        <div className="border-border/70 bg-card sticky top-0 z-10 flex items-center justify-between gap-3 rounded-t-xl border-b px-5 py-3">
          <div className="min-w-0">
            <h2 id="quote-dialog-title" className="text-foreground text-base font-semibold">
              {revising ? 'Revised PI' : 'Record proforma invoice'}
            </h2>
            <p className="text-muted-foreground mt-0.5 text-xs">
              {enquiry.enquiryNumber} · {enquiry.supplier?.name}
              {revising && ' · replaces ' + enquiry.piNumber}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={saving}
            className="btn-ghost"
            aria-label="Close"
          >
            <X size={16} />
          </button>
        </div>

        <div className="space-y-4 p-5">
          {error && (
            <div className="flex items-start gap-3 rounded-lg border border-red-500/40 bg-red-500/5 p-3">
              <AlertCircle size={16} className="mt-0.5 shrink-0 text-red-400" />
              <p className="text-sm text-red-400">{error}</p>
            </div>
          )}

          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <div>
              <label className="form-label" htmlFor="pi-no">
                PI number
              </label>
              <input
                id="pi-no"
                value={piNumber}
                onChange={(e) => setPiNumber(e.target.value)}
                placeholder="As he wrote it"
                className="form-input font-mono"
              />
              <p className="text-muted-foreground mt-1 text-[11px]">
                Goes onto the purchase order.
              </p>
            </div>
            <div>
              <label className="form-label" htmlFor="pi-date">
                PI date
              </label>
              <input
                id="pi-date"
                type="date"
                value={piDate}
                onChange={(e) => setPiDate(e.target.value)}
                className="form-input"
              />
            </div>
            <div>
              <label className="form-label" htmlFor="pi-valid">
                Holds price until
              </label>
              <input
                id="pi-valid"
                type="date"
                value={validUntil}
                onChange={(e) => setValidUntil(e.target.value)}
                className="form-input"
              />
              <p className="text-muted-foreground mt-1 text-[11px]">
                Left empty if he did not say.
              </p>
            </div>
            <div>
              <label className="form-label" htmlFor="pi-amount">
                Total on his PI
              </label>
              <input
                id="pi-amount"
                type="number"
                step="0.01"
                min="0"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                className="form-input text-right"
              />
              <p className="text-muted-foreground mt-1 text-[11px]">Stored as he stated it.</p>
            </div>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-muted-foreground text-[11px] uppercase">
                <tr>
                  <th className="px-2 py-1.5 text-left font-medium">Item</th>
                  <th className="w-24 px-2 py-1.5 text-right font-medium">Asked</th>
                  <th className="w-24 px-2 py-1.5 text-right font-medium">We expected</th>
                  <th className="w-28 px-2 py-1.5 text-right font-medium">He quotes</th>
                  <th className="w-20 px-2 py-1.5 text-right font-medium">GST %</th>
                  <th className="w-28 px-2 py-1.5 text-right font-medium">Line</th>
                </tr>
              </thead>
              <tbody className="divide-border/60 divide-y">
                {enquiry.lines.map((l) => {
                  const expected = l.expectedRate == null ? null : Number(l.expectedRate)
                  const quoted = rates[l.id] === '' ? null : num(rates[l.id] ?? '')
                  /* Flagged, not refused. A rate above what the buyer expected
                     is a negotiating position, not an error — but it is the one
                     thing they are reading this screen to find. */
                  const over = expected != null && quoted != null && quoted > expected
                  return (
                    <tr key={l.id}>
                      <td className="px-2 py-1.5">
                        <p className="text-xs font-medium">{l.item.name}</p>
                        <p className="text-muted-foreground font-mono text-[10px]">{l.item.code}</p>
                      </td>
                      <td className="px-2 py-1.5 text-right text-xs tabular-nums">
                        {Number(l.qty).toLocaleString('en-IN', { maximumFractionDigits: 3 })}
                        <span className="text-muted-foreground ml-1 text-[10px]">
                          {l.item.uom?.symbol}
                        </span>
                      </td>
                      <td className="text-muted-foreground px-2 py-1.5 text-right text-xs tabular-nums">
                        {expected == null ? '—' : money(expected)}
                      </td>
                      <td className="px-2 py-1.5">
                        <input
                          type="number"
                          step="0.01"
                          min="0"
                          value={rates[l.id] ?? ''}
                          onChange={(e) => setRates((p) => ({ ...p, [l.id]: e.target.value }))}
                          placeholder="—"
                          className={`form-input text-right ${over ? 'border-amber-500/60' : ''}`}
                          aria-label={'Quoted rate for ' + l.item.name}
                        />
                        {over && (
                          <p className="mt-0.5 text-right text-[10px] text-amber-400">
                            above estimate
                          </p>
                        )}
                      </td>
                      <td className="px-2 py-1.5">
                        <input
                          type="number"
                          step="0.01"
                          min="0"
                          max="100"
                          value={gst[l.id] ?? ''}
                          onChange={(e) => setGst((p) => ({ ...p, [l.id]: e.target.value }))}
                          className="form-input text-right"
                          aria-label={'GST rate for ' + l.item.name}
                        />
                      </td>
                      <td className="px-2 py-1.5 text-right text-xs tabular-nums">
                        {quoted == null ? (
                          <span className="text-muted-foreground/60">—</span>
                        ) : (
                          money(Number(l.qty) * quoted)
                        )}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>

          {/* Both figures, side by side, with neither corrected into the other.
              The buyer decides whether the gap is a charge he added or a slip
              worth a call — this screen only makes sure they see it. */}
          {mismatch && (
            <div className="flex items-start gap-3 rounded-lg border border-amber-500/40 bg-amber-500/5 p-3">
              <AlertCircle size={16} className="mt-0.5 shrink-0 text-amber-400" />
              <div className="text-xs">
                <p className="font-medium text-amber-400">His total and his rates do not agree.</p>
                <p className="text-muted-foreground mt-0.5">
                  The PI states ₹{money(mismatch.stated)}; the rates above come to ₹
                  {money(mismatch.ours)} before tax — a difference of ₹
                  {money(Math.abs(mismatch.stated - mismatch.ours))}. Often a charge he has added.
                  Both are kept as they are.
                </p>
              </div>
            </div>
          )}

          {priced === 0 && (
            <p className="text-muted-foreground text-xs">
              No rates typed. The PI will be recorded with its number and total only, which is
              enough to raise an order against — the order asks for its own rates.
            </p>
          )}
        </div>

        <div className="border-border/70 bg-card sticky bottom-0 flex flex-wrap items-center justify-between gap-3 rounded-b-xl border-t px-5 py-3">
          <div className="min-w-0">
            <p className="text-muted-foreground text-[11px]">
              {priced} of {enquiry.lines.length} lines priced
            </p>
            <p className="text-foreground text-sm font-semibold tabular-nums">
              ₹{money(stated ?? fromRates)}
              <span className="text-muted-foreground ml-1.5 text-[11px] font-normal">
                {stated != null ? 'his stated total' : 'from his rates, before tax'}
              </span>
            </p>
          </div>
          <div className="flex items-center gap-2">
            {problems.length > 0 && (
              <p className="text-muted-foreground max-w-[240px] text-right text-[11px]">
                {problems[0]}
              </p>
            )}
            <button type="button" onClick={onClose} disabled={saving} className="btn-ghost">
              Cancel
            </button>
            <button
              type="button"
              onClick={save}
              disabled={saving || problems.length > 0}
              className="btn-primary"
            >
              {saving ? <Loader2 size={15} className="animate-spin" /> : <Receipt size={15} />}
              {revising ? 'Replace PI' : 'Record PI'}
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body
  )
}
