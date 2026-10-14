'use client'

import { Boxes, ClipboardList, PackageCheck, Scissors, Truck, Warehouse } from 'lucide-react'
import { KpiTile, TONE } from '@/components/dashboard/DashKit'
import { Fact, Go, PiecesBySize, PiecesList, Section } from './TraceBits'
import { MO_STATUS, SO_STATUS, badge, fmtDay, qty, type Pieces, type Target } from './traceTypes'

interface OrderRow {
  id: string
  soNumber: string
  status: string
  orderDate: string
  deliveryDate: string | null
  poRef: string | null
  styles: string[]
  mos: Array<{ id: string; moNumber: string; status: string }>
  ordered: number
  cut: number
  packed: number
  inStore: number
  despatched: number
}

export interface CustomerStory {
  customer: { id: string; code: string; name: string; city: string; phone: string | null; email: string | null; gstin: string | null }
  figures: { orders: number; ordered: number; cut: number; packed: number; inStore: number; despatched: number }
  orders: OrderRow[]
}

export interface StyleStory {
  style: { id: string; code: string; name: string; imageUrl: string | null; mrp: number | null; composition: string | null; fabricType: string | null; category: string | null; season: string | null; colors: string[] }
  figures: { orders: number; planned: number; tagged: number; inStore: number; despatched: number }
  orders: Array<{ id: string; moNumber: string; status: string; soId: string | null; soNumber: string | null; customer: { id: string; name: string } | null; colors: string[]; qty: number; cut: number; packed: number; createdAt: string }>
  pieces: Pieces
}

const Bar = ({ done, of }: { done: number; of: number }) => (
  <div className="h-1.5 w-24 overflow-hidden rounded-full bg-secondary">
    <div className="h-full rounded-full bg-primary" style={{ width: `${of > 0 ? Math.min(100, Math.round((done / of) * 100)) : 0}%` }} />
  </div>
)

/** A customer: every order they have placed, and how far each has got. Each order opens its own story. */
export function CustomerTrace({ c, open }: { c: CustomerStory; open: (t: Target) => void }) {
  const f = c.figures
  return (
    <div className="space-y-4">
      <div className="glass-card p-4 sm:p-5">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-2xl font-bold text-foreground">{c.customer.name}</h2>
          <span className="badge badge-neutral font-mono">{c.customer.code}</span>
        </div>
        <div className="mt-3 grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-4">
          <Fact label="City">{c.customer.city || '—'}</Fact>
          <Fact label="Phone">{c.customer.phone ?? '—'}</Fact>
          <Fact label="Email">{c.customer.email ?? '—'}</Fact>
          <Fact label="GSTIN">{c.customer.gstin ?? '—'}</Fact>
        </div>
      </div>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <KpiTile icon={ClipboardList} tone={TONE.sky} label="Orders" value={qty(f.orders)} sub="not cancelled" />
        <KpiTile icon={ClipboardList} tone={TONE.violet} label="Pieces ordered" value={qty(f.ordered)} />
        <KpiTile icon={Scissors} tone={TONE.orange} label="Cut" value={qty(f.cut)} />
        <KpiTile icon={PackageCheck} tone={TONE.teal} label="Packed" value={qty(f.packed)} />
        <KpiTile icon={Warehouse} tone={TONE.emerald} label="In the store" value={qty(f.inStore)} />
        <KpiTile icon={Truck} tone={TONE.blue} label="Despatched" value={qty(f.despatched)} />
      </div>
      <Section icon={ClipboardList} title="Orders" note="Open one for its whole story">
        {!c.orders.length ? (
          <p className="p-6 text-center text-sm text-muted-foreground">No orders yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="data-table table-compact min-w-full">
              <thead>
                <tr className="bg-secondary">
                  <th>Order</th>
                  <th>Their PO</th>
                  <th>Ordered on</th>
                  <th>Wanted by</th>
                  <th>Styles</th>
                  <th>Status</th>
                  <th style={{ textAlign: 'right' }}>Ordered</th>
                  <th style={{ textAlign: 'right' }}>Cut</th>
                  <th style={{ textAlign: 'right' }}>Packed</th>
                  <th style={{ textAlign: 'right' }}>In store</th>
                  <th style={{ textAlign: 'right' }}>Despatched</th>
                  <th>Progress</th>
                </tr>
              </thead>
              <tbody>
                {c.orders.map((o) => {
                  const st = badge(SO_STATUS, o.status)
                  return (
                    <tr key={o.id}>
                      <td>
                        <Go to={{ kind: 'so', id: o.id }} open={open} mono>
                          {o.soNumber}
                        </Go>
                      </td>
                      <td className="text-sm">{o.poRef ?? '—'}</td>
                      <td className="whitespace-nowrap text-sm">{fmtDay(o.orderDate)}</td>
                      <td className="whitespace-nowrap text-sm">{fmtDay(o.deliveryDate)}</td>
                      <td className="text-sm">{o.styles.join(', ') || '—'}</td>
                      <td>
                        <span className={`badge ${st.cls}`}>{st.label}</span>
                      </td>
                      {[o.ordered, o.cut, o.packed, o.inStore, o.despatched].map((v, i) => (
                        <td key={i} className="text-right tabular-nums">
                          {qty(v)}
                        </td>
                      ))}
                      <td>
                        <Bar done={o.despatched} of={o.ordered} />
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </Section>
    </div>
  )
}

/** A style: every order it was made on, and where its tagged pieces are. */
export function StyleTrace({ s, open }: { s: StyleStory; open: (t: Target) => void }) {
  const f = s.figures
  const st = s.style
  return (
    <div className="space-y-4">
      <div className="glass-card flex flex-col gap-4 p-4 sm:flex-row sm:p-5">
        {st.imageUrl && (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={st.imageUrl} alt={st.code} className="h-32 w-32 shrink-0 rounded-lg border border-border object-cover" />
        )}
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-mono text-2xl font-bold tracking-wide text-primary">{st.code}</span>
            {st.mrp != null && <span className="badge badge-info">MRP ₹{st.mrp.toLocaleString('en-IN')}</span>}
          </div>
          <h2 className="text-xl font-semibold text-foreground">{st.name}</h2>
          <div className="mt-3 grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-4">
            <Fact label="Category">{st.category ?? '—'}</Fact>
            <Fact label="Fabric">{st.fabricType ?? '—'}</Fact>
            <Fact label="Composition">{st.composition ?? '—'}</Fact>
            <Fact label="Colours">{st.colors.length ? st.colors.join(', ') : '—'}</Fact>
          </div>
        </div>
      </div>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        <KpiTile icon={ClipboardList} tone={TONE.sky} label="Orders" value={qty(f.orders)} sub="manufacturing orders" />
        <KpiTile icon={Scissors} tone={TONE.orange} label="Planned" value={qty(f.planned)} sub="pieces" />
        <KpiTile icon={Boxes} tone={TONE.violet} label="Tagged" value={qty(f.tagged)} />
        <KpiTile icon={Warehouse} tone={TONE.emerald} label="In the store" value={qty(f.inStore)} />
        <KpiTile icon={Truck} tone={TONE.blue} label="Despatched" value={qty(f.despatched)} />
      </div>
      <Section icon={ClipboardList} title="Made on these orders" note="Open one for its whole story">
        {!s.orders.length ? (
          <p className="p-6 text-center text-sm text-muted-foreground">Not on any manufacturing order yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="data-table table-compact min-w-full">
              <thead>
                <tr className="bg-secondary">
                  <th>Manufacturing order</th>
                  <th>Sales order</th>
                  <th>Customer</th>
                  <th>Colours</th>
                  <th>Status</th>
                  <th style={{ textAlign: 'right' }}>Pieces</th>
                  <th style={{ textAlign: 'right' }}>Cut</th>
                  <th style={{ textAlign: 'right' }}>Packed</th>
                  <th>Raised</th>
                </tr>
              </thead>
              <tbody>
                {s.orders.map((o) => {
                  const ms = badge(MO_STATUS, o.status)
                  return (
                    <tr key={o.id}>
                      <td>
                        <Go to={{ kind: 'mo', id: o.id }} open={open} mono>
                          {o.moNumber}
                        </Go>
                      </td>
                      <td>
                        <Go to={o.soId ? { kind: 'so', id: o.soId } : null} open={open} mono>
                          {o.soNumber ?? '—'}
                        </Go>
                      </td>
                      <td className="text-sm">
                        <Go to={o.customer ? { kind: 'c', id: o.customer.id } : null} open={open}>
                          {o.customer?.name ?? 'For stock'}
                        </Go>
                      </td>
                      <td className="text-sm">{o.colors.join(', ')}</td>
                      <td>
                        <span className={`badge ${ms.cls}`}>{ms.label}</span>
                      </td>
                      <td className="text-right tabular-nums">{qty(o.qty)}</td>
                      <td className="text-right tabular-nums">{qty(o.cut)}</td>
                      <td className="text-right tabular-nums">{qty(o.packed)}</td>
                      <td className="whitespace-nowrap text-sm">{fmtDay(o.createdAt)}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </Section>
      <PiecesBySize pieces={s.pieces} />
      <PiecesList pieces={s.pieces} open={open} />
    </div>
  )
}
