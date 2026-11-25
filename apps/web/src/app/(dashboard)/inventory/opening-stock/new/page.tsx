'use client'

import { Suspense, useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { useRouter, useSearchParams } from 'next/navigation'
import { AlertCircle, ArrowLeft, ArrowRight, CheckCircle2, ClipboardList, FileSpreadsheet, Loader2, Printer, RotateCcw } from 'lucide-react'
import { api, ApiError, can } from '@/lib/api'
import { cn, newRequestId } from '@/lib/utils'
import { SmartSelect } from '@/components/ui/SmartSelect'
import { KINDS, kindOf, money, num, STATUSES, todayInIndia, cellKey, styleRows, type FormOptions, type Kind } from '@/components/inventory/opening/kinds'
import { FinishedGoods, RawMaterials, SemiFinished, type Garment, type Material } from '@/components/inventory/opening/Workspaces'
import { packInputOf } from '@/components/packages/PackagingEditor'
import { Banner, ChoiceCard, DoneCard, Field, PageHead, Panel, StatTile, Stats } from '@/components/inventory/opening/Frame'
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
type EntryLine = Record<string, string | number | ReturnType<typeof packInputOf>>
interface Saved {
  id: string
  number: string
  lines: number
  stickers: number
  /** Packages keeping a lot's own barcode: nothing to print for them. */
  kept?: number
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

const STEPS = ['What you are entering', 'Enter the stock', 'Review', 'Saved']
/** What each step of the entry is for, in a line under the title. */
const STEP_LINE = [
  'Enter the stock you had on the day, one kind at a time. Pick what you are entering.',
  'Everything here is kept on this computer until you save it or throw it away.',
  'Checked by the same rules as an Excel import. Nothing is saved until every line is right.',
  'In stock now, by item, size and place.',
]

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
  // When the entry was last kept on this computer, for the bar at the bottom.
  const [keptAt, setKeptAt] = useState<number | null>(null)
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
    setKeptAt(kept?.savedAt || null)
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
        // Everything removed: nothing is kept, so nothing comes back as an unsaved entry.
        if (draft.garments.length || draft.materials.length) {
          localStorage.setItem(DRAFT(draft.kind), JSON.stringify({ ...draft, savedAt: Date.now() }))
          setKeptAt(Date.now())
        } else {
          localStorage.removeItem(DRAFT(draft.kind))
          setKeptAt(null)
        }
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
      for (const c of styleRows(st)) {
        if (!c.item) continue
        for (const s of st.sizes) {
          const q = Number(g.qty[cellKey(c.key, s.id)] || 0)
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
          refs.push({ key: g.key, label: `${st.code} ${c.colour || c.item.code} ${s.code}${process ? ` at ${process.name}` : ''}`, style: st.code, colour: c.colour })
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
          ...(it.tracked && l.pack ? { pack: packInputOf(l.pack, q, it.unit ?? '', it.decimals) } : {}),
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
    <div className="space-y-5" style={{ ['--field' as string]: 'var(--card)' }}>
      <PageHead title={`Add Opening Stock${k ? ` — ${k.label}` : ''}`} subtitle={STEP_LINE[stepIndex]} steps={STEPS} current={stepIndex} />

      {!mayAdd && <Banner tone="warn">Adding opening stock needs Inventory → create. Ask an administrator for it.</Banner>}
      {error && <Banner tone="bad">{error}</Banner>}

      {/* 1. What is being entered. */}
      {!kind && (
        <div className="space-y-4">
          <div className="grid gap-4 lg:grid-cols-3">
            {KINDS.map((t) => {
              const waiting = typeof window !== 'undefined' ? readDraft(t.key) : null
              return (
                <ChoiceCard
                  key={t.key}
                  icon={t.icon}
                  label={t.label}
                  short={t.short}
                  text={t.text}
                  cta={`Enter ${t.label}`}
                  ariaLabel={`Enter ${t.label}`}
                  onClick={() => router.push(`/inventory/opening-stock/new?type=${t.key}`)}
                >
                  <ol className="flex flex-wrap items-center gap-1 text-[11px]" aria-label="What you choose, in order">
                    {t.steps.map((s, i) => (
                      <li key={s} className="flex items-center gap-1">
                        <span className="border-border text-foreground rounded-md border px-1.5 py-0.5">{s}</span>
                        {i < t.steps.length - 1 && <ArrowRight size={11} className="text-muted-foreground" />}
                      </li>
                    ))}
                  </ol>
                  {waiting && <span className="badge-warning w-fit">An unsaved entry is waiting</span>}
                </ChoiceCard>
              )
            })}
          </div>
          <p className="text-muted-foreground flex items-center gap-1.5 text-sm">
            <FileSpreadsheet size={14} /> A lot to enter?{' '}
            <Link href="/inventory/opening-stock/import" className="text-primary font-medium hover:underline">
              Import it from Excel instead
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
          {restored && step === 'enter' && (draft.garments.length > 0 || draft.materials.length > 0) && (
            <Banner
              tone="info"
              action={
                <button type="button" className="text-primary text-sm font-semibold hover:underline" onClick={startAgain}>
                  Start fresh instead
                </button>
              }
            >
              Your unsaved {k?.label.toLowerCase()} entry is back, as you left it.
            </Banner>
          )}

          {step === 'review' && plan && (
            <ReviewPanel kind={kind} plan={plan} lines={built.lines} bad={bad} problems={problems} value={built.value} pieces={built.pieces} />
          )}

          <fieldset disabled={step === 'review' || busy} className={cn('space-y-3', step === 'review' && 'opacity-60')}>
            {/* Where and when, for the whole entry. */}
            <Panel icon={ClipboardList} title="Stock details" description="These apply to every line of this entry." label="Where and when">
              <div className={cn('grid gap-4 sm:grid-cols-2', kind === 'SFG' ? 'lg:grid-cols-3' : kind === 'FG' ? 'lg:grid-cols-5' : 'lg:grid-cols-4')}>
                <Field label="Opening date" required hint="The day the stock was counted.">
                  <input type="date" className="form-input h-10" value={draft.date} max={todayInIndia()} onChange={(e) => set({ date: e.target.value })} aria-label="Opening date" />
                </Field>
                {kind !== 'SFG' && (
                  <Field label={kind === 'FG' ? 'Finished goods store' : 'Store'} required hint="Where the stock is kept.">
                    <SmartSelect className="form-input h-10" value={draft.storeId} onChange={(e) => set({ storeId: e.target.value })} aria-label="Store">
                      <option value="">Pick the store…</option>
                      {options.stores.map((s) => (
                        <option key={s.id} value={s.id}>
                          {s.name}
                        </option>
                      ))}
                    </SmartSelect>
                  </Field>
                )}
                <Field label="Stock status" hint="OK is ready to use; Hold keeps it back.">
                  <SmartSelect className="form-input h-10" value={draft.status} onChange={(e) => set({ status: e.target.value })} aria-label="Stock status">
                    {STATUSES.filter((s) => kind !== 'RM' || s.value !== 'B-Grade').map((s) => (
                      <option key={s.value} value={s.value}>
                        {s.label}
                      </option>
                    ))}
                  </SmartSelect>
                </Field>
                {kind === 'FG' && (
                  <Field label="Order No." hint="Optional: the order these pieces are for.">
                    <input className="form-input h-10" value={draft.orderNo} onChange={(e) => set({ orderNo: e.target.value })} placeholder="Optional" aria-label="Order No." />
                  </Field>
                )}
                <Field label="Remarks" hint="Optional.">
                  <input className="form-input h-10" value={draft.notes} onChange={(e) => set({ notes: e.target.value })} placeholder="Who counted it, anything to remember" aria-label="Remarks" />
                </Field>
              </div>
            </Panel>

            {(() => {
              const shared = {
                options,
                problems,
                mayMakeItems: can('masters', 'create'),
                maySetSizeRun: can('masters', 'edit'),
                onReload: loadOptions,
                onColourMade: (styleId: string, colour: string, item: { id: string; code: string; name?: string }) =>
                  setOptions(
                    (o) =>
                      o && {
                        ...o,
                        styles: o.styles.map((s) =>
                          s.id === styleId
                            ? {
                                ...s,
                                colours: s.colours.map((c) => (c.colour === colour ? { ...c, item } : c)),
                                // And it is one of the style's items now, to pick by code or name.
                                items: (s.items ?? []).some((i) => i.id === item.id)
                                  ? s.items
                                  : [...(s.items ?? []), { id: item.id, code: item.code, name: item.name ?? '', description: null, colour }],
                              }
                            : s,
                        ),
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
              {/* Whether the entry is kept, and what it comes to so far. */}
              <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
                <p className="text-muted-foreground flex items-center gap-1.5 text-xs">
                  <span className={cn('h-2 w-2 rounded-full', keptAt ? 'bg-emerald-500' : 'bg-muted-foreground/40')} aria-hidden />
                  {keptAt ? `Draft kept on this computer · ${new Date(keptAt).toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' })}` : built.lines.length ? 'Draft not kept yet' : 'Nothing entered yet'}
                </p>
                {built.lines.length > 0 && (
                  <dl className="flex items-center gap-5 text-sm" aria-label="Entry summary">
                    <Stat label={kind === 'RM' ? 'Materials' : 'Styles'} value={String(kind === 'RM' ? draft.materials.length : draft.garments.length)} />
                    <Stat label="Lines" value={String(built.lines.length)} />
                    {kind !== 'RM' && <Stat label="Pieces" value={num(built.pieces)} />}
                    <Stat label="Stock value" value={money(built.value)} />
                  </dl>
                )}
              </div>
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
                      <>
                        {built.lines.length > 0 && (
                          <button type="button" className="btn-ghost text-muted-foreground h-9 text-sm" onClick={() => setThrowing(true)}>
                            Throw away
                          </button>
                        )}
                        <button type="button" className="btn-secondary h-9 text-sm" onClick={() => router.push('/inventory/opening-stock/new')} title="Back to what you are entering; this entry is kept">
                          <ArrowLeft size={15} /> Back
                        </button>
                      </>
                    )}
                    <button type="button" className="btn-primary h-9" disabled={busy || !mayAdd} onClick={() => void review()}>
                      {busy ? <Loader2 size={15} className="animate-spin" /> : null} Review stock <ArrowRight size={15} />
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
        <DoneCard
          title={
            <>
              {saved.again ? 'Already saved' : 'Saved'} as <span className="font-mono text-teal-400">{saved.number}</span>
            </>
          }
          message={
            <>
              {saved.message}{' '}
              <span className="text-foreground">
                {saved.lines} {saved.lines === 1 ? 'line' : 'lines'} of {k?.label.toLowerCase()} · {money(saved.value)} — in stock now, by item, size and place.
                {(saved.kept ?? 0) > 0 && ` ${saved.kept} ${saved.kept === 1 ? 'package keeps its' : 'packages keep their'} own barcode: nothing to print for ${saved.kept === 1 ? 'it' : 'them'}.`}
              </span>
            </>
          }
          stats={
            <Stats label="Saved">
              <StatTile label="Lines" value={num(saved.lines)} />
              <StatTile label="Stock value" value={money(saved.value)} />
              <StatTile label="Stickers to print" value={num(saved.stickers)} />
              <StatTile label="Kind" value={<span className="text-base">{k?.label}</span>} />
            </Stats>
          }
          actions={
            <>
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
            </>
          }
        >
          {printing && <StickersReady source={{ type: 'OPENING', id: saved.id }} onClose={() => setPrinting(false)} />}
        </DoneCard>
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
      <section className="glass-card overflow-hidden border-red-500/40" aria-label="Review">
        <div className="flex items-start gap-3 border-b border-red-500/30 bg-red-500/10 px-5 py-3.5">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-red-500/15 text-red-400">
            <AlertCircle size={18} />
          </span>
          <div>
            <h2 className="text-sm font-semibold text-red-400">
              {bad} {bad === 1 ? 'line' : 'lines'} of {plan.length} {bad === 1 ? 'needs' : 'need'} putting right. Nothing is saved until every line is right.
            </h2>
            <p className="text-muted-foreground mt-0.5 text-xs">Go back to the entry: each line in trouble is marked in red there.</p>
          </div>
        </div>
        <ul className="space-y-1 px-5 py-4 text-xs text-red-400">
          {[...problems.values()].flat().map((p) => (
            <li key={p} className="border-l-2 border-red-500/60 pl-2.5">
              {p}
            </li>
          ))}
        </ul>
      </section>
    )
  }
  const garments = kind !== 'RM'
  const stickers = plan.reduce((t, r) => t + (r.stickers ?? 0), 0)
  const places = [...new Set(plan.map((r) => r.location))]
  return (
    <Panel
      icon={CheckCircle2}
      title={
        <span className="text-emerald-500">
          All {plan.length} {plan.length === 1 ? 'line is' : 'lines are'} right. Check them, then confirm.
        </span>
      }
      description={
        <>
          {places.map((l, i) => (
            <span key={l}>
              {i > 0 && ', '}into {l}
              {plan.some((r) => r.location === l && r.newFloor) ? ' (made on save)' : ''}
            </span>
          ))}
          {!garments && stickers > 0 && ` · ${stickers} stickers to print`}
        </>
      }
      label="Review"
      bodyClassName="space-y-4"
    >
      <Stats label="Review figures">
        <StatTile label="Lines" value={num(plan.length)} tone="good" />
        <StatTile label={garments ? 'Pieces' : 'Places'} value={garments ? num(pieces) : num(places.length)} />
        <StatTile label="Stock value" value={money(value)} />
        <StatTile label="Stickers to print" value={garments ? '—' : num(stickers)} />
      </Stats>
      <div className="border-border max-h-80 overflow-auto rounded-lg border">
        <table className="w-full text-xs">
          <thead>
            <tr className="text-muted-foreground text-left text-[10px] font-semibold uppercase tracking-wide">
              {garments ? (
                <>
                  <th className="px-3 py-2">Style</th>
                  <th className="px-3 py-2">Item</th>
                  <th className="px-3 py-2">Colour</th>
                  <th className="px-3 py-2">Size</th>
                  {kind === 'SFG' && <th className="px-3 py-2">Process</th>}
                </>
              ) : (
                <>
                  <th className="px-3 py-2">Item</th>
                  <th className="px-3 py-2">Lot / Roll</th>
                  <th className="px-3 py-2">Bundle</th>
                </>
              )}
              <th className="px-3 py-2">Location</th>
              <th className="px-3 py-2 text-right">Qty</th>
              <th className="px-3 py-2 text-right">Rate</th>
              <th className="px-3 py-2 text-right">Value</th>
              {!garments && <th className="px-3 py-2">Stickers</th>}
            </tr>
          </thead>
          <tbody>
            {plan.map((r) => {
              const l = lines[r.row - 1] ?? {}
              return (
                <tr key={r.row} className="border-border border-b last:border-b-0">
                  {garments ? (
                    <>
                      <td className="px-3 py-1.5">{String(l.style ?? '')}</td>
                      <td className="px-3 py-1.5">
                        <span className="font-mono text-teal-400">{r.item?.code}</span> {r.item?.name}
                      </td>
                      <td className="px-3 py-1.5">{String(l.colour ?? '')}</td>
                      <td className="text-foreground px-3 py-1.5 font-semibold">{r.size}</td>
                      {kind === 'SFG' && <td className="px-3 py-1.5">{r.process}</td>}
                    </>
                  ) : (
                    <>
                      <td className="px-3 py-1.5">
                        <span className="font-mono text-teal-400">{r.item?.code}</span> {r.item?.name}
                      </td>
                      <td className="px-3 py-1.5">{String(l.lot || '—')}</td>
                      <td className="px-3 py-1.5">{String(l.bundle || '—')}</td>
                    </>
                  )}
                  <td className="px-3 py-1.5">{r.location}</td>
                  <td className="px-3 py-1.5 text-right tabular-nums">
                    {num(r.qty ?? 0)} {r.unit}
                  </td>
                  <td className="px-3 py-1.5 text-right tabular-nums">{money(r.rate ?? 0)}</td>
                  <td className="text-foreground px-3 py-1.5 text-right font-semibold tabular-nums">{money(r.value ?? 0)}</td>
                  {!garments && <td className="text-muted-foreground px-3 py-1.5">{r.packing ?? '—'}</td>}
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </Panel>
  )
}

/** One figure of the summary in the bar at the bottom. */
function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="leading-tight">
      <dt className="text-muted-foreground text-[10px] font-semibold uppercase tracking-wide">{label}</dt>
      <dd className="text-foreground font-semibold tabular-nums">{value}</dd>
    </div>
  )
}
