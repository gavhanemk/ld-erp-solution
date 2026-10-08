'use client'

import { useEffect, useMemo, useState } from 'react'
import { Loader2, Plus, Trash2, ClipboardList, FileText, Package } from 'lucide-react'
import { api, ApiError, currentUser, masterResource } from '@/lib/api'
import { FormFrame } from '@/components/ui/FormFrame'
import { Section } from '@/components/purchase/Section'
import { SmartSelect } from '@/components/ui/SmartSelect'

/**
 * A department asking the store for material.
 *
 * Built in the order the person asking thinks: which department, then what
 * (category, sub-category, item — each list narrowed by the one before it and
 * by the department), then which store, from the stores that actually hold
 * that item. The store is per line: a fusing room asking for interlining and
 * collar bone is asking two counters, and one store for the whole requisition
 * made them pick a store that had neither.
 *
 * Each line also says whose material it draws: ours, or a customer's sitting in
 * that store for us to work on. The two are separate balances of the same
 * cloth, so a customer is offered only where they have some.
 */

interface Category {
  id: string
  name: string
  departmentId?: string | null
  parentId?: string | null
  parent?: { id: string; name: string; departmentId?: string | null } | null
}

interface ItemOption {
  id: string
  code: string
  name: string
  uom?: { symbol: string } | null
  departmentId?: string | null
  category?: Category | null
}

interface Line {
  categoryId: string
  subCategoryId: string
  itemId: string
  warehouseId: string
  requestedQty: string
  purpose: string
  /** The garment style it is for. Optional; matched against the style master when saved. */
  styleNo: string
  /** 'OWNED' for ours, or the id of the customer whose material it is. */
  owner: string
}

interface StockRow {
  itemId: string
  warehouseId: string
  warehouseName: string
  ownership: 'OWNED' | 'CUSTOMER_OWNED'
  ownerCustomerId: string | null
  ownerName: string | null
  qty: number
}

const emptyLine = (): Line => ({
  categoryId: '',
  subCategoryId: '',
  itemId: '',
  warehouseId: '',
  requestedQty: '',
  purpose: '',
  styleNo: '',
  owner: 'OWNED',
})
const fmt = (v: number) => v.toLocaleString('en-IN', { minimumFractionDigits: 0, maximumFractionDigits: 3 })

/** The main category and sub-category of an item: a category with a parent is a sub-category. */
const placeOf = (it: ItemOption) => {
  const c = it.category
  if (!c) return { main: '', sub: '' }
  return c.parentId || c.parent ? { main: c.parent?.id ?? c.parentId ?? '', sub: c.id } : { main: c.id, sub: '' }
}

/** The department an item belongs to: its own, else its category's, else the main category's. */
const departmentOf = (it: ItemOption) => it.departmentId ?? it.category?.departmentId ?? it.category?.parent?.departmentId ?? null

export function RequisitionDialog({
  onClose,
  onSaved,
}: {
  onClose: () => void
  onSaved: (message: string) => void
}) {
  const [items, setItems] = useState<ItemOption[]>([])
  const [departments, setDepartments] = useState<Array<{ id: string; name: string }>>([])
  const [warehouses, setWarehouses] = useState<Array<{ id: string; name: string }>>([])
  const [stock, setStock] = useState<StockRow[]>([])
  const [loadingLists, setLoadingLists] = useState(true)

  const [departmentId, setDepartmentId] = useState('')
  /** Off: only the department's items. On: every item, for the odd request outside it. */
  const [allItems, setAllItems] = useState(false)
  const [requiredDate, setRequiredDate] = useState('')
  /** The sales order the material is for: what the store reserves is held for its customer. */
  const [soId, setSoId] = useState('')
  const [styles, setStyles] = useState<Array<{ id: string; code: string; name: string }>>([])
  const [orders, setOrders] = useState<Array<{ id: string; soNumber: string; status: string; customer: { name: string } }>>([])
  const [notes, setNotes] = useState('')
  const [lines, setLines] = useState<Line[]>([emptyLine()])

  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const [i, d, w, st, so, sty] = await Promise.all([
          // Active only: a deactivated item, department or store is not offered
          // for anything new.
          masterResource<ItemOption>('items').list({ limit: 200, active: true, sort: 'name', order: 'asc' }),
          masterResource<{ id: string; name: string }>('departments').list({ limit: 100, active: true }),
          masterResource<{ id: string; name: string }>('warehouses').list({ limit: 100, active: true }),
          // What is on each rack, ours and customers' apart.
          api.get<{ data: StockRow[] }>('/inventory/stock').catch(() => ({ data: [] as StockRow[] })),
          // Sales orders still being worked on, for "For sales order".
          api
            .get<{ data: Array<{ id: string; soNumber: string; status: string; customer: { name: string } }> }>('/sales/orders?limit=200')
            .catch(() => ({ data: [] as Array<{ id: string; soNumber: string; status: string; customer: { name: string } }> })),
          // Style numbers to suggest in the Style no. box.
          masterResource<{ id: string; code: string; name: string }>('styles')
            .list({ limit: 200, active: true })
            .catch(() => ({ data: [] as Array<{ id: string; code: string; name: string }> })),
        ])
        if (cancelled) return
        setStyles(sty.data)
        setOrders(so.data.filter((o) => !['COMPLETED', 'CANCELLED'].includes(o.status)))
        setItems(i.data)
        setDepartments(d.data)
        setWarehouses(w.data)
        setStock(st.data)
      } catch {
        if (!cancelled) setError('Could not load items, departments and stores.')
      } finally {
        if (!cancelled) setLoadingLists(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  const itemsById = useMemo(() => new Map(items.map((i) => [i.id, i])), [items])

  /** The items this department may pick from. A department with none tagged sees everything. */
  const deptItems = useMemo(() => {
    if (!departmentId || allItems) return items
    const mine = items.filter((it) => departmentOf(it) === departmentId)
    return mine.length ? mine : items
  }, [items, departmentId, allItems])
  const deptHasOwn = useMemo(
    () => !!departmentId && items.some((it) => departmentOf(it) === departmentId),
    [items, departmentId],
  )

  /** Main categories that have at least one item open to this department. */
  const mainCategories = useMemo(() => {
    const m = new Map<string, string>()
    for (const it of deptItems) {
      const c = it.category
      if (!c) continue
      const main = c.parent ?? (c.parentId ? null : c)
      if (main) m.set(main.id, main.name)
    }
    return [...m.entries()].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name))
  }, [deptItems])

  /** Sub-categories under a main category, with items open to this department. */
  const subCategoriesOf = (mainId: string) => {
    const m = new Map<string, string>()
    for (const it of deptItems) {
      const c = it.category
      if (c && (c.parent?.id ?? c.parentId) === mainId) m.set(c.id, c.name)
    }
    return [...m.entries()].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name))
  }

  /** Items matching the line's category and sub-category, if chosen. */
  const itemsFor = (l: Line) =>
    deptItems.filter((it) => {
      const p = placeOf(it)
      return (!l.categoryId || p.main === l.categoryId) && (!l.subCategoryId || p.sub === l.subCategoryId)
    })

  /** Every store holding an item, ours and customers' apart, most of ours first. */
  const storesHolding = (itemId: string) => {
    const by = new Map<string, { id: string; name: string; ours: number; theirs: number }>()
    for (const r of stock) {
      if (r.itemId !== itemId || r.qty <= 0) continue
      const cur = by.get(r.warehouseId) ?? { id: r.warehouseId, name: r.warehouseName, ours: 0, theirs: 0 }
      if (r.ownership === 'OWNED') cur.ours += r.qty
      else cur.theirs += r.qty
      by.set(r.warehouseId, cur)
    }
    return [...by.values()].sort((a, b) => b.ours - a.ours || b.theirs - a.theirs)
  }

  /** What one store holds of an item, for each owner: ours, then each customer's. */
  const ownersAt = (itemId: string, storeId: string) => {
    const here = stock.filter((r) => r.itemId === itemId && r.warehouseId === storeId && r.qty > 0)
    const ours = here.filter((r) => r.ownership === 'OWNED').reduce((t, r) => t + r.qty, 0)
    const theirs = new Map<string, { id: string; name: string; qty: number }>()
    for (const r of here) {
      if (r.ownership !== 'CUSTOMER_OWNED' || !r.ownerCustomerId) continue
      const cur = theirs.get(r.ownerCustomerId) ?? { id: r.ownerCustomerId, name: r.ownerName ?? 'Customer', qty: 0 }
      cur.qty += r.qty
      theirs.set(r.ownerCustomerId, cur)
    }
    return { ours, theirs: [...theirs.values()].sort((a, b) => a.name.localeCompare(b.name)) }
  }

  /**
   * Where the quantity asked for would come from: the chosen store first, then
   * our other stores (largest first) by transfer, and whatever is still short
   * has to be bought. Worked out on the quantity actually typed.
   */
  const planFor = (itemId: string, storeId: string, asked: number) => {
    const here = ownersAt(itemId, storeId).ours
    const fromHere = Math.min(here, asked)
    let need = asked - fromHere
    const moves: Array<{ name: string; qty: number; has: number }> = []
    for (const o of storesHolding(itemId).filter((s) => s.id !== storeId && s.ours > 0)) {
      if (need <= 0) break
      const take = Math.min(o.ours, need)
      moves.push({ name: o.name, qty: take, has: o.ours })
      need -= take
    }
    return { here, fromHere, moves, toBuy: Math.max(0, need) }
  }

  const setLine = (index: number, patch: Partial<Line>) =>
    setLines((prev) => prev.map((l, i) => (i === index ? { ...l, ...patch } : l)))

  /** Picking an item fills in its category and sub-category, and the store that holds most of it. */
  const pickItem = (index: number, itemId: string) => {
    const it = itemsById.get(itemId)
    if (!it) return setLine(index, { itemId: '', warehouseId: '', owner: 'OWNED' })
    const p = placeOf(it)
    const best = storesHolding(itemId)[0]
    setLine(index, { itemId, categoryId: p.main, subCategoryId: p.sub, warehouseId: best?.id ?? '', owner: 'OWNED' })
  }

  const filled = lines.filter((l) => l.itemId && Number(l.requestedQty) > 0)

  const save = async () => {
    setError(null)
    if (!departmentId) return setError('Which department is asking?')
    if (filled.length === 0) return setError('Add at least one item with a quantity.')
    const noStore = filled.findIndex((l) => !l.warehouseId)
    if (noStore >= 0) return setError(`Line ${lines.indexOf(filled[noStore]) + 1}: pick the store to ask.`)

    setSaving(true)
    try {
      const res = await api.post<{ data: { mrNumber: string } }>('/inventory/requisitions', {
        departmentId,
        requiredDate: requiredDate || null,
        soId: soId || null,
        notes: notes || null,
        lines: filled.map((l) => ({
          itemId: l.itemId,
          warehouseId: l.warehouseId,
          requestedQty: Number(l.requestedQty),
          purpose: l.purpose || null,
          styleNo: l.styleNo.trim() || null,
          ownership: l.owner === 'OWNED' ? 'OWNED' : 'CUSTOMER_OWNED',
          ownerCustomerId: l.owner === 'OWNED' ? null : l.owner,
        })),
      })
      onSaved(
        currentUser()?.role === 'Admin'
          ? `${res.data.mrNumber} raised. As admin you can approve it straight away.`
          : `${res.data.mrNumber} raised. It needs someone else to approve it.`,
      )
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save. Try again.')
    } finally {
      setSaving(false)
    }
  }

  const raise = (
    <button type="button" className="btn-primary" onClick={() => void save()} disabled={saving}>
      {saving ? <Loader2 size={15} className="animate-spin" /> : <ClipboardList size={15} />}
      Raise requisition
    </button>
  )

  const GREEN = 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'
  const AMBER = 'bg-amber-500/10 text-amber-600 dark:text-amber-400'
  const RED = 'bg-red-500/10 text-red-500'
  const badge = (tone: string, text: string) => (
    <span className={`inline-block rounded-md px-1.5 py-0.5 text-[11px] font-medium ${tone}`}>{text}</span>
  )

  /** What the chosen store can give, and where the rest would come from. */
  const stockNote = (line: Line, unit: string) => {
    if (!line.itemId) return null
    if (!line.warehouseId) return <p className="text-[11px] text-muted-foreground">Pick the store to see what it has.</p>
    const asked = Number(line.requestedQty) || 0
    const owners = ownersAt(line.itemId, line.warehouseId)

    // A customer's cloth is never bought or moved in from our stock; the gap is theirs to send.
    if (line.owner !== 'OWNED') {
      const have = owners.theirs.find((t) => t.id === line.owner)?.qty ?? 0
      return have <= 0
        ? badge(RED, 'None of theirs in this store')
        : asked > have
          ? badge(AMBER, `Only ${fmt(have)} ${unit} of theirs here · ${fmt(asked - have)} ${unit} short`)
          : badge(GREEN, `${fmt(have)} ${unit} of theirs here`)
    }

    const storeName = warehouses.find((w) => w.id === line.warehouseId)?.name ?? 'this store'
    const elsewhere = storesHolding(line.itemId)
      .filter((s) => s.id !== line.warehouseId)
      .reduce((t, s) => t + s.ours, 0)

    // Not on any rack of ours: whatever store is picked, it has to be bought and comes in there.
    if (owners.ours <= 0 && elsewhere <= 0) {
      return (
        <div className="space-y-0.5">
          {badge(RED, asked ? `All ${fmt(asked)} ${unit} will have to be bought` : 'Not in stock in any store · it will have to be bought')}
          <p className="text-[11px] text-muted-foreground">It will come in to {storeName} when bought, and be handed over from there.</p>
        </div>
      )
    }

    if (!asked) {
      return owners.ours > 0
        ? badge(GREEN, `${fmt(owners.ours)} ${unit} in ${storeName}`)
        : badge(AMBER, `None in ${storeName} · ${fmt(elsewhere)} ${unit} in other stores`)
    }
    if (asked <= owners.ours) return badge(GREEN, `Enough in ${storeName} · ${fmt(owners.ours)} ${unit} there`)

    const plan = planFor(line.itemId, line.warehouseId, asked)
    return (
      <div className="flex flex-wrap items-start gap-x-4 gap-y-1">
        {plan.toBuy > 0
          ? badge(RED, `${fmt(plan.toBuy)} ${unit} will have to be bought`)
          : badge(AMBER, `Short in ${storeName} · the rest is in another store`)}
        <table className="text-[11px] tabular-nums">
          <tbody>
            <tr>
              <td className="pr-3 text-muted-foreground">From {storeName}</td>
              <td className="whitespace-nowrap text-right text-foreground">
                {fmt(plan.fromHere)} {unit}
              </td>
            </tr>
            {plan.moves.map((m) => (
              <tr key={m.name}>
                <td className="pr-3 text-muted-foreground" title={`${m.name} has ${fmt(m.has)} ${unit}`}>
                  Move from {m.name}
                </td>
                <td className="whitespace-nowrap text-right text-amber-600 dark:text-amber-400">
                  {fmt(m.qty)} {unit}
                </td>
              </tr>
            ))}
            {plan.toBuy > 0 && (
              <tr>
                <td className="pr-3 font-medium text-red-500">To buy</td>
                <td className="whitespace-nowrap text-right font-medium text-red-500">
                  {fmt(plan.toBuy)} {unit}
                </td>
              </tr>
            )}
          </tbody>
        </table>
        {plan.moves.length > 0 && (
          <p className="basis-full text-[10px] text-muted-foreground">Moving stock is a store transfer, done before the issue. The approver decides.</p>
        )}
      </div>
    )
  }

  const deptName = departments.find((d) => d.id === departmentId)?.name

  return (
    <FormFrame
      icon={ClipboardList}
      title="New material requisition"
      subtitle="A department asking the store for material. Once it is approved, the store hands it over."
      primary={raise}
      footer={
        <button type="button" className="btn-secondary" onClick={onClose} disabled={saving}>
          Cancel
        </button>
      }
      footerNote={
        currentUser()?.role === 'Admin'
          ? 'As admin you can approve it yourself. The approver decides what the store issues and what gets bought.'
          : 'Someone else approves it, and decides what the store issues and what gets bought.'
      }
      error={error}
      onClose={onClose}
      busy={saving}
    >
      <Section icon={FileText} title="Basic Details">
        <div className="grid grid-cols-1 gap-x-4 gap-y-3 sm:grid-cols-2 lg:grid-cols-4">
          <label className="block min-w-0">
            <span className="form-label">
              Department asking<span className="ml-0.5 text-red-500">*</span>
            </span>
            <SmartSelect
              className="form-input"
              value={departmentId}
              onChange={(e) => setDepartmentId(e.target.value)}
              disabled={loadingLists}
              autoFocus
            >
              <option value="">{loadingLists ? 'Loading...' : 'Choose a department...'}</option>
              {departments.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))}
            </SmartSelect>
            {departmentId && (
              <span className="mt-1 block text-[11px] leading-snug text-muted-foreground">
                {deptHasOwn
                  ? allItems
                    ? 'Showing every item.'
                    : `Showing ${deptName}'s items.`
                  : `No items are tagged to ${deptName}, so every item is shown.`}
                {deptHasOwn && (
                  <button type="button" className="ml-1 text-primary hover:underline" onClick={() => setAllItems((v) => !v)}>
                    {allItems ? `Only ${deptName}'s` : 'Show all items'}
                  </button>
                )}
              </span>
            )}
          </label>
          <label className="block min-w-0">
            <span className="form-label">For sales order</span>
            <SmartSelect className="form-input" value={soId} onChange={(e) => setSoId(e.target.value)} disabled={loadingLists}>
              <option value="">Not for a particular order</option>
              {orders.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.soNumber} · {o.customer.name}
                </option>
              ))}
            </SmartSelect>
            <span className="mt-1 block text-[11px] leading-snug text-muted-foreground">
              Stock the store reserves for it is held for this customer.
            </span>
          </label>
          <label className="block min-w-0">
            <span className="form-label">Needed by</span>
            <input type="date" className="form-input" value={requiredDate} onChange={(e) => setRequiredDate(e.target.value)} />
          </label>
          <label className="block min-w-0">
            <span className="form-label">Note</span>
            <input
              className="form-input placeholder:text-muted-foreground/60"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Anything the store should know"
            />
          </label>
        </div>
      </Section>

      <Section
        icon={Package}
        title="Items"
        actions={
          <button type="button" className="btn-secondary h-8 px-3 text-xs" onClick={() => setLines((prev) => [...prev, emptyLine()])}>
            <Plus size={14} /> Add another item
          </button>
        }
      >
        <div className="space-y-3">
          {lines.map((line, i) => {
            const it = itemsById.get(line.itemId)
            const unit = it?.uom?.symbol ?? ''
            const subs = line.categoryId ? subCategoriesOf(line.categoryId) : []
            const choices = itemsFor(line)
            const holding = line.itemId ? storesHolding(line.itemId) : []
            const holdingIds = new Set(holding.map((h) => h.id))
            const owners = line.itemId && line.warehouseId ? ownersAt(line.itemId, line.warehouseId) : { ours: 0, theirs: [] }
            return (
              <div key={i} className="rounded-lg border border-border bg-secondary/30 p-3">
                <div className="mb-2 flex items-center justify-between">
                  <span className="text-xs font-semibold text-muted-foreground">Item {i + 1}</span>
                  <button
                    type="button"
                    className="btn-ghost p-1.5 text-muted-foreground hover:text-red-400"
                    onClick={() => setLines((prev) => (prev.length === 1 ? [emptyLine()] : prev.filter((_, x) => x !== i)))}
                    aria-label={`Remove line ${i + 1}`}
                  >
                    <Trash2 size={15} />
                  </button>
                </div>

                {i === 0 && (
                  <datalist id="requisition-styles">
                    {styles.map((st) => (
                      <option key={st.id} value={st.code}>
                        {st.name}
                      </option>
                    ))}
                  </datalist>
                )}
                {/* What: category, sub-category, item, style — each narrows the next. */}
                <div className="grid grid-cols-1 gap-x-3 gap-y-2 sm:grid-cols-12">
                  <label className="block min-w-0 sm:col-span-3">
                    <span className="form-label">Category</span>
                    <SmartSelect
                      className="form-input h-9"
                      value={line.categoryId}
                      onChange={(e) => setLine(i, { categoryId: e.target.value, subCategoryId: '', itemId: '', warehouseId: '', owner: 'OWNED' })}
                      disabled={loadingLists}
                      aria-label={`Category on line ${i + 1}`}
                    >
                      <option value="">All categories</option>
                      {mainCategories.map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.name}
                        </option>
                      ))}
                    </SmartSelect>
                  </label>
                  <label className="block min-w-0 sm:col-span-2">
                    <span className="form-label">Sub-category</span>
                    <SmartSelect
                      className="form-input h-9"
                      value={line.subCategoryId}
                      onChange={(e) => setLine(i, { subCategoryId: e.target.value, itemId: '', warehouseId: '', owner: 'OWNED' })}
                      disabled={!line.categoryId || subs.length === 0}
                      aria-label={`Sub-category on line ${i + 1}`}
                    >
                      <option value="">{!line.categoryId ? 'Pick a category first' : subs.length ? 'All sub-categories' : 'None under it'}</option>
                      {subs.map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.name}
                        </option>
                      ))}
                    </SmartSelect>
                  </label>
                  <label className="block min-w-0 sm:col-span-5">
                    <span className="form-label">
                      Item<span className="ml-0.5 text-red-500">*</span>
                      <span className="ml-1 font-normal text-muted-foreground">({choices.length})</span>
                    </span>
                    <SmartSelect
                      className="form-input h-9"
                      value={line.itemId}
                      onChange={(e) => pickItem(i, e.target.value)}
                      disabled={loadingLists}
                      aria-label={`Item on line ${i + 1}`}
                    >
                      <option value="">{choices.length ? 'Choose an item...' : 'No items here'}</option>
                      {choices.map((c) => {
                        const total = storesHolding(c.id).reduce((t, s) => t + s.ours, 0)
                        return (
                          <option key={c.id} value={c.id}>
                            {c.code} — {c.name} · {total ? `${fmt(total)} ${c.uom?.symbol ?? ''} in stock` : 'none in stock'}
                          </option>
                        )
                      })}
                      {/* Kept if the filters above no longer include it, so a choice is never lost silently. */}
                      {it && !choices.some((c) => c.id === it.id) && (
                        <option value={it.id}>
                          {it.code} — {it.name}
                        </option>
                      )}
                    </SmartSelect>
                  </label>
                  {/* Optional: the garment style the material is for. Suggests style codes; anything typed is kept. */}
                  <label className="block min-w-0 sm:col-span-2">
                    <span className="form-label">Style no.</span>
                    <input
                      className="form-input h-9 placeholder:text-muted-foreground/60"
                      value={line.styleNo}
                      onChange={(e) => setLine(i, { styleNo: e.target.value })}
                      placeholder="Optional"
                      list="requisition-styles"
                      maxLength={50}
                      aria-label={`Style number on line ${i + 1}`}
                    />
                  </label>

                  {/* Where from, whose, how much, what for. */}
                  <label className="block min-w-0 sm:col-span-4">
                    <span className="form-label">
                      Store to ask<span className="ml-0.5 text-red-500">*</span>
                    </span>
                    <SmartSelect
                      className="form-input h-9"
                      value={line.warehouseId}
                      onChange={(e) => setLine(i, { warehouseId: e.target.value, owner: 'OWNED' })}
                      disabled={!line.itemId}
                      aria-label={`Store on line ${i + 1}`}
                    >
                      <option value="">{line.itemId ? 'Choose a store...' : 'Pick the item first'}</option>
                      {holding.length > 0 && (
                        <optgroup label="Has this item">
                          {holding.map((h) => (
                            <option key={h.id} value={h.id}>
                              {h.name} · {h.ours ? `${fmt(h.ours)} ${unit}` : 'none of ours'}
                              {h.theirs ? ` (+ ${fmt(h.theirs)} customers')` : ''}
                            </option>
                          ))}
                        </optgroup>
                      )}
                      {line.itemId && (
                        <optgroup label={holding.length ? 'No stock here — would be bought in' : 'No store has it — pick where it should come in'}>
                          {warehouses
                            .filter((w) => !holdingIds.has(w.id))
                            .map((w) => (
                              <option key={w.id} value={w.id}>
                                {w.name}
                              </option>
                            ))}
                        </optgroup>
                      )}
                    </SmartSelect>
                  </label>
                  <label className="block min-w-0 sm:col-span-3">
                    <span className="form-label">Whose material</span>
                    <SmartSelect
                      className={`form-input h-9 ${line.owner !== 'OWNED' ? 'text-sky-500' : ''}`}
                      value={line.owner}
                      onChange={(e) => setLine(i, { owner: e.target.value })}
                      disabled={!line.warehouseId}
                      aria-label={`Whose material on line ${i + 1}`}
                    >
                      <option value="OWNED">Our own</option>
                      {owners.theirs.map((t) => (
                        <option key={t.id} value={t.id}>
                          {t.name}&apos;s · {fmt(t.qty)} {unit}
                        </option>
                      ))}
                    </SmartSelect>
                  </label>
                  <label className="block min-w-0 sm:col-span-2">
                    <span className="form-label">
                      Quantity<span className="ml-0.5 text-red-500">*</span>
                    </span>
                    <div className="relative">
                      <input
                        type="number"
                        step="0.001"
                        min="0"
                        className="form-input h-9 pr-10 text-right tabular-nums"
                        value={line.requestedQty}
                        onChange={(e) => setLine(i, { requestedQty: e.target.value })}
                        disabled={!line.itemId}
                        aria-label={`Quantity on line ${i + 1}`}
                      />
                      {unit && (
                        <span className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-xs text-muted-foreground">{unit}</span>
                      )}
                    </div>
                  </label>
                  <label className="block min-w-0 sm:col-span-3">
                    <span className="form-label">What for</span>
                    <input
                      className="form-input h-9 placeholder:text-muted-foreground/60"
                      value={line.purpose}
                      onChange={(e) => setLine(i, { purpose: e.target.value })}
                      placeholder="e.g. Cutting lay 1, sample"
                      aria-label={`Purpose on line ${i + 1}`}
                    />
                  </label>
                </div>

                {line.itemId && <div className="mt-2">{stockNote(line, unit)}</div>}
              </div>
            )
          })}
        </div>
      </Section>
    </FormFrame>
  )
}
