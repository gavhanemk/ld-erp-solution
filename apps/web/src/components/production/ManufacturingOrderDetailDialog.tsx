'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { AlertCircle, Ban, CheckCircle2, ClipboardList, Factory, Info, Layers, Loader2, PackageCheck, Pencil, Send, X } from 'lucide-react'
import { api, ApiError, can } from '@/lib/api'
import { formatDate } from '@/lib/utils'
import { Section } from '@/components/purchase/Section'
import { SmartSelect } from '@/components/ui/SmartSelect'
import { StepInput } from '@/components/ui/StepInput'
import { ReasonDialog } from '@/components/ui/ReasonDialog'
import { LIVE_MO, moStatus } from './status'

interface MoDetail {
  id: string
  moNumber: string
  status: string
  plannedStartDate: string | null
  plannedEndDate: string | null
  totalPlannedQty: number
  totalPackedQty: number
  notes: string | null
  closedAt: string | null
  closeReason: string | null
  createdAt: string
  createdBy: { name: string } | null
  closedBy: { name: string } | null
  brand: { name: string }
  so: { id: string; soNumber: string; status: string; isJobWork: boolean; deliveryDate: string | null; customerPORef: string | null; customer: { name: string } } | null
  lines: Array<{
    id: string
    color: string
    totalQty: number
    style: { code: string; name: string }
    soLine: { item: { code: string; name: string } } | null
    bom: { id: string; version: string; color: string | null; status: string } | null
    sizes: Array<{ id: string; qty: number; size: { code: string; sequence: number } }>
  }>
  materialRequisitions: Array<{
    id: string
    mrNumber: string
    status: string
    requestDate: string
    issuedAt: string | null
    closedAt: string | null
    department: { name: string }
    _count: { lines: number }
  }>
  fgReceipts: Array<{ id: string; fgrNumber: string; receiptDate: string; cancelledAt: string | null; lines: Array<{ qty: string | number }> }>
}

interface PlanRow {
  key: string
  item: { id: string; code: string; name: string; type: string; uom: string | null }
  ownership: 'OWNED' | 'CUSTOMER_OWNED'
  ownerCustomerId: string | null
  department: { id: string; name: string } | null
  styles: string[]
  required: number
  inStock: number
  requested: number
  toRequest: number
  short: number
  stores: Array<{ id: string; name: string; qty: number }>
  defaultStoreId: string | null
}

interface MaterialPlan {
  rows: PlanRow[]
  missing: Array<{ style: string; color: string; pieces: number }>
  warehouses: Array<{ id: string; name: string }>
  departments: Array<{ id: string; name: string }>
}

type Ask = Record<string, { on: boolean; qty: string; departmentId: string; warehouseId: string }>

const qty = (n: number) => n.toLocaleString('en-IN', { maximumFractionDigits: 3 })
const pcs = (n: number) => n.toLocaleString('en-IN')

/**
 * One manufacturing order: what is being made, the materials it needs, the
 * requisitions raised for them, and what has been packed.
 *
 * The material plan multiplies each line's pieces, size by size, by its
 * approved BOM — wastage already in — and sets every material against what
 * the stores hold and what this order has already asked for. "Raise
 * requisitions" sends what is still to ask for to the store, one requisition
 * per department, where it is approved, issued from stock or passed to
 * Purchase in the ordinary way.
 */
export function ManufacturingOrderDetailDialog({
  moId,
  onClose,
  onEdit,
  onChanged,
}: {
  moId: string | null
  onClose: () => void
  onEdit: (id: string) => void
  onChanged: (message: string) => void
}) {
  const [mounted, setMounted] = useState(false)
  useEffect(() => setMounted(true), [])
  const [mo, setMo] = useState<MoDetail | null>(null)
  const [plan, setPlan] = useState<MaterialPlan | null>(null)
  const [ask, setAsk] = useState<Ask>({})
  const [requiredDate, setRequiredDate] = useState('')
  const [loading, setLoading] = useState(false)
  const [loadingPlan, setLoadingPlan] = useState(false)
  const [busy, setBusy] = useState<'release' | 'raise' | 'close' | null>(null)
  const [closing, setClosing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)

  const load = useCallback(async (id: string) => {
    setLoading(true)
    try {
      setMo((await api.get<{ data: MoDetail }>(`/production/orders/${id}`)).data)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not open that manufacturing order.')
    } finally {
      setLoading(false)
    }
  }, [])

  const loadPlan = useCallback(async (id: string) => {
    setLoadingPlan(true)
    try {
      const res = await api.get<{ data: MaterialPlan }>(`/production/orders/${id}/materials`)
      setPlan(res.data)
      setAsk(
        Object.fromEntries(
          res.data.rows.map((r) => [
            r.key,
            { on: r.toRequest > 0, qty: r.toRequest > 0 ? String(r.toRequest) : '', departmentId: r.department?.id ?? '', warehouseId: r.defaultStoreId ?? '' },
          ])
        )
      )
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not work out the materials.')
    } finally {
      setLoadingPlan(false)
    }
  }, [])

  useEffect(() => {
    if (!moId) return
    setError(null)
    setMessage(null)
    setMo(null)
    setPlan(null)
    setRequiredDate('')
    void load(moId)
    void loadPlan(moId)
  }, [moId, load, loadPlan])

  useEffect(() => {
    if (!moId) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !busy && !closing) onClose()
    }
    window.addEventListener('keydown', onKey)
    const previous = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      window.removeEventListener('keydown', onKey)
      document.body.style.overflow = previous
    }
  }, [moId, onClose, busy, closing])

  const refresh = async (msg: string) => {
    setMessage(msg)
    onChanged(msg)
    if (moId) {
      await load(moId)
      await loadPlan(moId)
    }
  }

  const releaseIt = async () => {
    if (!mo) return
    setBusy('release')
    setError(null)
    try {
      const res = await api.post<{ message?: string }>(`/production/orders/${mo.id}/release`, {})
      await refresh(res.message ?? `${mo.moNumber} released.`)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not release it.')
    } finally {
      setBusy(null)
    }
  }

  const closeIt = async (reason: string) => {
    if (!mo) return
    setBusy('close')
    setError(null)
    try {
      const res = await api.post<{ message?: string }>(`/production/orders/${mo.id}/close`, { reason })
      setClosing(false)
      await refresh(res.message ?? `${mo.moNumber} closed.`)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not close it.')
      setClosing(false)
    } finally {
      setBusy(null)
    }
  }

  const chosen = useMemo(
    () =>
      (plan?.rows ?? [])
        .map((r) => ({ r, a: ask[r.key] }))
        .filter((x) => x.a?.on && (Number(x.a.qty) || 0) > 0),
    [plan, ask]
  )
  const live = !!mo && LIVE_MO.includes(mo.status)
  const mayRaise = can('production', 'create')
  const raiseBlocker = !mo
    ? null
    : mo.status === 'DRAFT'
      ? 'Release it before asking the store for materials.'
      : !live
        ? null
        : chosen.length === 0
          ? 'Tick the materials to ask for.'
          : chosen.find((x) => !x.a.departmentId)
            ? `Say which department asks for ${chosen.find((x) => !x.a.departmentId)!.r.item.code}.`
            : chosen.find((x) => !x.a.warehouseId)
              ? `Say which store to ask for ${chosen.find((x) => !x.a.warehouseId)!.r.item.code}.`
              : null

  const raise = async () => {
    if (!mo || raiseBlocker) return
    setBusy('raise')
    setError(null)
    try {
      const res = await api.post<{ message?: string }>(`/production/orders/${mo.id}/requisitions`, {
        requiredDate: requiredDate || null,
        lines: chosen.map(({ r, a }) => ({
          itemId: r.item.id,
          departmentId: a.departmentId,
          warehouseId: a.warehouseId,
          qty: Number(a.qty),
          ownership: r.ownership,
          ownerCustomerId: r.ownerCustomerId,
          styleNo: r.styles.length === 1 ? r.styles[0] : null,
        })),
      })
      await refresh(res.message ?? 'Requisitions raised.')
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not raise the requisitions.')
    } finally {
      setBusy(null)
    }
  }

  if (!moId || !mounted) return null
  const s = mo ? moStatus(mo.status) : null
  const share = mo && mo.totalPlannedQty > 0 ? Math.min(100, Math.round((mo.totalPackedQty / mo.totalPlannedQty) * 100)) : 0
  const setRow = (key: string, patch: Partial<Ask[string]>) => setAsk((a) => ({ ...a, [key]: { ...a[key], ...patch } }))

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-stretch justify-center bg-black/60 p-2 backdrop-blur-sm sm:left-[var(--sidebar-current-width)] sm:p-3">
      <div className="glass-card po-form flex h-full max-h-full w-full flex-col overflow-hidden" role="dialog" aria-modal="true" aria-labelledby="mo-detail-title">
        <div className="border-border flex shrink-0 flex-wrap items-center justify-between gap-3 border-b px-5 py-3.5">
          <div className="flex min-w-0 items-center gap-3">
            <div className="bg-primary/10 border-primary/20 flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border">
              <Factory size={19} className="text-primary" />
            </div>
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <h2 id="mo-detail-title" className="text-foreground font-mono text-xl font-semibold tracking-tight">
                  {mo?.moNumber ?? 'Manufacturing order'}
                </h2>
                {s && <span className={s.cls}>{s.label}</span>}
                {mo?.so?.isJobWork && <span className="badge-purple">Job work</span>}
              </div>
              {mo && (
                <p className="text-muted-foreground mt-0.5 truncate text-[13px]">
                  {mo.so ? `${mo.so.soNumber} · ${mo.so.customer.name}` : 'No sales order'} · {mo.brand.name}
                </p>
              )}
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {mo?.status === 'DRAFT' && can('production', 'edit') && (
              <>
                <button className="btn-secondary" onClick={() => onEdit(mo.id)} disabled={busy !== null}>
                  <Pencil size={15} /> Edit draft
                </button>
                <button className="btn-primary" onClick={() => void releaseIt()} disabled={busy !== null}>
                  {busy === 'release' ? <Loader2 size={15} className="animate-spin" /> : <CheckCircle2 size={15} />} Release
                </button>
              </>
            )}
            {mo && mo.status !== 'CLOSED' && mo.status !== 'COMPLETED' && can('production', 'edit') && (
              <button className="btn-ghost text-destructive" onClick={() => setClosing(true)} disabled={busy !== null}>
                <Ban size={15} /> Close
              </button>
            )}
            <button onClick={onClose} className="btn-ghost p-2" aria-label="Close" disabled={busy !== null}>
              <X size={18} />
            </button>
          </div>
        </div>

        <div className="flex-1 space-y-3 overflow-y-auto px-4 py-3">
          {error && (
            <div className="border-destructive/40 bg-destructive/5 flex items-start gap-3 rounded-lg border p-3">
              <AlertCircle size={16} className="text-destructive mt-0.5 shrink-0" />
              <p className="text-destructive text-sm">{error}</p>
            </div>
          )}
          {message && (
            <div className="border-primary/40 bg-primary/5 rounded-lg border p-3">
              <p className="text-primary text-sm">{message}</p>
            </div>
          )}
          {loading && !mo ? (
            <div className="skeleton h-72 w-full rounded-xl" />
          ) : mo ? (
            <>
              {mo.status === 'CLOSED' && (
                <div className="border-border bg-secondary/40 rounded-lg border p-3 text-sm">
                  Closed {mo.closedAt ? formatDate(mo.closedAt) : ''}
                  {mo.closedBy ? ` by ${mo.closedBy.name}` : ''}
                  {mo.closeReason ? ` — ${mo.closeReason}` : ''}
                </div>
              )}
              <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
                {[
                  ['Planned', `${pcs(mo.totalPlannedQty)} pcs`],
                  ['Packed', `${pcs(mo.totalPackedQty)} pcs · ${share}%`],
                  ['Planned dates', `${mo.plannedStartDate ? formatDate(mo.plannedStartDate) : '—'} → ${mo.plannedEndDate ? formatDate(mo.plannedEndDate) : '—'}`],
                  ['Order delivery', mo.so?.deliveryDate ? formatDate(mo.so.deliveryDate) : '—'],
                ].map(([label, value]) => (
                  <div key={label} className="glass-card p-3">
                    <p className="text-muted-foreground text-[11px]">{label}</p>
                    <p className="text-foreground mt-0.5 text-sm font-semibold tabular-nums">{value}</p>
                    {label === 'Packed' && (
                      <div className="bg-secondary mt-1.5 h-1.5 rounded-full" aria-hidden>
                        <div className="bg-primary h-1.5 rounded-full" style={{ width: `${share}%` }} />
                      </div>
                    )}
                  </div>
                ))}
              </div>
              {mo.notes && <p className="text-muted-foreground text-sm">Notes: {mo.notes}</p>}

              <Section icon={Layers} title="What is being made">
                <div className="space-y-2">
                  {mo.lines.map((l) => (
                    <div key={l.id} className="border-border bg-card rounded-lg border p-2.5">
                      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                        <p className="text-foreground text-sm font-medium">
                          <span className="font-mono">{l.style.code}</span>
                          {l.color ? ` · ${l.color}` : ''}
                          {l.soLine && <span className="text-muted-foreground font-normal"> · {l.soLine.item.code}</span>}
                        </p>
                        <p className="text-xs">
                          {l.bom ? (
                            <span className="text-primary">BOM v{l.bom.version}{l.bom.color ? ` ${l.bom.color}` : ''}</span>
                          ) : (
                            <span className="warn-text">No approved BOM</span>
                          )}
                          <span className="text-foreground ml-3 font-semibold tabular-nums">{pcs(l.totalQty)} pcs</span>
                        </p>
                      </div>
                      {l.sizes.length > 0 && (
                        <p className="text-muted-foreground mt-1 text-xs tabular-nums">
                          {[...l.sizes].sort((a, b) => a.size.sequence - b.size.sequence).map((z) => `${z.size.code} ${pcs(z.qty)}`).join(' · ')}
                        </p>
                      )}
                    </div>
                  ))}
                </div>
              </Section>

              <Section
                icon={ClipboardList}
                title="Materials from the BOM"
                actions={
                  plan && live && mayRaise ? (
                    <div className="flex flex-wrap items-center gap-2">
                      <label className="text-muted-foreground flex items-center gap-1.5 text-xs">
                        Needed by
                        <input type="date" className="form-input h-7 w-36 py-0 text-xs" value={requiredDate} onChange={(e) => setRequiredDate(e.target.value)} />
                      </label>
                      <button type="button" className="btn-primary h-8 px-3 text-xs" onClick={() => void raise()} disabled={busy !== null || !!raiseBlocker}>
                        {busy === 'raise' ? <Loader2 size={13} className="animate-spin" /> : <Send size={13} />} Raise requisitions
                      </button>
                    </div>
                  ) : undefined
                }
              >
                {loadingPlan && !plan ? (
                  <div className="skeleton h-32 w-full rounded-lg" />
                ) : !plan ? null : (
                  <>
                    {plan.missing.length > 0 && (
                      <p className="warn-text mb-2 flex items-start gap-1.5 text-xs">
                        <AlertCircle size={13} className="mt-px shrink-0" />
                        No approved BOM for {plan.missing.map((m) => `${m.style}${m.color ? ` ${m.color}` : ''} (${pcs(m.pieces)} pcs)`).join(', ')}: their materials are not worked out. Approve a BOM in
                        Masters → Bill of Materials.
                      </p>
                    )}
                    {plan.rows.length === 0 ? (
                      <p className="text-muted-foreground text-sm">Nothing to work out.</p>
                    ) : (
                      <div className="border-border overflow-x-auto rounded-lg border">
                        <table className="data-table w-full min-w-[1080px]">
                          <thead>
                            <tr className="bg-secondary">
                              {live && mayRaise && <th style={{ width: 32 }} />}
                              <th>Material</th>
                              <th>Department</th>
                              <th style={{ textAlign: 'right' }}>Needed</th>
                              <th style={{ textAlign: 'right' }}>In stock</th>
                              <th style={{ textAlign: 'right' }}>Asked for</th>
                              <th style={{ textAlign: 'right' }}>Short</th>
                              {live && mayRaise && (
                                <>
                                  <th style={{ textAlign: 'right' }}>Ask now</th>
                                  <th>From store</th>
                                </>
                              )}
                            </tr>
                          </thead>
                          <tbody>
                            {plan.rows.map((r) => {
                              const a = ask[r.key]
                              return (
                                <tr key={r.key}>
                                  {live && mayRaise && (
                                    <td>
                                      <input
                                        type="checkbox"
                                        className="accent-primary"
                                        checked={!!a?.on}
                                        onChange={(e) => setRow(r.key, { on: e.target.checked })}
                                        aria-label={`Ask for ${r.item.code}`}
                                      />
                                    </td>
                                  )}
                                  <td>
                                    <div className="text-foreground text-sm font-medium">
                                      <span className="font-mono text-xs">{r.item.code}</span> — {r.item.name}
                                    </div>
                                    <div className="text-muted-foreground text-[11px]">
                                      {r.styles.join(', ')}
                                      {r.ownership === 'CUSTOMER_OWNED' && <span className="badge-purple ml-1.5">Customer&apos;s</span>}
                                    </div>
                                  </td>
                                  <td className="text-xs">
                                    {live && mayRaise ? (
                                      <SmartSelect className="form-input h-8 w-36 py-0 text-xs" value={a?.departmentId ?? ''} onChange={(e) => setRow(r.key, { departmentId: e.target.value })}>
                                        <option value="">Department…</option>
                                        {plan.departments.map((d) => (
                                          <option key={d.id} value={d.id}>
                                            {d.name}
                                          </option>
                                        ))}
                                      </SmartSelect>
                                    ) : (
                                      r.department?.name ?? '—'
                                    )}
                                  </td>
                                  <td className="text-right text-xs tabular-nums">
                                    {qty(r.required)} {r.item.uom ?? ''}
                                  </td>
                                  <td className="text-right text-xs tabular-nums">{qty(r.inStock)}</td>
                                  <td className="text-right text-xs tabular-nums">{r.requested > 0 ? qty(r.requested) : '—'}</td>
                                  <td className={`text-right text-xs tabular-nums ${r.short > 0 ? 'warn-text font-medium' : 'text-muted-foreground'}`}>{r.short > 0 ? qty(r.short) : '—'}</td>
                                  {live && mayRaise && (
                                    <>
                                      <td className="w-32 text-right">
                                        <StepInput
                                          decimals
                                          className="form-input h-8 w-28 px-2 text-right text-xs tabular-nums"
                                          value={a?.qty ?? ''}
                                          placeholder="0"
                                          onValueChange={(v) => setRow(r.key, { qty: v, on: Number(v) > 0 })}
                                          aria-label={`Ask for ${r.item.code}, quantity`}
                                        />
                                      </td>
                                      <td>
                                        <SmartSelect className="form-input h-8 w-44 py-0 text-xs" value={a?.warehouseId ?? ''} onChange={(e) => setRow(r.key, { warehouseId: e.target.value })}>
                                          <option value="">Store…</option>
                                          {plan.warehouses.map((w) => {
                                            const held = r.stores.find((x) => x.id === w.id)
                                            return (
                                              <option key={w.id} value={w.id} data-sub={held ? `${qty(held.qty)} in stock` : 'none in stock'}>
                                                {w.name}
                                              </option>
                                            )
                                          })}
                                        </SmartSelect>
                                      </td>
                                    </>
                                  )}
                                </tr>
                              )
                            })}
                          </tbody>
                        </table>
                      </div>
                    )}
                    <p className="text-muted-foreground mt-2 flex items-start gap-1.5 text-xs">
                      <Info size={13} className="mt-px shrink-0" />
                      Needed = pieces by size × the BOM per piece, wastage included. Requisitions go one per department and wait for approval in
                      Inventory; the store then issues what it has and passes the rest to Purchase.
                    </p>
                    {live && mayRaise && raiseBlocker && <p className="warn-text mt-1 text-xs">{raiseBlocker}</p>}
                    {mo.status === 'DRAFT' && <p className="text-muted-foreground mt-1 text-xs">Release it to ask the store for these.</p>}
                  </>
                )}
              </Section>

              <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
                <Section icon={ClipboardList} title="Requisitions">
                  {mo.materialRequisitions.length === 0 ? (
                    <p className="text-muted-foreground text-sm">None raised yet.</p>
                  ) : (
                    <div className="divide-border divide-y text-sm">
                      {mo.materialRequisitions.map((m) => (
                        <div key={m.id} className="flex items-center justify-between gap-3 py-1.5">
                          <span>
                            <a href={`/inventory/requisitions?q=${encodeURIComponent(m.mrNumber)}`} className="text-primary font-mono text-xs hover:underline">
                              {m.mrNumber}
                            </a>{' '}
                            <span className="text-muted-foreground text-xs">
                              {m.department.name} · {m._count.lines} {m._count.lines === 1 ? 'item' : 'items'} · {formatDate(m.requestDate)}
                            </span>
                          </span>
                          <span className="text-xs">
                            {m.closedAt ? 'Closed' : m.issuedAt ? 'Issued' : m.status === 'APPROVED' ? 'Approved' : m.status === 'REJECTED' ? 'Refused' : 'Waiting approval'}
                          </span>
                        </div>
                      ))}
                    </div>
                  )}
                </Section>
                <Section icon={PackageCheck} title="Packed (Finished Goods In)">
                  {mo.fgReceipts.length === 0 ? (
                    <p className="text-muted-foreground text-sm">Nothing booked in against it yet. Packed garments go in under Inventory → Finished Goods In, against this order.</p>
                  ) : (
                    <div className="divide-border divide-y text-sm">
                      {mo.fgReceipts.map((f) => (
                        <div key={f.id} className={`flex items-center justify-between gap-3 py-1.5 ${f.cancelledAt ? 'opacity-60' : ''}`}>
                          <span>
                            <span className="font-mono text-xs">{f.fgrNumber}</span> <span className="text-muted-foreground text-xs">{formatDate(f.receiptDate)}</span>
                          </span>
                          <span className="text-xs tabular-nums">
                            {f.cancelledAt ? 'Cancelled' : `${pcs(f.lines.reduce((t, l) => t + Number(l.qty), 0))} pcs`}
                          </span>
                        </div>
                      ))}
                    </div>
                  )}
                </Section>
              </div>
            </>
          ) : null}
        </div>
      </div>
      {closing && mo && (
        <ReasonDialog
          title={`Close ${mo.moNumber}?`}
          description="It stays on file as closed, with your reason, and its pieces can be planned again. Requisitions already raised stay open in Inventory for the store to close."
          confirmLabel="Close it"
          placeholder="Buyer changed the fabric"
          danger
          busy={busy === 'close'}
          onCancel={() => setClosing(false)}
          onConfirm={(reason) => void closeIt(reason)}
        />
      )}
    </div>,
    document.body
  )
}
