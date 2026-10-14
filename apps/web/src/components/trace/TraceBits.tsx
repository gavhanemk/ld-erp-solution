'use client'

import { useMemo, useState } from 'react'
import { Boxes, Factory, Search } from 'lucide-react'
import { GARMENT_STATUS, badge, qty, type Pieces, type Target } from './traceTypes'

/** A named fact: "SIZE" small and grey, the value under it. */
export function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <div className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className="break-words text-sm text-foreground">{children}</div>
    </div>
  )
}

/** A link to another view on this screen: an order, a customer, a piece. */
export function Go({ to, open, children, mono = false }: { to: Target | null; open: (t: Target) => void; children: React.ReactNode; mono?: boolean }) {
  if (!to) return <>{children}</>
  return (
    <button type="button" onClick={() => open(to)} className={`text-left font-medium text-primary hover:underline ${mono ? 'font-mono' : ''}`}>
      {children}
    </button>
  )
}

/** A titled card section. */
export function Section({ icon: Icon, title, note, children }: { icon: React.ElementType; title: string; note?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="glass-card overflow-hidden p-0">
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-3">
        <Icon size={16} className="text-primary" />
        <h3 className="text-sm font-semibold text-foreground">{title}</h3>
        {note && <span className="ml-auto text-xs text-muted-foreground">{note}</span>}
      </div>
      {children}
    </div>
  )
}

const COLS = ['IN_STOCK', 'PACKED', 'DISPATCHED', 'SCRAPPED'] as const

/** Tagged pieces by colour and size, and where they are. */
export function PiecesBySize({ pieces }: { pieces: Pieces }) {
  if (!pieces.bySize.length) return null
  const cols = COLS.filter((c) => pieces.bySize.some((r) => r.counts[c]))
  return (
    <Section icon={Boxes} title="Tagged pieces by size" note={`${qty(pieces.tagged)} pieces`}>
      <div className="overflow-x-auto">
        <table className="data-table table-compact min-w-full">
          <thead>
            <tr className="bg-secondary">
              <th>Style · colour</th>
              <th>Size</th>
              {cols.map((c) => (
                <th key={c} style={{ textAlign: 'right' }}>
                  {GARMENT_STATUS[c].label}
                </th>
              ))}
              <th style={{ textAlign: 'right' }}>Total</th>
            </tr>
          </thead>
          <tbody>
            {pieces.bySize.map((r, i) => (
              <tr key={i}>
                <td className="whitespace-nowrap text-sm">
                  {r.style} <span className="text-muted-foreground">· {r.color}</span>
                </td>
                <td className="font-semibold">{r.size}</td>
                {cols.map((c) => (
                  <td key={c} className="text-right tabular-nums">
                    {r.counts[c] ? qty(r.counts[c]) : <span className="text-muted-foreground">—</span>}
                  </td>
                ))}
                <td className="text-right font-semibold tabular-nums">{qty(r.total)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Section>
  )
}

/** Every tagged piece, findable by its code, size or where it is; a code opens that piece's story. */
export function PiecesList({ pieces, open }: { pieces: Pieces; open: (t: Target) => void }) {
  const [q, setQ] = useState('')
  const [status, setStatus] = useState('')
  const [all, setAll] = useState(false)
  const rows = useMemo(() => {
    const s = q.trim().toLowerCase()
    return pieces.list.filter(
      (p) => (!status || p.status === status) && (!s || [p.code, p.size, p.color, p.style, p.store, p.dcNumber ?? '', p.moNumber].some((v) => v.toLowerCase().includes(s))),
    )
  }, [pieces.list, q, status])
  if (!pieces.list.length) return null
  const shown = all ? rows : rows.slice(0, 50)
  return (
    <Section icon={Factory} title="Every piece" note={pieces.list.length >= 1000 ? 'The first 1,000' : `${pieces.list.length} pieces`}>
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-2">
        <div className="flex min-w-0 flex-1 items-center gap-2 rounded-lg border border-field-edge bg-field px-2 py-1.5 sm:max-w-xs">
          <Search size={14} className="shrink-0 text-muted-foreground" />
          <input className="min-w-0 flex-1 border-0 bg-transparent text-sm text-foreground outline-none" placeholder="Code, size, colour, challan…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Find a piece" />
        </div>
        {['', ...COLS].map((s) => (
          <button
            key={s || 'all'}
            type="button"
            onClick={() => setStatus(s)}
            className={`rounded-full border px-2.5 py-0.5 text-xs font-medium ${status === s ? 'border-primary bg-primary/10 text-primary' : 'border-border text-muted-foreground hover:text-foreground'}`}
          >
            {s ? GARMENT_STATUS[s].label : 'All'}
          </button>
        ))}
        <span className="ml-auto text-xs text-muted-foreground">{rows.length} shown</span>
      </div>
      <div className="max-h-[28rem] overflow-auto">
        <table className="data-table table-compact min-w-full">
          <thead className="sticky top-0 z-10">
            <tr className="bg-secondary">
              <th>Tag</th>
              <th>Style · colour</th>
              <th>Size</th>
              <th>Grade</th>
              <th>Where</th>
              <th>Challan</th>
              <th>Label</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((p) => {
              const st = badge(GARMENT_STATUS, p.status)
              return (
                <tr key={p.code}>
                  <td>
                    <Go to={{ kind: 'g', id: p.code }} open={open} mono>
                      {p.code}
                    </Go>
                  </td>
                  <td className="whitespace-nowrap text-sm">
                    {p.style} <span className="text-muted-foreground">· {p.color}</span>
                  </td>
                  <td className="font-semibold">{p.size || '—'}</td>
                  <td>{p.grade === 'B' ? <span className="badge badge-warning">B</span> : 'A'}</td>
                  <td className="whitespace-nowrap">
                    <span className={`badge ${st.cls}`}>{st.label}</span> <span className="text-xs text-muted-foreground">{p.status === 'DISPATCHED' ? '' : p.store}</span>
                  </td>
                  <td className="font-mono text-xs">{p.dcNumber ?? <span className="text-muted-foreground">—</span>}</td>
                  <td className="text-xs text-muted-foreground">{p.printed ? 'Printed' : 'Not printed'}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
      {!all && rows.length > 50 && (
        <div className="border-t border-border px-4 py-2 text-center">
          <button type="button" className="btn-ghost h-8 text-xs" onClick={() => setAll(true)}>
            Show all {rows.length}
          </button>
        </div>
      )}
    </Section>
  )
}
