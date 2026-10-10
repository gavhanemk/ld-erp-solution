'use client'

import { useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { AlertCircle, CheckCircle2, ClipboardList, Factory, FileText, Hash, Info, Loader2, Save, Wand2, X } from 'lucide-react'
import { api, ApiError } from '@/lib/api'
import { formatDate } from '@/lib/utils'
import { Section } from '@/components/purchase/Section'
import { SmartSelect } from '@/components/ui/SmartSelect'
import { StepInput } from '@/components/ui/StepInput'

interface Plannable {
  id: string
  soNumber: string
  deliveryDate: string | null
  customer: string
  ordered: number
  planned: number
  toPlan: number
}

interface PlanLine {
  soLineId: string
  item: { id: string; code: string; name: string }
  style: { id: string; code: string; name: string } | null
  color: string | null
  bom: { id: string; version: string; color: string | null } | null
  problem: string | null
  ordered: number
  planned: number
  remaining: number
  sizes: Array<{ sizeId: string; code: string; ordered: number; planned: number; remaining: number }>
}

interface Plan {
  order: {
    id: string
    soNumber: string
    status: string
    isJobWork: boolean
    deliveryDate: string | null
    customer: { name: string }
    brand: { name: string }
  }
  lines: PlanLine[]
}

interface SavedMo {
  id: string
  moNumber: string
  status: string
  soId: string | null
  plannedStartDate: string | null
  plannedEndDate: string | null
  notes: string | null
  lines: Array<{ soLineId: string | null; totalQty: number; sizes: Array<{ sizeId: string; qty: number }> }>
}

type Draft = Record<string, { sizes: Record<string, string>; qty: string }>

const day = (iso: string | null | undefined) => (iso ? iso.slice(0, 10) : '')
const pcs = (n: number) => n.toLocaleString('en-IN')

function Field({ label, icon: Icon, htmlFor, className = '', children }: { label: string; icon?: React.ElementType; htmlFor?: string; className?: string; children: React.ReactNode }) {
  return (
    <div className={`min-w-0 ${className}`}>
      <label className="form-label" htmlFor={htmlFor}>
        {label}
      </label>
      {Icon ? (
        <div className="relative">
          <Icon size={14} className="text-muted-foreground pointer-events-none absolute left-3 top-1/2 z-10 -translate-y-1/2" />
          {children}
        </div>
      ) : (
        children
      )}
    </div>
  )
}

/**
 * A manufacturing order: what the factory is to make for a confirmed sales
 * order.
 *
 * Pick the order and its lines come in with their style, colour and approved
 * BOM, and per size what was ordered, what earlier manufacturing orders have
 * already planned, and what is left — which is what the boxes start at. Make
 * less to split the order across several runs, or more to cut an allowance.
 * Saved as a draft to check, or released to the floor straight away.
 *
 * A line whose item has no style cannot be made here: the BOM, and so the
 * materials, hang off the style. The form says which and how to fix it.
 */
export function ManufacturingOrderDialog({
  open,
  soId: presetOrder,
  moId,
  onClose,
  onSaved,
}: {
  open: boolean
  /** The sales order to plan, when opened from it. */
  soId?: string | null
  /** A draft to change, instead of a new order. */
  moId?: string | null
  onClose: () => void
  onSaved: (message: string, moId: string) => void
}) {
  const [mounted, setMounted] = useState(false)
  useEffect(() => setMounted(true), [])

  const [orders, setOrders] = useState<Plannable[]>([])
  const [saved, setSaved] = useState<SavedMo | null>(null)
  const [soId, setSoId] = useState('')
  const [plan, setPlan] = useState<Plan | null>(null)
  const [draft, setDraft] = useState<Draft>({})
  const [start, setStart] = useState('')
  const [finish, setFinish] = useState('')
  const [notes, setNotes] = useState('')
  const [loading, setLoading] = useState(false)
  const [loadingPlan, setLoadingPlan] = useState(false)
  const [saving, setSaving] = useState<'draft' | 'release' | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !saving) onClose()
    }
    window.addEventListener('keydown', onKey)
    const previous = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      window.removeEventListener('keydown', onKey)
      document.body.style.overflow = previous
    }
  }, [open, onClose, saving])

  // Opening: the orders that can be planned, and the draft being changed.
  useEffect(() => {
    if (!open) return
    let alive = true
    setError(null)
    setSaved(null)
    setPlan(null)
    setDraft({})
    setStart(new Date().toISOString().slice(0, 10))
    setFinish('')
    setNotes('')
    setSoId('')
    setLoading(true)
    void (async () => {
      try {
        const [list, mo] = await Promise.all([
          api.get<{ data: Plannable[] }>('/production/plannable'),
          moId ? api.get<{ data: SavedMo }>(`/production/orders/${moId}`) : Promise.resolve(null),
        ])
        if (!alive) return
        setOrders(list.data)
        if (mo) {
          setSaved(mo.data)
          setSoId(mo.data.soId ?? '')
          setStart(day(mo.data.plannedStartDate))
          setFinish(day(mo.data.plannedEndDate))
          setNotes(mo.data.notes ?? '')
        } else if (presetOrder) {
          setSoId(presetOrder)
        }
      } catch (err) {
        if (alive) setError(err instanceof ApiError ? err.message : 'Could not load the orders.')
      } finally {
        if (alive) setLoading(false)
      }
    })()
    return () => {
      alive = false
    }
  }, [open, moId, presetOrder])

  // Each order picked: its lines as production plans them.
  useEffect(() => {
    if (!open || !soId) {
      setPlan(null)
      return
    }
    let alive = true
    setLoadingPlan(true)
    const qs = new URLSearchParams({ soId })
    if (saved) qs.set('moId', saved.id)
    api
      .get<{ data: Plan }>(`/production/plan?${qs}`)
      .then((res) => {
        if (!alive) return
        setPlan(res.data)
        if (!saved) setFinish((f) => f || day(res.data.order.deliveryDate))
        // A draft opens at its own pieces; a new one at what is left.
        const next: Draft = {}
        for (const l of res.data.lines) {
          const mine = saved?.lines.find((x) => x.soLineId === l.soLineId)
          next[l.soLineId] = saved
            ? {
                sizes: Object.fromEntries((mine?.sizes ?? []).map((s) => [s.sizeId, String(s.qty)])),
                qty: mine && !mine.sizes.length ? String(mine.totalQty) : '',
              }
            : l.style
              ? {
                  sizes: Object.fromEntries(l.sizes.map((s) => [s.sizeId, s.remaining > 0 ? String(s.remaining) : ''])),
                  qty: !l.sizes.length && l.remaining > 0 ? String(l.remaining) : '',
                }
              : { sizes: {}, qty: '' }
        }
        setDraft(next)
      })
      .catch((err) => alive && setError(err instanceof ApiError ? err.message : 'Could not load the order.'))
      .finally(() => alive && setLoadingPlan(false))
    return () => {
      alive = false
    }
  }, [open, soId, saved])

  const rows = useMemo(
    () =>
      (plan?.lines ?? []).map((l) => {
        const d = draft[l.soLineId] ?? { sizes: {}, qty: '' }
        const make = l.sizes.length ? l.sizes.reduce((t, s) => t + (Number(d.sizes[s.sizeId]) || 0), 0) : Number(d.qty) || 0
        return { l, d, make, over: make > l.remaining }
      }),
    [plan, draft]
  )
  const total = rows.reduce((t, r) => t + r.make, 0)
  const blocked = rows.find((r) => r.make > 0 && !r.l.style)

  const fillLeft = () => {
    if (!plan) return
    const next: Draft = {}
    for (const l of plan.lines) {
      next[l.soLineId] = l.style
        ? { sizes: Object.fromEntries(l.sizes.map((s) => [s.sizeId, s.remaining > 0 ? String(s.remaining) : ''])), qty: !l.sizes.length && l.remaining > 0 ? String(l.remaining) : '' }
        : { sizes: {}, qty: '' }
    }
    setDraft(next)
  }

  const setLine = (id: string, patch: Partial<Draft[string]>) => setDraft((d) => ({ ...d, [id]: { ...(d[id] ?? { sizes: {}, qty: '' }), ...patch } }))

  const blocker = !soId
    ? 'Pick the sales order to make.'
    : !plan
      ? null
      : blocked
        ? blocked.l.problem
        : total <= 0
          ? 'Put the pieces to make against at least one line.'
          : finish && start && finish < start
            ? 'It cannot finish before it starts.'
            : null

  const save = async (release: boolean) => {
    if (blocker || !plan) return
    setSaving(release ? 'release' : 'draft')
    setError(null)
    const body = {
      plannedStartDate: start || null,
      plannedEndDate: finish || null,
      notes: notes.trim() || null,
      lines: rows
        .filter((r) => r.make > 0)
        .map((r) => ({
          soLineId: r.l.soLineId,
          sizes: r.l.sizes.length ? r.l.sizes.map((s) => ({ sizeId: s.sizeId, qty: Number(r.d.sizes[s.sizeId]) || 0 })).filter((s) => s.qty > 0) : undefined,
          qty: r.l.sizes.length ? undefined : r.make,
        })),
    }
    try {
      let id: string
      let message: string
      if (saved) {
        const res = await api.patch<{ message?: string; data: { id: string } }>(`/production/orders/${saved.id}`, body)
        id = res.data.id
        message = res.message ?? `${saved.moNumber} saved.`
        if (release) {
          const r2 = await api.post<{ message?: string }>(`/production/orders/${saved.id}/release`, {})
          message = r2.message ?? message
        }
      } else {
        const res = await api.post<{ message?: string; data: { id: string } }>('/production/orders', { ...body, soId, release })
        id = res.data.id
        message = res.message ?? 'Manufacturing order saved.'
      }
      onSaved(message, id)
      onClose()
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save the manufacturing order.')
    } finally {
      setSaving(null)
    }
  }

  if (!open || !mounted) return null
  const o = plan?.order
  const busy = saving !== null || loading

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-stretch justify-center bg-black/60 p-2 backdrop-blur-sm sm:left-[var(--sidebar-current-width)] sm:p-3">
      <div className="glass-card po-form flex h-full max-h-full w-full flex-col overflow-hidden" role="dialog" aria-modal="true" aria-labelledby="mo-title">
        <div className="border-border flex shrink-0 items-center justify-between gap-4 border-b px-5 py-3.5">
          <div className="flex min-w-0 items-center gap-3">
            <div className="bg-primary/10 border-primary/20 flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border">
              <Factory size={19} className="text-primary" />
            </div>
            <div className="min-w-0">
              <h2 id="mo-title" className="text-foreground truncate text-xl font-semibold tracking-tight">
                Manufacturing Order
              </h2>
              <p className="text-muted-foreground mt-0.5 truncate text-[13px]">
                {saved ? `${saved.moNumber} — a draft can be changed until it is released` : o ? `Making ${o.soNumber} for ${o.customer.name}` : 'What the factory is to make for a sales order'}
              </p>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <button type="button" className="btn-primary hidden md:inline-flex" onClick={() => void save(true)} disabled={busy || !!blocker || !plan}>
              {saving === 'release' ? <Loader2 size={15} className="animate-spin" /> : <CheckCircle2 size={15} />} Save &amp; release
            </button>
            <button onClick={onClose} className="btn-ghost p-2" aria-label="Close" disabled={saving !== null}>
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
          {loading ? (
            <div className="skeleton h-72 w-full rounded-xl" />
          ) : (
            <>
              <Section icon={FileText} title="Basic Details">
                <div className="grid grid-cols-1 gap-x-4 gap-y-3 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-5">
                  <Field label="Sales order" icon={ClipboardList} htmlFor="mo-so" className="sm:col-span-2">
                    <SmartSelect id="mo-so" className="form-input pl-9" value={soId} onChange={(e) => setSoId(e.target.value)} disabled={!!saved}>
                      <option value="">Choose an order to make</option>
                      {/* The order being changed stays pickable even when nothing is left to plan on it. */}
                      {saved && plan && !orders.some((x) => x.id === plan.order.id) && <option value={plan.order.id}>{plan.order.soNumber}</option>}
                      {orders.map((x) => (
                        <option key={x.id} value={x.id} data-sub={`${x.customer} · ${pcs(x.toPlan)} pcs to plan${x.deliveryDate ? ` · due ${formatDate(x.deliveryDate)}` : ''}`}>
                          {x.soNumber}
                        </option>
                      ))}
                    </SmartSelect>
                  </Field>
                  <Field label="MO no." icon={Hash}>
                    <div className="form-input text-muted-foreground pl-9 font-mono">{saved?.moNumber ?? 'Given when saved'}</div>
                  </Field>
                  <Field label="Planned start" htmlFor="mo-start">
                    <input id="mo-start" type="date" className="form-input" value={start} onChange={(e) => setStart(e.target.value)} />
                  </Field>
                  <Field label="Planned finish" htmlFor="mo-finish">
                    <input id="mo-finish" type="date" className="form-input" value={finish} min={start || undefined} onChange={(e) => setFinish(e.target.value)} />
                  </Field>
                  <Field label="Notes for the floor" htmlFor="mo-notes" className="sm:col-span-2 lg:col-span-5">
                    <input id="mo-notes" className="form-input" maxLength={1000} value={notes} placeholder="Cutting priority, special checks" onChange={(e) => setNotes(e.target.value)} />
                  </Field>
                </div>
                {o && (
                  <div className="border-border bg-secondary/30 mt-3 flex flex-wrap items-center gap-x-5 gap-y-1 rounded-lg border px-3 py-2 text-xs">
                    <span className="text-foreground font-medium">{o.customer.name}</span>
                    <span className="text-muted-foreground">{o.brand.name}</span>
                    {o.deliveryDate && <span className="text-muted-foreground">Delivery due {formatDate(o.deliveryDate)}</span>}
                    {o.isJobWork && <span className="badge-purple">Job work · the customer&apos;s fabric</span>}
                  </div>
                )}
              </Section>

              <Section
                icon={Factory}
                title="What to make"
                actions={
                  plan ? (
                    <div className="flex items-center gap-2">
                      <span className="text-muted-foreground text-xs tabular-nums">{pcs(total)} pcs</span>
                      <button type="button" className="btn-secondary h-7 px-2.5 text-xs" onClick={fillLeft}>
                        <Wand2 size={13} /> Fill what&apos;s left
                      </button>
                    </div>
                  ) : undefined
                }
              >
                {!soId ? (
                  <p className="text-muted-foreground text-sm">Pick a confirmed sales order. Its lines come in with what is still to make.</p>
                ) : loadingPlan || !plan ? (
                  <div className="skeleton h-40 w-full rounded-lg" />
                ) : (
                  <div className="space-y-3">
                    {rows.map(({ l, d, make, over }) => (
                      <div key={l.soLineId} className={`border-border bg-card rounded-lg border p-3 ${!l.style ? 'opacity-80' : ''}`}>
                        <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-1">
                          <div className="min-w-0">
                            <p className="text-foreground text-sm font-medium">
                              <span className="font-mono text-xs">{l.item.code}</span> — {l.item.name}
                            </p>
                            <p className="text-muted-foreground text-[11px]">
                              {l.style ? (
                                <>
                                  Style <span className="font-mono">{l.style.code}</span>
                                  {l.color ? ` · ${l.color}` : ''} ·{' '}
                                  {l.bom ? (
                                    <span className="text-primary">
                                      BOM v{l.bom.version}
                                      {l.bom.color ? ` ${l.bom.color}` : ' (all colours)'}
                                    </span>
                                  ) : (
                                    <span className="warn-text">no approved BOM</span>
                                  )}
                                </>
                              ) : (
                                <span className="warn-text">No style</span>
                              )}
                            </p>
                          </div>
                          <p className="text-muted-foreground text-xs tabular-nums">
                            Ordered {pcs(l.ordered)} · Planned {pcs(l.planned)} · <span className="text-foreground font-medium">Left {pcs(l.remaining)}</span>
                          </p>
                        </div>
                        {l.problem && (
                          <p className={`mt-1.5 flex items-start gap-1.5 text-xs ${l.style ? 'text-muted-foreground' : 'warn-text'}`}>
                            <Info size={13} className="mt-px shrink-0" />
                            {l.problem}
                          </p>
                        )}
                        {l.style && (
                          <div className="mt-2 overflow-x-auto">
                            <table className="subtable w-auto">
                              <thead>
                                <tr>
                                  <th className="text-left" />
                                  {l.sizes.length ? (
                                    l.sizes.map((s) => (
                                      <th key={s.sizeId} className="w-16 text-center">
                                        {s.code}
                                      </th>
                                    ))
                                  ) : (
                                    <th className="w-24 text-center">Pieces</th>
                                  )}
                                  <th className="w-16 text-right">Total</th>
                                </tr>
                              </thead>
                              <tbody>
                                <tr>
                                  <td className="text-muted-foreground pr-4 text-xs">Left to make</td>
                                  {l.sizes.length ? (
                                    l.sizes.map((s) => (
                                      <td key={s.sizeId} className="text-center text-xs tabular-nums">
                                        {pcs(s.remaining)}
                                      </td>
                                    ))
                                  ) : (
                                    <td className="text-center text-xs tabular-nums">{pcs(l.remaining)}</td>
                                  )}
                                  <td className="text-right text-xs tabular-nums">{pcs(l.remaining)}</td>
                                </tr>
                                <tr>
                                  <td className="text-foreground pr-4 text-xs font-medium">Make now</td>
                                  {l.sizes.length ? (
                                    l.sizes.map((s) => (
                                      <td key={s.sizeId} className="px-1 py-1">
                                        <StepInput
                                          className={`form-input h-8 w-14 px-1 text-center text-xs tabular-nums ${(Number(d.sizes[s.sizeId]) || 0) > s.remaining ? 'border-primary/60' : ''}`}
                                          value={d.sizes[s.sizeId] ?? ''}
                                          placeholder="0"
                                          aria-label={`${l.item.code} size ${s.code}, make now`}
                                          onValueChange={(v) => setLine(l.soLineId, { sizes: { ...d.sizes, [s.sizeId]: v } })}
                                        />
                                      </td>
                                    ))
                                  ) : (
                                    <td className="px-1 py-1">
                                      <StepInput
                                        className="form-input h-8 w-20 px-1 text-center text-xs tabular-nums"
                                        value={d.qty}
                                        placeholder="0"
                                        aria-label={`${l.item.code}, make now`}
                                        onValueChange={(v) => setLine(l.soLineId, { qty: v })}
                                      />
                                    </td>
                                  )}
                                  <td className="text-foreground text-right text-xs font-semibold tabular-nums">{pcs(make)}</td>
                                </tr>
                              </tbody>
                            </table>
                          </div>
                        )}
                        {over && <p className="text-muted-foreground mt-1.5 text-xs">More than is left on the order — an allowance for cutting losses is fine.</p>}
                      </div>
                    ))}
                  </div>
                )}
              </Section>
            </>
          )}
        </div>

        <div className="border-border flex shrink-0 flex-wrap items-center justify-end gap-2 border-t px-3 py-2.5 sm:gap-3 sm:px-5 sm:py-3.5">
          {blocker && !loading && (
            <p className="warn-text mr-auto flex max-w-xl basis-full items-start gap-1.5 text-xs sm:basis-auto">
              <AlertCircle size={13} className="mt-px shrink-0" />
              <span>{blocker}</span>
            </p>
          )}
          <button type="button" onClick={onClose} className="btn-secondary hidden sm:inline-flex" disabled={saving !== null}>
            Cancel
          </button>
          <button type="button" className="btn-secondary" onClick={() => void save(false)} disabled={busy || !!blocker || !plan}>
            {saving === 'draft' ? <Loader2 size={15} className="animate-spin" /> : <Save size={15} />}
            <span className="sm:hidden">Draft</span>
            <span className="hidden sm:inline">Save as draft</span>
          </button>
          <button type="button" className="btn-primary" onClick={() => void save(true)} disabled={busy || !!blocker || !plan}>
            {saving === 'release' ? <Loader2 size={15} className="animate-spin" /> : <CheckCircle2 size={15} />} Save &amp; release
          </button>
        </div>
      </div>
    </div>,
    document.body
  )
}
