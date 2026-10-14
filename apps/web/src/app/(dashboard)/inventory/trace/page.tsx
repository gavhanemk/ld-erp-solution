'use client'

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { AlertCircle, ArrowLeft, ClipboardList, Factory, History, Loader2, Palette, ScanLine, Shirt, User } from 'lucide-react'
import { api, ApiError } from '@/lib/api'
import { Scanner } from '@/components/packages/Scanner'
import { looksLikeGarment } from '@/components/packages/GarmentCard'
import { GarmentTrace, type GarmentStory } from '@/components/trace/GarmentTrace'
import { OrderTrace, type OrderStory } from '@/components/trace/OrderTrace'
import { CustomerTrace, StyleTrace, type CustomerStory, type StyleStory } from '@/components/trace/PartyTrace'
import { hitTarget, type Hit, type Target } from '@/components/trace/traceTypes'

const KINDS = ['g', 'so', 'mo', 'c', 's'] as const

const HIT: Record<Hit['kind'], { label: string; icon: React.ElementType }> = {
  GARMENT: { label: 'Garment', icon: Shirt },
  SO: { label: 'Order', icon: ClipboardList },
  MO: { label: 'Manufacturing order', icon: Factory },
  CUSTOMER: { label: 'Customer', icon: User },
  STYLE: { label: 'Style', icon: Palette },
}

type Loaded =
  | { kind: 'g'; body: GarmentStory }
  | { kind: 'so' | 'mo'; body: OrderStory }
  | { kind: 'c'; body: CustomerStory }
  | { kind: 's'; body: StyleStory }

interface Recent {
  target: Target
  title: string
  sub: string
}

const urlOf = (t: Target) =>
  t.kind === 'g'
    ? `/trace/garment/${encodeURIComponent(t.id)}`
    : t.kind === 'so'
      ? `/trace/order/SO/${t.id}`
      : t.kind === 'mo'
        ? `/trace/order/MO/${t.id}`
        : t.kind === 'c'
          ? `/trace/customer/${t.id}`
          : `/trace/style/${t.id}`

/** What a lookup is called in the recent list. */
function summary(l: Loaded): { title: string; sub: string } {
  switch (l.kind) {
    case 'g':
      return { title: l.body.code, sub: `${l.body.description} · size ${l.body.size || '—'}` }
    case 'so':
    case 'mo':
      return {
        title: l.kind === 'so' ? (l.body.so?.soNumber ?? '') : (l.body.mos[0]?.moNumber ?? ''),
        sub: l.body.so?.customer.name ?? 'For stock',
      }
    case 'c':
      return { title: l.body.customer.name, sub: `${l.body.figures.orders} orders` }
    case 's':
      return { title: l.body.style.code, sub: l.body.style.name }
  }
}

/**
 * Track & trace: scan a garment's tag, or look up an order, a style or a
 * customer, and see the whole story in one place — where it is now and
 * everything that happened on the way, dated, timed and signed. Customers
 * open to their orders, orders to their pieces, pieces to their history.
 */
function TraceScreen() {
  const params = useSearchParams()
  const router = useRouter()
  const target = useMemo<Target | null>(() => {
    for (const k of KINDS) {
      const v = params.get(k)
      if (v) return { kind: k, id: v }
    }
    return null
  }, [params])

  const [typed, setTyped] = useState('')
  const [hits, setHits] = useState<Hit[] | null>(null)
  const [results, setResults] = useState<{ q: string; hits: Hit[] } | null>(null)
  const [searching, setSearching] = useState(false)
  const [loaded, setLoaded] = useState<Loaded | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [recent, setRecent] = useState<Recent[]>([])
  const boxRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    try {
      setRecent(JSON.parse(localStorage.getItem('trace-recent') ?? '[]'))
    } catch {
      /* none remembered */
    }
  }, [])

  const open = useCallback(
    (t: Target) => {
      setHits(null)
      setResults(null)
      setTyped('')
      router.push(`/inventory/trace?${t.kind}=${encodeURIComponent(t.id)}`)
    },
    [router],
  )

  // Suggestions as it is typed.
  useEffect(() => {
    const q = typed.trim()
    if (q.length < 2) {
      setHits(null)
      return
    }
    const t = setTimeout(async () => {
      setSearching(true)
      try {
        const r = await api.get<{ data: Hit[] }>(`/trace/search?q=${encodeURIComponent(q)}`)
        setHits(r.data)
      } catch {
        setHits([])
      } finally {
        setSearching(false)
      }
    }, 250)
    return () => clearTimeout(t)
  }, [typed])

  // A click anywhere else closes the suggestions.
  useEffect(() => {
    const close = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setHits(null)
    }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [])

  // Scanned, or typed and Enter: a tag opens at once; anything else opens if it means one thing.
  const onCode = async (raw: string) => {
    const q = raw.trim()
    setHits(null)
    if (looksLikeGarment(q)) return open({ kind: 'g', id: q })
    setSearching(true)
    try {
      const r = await api.get<{ data: Hit[] }>(`/trace/search?q=${encodeURIComponent(q)}`)
      if (r.data.length === 1) open(hitTarget(r.data[0]))
      else setResults({ q, hits: r.data })
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not search.')
    } finally {
      setSearching(false)
    }
  }

  // What is open: loaded whenever the address changes, so Back works.
  useEffect(() => {
    if (!target) {
      setLoaded(null)
      setError(null)
      return
    }
    let live = true
    setLoading(true)
    setError(null)
    api
      .get<{ data: unknown }>(urlOf(target))
      .then((r) => {
        if (!live) return
        const l = { kind: target.kind, body: r.data } as Loaded
        setLoaded(l)
        const s = summary(l)
        setRecent((prev) => {
          const next = [{ target, title: s.title, sub: s.sub }, ...prev.filter((p) => !(p.target.kind === target.kind && p.target.id === target.id) && p.title !== s.title)].slice(0, 8)
          try {
            localStorage.setItem('trace-recent', JSON.stringify(next))
          } catch {
            /* fine without it */
          }
          return next
        })
      })
      .catch((err) => {
        if (!live) return
        setLoaded(null)
        setError(err instanceof ApiError ? err.message : 'Could not open it. Is the API running?')
      })
      .finally(() => live && setLoading(false))
    return () => {
      live = false
    }
  }, [target])

  const hitList = (list: Hit[], onPick: (h: Hit) => void) =>
    list.map((h, i) => {
      const k = HIT[h.kind]
      return (
        <button
          key={`${h.kind}-${h.id}-${h.title}-${i}`}
          type="button"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => onPick(h)}
          className="flex w-full items-center gap-3 px-3 py-2 text-left hover:bg-secondary"
        >
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
            <k.icon size={15} />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm font-semibold text-foreground">{h.title}</span>
            <span className="block truncate text-xs text-muted-foreground">{h.sub}</span>
          </span>
          <span className="shrink-0 text-[11px] text-muted-foreground">{k.label}</span>
        </button>
      )
    })

  return (
    <div className="space-y-5">
      <div className="page-header gap-3">
        <div className="min-w-0">
          <h1 className="page-title text-xl sm:text-2xl">Track &amp; Trace</h1>
          <p className="page-subtitle hidden sm:block">Scan a garment&apos;s tag, or look up an order, style or customer — its whole story in one place</p>
        </div>
        {target && (
          <button type="button" className="btn-secondary shrink-0" onClick={() => router.back()}>
            <ArrowLeft size={15} /> Back
          </button>
        )}
      </div>

      <div ref={boxRef}>
        {/* A fresh box for each thing opened: what was typed to find it goes. */}
        <Scanner
          key={target ? `${target.kind}:${target.id}` : 'none'}
          onCode={(c) => void onCode(c)}
          busy={false}
          autoFocus={!target}
          placeholder="Scan a tag, or type a code, order, PO, challan, customer or style"
          onType={(t) => {
            setTyped(t)
            setResults(null)
          }}
          suggestions={
            hits && typed.trim().length >= 2 ? (
              <div className="glass-card absolute left-0 right-0 top-full z-30 mt-1 max-h-96 overflow-y-auto p-1 shadow-xl sm:right-[12.5rem]">
                {hits.length ? hitList(hits, (h) => open(hitTarget(h))) : <p className="px-3 py-3 text-sm text-muted-foreground">{searching ? 'Looking…' : 'Nothing matches that.'}</p>}
              </div>
            ) : null
          }
        />
      </div>

      {results && (
        <div className="glass-card overflow-hidden p-0">
          <p className="border-b border-border px-4 py-2 text-sm text-muted-foreground">
            {results.hits.length ? `${results.hits.length} matches for “${results.q}” — pick one` : `Nothing matches “${results.q}”. Try a tag number, an order or PO number, a customer or a style.`}
          </p>
          {results.hits.length > 0 && <div className="p-1">{hitList(results.hits, (h) => open(hitTarget(h)))}</div>}
        </div>
      )}

      {error && (
        <div className="flex items-start gap-3 rounded-lg border border-destructive/40 bg-destructive/5 p-3">
          <AlertCircle size={16} className="mt-0.5 shrink-0 text-destructive" />
          <p className="text-sm text-destructive">{error}</p>
        </div>
      )}

      {target && loading && (
        <div className="flex items-center gap-2 py-10 text-sm text-muted-foreground">
          <Loader2 size={16} className="animate-spin" /> Putting its story together…
        </div>
      )}

      {target && !loading && loaded && loaded.kind === target.kind && (
        <>
          {loaded.kind === 'g' && <GarmentTrace g={loaded.body} open={open} />}
          {(loaded.kind === 'so' || loaded.kind === 'mo') && <OrderTrace o={loaded.body} open={open} />}
          {loaded.kind === 'c' && <CustomerTrace c={loaded.body} open={open} />}
          {loaded.kind === 's' && <StyleTrace s={loaded.body} open={open} />}
        </>
      )}

      {!target && !results && (
        <div className="space-y-5">
          <div className="grid gap-3 sm:grid-cols-3">
            {[
              { icon: ScanLine, title: 'Scan a tag', text: 'Every garment’s own code — G-00000001 — from its QR or barcode. See where that piece is and everything it went through, from cutting to the customer.' },
              { icon: ClipboardList, title: 'Look up an order', text: 'Our order or MO number, the buyer’s PO, a challan or a finished-goods receipt. See every step’s progress, every piece, and every date.' },
              { icon: User, title: 'A customer or a style', text: 'All their orders and how far each has got, or every order a style was made on and where its pieces are.' },
            ].map((t) => (
              <div key={t.title} className="glass-card p-4">
                <t.icon size={20} className="text-primary" />
                <h3 className="mt-2 font-semibold text-foreground">{t.title}</h3>
                <p className="mt-1 text-sm text-muted-foreground">{t.text}</p>
              </div>
            ))}
          </div>
          {recent.length > 0 && (
            <div className="glass-card overflow-hidden p-0">
              <div className="flex items-center gap-2 border-b border-border px-4 py-3">
                <History size={16} className="text-primary" />
                <h3 className="text-sm font-semibold text-foreground">Looked up lately</h3>
              </div>
              <div className="grid gap-1 p-1 sm:grid-cols-2">
                {recent.map((r) => {
                  const k = HIT[r.target.kind === 'g' ? 'GARMENT' : r.target.kind === 'so' ? 'SO' : r.target.kind === 'mo' ? 'MO' : r.target.kind === 'c' ? 'CUSTOMER' : 'STYLE']
                  return (
                    <button key={`${r.target.kind}-${r.target.id}`} type="button" onClick={() => open(r.target)} className="flex items-center gap-3 rounded-lg px-3 py-2 text-left hover:bg-secondary">
                      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
                        <k.icon size={15} />
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-semibold text-foreground">{r.title}</span>
                        <span className="block truncate text-xs text-muted-foreground">{r.sub}</span>
                      </span>
                    </button>
                  )
                })}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

export default function TracePage() {
  return (
    <Suspense fallback={null}>
      <TraceScreen />
    </Suspense>
  )
}
