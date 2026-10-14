'use client'

import { useMemo, useState } from 'react'
import { Boxes, Factory, Printer, Search, ShoppingCart } from 'lucide-react'
import { GARMENT_STATUS, badge, fmtDay, printLabels, qty, type MaterialLine, type Pieces, type Target } from './traceTypes'

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
export function PiecesList({ pieces, open, printQuery }: { pieces: Pieces; open: (t: Target) => void; printQuery?: string }) {
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
        {printQuery && pieces.notPrinted > 0 && (
          <button type="button" className="btn-primary h-8 px-3 text-xs" onClick={() => printLabels(`${printQuery}&only=new`)} title="Print every label here that has not been printed yet">
            <Printer size={13} /> Print {qty(pieces.notPrinted)} not printed
          </button>
        )}
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
                  <td className="text-xs">
                    <LabelCell printed={p.printed} id={p.id} code={p.code} />
                  </td>
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

/** A piece's label: "Printed", or a button that prints it. */
export function LabelCell({ printed, id, code }: { printed: boolean; id: string; code: string }) {
  if (printed) return <span className="text-muted-foreground">Printed</span>
  return (
    <button
      type="button"
      className="btn-secondary h-7 whitespace-nowrap px-2 text-xs"
      onClick={(e) => {
        e.stopPropagation()
        printLabels(`ids=${id}&only=all`)
      }}
      title={`${code} has no label yet: print it`}
    >
      <Printer size={12} /> Print
    </button>
  )
}

const unitQty = (n: number, unit: string) => (n ? `${qty(n)} ${unit}`.trim() : '—')

/**
 * What the order asked the store for, what it was given and gave back, and —
 * where the store did not have it — what was bought for it, from whom, and
 * what has come in.
 */
export function MaterialsUsed({ lines, note }: { lines: MaterialLine[]; note?: string }) {
  if (!lines.length) {
    return (
      <Section icon={ShoppingCart} title="Materials & purchase">
        <p className="px-4 py-5 text-sm text-muted-foreground">No material request has been raised for this order yet.</p>
      </Section>
    )
  }
  const requests = new Set(lines.map((l) => l.mrNumber)).size
  const pos = new Set(lines.flatMap((l) => l.purchases.map((p) => p.poNumber))).size
  return (
    <Section
      icon={ShoppingCart}
      title="Materials & purchase"
      note={[note, `${requests} ${requests === 1 ? 'request' : 'requests'}`, pos ? `${pos} purchase ${pos === 1 ? 'order' : 'orders'}` : 'nothing bought for it'].filter(Boolean).join(' · ')}
    >
      <div className="max-h-[28rem] overflow-auto">
        <table className="data-table table-compact min-w-full">
          <thead className="sticky top-0 z-10 [&_th]:bg-secondary">
            <tr>
              <th style={{ minWidth: 200 }}>Material</th>
              <th>Request</th>
              <th style={{ textAlign: 'right' }}>Asked for</th>
              <th style={{ textAlign: 'right' }}>Given</th>
              <th style={{ textAlign: 'right' }}>Returned</th>
              <th>Status</th>
              <th style={{ minWidth: 220 }}>Bought for it</th>
            </tr>
          </thead>
          <tbody>
            {lines.map((l, i) => {
              const state =
                l.issued >= l.asked && l.asked > 0
                  ? { label: 'Given in full', cls: 'badge-success' }
                  : l.issued > 0
                    ? { label: 'Partly given', cls: 'badge-warning' }
                    : l.status === 'REJECTED' || l.status === 'CANCELLED'
                      ? { label: l.status === 'REJECTED' ? 'Turned down' : 'Cancelled', cls: 'badge-danger' }
                      : l.status === 'PENDING'
                        ? { label: 'Waiting for approval', cls: 'badge-neutral' }
                        : { label: 'Waiting for the store', cls: 'badge-info' }
              return (
                <tr key={i}>
                  <td>
                    <div className="font-medium text-foreground">{l.item}</div>
                    <div className="font-mono text-[11px] text-muted-foreground">{l.code}</div>
                  </td>
                  <td className="whitespace-nowrap">
                    <span className="font-mono text-xs">{l.mrNumber}</span>
                    <div className="text-[11px] text-muted-foreground">{l.department}</div>
                  </td>
                  <td className="whitespace-nowrap text-right tabular-nums">{unitQty(l.asked, l.unit)}</td>
                  <td className="whitespace-nowrap text-right tabular-nums">{unitQty(l.issued, l.unit)}</td>
                  <td className="whitespace-nowrap text-right tabular-nums">{unitQty(l.returned, l.unit)}</td>
                  <td className="whitespace-nowrap">
                    <span className={`badge ${state.cls}`}>{state.label}</span>
                  </td>
                  <td className="text-xs">
                    {l.purchases.length ? (
                      <div className="space-y-1">
                        {l.purchases.map((p) => (
                          <div key={p.poNumber}>
                            <span className="font-mono font-semibold">{p.poNumber}</span> <span className="text-muted-foreground">· {p.supplier} · {fmtDay(p.date)}</span>
                            <div className="text-muted-foreground">
                              {qty(p.qty)} {l.unit} ordered ·{' '}
                              {p.receipts.length
                                ? p.receipts.map((r) => `${qty(r.qty)} in on ${r.grnNumber} (${fmtDay(r.date)})`).join(', ')
                                : 'nothing received yet'}
                            </div>
                          </div>
                        ))}
                      </div>
                    ) : l.toBuy > 0 ? (
                      <span className="warn-text">
                        {qty(l.toBuy)} {l.unit} to buy · no purchase order yet
                      </span>
                    ) : (
                      <span className="text-muted-foreground">From stock</span>
                    )}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </Section>
  )
}
