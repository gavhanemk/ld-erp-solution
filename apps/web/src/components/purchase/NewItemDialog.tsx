'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { AlertCircle, Boxes, IndianRupee, Loader2, Package, X } from 'lucide-react'
import { api, apiErrorMessage } from '@/lib/api'
import { Section } from '@/components/purchase/Section'

/**
 * Adding an item to the master without leaving the form that needed it.
 *
 * A buyer enquiring about something the mill has never bought before was stuck:
 * the item dropdown offers what the master holds and nothing else, so the
 * honest options were to abandon a half-typed enquiry and go to Masters, or to
 * pick a near-enough item and put the real one in the description. The second
 * is what actually happens, and it is how a master stops meaning anything —
 * six months later the purchase history says the mill bought Cotton Oxford
 * when it bought something else entirely.
 *
 * ── Why it asks for more than the form strictly needs ───────────────────────
 *
 * The enquiry needs a name and a quantity. The *master* needs a unit and a
 * type, and this writes to the master. A unit is not paperwork: an item with no
 * unit makes every quantity ever recorded against it ambiguous, and no later
 * screen can repair that from the outside. A type decides which lists the item
 * appears on for everybody else.
 *
 * So: category, name, unit and type are asked for, and the code, the HSN and
 * the rate are offered. The code is left blank by default because the server
 * allots one, and two people typing codes by hand is how a master ends up with
 * FAB-COT-3 and FAB-COT-003.
 */

interface Category {
  id: string
  name: string
  parentId: string | null
}

interface Uom {
  id: string
  code?: string | null
  symbol: string
  name: string
}

export interface NewItem {
  id: string
  code: string
  name: string
  hsnCode: string | null
  uom: { symbol: string } | null
  category: { id: string; name: string; parentId: string | null } | null
  standardRate?: string | null
}

const TYPES: Array<{ value: string; label: string; hint: string }> = [
  {
    value: 'RAW_MATERIAL',
    label: 'Raw material',
    hint: 'Fabric, yarn — what the product is made of',
  },
  { value: 'TRIM', label: 'Trim', hint: 'Buttons, zips, elastic, lace' },
  { value: 'PACKING_MATERIAL', label: 'Packing material', hint: 'Cartons, poly bags, tape' },
  { value: 'CONSUMABLE', label: 'Consumable', hint: 'Used up, not part of the product' },
  { value: 'SEMI_FINISHED', label: 'Semi finished', hint: 'Part-made, going back out' },
  { value: 'FINISHED_GOOD', label: 'Finished good', hint: 'Ready to sell' },
]

export function NewItemDialog({
  categories,
  categoryId: initialCategory,
  subcategoryId: initialSubcategory,
  onClose,
  onCreated,
}: {
  categories: Category[]
  /** Whatever the row had already narrowed to, so the buyer does not repeat it. */
  categoryId?: string
  subcategoryId?: string
  onClose: () => void
  onCreated: (item: NewItem) => void
}) {
  const [categoryId, setCategoryId] = useState(initialCategory ?? '')
  const [subcategoryId, setSubcategoryId] = useState(initialSubcategory ?? '')
  const [name, setName] = useState('')
  const [code, setCode] = useState('')
  const [type, setType] = useState('RAW_MATERIAL')
  const [uomId, setUomId] = useState('')
  const [hsnCode, setHsnCode] = useState('')
  const [description, setDescription] = useState('')
  const [rate, setRate] = useState('')
  const [reorderLevel, setReorderLevel] = useState('')
  const [minStock, setMinStock] = useState('')
  const [maxStock, setMaxStock] = useState('')

  const [uoms, setUoms] = useState<Uom[]>([])
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    api
      .get<{ data: Uom[] }>('/masters/uoms?limit=100')
      .then((r) => setUoms(r.data))
      .catch(() => setError('Could not load the units. Close and try again.'))
  }, [])

  /** The chosen unit's symbol, so the stock figures say what they count. */
  const uomSymbol = useMemo(() => uoms.find((u) => u.id === uomId)?.symbol ?? '', [uoms, uomId])

  /*
   * A minimum above a maximum, which the server refuses outright.
   *
   * Caught here so it shows as a tinted edge on both boxes while they are
   * being typed, rather than as a sentence after a round trip that also lost
   * everything else on the form.
   */
  const stockBackwards = minStock !== '' && maxStock !== '' && Number(minStock) > Number(maxStock)

  const tops = useMemo(() => categories.filter((c) => !c.parentId), [categories])
  const subs = useMemo(
    () => categories.filter((c) => c.parentId === categoryId),
    [categories, categoryId]
  )

  const problems = useMemo(() => {
    const out: string[] = []
    if (!name.trim()) out.push('The item needs a name')
    if (!categoryId) out.push('Pick a category')
    if (!uomId) out.push('Pick a unit')
    if (hsnCode && !/^[0-9]{4,8}$/.test(hsnCode.trim())) {
      out.push('An HSN code is 4 to 8 digits, nothing else')
    }
    if (stockBackwards) out.push('Minimum stock cannot be above maximum stock')
    return out
  }, [name, categoryId, uomId, hsnCode, stockBackwards])

  const save = useCallback(async () => {
    if (problems.length) return
    setSaving(true)
    setError(null)
    try {
      const res = await api.post<{ data: NewItem }>('/masters/items', {
        name: name.trim(),
        // Left out entirely when blank, so the server allots one rather than
        // being handed an empty string to validate.
        ...(code.trim() ? { code: code.trim().toUpperCase() } : {}),
        type,
        // The subcategory is the real filing when there is one; the parent is
        // only how the buyer found it.
        categoryId: subcategoryId || categoryId,
        uomId,
        ...(hsnCode.trim() ? { hsnCode: hsnCode.trim() } : {}),
        ...(description.trim() ? { description: description.trim() } : {}),
        // Each left out entirely when blank rather than sent as zero. Zero is a
        // real reorder level — "tell me the moment it runs out" — and is not
        // the same answer as "nobody has decided one".
        ...(rate.trim() ? { standardRate: Number(rate) } : {}),
        ...(reorderLevel.trim() ? { reorderLevel: Number(reorderLevel) } : {}),
        ...(minStock.trim() ? { minStock: Number(minStock) } : {}),
        ...(maxStock.trim() ? { maxStock: Number(maxStock) } : {}),
      })
      onCreated(res.data)
    } catch (err) {
      setError(apiErrorMessage(err, 'Could not add that item.'))
    } finally {
      setSaving(false)
    }
  }, [
    problems,
    name,
    code,
    type,
    categoryId,
    subcategoryId,
    uomId,
    hsnCode,
    description,
    rate,
    reorderLevel,
    minStock,
    maxStock,
    onCreated,
  ])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !saving) onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, saving])

  return createPortal(
    /* Above the form that opened it, and narrower — it is one short question,
       not a document. The chrome is the module's own so it does not read as a
       window from somewhere else. */
    <div className="fixed inset-0 z-[70] flex items-center justify-center overflow-y-auto bg-black/60 p-4 backdrop-blur-sm">
      <div
        className="glass-card po-form my-4 flex w-full max-w-4xl flex-col overflow-hidden"
        role="dialog"
        aria-modal="true"
        aria-labelledby="new-item-title"
      >
        <div className="border-border flex shrink-0 items-center justify-between gap-4 border-b px-5 py-3.5">
          <div className="flex min-w-0 items-center gap-3">
            <div className="bg-primary/10 border-primary/20 flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border">
              <Package size={19} className="text-primary" />
            </div>
            <div className="min-w-0">
              <h2
                id="new-item-title"
                className="text-foreground truncate text-xl font-semibold tracking-tight"
              >
                New Item
              </h2>
              <p className="text-muted-foreground mt-0.5 truncate text-[13px]">
                Added to the item master, and put on this line
              </p>
            </div>
          </div>
          <button onClick={onClose} className="btn-ghost p-1.5" aria-label="Close">
            <X size={18} />
          </button>
        </div>

        <div className="space-y-3 overflow-y-auto px-5 py-4">
          {error && (
            <div className="flex items-start gap-3 rounded-lg border border-red-500/40 bg-red-500/5 p-3">
              <AlertCircle size={16} className="mt-0.5 shrink-0 text-red-400" />
              <p className="text-sm text-red-400">{error}</p>
            </div>
          )}

          {/* The same three groups the Masters screen files an item under, with
            the same labels and the same help under each. This writes to that
            master, so somebody who fills this in and later opens the item there
            should recognise what they typed and find it where they left it. */}
          <Section icon={Package} title="Identity">
            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <label className="form-label" htmlFor="ni-cat">
                  Category
                </label>
                <select
                  id="ni-cat"
                  value={categoryId}
                  onChange={(e) => {
                    setCategoryId(e.target.value)
                    setSubcategoryId('')
                  }}
                  className="form-input"
                >
                  <option value="">Pick a category</option>
                  {tops.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="form-label" htmlFor="ni-sub">
                  Subcategory
                </label>
                <select
                  id="ni-sub"
                  value={subcategoryId}
                  onChange={(e) => setSubcategoryId(e.target.value)}
                  disabled={subs.length === 0}
                  className="form-input"
                >
                  <option value="">{subs.length === 0 ? 'None under this' : 'None'}</option>
                  {subs.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
                <p className="form-help">Where it is filed, if there is one.</p>
              </div>
            </div>

            <div className="mt-3">
              <label className="form-label" htmlFor="ni-name">
                Item name
              </label>
              <input
                id="ni-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Cotton Poplin 40s"
                className="form-input"
                autoFocus
              />
            </div>

            <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <div>
                <label className="form-label" htmlFor="ni-code">
                  Item code
                </label>
                <input
                  id="ni-code"
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                  placeholder="Allotted on save"
                  className="form-input font-mono"
                />
                {/* Left blank on purpose. Two people typing codes by hand is how
                  a master ends up holding FAB-COT-3 and FAB-COT-003. */}
                <p className="form-help">Leave empty unless it already has one.</p>
              </div>
              <div>
                <label className="form-label" htmlFor="ni-type">
                  Item type
                </label>
                <select
                  id="ni-type"
                  value={type}
                  onChange={(e) => setType(e.target.value)}
                  className="form-input"
                >
                  {TYPES.map((t) => (
                    <option key={t.value} value={t.value}>
                      {t.label}
                    </option>
                  ))}
                </select>
                {/* Decides which lists it turns up on for everybody else. */}
                <p className="form-help">{TYPES.find((t) => t.value === type)?.hint}</p>
              </div>
              <div>
                <label className="form-label" htmlFor="ni-uom">
                  Unit of measure
                </label>
                <select
                  id="ni-uom"
                  value={uomId}
                  onChange={(e) => setUomId(e.target.value)}
                  className="form-input"
                >
                  <option value="">Pick a unit</option>
                  {uoms.map((u) => (
                    <option key={u.id} value={u.id}>
                      {u.symbol} · {u.name}
                    </option>
                  ))}
                </select>
                {/* Not paperwork. An item with no unit makes every quantity ever
                  recorded against it ambiguous, and nothing later can repair it. */}
                <p className="form-help">What its quantity is counted in.</p>
              </div>
              <div>
                <label className="form-label" htmlFor="ni-hsn">
                  HSN code
                </label>
                <input
                  id="ni-hsn"
                  value={hsnCode}
                  onChange={(e) => setHsnCode(e.target.value)}
                  placeholder="52081200"
                  className="form-input font-mono"
                />
                <p className="form-help">4 to 8 digits, used on GST invoices.</p>
              </div>
            </div>

            <div className="mt-3">
              <label className="form-label" htmlFor="ni-desc">
                Description
              </label>
              <textarea
                id="ni-desc"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                rows={2}
                placeholder="Composition, width, finish — whatever tells this apart from the one beside it"
                className="form-input"
              />
            </div>
          </Section>

          <div className="grid gap-3 lg:grid-cols-2">
            <Section icon={IndianRupee} title="Costing">
              <div className="sm:max-w-[14rem]">
                <label className="form-label" htmlFor="ni-rate">
                  Standard rate
                </label>
                <input
                  id="ni-rate"
                  type="number"
                  step="0.01"
                  min="0"
                  value={rate}
                  onChange={(e) => setRate(e.target.value)}
                  placeholder="145.50"
                  className="form-input text-right"
                />
                {/* The mill's own working figure, not a price anybody quoted —
                  which is the whole reason the enquiry is being raised. It
                  lands in the expected-rate column on the line, where it is
                  labelled as an estimate and stays editable. */}
                <p className="form-help">
                  What we expect to pay, for costing a BOM before real purchase rates exist. Not a
                  quoted price.
                </p>
              </div>
            </Section>

            <Section icon={Boxes} title="Stock control">
              <div className="grid gap-3 sm:grid-cols-3">
                <div>
                  <label className="form-label" htmlFor="ni-reorder">
                    Reorder level
                  </label>
                  <input
                    id="ni-reorder"
                    type="number"
                    step="0.001"
                    min="0"
                    value={reorderLevel}
                    onChange={(e) => setReorderLevel(e.target.value)}
                    placeholder="500"
                    className="form-input text-right"
                  />
                </div>
                <div>
                  <label className="form-label" htmlFor="ni-min">
                    Minimum stock
                  </label>
                  <input
                    id="ni-min"
                    type="number"
                    step="0.001"
                    min="0"
                    value={minStock}
                    onChange={(e) => setMinStock(e.target.value)}
                    className={`form-input text-right ${stockBackwards ? 'border-amber-500/60' : ''}`}
                  />
                </div>
                <div>
                  <label className="form-label" htmlFor="ni-max">
                    Maximum stock
                  </label>
                  <input
                    id="ni-max"
                    type="number"
                    step="0.001"
                    min="0"
                    value={maxStock}
                    onChange={(e) => setMaxStock(e.target.value)}
                    className={`form-input text-right ${stockBackwards ? 'border-amber-500/60' : ''}`}
                  />
                </div>
              </div>
              <p className="form-help mt-2">
                All three optional, and all in {uomSymbol || 'the unit above'}. The reorder level
                raises an alert when stock falls below it.
              </p>
            </Section>
          </div>
        </div>

        <div className="border-border flex shrink-0 flex-wrap items-center justify-between gap-3 border-t px-5 py-3.5">
          <p className="text-muted-foreground max-w-[22rem] text-[11px]">
            {problems.length > 0
              ? problems[0]
              : 'Saved to the item master, so every other screen can use it too.'}
          </p>
          <div className="flex items-center gap-3">
            <button type="button" className="btn-secondary" onClick={onClose} disabled={saving}>
              Cancel
            </button>
            <button
              type="button"
              className="btn-primary"
              onClick={save}
              disabled={saving || problems.length > 0}
            >
              {saving ? <Loader2 size={15} className="animate-spin" /> : <Package size={15} />}
              Add item
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body
  )
}
