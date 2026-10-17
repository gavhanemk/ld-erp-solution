'use client'

import { useEffect, useMemo, useState } from 'react'
import { ChevronLeft, ChevronRight, Filter, Loader2, Printer, X } from 'lucide-react'
import { api } from '@/lib/api'
import { SmartSelect } from '@/components/ui/SmartSelect'
import { LabelCell } from './TraceBits'
import { GARMENT_STATUS, badge, fmtDay, printLabels, qty, useAfterPrint, type Target } from './traceTypes'

/** The filters, as the address keeps them: so Back comes back to the same list. */
export const FILTER_KEYS = ['fc', 'fo', 'fm', 'fs', 'col', 'sz', 'st', 'from', 'to'] as const
export type FilterKey = (typeof FILTER_KEYS)[number]
export type Filters = Record<FilterKey, string>

export interface FilterOptions {
  customers: Array<{ id: string; name: string }>
  sos: Array<{ id: string; soNumber: string; poRef: string | null; customerId: string; customer: string }>
  mos: Array<{ id: string; moNumber: string; soId: string | null; customerId: string | null; styleIds: string[] }>
  styles: Array<{ id: string; code: string; name: string }>
  colors: string[]
  sizes: Array<{ id: string; code: string }>
}

const STATES = ['IN_STOCK', 'PACKED', 'DISPATCHED', 'SCRAPPED', 'VOID'] as const

/**
 * Narrowing down to the pieces wanted: customer, order, MO, style, colour,
 * size, where they are and when they went into finished goods. Each list only
 * offers what the others leave possible — a customer's own orders, an order's
 * own MOs. Customers, orders, MOs and styles include those with no tagged
 * pieces yet; the page offers their whole story instead.
 */
export function FilterBar({ options, f, set, clear }: { options: FilterOptions | null; f: Filters; set: (patch: Partial<Filters>) => void; clear: () => void }) {
  const o = options
  const sos = o ? o.sos.filter((s) => !f.fc || s.customerId === f.fc) : []
  const mos = o ? o.mos.filter((m) => (!f.fc || m.customerId === f.fc) && (!f.fo || m.soId === f.fo) && (!f.fs || m.styleIds.includes(f.fs))) : []
  const mo = o?.mos.find((m) => m.id === f.fm)
  const styles = o ? o.styles.filter((s) => !mo || mo.styleIds.includes(s.id)) : []
  const any = FILTER_KEYS.some((k) => f[k])
  const cls = 'form-input h-9 px-2 py-0 text-sm'
  return (
    <div className="glass-card flex flex-wrap items-center gap-2 p-2">
      <span className="text-muted-foreground flex items-center gap-1.5 px-1 text-xs font-semibold uppercase tracking-wide">
        <Filter size={13} /> Filters
      </span>
      <div className="w-44">
        <SmartSelect className={cls} value={f.fc} onChange={(e) => set({ fc: e.target.value, fo: '', fm: '' })} aria-label="Customer">
          <option value="">All customers</option>
          {o?.customers.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </SmartSelect>
      </div>
      <div className="w-44">
        <SmartSelect className={cls} value={f.fo} onChange={(e) => set({ fo: e.target.value, fm: '' })} aria-label="Sales order">
          <option value="">All orders</option>
          {sos.map((s) => (
            <option key={s.id} value={s.id} data-sub={[s.customer, s.poRef ? `PO ${s.poRef}` : null].filter(Boolean).join(' · ')}>
              {s.soNumber}
            </option>
          ))}
        </SmartSelect>
      </div>
      <div className="w-40">
        <SmartSelect className={cls} value={f.fm} onChange={(e) => set({ fm: e.target.value })} aria-label="Manufacturing order">
          <option value="">All MOs</option>
          {mos.map((m) => (
            <option key={m.id} value={m.id}>
              {m.moNumber}
            </option>
          ))}
        </SmartSelect>
      </div>
      <div className="w-40">
        <SmartSelect className={cls} value={f.fs} onChange={(e) => set({ fs: e.target.value })} aria-label="Style">
          <option value="">All styles</option>
          {styles.map((s) => (
            <option key={s.id} value={s.id} data-sub={s.name}>
              {s.code}
            </option>
          ))}
        </SmartSelect>
      </div>
      <div className="w-36">
        <SmartSelect className={cls} value={f.col} onChange={(e) => set({ col: e.target.value })} aria-label="Colour">
          <option value="">All colours</option>
          {o?.colors.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </SmartSelect>
      </div>
      <div className="w-28">
        <SmartSelect className={cls} value={f.sz} onChange={(e) => set({ sz: e.target.value })} aria-label="Size">
          <option value="">All sizes</option>
          {o?.sizes.map((s) => (
            <option key={s.id} value={s.id}>
              {s.code}
            </option>
          ))}
        </SmartSelect>
      </div>
      <div className="w-36">
        <SmartSelect className={cls} value={f.st} onChange={(e) => set({ st: e.target.value })} aria-label="Where it is">
          <option value="">Anywhere</option>
          {STATES.map((s) => (
            <option key={s} value={s}>
              {GARMENT_STATUS[s].label}
            </option>
          ))}
        </SmartSelect>
      </div>
      <div className="flex items-center gap-1">
        <input type="date" className="form-input h-9 w-[8.5rem] px-2 py-0 text-xs" value={f.from} max={f.to || undefined} onChange={(e) => set({ from: e.target.value })} aria-label="Into finished goods from" title="Into finished goods from" />
        <span className="text-muted-foreground text-xs">to</span>
        <input type="date" className="form-input h-9 w-[8.5rem] px-2 py-0 text-xs" value={f.to} min={f.from || undefined} onChange={(e) => set({ to: e.target.value })} aria-label="Into finished goods to" title="Into finished goods to" />
      </div>
      {any && (
        <button type="button" className="btn-ghost h-9 px-2 text-xs" onClick={clear}>
          <X size={13} /> Clear
        </button>
      )}
    </div>
  )
}

interface PieceRow {
  id: string
  code: string
  status: string
  grade: string
  printed: boolean
  style: string
  color: string
  size: string
  customer: string | null
  soNumber: string | null
  moNumber: string
  store: string
  dcNumber: string | null
  receivedOn: string
  lot: string | null
}

/**
 * The pieces the filters — and what is typed in the box — leave: counted by
 * where they are, 50 a page; a piece opens its whole history.
 */
export function PieceResults({ f, typed, set, open, storyAbove = false }: { f: Filters; typed: string; set: (patch: Partial<Filters>) => void; open: (t: Target) => void; storyAbove?: boolean }) {
  const [page, setPage] = useState(1)
  const [data, setData] = useState<{ total: number; notPrinted: number; pages: number; counts: Record<string, number>; rows: PieceRow[] } | null>(null)
  const printed = useAfterPrint()
  const [loading, setLoading] = useState(false)
  const [q, setQ] = useState(typed)

  // What is typed narrows the list a moment after typing stops.
  useEffect(() => {
    const t = setTimeout(() => setQ(typed.trim()), 300)
    return () => clearTimeout(t)
  }, [typed])
  const key = JSON.stringify([f, q])
  useEffect(() => setPage(1), [key])

  // The filters as the API and the label sheet read them.
  const query = useMemo(() => {
    const qs = new URLSearchParams()
    const map: Array<[FilterKey, string]> = [['fc', 'customerId'], ['fo', 'soId'], ['fm', 'moId'], ['fs', 'styleId'], ['col', 'color'], ['sz', 'sizeId'], ['st', 'status'], ['from', 'from'], ['to', 'to']]
    for (const [k, name] of map) if (f[k]) qs.set(name, f[k])
    if (q.length >= 2) qs.set('q', q)
    return qs.toString()
    // The key holds the filters and the typed text.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])

  useEffect(() => {
    let live = true
    setLoading(true)
    api
      .get<{ data: { total: number; notPrinted: number; pages: number; counts: Record<string, number>; rows: PieceRow[] } }>(`/trace/pieces?${query}${query ? '&' : ''}page=${page}`)
      .then((r) => live && setData(r.data))
      .catch(() => live && setData({ total: 0, notPrinted: 0, pages: 1, counts: {}, rows: [] }))
      .finally(() => live && setLoading(false))
    return () => {
      live = false
    }
  }, [query, page, printed])

  const all = data ? Object.entries(data.counts).filter(([s]) => s !== 'VOID').reduce((t, [, n]) => t + n, 0) : 0
  return (
    <div className="glass-card overflow-hidden p-0">
      <div className="border-border flex flex-wrap items-center gap-2 border-b px-4 py-3">
        <h3 className="text-foreground mr-1 text-sm font-semibold">
          {data ? `${qty(data.total)} ${data.total === 1 ? 'piece' : 'pieces'} found` : 'Looking…'}
          {q.length >= 2 && <span className="text-muted-foreground font-normal"> for “{q}”</span>}
        </h3>
        {loading && <Loader2 size={14} className="text-muted-foreground animate-spin" />}
        {data && (
          <>
            <button
              type="button"
              onClick={() => set({ st: '' })}
              className={`rounded-full border px-2.5 py-0.5 text-xs font-medium ${!f.st ? 'border-primary bg-primary/10 text-primary' : 'border-border text-muted-foreground hover:text-foreground'}`}
            >
              All {qty(all)}
            </button>
            {STATES.filter((s) => data.counts[s]).map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => set({ st: f.st === s ? '' : s })}
                className={`rounded-full border px-2.5 py-0.5 text-xs font-medium ${f.st === s ? 'border-primary bg-primary/10 text-primary' : 'border-border text-muted-foreground hover:text-foreground'}`}
              >
                {GARMENT_STATUS[s].label} {qty(data.counts[s])}
              </button>
            ))}
            {data.notPrinted > 0 && (
              <button
                type="button"
                className="btn-primary ml-auto h-8 px-3 text-xs"
                onClick={() => printLabels(`trace=1${query ? `&${query}` : ''}&only=new`)}
                title="Print the labels of every piece in this list that has not been printed yet"
              >
                <Printer size={13} /> Print {qty(data.notPrinted)} not printed
              </button>
            )}
          </>
        )}
      </div>
      {data && !data.rows.length ? (
        <p className="text-muted-foreground p-6 text-center text-sm">
          {storyAbove
            ? 'No tagged pieces here yet: pieces show once their garment tags are made. Open its story above for its materials, stages and dispatch.'
            : 'No pieces match. Loosen a filter, or change what is typed.'}
        </p>
      ) : (
        <div className="max-h-[60vh] overflow-auto">
          <table className="data-table table-compact min-w-full">
            <thead className="sticky top-0 z-10 [&_th]:bg-secondary">
              <tr>
                <th>Tag</th>
                <th>Style · colour</th>
                <th>Size</th>
                <th>Customer</th>
                <th>Order</th>
                <th>MO</th>
                <th>Lot</th>
                <th>Where now</th>
                <th>Challan</th>
                <th>Into FG</th>
                <th>Label</th>
              </tr>
            </thead>
            <tbody>
              {data?.rows.map((r) => {
                const st = badge(GARMENT_STATUS, r.status)
                return (
                  <tr key={r.code} className="cursor-pointer" onClick={() => open({ kind: 'g', id: r.code })} title={`${r.code}: see its whole history`}>
                    <td className="text-primary whitespace-nowrap font-mono text-xs font-semibold">{r.code}</td>
                    <td className="whitespace-nowrap text-sm">
                      {r.style} <span className="text-muted-foreground">· {r.color}</span>
                    </td>
                    <td className="font-semibold">
                      {r.size || '—'}
                      {r.grade === 'B' && <span className="badge badge-warning ml-1">B</span>}
                    </td>
                    <td className="text-sm">{r.customer ?? <span className="text-muted-foreground">For stock</span>}</td>
                    <td className="whitespace-nowrap font-mono text-xs">{r.soNumber ?? '—'}</td>
                    <td className="whitespace-nowrap font-mono text-xs">{r.moNumber}</td>
                    <td className="text-xs">{r.lot ?? '—'}</td>
                    <td className="whitespace-nowrap">
                      <span className={`badge ${st.cls}`}>{st.label}</span>
                      {r.status !== 'DISPATCHED' && <span className="text-muted-foreground text-xs"> {r.store}</span>}
                    </td>
                    <td className="font-mono text-xs">{r.dcNumber ?? <span className="text-muted-foreground">—</span>}</td>
                    <td className="whitespace-nowrap text-xs">{fmtDay(r.receivedOn)}</td>
                    <td className="text-xs">
                      <LabelCell printed={r.printed} id={r.id} code={r.code} />
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
      {data && data.pages > 1 && (
        <div className="border-border flex items-center justify-end gap-2 border-t px-4 py-2 text-xs">
          <span className="text-muted-foreground">
            Page {page} of {data.pages}
          </span>
          <button type="button" className="btn-ghost h-8 px-2" disabled={page <= 1} onClick={() => setPage((p) => p - 1)} aria-label="Previous page">
            <ChevronLeft size={15} />
          </button>
          <button type="button" className="btn-ghost h-8 px-2" disabled={page >= data.pages} onClick={() => setPage((p) => p + 1)} aria-label="Next page">
            <ChevronRight size={15} />
          </button>
        </div>
      )}
    </div>
  )
}
