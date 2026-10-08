'use client'

import { useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { X, Loader2, AlertCircle, Plus, Trash2, PackageOpen, FileText, Truck, Boxes, Save } from 'lucide-react'
import { api, ApiError, masterResource, type Paginated } from '@/lib/api'
import { Section } from '@/components/purchase/Section'
import { SmartSelect } from '@/components/ui/SmartSelect'

/**
 * Booking in a customer's own material.
 *
 * Their challan quantity and what actually arrived are both asked for, because
 * the gap between the two is the thing worth telling them about. The store
 * keeper types what they counted; the difference is worked out here.
 *
 * The fields follow the old system's "GRN JW Customer" form: their challan
 * (D.C.) and bill, the gate entry, and per line the category, sub-category and
 * item, then challan, received, short/excess, rejected and accepted. Rejected
 * material is still booked into the customer's stock — it is on our floor — and
 * flagged so it can go back on a return challan.
 */

interface Option {
  id: string
  name: string
  code?: string
}

interface Category {
  id: string
  name: string
  parentId?: string | null
  parent?: { id: string; name: string } | null
}

interface ItemOption extends Option {
  uom?: { symbol: string } | null
  category?: Category | null
}

interface Line {
  categoryId: string
  subCategoryId: string
  itemId: string
  challanQty: string
  receivedQty: string
  rejectedQty: string
  markings: string
}

const emptyLine = (): Line => ({
  categoryId: '',
  subCategoryId: '',
  itemId: '',
  challanQty: '',
  receivedQty: '',
  rejectedQty: '',
  markings: '',
})

/** The main category and sub-category of an item: a category with a parent is a sub-category. */
const placeOf = (it: ItemOption) => {
  const c = it.category
  if (!c) return { main: '', sub: '' }
  return c.parentId || c.parent ? { main: c.parent?.id ?? c.parentId ?? '', sub: c.id } : { main: c.id, sub: '' }
}
const fmt = (v: number) => v.toLocaleString('en-IN', { minimumFractionDigits: 0, maximumFractionDigits: 3 })
const num = (v: string) => Number(v) || 0

export function CustomerMaterialDialog({
  onClose,
  onSaved,
}: {
  onClose: () => void
  onSaved: (message: string) => void
}) {
  const [customers, setCustomers] = useState<Option[]>([])
  const [items, setItems] = useState<ItemOption[]>([])
  const [warehouses, setWarehouses] = useState<Option[]>([])
  const [orders, setOrders] = useState<Array<{ id: string; soNumber: string; customerId: string }>>(
    []
  )
  const [loadingLists, setLoadingLists] = useState(true)

  const [customerId, setCustomerId] = useState('')
  const [soId, setSoId] = useState('')
  const [warehouseId, setWarehouseId] = useState('')
  const [receiptDate, setReceiptDate] = useState('')
  const [challanNumber, setChallanNumber] = useState('')
  const [challanDate, setChallanDate] = useState('')
  const [gateEntryNumber, setGateEntryNumber] = useState('')
  const [gateEntryDate, setGateEntryDate] = useState('')
  const [billNumber, setBillNumber] = useState('')
  const [billDate, setBillDate] = useState('')
  const [vehicleNo, setVehicleNo] = useState('')
  const [transporter, setTransporter] = useState('')
  const [notes, setNotes] = useState('')
  const [lines, setLines] = useState<Line[]>([emptyLine()])

  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const [c, i, w, so] = await Promise.all([
          masterResource<Option>('customers').list({ limit: 300 }),
          // Active only: a switched-off item or store is not offered for anything new.
          masterResource<ItemOption>('items').list({ limit: 200, active: true, sort: 'name', order: 'asc' }),
          masterResource<Option>('warehouses').list({ limit: 100, active: true }),
          api.get<Paginated<{ id: string; soNumber: string; customerId: string }>>(
            '/sales/orders?limit=100'
          ),
        ])
        if (cancelled) return
        setCustomers(c.data)
        setItems(i.data)
        setWarehouses(w.data)
        // One store to choose from: chosen already.
        if (w.data.length === 1) setWarehouseId(w.data[0].id)
        setOrders(so.data)
      } catch {
        if (!cancelled) setError('Could not load customers, items and stores.')
      } finally {
        if (!cancelled) setLoadingLists(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  const setLine = (index: number, patch: Partial<Line>) =>
    setLines((prev) => prev.map((l, i) => (i === index ? { ...l, ...patch } : l)))

  const theirOrders = orders.filter((o) => o.customerId === customerId)
  const filled = lines.filter((l) => l.itemId && num(l.receivedQty) > 0)

  /** Main categories that have at least one item. */
  const mainCategories = useMemo(() => {
    const m = new Map<string, string>()
    for (const it of items) {
      const c = it.category
      if (!c) continue
      const main = c.parent ?? (c.parentId ? null : c)
      if (main) m.set(main.id, main.name)
    }
    return [...m.entries()].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name))
  }, [items])

  /** Sub-categories under a main category that have items. */
  const subCategoriesOf = (mainId: string) => {
    const m = new Map<string, string>()
    for (const it of items) {
      const c = it.category
      if (c && (c.parent?.id ?? c.parentId) === mainId) m.set(c.id, c.name)
    }
    return [...m.entries()].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name))
  }

  /** Items matching the line's category and sub-category, where chosen. */
  const itemsFor = (l: Line) =>
    items.filter((it) => {
      const p = placeOf(it)
      return (!l.categoryId || p.main === l.categoryId) && (!l.subCategoryId || p.sub === l.subCategoryId)
    })

  const save = async () => {
    setError(null)
    if (!customerId) return setError('Whose material is this?')
    if (!warehouseId) return setError('Which store did it go into?')
    if (filled.length === 0) return setError('Enter what arrived on at least one line.')
    const over = filled.find((l) => num(l.rejectedQty) > num(l.receivedQty))
    if (over) return setError(`Line ${lines.indexOf(over) + 1}: more is rejected than arrived. Rejected is part of what arrived.`)

    setSaving(true)
    try {
      const res = await api.post<{ message?: string; data: { grnNumber: string } }>(
        '/inventory/customer-grn',
        {
          customerId,
          soId: soId || null,
          warehouseId,
          receiptDate: receiptDate || undefined,
          challanNumber: challanNumber || null,
          challanDate: challanDate || null,
          gateEntryNumber: gateEntryNumber || null,
          gateEntryDate: gateEntryDate || null,
          billNumber: billNumber || null,
          billDate: billDate || null,
          vehicleNo: vehicleNo || null,
          transporter: transporter || null,
          notes: notes || null,
          lines: filled.map((l) => ({
            itemId: l.itemId,
            challanQty: num(l.challanQty) || num(l.receivedQty),
            receivedQty: num(l.receivedQty),
            rejectedQty: num(l.rejectedQty),
            markings: l.markings || null,
          })),
        }
      )
      onSaved(res.message ?? `${res.data.grnNumber} saved.`)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save. Try again.')
    } finally {
      setSaving(false)
    }
  }

  /*
   * The same frame as the master and purchase forms: a header with the icon
   * tile and the save button, titled sections, a footer always in reach.
   *
   * Portalled to <body>. Drawn inside the page it sat in whatever box the page
   * transition had made, so `fixed` measured from that box and a strip of the
   * page showed above the dimmed cover.
   */
  const saveButton = (
    <button type="submit" form="customer-material-form" className="btn-primary" disabled={saving}>
      {saving ? <Loader2 size={15} className="animate-spin" /> : <Save size={15} />}
      Receive material
    </button>
  )

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-stretch justify-center bg-black/60 p-2 backdrop-blur-sm sm:left-[var(--sidebar-current-width)] sm:p-3">
      <form
        id="customer-material-form"
        onSubmit={(e) => {
          e.preventDefault()
          void save()
        }}
        noValidate
        className="glass-card po-form flex max-h-full w-full max-w-7xl flex-col self-center overflow-hidden"
        role="dialog"
        aria-modal="true"
        aria-labelledby="customer-material-title"
      >
        <div className="border-border flex shrink-0 items-center justify-between gap-4 border-b px-5 py-3.5">
          <div className="flex min-w-0 items-center gap-3">
            <div className="bg-primary/10 border-primary/20 flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border">
              <PackageOpen size={19} className="text-primary" />
            </div>
            <div className="min-w-0">
              <h2 id="customer-material-title" className="text-foreground truncate text-xl font-semibold tracking-tight">
                Receive customer material
              </h2>
              <p className="text-muted-foreground mt-0.5 truncate text-[13px]">
                Stays the customer&apos;s — shown under their name, never in our stock value
              </p>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <div className="hidden md:block">{saveButton}</div>
            <button type="button" onClick={onClose} className="btn-ghost p-2" aria-label="Close">
              <X size={18} />
            </button>
          </div>
        </div>

        <div className="flex-1 space-y-3 overflow-y-auto px-4 py-3">
          {error && (
            <div className="flex items-start gap-3 rounded-lg border border-red-500/40 bg-red-500/5 p-3">
              <AlertCircle size={16} className="mt-0.5 shrink-0 text-red-400" />
              <p className="text-sm text-red-400">{error}</p>
            </div>
          )}

          <Section icon={FileText} title="Customer & their challan">
            <div className="grid grid-cols-1 gap-x-4 gap-y-2 sm:grid-cols-2 lg:grid-cols-4">
              <label className="block min-w-0">
                <span className="form-label">
                  Customer <span className="text-red-400">*</span>
                </span>
                <SmartSelect
                  className="form-input"
                  value={customerId}
                  onChange={(e) => {
                    setCustomerId(e.target.value)
                    setSoId('')
                  }}
                  disabled={loadingLists}
                >
                  <option value="">Choose…</option>
                  {customers.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </SmartSelect>
              </label>
              <label className="block min-w-0">
                <span className="form-label">Against order</span>
                <SmartSelect
                  className="form-input"
                  value={soId}
                  onChange={(e) => setSoId(e.target.value)}
                  disabled={!customerId}
                >
                  <option value="">Not against an order</option>
                  {theirOrders.map((o) => (
                    <option key={o.id} value={o.id}>
                      {o.soNumber}
                    </option>
                  ))}
                </SmartSelect>
              </label>
              <label className="block min-w-0">
                <span className="form-label">Their challan (D.C.) no.</span>
                <input
                  className="form-input placeholder:text-muted-foreground/60"
                  value={challanNumber}
                  onChange={(e) => setChallanNumber(e.target.value)}
                  placeholder="As on their paperwork"
                />
              </label>
              <label className="block min-w-0">
                <span className="form-label">Their challan (D.C.) date</span>
                <input
                  type="date"
                  className="form-input"
                  value={challanDate}
                  onChange={(e) => setChallanDate(e.target.value)}
                />
              </label>
              <label className="block min-w-0">
                <span className="form-label">Their bill no.</span>
                <input
                  className="form-input placeholder:text-muted-foreground/60"
                  value={billNumber}
                  onChange={(e) => setBillNumber(e.target.value)}
                  placeholder="If a bill came with it"
                />
              </label>
              <label className="block min-w-0">
                <span className="form-label">Their bill date</span>
                <input type="date" className="form-input" value={billDate} onChange={(e) => setBillDate(e.target.value)} />
              </label>
            </div>
          </Section>

          <Section icon={Truck} title="Arrival">
            <div className="grid grid-cols-1 gap-x-4 gap-y-2 sm:grid-cols-2 lg:grid-cols-4">
              <label className="block min-w-0">
                <span className="form-label">
                  Into which store <span className="text-red-400">*</span>
                </span>
                <SmartSelect
                  className="form-input"
                  value={warehouseId}
                  onChange={(e) => setWarehouseId(e.target.value)}
                  disabled={loadingLists}
                >
                  <option value="">Choose…</option>
                  {warehouses.map((w) => (
                    <option key={w.id} value={w.id}>
                      {w.name}
                    </option>
                  ))}
                </SmartSelect>
              </label>
              <label className="block min-w-0">
                <span className="form-label">Received on</span>
                <input
                  type="date"
                  className="form-input"
                  value={receiptDate}
                  onChange={(e) => setReceiptDate(e.target.value)}
                />
              </label>
              <label className="block min-w-0">
                <span className="form-label">Gate entry (G.E.) no.</span>
                <input
                  className="form-input"
                  value={gateEntryNumber}
                  onChange={(e) => setGateEntryNumber(e.target.value)}
                />
              </label>
              <label className="block min-w-0">
                <span className="form-label">Gate entry (G.E.) date</span>
                <input
                  type="date"
                  className="form-input"
                  value={gateEntryDate}
                  onChange={(e) => setGateEntryDate(e.target.value)}
                />
              </label>
              <label className="block min-w-0">
                <span className="form-label">Vehicle number</span>
                <input
                  className="form-input placeholder:text-muted-foreground/60"
                  value={vehicleNo}
                  onChange={(e) => setVehicleNo(e.target.value)}
                  placeholder="e.g. MH04AB1234"
                />
              </label>
              <label className="block min-w-0">
                <span className="form-label">Transport</span>
                <input
                  className="form-input"
                  value={transporter}
                  onChange={(e) => setTransporter(e.target.value)}
                />
              </label>
              <label className="block min-w-0 sm:col-span-2 lg:col-span-2">
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
            icon={Boxes}
            title="Items"
            actions={
              <button
                type="button"
                className="btn-secondary h-8 text-xs"
                onClick={() => setLines((prev) => [...prev, emptyLine()])}
              >
                <Plus size={14} /> Add item
              </button>
            }
          >
            <div className="-mx-4 -mb-3.5 -mt-3 overflow-x-auto">
              <table className="data-table w-full [&>tbody>tr>td]:px-3 [&>thead>tr>th]:px-3">
                <thead>
                  <tr>
                    <th style={{ width: 36 }}>#</th>
                    <th>Category · Sub-category · Item</th>
                    <th style={{ textAlign: 'right' }}>Challan qty</th>
                    <th style={{ textAlign: 'right' }}>Received qty</th>
                    <th style={{ textAlign: 'right' }}>Short / excess</th>
                    <th style={{ textAlign: 'right' }}>Rejected qty</th>
                    <th style={{ textAlign: 'right' }}>Accepted qty</th>
                    <th>Markings / remarks</th>
                    <th style={{ width: 40 }} />
                  </tr>
                </thead>
                <tbody>
                  {lines.map((line, i) => {
                    const diff = num(line.receivedQty) - num(line.challanQty)
                    const item = items.find((x) => x.id === line.itemId)
                    const uom = item?.uom?.symbol ?? ''
                    const rejected = num(line.rejectedQty)
                    const accepted = num(line.receivedQty) - rejected
                    const subs = line.categoryId ? subCategoriesOf(line.categoryId) : []
                    const choices = itemsFor(line)
                    const qtyInput = (field: 'challanQty' | 'receivedQty' | 'rejectedQty', label: string, bad = false) => (
                      <div className="relative">
                        <input
                          className={`form-input h-9 pr-10 text-right ${bad ? 'border-red-500/60' : ''}`}
                          inputMode="decimal"
                          value={line[field]}
                          onChange={(e) => setLine(i, { [field]: e.target.value })}
                          aria-label={`${label} on line ${i + 1}`}
                        />
                        {uom && (
                          <span className="text-muted-foreground pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-xs">
                            {uom}
                          </span>
                        )}
                      </div>
                    )
                    return (
                      <tr key={i} className="align-top">
                        <td className="text-muted-foreground pt-4 text-xs tabular-nums">{i + 1}</td>
                        {/* Category and sub-category narrow the item list, as on the old form. */}
                        <td className="min-w-[300px]">
                          <div className="grid grid-cols-2 gap-1.5">
                            <SmartSelect
                              className="form-input h-9"
                              value={line.categoryId}
                              onChange={(e) => {
                                const categoryId = e.target.value
                                const keep = item && (!categoryId || placeOf(item).main === categoryId)
                                setLine(i, { categoryId, subCategoryId: '', itemId: keep ? line.itemId : '' })
                              }}
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
                            <SmartSelect
                              className="form-input h-9"
                              value={line.subCategoryId}
                              onChange={(e) => {
                                const subCategoryId = e.target.value
                                const keep = item && (!subCategoryId || placeOf(item).sub === subCategoryId)
                                setLine(i, { subCategoryId, itemId: keep ? line.itemId : '' })
                              }}
                              disabled={!line.categoryId || subs.length === 0}
                              aria-label={`Sub-category on line ${i + 1}`}
                            >
                              <option value="">
                                {!line.categoryId ? 'Sub-category' : subs.length ? 'All sub-categories' : 'No sub-categories'}
                              </option>
                              {subs.map((c) => (
                                <option key={c.id} value={c.id}>
                                  {c.name}
                                </option>
                              ))}
                            </SmartSelect>
                          </div>
                          <SmartSelect
                            className="form-input mt-1.5 h-9"
                            value={line.itemId}
                            onChange={(e) => {
                              const picked = items.find((x) => x.id === e.target.value)
                              // Picking an item fills in its category and sub-category.
                              const place = picked ? placeOf(picked) : null
                              setLine(i, {
                                itemId: e.target.value,
                                ...(place ? { categoryId: place.main, subCategoryId: place.sub } : {}),
                              })
                            }}
                            disabled={loadingLists}
                            aria-label={`Item on line ${i + 1}`}
                          >
                            <option value="">Choose an item… ({choices.length})</option>
                            {choices.map((it) => (
                              <option key={it.id} value={it.id}>
                                {it.code ? `${it.code} · ` : ''}
                                {it.name}
                              </option>
                            ))}
                          </SmartSelect>
                        </td>
                        <td className="min-w-[110px]">{qtyInput('challanQty', 'Challan quantity')}</td>
                        <td className="min-w-[110px]">{qtyInput('receivedQty', 'Received quantity')}</td>
                        <td className="whitespace-nowrap pt-4 text-right text-sm tabular-nums">
                          {!line.challanQty || !line.receivedQty ? (
                            <span className="text-muted-foreground">—</span>
                          ) : diff === 0 ? (
                            <span className="badge-success">matches</span>
                          ) : (
                            <span className={diff > 0 ? 'text-amber-500' : 'text-red-500'}>
                              {diff > 0 ? '+' : ''}
                              {fmt(diff)} {uom}
                            </span>
                          )}
                        </td>
                        <td className="min-w-[110px]">{qtyInput('rejectedQty', 'Rejected quantity', rejected > num(line.receivedQty))}</td>
                        <td className="whitespace-nowrap pt-4 text-right text-sm tabular-nums">
                          {!line.receivedQty ? (
                            <span className="text-muted-foreground">—</span>
                          ) : accepted < 0 ? (
                            <span className="text-red-500">more rejected than received</span>
                          ) : (
                            <span className="text-emerald-600">
                              {fmt(accepted)} {uom}
                            </span>
                          )}
                        </td>
                        <td className="min-w-[150px]">
                          <input
                            className="form-input h-9 placeholder:text-muted-foreground/60"
                            value={line.markings}
                            onChange={(e) => setLine(i, { markings: e.target.value })}
                            placeholder="e.g. Lot 7, navy"
                            aria-label={`Markings or remarks on line ${i + 1}`}
                          />
                        </td>
                        <td className="text-right">
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
        </div>

        <div className="border-border flex shrink-0 items-center justify-end gap-2 border-t px-5 py-3">
          <span className="text-muted-foreground mr-auto hidden text-xs sm:inline">
            {filled.length} {filled.length === 1 ? 'item' : 'items'} to receive
          </span>
          <button type="button" onClick={onClose} className="btn-secondary" disabled={saving}>
            Cancel
          </button>
          {saveButton}
        </div>
      </form>
    </div>,
    document.body,
  )
}
