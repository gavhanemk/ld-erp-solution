'use client'

import { Check, MapPin, Printer } from 'lucide-react'
import { QrCode } from '@/components/packages/QrCode'
import { Code128 } from '@/components/packages/Code128'
import { Timeline } from './Timeline'
import { Fact, Go, MaterialsUsed } from './TraceBits'
import { GARMENT_STATUS, MO_STATUS, badge, fmtDay, fmtTime, type MaterialLine, type Step, type Target } from './traceTypes'

export interface GarmentStory {
  id: string
  code: string
  status: string
  grade: string
  printCount: number
  lastPrintedAt: string | null
  style: string
  description: string
  sku: string
  color: string
  size: string
  store: string
  brand: string | null
  mo: { id: string; moNumber: string }
  moStatus: string
  soId: string | null
  soNumber: string | null
  poRef: string | null
  buyer: string | null
  customerId: string | null
  styleId: string | null
  imageUrl: string | null
  mrp: number | null
  orderDate: string | null
  deliveryDate: string | null
  receipt: { fgrNumber: string; receiptDate: string; cancelledAt: string | null }
  bundle: { code: string; bundleNo: number; qty: number; cutOrder: string | null; cutDate: string | null; lot: string | null; jobCard: string | null } | null
  challan: { dcNumber: string; dcDate: string; status: string; dispatchedAt: string | null; deliveredAt: string | null; vehicle: string | null; transporter: string | null; lr: string | null; invoice: string | null } | null
  where: string
  milestones: Array<{ key: string; label: string; at: string | null }>
  materials: MaterialLine[]
  timeline: Step[]
}

/**
 * One garment, from its order being booked to today: who it is, where it is
 * now, the milestones it has passed, and every step in between.
 */
export function GarmentTrace({ g, open }: { g: GarmentStory; open: (t: Target) => void }) {
  const st = badge(GARMENT_STATUS, g.status)
  const reached = g.milestones.filter((m) => m.at).length
  return (
    <div className="space-y-4">
      <div className="glass-card overflow-hidden p-0">
        <div className="flex flex-col gap-5 p-4 sm:flex-row sm:items-start sm:p-5">
          <div className="mx-auto shrink-0 space-y-2 sm:mx-0">
            <div className="w-32 rounded-lg bg-white p-2">
              <QrCode text={g.code} />
            </div>
            <div className="w-32 rounded bg-white px-1 py-1" style={{ height: 34 }}>
              <Code128 text={g.code} />
            </div>
          </div>
          <div className="min-w-0 flex-1 space-y-2">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-mono text-2xl font-bold tracking-wide text-primary">{g.code}</span>
              <span className={`badge ${st.cls}`}>{st.label}</span>
              {g.grade === 'B' && <span className="badge badge-warning">B-grade</span>}
            </div>
            <h2 className="text-xl font-semibold leading-tight text-foreground">{g.description}</h2>
            <p className="text-sm text-muted-foreground">
              Style{' '}
              <Go to={g.styleId ? { kind: 's', id: g.styleId } : null} open={open}>
                {g.style}
              </Go>{' '}
              · SKU <span className="font-mono">{g.sku}</span>
              {g.brand ? ` · ${g.brand}` : ''}
              {g.mrp != null ? ` · MRP ₹${g.mrp.toLocaleString('en-IN')}` : ''}
            </p>
            <p className="inline-flex items-center gap-2 rounded-lg border border-primary/30 bg-primary/10 px-3 py-1.5 text-sm font-medium text-foreground">
              <MapPin size={15} className="shrink-0 text-primary" /> {g.where}
            </p>
          </div>
          <div className="flex shrink-0 flex-col gap-2 self-start">
            {g.status !== 'VOID' && (
              <button type="button" className="btn-secondary" onClick={() => window.open(`/print/garments?ids=${g.id}&only=all`, '_blank')}>
                <Printer size={15} /> {g.printCount ? 'Reprint label' : 'Print label'}
              </button>
            )}
          </div>
        </div>

        {/* The milestones it has passed, left to right. */}
        <div className="overflow-x-auto border-t border-border bg-secondary/40 px-4 py-4">
          <ol className="flex min-w-max items-start">
            {g.milestones.map((m, i) => {
              const done = Boolean(m.at)
              return (
                <li key={m.key} className="flex items-start">
                  <div className="flex w-28 flex-col items-center text-center">
                    <span className={`flex h-8 w-8 items-center justify-center rounded-full border-2 ${done ? 'border-primary bg-primary text-white' : 'border-border bg-card text-muted-foreground'}`}>
                      {done ? <Check size={16} /> : <span className="text-xs font-semibold">{i + 1}</span>}
                    </span>
                    <span className={`mt-1.5 text-xs font-semibold ${done ? 'text-foreground' : 'text-muted-foreground'}`}>{m.label}</span>
                    <span className="text-[11px] leading-tight text-muted-foreground">{m.at ? `${fmtDay(m.at)}` : 'Not yet'}</span>
                    {m.at && <span className="text-[11px] leading-tight text-muted-foreground">{fmtTime(m.at)}</span>}
                  </div>
                  {i < g.milestones.length - 1 && <span className={`mt-4 h-0.5 w-8 ${i < reached - 1 && g.milestones[i + 1].at ? 'bg-primary' : 'bg-border'}`} />}
                </li>
              )
            })}
          </ol>
        </div>

        <div className="grid grid-cols-2 gap-x-6 gap-y-3 border-t border-border p-4 sm:grid-cols-3 lg:grid-cols-6">
          <Fact label="Size">
            <span className="text-2xl font-bold">{g.size || '—'}</span>
          </Fact>
          <Fact label="Colour">{g.color || '—'}</Fact>
          <Fact label="Grade">{g.grade || 'A'}</Fact>
          <Fact label="Customer">
            <Go to={g.customerId ? { kind: 'c', id: g.customerId } : null} open={open}>
              {g.buyer ?? 'For stock'}
            </Go>
          </Fact>
          <Fact label="Sales order">
            <Go to={g.soId ? { kind: 'so', id: g.soId } : null} open={open} mono>
              {g.soNumber ?? '—'}
            </Go>
            {g.poRef && <div className="text-xs text-muted-foreground">Their PO {g.poRef}</div>}
          </Fact>
          <Fact label="Manufacturing order">
            <Go to={{ kind: 'mo', id: g.mo.id }} open={open} mono>
              {g.mo.moNumber}
            </Go>
            <div className="text-xs text-muted-foreground">{badge(MO_STATUS, g.moStatus).label}</div>
          </Fact>
          <Fact label="Ordered on">{fmtDay(g.orderDate)}</Fact>
          <Fact label="Wanted by">{fmtDay(g.deliveryDate)}</Fact>
          <Fact label="Lot">{g.bundle?.lot ?? '—'}</Fact>
          <Fact label="Bundle">
            {g.bundle ? (
              <>
                <span className="font-mono">{g.bundle.code}</span>
                <div className="text-xs text-muted-foreground">
                  {g.bundle.qty} pieces{g.bundle.cutOrder ? ` · ${g.bundle.cutOrder}` : ''}
                </div>
              </>
            ) : (
              '—'
            )}
          </Fact>
          <Fact label="Into finished goods">
            <span className="font-mono">{g.receipt.fgrNumber}</span>
            <div className="text-xs text-muted-foreground">{fmtDay(g.receipt.receiptDate)}</div>
          </Fact>
          <Fact label="Label">{g.printCount ? `Printed ${g.printCount === 1 ? 'once' : `${g.printCount} times`}` : 'Not printed yet'}</Fact>
          {g.challan && (
            <>
              <Fact label="Challan">
                <span className="font-mono">{g.challan.dcNumber}</span>
                <div className="text-xs text-muted-foreground">{fmtDay(g.challan.dispatchedAt ?? g.challan.dcDate)}</div>
              </Fact>
              <Fact label="Invoice">{g.challan.invoice ?? '—'}</Fact>
              <Fact label="Vehicle">{[g.challan.vehicle, g.challan.transporter].filter(Boolean).join(' · ') || '—'}</Fact>
              <Fact label="LR no.">{g.challan.lr ?? '—'}</Fact>
            </>
          )}
        </div>
      </div>

      <MaterialsUsed lines={g.materials} note={`For all of ${g.mo.moNumber}`} />

      <Timeline steps={g.timeline} />
    </div>
  )
}
