'use client'

import { Boxes, ClipboardList, Factory, PackageCheck, Scissors, Truck, Warehouse } from 'lucide-react'
import { KpiTile, TONE } from '@/components/dashboard/DashKit'
import { Timeline } from './Timeline'
import { Fact, Go, PiecesBySize, PiecesList, Section } from './TraceBits'
import { MO_STATUS, SO_STATUS, badge, fmtDay, qty, type Pieces, type Step, type Target } from './traceTypes'

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
  pieces: Pieces
  timeline: Step[]
}

const pct = (a: number, b: number) => (b > 0 ? Math.min(100, Math.round((a / b) * 100)) : 0)

/**
 * An order, start to finish: what was asked for, how far each production step
 * has got, where every tagged piece is, and everything that happened to it.
 */
export function OrderTrace({ o, open }: { o: OrderStory; open: (t: Target) => void }) {
  const f = o.figures
  const late = o.so?.deliveryDate && new Date(o.so.deliveryDate) < new Date() && f.despatched < f.ordered
  const head = o.kind === 'SO' && o.so ? o.so.soNumber : o.mos[0]?.moNumber
  const status = o.kind === 'SO' && o.so ? badge(SO_STATUS, o.so.status) : badge(MO_STATUS, o.mos[0]?.status ?? '')
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
          <Fact label="Styles">
            {[...new Map(o.mos.flatMap((m) => m.styles).map((s) => [`${s.styleId}|${s.color}`, s])).values()].map((s) => (
              <div key={`${s.styleId}${s.color}`}>
                <Go to={{ kind: 's', id: s.styleId }} open={open}>
                  {s.style}
                </Go>{' '}
                <span className="text-muted-foreground">
                  {s.color} · {qty(s.qty)} pcs
                </span>
              </div>
            ))}
          </Fact>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <KpiTile icon={ClipboardList} tone={TONE.sky} label="Ordered" value={qty(f.ordered)} sub="pieces" />
        <KpiTile icon={Scissors} tone={TONE.orange} label="Cut" value={qty(f.cut)} sub={`${pct(f.cut, f.ordered)}% of the order`} />
        <KpiTile icon={PackageCheck} tone={TONE.teal} label="Into finished goods" value={qty(f.intoFg)} sub={`${pct(f.intoFg, f.ordered)}% of the order`} />
        <KpiTile icon={Boxes} tone={TONE.violet} label="Tagged" value={qty(f.tagged)} sub="pieces with their own tag" />
        <KpiTile icon={Warehouse} tone={TONE.emerald} label="In the store" value={qty(f.inStore)} sub="ready to send" />
        <KpiTile icon={Truck} tone={TONE.blue} label="Despatched" value={qty(f.despatched)} sub={`${pct(f.despatched, f.ordered)}% of the order`} />
      </div>

      {o.stages.map((s) =>
        s.steps.length ? (
          <Section key={s.moId} icon={Factory} title={`Production steps · ${s.moNumber}`} note={`${qty(s.planned)} pieces planned`}>
            <div className="overflow-x-auto">
              <table className="data-table table-compact min-w-full">
                <thead>
                  <tr className="bg-secondary">
                    <th>Step</th>
                    <th style={{ minWidth: 220 }}>Done</th>
                    <th style={{ textAlign: 'right' }}>In hand</th>
                    <th style={{ textAlign: 'right' }}>At a unit</th>
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
      <PiecesList pieces={o.pieces} open={open} />
      <Timeline steps={o.timeline} />
    </div>
  )
}
