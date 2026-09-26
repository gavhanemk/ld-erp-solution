'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import {
  AlertCircle,
  Check,
  Loader2,
  Paperclip,
  Plus,
  Printer,
  Send,
  ShoppingCart,
  ThumbsDown,
  Trash2,
  Undo2,
} from 'lucide-react'
import { api, apiErrorMessage, can } from '@/lib/api'
import { formatDate } from '@/lib/utils'
import { RecordQuoteDialog } from '@/components/purchase/RecordQuoteDialog'
import { ReasonDialog } from '@/components/ui/ReasonDialog'
import {
  money,
  overBest,
  qty,
  quoteTotal,
  waitingFor,
  type EnquiryQuote,
  type EnquiryRecord,
} from '@/components/purchase/enquiryTypes'

/**
 * One enquiry opened up: who was asked, what each of them said, and which of
 * them is cheapest.
 *
 * This is the stage the old ERP calls *Supplier Rates*, and it is the reason
 * the enquiry is its own document rather than a status on a purchase order.
 * Three suppliers answering the same seven lines is a grid, and a grid is the
 * only honest way to show it: the buyer reads down a column to see one
 * supplier's offer and across a row to see who is cheapest on that item, and
 * neither of those is available from three separate documents.
 *
 * ── What the screen refuses to do for the buyer ─────────────────────────────
 *
 * It ranks, and it says how it ranked. It does not decide. A supplier who
 * priced two of seven lines will always look cheapest on totals, so the number
 * of lines he actually priced travels beside his total and an incomplete
 * comparison says so in words. Lead time, quality and how reliably somebody
 * delivers are not on this screen and never will be — which is exactly why the
 * cheapest column is marked rather than pre-selected.
 */

const MODULE = 'purchase'

export function EnquiryDetail({
  enquiryId,
  onChanged,
  onError,
}: {
  enquiryId: string
  /** Tells the list to reload, with a sentence for the banner where there is one. */
  onChanged: (message?: string) => void
  onError: (message: string) => void
}) {
  const [enquiry, setEnquiry] = useState<EnquiryRecord | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState<string | null>(null)

  const [suppliers, setSuppliers] = useState<Array<{ id: string; code: string; name: string }>>([])
  const [adding, setAdding] = useState('')
  const [quoting, setQuoting] = useState<EnquiryQuote | null>(null)
  const [declining, setDeclining] = useState<EnquiryQuote | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const res = await api.get<{ data: EnquiryRecord }>('/purchase/enquiries/' + enquiryId)
      setEnquiry(res.data)
    } catch (err) {
      onError(apiErrorMessage(err, 'Could not open that enquiry.'))
    } finally {
      setLoading(false)
    }
  }, [enquiryId, onError])

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    api
      .get<{ data: Array<{ id: string; code: string; name: string }> }>(
        '/masters/suppliers?limit=500&active=true'
      )
      .then((r) => setSuppliers(r.data))
      .catch(() => {})
  }, [])

  /** One helper for every action, so each reports and refreshes the same way. */
  const act = useCallback(
    async (key: string, run: () => Promise<{ message?: string }>) => {
      setBusy(key)
      try {
        const res = await run()
        await load()
        onChanged(res.message)
      } catch (err) {
        onError(apiErrorMessage(err, 'That did not go through.'))
      } finally {
        setBusy(null)
      }
    },
    [load, onChanged, onError]
  )

  const addSupplier = () => {
    if (!adding) return
    const supplierId = adding
    setAdding('')
    void act('add', () =>
      api.post<{ message?: string }>('/purchase/enquiries/' + enquiryId + '/quotes', { supplierId })
    )
  }

  /** Opens a stored file on a one-use link, the way every other list does. */
  const openFile = useCallback(
    async (id: string) => {
      try {
        const res = await api.get<{ data: { url: string } }>(
          '/purchase/enquiries/attachments/' + id + '/link'
        )
        window.open(res.data.url, '_blank', 'noopener')
      } catch (err) {
        onError(apiErrorMessage(err, 'Could not open that file.'))
      }
    },
    [onError]
  )

  const best = enquiry?.best?.amount ?? null

  /** Suppliers not yet on this enquiry, so the picker cannot offer a duplicate. */
  const addable = useMemo(() => {
    const on = new Set((enquiry?.quotes ?? []).map((q) => q.supplierId))
    return suppliers.filter((s) => !on.has(s.id))
  }, [suppliers, enquiry])

  if (loading && !enquiry) {
    return (
      <div className="text-muted-foreground flex items-center justify-center gap-2 p-6 text-sm">
        <Loader2 size={15} className="animate-spin" />
        Opening enquiry
      </div>
    )
  }
  if (!enquiry) return null

  const editable = enquiry.status !== 'CLOSED' && !enquiry.deletedAt
  const lines = enquiry.lines

  return (
    <div className="space-y-4 p-4">
      {/* ── What was asked for ────────────────────────────────────────────

        First, because this is what the row's chevron promises: the items. Same
        `.subtable` as the order, receipt and bill lists open into, so a person
        moving between the five screens is reading the same table each time.

        Ordered and unplaced sit here rather than only on the comparison,
        because part-ordering is ordinary — 600 of the 1,240 now, the rest when
        somebody can hold the price — and "what is left on this enquiry" is the
        question that sends a buyer back to it weeks later. */}
      <section>
        <h4 className="text-foreground mb-2 text-sm font-semibold">
          Items on this enquiry
          <span className="text-muted-foreground ml-2 text-xs font-normal">
            {lines.length} line{lines.length === 1 ? '' : 's'}
          </span>
        </h4>
        <div className="border-border/70 overflow-x-auto rounded-lg border">
          <table className="subtable w-full">
            <thead>
              <tr className="bg-secondary/60">
                <th className="text-left" style={{ width: 34 }}>
                  #
                </th>
                <th className="text-left">Item &amp; description</th>
                <th className="text-left">HSN</th>
                <th className="text-left">Against indent</th>
                <th style={{ textAlign: 'right' }}>Asked</th>
                <th style={{ textAlign: 'right' }}>We expected</th>
                <th style={{ textAlign: 'right' }}>Ordered</th>
                <th style={{ textAlign: 'right' }}>Still unplaced</th>
              </tr>
            </thead>
            <tbody>
              {lines.map((l, i) => {
                const unplaced = Number(l.pendingQty ?? Number(l.qty))
                return (
                  <tr key={l.id}>
                    <td className="text-muted-foreground">{i + 1}</td>
                    <td>
                      <p className="text-xs font-medium">{l.item.name}</p>
                      <p className="text-muted-foreground font-mono text-[10px]">{l.item.code}</p>
                      {l.description && (
                        <p className="text-muted-foreground text-[10px]">{l.description}</p>
                      )}
                    </td>
                    <td className="text-muted-foreground text-[11px]">{l.hsnCode ?? '—'}</td>
                    <td className="text-muted-foreground text-[11px]">
                      {l.mrLine?.mr.mrNumber ?? '—'}
                    </td>
                    <td style={{ textAlign: 'right' }} className="text-xs tabular-nums">
                      {qty(l.qty)}
                      <span className="text-muted-foreground ml-1 text-[10px]">
                        {l.item.uom?.symbol}
                      </span>
                    </td>
                    {/* Ours, and greyed, because it is a guess. It must never
                      read as a price somebody quoted. */}
                    <td
                      style={{ textAlign: 'right' }}
                      className="text-muted-foreground text-xs tabular-nums"
                    >
                      {l.expectedRate == null ? '—' : money(l.expectedRate)}
                    </td>
                    <td style={{ textAlign: 'right' }} className="text-xs tabular-nums">
                      {qty(l.orderedQty ?? 0)}
                    </td>
                    <td
                      style={{ textAlign: 'right' }}
                      className={`text-xs tabular-nums ${unplaced > 0 ? '' : 'text-muted-foreground'}`}
                    >
                      {qty(unplaced)}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </section>

      {/* ── Who was asked ─────────────────────────────────────────────────── */}
      <section>
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <h4 className="text-foreground text-sm font-semibold">
            Suppliers asked
            <span className="text-muted-foreground ml-2 text-xs font-normal">
              {enquiry.answeredCount} of {enquiry.supplierCount} have answered
            </span>
          </h4>
          {editable && can(MODULE, 'edit') && addable.length > 0 && (
            <div className="flex items-center gap-2">
              <select
                value={adding}
                onChange={(e) => setAdding(e.target.value)}
                className="form-input w-auto text-xs"
                aria-label="Add a supplier"
              >
                <option value="">Add a supplier…</option>
                {addable.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
              <button
                type="button"
                onClick={addSupplier}
                disabled={!adding || busy === 'add'}
                className="btn-ghost text-xs"
              >
                {busy === 'add' ? (
                  <Loader2 size={13} className="animate-spin" />
                ) : (
                  <Plus size={13} />
                )}
                Add
              </button>
            </div>
          )}
        </div>

        {enquiry.supplierCount === 0 ? (
          <div className="border-border/70 rounded-lg border border-dashed p-5 text-center">
            <p className="text-muted-foreground text-sm">Nobody has been asked yet.</p>
            <p className="text-muted-foreground mt-1 text-xs">
              Add the suppliers you want rates from. Asking two or three is what makes the
              comparison below worth reading.
            </p>
          </div>
        ) : null}
      </section>

      {enquiry.supplierCount > 0 && (
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {enquiry.quotes.map((q) => {
            const isBest = enquiry.best?.quoteId === q.id
            const over = overBest(q, best)
            const working = busy === q.id
            return (
              <div
                key={q.id}
                /* The cheapest is ringed, not filled and not pre-selected.
                   Marking it answers the question; choosing for the buyer
                   would pretend the screen knows about lead time and quality,
                   which it does not. */
                className={`rounded-lg border p-3 ${
                  q.declinedAt
                    ? 'border-border/60 bg-secondary/20 opacity-70'
                    : isBest
                      ? 'border-emerald-500/40 bg-emerald-500/5'
                      : 'border-border/70 bg-card'
                }`}
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="text-foreground truncate text-sm font-medium">
                      {q.supplier.name}
                    </p>
                    <p className="text-muted-foreground font-mono text-[11px]">{q.supplier.code}</p>
                  </div>
                  {isBest && !q.declinedAt && (
                    <span className="badge-success shrink-0">Cheapest</span>
                  )}
                  {q.declinedAt && <span className="badge-neutral shrink-0">Passed over</span>}
                  {q.ordered && <span className="badge-info shrink-0">Ordered</span>}
                </div>

                <div className="mt-2 space-y-1 text-xs">
                  {q.answered ? (
                    <>
                      <p className="font-mono">{q.piNumber}</p>
                      <p className="text-muted-foreground">
                        {q.piDate && formatDate(q.piDate)}
                        {q.piValidUntil &&
                          (q.expired ? (
                            <span className="ml-1 font-medium text-red-400">
                              · price lapsed {formatDate(q.piValidUntil)}
                            </span>
                          ) : (
                            <span className="ml-1">· holds to {formatDate(q.piValidUntil)}</span>
                          ))}
                      </p>
                      <p className="text-foreground text-base font-semibold tabular-nums">
                        ₹{money(quoteTotal(q))}
                        {/* How far off the cheapest, in the terms a buyer
                          argues in. "8% higher" is a negotiating position;
                          "₹680 more" is arithmetic they would have to do. */}
                        {over != null && (
                          <span className="ml-1.5 text-[11px] font-normal text-amber-400">
                            {(over * 100).toFixed(1)}% higher
                          </span>
                        )}
                      </p>
                      <p className="text-muted-foreground text-[11px]">
                        {q.piAmount != null ? 'his stated total' : 'from his rates, before tax'}
                        {' · '}
                        {q.pricedLines} of {lines.length} priced
                      </p>
                    </>
                  ) : (
                    <p className="text-muted-foreground">
                      {q.sentAt
                        ? 'No rates back yet · waiting ' + waitingFor(q.sentAt)
                        : 'Not yet sent to him'}
                    </p>
                  )}
                  {q.declinedReason && (
                    <p className="text-muted-foreground text-[11px] italic">{q.declinedReason}</p>
                  )}
                </div>

                {editable && can(MODULE, 'edit') && (
                  <div className="border-border/60 mt-3 flex flex-wrap items-center gap-1 border-t pt-2">
                    {working && <Loader2 size={13} className="animate-spin" />}
                    {!q.sentAt && (
                      <button
                        type="button"
                        onClick={() =>
                          void act(q.id, () =>
                            api.patch<{ message: string }>(
                              '/purchase/enquiries/quotes/' + q.id + '/send',
                              {}
                            )
                          )
                        }
                        disabled={working}
                        className="btn-ghost text-xs"
                      >
                        <Send size={13} /> Sent
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => setQuoting(q)}
                      disabled={working}
                      className="btn-ghost text-xs"
                    >
                      <Check size={13} /> {q.answered ? 'Revise PI' : 'Record PI'}
                    </button>
                    <a
                      href={'/print/purchase-enquiry/' + enquiry.id + '?quote=' + q.id}
                      target="_blank"
                      rel="noreferrer"
                      className="btn-ghost text-xs"
                      title={'His copy of ' + enquiry.enquiryNumber}
                    >
                      <Printer size={13} />
                    </a>
                    {q.answered && !q.declinedAt && can(MODULE, 'create') && (
                      <Link
                        href={'/purchase/orders?fromEnquiry=' + enquiry.id + '&fromQuote=' + q.id}
                        className="btn-primary text-xs"
                        title={'Raise a purchase order against ' + q.piNumber}
                      >
                        <ShoppingCart size={13} /> Order
                      </Link>
                    )}
                    {q.declinedAt ? (
                      <button
                        type="button"
                        onClick={() =>
                          void act(q.id, () =>
                            api.patch<{ message: string }>(
                              '/purchase/enquiries/quotes/' + q.id + '/reconsider',
                              {}
                            )
                          )
                        }
                        disabled={working}
                        className="btn-ghost text-xs"
                      >
                        <Undo2 size={13} /> Reconsider
                      </button>
                    ) : (
                      q.answered &&
                      !q.ordered && (
                        <button
                          type="button"
                          onClick={() => setDeclining(q)}
                          disabled={working}
                          className="btn-ghost text-xs"
                          title="Keep his quote on the record, but pass him over"
                        >
                          <ThumbsDown size={13} />
                        </button>
                      )
                    )}
                    {!q.ordered && can(MODULE, 'delete') && (
                      <button
                        type="button"
                        onClick={() =>
                          void act(q.id, () =>
                            api.delete<{ message: string }>('/purchase/enquiries/quotes/' + q.id)
                          )
                        }
                        disabled={working}
                        className="btn-ghost text-xs text-red-400"
                        title="Take him off the enquiry altogether"
                      >
                        <Trash2 size={13} />
                      </button>
                    )}
                  </div>
                )}

                {/* His paperwork, filed against him rather than against the
                  enquiry — three scanned PIs in one list with nothing saying
                  whose each was is not a filing system.

                  Listed here, attached in the Record PI dialog. The buyer is
                  holding the PDF at the moment they type its number, and a
                  drop zone in every supplier card would put three of them on a
                  panel that is meant to be read at a glance. */}
                {q.attachments.length > 0 && (
                  <div className="border-border/60 mt-2 border-t pt-2">
                    {q.attachments.map((a) => (
                      <button
                        key={a.id}
                        type="button"
                        onClick={() => void openFile(a.id)}
                        className="text-primary flex w-full items-center gap-1.5 truncate text-left text-[11px] hover:underline"
                      >
                        <Paperclip size={11} className="shrink-0" />
                        <span className="truncate">{a.fileName}</span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}

      {/* ── The grid ──────────────────────────────────────────────────────────

        Lines down the side, suppliers across the top. Read a column to see one
        supplier's whole offer; read a row to see who is cheapest on that item.
        Neither is available from three separate documents, which is the whole
        argument for this document existing.

        Shown once two suppliers have answered. With one there is nothing to
        compare and the card above already says what he quoted. */}
      {enquiry.answeredCount > 1 && (
        <section>
          <h4 className="text-foreground mb-2 text-sm font-semibold">
            Rates compared
            {!enquiry.comparable && (
              <span className="ml-2 text-xs font-normal text-amber-400">
                — not every supplier priced every line, so the totals are not like for like
              </span>
            )}
          </h4>
          <div className="border-border/70 overflow-x-auto rounded-lg border">
            <table className="subtable w-full">
              <thead>
                <tr className="bg-secondary/60">
                  <th className="text-left">Item</th>
                  <th style={{ textAlign: 'right' }}>Asked</th>
                  <th style={{ textAlign: 'right' }}>We expected</th>
                  {enquiry.quotes
                    .filter((q) => q.answered)
                    .map((q) => (
                      <th key={q.id} style={{ textAlign: 'right' }}>
                        {q.supplier.name}
                        {q.declinedAt && (
                          <span className="text-muted-foreground block text-[9px] font-normal">
                            passed over
                          </span>
                        )}
                      </th>
                    ))}
                </tr>
              </thead>
              <tbody>
                {lines.map((l) => {
                  const answered = enquiry.quotes.filter((q) => q.answered)
                  /* The cheapest rate on this row, so the winning cell can be
                     marked. Declined suppliers are out of the running — a
                     highlight on a rate nobody is going to use misleads. */
                  const rates = answered
                    .filter((q) => !q.declinedAt)
                    .map((q) => Number(l.quotedBy?.[q.id]?.quotedRate ?? NaN))
                    .filter((n) => Number.isFinite(n) && n > 0)
                  const low = rates.length > 1 ? Math.min(...rates) : null

                  return (
                    <tr key={l.id}>
                      <td>
                        <p className="text-xs font-medium">{l.item.name}</p>
                        <p className="text-muted-foreground font-mono text-[10px]">{l.item.code}</p>
                      </td>
                      <td style={{ textAlign: 'right' }} className="text-xs tabular-nums">
                        {qty(l.qty)}
                        <span className="text-muted-foreground ml-1 text-[10px]">
                          {l.item.uom?.symbol}
                        </span>
                      </td>
                      <td
                        style={{ textAlign: 'right' }}
                        className="text-muted-foreground text-xs tabular-nums"
                      >
                        {l.expectedRate == null ? '—' : money(l.expectedRate)}
                      </td>
                      {answered.map((q) => {
                        const ql = l.quotedBy?.[q.id] ?? null
                        const rate = ql?.quotedRate == null ? null : Number(ql.quotedRate)
                        const isLow = low != null && rate != null && rate === low
                        return (
                          <td
                            key={q.id}
                            style={{ textAlign: 'right' }}
                            className={`text-xs tabular-nums ${
                              isLow ? 'font-semibold text-emerald-400' : ''
                            }`}
                          >
                            {rate == null ? (
                              <span className="text-muted-foreground/50">not priced</span>
                            ) : (
                              money(rate)
                            )}
                            {/* Where he cannot supply the whole line. A rate
                              for 800 of the 1,240 asked is a different offer
                              from a rate for all of it, and the buyer splitting
                              an order between two suppliers is doing it for
                              exactly this reason. */}
                            {ql?.offeredQty != null && Number(ql.offeredQty) < Number(l.qty) && (
                              <span className="block text-[10px] font-normal text-amber-400">
                                only {qty(ql.offeredQty)}
                              </span>
                            )}
                          </td>
                        )
                      })}
                    </tr>
                  )
                })}
              </tbody>
              <tfoot>
                <tr>
                  <td colSpan={3} className="text-xs font-medium">
                    Total at his rates
                  </td>
                  {enquiry.quotes
                    .filter((q) => q.answered)
                    .map((q) => (
                      <td
                        key={q.id}
                        style={{ textAlign: 'right' }}
                        className={`text-xs font-semibold tabular-nums ${
                          enquiry.best?.quoteId === q.id && !q.declinedAt ? 'text-emerald-400' : ''
                        }`}
                      >
                        ₹{money(q.value)}
                      </td>
                    ))}
                </tr>
                <tr>
                  <td colSpan={3} className="text-muted-foreground text-xs">
                    Total his PI states
                  </td>
                  {enquiry.quotes
                    .filter((q) => q.answered)
                    .map((q) => (
                      <td
                        key={q.id}
                        style={{ textAlign: 'right' }}
                        className="text-muted-foreground text-xs tabular-nums"
                      >
                        {q.piAmount == null ? '—' : '₹' + money(q.piAmount)}
                      </td>
                    ))}
                </tr>
              </tfoot>
            </table>
          </div>
          <p className="text-muted-foreground mt-2 text-[11px]">
            Cheapest is marked, not chosen. Lead time, quality and how reliably somebody delivers
            are not on this screen — the figures are one part of the decision.
          </p>
        </section>
      )}

      {quoting && (
        <RecordQuoteDialog
          enquiry={enquiry}
          quote={quoting}
          onClose={() => setQuoting(null)}
          onSaved={(msg) => {
            setQuoting(null)
            void load()
            onChanged(msg)
          }}
        />
      )}

      {declining && (
        <ReasonDialog
          title={'Pass over ' + declining.supplier.name}
          description="His quote stays on the enquiry with this against it, so the record says you asked him, he answered, and why he did not get it. He comes back into the running on his own if he sends a revised PI."
          confirmLabel="Pass over"
          onCancel={() => setDeclining(null)}
          onConfirm={(reason) => {
            const q = declining
            setDeclining(null)
            void act(q.id, () =>
              api.patch<{ message: string }>('/purchase/enquiries/quotes/' + q.id + '/decline', {
                reason,
              })
            )
          }}
        />
      )}
    </div>
  )
}
