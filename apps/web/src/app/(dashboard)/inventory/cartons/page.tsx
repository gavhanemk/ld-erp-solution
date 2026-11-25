'use client'

import { Suspense, useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { useRouter, useSearchParams } from 'next/navigation'
import { AlertTriangle, Boxes, CheckCircle2, Loader2, PackageOpen, Printer, Search, Truck, X } from 'lucide-react'
import { api, ApiError, can } from '@/lib/api'
import { cn } from '@/lib/utils'
import { Scanner } from '@/components/packages/Scanner'
import { SmartSelect } from '@/components/ui/SmartSelect'
import { openPrintTab } from '@/components/packages/packageTypes'
import { PackCartonDialog } from '@/components/inventory/cartons/PackCartonDialog'
import { printCartons, sizesLine, STATUS_LABEL, type Carton, type CartonOrder } from '@/components/inventory/cartons/cartonTypes'

/*
 * Inventory → Finished Goods → Cartons: finished garments packed in the
 * store, each carton with its own sticker — what is in it by style, item and
 * size, and the order it is for — then loaded onto a delivery challan by
 * scanning or picking the cartons.
 */

interface Loading {
  dcId: string
  dcNumber: string
  status: string
  soId: string
  store: { id: string; name: string } | null
  cartons: Carton[]
  pieces: number
  bySize: Array<{ code: string; qty: number }>
}

const day = (d: string | null) => (d ? new Date(d).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: '2-digit' }) : '—')

export default function CartonsPage() {
  return (
    <Suspense fallback={null}>
      <Cartons />
    </Suspense>
  )
}

function Cartons() {
  const params = useSearchParams()
  const router = useRouter()
  const tab = params.get('tab') === 'dispatch' ? 'dispatch' : 'cartons'
  const [done, setDone] = useState<{ message: string; link?: { href: string; label: string } } | null>(null)

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="mr-auto">
          <h1 className="page-title">Cartons</h1>
          <p className="text-muted-foreground text-sm">Finished garments packed in the store, each carton with its own sticker, sent by scanning onto a delivery challan.</p>
        </div>
        <div className="border-border bg-secondary inline-flex rounded-lg border p-0.5" role="tablist" aria-label="Cartons">
          {(
            [
              ['cartons', 'Cartons'],
              ['dispatch', 'Dispatch'],
            ] as const
          ).map(([key, label]) => (
            <button
              key={key}
              role="tab"
              aria-selected={tab === key}
              onClick={() => router.replace(key === 'dispatch' ? '/inventory/cartons?tab=dispatch' : '/inventory/cartons', { scroll: false })}
              className={cn('h-8 rounded-md px-3 text-sm font-semibold', tab === key ? 'bg-card text-primary shadow-sm' : 'text-muted-foreground hover:text-foreground')}
            >
              {label}
            </button>
          ))}
        </div>
      </div>
      {done && (
        <div className="flex items-start gap-3 rounded-xl border border-emerald-500/40 bg-emerald-500/10 p-3 text-emerald-600" role="status">
          <CheckCircle2 size={18} className="mt-0.5 shrink-0" />
          <p className="font-medium">{done.message}</p>
          {done.link && (
            <Link href={done.link.href} target="_blank" className="btn-secondary ml-auto h-9 shrink-0">
              <Printer size={15} /> {done.link.label}
            </Link>
          )}
          <button className={done.link ? 'shrink-0' : 'ml-auto'} onClick={() => setDone(null)} aria-label="Dismiss">
            <X size={16} />
          </button>
        </div>
      )}
      {tab === 'cartons' ? <CartonList onDone={setDone} /> : <DispatchCartons onDone={setDone} />}
    </div>
  )
}

/** The cartons, in the store by default: what each holds, for which order, and where it is. */
function CartonList({ onDone }: { onDone: (d: { message: string }) => void }) {
  const [rows, setRows] = useState<Carton[] | null>(null)
  const [counts, setCounts] = useState<Record<string, number>>({})
  const [status, setStatus] = useState('PACKED')
  const [q, setQ] = useState('')
  const [packing, setPacking] = useState(false)
  const [opening, setOpening] = useState<Carton | null>(null)
  const [reason, setReason] = useState('')
  const [error, setError] = useState<string | null>(null)
  const mayPack = can('inventory', 'create')

  const load = useCallback(async () => {
    try {
      const qs = new URLSearchParams({ status })
      if (q.trim()) qs.set('q', q.trim())
      const r = await api.get<{ data: Carton[]; counts: Record<string, number> }>(`/fg-cartons?${qs}`)
      setRows(r.data)
      setCounts(r.counts)
      setError(null)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load the cartons.')
    }
  }, [status, q])
  useEffect(() => {
    const t = setTimeout(() => void load(), q ? 300 : 0)
    return () => clearTimeout(t)
  }, [load, q])

  const open = async () => {
    if (!opening) return
    try {
      const r = await api.post<{ message: string }>(`/fg-cartons/${opening.id}/open`, { reason })
      setOpening(null)
      setReason('')
      onDone({ message: r.message })
      void load()
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not open the carton.')
    }
  }

  const shown = rows ?? []
  return (
    <div className="glass-card overflow-hidden p-0">
      <div className="border-border flex flex-wrap items-center gap-2 border-b px-3 py-2">
        <SmartSelect className="form-input h-9 w-44" value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Which cartons">
          <option value="PACKED">In store ({counts.PACKED ?? 0})</option>
          <option value="DISPATCHED">Dispatched ({counts.DISPATCHED ?? 0})</option>
          <option value="OPENED">Opened ({counts.OPENED ?? 0})</option>
          <option value="ALL">All</option>
        </SmartSelect>
        <div className="border-border bg-secondary flex h-9 min-w-60 flex-1 items-center gap-2 rounded-lg border px-3">
          <Search size={14} className="text-muted-foreground" />
          <input
            className="text-foreground placeholder:text-muted-foreground flex-1 border-0 bg-transparent text-sm outline-none"
            placeholder="Search carton, style, item or order…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            aria-label="Search cartons"
            data-hotkey="search"
          />
        </div>
        {shown.some((c) => c.status === 'PACKED') && (
          <button className="btn-secondary h-9" onClick={() => printCartons(shown.filter((c) => c.status === 'PACKED').map((c) => c.id))}>
            <Printer size={15} /> Print stickers ({shown.filter((c) => c.status === 'PACKED').length})
          </button>
        )}
        {mayPack && (
          <button className="btn-primary h-9" onClick={() => setPacking(true)}>
            <Boxes size={15} /> Pack a carton
          </button>
        )}
      </div>
      {error && <p className="px-4 pt-3 text-sm text-red-400">{error}</p>}
      {opening && (
        <div className="border-border flex flex-wrap items-center gap-2 border-b bg-amber-500/5 px-4 py-2 text-sm" role="dialog" aria-label="Open carton">
          <span className="text-foreground">
            Open <b>{opening.code}</b>: its {opening.pieces} pcs go back loose in {opening.store.name}.
          </span>
          <input className="form-input h-8 w-64" placeholder="Why, e.g. repacked by size" value={reason} onChange={(e) => setReason(e.target.value)} aria-label="Why the carton is opened" />
          <button className="btn-ghost h-8" onClick={() => setOpening(null)}>
            Cancel
          </button>
          <button className="btn-primary h-8" disabled={reason.trim().length < 3} onClick={() => void open()}>
            <PackageOpen size={14} /> Open carton
          </button>
        </div>
      )}
      {rows === null ? (
        <p className="text-muted-foreground p-8 text-center text-sm">Loading…</p>
      ) : !shown.length ? (
        <p className="text-muted-foreground p-10 text-center text-sm">
          {q || status !== 'PACKED' ? 'No carton matches that.' : 'No cartons in the store yet. Pack one from the finished pieces in a store.'}
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="data-table table-compact min-w-full">
            <thead>
              <tr className="bg-secondary">
                <th>Carton</th>
                <th>Store</th>
                <th>Order</th>
                <th>What is in it</th>
                <th style={{ textAlign: 'right' }}>Pcs</th>
                <th>Status</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {shown.map((c) => {
                const st = STATUS_LABEL[c.status]
                return (
                  <tr key={c.id}>
                    <td className="whitespace-nowrap">
                      <Link href={`/inventory/scan?code=${c.code}`} className="text-primary font-mono text-sm font-semibold hover:underline">
                        {c.code}
                      </Link>
                      <div className="text-muted-foreground text-xs">{day(c.createdAt)}</div>
                    </td>
                    <td className="whitespace-nowrap text-sm">{c.store.name}</td>
                    <td className="text-sm">
                      {c.order ? (
                        <>
                          <div className="font-mono">{c.order.soNumber}</div>
                          <div className="text-muted-foreground text-xs">{c.order.customer}</div>
                        </>
                      ) : (
                        <span className="text-muted-foreground">Any buyer</span>
                      )}
                    </td>
                    <td className="text-sm">
                      {c.items.map((it) => (
                        <div key={`${it.itemId}|${it.grade}`}>
                          <span className="font-mono text-xs">{it.style ?? ''}</span> <span className="font-mono text-xs text-teal-400">{it.code}</span>{' '}
                          <span className="text-foreground">{it.colour ?? it.name}</span>
                          {it.grade === 'B' && <span className="badge-purple ml-1">B</span>}
                          <span className="text-muted-foreground"> · {sizesLine(it.sizes)}</span>
                        </div>
                      ))}
                    </td>
                    <td className="whitespace-nowrap text-right font-semibold tabular-nums">{c.pieces}</td>
                    <td className="whitespace-nowrap">
                      <span className={`badge ${st.cls}`}>{st.label}</span>
                      {c.challan && <div className="text-muted-foreground mt-0.5 font-mono text-xs">{c.challan.dcNumber}</div>}
                    </td>
                    <td className="whitespace-nowrap text-right">
                      {c.status === 'PACKED' && (
                        <>
                          <button className="btn-ghost p-1.5" title="Print its sticker" onClick={() => printCartons([c.id], openPrintTab())} aria-label={`Print ${c.code}`}>
                            <Printer size={15} />
                          </button>
                          {!c.challan && can('inventory', 'edit') && (
                            <button className="btn-ghost p-1.5" title="Open the carton: its pieces back loose" onClick={() => setOpening(c)} aria-label={`Open ${c.code}`}>
                              <PackageOpen size={15} />
                            </button>
                          )}
                        </>
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
      {packing && (
        <PackCartonDialog
          onClose={() => setPacking(false)}
          onDone={(message) => {
            setPacking(false)
            onDone({ message })
            setStatus('PACKED')
            void load()
          }}
        />
      )}
    </div>
  )
}

/**
 * Cartons loaded onto a delivery challan: pick the order, then scan each
 * carton as it goes on the lorry — or pick it from the list. The first one
 * starts the challan; its lines are what the cartons hold.
 */
function DispatchCartons({ onDone }: { onDone: (d: { message: string; link?: { href: string; label: string } }) => void }) {
  const [orders, setOrders] = useState<CartonOrder[]>([])
  const [soId, setSoId] = useState('')
  const [load, setLoad] = useState<Loading | null>(null)
  const [available, setAvailable] = useState<Carton[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [vehicle, setVehicle] = useState('')
  const [lr, setLr] = useState('')
  const [transporter, setTransporter] = useState('')

  const refresh = useCallback(async () => {
    const r = await api.get<{ data: CartonOrder[] }>('/fg-cartons/dispatch/orders')
    setOrders(r.data)
  }, [])
  useEffect(() => {
    void refresh().catch(() => setError('Could not load the orders.'))
  }, [refresh])
  const loadAvailable = useCallback(async (id: string) => {
    if (!id) return setAvailable([])
    const r = await api.get<{ data: Carton[] }>(`/fg-cartons/dispatch/available?soId=${id}`)
    setAvailable(r.data)
  }, [])

  const order = orders.find((o) => o.soId === soId)
  const openDraft = async (dcId: string) => {
    const r = await api.get<{ data: Loading }>(`/fg-cartons/dispatch/${dcId}`)
    setLoad(r.data)
  }
  const pickOrder = async (id: string) => {
    setSoId(id)
    setLoad(null)
    setError(null)
    const o = orders.find((x) => x.soId === id)
    // A challan already being loaded for the order carries on.
    if (o?.drafts.length === 1) await openDraft(o.drafts[0].dcId).catch(() => {})
    await loadAvailable(id).catch(() => setAvailable([]))
  }

  const add = async (code: string) => {
    if (!soId) return setError('Pick the order first.')
    setBusy(true)
    setError(null)
    try {
      const r = await api.post<{ data: Loading }>('/fg-cartons/dispatch/scan', { soId, dcId: load?.dcId ?? null, code })
      setLoad(r.data)
      await loadAvailable(soId)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load that carton.')
    } finally {
      setBusy(false)
    }
  }

  const takeOff = async (cartonId: string) => {
    if (!load) return
    setBusy(true)
    try {
      const r = await api.delete<{ message: string; data: Loading | null }>(`/fg-cartons/dispatch/${load.dcId}/cartons/${cartonId}`)
      setLoad(r.data)
      if (!r.data) {
        setError(r.message)
        await refresh()
      }
      await loadAvailable(soId)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not take it off.')
    } finally {
      setBusy(false)
    }
  }

  const dispatch = async () => {
    if (!load) return
    setBusy(true)
    setError(null)
    try {
      const r = await api.post<{ message: string }>(`/fg-cartons/dispatch/${load.dcId}/dispatch`, { vehicleNumber: vehicle || null, lrNumber: lr || null, transporter: transporter || null })
      onDone({ message: r.message, link: { href: `/print/delivery-challan/${load.dcId}`, label: 'Print challan' } })
      setLoad(null)
      setVehicle('')
      setLr('')
      setTransporter('')
      await refresh()
      await loadAvailable(soId)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not dispatch.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]">
      <div className="glass-card space-y-3 p-4">
        <div>
          <label className="form-label">Sales order</label>
          <SmartSelect className="form-input h-11" value={soId} onChange={(e) => void pickOrder(e.target.value)} aria-label="Sales order">
            <option value="">{orders.length ? 'Pick the order to send…' : 'No open order'}</option>
            {orders.map((o) => (
              <option key={o.soId} value={o.soId} data-sub={[o.customer, o.packed ? `${o.packed} packed for it` : '', o.poRef ? `PO ${o.poRef}` : ''].filter(Boolean).join(' · ')}>
                {o.soNumber}
              </option>
            ))}
          </SmartSelect>
        </div>
        {order && order.drafts.length > 0 && !load && (
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <span className="text-muted-foreground">Being loaded:</span>
            {order.drafts.map((d) => (
              <button key={d.dcId} className="btn-secondary h-8" onClick={() => void openDraft(d.dcId)}>
                {d.dcNumber} · {d.cartons} {d.cartons === 1 ? 'carton' : 'cartons'}
              </button>
            ))}
          </div>
        )}
        <Scanner onCode={(c) => void add(c)} busy={busy} placeholder={soId ? 'Scan a carton onto the challan' : 'Pick the order first'} />
        {error && (
          <p className="flex items-start gap-2 rounded-lg border border-red-500/40 bg-red-500/5 p-3 text-sm text-red-400" role="alert">
            <AlertTriangle size={16} className="mt-0.5 shrink-0" /> {error}
          </p>
        )}
        {soId && (
          <div className="space-y-1.5">
            <p className="text-foreground text-sm font-medium">Or pick from the cartons for it ({available.length})</p>
            {!available.length ? (
              <p className="text-muted-foreground text-xs">No carton in the store holds only this order&apos;s items. Pack one on the Cartons tab.</p>
            ) : (
              <ul className="border-border divide-border max-h-72 divide-y overflow-y-auto rounded-lg border">
                {available.map((c) => (
                  <li key={c.id} className="flex items-center gap-2 px-3 py-2 text-sm">
                    <div className="min-w-0 flex-1">
                      <span className="font-mono font-semibold">{c.code}</span> <span className="text-muted-foreground">· {c.store.name} · {c.pieces} pcs</span>
                      <div className="text-muted-foreground truncate text-xs">{c.items.map((it) => `${it.code} ${it.colour ?? ''} ${sizesLine(it.sizes)}`).join(' | ')}</div>
                    </div>
                    <button className="btn-secondary h-8 shrink-0" disabled={busy} onClick={() => void add(c.code)} aria-label={`Load ${c.code}`}>
                      Load
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
        {load && (
          <div className="space-y-2 border-t border-border pt-3">
            <div className="grid grid-cols-3 gap-2">
              <input className="form-input h-10" placeholder="Vehicle no." value={vehicle} onChange={(e) => setVehicle(e.target.value)} aria-label="Vehicle number" />
              <input className="form-input h-10" placeholder="LR no." value={lr} onChange={(e) => setLr(e.target.value)} aria-label="LR number" />
              <input className="form-input h-10" placeholder="Transporter" value={transporter} onChange={(e) => setTransporter(e.target.value)} aria-label="Transporter" />
            </div>
            <button className="btn-primary h-12 w-full justify-center text-base" disabled={busy || !load.cartons.length} onClick={() => void dispatch()}>
              {busy ? <Loader2 size={18} className="animate-spin" /> : <Truck size={18} />}
              Dispatch {load.cartons.length} {load.cartons.length === 1 ? 'carton' : 'cartons'} on {load.dcNumber}
            </button>
            <p className="text-xs text-muted-foreground">The stock drops by exactly what these cartons hold. Until then they stay in the store, held for this challan.</p>
          </div>
        )}
      </div>

      <div className="glass-card overflow-hidden p-0">
        {load ? (
          <>
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-border px-4 py-2 text-sm">
              <span className="font-mono font-semibold text-foreground">{load.dcNumber}</span>
              <span className="text-muted-foreground">
                {order?.soNumber} · {order?.customer} · from {load.store?.name}
              </span>
              <span className="ml-auto font-bold text-foreground">
                {load.cartons.length} {load.cartons.length === 1 ? 'carton' : 'cartons'} · {load.pieces} pcs
              </span>
            </div>
            <div className="flex flex-wrap gap-2 border-b border-border px-4 py-2">
              {load.bySize.map((s) => (
                <span key={s.code} className="rounded-lg border border-border bg-secondary px-2.5 py-1 text-sm">
                  <span className="font-semibold">{s.code}</span> <span className="font-bold text-primary">× {s.qty}</span>
                </span>
              ))}
            </div>
            <ul className="divide-border divide-y">
              {load.cartons.map((c) => (
                <li key={c.id} className="flex items-start gap-3 px-4 py-2 text-sm">
                  <div className="min-w-0 flex-1">
                    <span className="font-mono font-semibold">{c.code}</span> <span className="text-muted-foreground">· {c.pieces} pcs</span>
                    {c.items.map((it) => (
                      <div key={`${it.itemId}|${it.grade}`} className="text-muted-foreground text-xs">
                        {it.style} · {it.code} {it.colour ?? it.name}
                        {it.grade === 'B' ? ' (B)' : ''} · {sizesLine(it.sizes)}
                      </div>
                    ))}
                  </div>
                  <button className="btn-ghost p-1.5" disabled={busy} onClick={() => void takeOff(c.id)} aria-label={`Take ${c.code} off`}>
                    <X size={15} />
                  </button>
                </li>
              ))}
            </ul>
          </>
        ) : (
          <p className="p-10 text-center text-muted-foreground">Pick the order, then scan or pick each carton as it is loaded. The first one starts the challan.</p>
        )}
      </div>
    </div>
  )
}
