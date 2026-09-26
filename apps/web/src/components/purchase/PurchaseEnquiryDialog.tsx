'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  AlertCircle,
  ClipboardList,
  FileText,
  Loader2,
  MapPin,
  Package,
  Paperclip,
  Plus,
  Trash2,
  Truck,
  X,
} from 'lucide-react'
import { api, apiErrorMessage } from '@/lib/api'
import { Section } from '@/components/purchase/Section'
import { AttachmentsBox, type AttachmentsBoxHandle } from '@/components/purchase/AttachmentsBox'
import { IndentItemsDialog, type IndentPick } from '@/components/purchase/IndentItemsDialog'
import type { EnquiryRecord } from '@/components/purchase/enquiryTypes'

/**
 * Raising or correcting a purchase enquiry.
 *
 * Laid out as the mill's old ERP lays it out, because the people using this
 * spent years on that form: Location, Purchase Enquiry No., Reference, Enquiry
 * Date and Remark across the head; *Select Items From Indent Items* over the
 * item table; Item Code, Category, Subcategory and Item down it; and the
 * suppliers at the foot. The number is the one box that is read-only — it is
 * allotted by the server on save, so two people raising an enquiry at once
 * cannot be handed the same one.
 *
 * Deliberately smaller than the order form, which runs to four thousand lines.
 * An enquiry has no tax to split, no discount to place, no delivery address to
 * freeze and no charges to resolve, because none of that has been agreed yet —
 * the whole document is a question. Putting the order form's totals block on it
 * would be inventing figures nobody has quoted.
 *
 * No rate any supplier gave is typed here. What each of them says goes in
 * against his own PI number through `RecordQuoteDialog`, so a price on the
 * system always has a document behind it.
 */

interface Supplier {
  id: string
  code: string
  name: string
}

interface Category {
  id: string
  name: string
  parentId: string | null
}

interface Item {
  id: string
  code: string
  name: string
  hsnCode: string | null
  uom: { symbol: string } | null
  category: { id: string; name: string; parentId: string | null } | null
}

interface Warehouse {
  id: string
  name: string
}

/** One editable row. `id` is kept so the server can tell a correction from a swap. */
interface Line {
  key: string
  id: string | null
  itemId: string
  /** What was typed in the Item Code box, which may not have matched anything yet. */
  codeText: string
  categoryId: string
  subcategoryId: string
  qty: string
  expectedRate: string
  description: string
  mrLineId: string | null
  mrNumber: string | null
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
  /** The id comes back so the list can open the new enquiry straight away. */
  onSaved: (message: string, id?: string) => void
}) {
  const editing = Boolean(record)

  const [enquiryDate, setEnquiryDate] = useState(
    iso(record?.enquiryDate) || new Date().toISOString().slice(0, 10)
  )
  const [requiredDate, setRequiredDate] = useState(iso(record?.requiredDate))
  const [locationId, setLocationId] = useState(record?.locationId ?? '')
  const [reference, setReference] = useState(record?.reference ?? '')
  const [notes, setNotes] = useState(record?.notes ?? '')
  const [terms, setTerms] = useState(record?.terms ?? '')
  const [remark, setRemark] = useState(record?.remark ?? '')

  /*
   * Who to ask. Only settable while raising: once the enquiry exists the
   * suppliers are added and removed from the comparison panel, where their
   * answers live — a form that could silently drop a supplier would take his
   * recorded PI with him.
   */
  const [supplierIds, setSupplierIds] = useState<string[]>([])

  const [lines, setLines] = useState<Line[]>(
    record
      ? record.lines.map((l) => ({
          key: nextKey(),
          id: l.id,
          itemId: l.itemId,
          codeText: l.item.code,
          categoryId: '',
          subcategoryId: '',
          qty: String(Number(l.qty)),
          expectedRate: l.expectedRate == null ? '' : String(Number(l.expectedRate)),
          description: l.description ?? '',
          mrLineId: l.mrLineId,
          mrNumber: l.mrLine?.mr.mrNumber ?? null,
        }))
      : []
  )

  const [suppliers, setSuppliers] = useState<Supplier[]>([])
  const [items, setItems] = useState<Item[]>([])
  const [categories, setCategories] = useState<Category[]>([])
  const [warehouses, setWarehouses] = useState<Warehouse[]>([])
  const [loadingRefs, setLoadingRefs] = useState(true)
  const [indentOpen, setIndentOpen] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const filesRef = useRef<AttachmentsBoxHandle>(null)

  useEffect(() => {
    let alive = true
    Promise.all([
      api.get<{ data: Supplier[] }>('/masters/suppliers?limit=500&active=true'),
      api.get<{ data: Item[] }>('/masters/items?limit=1000&active=true'),
      api.get<{ data: Category[] }>('/masters/categories?limit=500'),
      api.get<{ data: Warehouse[] }>('/masters/warehouses?limit=200&active=true'),
    ])
      .then(([s, i, c, w]) => {
        if (!alive) return
        setSuppliers(s.data)
        setItems(i.data)
        setCategories(c.data)
        setWarehouses(w.data)
      })
      .catch(() => {
        if (alive) setError('Could not load the masters. Close and try again.')
      })
      .finally(() => {
        if (alive) setLoadingRefs(false)
      })
    return () => {
      alive = false
    }
  }, [])

  const topCategories = useMemo(() => categories.filter((c) => !c.parentId), [categories])
  const subsOf = useCallback(
    (parentId: string) => categories.filter((c) => c.parentId === parentId),
    [categories]
  )

  const blank = (): Line => ({
    key: nextKey(),
    id: null,
    itemId: '',
    codeText: '',
    categoryId: '',
    subcategoryId: '',
    qty: '',
    expectedRate: '',
    description: '',
    mrLineId: null,
    mrNumber: null,
  })

  const addLine = useCallback(() => setLines((p) => [...p, blank()]), [])

  const setLine = useCallback((key: string, patch: Partial<Line>) => {
    setLines((prev) => prev.map((l) => (l.key === key ? { ...l, ...patch } : l)))
  }, [])

  const removeLine = useCallback((key: string) => {
    setLines((prev) => prev.filter((l) => l.key !== key))
  }, [])

  /**
   * Typing a code straight into the Item Code box, as the old form allows.
   *
   * Matched exactly and case-insensitively, and only on an exact match — a
   * partial match that guessed would put the wrong item on an enquiry that goes
   * out to three suppliers. What was typed is kept either way, so nothing is
   * silently discarded and the dropdown beside it is still there to pick from.
   */
  const pickByCode = useCallback(
    (key: string, code: string) => {
      const hit = items.find((i) => (i.code ?? '').toLowerCase() === code.trim().toLowerCase())
      if (!hit) {
        setLine(key, { codeText: code, itemId: '' })
        return
      }
      const cat = categories.find((c) => c.id === hit.category?.id)
      setLine(key, {
        codeText: code,
        itemId: hit.id,
        categoryId: cat?.parentId ?? cat?.id ?? '',
        subcategoryId: cat?.parentId ? cat.id : '',
      })
    },
    [items, categories, setLine]
  )

  /** Items on offer for a row, narrowed by whatever category it has chosen. */
  const itemsFor = useCallback(
    (l: Line) => {
      const want = l.subcategoryId || l.categoryId
      if (!want) return items
      const ids = new Set([want, ...subsOf(want).map((c) => c.id)])
      return items.filter((i) => (i.category ? ids.has(i.category.id) : false))
    },
    [items, subsOf]
  )

  const pickItem = useCallback(
    (key: string, itemId: string) => {
      const item = items.find((i) => i.id === itemId)
      setLine(key, { itemId, codeText: item?.code ?? '' })
    },
    [items, setLine]
  )

  /*
   * Lines taken off the indent list.
   *
   * The same picker the order form uses, because it answers the same question —
   * what has production asked for that nobody has bought. Taking them onto an
   * enquiry rather than straight onto an order is the honest route when the
   * rate is not known: the request keeps its link to the job through
   * `mrLineId`, and that travels on to the order when one is raised.
   */
  const takeIndent = useCallback(
    (picks: IndentPick[]) => {
      setIndentOpen(false)
      setLines((prev) => [
        ...prev,
        ...picks.map((p) => {
          const cat = categories.find(
            (c) => c.id === (p.row.item as { category?: { id: string } }).category?.id
          )
          return {
            key: nextKey(),
            id: null,
            itemId: p.row.item.id,
            codeText: p.row.item.code,
            categoryId: cat?.parentId ?? cat?.id ?? '',
            subcategoryId: cat?.parentId ? cat.id : '',
            qty: String(p.qty),
            expectedRate: '',
            description: '',
            mrLineId: p.row.mrLineId,
            mrNumber: p.row.mrNumber,
          }
        }),
      ])
    },
    [categories]
  )

  const estimate = useMemo(
    () => lines.reduce((t, l) => t + num(l.qty) * num(l.expectedRate), 0),
    [lines]
  )

  const problems = useMemo(() => {
    const out: string[] = []
    if (lines.length === 0) out.push('Add at least one item')
    if (lines.some((l) => !l.itemId)) out.push('Every line needs an item')
    if (lines.some((l) => num(l.qty) <= 0)) out.push('Every line needs a quantity above zero')
    if (requiredDate && enquiryDate && requiredDate < enquiryDate) {
      out.push('The date needed cannot be before the enquiry date')
    }
    return out
  }, [lines, requiredDate, enquiryDate])

  const save = useCallback(async () => {
    if (problems.length) return
    setSaving(true)
    setError(null)

    const payload = {
      enquiryDate,
      requiredDate: requiredDate || null,
      locationId: locationId || null,
      reference: reference.trim() || null,
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
        mrLineId: l.mrLineId,
      })),
      ...(editing ? {} : { supplierIds }),
    }

    try {
      if (record) {
        const res = await api.patch<{ data: EnquiryRecord }>(
          '/purchase/enquiries/' + record.id,
          payload
        )
        onSaved(res.data.enquiryNumber + ' updated.', res.data.id)
      } else {
        const res = await api.post<{ data: EnquiryRecord }>('/purchase/enquiries', payload)
        // Files chosen before the enquiry existed have somewhere to go now.
        const pending = await filesRef.current?.uploadPending(res.data.id)
        onSaved(
          res.data.enquiryNumber +
            ' raised' +
            (supplierIds.length
              ? ' for ' + supplierIds.length + ' supplier' + (supplierIds.length > 1 ? 's' : '')
              : '') +
            '.' +
            (pending?.failed.length
              ? ' These files did not send: ' + pending.failed.join(', ')
              : ''),
          res.data.id
        )
      }
    } catch (err) {
      setError(apiErrorMessage(err, 'Could not save the enquiry.'))
    } finally {
      setSaving(false)
    }
  }, [
    problems,
    enquiryDate,
    requiredDate,
    locationId,
    reference,
    notes,
    terms,
    remark,
    lines,
    supplierIds,
    editing,
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
    /* The module's own shell: offset past the sidebar so the menu stays
      reachable, full height, and `po-form` so the labels and fields match the
      order, bill and receipt forms rather than inventing a third look. */
    <div className="fixed inset-0 z-40 flex items-stretch justify-center bg-black/60 p-2 backdrop-blur-sm sm:left-[var(--sidebar-current-width)] sm:p-3">
      <div
        className="glass-card po-form flex h-full max-h-full w-full flex-col overflow-hidden"
        role="dialog"
        aria-modal="true"
        aria-labelledby="enquiry-dialog-title"
      >
        <div className="border-border flex shrink-0 items-center justify-between gap-3 border-b px-4 py-3">
          <div className="min-w-0">
            <h2 id="enquiry-dialog-title" className="text-foreground text-base font-semibold">
              {editing ? 'Correct ' + record!.enquiryNumber : 'New purchase enquiry'}
            </h2>
            <p className="text-muted-foreground mt-0.5 text-xs">
              {editing
                ? 'Quantities the suppliers have already been asked about. Rates they quoted are kept.'
                : 'Quantities now, prices when they answer. The number is allotted on save.'}
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

        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4">
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

          <Section icon={FileText} title="Basic Details">
            <div className="grid grid-cols-[repeat(auto-fit,minmax(105px,1fr))] gap-x-4 gap-y-3 md:grid-cols-3">
              <div>
                <label className="form-label" htmlFor="enq-location">
                  Location
                </label>
                <div className="relative">
                  <MapPin
                    size={14}
                    className="text-muted-foreground pointer-events-none absolute left-3 top-1/2 z-10 -translate-y-1/2"
                  />
                  <select
                    id="enq-location"
                    value={locationId}
                    onChange={(e) => setLocationId(e.target.value)}
                    className="form-input pl-9"
                  >
                    <option value="">Head office</option>
                    {warehouses.map((w) => (
                      <option key={w.id} value={w.id}>
                        {w.name}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
              <div>
                <label className="form-label" htmlFor="enq-no">
                  Purchase Enquiry No.
                </label>
                {/* Read-only, and said so. The number is allotted by the server
                  on save so two people raising an enquiry at the same moment
                  cannot be handed the same one. */}
                <input
                  id="enq-no"
                  value={record?.enquiryNumber ?? 'Allotted on save'}
                  readOnly
                  disabled
                  className="form-input font-mono"
                />
              </div>
              <div>
                <label className="form-label" htmlFor="enq-date">
                  Enquiry Date
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
                <label className="form-label" htmlFor="enq-ref">
                  Reference
                </label>
                <input
                  id="enq-ref"
                  value={reference}
                  onChange={(e) => setReference(e.target.value)}
                  placeholder="Job no, indent slip, your own reference"
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
              </div>
              <div>
                <label className="form-label" htmlFor="enq-remark">
                  Remark
                </label>
                <input
                  id="enq-remark"
                  value={remark}
                  onChange={(e) => setRemark(e.target.value)}
                  placeholder="Internal — never printed"
                  className="form-input"
                />
              </div>
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
                  title="What production has asked for and nobody has ordered yet"
                >
                  <ClipboardList size={14} />
                  Select Items From Indent Items
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
                <table className="subtable w-full">
                  <thead>
                    <tr className="bg-secondary/60">
                      <th className="text-left" style={{ width: 140 }}>
                        Item Code
                      </th>
                      <th className="text-left">Item &amp; Description</th>
                      <th style={{ width: 110, textAlign: 'right' }}>Quantity</th>
                      <th style={{ width: 110, textAlign: 'right' }}>Expected rate</th>
                      <th style={{ width: 40 }} />
                    </tr>
                  </thead>
                  <tbody>
                    {lines.map((l) => (
                      <tr key={l.key}>
                        <td>
                          <input
                            value={l.codeText}
                            onChange={(e) => setLine(l.key, { codeText: e.target.value })}
                            onBlur={(e) => pickByCode(l.key, e.target.value)}
                            placeholder="Items Code"
                            className={`form-input font-mono ${
                              l.codeText && !l.itemId ? 'border-amber-500/60' : ''
                            }`}
                            aria-label="Item code"
                          />
                          {l.codeText && !l.itemId && (
                            <p className="mt-0.5 text-[10px] text-amber-400">
                              no item with that code
                            </p>
                          )}
                        </td>
                        <td>
                          {/* Category over subcategory over item, as the old
                            form has it. Each narrows the one below, and
                            leaving them empty offers every item — a buyer who
                            knows what they want should not have to file it
                            first. */}
                          <div className="flex flex-wrap gap-1.5">
                            <select
                              value={l.categoryId}
                              onChange={(e) =>
                                setLine(l.key, { categoryId: e.target.value, subcategoryId: '' })
                              }
                              className="form-input w-auto min-w-[120px] flex-1"
                              aria-label="Category"
                            >
                              <option value="">Category …</option>
                              {topCategories.map((c) => (
                                <option key={c.id} value={c.id}>
                                  {c.name}
                                </option>
                              ))}
                            </select>
                            <select
                              value={l.subcategoryId}
                              onChange={(e) => setLine(l.key, { subcategoryId: e.target.value })}
                              disabled={!l.categoryId}
                              className="form-input w-auto min-w-[120px] flex-1"
                              aria-label="Subcategory"
                            >
                              <option value="">Subcategory …</option>
                              {subsOf(l.categoryId).map((c) => (
                                <option key={c.id} value={c.id}>
                                  {c.name}
                                </option>
                              ))}
                            </select>
                          </div>
                          <select
                            value={l.itemId}
                            onChange={(e) => pickItem(l.key, e.target.value)}
                            disabled={loadingRefs}
                            className="form-input mt-1.5"
                            aria-label="Item"
                          >
                            <option value="">{loadingRefs ? 'Loading items…' : 'Items'}</option>
                            {itemsFor(l).map((i) => (
                              <option key={i.id} value={i.id}>
                                {i.code} · {i.name}
                              </option>
                            ))}
                          </select>
                          <textarea
                            value={l.description}
                            onChange={(e) => setLine(l.key, { description: e.target.value })}
                            rows={2}
                            placeholder="In our own words, if it differs"
                            className="form-input mt-1.5"
                            aria-label="Description"
                          />
                          {l.mrNumber && (
                            <p className="text-muted-foreground mt-0.5 text-[10px]">
                              against indent {l.mrNumber}
                            </p>
                          )}
                        </td>
                        <td>
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
                        <td>
                          {/* Ours, not theirs, and labelled as an estimate
                            wherever it is shown. What a supplier quotes is
                            recorded against his PI number and never typed on
                            this form. */}
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
                        <td style={{ textAlign: 'right' }}>
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

          {/* Suppliers only while raising. Once the enquiry exists they are
            added and removed from the comparison panel, where their answers
            live — a form that could drop a supplier would take his recorded PI
            with him, and the order that quotes it would be left pointing at
            nothing. */}
          {!editing && (
            <Section
              icon={Truck}
              title="Suppliers to ask"
              summary={supplierIds.length ? supplierIds.length + ' chosen' : 'None yet'}
            >
              <p className="text-muted-foreground mb-2 text-xs">
                Tick everybody you want a rate from. Asking two or three is what makes the
                comparison worth reading — and you can add more once it is raised.
              </p>
              <div className="grid max-h-56 gap-1 overflow-y-auto sm:grid-cols-2 lg:grid-cols-3">
                {suppliers.map((s) => {
                  const on = supplierIds.includes(s.id)
                  return (
                    <label
                      key={s.id}
                      className={`flex cursor-pointer items-center gap-2 rounded-lg border px-2.5 py-1.5 text-xs transition-colors ${
                        on
                          ? 'border-primary/40 bg-primary/5'
                          : 'border-border/70 hover:bg-secondary/40'
                      }`}
                    >
                      <input
                        type="checkbox"
                        checked={on}
                        onChange={() =>
                          setSupplierIds((prev) =>
                            prev.includes(s.id) ? prev.filter((x) => x !== s.id) : [...prev, s.id]
                          )
                        }
                        className="accent-primary"
                      />
                      <span className="min-w-0 truncate">{s.name}</span>
                    </label>
                  )
                })}
              </div>
            </Section>
          )}

          <Section
            icon={Paperclip}
            title="Drawings and specifications"
            foldable
            openByDefault={false}
            summary="What every supplier gets a copy of"
          >
            <p className="text-muted-foreground mb-2 text-xs">
              Files here go to everybody asked. A supplier&rsquo;s own proforma invoice is filed
              against him when you record it, not here.
            </p>
            <AttachmentsBox
              ref={filesRef}
              basePath="/purchase/enquiries"
              linkBasePath="/purchase/enquiries/attachments"
              recordId={record?.id}
              filter={(a) => !(a as { quoteId?: string | null }).quoteId}
              onError={setError}
            />
          </Section>

          <Section
            icon={FileText}
            title="Notes and terms"
            foldable
            openByDefault={false}
            summary={notes || terms ? 'Filled in' : 'The mill’s standing terms, nothing extra'}
          >
            <div className="grid gap-3 lg:grid-cols-2">
              <div>
                <label className="form-label" htmlFor="enq-notes">
                  Notes to the suppliers
                </label>
                <textarea
                  id="enq-notes"
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  rows={3}
                  className="form-input"
                  placeholder="Printed on their copies"
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
                  placeholder="Printed on their copies"
                />
              </div>
            </div>
          </Section>
        </div>

        <div className="border-border flex shrink-0 flex-wrap items-center justify-between gap-3 border-t px-4 py-3">
          <div className="min-w-0">
            {/* Labelled an estimate every time it is shown. It is built from
              rates nobody has agreed to, and a bare total here would read as a
              price. */}
            <p className="text-muted-foreground text-[11px]">Our own estimate</p>
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
