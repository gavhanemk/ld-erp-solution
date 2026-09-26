'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  AlertCircle,
  CalendarDays,
  ClipboardList,
  FileText,
  Loader2,
  Package,
  Plus,
  Trash2,
  Truck,
  X,
} from 'lucide-react'
import { api, apiErrorMessage } from '@/lib/api'
import { Section } from '@/components/purchase/Section'
import { Readout } from '@/components/purchase/FormBits'
import { IndentItemsDialog, type IndentPick } from '@/components/purchase/IndentItemsDialog'

/**
 * Raising or correcting a purchase enquiry.
 *
 * Deliberately smaller than the order form, which runs to four thousand lines.
 * An enquiry has no tax to split, no discount to place, no delivery address to
 * freeze and no charges to resolve, because none of that has been agreed yet —
 * the whole document is a question. Putting the order form's totals block on it
 * would be inventing figures nobody has quoted.
 *
 * The one rate here is `expectedRate`, and it is optional and labelled as an
 * estimate. What the supplier says goes on through `RecordQuoteDialog`, against
 * his PI number — never typed into this form, so a price on the system always
 * has a document behind it.
 */

export interface EnquiryRecord {
  id: string
  enquiryNumber: string
  enquiryDate: string
  requiredDate: string | null
  status: string
  sentAt: string | null
  piNumber: string | null
  piDate: string | null
  piAmount: string | null
  piValidUntil: string | null
  placeOfSupplyCode: string | null
  notes: string | null
  terms: string | null
  remark: string | null
  closeReason: string | null
  supplier: {
    id: string
    code: string
    name: string
    gstin: string | null
    stateCode: string | null
  } | null
  lines: Array<{
    id: string
    itemId: string
    description: string | null
    qty: string
    expectedRate: string | null
    quotedRate: string | null
    gstRate: string | null
    mrLineId: string | null
    item: {
      id: string
      code: string
      name: string
      hsnCode: string | null
      uom: { symbol: string } | null
    }
    mrLine: { id: string; mr: { id: string; mrNumber: string } } | null
  }>
}

interface Supplier {
  id: string
  code: string
  name: string
  gstin: string | null
  stateCode: string | null
}

interface Item {
  id: string
  code: string
  name: string
  hsnCode: string | null
  uom: { symbol: string } | null
  taxRate: { id: string; rate: string | number } | null
}

/** One editable row. `id` is kept so the server can tell a correction from a swap. */
interface Line {
  key: string
  id: string | null
  itemId: string
  itemLabel: string
  uom: string
  qty: string
  expectedRate: string
  gstRate: string
  description: string
  mrLineId: string | null
  mrNumber: string | null
  /** Set once the supplier has priced it, and shown read-only. */
  quotedRate: string | null
}

const num = (v: string) => {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}

const iso = (d: string | null | undefined) => (d ? new Date(d).toISOString().slice(0, 10) : '')

let seq = 0
const nextKey = () => 'l' + ++seq

export function PurchaseEnquiryDialog({
  record,
  onClose,
  onSaved,
}: {
  record: EnquiryRecord | null
  onClose: () => void
  onSaved: (message: string) => void
}) {
  const editing = Boolean(record)

  const [supplierId, setSupplierId] = useState(record?.supplier?.id ?? '')
  const [enquiryDate, setEnquiryDate] = useState(
    iso(record?.enquiryDate) || new Date().toISOString().slice(0, 10)
  )
  const [requiredDate, setRequiredDate] = useState(iso(record?.requiredDate))
  const [notes, setNotes] = useState(record?.notes ?? '')
  const [terms, setTerms] = useState(record?.terms ?? '')
  const [remark, setRemark] = useState(record?.remark ?? '')

  const [lines, setLines] = useState<Line[]>(
    record
      ? record.lines.map((l) => ({
          key: nextKey(),
          id: l.id,
          itemId: l.itemId,
          itemLabel: l.item.code + ' · ' + l.item.name,
          uom: l.item.uom?.symbol ?? '',
          qty: String(Number(l.qty)),
          expectedRate: l.expectedRate == null ? '' : String(Number(l.expectedRate)),
          gstRate: l.gstRate == null ? '' : String(Number(l.gstRate)),
          description: l.description ?? '',
          mrLineId: l.mrLineId,
          mrNumber: l.mrLine?.mr.mrNumber ?? null,
          quotedRate: l.quotedRate == null ? null : String(Number(l.quotedRate)),
        }))
      : []
  )

  const [suppliers, setSuppliers] = useState<Supplier[]>([])
  const [items, setItems] = useState<Item[]>([])
  const [loadingRefs, setLoadingRefs] = useState(true)
  const [indentOpen, setIndentOpen] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    Promise.all([
      api.get<{ data: Supplier[] }>('/masters/suppliers?limit=500&active=true'),
      api.get<{ data: Item[] }>('/masters/items?limit=1000&active=true'),
    ])
      .then(([s, i]) => {
        if (!alive) return
        setSuppliers(s.data)
        setItems(i.data)
      })
      .catch(() => {
        if (alive) setError('Could not load suppliers and items. Close and try again.')
      })
      .finally(() => {
        if (alive) setLoadingRefs(false)
      })
    return () => {
      alive = false
    }
  }, [])

  const supplier = useMemo(
    () => suppliers.find((s) => s.id === supplierId) ?? null,
    [suppliers, supplierId]
  )

  const addLine = useCallback(() => {
    setLines((prev) => [
      ...prev,
      {
        key: nextKey(),
        id: null,
        itemId: '',
        itemLabel: '',
        uom: '',
        qty: '',
        expectedRate: '',
        gstRate: '',
        description: '',
        mrLineId: null,
        mrNumber: null,
        quotedRate: null,
      },
    ])
  }, [])

  const setLine = useCallback((key: string, patch: Partial<Line>) => {
    setLines((prev) => prev.map((l) => (l.key === key ? { ...l, ...patch } : l)))
  }, [])

  const removeLine = useCallback((key: string) => {
    setLines((prev) => prev.filter((l) => l.key !== key))
  }, [])

  /** Picking an item fills the unit and the GST rate the master carries. */
  const pickItem = useCallback(
    (key: string, itemId: string) => {
      const item = items.find((i) => i.id === itemId)
      setLine(key, {
        itemId,
        itemLabel: item ? item.code + ' · ' + item.name : '',
        uom: item?.uom?.symbol ?? '',
        gstRate: item?.taxRate ? String(Number(item.taxRate.rate)) : '',
      })
    },
    [items, setLine]
  )

  /*
   * Lines taken off the indent list.
   *
   * The same picker the order form uses, because it answers the same question —
   * what has production asked for that nobody has bought. Taking them onto an
   * enquiry rather than straight onto an order is the honest route when the rate
   * is not known: the request keeps its link to the job through `mrLineId`, and
   * it travels from here onto the order when one is raised.
   */
  const takeIndent = useCallback((picks: IndentPick[]) => {
    setIndentOpen(false)
    setLines((prev) => [
      ...prev,
      ...picks.map((p) => ({
        key: nextKey(),
        id: null,
        itemId: p.row.item.id,
        itemLabel: p.row.item.code + ' · ' + p.row.item.name,
        uom: p.row.item.uom?.symbol ?? '',
        qty: String(p.qty),
        expectedRate: '',
        gstRate: p.row.item.taxRate ? String(Number(p.row.item.taxRate.rate)) : '',
        description: '',
        mrLineId: p.row.mrLineId,
        mrNumber: p.row.mrNumber,
        quotedRate: null,
      })),
    ])
  }, [])

  const estimate = useMemo(
    () =>
      lines.reduce((t, l) => {
        const rate = l.quotedRate != null ? num(l.quotedRate) : num(l.expectedRate)
        return t + num(l.qty) * rate
      }, 0),
    [lines]
  )

  const problems = useMemo(() => {
    const out: string[] = []
    if (!supplierId) out.push('Pick a supplier')
    if (lines.length === 0) out.push('Add at least one item')
    if (lines.some((l) => !l.itemId)) out.push('Every line needs an item')
    if (lines.some((l) => num(l.qty) <= 0)) out.push('Every line needs a quantity above zero')
    if (requiredDate && enquiryDate && requiredDate < enquiryDate) {
      out.push('The date needed cannot be before the enquiry date')
    }
    return out
  }, [supplierId, lines, requiredDate, enquiryDate])

  const save = useCallback(async () => {
    if (problems.length) return
    setSaving(true)
    setError(null)

    const payload = {
      supplierId,
      enquiryDate,
      requiredDate: requiredDate || null,
      notes: notes.trim() || null,
      terms: terms.trim() || null,
      remark: remark.trim() || null,
      lines: lines.map((l) => ({
        // Sent only when the line already exists, so the server can tell a
        // corrected line from a replaced one — and its guard on what has been
        // ordered has something to match against.
        ...(l.id ? { id: l.id } : {}),
        itemId: l.itemId,
        description: l.description.trim() || null,
        qty: num(l.qty),
        expectedRate: l.expectedRate === '' ? null : num(l.expectedRate),
        gstRate: l.gstRate === '' ? null : num(l.gstRate),
        mrLineId: l.mrLineId,
      })),
    }

    try {
      if (record) {
        const res = await api.patch<{ data: { enquiryNumber: string } }>(
          '/purchase/enquiries/' + record.id,
          payload
        )
        onSaved(res.data.enquiryNumber + ' updated.')
      } else {
        const res = await api.post<{ data: { enquiryNumber: string } }>(
          '/purchase/enquiries',
          payload
        )
        onSaved(res.data.enquiryNumber + ' raised. Send it to the supplier when it is ready.')
      }
    } catch (err) {
      setError(apiErrorMessage(err, 'Could not save the enquiry.'))
    } finally {
      setSaving(false)
    }
  }, [
    problems,
    supplierId,
    enquiryDate,
    requiredDate,
    notes,
    terms,
    remark,
    lines,
    record,
    onSaved,
  ])

  /** Escape closes, as every other dialog in the module does. */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !saving) onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, saving])

  return createPortal(
    <div className="fixed inset-0 z-40 flex items-start justify-center overflow-y-auto bg-black/60 p-4 backdrop-blur-sm">
      <div
        className="glass-card my-4 w-full max-w-5xl p-0"
        role="dialog"
        aria-modal="true"
        aria-labelledby="enquiry-dialog-title"
      >
        <div className="border-border/70 bg-card sticky top-0 z-10 flex items-center justify-between gap-3 rounded-t-xl border-b px-5 py-3">
          <div className="min-w-0">
            <h2 id="enquiry-dialog-title" className="text-foreground text-base font-semibold">
              {editing ? 'Correct ' + record!.enquiryNumber : 'New purchase enquiry'}
            </h2>
            <p className="text-muted-foreground mt-0.5 text-xs">
              {editing
                ? 'Quantities the supplier has already been asked about. Rates he quoted are kept.'
                : 'Quantities now, prices when he answers. The number is allotted on save.'}
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

        <div className="space-y-3 p-5">
          {error && (
            <div className="flex items-start gap-3 rounded-lg border border-red-500/40 bg-red-500/5 p-3">
              <AlertCircle size={16} className="mt-0.5 shrink-0 text-red-400" />
              <p className="text-sm text-red-400">{error}</p>
            </div>
          )}

          {/* Said once, at the top, rather than discovered when the order is
              raised. An enquiry that reads like an order is the one way this
              document could do harm. */}
          <p className="text-muted-foreground border-border/70 bg-secondary/30 rounded-lg border px-3 py-2 text-xs">
            Nothing here commits the mill. No stock is expected, nothing is owed, and the indent
            this answers still shows as needing to be ordered until a purchase order is raised.
          </p>

          <Section icon={Truck} title="Supplier">
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <div>
                <label className="form-label" htmlFor="enq-supplier">
                  Supplier
                </label>
                <select
                  id="enq-supplier"
                  value={supplierId}
                  onChange={(e) => setSupplierId(e.target.value)}
                  disabled={loadingRefs}
                  className="form-input"
                >
                  <option value="">{loadingRefs ? 'Loading suppliers…' : 'Pick a supplier'}</option>
                  {suppliers.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="form-label" htmlFor="enq-date">
                  Enquiry date
                </label>
                <input
                  id="enq-date"
                  type="date"
                  value={enquiryDate}
                  onChange={(e) => setEnquiryDate(e.target.value)}
                  className="form-input"
                />
              </div>
              <div>
                <label className="form-label" htmlFor="enq-needed">
                  Needed by
                </label>
                <input
                  id="enq-needed"
                  type="date"
                  value={requiredDate}
                  onChange={(e) => setRequiredDate(e.target.value)}
                  className="form-input"
                />
                <p className="text-muted-foreground mt-1 text-[11px]">
                  Printed, so he quotes against a date.
                </p>
              </div>
              {supplier && (
                <Readout label="GSTIN" icon={FileText}>
                  {supplier.gstin || 'Not on file'}
                </Readout>
              )}
            </div>
          </Section>

          <Section
            icon={Package}
            title="Items"
            actions={
              <>
                <button
                  type="button"
                  onClick={() => setIndentOpen(true)}
                  className="btn-ghost text-xs"
                >
                  <ClipboardList size={14} />
                  Select from indent
                </button>
                <button type="button" onClick={addLine} className="btn-ghost text-xs">
                  <Plus size={14} />
                  Add line
                </button>
              </>
            }
          >
            {lines.length === 0 ? (
              <div className="border-border/70 rounded-lg border border-dashed p-6 text-center">
                <p className="text-muted-foreground text-sm">Nothing on the enquiry yet.</p>
                <p className="text-muted-foreground mt-1 text-xs">
                  Take the lines off an indent, or add them by hand.
                </p>
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="text-muted-foreground text-[11px] uppercase">
                    <tr>
                      <th className="px-2 py-1.5 text-left font-medium">Item</th>
                      <th className="w-24 px-2 py-1.5 text-right font-medium">Qty</th>
                      <th className="w-16 px-2 py-1.5 text-left font-medium">Unit</th>
                      <th className="w-28 px-2 py-1.5 text-right font-medium">Expected rate</th>
                      <th className="w-20 px-2 py-1.5 text-right font-medium">GST %</th>
                      <th className="w-28 px-2 py-1.5 text-right font-medium">Quoted</th>
                      <th className="w-10 px-2 py-1.5" />
                    </tr>
                  </thead>
                  <tbody className="divide-border/60 divide-y">
                    {lines.map((l) => (
                      <tr key={l.key}>
                        <td className="px-2 py-1.5">
                          <select
                            value={l.itemId}
                            onChange={(e) => pickItem(l.key, e.target.value)}
                            disabled={loadingRefs}
                            className="form-input"
                            aria-label="Item"
                          >
                            <option value="">Pick an item</option>
                            {items.map((i) => (
                              <option key={i.id} value={i.id}>
                                {i.code} · {i.name}
                              </option>
                            ))}
                          </select>
                          {l.mrNumber && (
                            <p className="text-muted-foreground mt-0.5 text-[10px]">
                              against indent {l.mrNumber}
                            </p>
                          )}
                        </td>
                        <td className="px-2 py-1.5">
                          <input
                            type="number"
                            step="0.001"
                            min="0"
                            value={l.qty}
                            onChange={(e) => setLine(l.key, { qty: e.target.value })}
                            className="form-input text-right"
                            aria-label="Quantity"
                          />
                        </td>
                        <td className="text-muted-foreground px-2 py-1.5 text-xs">{l.uom}</td>
                        <td className="px-2 py-1.5">
                          <input
                            type="number"
                            step="0.01"
                            min="0"
                            value={l.expectedRate}
                            onChange={(e) => setLine(l.key, { expectedRate: e.target.value })}
                            placeholder="—"
                            className="form-input text-right"
                            aria-label="Expected rate"
                          />
                        </td>
                        <td className="px-2 py-1.5">
                          <input
                            type="number"
                            step="0.01"
                            min="0"
                            max="100"
                            value={l.gstRate}
                            onChange={(e) => setLine(l.key, { gstRate: e.target.value })}
                            className="form-input text-right"
                            aria-label="GST rate"
                          />
                        </td>
                        <td className="px-2 py-1.5 text-right">
                          {/* Read-only on purpose: it belongs to his PI, and it
                              is recorded against a PI number or not at all. */}
                          {l.quotedRate != null ? (
                            <span className="text-xs font-medium tabular-nums">
                              {Number(l.quotedRate).toLocaleString('en-IN', {
                                minimumFractionDigits: 2,
                              })}
                            </span>
                          ) : (
                            <span className="text-muted-foreground/60 text-xs">—</span>
                          )}
                        </td>
                        <td className="px-2 py-1.5 text-right">
                          <button
                            type="button"
                            onClick={() => removeLine(l.key)}
                            className="btn-ghost text-red-400"
                            aria-label="Remove line"
                          >
                            <Trash2 size={13} />
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Section>

          <Section
            icon={CalendarDays}
            title="Notes and terms"
            foldable
            openByDefault={false}
            summary={
              notes || terms || remark ? 'Filled in' : 'The mill’s standing terms, nothing extra'
            }
          >
            <div className="grid gap-3 lg:grid-cols-3">
              <div>
                <label className="form-label" htmlFor="enq-notes">
                  Notes to the supplier
                </label>
                <textarea
                  id="enq-notes"
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  rows={3}
                  className="form-input"
                  placeholder="Printed on his copy"
                />
              </div>
              <div>
                <label className="form-label" htmlFor="enq-terms">
                  Terms
                </label>
                <textarea
                  id="enq-terms"
                  value={terms}
                  onChange={(e) => setTerms(e.target.value)}
                  rows={3}
                  className="form-input"
                  placeholder="Printed on his copy"
                />
              </div>
              <div>
                <label className="form-label" htmlFor="enq-remark">
                  Internal remark
                </label>
                <textarea
                  id="enq-remark"
                  value={remark}
                  onChange={(e) => setRemark(e.target.value)}
                  rows={3}
                  className="form-input"
                  placeholder="Never printed"
                />
              </div>
            </div>
          </Section>
        </div>

        <div className="border-border/70 bg-card sticky bottom-0 flex flex-wrap items-center justify-between gap-3 rounded-b-xl border-t px-5 py-3">
          <div className="min-w-0">
            {/* Labelled an estimate every time it is shown. It is built from
                rates nobody has agreed to unless the supplier has quoted them,
                and a bare total here would read as a price. */}
            <p className="text-muted-foreground text-[11px]">
              {lines.some((l) => l.quotedRate != null) ? 'At quoted rates' : 'Rough estimate'}
            </p>
            <p className="text-foreground text-sm font-semibold tabular-nums">
              ₹
              {estimate.toLocaleString('en-IN', {
                minimumFractionDigits: 2,
                maximumFractionDigits: 2,
              })}
              <span className="text-muted-foreground ml-1.5 text-[11px] font-normal">
                before tax · not a quotation
              </span>
            </p>
          </div>
          <div className="flex items-center gap-2">
            {problems.length > 0 && (
              <p className="text-muted-foreground max-w-[280px] text-right text-[11px]">
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
              {saving && <Loader2 size={15} className="animate-spin" />}
              {editing ? 'Save changes' : 'Raise enquiry'}
            </button>
          </div>
        </div>
      </div>

      {indentOpen && (
        <IndentItemsDialog
          onClose={() => setIndentOpen(false)}
          onAdd={takeIndent}
          alreadyPicked={new Set(lines.map((l) => l.mrLineId).filter(Boolean) as string[])}
        />
      )}
    </div>,
    document.body
  )
}
