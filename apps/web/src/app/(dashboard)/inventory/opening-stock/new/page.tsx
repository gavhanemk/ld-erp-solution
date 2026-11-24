'use client'

import { Suspense, useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import Link from 'next/link'
import { useRouter, useSearchParams } from 'next/navigation'
import { AlertCircle, ArrowLeft, ArrowRight, CheckCircle2, FileSpreadsheet, Loader2, Printer, RotateCcw } from 'lucide-react'
import { api, ApiError, can } from '@/lib/api'
import { cn, newRequestId } from '@/lib/utils'
import { SmartSelect } from '@/components/ui/SmartSelect'
import { KINDS, kindOf, money, num, STATUSES, todayInIndia, cellKey, type FormOptions, type Kind } from '@/components/inventory/opening/kinds'
import { FinishedGoods, RawMaterials, SemiFinished, type Garment, type Material } from '@/components/inventory/opening/Workspaces'
import { planOf, type PackValue } from '@/components/packages/PackagingEditor'
import { StickersReady } from '@/components/packages/StickersReady'

/*
 * Inventory → Opening Stock → Add Opening Stock: a guided entry, one kind at
 * a time. First what is being entered — finished goods, semi-finished goods
 * or raw materials — then that kind's own screen, where each choice leads
 * only to what belongs to it; then a review, checked by the same rules as an
 * Excel import, and the save. The entry is kept on this computer until it is
 * saved or thrown away, and a save sent twice posts once.
 */

interface Draft {
  kind: Kind
  /** Sent with the save: the same save twice posts once. */
  requestKey: string
  date: string
  storeId: string
  status: string
  orderNo: string
  notes: string
  garments: Garment[]
  materials: Material[]
  savedAt: number
}
interface PlanRow {
  row: number
  problems: string[]
  item: { code: string; name: string } | null
  size: string | null
  qty: number | null
  unit: string | null
  rate: number | null
  value: number | null
  process: string
  location: string
  newFloor: boolean
  /** Raw materials labelled by package: what its stickers will be. */
  packing?: string | null
  stickers?: number
}
/** A lot's packing, as the save takes it. */
interface PackBody {
  type: string
  qtys?: number[]
  refs?: Array<string | null>
  later?: boolean
  count?: number
}
type EntryLine = Record<string, string | number | PackBody>
interface Saved {
  id: string
  number: string
  lines: number
  stickers: number
  floorsMade: string[]
  again?: boolean
  message?: string
  value: number
}
type Step = 'enter' | 'review' | 'saved'

const DRAFT = (k: Kind) => `ld-opening-draft-v1-${k}`
const fresh = (kind: Kind): Draft => ({
  kind,
  requestKey: newRequestId(),
  date: todayInIndia(),
  storeId: '',
  status: 'OK',
  orderNo: '',
  notes: '',
  garments: [],
  materials: [],
  savedAt: 0,
})
const readDraft = (k: Kind): Draft | null => {
  try {
    const raw = localStorage.getItem(DRAFT(k))
    const d = raw ? (JSON.parse(raw) as Draft) : null
    return d && d.kind === k && (d.garments?.length || d.materials?.length) ? d : null
  } catch {
    return null
  }
}
const dropDraft = (k: Kind) => {
  try {
    localStorage.removeItem(DRAFT(k))
  } catch {
    // Nothing kept: nothing to drop.
  }
}

/** The screen's own names for its boxes, so a problem points at what is on screen. */
const LABELS: Record<Kind, Record<string, string>> = {
  FG: { date: 'Opening date', location: 'Store', code: 'Item', qty: 'Pieces', rate: 'Rate per piece', status: 'Stock status', style: 'Style' },
  SFG: { date: 'Opening date', process: 'Process', location: 'Location', code: 'Item', qty: 'Pieces', rate: 'Rate per piece', status: 'Stock status', style: 'Style' },
  RM: {
    date: 'Opening date',
    location: 'Store',
    code: 'Item',
    qty: 'Opening Qty',
    rate: 'Unit Rate',
    status: 'Stock status',
    uom: 'Unit',
    packType: 'Packed in',
    packCount: 'Packages',
    packEach: 'Each package holds',
    packQtys: 'The packages',
    packRefs: 'Roll no.',
  },
}

/** The packing chosen in "Packed as", as the save takes it: sizes worked out here, or none yet. */
function packBody(v: PackValue, qty: number, unit: string, places: number): PackBody {
  if (v.method === 'LATER') return { type: v.type, later: true, ...(Number(v.count) >= 1 ? { count: Math.floor(Number(v.count)) } : {}) }
  const plan = planOf(v, qty, unit, places)
  return { type: v.type, qtys: plan.qtys, ...(plan.notes.some(Boolean) ? { refs: plan.notes.map((n) => n || null) } : {}) }
}
const STEPS = ['What you are entering', 'Enter the stock', 'Review', 'Saved']

/** The store an entry most likely goes to: the finished goods store, or the raw material one. */
function likelyStore(o: FormOptions, k: Kind) {
  const by = (re: RegExp) => o.stores.find((s) => re.test(s.name))?.id
  return (k === 'FG' ? (by(/finish|\bfg\b/i) ?? by(/^store$/i)) : (by(/raw|fabric|main/i) ?? by(/^store$/i))) ?? o.stores[0]?.id ?? ''
}

export default function AddOpeningStockPage() {
  return (
    <Suspense fallback={null}>
      <AddOpeningStock />
    </Suspense>
  )
}

function AddOpeningStock() {
  const params = useSearchParams()
  const router = useRouter()
  const kind = kindOf(params.get('type'))?.key ?? null
  const [options, setOptions] = useState<FormOptions | null>(null)
  const [draft, setDraft] = useState<Draft | null>(null)
  const [restored, setRestored] = useState(false)
  const [step, setStep] = useState<Step>('enter')
  const [plan, setPlan] = useState<PlanRow[] | null>(null)
  const [problems, setProblems] = useState<Map<string, string[]>>(new Map())
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState<Saved | null>(null)
  const [throwing, setThrowing] = useState(false)
  const [printing, setPrinting] = useState(false)
  const mayAdd = can('inventory', 'create')

  const loadOptions = useCallback(async () => {
    try {
      const r = await api.get<{ data: FormOptions }>('/inventory/opening-stock/form')
      setOptions(r.data)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load the styles and items. Is the API running?')
    }
  }, [])
  useEffect(() => {
    void loadOptions()
  }, [loadOptions])

  // The kind's draft, kept on this computer: carried on where it was left.
  useEffect(() => {
    if (!kind) {
      setDraft(null)
      return
    }
    const kept = readDraft(kind)
    setDraft(kept ?? fresh(kind))
    setRestored(Boolean(kept))
    setStep('enter')
    setPlan(null)
    setProblems(new Map())
    setSaved(null)
    setError(null)
  }, [kind])
  useEffect(() => {
    if (!draft || step === 'saved') return
    const t = setTimeout(() => {
      try {
        if (draft.garments.length || draft.materials.length) localStorage.setItem(DRAFT(draft.kind), JSON.stringify({ ...draft, savedAt: Date.now() }))
      } catch {
        // Not kept on this computer: the entry still saves.
      }
    }, 400)
    return () => clearTimeout(t)
  }, [draft, step])
  // The likely store, once the stores are known.
  useEffect(() => {
    if (options && draft && !draft.storeId && draft.kind !== 'SFG') setDraft((d) => d && { ...d, storeId: likelyStore(options, d.kind) })
  }, [options, draft])

  const set = (change: Partial<Draft>) => {
    setDraft((d) => d && { ...d, ...change })
    if (step === 'review') setStep('enter')
  }

  // Every line to bring in, as the sheet's columns, and what each belongs to on screen.
  const built = useMemo(() => {
    const lines: EntryLine[] = []
    const refs: Array<{ key: string; label: string; style?: string; colour?: string }> = []
    let value = 0
    if (!draft || !options) return { lines, refs, value, pieces: 0 }
    const storeName = options.stores.find((s) => s.id === draft.storeId)?.name ?? ''
    const base = { date: draft.date, status: draft.status }
    let pieces = 0
    for (const g of draft.kind === 'RM' ? [] : draft.garments) {
      const st = options.styles.find((x) => x.id === g.styleId)
      if (!st) continue
      const process = draft.kind === 'SFG' ? (options.processes.find((p) => p.id === g.processId) ?? st.route?.find((p) => p.id === g.processId)) : null
      if (draft.kind === 'SFG' && !process) continue
      for (const c of st.colours) {
        if (!c.item) continue
        for (const s of st.sizes) {
          const q = Number(g.qty[cellKey(c.colour, s.id)] || 0)
          if (!(q > 0)) continue
          const rate = g.rates[s.id] ?? ''
          value += q * Number(rate || 0)
          pieces += q
          lines.push({
            ...base,
            process: draft.kind === 'FG' ? 'Finished Goods' : process!.name,
            location: draft.kind === 'FG' ? storeName : (options.stores.find((w) => w.id === g.locationId)?.name ?? ''),
            order: (draft.kind === 'FG' ? draft.orderNo : g.orderNo).trim(),
            bundle: draft.kind === 'SFG' ? g.bundle.trim() : '',
            style: st.code,
            code: c.item.code,
            colour: c.colour,
            size: s.code,
            qty: q,
            rate,
          })
          refs.push({ key: g.key, label: `${st.code} ${c.colour} ${s.code}${process ? ` at ${process.name}` : ''}`, style: st.code, colour: c.colour })
        }
      }
    }
    for (const m of draft.kind === 'RM' ? draft.materials : []) {
      const it = options.items.find((x) => x.id === m.itemId)
      if (!it) continue
      const category = options.categories.find((c) => c.id === it.categoryId)?.name ?? ''
      for (const l of m.lots) {
        const q = Number(l.qty || 0)
        if (!(q > 0)) continue
        value += q * Number(l.rate || 0)
        lines.push({
          ...base,
          process: 'Store',
          location: storeName,
          category,
          code: it.code,
          uom: it.unit ?? '',
          qty: q,
          rate: l.rate,
          lot: l.lot.trim(),
          bundle: l.bundle.trim(),
          // Its packing, when one was chosen; else the save goes by the item's usual.
          ...(it.tracked && l.pack ? { pack: packBody(l.pack, q, it.unit ?? '', it.decimals) } : {}),
        })
        refs.push({ key: l.key, label: `${it.code}${l.lot.trim() ? ` lot ${l.lot.trim()}` : ''}${l.bundle.trim() ? ` · ${l.bundle.trim()}` : ''}` })
      }
    }
    return { lines, refs, value, pieces }
  }, [draft, options])

  const review = async () => {
    if (!draft) return
    if (draft.kind !== 'SFG' && !draft.storeId) return setError('Pick the store the stock is in.')
    if (!built.lines.length) {
      return setError(draft.kind === 'RM' ? 'Enter a quantity for at least one lot or roll.' : 'Enter pieces for at least one colour and size.')
    }
    setBusy(true)
    setError(null)
    try {
      const res = await api.post<{ data: { rows: PlanRow[] } }>('/inventory/opening-stock/entry', { lines: built.lines, kind: draft.kind, labels: LABELS[draft.kind], notes: draft.notes })
      const byKey = new Map<string, string[]>()
      for (const r of res.data.rows) {
        const ref = built.refs[r.row - 1]
        if (ref && r.problems.length) byKey.set(ref.key, [...(byKey.get(ref.key) ?? []), ...r.problems.map((p) => `${ref.label}: ${p}`)])
      }
      setProblems(byKey)
      setPlan(res.data.rows)
      setStep('review')
      window.scrollTo({ top: 0 })
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not check the entry.')
    } finally {
      setBusy(false)
    }
  }

  const confirm = async () => {
    if (!draft) return
    setBusy(true)
    setError(null)
    try {
      const res = await api.post<{ message: string; data: Omit<Saved, 'value' | 'message'> }>('/inventory/opening-stock/entry', {
        lines: built.lines,
        kind: draft.kind,
        labels: LABELS[draft.kind],
        notes: draft.notes,
        confirm: true,
        requestKey: draft.requestKey,
      })
      dropDraft(draft.kind)
      setSaved({ ...res.data, message: res.message, value: built.value })
      setStep('saved')
      // Stickers made as it came in: here they are to print.
      if (res.data.stickers > 0) setPrinting(true)
      window.scrollTo({ top: 0 })
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save the opening stock.')
    } finally {
      setBusy(false)
    }
  }

  const startAgain = () => {
    if (!kind) return
    dropDraft(kind)
    setDraft(fresh(kind))
    setRestored(false)
    setStep('enter')
    setPlan(null)
    setProblems(new Map())
    setSaved(null)
    setThrowing(false)
    setPrinting(false)
    setError(null)
  }

  const k = kindOf(kind)
  const stepIndex = !kind ? 0 : step === 'enter' ? 1 : step === 'review' ? 2 : 3
  const bad = (plan ?? []).filter((r) => r.problems.length).length

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <Link href="/inventory/opening-stock" className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1 text-xs">
            <ArrowLeft size={12} /> Opening Stock
          </Link>
          <h1 className="page-title">Add Opening Stock{k ? ` — ${k.label}` : ''}</h1>
        </div>
        <ol className="flex flex-wrap items-center gap-1 text-xs" aria-label="Steps">
          {STEPS.map((label, i) => (
            <li key={label} className="flex items-center gap-1">
              <span
                className={cn(
                  'flex items-center gap-1.5 rounded-full border px-2.5 py-1',
                  i === stepIndex ? 'border-primary bg-primary/10 text-primary font-semibold' : i < stepIndex ? 'border-border text-foreground' : 'border-border text-muted-foreground',
                )}
                aria-current={i === stepIndex ? 'step' : undefined}
              >
                <span className="tabular-nums">{i + 1}</span> {label}
              </span>
              {i < STEPS.length - 1 && <span className="text-muted-foreground">›</span>}
            </li>
          ))}
        </ol>
      </div>

      {!mayAdd && <Banner tone="warn">Adding opening stock needs Inventory → create. Ask an administrator for it.</Banner>}
      {error && <Banner tone="bad">{error}</Banner>}

      {/* 1. What is being entered. */}
      {!kind && (
        <div className="space-y-4">
          <div className="grid gap-4 lg:grid-cols-3">
            {KINDS.map((t) => {
              const waiting = typeof window !== 'undefined' ? readDraft(t.key) : null
              return (
                <button
                  key={t.key}
                  type="button"
                  onClick={() => router.push(`/inventory/opening-stock/new?type=${t.key}`)}
                  className="glass-card hover:border-primary group flex flex-col gap-3 border p-5 text-left transition-colors"
                  aria-label={`Enter ${t.label}`}
                >
                  <div className="flex items-center gap-3">
                    <span className="bg-primary/10 text-primary rounded-xl p-3">
                      <t.icon size={22} />
                    </span>
                    <div>
                      <div className="text-foreground text-lg font-semibold">{t.label}</div>
                      <div className="text-muted-foreground text-xs font-semibold">{t.short}</div>
                    </div>
                  </div>
                  <p className="text-muted-foreground text-sm">{t.text}</p>
                  <div className="flex flex-wrap items-center gap-1 text-xs">
                    {t.steps.map((s, i) => (
                      <span key={s} className="flex items-center gap-1">
                        <span className="badge-neutral">{s}</span>
                        {i < t.steps.length - 1 && <ArrowRight size={11} className="text-muted-foreground" />}
                      </span>
                    ))}
                  </div>
                  {waiting && <span className="badge-warning w-fit">An unsaved entry is waiting</span>}
                  <span className="text-primary mt-auto text-sm font-semibold group-hover:underline">Enter {t.label} →</span>
                </button>
              )
            })}
          </div>
          <p className="text-muted-foreground text-sm">
            A lot to enter?{' '}
            <Link href="/inventory/opening-stock/import" className="text-primary inline-flex items-center gap-1 font-medium hover:underline">
              <FileSpreadsheet size={14} /> Import it from Excel instead
            </Link>
          </p>
        </div>
      )}

      {kind && draft && !options && (
        <p className="text-muted-foreground flex items-center gap-2 text-sm">
          <Loader2 size={15} className="animate-spin" /> Loading the styles and items…
        </p>
      )}

      {/* 2. Enter, and 3. review. */}
      {kind && draft && options && step !== 'saved' && (
        <>
          {restored && step === 'enter' && (
            <Banner tone="info">
              Your unsaved {k?.label.toLowerCase()} entry is back, as you left it.{' '}
              <button type="button" className="text-primary font-medium hover:underline" onClick={startAgain}>
                Start fresh instead
              </button>
            </Banner>
          )}

          {step === 'review' && plan && (
            <ReviewPanel kind={kind} plan={plan} lines={built.lines} bad={bad} problems={problems} value={built.value} pieces={built.pieces} />
          )}

          <fieldset disabled={step === 'review' || busy} className={cn('space-y-3', step === 'review' && 'opacity-60')}>
            {/* Where and when, for the whole entry. */}
            <section className="glass-card grid gap-3 p-4 sm:grid-cols-2 lg:grid-cols-5" aria-label="Where and when">
              <label className="space-y-1 text-sm">
                <span className="text-foreground font-medium">Opening date</span>
                <input type="date" className="form-input" value={draft.date} max={todayInIndia()} onChange={(e) => set({ date: e.target.value })} aria-label="Opening date" />
              </label>
              {kind !== 'SFG' && (
                <label className="space-y-1 text-sm">
                  <span className="text-foreground font-medium">{kind === 'FG' ? 'Finished goods store' : 'Store'}</span>
                  <SmartSelect className="form-input" value={draft.storeId} onChange={(e) => set({ storeId: e.target.value })} aria-label="Store">
                    <option value="">Pick the store…</option>
                    {options.stores.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name}
                      </option>
                    ))}
                  </SmartSelect>
                </label>
              )}
              <label className="space-y-1 text-sm">
                <span className="text-foreground font-medium">Stock status</span>
                <SmartSelect className="form-input" value={draft.status} onChange={(e) => set({ status: e.target.value })} aria-label="Stock status">
                  {STATUSES.filter((s) => kind !== 'RM' || s.value !== 'B-Grade').map((s) => (
                    <option key={s.value} value={s.value}>
                      {s.label}
                    </option>
                  ))}
                </SmartSelect>
              </label>
              {kind === 'FG' && (
                <label className="space-y-1 text-sm">
                  <span className="text-foreground font-medium">Order No.</span>
                  <input className="form-input" value={draft.orderNo} onChange={(e) => set({ orderNo: e.target.value })} placeholder="Optional" aria-label="Order No." />
                </label>
              )}
              <label className={cn('space-y-1 text-sm', kind === 'SFG' ? 'lg:col-span-3' : kind === 'RM' ? 'lg:col-span-2' : '')}>
                <span className="text-foreground font-medium">Remarks</span>
                <input className="form-input" value={draft.notes} onChange={(e) => set({ notes: e.target.value })} placeholder="Optional: who counted it, anything to remember" aria-label="Remarks" />
              </label>
            </section>

            {(() => {
              const shared = {
                options,
                problems,
                mayMakeItems: can('masters', 'create'),
                maySetSizeRun: can('masters', 'edit'),
                onReload: loadOptions,
                onColourMade: (styleId: string, colour: string, item: { id: string; code: string }) =>
                  setOptions(
                    (o) =>
                      o && {
                        ...o,
                        styles: o.styles.map((s) => (s.id === styleId ? { ...s, colours: s.colours.map((c) => (c.colour === colour ? { ...c, item } : c)) } : s)),
                      },
                  ),
              }
              if (kind === 'FG') return <FinishedGoods {...shared} garments={draft.garments} onChange={(garments) => set({ garments })} />
              if (kind === 'SFG') return <SemiFinished {...shared} garments={draft.garments} onChange={(garments) => set({ garments })} />
              return <RawMaterials {...shared} materials={draft.materials} onChange={(materials) => set({ materials })} />
            })()}
          </fieldset>

          {/* The actions, always in reach. */}
          <div className="border-border bg-card/95 sticky bottom-0 z-30 -mx-4 border-t px-4 py-3 backdrop-blur">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <p className="text-muted-foreground text-sm">
                {built.lines.length ? (
                  <>
                    <span className="text-foreground font-semibold">{built.lines.length}</span> {built.lines.length === 1 ? 'line' : 'lines'}
                    {kind !== 'RM' && (
                      <>
                        {' '}
                        · <span className="text-foreground font-semibold">{num(built.pieces)}</span> pcs
                      </>
                    )}{' '}
                    · <span className="text-foreground font-semibold">{money(built.value)}</span>
                  </>
                ) : (
                  'Nothing entered yet'
                )}
              </p>
              <div className="flex items-center gap-2">
                {step === 'enter' ? (
                  <>
                    {throwing ? (
                      <span className="flex items-center gap-2 text-sm">
                        Throw this entry away?
                        <button type="button" className="btn-secondary h-9 text-sm" onClick={startAgain}>
                          Yes, throw away
                        </button>
                        <button type="button" className="btn-ghost h-9 text-sm" onClick={() => setThrowing(false)}>
                          Keep it
                        </button>
                      </span>
                    ) : (
                      <button type="button" className="btn-ghost h-9 text-sm" onClick={() => (built.lines.length ? setThrowing(true) : router.push('/inventory/opening-stock/new'))}>
                        {built.lines.length ? 'Throw away' : 'Back'}
                      </button>
                    )}
                    <button type="button" className="btn-primary h-9" disabled={busy || !mayAdd} onClick={() => void review()}>
                      {busy ? <Loader2 size={15} className="animate-spin" /> : null} Review <ArrowRight size={15} />
                    </button>
                  </>
                ) : (
                  <>
                    <button type="button" className="btn-secondary h-9" disabled={busy} onClick={() => setStep('enter')}>
                      <ArrowLeft size={15} /> {bad ? 'Back to put them right' : 'Back to the entry'}
                    </button>
                    <button type="button" className="btn-primary h-9" disabled={busy || bad > 0} onClick={() => void confirm()}>
                      {busy ? <Loader2 size={15} className="animate-spin" /> : <CheckCircle2 size={15} />} Confirm and save
                    </button>
                  </>
                )}
              </div>
            </div>
          </div>
        </>
      )}

      {/* 4. Saved. */}
      {kind && step === 'saved' && saved && (
        <div className="glass-card space-y-4 p-6">
          <div className="flex items-start gap-3">
            <CheckCircle2 size={28} className="shrink-0 text-emerald-500" />
            <div>
              <h2 className="text-foreground text-lg font-semibold">
                {saved.again ? 'Already saved' : 'Saved'} as <span className="font-mono text-teal-400">{saved.number}</span>
              </h2>
              <p className="text-muted-foreground text-sm" role="status">
                {saved.message}
              </p>
              <p className="text-foreground mt-1 text-sm">
                {saved.lines} {saved.lines === 1 ? 'line' : 'lines'} of {k?.label.toLowerCase()} · {money(saved.value)} — in stock now, by item, size and place.
              </p>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" className="btn-primary" onClick={startAgain}>
              <RotateCcw size={15} /> Enter more {k?.label}
            </button>
            <Link href={`/inventory/opening-stock?entry=${saved.id}`} className="btn-secondary">
              See these lines
            </Link>
            {saved.stickers > 0 && (
              <button type="button" className="btn-secondary" onClick={() => setPrinting(true)}>
                <Printer size={15} /> Print {saved.stickers} {saved.stickers === 1 ? 'sticker' : 'stickers'}
              </button>
            )}
            <Link href="/inventory/opening-stock/new" className="btn-ghost">
              Enter another kind
            </Link>
          </div>
          {printing && <StickersReady source={{ type: 'OPENING', id: saved.id }} onClose={() => setPrinting(false)} />}
        </div>
      )}
    </div>
  )
}

/** The check's answer: every line right and what goes in, or what to put right first. */
function ReviewPanel({
  kind,
  plan,
  lines,
  bad,
  problems,
  value,
  pieces,
}: {
  kind: Kind
  plan: PlanRow[]
  lines: EntryLine[]
  bad: number
  problems: Map<string, string[]>
  value: number
  pieces: number
}) {
  if (bad) {
    return (
      <section className="space-y-2 rounded-xl border border-red-500/40 bg-red-500/10 p-4" aria-label="Review">
        <p className="flex items-center gap-2 text-sm font-semibold text-red-400">
          <AlertCircle size={16} /> {bad} {bad === 1 ? 'line' : 'lines'} of {plan.length} {bad === 1 ? 'needs' : 'need'} putting right. Nothing is saved until every line is right.
        </p>
        <ul className="space-y-0.5 text-xs text-red-400">
          {[...problems.values()].flat().map((p) => (
            <li key={p}>• {p}</li>
          ))}
        </ul>
        <p className="text-muted-foreground text-xs">Go back to the entry: each line in trouble is marked in red there.</p>
      </section>
    )
  }
  const garments = kind !== 'RM'
  return (
    <section className="glass-card space-y-3 p-4" aria-label="Review">
      <p className="flex items-center gap-2 text-sm font-semibold text-emerald-500">
        <CheckCircle2 size={16} /> All {plan.length} {plan.length === 1 ? 'line is' : 'lines are'} right. Check them, then confirm.
      </p>
      <div className="flex flex-wrap gap-2 text-sm">
        <span className="badge-success">{plan.length} lines</span>
        {garments && <span className="badge-neutral">{num(pieces)} pcs</span>}
        <span className="badge-info">{money(value)}</span>
        {!garments && plan.some((r) => r.stickers) && (
          <span className="badge-neutral">
            {plan.reduce((t, r) => t + (r.stickers ?? 0), 0)} stickers to print
          </span>
        )}
        {[...new Set(plan.map((r) => r.location))].map((l) => (
          <span key={l} className="badge-neutral">
            into {l}
            {plan.some((r) => r.location === l && r.newFloor) ? ' (made on save)' : ''}
          </span>
        ))}
      </div>
      <div className="max-h-80 overflow-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="text-muted-foreground text-left text-[10px] font-semibold uppercase tracking-wide">
              {garments ? (
                <>
                  <th className="px-2 py-1.5">Style</th>
                  <th className="px-2 py-1.5">Item</th>
                  <th className="px-2 py-1.5">Colour</th>
                  <th className="px-2 py-1.5">Size</th>
                  {kind === 'SFG' && <th className="px-2 py-1.5">Process</th>}
                </>
              ) : (
                <>
                  <th className="px-2 py-1.5">Item</th>
                  <th className="px-2 py-1.5">Lot / Roll</th>
                  <th className="px-2 py-1.5">Bundle</th>
                </>
              )}
              <th className="px-2 py-1.5">Location</th>
              <th className="px-2 py-1.5 text-right">Qty</th>
              <th className="px-2 py-1.5 text-right">Rate</th>
              <th className="px-2 py-1.5 text-right">Value</th>
              {!garments && <th className="px-2 py-1.5">Stickers</th>}
            </tr>
          </thead>
          <tbody>
            {plan.map((r) => {
              const l = lines[r.row - 1] ?? {}
              return (
                <tr key={r.row} className="border-border border-t">
                  {garments ? (
                    <>
                      <td className="px-2 py-1">{String(l.style ?? '')}</td>
                      <td className="px-2 py-1">
                        <span className="font-mono text-teal-400">{r.item?.code}</span> {r.item?.name}
                      </td>
                      <td className="px-2 py-1">{String(l.colour ?? '')}</td>
                      <td className="px-2 py-1 font-semibold">{r.size}</td>
                      {kind === 'SFG' && <td className="px-2 py-1">{r.process}</td>}
                    </>
                  ) : (
                    <>
                      <td className="px-2 py-1">
                        <span className="font-mono text-teal-400">{r.item?.code}</span> {r.item?.name}
                      </td>
                      <td className="px-2 py-1">{String(l.lot || '—')}</td>
                      <td className="px-2 py-1">{String(l.bundle || '—')}</td>
                    </>
                  )}
                  <td className="px-2 py-1">{r.location}</td>
                  <td className="px-2 py-1 text-right tabular-nums">
                    {num(r.qty ?? 0)} {r.unit}
                  </td>
                  <td className="px-2 py-1 text-right tabular-nums">{money(r.rate ?? 0)}</td>
                  <td className="text-foreground px-2 py-1 text-right font-semibold tabular-nums">{money(r.value ?? 0)}</td>
                  {!garments && <td className="text-muted-foreground px-2 py-1">{r.packing ?? '—'}</td>}
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </section>
  )
}

function Banner({ tone, children }: { tone: 'bad' | 'warn' | 'info'; children: ReactNode }) {
  return (
    <div
      className={cn(
        'flex items-center gap-2 rounded-lg border px-3 py-2 text-sm',
        tone === 'bad' && 'border-red-500/30 bg-red-500/10 text-red-400',
        tone === 'warn' && 'border-amber-500/30 bg-amber-500/10 text-amber-600',
        tone === 'info' && 'border-primary/30 bg-primary/10 text-foreground',
      )}
      role={tone === 'bad' ? 'alert' : 'status'}
    >
      <AlertCircle size={15} className="shrink-0" /> <span>{children}</span>
    </div>
  )
}
