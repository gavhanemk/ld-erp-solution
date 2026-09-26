'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { AlertCircle, Loader2, Receipt, X } from 'lucide-react'
import { api, apiErrorMessage } from '@/lib/api'
import { AttachmentsBox, type AttachmentsBoxHandle } from '@/components/purchase/AttachmentsBox'
import {
  money,
  qty as fmtQty,
  type EnquiryQuote,
  type EnquiryRecord,
} from '@/components/purchase/enquiryTypes'

/**
 * Recording what one supplier came back with.
 *
 * His proforma invoice is a document, not a set of numbers, and this form is
 * built around that: its number and date are required, because the purchase
 * order will quote them and a price with no document behind it cannot be
 * defended when the bill is queried. The scan is attached here rather than in a
 * drop zone somewhere else on the screen, because this is the moment the buyer
 * is holding it.
 *
 * The rest is deliberately forgiving. Rates are optional per line — a supplier
 * who quotes one lump sum for a mixed enquiry is ordinary, and refusing his PI
 * because it does not break down per item would push the step back onto email.
 * So is a short supply: a supplier who can manage 800 of the 1,240 asked has
 * answered the enquiry, and that is the fact the buyer splits an order on.
 *
 * His total and ours are both shown when they disagree, and neither is
 * corrected into the other. A mismatch is usually a charge he has added or an
 * arithmetic slip worth a phone call, and silently replacing one with the other
 * hides both.
 */

const num = (v: string) => {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}

const iso = (d: string | null | undefined) => (d ? new Date(d).toISOString().slice(0, 10) : '')

interface RateRow {
  quotedRate: string
  gstRate: string
  offeredQty: string
  remark: string
}

export function RecordQuoteDialog({
  enquiry,
  quote,
  onClose,
  onSaved,
}: {
  enquiry: EnquiryRecord
  quote: EnquiryQuote
  onClose: () => void
  onSaved: (message: string) => void
}) {
  const revising = Boolean(quote.piNumber)

  const [piNumber, setPiNumber] = useState(quote.piNumber ?? '')
  const [piDate, setPiDate] = useState(iso(quote.piDate) || new Date().toISOString().slice(0, 10))
  const [validUntil, setValidUntil] = useState(iso(quote.piValidUntil))
  const [amount, setAmount] = useState(quote.piAmount == null ? '' : String(Number(quote.piAmount)))
  const [remark, setRemark] = useState(quote.remark ?? '')

  const [rows, setRows] = useState<Record<string, RateRow>>(() =>
    Object.fromEntries(
      enquiry.lines.map((l) => {
        const ql = quote.lines.find((x) => x.enquiryLineId === l.id)
        return [
          l.id,
          {
            quotedRate: ql?.quotedRate == null ? '' : String(Number(ql.quotedRate)),
            gstRate: ql?.gstRate == null ? '' : String(Number(ql.gstRate)),
            offeredQty: ql?.offeredQty == null ? '' : String(Number(ql.offeredQty)),
            remark: ql?.remark ?? '',
          },
        ]
      })
    )
  )

  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const filesRef = useRef<AttachmentsBoxHandle>(null)

  const setRow = (lineId: string, patch: Partial<RateRow>) =>
    setRows((p) => ({ ...p, [lineId]: { ...p[lineId], ...patch } }))

  /** What his rates add up to, for comparison against the total he stated. */
  const fromRates = useMemo(
    () =>
      enquiry.lines.reduce((t, l) => {
        const r = rows[l.id]?.quotedRate
        if (r === '' || r == null) return t
        // Priced on what he can actually supply, not on what was asked. A rate
        // for 800 of 1,240 costs the mill 800 of them.
        const q = rows[l.id]?.offeredQty
        const useQty = q === '' || q == null ? Number(l.qty) : num(q)
        return t + useQty * num(r)
      }, 0),
    [enquiry.lines, rows]
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

  const priced = enquiry.lines.filter((l) => rows[l.id]?.quotedRate !== '').length

  const problems = useMemo(() => {
    const out: string[] = []
    if (!piNumber.trim()) out.push('The PI needs its number')
    if (!piDate) out.push('The PI needs its date')
    if (validUntil && piDate && validUntil < piDate) {
      out.push('The PI cannot expire before the date on it')
    }
    for (const l of enquiry.lines) {
      const o = rows[l.id]?.offeredQty
      if (o !== '' && o != null && num(o) > Number(l.qty)) {
        out.push('He cannot offer more of ' + l.item.name + ' than was asked for')
        break
      }
    }
    return out
  }, [piNumber, piDate, validUntil, enquiry.lines, rows])

  const save = useCallback(async () => {
    if (problems.length) return
    setSaving(true)
    setError(null)
    try {
      const res = await api.patch<{ message: string }>(
        '/purchase/enquiries/quotes/' + quote.id + '/quote',
        {
          piNumber: piNumber.trim(),
          piDate,
          amount: amount === '' ? null : num(amount),
          validUntil: validUntil || null,
          remark: remark.trim() || null,
          rates: enquiry.lines.map((l) => {
            const r = rows[l.id]
            return {
              lineId: l.id,
              quotedRate: r?.quotedRate === '' ? null : num(r?.quotedRate ?? ''),
              gstRate: r?.gstRate === '' ? null : num(r?.gstRate ?? ''),
              offeredQty: r?.offeredQty === '' ? null : num(r?.offeredQty ?? ''),
              remark: r?.remark?.trim() || null,
            }
          }),
        }
      )
      // The scan lands after the PI it belongs to, so a file that fails to send
      // cannot leave a quote with paperwork and no number.
      const pending = await filesRef.current?.uploadPending(enquiry.id)
      onSaved(
        res.message +
          (pending?.failed.length ? ' These files did not send: ' + pending.failed.join(', ') : '')
      )
    } catch (err) {
      setError(apiErrorMessage(err, 'Could not record the PI.'))
    } finally {
      setSaving(false)
    }
  }, [problems, quote, enquiry, piNumber, piDate, amount, validUntil, remark, rows, onSaved])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !saving) onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, saving])

  return createPortal(
    /* Centred and sized to its content, not stretched to the window.
      The order and enquiry forms are full height because they are long; this
      one is four fields and a short table, and at full height two thirds of it
      was empty grey with the buttons stranded at the bottom of the screen. */
    <div className="fixed inset-0 z-50 flex items-center justify-center overflow-y-auto bg-black/60 p-2 backdrop-blur-sm sm:left-[var(--sidebar-current-width)] sm:p-4">
      <div
        className="glass-card po-form flex max-h-full w-full max-w-5xl flex-col overflow-hidden"
        role="dialog"
        aria-modal="true"
        aria-labelledby="quote-dialog-title"
      >
        <div className="border-border flex shrink-0 items-center justify-between gap-3 border-b px-4 py-3">
          <div className="min-w-0">
            <h2 id="quote-dialog-title" className="text-foreground text-base font-semibold">
              {revising ? 'Revised PI' : 'Record proforma invoice'}
            </h2>
            <p className="text-muted-foreground mt-0.5 text-xs">
              {enquiry.enquiryNumber} · {quote.supplier.name}
              {revising && ' · replaces ' + quote.piNumber}
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

        <div className="min-h-0 space-y-4 overflow-y-auto p-4">
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

          {/* Fixed widths, or every cell sizes itself off its own input and
            the three typed columns balloon to a third of the row each — which
            is what this table was doing: a 300px box holding the word "all",
            right-aligned, floating in the middle of nothing.

            What we are told sits narrow and grey; what he tells us is typed
            and therefore wider. The two are not interchangeable and the table
            should not pretend they are. */}
          <div className="border-border/70 overflow-x-auto rounded-lg border">
            <table className="subtable w-full table-fixed">
              <thead>
                <tr className="bg-secondary/60">
                  <th className="text-left" style={{ width: '26%' }}>
                    Item
                  </th>
                  <th style={{ width: '13%', textAlign: 'right' }}>Asked</th>
                  <th style={{ width: '12%', textAlign: 'right' }}>We expected</th>
                  <th style={{ width: '13%', textAlign: 'right' }}>He can supply</th>
                  <th style={{ width: '13%', textAlign: 'right' }}>He quotes</th>
                  <th style={{ width: '10%', textAlign: 'right' }}>GST %</th>
                  <th style={{ width: '13%', textAlign: 'right' }}>Line</th>
                </tr>
              </thead>
              <tbody>
                {enquiry.lines.map((l) => {
                  const r = rows[l.id]
                  const expected = l.expectedRate == null ? null : Number(l.expectedRate)
                  const quoted = r?.quotedRate === '' ? null : num(r?.quotedRate ?? '')
                  /* Flagged, not refused. A rate above what the buyer expected
                     is a negotiating position, not an error — but it is the one
                     thing they are reading this screen to find. */
                  const over = expected != null && quoted != null && quoted > expected
                  const useQty =
                    r?.offeredQty === '' || r?.offeredQty == null
                      ? Number(l.qty)
                      : num(r.offeredQty)
                  const short = useQty < Number(l.qty)
                  return (
                    <tr key={l.id}>
                      <td>
                        <p className="text-xs font-medium">{l.item.name}</p>
                        <p className="text-muted-foreground font-mono text-[10px]">{l.item.code}</p>
                      </td>
                      <td style={{ textAlign: 'right' }} className="text-xs tabular-nums">
                        {fmtQty(l.qty)}
                        <span className="text-muted-foreground ml-1 text-[10px]">
                          {l.item.uom?.symbol}
                        </span>
                      </td>
                      <td
                        style={{ textAlign: 'right' }}
                        className="text-muted-foreground text-xs tabular-nums"
                      >
                        {expected == null ? '—' : money(expected)}
                      </td>
                      <td>
                        {/* Empty means all of it, which is the usual answer.
                          Typing a smaller figure is how a buyer records that
                          he is short — and it is what the order carries, so
                          the balance stays unplaced on the enquiry. */}
                        <input
                          type="number"
                          step="0.001"
                          min="0"
                          value={r?.offeredQty ?? ''}
                          onChange={(e) => setRow(l.id, { offeredQty: e.target.value })}
                          placeholder="all"
                          className={`form-input text-right ${short ? 'border-amber-500/60' : ''}`}
                          aria-label={'Quantity offered for ' + l.item.name}
                        />
                        {short && (
                          <p className="mt-0.5 text-right text-[10px] text-amber-400">
                            {fmtQty(Number(l.qty) - useQty)} short
                          </p>
                        )}
                      </td>
                      <td>
                        <input
                          type="number"
                          step="0.01"
                          min="0"
                          value={r?.quotedRate ?? ''}
                          onChange={(e) => setRow(l.id, { quotedRate: e.target.value })}
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
                      <td>
                        <input
                          type="number"
                          step="0.01"
                          min="0"
                          max="100"
                          value={r?.gstRate ?? ''}
                          onChange={(e) => setRow(l.id, { gstRate: e.target.value })}
                          className="form-input text-right"
                          aria-label={'GST rate for ' + l.item.name}
                        />
                      </td>
                      <td style={{ textAlign: 'right' }} className="text-xs tabular-nums">
                        {quoted == null ? (
                          <span className="text-muted-foreground/60">—</span>
                        ) : (
                          money(useQty * quoted)
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

          <div className="grid gap-3 lg:grid-cols-2">
            <div>
              <label className="form-label" htmlFor="pi-remark">
                Note about his answer
              </label>
              <textarea
                id="pi-remark"
                value={remark}
                onChange={(e) => setRemark(e.target.value)}
                rows={2}
                placeholder="Lead time, packing, anything he said on the phone. Internal."
                className="form-input"
              />
            </div>
            <div>
              <span className="form-label">His proforma invoice</span>
              <AttachmentsBox
                ref={filesRef}
                basePath="/purchase/enquiries"
                linkBasePath="/purchase/enquiries/attachments"
                recordId={enquiry.id}
                extraBody={{ quoteId: quote.id }}
                filter={(a) => (a as { quoteId?: string | null }).quoteId === quote.id}
                onError={setError}
              />
              <p className="text-muted-foreground mt-1 text-[11px]">
                Filed against {quote.supplier.name}, not against the enquiry — so three suppliers do
                not leave three unlabelled PDFs in one list.
              </p>
            </div>
          </div>

          {priced === 0 && (
            <p className="text-muted-foreground text-xs">
              No rates typed. The PI will be recorded with its number and total only, which is
              enough to raise an order against — the order asks for its own rates.
            </p>
          )}
        </div>

        <div className="border-border flex shrink-0 flex-wrap items-center justify-between gap-3 border-t px-4 py-3">
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
