'use client'

import { useState } from 'react'
import { AlertTriangle, CheckCircle2, Factory, History, Printer, Trash2 } from 'lucide-react'
import { api, ApiError, can } from '@/lib/api'
import { QrCode } from './QrCode'

export interface GarmentDetail {
  id: string
  code: string
  status: string
  grade: string
  printCount: number
  lastPrintedAt: string | null
  createdAt: string
  style: string
  description: string
  item: string
  sku: string
  color: string
  size: string
  store: string
  brand: string | null
  mo: { id: string; moNumber: string }
  soNumber: string | null
  poRef: string | null
  buyer: string | null
  receipt: { id: string; fgrNumber: string; receiptDate: string; cancelledAt: string | null }
  bundle: { code: string; bundleNo: number; qty: number; cutOrder: string | null; cutDate: string | null; lot: string | null; jobCard: string | null } | null
  production: Array<{ date: string; type: string; step: string; check: boolean; changes: string[]; ref: string | null; by: string | null; reversed: boolean }>
  events: Array<{ type: string; notes: string | null; referenceNumber: string | null; by: string | null; at: string }>
}

/** Normalises what a scanner typed and says whether it is a garment's code (G-00001234). */
export const looksLikeGarment = (raw: string) => {
  let s = raw.trim()
  if (s.includes('/')) s = s.split('/').filter(Boolean).pop() ?? s
  return /^G-?\d{1,10}$/i.test(s.replace(/\s+/g, ''))
}

const STATUS: Record<string, { label: string; cls: string }> = {
  IN_STOCK: { label: 'In stock', cls: 'badge-success' },
  PACKED: { label: 'Packed', cls: 'badge-info' },
  DISPATCHED: { label: 'Despatched', cls: 'badge-purple' },
  VOID: { label: 'Tag withdrawn', cls: 'badge-danger' },
}
const EVENT: Record<string, string> = {
  TAGGED: 'Tagged',
  PACKED: 'Packed into a carton',
  UNPACKED: 'Taken out of a carton',
  DISPATCHED: 'Despatched',
  RETURNED: 'Returned',
  VOIDED: 'Tag withdrawn',
}
const day = (d: string | null) => (d ? new Date(d).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }) : '—')
const when = (d: string) => new Date(d).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })

/**
 * One scanned garment: what it is, who it is for, the bundle it was sewn in
 * and that bundle's way through the floor. Scanning changes nothing.
 */
export function GarmentCard({ g, onChange, onDone }: { g: GarmentDetail; onChange: (g: GarmentDetail) => void; onDone: (m: string) => void }) {
  const [tab, setTab] = useState<'production' | 'tag'>('production')
  const [why, setWhy] = useState('')
  const [withdrawing, setWithdrawing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const st = STATUS[g.status] ?? { label: g.status, cls: 'badge-neutral' }

  const reprint = () => window.open(`/print/garments?ids=${g.id}&only=all`, '_blank')
  const withdraw = async () => {
    setError(null)
    try {
      const res = await api.post<{ message: string; data: GarmentDetail }>(`/garments/${g.id}/void`, { reason: why.trim() })
      onChange(res.data)
      onDone(res.message)
      setWithdrawing(false)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save.')
    }
  }

  return (
    <div className="glass-card overflow-hidden p-0">
      <div className="flex flex-col gap-4 border-b border-border p-4 sm:flex-row sm:items-start">
        <div className="mx-auto w-28 shrink-0 rounded-lg bg-white p-1.5 sm:mx-0">
          <QrCode text={g.code} />
        </div>
        <div className="min-w-0 flex-1 space-y-1.5">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-mono text-lg font-bold tracking-wide text-primary">{g.code}</span>
            <span className={`badge ${st.cls}`}>{st.label}</span>
            {g.grade === 'B' && <span className="badge badge-warning">B-grade</span>}
          </div>
          <h2 className="text-xl font-semibold leading-tight text-foreground">{g.description}</h2>
          <p className="text-sm text-muted-foreground">
            Style <span className="font-semibold text-foreground">{g.style}</span> · SKU <span className="font-mono">{g.sku}</span>
            {g.brand ? ` · ${g.brand}` : ''}
          </p>
          <div className="grid grid-cols-2 gap-x-4 gap-y-1 pt-1 text-sm sm:grid-cols-4">
            <Fact label="Size">
              <span className="text-2xl font-bold text-foreground">{g.size || '—'}</span>
            </Fact>
            <Fact label="Colour">{g.color}</Fact>
            <Fact label="Store">{g.store}</Fact>
            <Fact label="Buyer">{g.buyer ?? 'For stock'}</Fact>
            <Fact label="Order">
              {g.soNumber ?? '—'}
              {g.poRef ? ` · PO ${g.poRef}` : ''}
            </Fact>
            <Fact label="Manufacturing order">{g.mo.moNumber}</Fact>
            <Fact label="Lot">{g.bundle?.lot ?? '—'}</Fact>
            <Fact label="Received">
              {g.receipt.fgrNumber} · {day(g.receipt.receiptDate)}
            </Fact>
          </div>
          <p className="text-xs text-muted-foreground">
            {g.printCount ? `Label printed ${g.printCount === 1 ? 'once' : `${g.printCount} times`}, last ${day(g.lastPrintedAt)}` : 'Label not printed yet'}
          </p>
        </div>
        <div className="flex shrink-0 flex-col gap-2 self-start">
          {g.status !== 'VOID' && (
            <button type="button" className="btn-secondary" onClick={reprint}>
              <Printer size={15} /> {g.printCount ? 'Reprint label' : 'Print label'}
            </button>
          )}
          {g.status === 'IN_STOCK' && can('inventory', 'edit') && (
            <button type="button" className="btn-ghost text-red-400" onClick={() => setWithdrawing((w) => !w)}>
              <Trash2 size={15} /> Withdraw tag
            </button>
          )}
        </div>
      </div>

      {withdrawing && (
        <div className="flex flex-wrap items-center gap-2 border-b border-border bg-red-500/5 px-4 py-3">
          <span className="text-sm text-foreground">Withdraw {g.code}? The piece stays in stock, untagged, and can be tagged again.</span>
          <input className="form-input h-9 w-64" placeholder="Why, e.g. tagged twice" value={why} onChange={(e) => setWhy(e.target.value)} />
          <button className="btn-secondary h-9 text-red-400" disabled={why.trim().length < 3} onClick={() => void withdraw()}>
            Withdraw
          </button>
        </div>
      )}
      {error && (
        <p className="flex items-center gap-2 border-b border-border px-4 py-2 text-sm text-red-400">
          <AlertTriangle size={15} /> {error}
        </p>
      )}

      <div className="flex gap-1 border-b border-border bg-secondary/40 px-2 pt-2">
        {(
          [
            ['production', 'Production & QC', Factory],
            ['tag', 'Tag history', History],
          ] as const
        ).map(([key, label, Icon]) => (
          <button
            key={key}
            type="button"
            onClick={() => setTab(key)}
            className={`flex items-center gap-2 rounded-t-lg px-4 py-2.5 text-sm font-semibold ${tab === key ? 'bg-card text-primary shadow-sm' : 'text-muted-foreground hover:text-foreground'}`}
          >
            <Icon size={16} /> {label}
          </button>
        ))}
      </div>

      <div className="p-4">
        {tab === 'production' ? (
          g.bundle ? (
            <div className="space-y-3">
              <p className="text-sm text-muted-foreground">
                Sewn in bundle <span className="font-mono font-semibold text-foreground">{g.bundle.code}</span> ({g.bundle.qty} pieces)
                {g.bundle.cutOrder ? `, cut on ${g.bundle.cutOrder} ${day(g.bundle.cutDate)}` : ''}
                {g.bundle.jobCard ? ` · job card ${g.bundle.jobCard}` : ''}. The steps below are that bundle's.
              </p>
              <ol className="space-y-1.5">
                {g.production.map((e, i) => (
                  <li key={i} className={`flex gap-3 rounded-lg border p-2.5 text-sm ${e.check ? 'border-primary/30 bg-primary/5' : 'border-border'} ${e.reversed ? 'opacity-50' : ''}`}>
                    {e.check ? <CheckCircle2 size={16} className="mt-0.5 shrink-0 text-primary" /> : <span className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-muted-foreground/50" />}
                    <div className="min-w-0 flex-1">
                      <span className="font-semibold text-foreground">
                        {e.type} · {e.step}
                      </span>{' '}
                      <span className="text-foreground">{e.changes.join(', ')}</span>
                      {e.reversed && <span className="ml-1 text-xs">(reversed)</span>}
                      <div className="text-xs text-muted-foreground">
                        {when(e.date)}
                        {e.by ? ` · ${e.by}` : ''}
                        {e.ref ? ` · ${e.ref}` : ''}
                      </div>
                    </div>
                  </li>
                ))}
              </ol>
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">This piece was received into finished goods without a bundle on the floor, so there is no production history to show.</p>
          )
        ) : (
          <ol className="space-y-1.5">
            {g.events.map((e, i) => (
              <li key={i} className="rounded-lg border border-border p-2.5 text-sm">
                <span className="font-semibold text-foreground">{EVENT[e.type] ?? e.type}</span>
                {e.referenceNumber ? ` · ${e.referenceNumber}` : ''}
                {e.notes ? <span className="text-muted-foreground"> · {e.notes}</span> : ''}
                <div className="text-xs text-muted-foreground">
                  {when(e.at)}
                  {e.by ? ` · ${e.by}` : ''}
                </div>
              </li>
            ))}
          </ol>
        )}
      </div>
    </div>
  )
}

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <div className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className="break-words text-foreground">{children}</div>
    </div>
  )
}
