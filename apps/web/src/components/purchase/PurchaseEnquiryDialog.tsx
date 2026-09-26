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
  /** The item's unit, shown under the quantity so a figure says what it counts. */
  uom: string
  expectedRate: string
  description: string
  mrLineId: string | null
  mrNumber: string | null
}

/*
 * The widths of the item table.
 *
 * Declared rather than left to the browser: `table-fixed` needs a number per
 * column, and without one the cells size themselves off whatever is typed in
 * them — which is how the code box ended up at 140px of a 1600px row while
 * three full-width dropdowns stacked in the cell beside it.
 *
 * Only the item name and the description hold anything sentence-shaped; the
 * rest are a code, a figure or a short dropdown and gain nothing from being
 * wider. Their sum is the table's `min-w`, so a narrow screen scrolls rather
 * than crushing eight columns into what it has.
 */
const COL = {
  num: 'w-8',
  code: 'w-32',
  category: 'w-44',
  item: 'w-72',
  description: 'w-44',
  qty: 'w-24',
  rate: 'w-28',
  remove: 'w-10',
} as const

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
          uom: l.item.uom?.symbol ?? '',
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
      api.get<{ data: Category[] }>('/masters/item-categories?limit=500'),
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
    uom: '',
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
        setLine(key, { codeText: code, itemId: '', uom: '' })
        return
      }
      const cat = categories.find((c) => c.id === hit.category?.id)
      setLine(key, {
        codeText: code,
        itemId: hit.id,
        uom: hit.uom?.symbol ?? '',
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

  /**
   * Picking an item fills in everything that describes it.
   *
   * The code box and both category boxes follow, so a row never sits there
   * saying "Category: Fabric" over an item filed under Trims. The three
   * controls are one question asked three ways, and whichever of them the buyer
   * answers, the other two have to agree with it.
   */
  const pickItem = useCallback(
    (key: string, itemId: string) => {
      const item = items.find((i) => i.id === itemId)
      const cat = categories.find((c) => c.id === item?.category?.id)
      setLine(key, {
        itemId,
        codeText: item?.code ?? '',
        uom: item?.uom?.symbol ?? '',
        categoryId: cat?.parentId ?? cat?.id ?? '',
        subcategoryId: cat?.parentId ? cat.id : '',
      })
    },
    [items, categories, setLine]
  )

  /**
   * Narrowing the category, which can invalidate the item already chosen.
   *
   * The item is cleared only when it genuinely no longer belongs under what was
   * picked. Clearing it on every change would punish a buyer who chose the item
   * first and then set the category to match — which is the commoner way round,
   * because the code is what is on the indent slip in their hand.
   */
  const narrow = useCallback(
    (key: string, patch: { categoryId?: string; subcategoryId?: string }) => {
      setLines((prev) =>
        prev.map((l) => {
          if (l.key !== key) return l
          const next = { ...l, ...patch }
          if (patch.categoryId !== undefined) next.subcategoryId = ''
          const want = next.subcategoryId || next.categoryId
          if (want && next.itemId) {
            const item = items.find((i) => i.id === next.itemId)
            const ids = new Set([
              want,
              ...categories.filter((c) => c.parentId === want).map((c) => c.id),
            ])
            if (!item?.category || !ids.has(item.category.id)) {
              next.itemId = ''
              next.codeText = ''
              next.uom = ''
            }
          }
          return next
        })
      )
    },
    [items, categories]
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
            uom: p.row.item.uom?.symbol ?? '',
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

          {/* Said once, and small. An enquiry that reads like an order is the
            one way this document could do harm, so the line stays — but at the
            weight of a caption rather than a banner, because it is the same
            sentence every time and nobody needs it twice. */}
          <p className="text-muted-foreground text-[11px]">
            Nothing here commits the mill. No stock is expected, nothing is owed, and the indent
            this answers still shows as needing to be ordered until a purchase order is raised.
          </p>

          <Section icon={FileText} title="Basic Details">
            {/* Six short fields in one row at a desk, not two rows of three.
              Every one of them is a date, a code or a line — nothing here holds
              a sentence — so three columns spent half the width on whitespace
              and pushed the item table, which is the part being worked on,
              below the fold. Three columns on a tablet, two on a phone. */}
            <div className="grid grid-cols-2 gap-x-3 gap-y-2 md:grid-cols-3 xl:grid-cols-6">
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
              /* A fixed-width table, sized like the order form's.
                 `table-fixed` with a declared width per column, and a `min-w`
                 that is their sum — so a narrow screen scrolls sideways rather
                 than crushing eight columns into whatever it has, and every row
                 lines up with the header above it whatever is typed in it.
                 The previous layout let the cells size themselves, which put
                 the code box at 140px of a 1600px row and stacked three
                 full-width dropdowns in the cell beside it. */
              <div className="border-border bg-card overflow-x-auto rounded-lg border">
                <table className="w-full min-w-[1000px] table-fixed border-collapse text-sm">
                  <thead>
                    <tr className="bg-secondary">
                      {[
                        ['#', COL.num, 'left'],
                        ['Item code', COL.code, 'left'],
                        ['Category', COL.category, 'left'],
                        ['Item', COL.item, 'left'],
                        ['Description', COL.description, 'left'],
                        ['Qty', COL.qty, 'right'],
                        ['Expected rate', COL.rate, 'right'],
                        ['', COL.remove, 'left'],
                      ].map(([label, width, align], i) => (
                        <th
                          key={label + '-' + i}
                          className={`${width} border-border text-muted-foreground border-b px-2 py-1.5 align-bottom text-[10px] font-semibold uppercase tracking-wider ${
                            align === 'right' ? 'text-right' : 'text-left'
                          }`}
                        >
                          {label}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {lines.map((l, i) => (
                      <tr key={l.key} className="border-border/60 border-b last:border-0">
                        <td className="text-muted-foreground px-2 py-1.5 align-top text-[11px]">
                          {i + 1}
                        </td>
                        <td className="px-2 py-1.5 align-top">
                          <input
                            value={l.codeText}
                            onChange={(e) => setLine(l.key, { codeText: e.target.value })}
                            onBlur={(e) => pickByCode(l.key, e.target.value)}
                            placeholder="Items Code"
                            className={`form-input font-mono ${
                              l.codeText && !l.itemId ? 'border-amber-500/60' : ''
                            }`}
                            aria-label={`Row ${i + 1} item code`}
                          />
                          {l.codeText && !l.itemId && (
                            <p className="mt-0.5 text-[10px] text-amber-400">
                              no item with that code
                            </p>
                          )}
                        </td>
                        {/* Category over subcategory, stacked in one column.
                          They are how a row finds its item, not part of the
                          enquiry — neither is sent to the server — and as two
                          full columns they took 256px of the row to narrow a
                          dropdown. The order form settled this the same way. */}
                        <td className="px-2 py-1.5 align-top">
                          <select
                            value={l.categoryId}
                            onChange={(e) => narrow(l.key, { categoryId: e.target.value })}
                            className="form-input"
                            aria-label={`Row ${i + 1} category`}
                          >
                            <option value="">All categories</option>
                            {topCategories.map((c) => (
                              <option key={c.id} value={c.id}>
                                {c.name}
                              </option>
                            ))}
                          </select>
                          <select
                            value={l.subcategoryId}
                            onChange={(e) => narrow(l.key, { subcategoryId: e.target.value })}
                            disabled={subsOf(l.categoryId).length === 0}
                            className="form-input mt-1"
                            aria-label={`Row ${i + 1} subcategory`}
                          >
                            <option value="">
                              {subsOf(l.categoryId).length === 0 ? 'None' : 'All'}
                            </option>
                            {subsOf(l.categoryId).map((c) => (
                              <option key={c.id} value={c.id}>
                                {c.name}
                              </option>
                            ))}
                          </select>
                        </td>
                        <td className="px-2 py-1.5 align-top">
                          <select
                            value={l.itemId}
                            onChange={(e) => pickItem(l.key, e.target.value)}
                            disabled={loadingRefs}
                            className="form-input"
                            aria-label={`Row ${i + 1} item`}
                          >
                            <option value="">{loadingRefs ? 'Loading…' : 'Items'}</option>
                            {itemsFor(l).map((it) => (
                              <option key={it.id} value={it.id}>
                                {it.code} · {it.name}
                              </option>
                            ))}
                          </select>
                          {l.mrNumber && (
                            <p className="text-muted-foreground mt-0.5 text-[10px]">
                              against indent {l.mrNumber}
                            </p>
                          )}
                        </td>
                        <td className="px-2 py-1.5 align-top">
                          <input
                            value={l.description}
                            onChange={(e) => setLine(l.key, { description: e.target.value })}
                            placeholder="If it differs"
                            className="form-input"
                            aria-label={`Row ${i + 1} description`}
                          />
                        </td>
                        <td className="px-2 py-1.5 align-top">
                          <input
                            type="number"
                            step="0.001"
                            min="0"
                            value={l.qty}
                            onChange={(e) => setLine(l.key, { qty: e.target.value })}
                            className="form-input text-right"
                            aria-label={`Row ${i + 1} quantity`}
                          />
                          {l.uom && (
                            <p className="text-muted-foreground mt-0.5 text-right text-[10px]">
                              {l.uom}
                            </p>
                          )}
                        </td>
                        {/* Ours, not theirs. What a supplier quotes is recorded
                          against his PI number and never typed on this form. */}
                        <td className="px-2 py-1.5 align-top">
                          <input
                            type="number"
                            step="0.01"
                            min="0"
                            value={l.expectedRate}
                            onChange={(e) => setLine(l.key, { expectedRate: e.target.value })}
                            placeholder="—"
                            className="form-input text-right"
                            aria-label={`Row ${i + 1} expected rate`}
                          />
                        </td>
                        <td className="px-2 py-1.5 align-top">
                          <button
                            type="button"
                            onClick={() => removeLine(l.key)}
                            className="btn-ghost p-1 text-red-400"
                            aria-label={`Remove row ${i + 1}`}
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

          {/* The three side panels in one row.
            None of them is the work — the items above are — and stacked they
            pushed the save buttons two screens down on a form whose commonest
            use is four lines and one supplier. Three across at a desk, two on a
            tablet, one on a phone. They are no longer foldable: a panel that is
            already a third of a row and open is quicker to read than a closed
            strip that has to be found and pressed first. */}
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
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

            <Section icon={Paperclip} title="Attachments">
              <p className="text-muted-foreground mb-2 text-xs">
                Drawings and specifications, which go to everybody asked. A supplier&rsquo;s own
                proforma invoice is filed against him when you record it, not here.
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

            <Section icon={FileText} title="Notes and terms">
              <div className="space-y-3">
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
