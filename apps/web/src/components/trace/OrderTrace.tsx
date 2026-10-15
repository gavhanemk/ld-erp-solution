'use client'

import { useEffect, useState } from 'react'
import { Boxes, ChevronRight, ClipboardList, Factory, Layers } from 'lucide-react'
import { Timeline } from './Timeline'
import { Fact, Go, MaterialsUsed, PiecesBySize, PiecesList, Section } from './TraceBits'
import { MO_STATUS, SO_STATUS, badge, fmtDay, qty, type MaterialLine, type Pieces, type Step, type Target } from './traceTypes'

/** One item of the order — a style in one colour — and how far it has got. */
export interface OrderItem {
  key: string
  moId: string
  moNumber: string
  styleId: string
  style: string
  name: string
  color: string
  description: string | null
  ordered: number
  cut: number
  intoFg: number
  tagged: number
  inStore: number
  despatched: number
  scrapped: number
  /** Where its pieces are on the floor now. */
  nowAt: Array<{ step: string; qty: number; outside: boolean }>
  sizes: Array<{ code: string; ordered: number; cut: number; intoFg: number; inStore: number; despatched: number }>
}

export interface OrderStory {
  kind: 'SO' | 'MO'
  so: { id: string; soNumber: string; status: string; orderDate: string; deliveryDate: string | null; poRef: string | null; customer: { id: string; name: string; billingCity: string | null } } | null
  mos: Array<{ id: string; moNumber: string; status: string; planned: number; cut: number; packed: number; styles: Array<{ styleId: string; style: string; name: string; color: string; qty: number }> }>
  figures: { ordered: number; cut: number; intoFg: number; tagged: number; inStore: number; despatched: number; scrapped: number; delivered: number | null }
  stages: Array<{
    moId: string
    moNumber: string
    planned: number
    steps: Array<{ name: string; kind: string; check: boolean; state: string; received: number; completed: number; inHand: number; atVendor: number; rework: number; waiting: number; damaged: number }>
  }>
  items?: OrderItem[]
  pieces: Pieces
  materials: MaterialLine[]
  timeline: Step[]
}

type View = 'order' | 'items'

const pct = (a: number, b: number) => (b > 0 ? Math.min(100, Math.round((a / b) * 100)) : 0)

/**
 * How far something has got, left to right: ordered → cut → finished →
 * in the store → despatched, each with its share of what was ordered. The
 * same line for the whole order and for each item of it.
 */
function Progress({ ordered, cut, intoFg, inStore, despatched, tagged, small = false }: { ordered: number; cut: number; intoFg: number; inStore: number; despatched: number; tagged?: number; small?: boolean }) {
  const steps = [
    { label: 'Ordered', value: ordered, bar: 'bg-sky-500', sub: 'pieces' },
    { label: 'Cut', value: cut, bar: 'bg-orange-500', sub: `${pct(cut, ordered)}% of the order` },
    { label: 'Finished', value: intoFg, bar: 'bg-teal-500', sub: tagged != null && tagged > 0 ? `${pct(intoFg, ordered)}% · ${qty(tagged)} tagged` : `${pct(intoFg, ordered)}% of the order` },
    { label: 'In the store', value: inStore, bar: 'bg-emerald-500', sub: 'ready to send' },
    { label: 'Despatched', value: despatched, bar: 'bg-violet-500', sub: `${pct(despatched, ordered)}% of the order` },
  ]
  return (
    <div className={`grid grid-cols-2 gap-2 sm:grid-cols-5 ${small ? '' : 'sm:gap-3'}`}>
      {steps.map((s, i) => (
        <div key={s.label} className="relative">
          <div className={`h-full rounded-xl border border-border bg-card ${small ? 'px-2.5 py-2' : 'px-3.5 py-3'}`}>
            <div className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{s.label}</div>
            <div className={`font-bold tabular-nums text-foreground ${small ? 'text-lg' : 'text-2xl'}`}>{qty(s.value)}</div>
            <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-secondary">
              <div className={`h-full rounded-full ${s.bar}`} style={{ width: `${i === 0 ? 100 : pct(s.value, ordered)}%` }} />
            </div>
            <div className="mt-1 text-[11px] text-muted-foreground">{s.sub}</div>
          </div>
          {i < steps.length - 1 && (
            <ChevronRight size={16} className="absolute -right-3 top-1/2 z-10 hidden -translate-y-1/2 text-muted-foreground sm:block" aria-hidden />
          )}
        </div>
      ))}
    </div>
  )
}

/** What is still to do, in one line. */
function stillToDo(o: { ordered: number; cut: number; intoFg: number; despatched: number }) {
  const parts = [
    o.ordered - o.cut > 0 ? `${qty(o.ordered - o.cut)} to cut` : null,
    o.cut - o.intoFg > 0 ? `${qty(o.cut - o.intoFg)} on the floor` : null,
    o.ordered - o.despatched > 0 ? `${qty(o.ordered - o.despatched)} to send` : null,
  ].filter(Boolean)
  return parts.length ? `Still: ${parts.join(' · ')}` : 'All done and despatched'
}

/** Each item of the order on its own card: its progress, where it is on the floor, and size by size. */
function ItemsView({ items, open }: { items: OrderItem[]; open: (t: Target) => void }) {
  if (!items.length) {
    return (
      <Section icon={Boxes} title="Item by item">
        <p className="px-4 py-5 text-sm text-muted-foreground">No manufacturing order has been raised yet, so there are no items to follow.</p>
      </Section>
    )
  }
  const sizeRows: Array<{ key: 'ordered' | 'cut' | 'intoFg' | 'inStore' | 'despatched'; label: string }> = [
    { key: 'ordered', label: 'Ordered' },
    { key: 'cut', label: 'Cut' },
    { key: 'intoFg', label: 'Finished' },
    { key: 'inStore', label: 'In the store' },
    { key: 'despatched', label: 'Despatched' },
  ]
  return (
    <div className="space-y-3">
      {items.map((it) => (
        <div key={it.key} className="glass-card overflow-hidden p-0">
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 border-b border-border px-4 py-3">
            <Go to={{ kind: 's', id: it.styleId }} open={open}>
              <span className="text-base font-semibold">{it.style}</span>
            </Go>
            <span className="text-sm font-medium text-foreground">{it.color}</span>
            <span className="text-sm text-muted-foreground">{it.description || it.name}</span>
            <span className="ml-auto flex items-center gap-2 text-xs text-muted-foreground">
              <Go to={{ kind: 'mo', id: it.moId }} open={open} mono>
                {it.moNumber}
              </Go>
              · {qty(it.ordered)} pcs
            </span>
          </div>
          <div className="space-y-3 p-4">
            <Progress ordered={it.ordered} cut={it.cut} intoFg={it.intoFg} inStore={it.inStore} despatched={it.despatched} tagged={it.tagged} small />
            <div className="flex flex-wrap items-center gap-1.5 text-xs">
              <span className="font-semibold uppercase tracking-wide text-muted-foreground">On the floor now</span>
              {it.nowAt.length ? (
                it.nowAt.map((s) => (
                  <span key={s.step} className="rounded-full border border-primary/30 bg-primary/10 px-2 py-0.5 font-medium text-foreground">
                    {s.step} <span className="tabular-nums">{qty(s.qty)}</span>
                    {s.outside ? <span className="text-muted-foreground"> · outside</span> : null}
                  </span>
                ))
              ) : (
                <span className="text-muted-foreground">{it.cut === 0 ? 'Not cut yet' : it.intoFg >= it.cut ? 'Nothing — all through to finished goods' : 'Nothing on a stage'}</span>
              )}
              <span className="ml-auto text-muted-foreground">{stillToDo(it)}</span>
            </div>
            {it.sizes.length > 0 && (
              <div className="overflow-x-auto rounded-lg border border-border">
                <table className="data-table table-compact min-w-full">
                  <thead>
                    <tr className="bg-secondary">
                      <th>Size</th>
                      {it.sizes.map((z) => (
                        <th key={z.code} style={{ textAlign: 'right' }}>
                          {z.code}
                        </th>
                      ))}
                      <th style={{ textAlign: 'right' }}>Total</th>
                    </tr>
                  </thead>
                  <tbody>
                    {sizeRows.map((r) => {
                      const total = it.sizes.reduce((t, z) => t + z[r.key], 0)
                      return (
                        <tr key={r.key}>
                          <td className="whitespace-nowrap font-medium text-foreground">{r.label}</td>
                          {it.sizes.map((z) => (
                            <td key={z.code} className={`text-right tabular-nums ${r.key !== 'ordered' && z[r.key] < z.ordered ? 'text-muted-foreground' : ''}`}>
                              {z[r.key] ? qty(z[r.key]) : <span className="text-muted-foreground">—</span>}
                            </td>
                          ))}
                          <td className="text-right font-semibold tabular-nums">{qty(total)}</td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      ))}
    </div>
  )
}

/**
 * An order, start to finish, seen two ways. The whole order: its totals, the
 * materials bought and issued for it, how far each production step has got,
 * every tagged piece and everything that happened. Or item by item: each
 * style in each colour with its own progress, where it is on the floor now,
 * and size by size.
 */
export function OrderTrace({ o, open }: { o: OrderStory; open: (t: Target) => void }) {
  const f = o.figures
  const items = o.items ?? []
  const late = o.so?.deliveryDate && new Date(o.so.deliveryDate) < new Date() && f.despatched < f.ordered
  const head = o.kind === 'SO' && o.so ? o.so.soNumber : o.mos[0]?.moNumber
  const status = o.kind === 'SO' && o.so ? badge(SO_STATUS, o.so.status) : badge(MO_STATUS, o.mos[0]?.status ?? '')
  const [view, setView] = useState<View>('order')
  // The view last used is the one shown next time, on this computer.
  useEffect(() => {
    try {
      const v = localStorage.getItem('trace-order-view')
      if (v === 'order' || v === 'items') setView(v)
    } catch {
      /* no storage: the whole order first */
    }
  }, [])
  const pick = (v: View) => {
    setView(v)
    try {
      localStorage.setItem('trace-order-view', v)
    } catch {
      /* kept for this visit only */
    }
  }

  return (
    <div className="space-y-4">
      <div className="glass-card p-4 sm:p-5">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-mono text-2xl font-bold tracking-wide text-primary">{head}</span>
          <span className={`badge ${status.cls}`}>{status.label}</span>
          {late && <span className="badge badge-danger">Past its delivery date</span>}
        </div>
        <div className="mt-3 grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-3 lg:grid-cols-6">
          <Fact label="Customer">
            {o.so ? (
              <Go to={{ kind: 'c', id: o.so.customer.id }} open={open}>
                {o.so.customer.name}
              </Go>
            ) : (
              'For stock'
            )}
          </Fact>
          {o.kind === 'MO' && (
            <Fact label="Sales order">
              <Go to={o.so ? { kind: 'so', id: o.so.id } : null} open={open} mono>
                {o.so?.soNumber ?? '—'}
              </Go>
            </Fact>
          )}
          <Fact label="Their PO">{o.so?.poRef ?? '—'}</Fact>
          <Fact label="Ordered on">{fmtDay(o.so?.orderDate)}</Fact>
          <Fact label="Wanted by">{fmtDay(o.so?.deliveryDate)}</Fact>
          <Fact label={o.mos.length === 1 ? 'Manufacturing order' : 'Manufacturing orders'}>
            <div className="flex flex-wrap gap-x-2">
              {o.mos.length
                ? o.mos.map((m) => (
                    <Go key={m.id} to={o.kind === 'MO' ? null : { kind: 'mo', id: m.id }} open={open} mono>
                      {m.moNumber}
                    </Go>
                  ))
                : 'None yet'}
            </div>
          </Fact>
          <Fact label="Items">
            {items.length
              ? `${items.length} ${items.length === 1 ? 'style-colour' : 'style-colours'}, ${qty(items.reduce((t, i) => t + i.ordered, 0))} pcs`
              : `${[...new Set(o.mos.flatMap((m) => m.styles.map((s) => `${s.styleId}|${s.color}`)))].length || '—'}`}
          </Fact>
        </div>
      </div>

      {/* The whole order at a glance, left to right. */}
      <div className="glass-card p-4">
        <div className="mb-3 flex flex-wrap items-baseline gap-2">
          <h3 className="text-sm font-semibold text-foreground">Where the whole order stands</h3>
          <span className="text-xs text-muted-foreground">all items together, in pieces</span>
          <span className="ml-auto text-xs text-muted-foreground">{stillToDo(f)}</span>
        </div>
        <Progress ordered={f.ordered} cut={f.cut} intoFg={f.intoFg} inStore={f.inStore} despatched={f.despatched} tagged={f.tagged} />
      </div>

      {/* Two ways to look at it. */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="inline-flex rounded-lg border border-border bg-secondary p-1" role="tablist" aria-label="How to look at the order">
          {(
            [
              { key: 'order', label: 'Whole order', icon: ClipboardList },
              { key: 'items', label: `Item by item${items.length ? ` (${items.length})` : ''}`, icon: Layers },
            ] as const
          ).map((t) => (
            <button
              key={t.key}
              type="button"
              role="tab"
              aria-selected={view === t.key}
              onClick={() => pick(t.key)}
              className={`flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm ${view === t.key ? 'bg-card font-semibold text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'}`}
            >
              <t.icon size={14} /> {t.label}
            </button>
          ))}
        </div>
        <span className="text-xs text-muted-foreground">
          {view === 'order'
            ? 'Totals for the order: materials, production stages, every piece and its history.'
            : 'Each style in each colour on its own: its progress, where it is on the floor, and size by size.'}
        </span>
      </div>

      {view === 'items' ? (
        <ItemsView items={items} open={open} />
      ) : (
        <>
          <MaterialsUsed lines={o.materials} note="for the whole order" />

          {o.stages.map((s) =>
            s.steps.length ? (
              <Section key={s.moId} icon={Factory} title={`Production stages · ${s.moNumber}`} note={`${qty(s.planned)} pieces planned`}>
                <div className="overflow-x-auto">
                  <table className="data-table table-compact min-w-full">
                    <thead>
                      <tr className="bg-secondary">
                        <th>Stage</th>
                        <th style={{ minWidth: 220 }}>Done</th>
                        <th style={{ textAlign: 'right' }}>In hand</th>
                        <th style={{ textAlign: 'right' }}>At an outside unit</th>
                        <th style={{ textAlign: 'right' }}>Rework</th>
                        <th style={{ textAlign: 'right' }}>Waiting to move</th>
                        <th style={{ textAlign: 'right' }}>Damaged / rejected</th>
                      </tr>
                    </thead>
                    <tbody>
                      {s.steps.map((st, i) => {
                        const p = pct(st.completed, s.planned)
                        return (
                          <tr key={i}>
                            <td className="whitespace-nowrap">
                              <span className="font-medium text-foreground">{st.name}</span>
                              {st.check && <span className="ml-1.5 text-xs text-emerald-600">check</span>}
                            </td>
                            <td>
                              <div className="flex items-center gap-2">
                                <div className="h-2 flex-1 overflow-hidden rounded-full bg-secondary">
                                  <div className={`h-full rounded-full ${st.state === 'DONE' ? 'bg-emerald-500' : st.completed ? 'bg-primary' : 'bg-transparent'}`} style={{ width: `${p}%` }} />
                                </div>
                                <span className="w-24 shrink-0 text-right text-xs tabular-nums text-muted-foreground">
                                  {qty(st.completed)} / {qty(s.planned)}
                                </span>
                              </div>
                            </td>
                            {[st.inHand, st.atVendor, st.rework, st.waiting, st.damaged].map((v, k) => (
                              <td key={k} className="text-right tabular-nums">
                                {v ? qty(v) : <span className="text-muted-foreground">—</span>}
                              </td>
                            ))}
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>
              </Section>
            ) : null,
          )}

          <PiecesBySize pieces={o.pieces} />
          <PiecesList pieces={o.pieces} open={open} printQuery={o.kind === 'SO' && o.so ? `trace=1&soId=${o.so.id}` : o.mos[0] ? `trace=1&moId=${o.mos[0].id}` : undefined} />
          <Timeline steps={o.timeline} />
        </>
      )}
    </div>
  )
}
