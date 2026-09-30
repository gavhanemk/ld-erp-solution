'use client'

import { useEffect, useMemo, useState } from 'react'
import { Loader2, Plus, Trash2, ClipboardList, FileText, Package } from 'lucide-react'
import { api, ApiError, currentUser, masterResource } from '@/lib/api'
import { FormFrame } from '@/components/ui/FormFrame'
import { Section } from '@/components/purchase/Section'

/**
 * A department asking the store for material.
 *
 * The store is chosen once at the top rather than per line, because in practice
 * one requisition is walked to one counter. Every line is saved against that
 * store, so there is still only one place the answer lives.
 *
 * Each line also says whose material it draws: ours, or a customer's that is
 * sitting in the store for us to work on. The two are separate balances of the
 * same cloth, so the choice is offered only where that customer has some, with
 * how much is there.
 */

interface ItemOption {
  id: string
  code: string
  name: string
  uom?: { symbol: string } | null
}

interface Line {
  itemId: string
  requestedQty: string
  purpose: string
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

const emptyLine = (): Line => ({ itemId: '', requestedQty: '', purpose: '', owner: 'OWNED' })
const fmt = (v: number) => v.toLocaleString('en-IN', { minimumFractionDigits: 0, maximumFractionDigits: 3 })

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
  const [warehouseId, setWarehouseId] = useState('')
  const [requiredDate, setRequiredDate] = useState('')
  const [notes, setNotes] = useState('')
  const [lines, setLines] = useState<Line[]>([emptyLine()])

  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const [i, d, w, st] = await Promise.all([
          // Active only: a deactivated item, department or store is not offered
          // for anything new.
          masterResource<ItemOption>('items').list({ limit: 200, active: true, sort: 'name', order: 'asc' }),
          masterResource<{ id: string; name: string }>('departments').list({ limit: 100, active: true }),
          masterResource<{ id: string; name: string }>('warehouses').list({ limit: 100, active: true }),
          // What is on each rack, ours and customers' apart, for the "whose" choice.
          api.get<{ data: StockRow[] }>('/inventory/stock').catch(() => ({ data: [] as StockRow[] })),
        ])
        if (cancelled) return
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

  /** What the chosen store holds of an item, for each owner: ours first, then each customer's. */
  const ownersOf = (itemId: string) => {
    const here = stock.filter((r) => r.itemId === itemId && r.warehouseId === warehouseId && r.qty > 0)
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
   * Customers holding this item in some other store. Shown greyed in the
   * "whose" list so it is plain why they cannot be picked: their cloth is not
   * at this counter.
   */
  const theirsElsewhere = (itemId: string) => {
    const by = new Map<string, { key: string; name: string; store: string; qty: number }>()
    for (const r of stock) {
      if (r.itemId !== itemId || r.warehouseId === warehouseId || r.ownership !== 'CUSTOMER_OWNED' || !r.ownerCustomerId || r.qty <= 0) continue
      const key = `${r.ownerCustomerId}|${r.warehouseId}`
      const cur = by.get(key) ?? { key, name: r.ownerName ?? 'Customer', store: r.warehouseName, qty: 0 }
      cur.qty += r.qty
      by.set(key, cur)
    }
    return [...by.values()].sort((a, b) => a.name.localeCompare(b.name))
  }

  const availableFor = (l: Line) => {
    const o = ownersOf(l.itemId)
    return l.owner === 'OWNED' ? o.ours : (o.theirs.find((t) => t.id === l.owner)?.qty ?? 0)
  }

  /** Our own stock of every item in the chosen store, for the item list itself. */
  const oursHere = useMemo(() => {
    const m = new Map<string, number>()
    for (const r of stock) {
      if (r.warehouseId !== warehouseId || r.ownership !== 'OWNED' || r.qty <= 0) continue
      m.set(r.itemId, (m.get(r.itemId) ?? 0) + r.qty)
    }
    return m
  }, [stock, warehouseId])

  /**
   * The other store holding most of our own stock of an item. When this store
   * has none, that is usually a transfer away rather than a purchase.
   */
  const elsewhere = (itemId: string) => {
    const by = new Map<string, { name: string; qty: number }>()
    for (const r of stock) {
      if (r.itemId !== itemId || r.warehouseId === warehouseId || r.ownership !== 'OWNED' || r.qty <= 0) continue
      const cur = by.get(r.warehouseId) ?? { name: r.warehouseName, qty: 0 }
      cur.qty += r.qty
      by.set(r.warehouseId, cur)
    }
    return [...by.values()].sort((a, b) => b.qty - a.qty)[0] ?? null
  }

  const setLine = (index: number, patch: Partial<Line>) =>
    setLines((prev) => prev.map((l, i) => (i === index ? { ...l, ...patch } : l)))

  const filled = lines.filter((l) => l.itemId && Number(l.requestedQty) > 0)

  const save = async () => {
    setError(null)
    if (!departmentId) return setError('Which department is asking?')
    if (!warehouseId) return setError('Which store should it come from?')
    if (filled.length === 0) return setError('Add at least one item with a quantity.')

    setSaving(true)
    try {
      const res = await api.post<{ data: { mrNumber: string } }>('/inventory/requisitions', {
        departmentId,
        warehouseId,
        requiredDate: requiredDate || null,
        notes: notes || null,
        lines: filled.map((l) => ({
          itemId: l.itemId,
          requestedQty: Number(l.requestedQty),
          purpose: l.purpose || null,
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
        <div className="grid grid-cols-1 gap-x-4 gap-y-3 sm:grid-cols-3">
          <label className="block min-w-0">
            <span className="form-label">
              Department asking<span className="ml-0.5 text-red-500">*</span>
            </span>
            <select
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
            </select>
          </label>
          <label className="block min-w-0">
            <span className="form-label">
              Store to ask<span className="ml-0.5 text-red-500">*</span>
            </span>
            <select
              className="form-input"
              value={warehouseId}
              onChange={(e) => setWarehouseId(e.target.value)}
              disabled={loadingLists}
            >
              <option value="">{loadingLists ? 'Loading...' : 'Choose a store...'}</option>
              {warehouses.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.name}
                </option>
              ))}
            </select>
            <span className="mt-1 block text-[11px] leading-snug text-muted-foreground">
              The store that hands it over. What it lacks gets bought.
            </span>
          </label>
          <label className="block min-w-0">
            <span className="form-label">Needed by</span>
            <input
              type="date"
              className="form-input"
              value={requiredDate}
              onChange={(e) => setRequiredDate(e.target.value)}
            />
          </label>
          <label className="block min-w-0 sm:col-span-3">
            <span className="form-label">Note</span>
            <input
              className="form-input placeholder:text-muted-foreground/60"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Against which order, or anything the store should know"
            />
          </label>
        </div>
      </Section>

      <Section
        icon={Package}
        title="Items"
        actions={
          <button
            type="button"
            className="btn-secondary h-8 px-3 text-xs"
            onClick={() => setLines((prev) => [...prev, emptyLine()])}
          >
            <Plus size={14} /> Add another item
          </button>
        }
      >
        <div className="overflow-x-auto">
          <table className="line-table w-full min-w-[820px] text-sm">
            <thead>
              <tr>
                <th style={{ width: 36 }}>#</th>
                <th style={{ width: '30%' }}>Item</th>
                <th style={{ width: '24%' }}>Whose material</th>
                <th style={{ textAlign: 'right' }}>Quantity</th>
                <th>What for</th>
                <th style={{ width: 40 }} />
              </tr>
            </thead>
            <tbody>
              {lines.map((line, i) => {
                const owners = line.itemId ? ownersOf(line.itemId) : { ours: 0, theirs: [] }
                const have = line.itemId && warehouseId ? availableFor(line) : null
                const short = have !== null && Number(line.requestedQty) > have
                const unit = itemsById.get(line.itemId)?.uom?.symbol ?? ''
                return (
                <tr key={i}>
                  <td className="text-muted-foreground px-3 py-2 text-xs">{i + 1}</td>
                  <td className="px-3 py-2">
                    <select
                      className="form-input h-9"
                      value={line.itemId}
                      // A new item starts from our own stock again.
                      onChange={(e) => setLine(i, { itemId: e.target.value, owner: 'OWNED' })}
                      disabled={loadingLists}
                      aria-label={`Item on line ${i + 1}`}
                    >
                      <option value="">Choose an item...</option>
                      {items.map((it) => {
                        const q = oursHere.get(it.id) ?? 0
                        return (
                          <option key={it.id} value={it.id}>
                            {it.code} — {it.name}
                            {warehouseId ? `  ·  ${q ? `${fmt(q)} ${it.uom?.symbol ?? ''} in store` : 'none in store'}` : ''}
                          </option>
                        )
                      })}
                    </select>
                    {/* What the store can hand over, said the moment the item is
                      picked, so the person asking knows before they ask
                      whether it will come off the rack or has to be bought. */}
                    {line.itemId && !warehouseId && (
                      <div className="mt-1 text-[11px] text-muted-foreground">Choose the store above to see its stock</div>
                    )}
                    {have !== null &&
                      (() => {
                        const asked = Number(line.requestedQty) || 0
                        const other = line.owner === 'OWNED' && have < Math.max(asked, 1e-9) ? elsewhere(line.itemId) : null
                        const tone = have <= 0 ? 'bg-red-500/10 text-red-500' : short ? 'bg-amber-500/10 text-amber-600 dark:text-amber-400' : 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'
                        // A customer's cloth is never bought; the gap is theirs to send.
                        const ours = line.owner === 'OWNED'
                        const text =
                          have <= 0
                            ? ours
                              ? 'None in this store · will have to be bought'
                              : 'None of theirs in this store'
                            : short
                              ? ours
                                ? `Only ${fmt(have)} ${unit} in store · ${fmt(asked - have)} ${unit} to buy`
                                : `Only ${fmt(have)} ${unit} of theirs here · ${fmt(asked - have)} ${unit} short`
                              : `${fmt(have)} ${unit} ${ours ? 'in store' : 'of theirs here'}`
                        return (
                          <div className="mt-1 space-y-0.5">
                            <span className={`inline-block rounded-md px-1.5 py-0.5 text-[11px] font-medium ${tone}`}>{text}</span>
                            {other && (
                              <div className="text-[11px] text-muted-foreground">
                                {fmt(other.qty)} {unit} in {other.name}: a transfer may be quicker than buying
                              </div>
                            )}
                          </div>
                        )
                      })()}
                  </td>
                  <td className="px-3 py-2">
                    <select
                      className={`form-input h-9 ${line.owner !== 'OWNED' ? 'text-sky-500' : ''}`}
                      value={line.owner}
                      onChange={(e) => setLine(i, { owner: e.target.value })}
                      disabled={!line.itemId}
                      aria-label={`Whose material on line ${i + 1}`}
                    >
                      <option value="OWNED">Our own</option>
                      {owners.theirs.map((t) => (
                        <option key={t.id} value={t.id}>
                          {t.name}&apos;s · {fmt(t.qty)} {unit} here
                        </option>
                      ))}
                      {/* Theirs, but in another store: shown so it is clear why it cannot be picked. */}
                      {line.itemId &&
                        theirsElsewhere(line.itemId).map((t) => (
                          <option key={t.key} value="" disabled>
                            {t.name}&apos;s · {fmt(t.qty)} {unit} in {t.store}, not this store
                          </option>
                        ))}
                      {line.itemId && owners.theirs.length === 0 && theirsElsewhere(line.itemId).length === 0 && (
                        <option value="" disabled>
                          No customer&apos;s material of this item with us
                        </option>
                      )}
                      {/* Kept while its store is changed, so the choice is not silently lost. */}
                      {line.owner !== 'OWNED' && !owners.theirs.some((t) => t.id === line.owner) && (
                        <option value={line.owner}>Customer&apos;s material (none here)</option>
                      )}
                    </select>
                    {line.owner === 'OWNED' && owners.theirs.length > 0 && (
                      <div className="mt-0.5 text-[10px] text-sky-400">
                        {owners.theirs.length === 1 ? `${owners.theirs[0].name} also has some here` : `${owners.theirs.length} customers also have some here`}
                      </div>
                    )}
                  </td>
                  <td className="px-3 py-2 text-right">
                    <div className="flex items-center justify-end gap-2">
                      <input
                        type="number"
                        step="0.001"
                        min="0"
                        className="form-input h-9 w-28 text-right tabular-nums"
                        value={line.requestedQty}
                        onChange={(e) => setLine(i, { requestedQty: e.target.value })}
                        aria-label={`Quantity on line ${i + 1}`}
                      />
                      <span className="text-muted-foreground w-8 text-left text-xs">{unit}</span>
                    </div>
                  </td>
                  <td className="px-3 py-2">
                    <input
                      className="form-input h-9 placeholder:text-muted-foreground/60"
                      value={line.purpose}
                      onChange={(e) => setLine(i, { purpose: e.target.value })}
                      placeholder="e.g. Cutting lay 1, sample"
                      aria-label={`Purpose on line ${i + 1}`}
                    />
                  </td>
                  <td className="px-3 py-2 text-right">
                    <button
                      type="button"
                      className="btn-ghost text-muted-foreground p-1.5 hover:text-red-400"
                      onClick={() =>
                        setLines((prev) =>
                          prev.length === 1 ? [emptyLine()] : prev.filter((_, x) => x !== i)
                        )
                      }
                      aria-label={`Remove line ${i + 1}`}
                    >
                      <Trash2 size={15} />
                    </button>
                  </td>
                </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </Section>
    </FormFrame>
  )
}
