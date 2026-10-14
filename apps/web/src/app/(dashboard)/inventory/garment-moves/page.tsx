'use client'

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { AlertTriangle, ArrowLeftRight, CheckCircle2, Loader2, PackageX, Printer, Truck, Undo2, X } from 'lucide-react'
import { api, ApiError } from '@/lib/api'
import { Scanner } from '@/components/packages/Scanner'
import { SmartSelect } from '@/components/ui/SmartSelect'

type Tab = 'dispatch' | 'move' | 'return' | 'scrap'

interface Checked {
  id: string
  code: string
  what: string
  grade: string
  store: string
  warehouseId: string
  dcNumber: string | null
  invoice: string | null
  problem: string | null
}

interface Loading {
  dcId: string
  dcNumber: string
  status: string
  soNumber: string
  customer: string
  store: string
  pieces: Array<{ id: string; code: string; grade: string; size: string; what: string }>
  bySize: Array<{ what: string; size: string; grade: string; n: number }>
}

interface OrderToSend {
  soId: string
  soNumber: string
  poRef: string | null
  customer: string
  ready: number
  drafts: Array<{ dcId: string; dcNumber: string; store: string; pieces: number }>
}

const TABS: Array<{ key: Tab; label: string; icon: typeof Truck; hint: string }> = [
  { key: 'dispatch', label: 'Dispatch', icon: Truck, hint: 'Scan pieces onto the delivery challan, then dispatch it' },
  { key: 'move', label: 'Move', icon: ArrowLeftRight, hint: 'Scan pieces going to another store' },
  { key: 'return', label: 'Return in', icon: Undo2, hint: 'Scan pieces a customer sent back; a credit note is made' },
  { key: 'scrap', label: 'Write off', icon: PackageX, hint: 'Scan damaged pieces; a store manager approves before stock leaves' },
]

const beep = (ok: boolean) => {
  try {
    navigator.vibrate?.(ok ? 60 : [80, 60, 80])
    const ctx = new AudioContext()
    const o = ctx.createOscillator()
    o.frequency.value = ok ? 880 : 220
    o.connect(ctx.destination)
    o.start()
    o.stop(ctx.currentTime + (ok ? 0.08 : 0.3))
  } catch {
    /* no sound: fine */
  }
}

/**
 * Finished garments in and out by scanning: onto a challan and dispatched,
 * to another store, back from a customer, written off. A scan only puts a
 * piece on the list; nothing moves until the button under the list is pressed.
 */
export default function GarmentMovesPage() {
  const [tab, setTab] = useState<Tab>('dispatch')
  const [done, setDone] = useState<{ message: string; available?: Array<{ item: string; size: string; grade: string; qty: number }>; link?: { href: string; label: string } } | null>(null)

  return (
    <div className="mx-auto max-w-6xl space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <h1 className="page-title mr-auto">Garment In / Out</h1>
        <Link href="/inventory/garment-tags" className="btn-ghost h-9">
          Garment tags
        </Link>
      </div>

      <div className="inline-flex flex-wrap rounded-lg border border-border bg-secondary p-0.5" role="tablist">
        {TABS.map((t) => (
          <button
            key={t.key}
            role="tab"
            aria-selected={tab === t.key}
            onClick={() => {
              setTab(t.key)
              setDone(null)
            }}
            className={`flex h-10 items-center gap-2 rounded-md px-4 text-sm font-semibold ${tab === t.key ? 'bg-card text-primary shadow-sm' : 'text-muted-foreground hover:text-foreground'}`}
          >
            <t.icon size={16} /> {t.label}
          </button>
        ))}
      </div>
      <p className="text-sm text-muted-foreground">{TABS.find((t) => t.key === tab)?.hint}</p>

      {done && (
        <div className="rounded-xl border border-emerald-500/40 bg-emerald-500/10 p-3 text-emerald-600">
          <div className="flex items-start gap-3">
            <CheckCircle2 size={20} className="mt-0.5 shrink-0" />
            <p className="flex-1 text-base font-semibold">{done.message}</p>
            {done.link && (
              <a href={done.link.href} target="_blank" rel="noreferrer" className="btn-secondary h-9 shrink-0">
                <Printer size={15} /> {done.link.label}
              </a>
            )}
            <button onClick={() => setDone(null)} aria-label="Dismiss">
              <X size={16} />
            </button>
          </div>
          {done.available && done.available.length > 0 && (
            <p className="mt-1 pl-8 text-sm text-foreground">
              Now in stock:{' '}
              {done.available.map((a, i) => (
                <span key={i}>
                  {i > 0 && ' · '}
                  {a.item} size {a.size}
                  {a.grade === 'B' ? ' (B)' : ''} <span className="font-bold">{a.qty}</span>
                </span>
              ))}
            </p>
          )}
        </div>
      )}

      {tab === 'dispatch' ? <DispatchTab onDone={setDone} /> : <ListTab key={tab} action={tab} onDone={setDone} />}
    </div>
  )
}

/** Dispatch: an order, its challan being loaded, the pieces scanned onto it. */
function DispatchTab({ onDone }: { onDone: (d: { message: string; available?: Array<{ item: string; size: string; grade: string; qty: number }>; link?: { href: string; label: string } }) => void }) {
  const [orders, setOrders] = useState<OrderToSend[]>([])
  const [soId, setSoId] = useState('')
  const [load, setLoad] = useState<Loading | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [vehicle, setVehicle] = useState('')
  const [lr, setLr] = useState('')
  const [cartons, setCartons] = useState('')

  const refresh = useCallback(async () => {
    const r = await api.get<{ data: OrderToSend[] }>('/garments/dispatch/orders')
    setOrders(r.data)
  }, [])
  useEffect(() => {
    void refresh().catch(() => setError('Could not load the orders.'))
  }, [refresh])

  const order = orders.find((o) => o.soId === soId)
  const openDraft = async (dcId: string) => {
    const r = await api.get<{ data: Loading }>(`/garments/dispatch/${dcId}`)
    setLoad(r.data)
  }
  const pickOrder = async (id: string) => {
    setSoId(id)
    setLoad(null)
    setError(null)
    const o = orders.find((x) => x.soId === id)
    // A challan already being loaded for the order carries on.
    if (o?.drafts.length === 1) await openDraft(o.drafts[0].dcId).catch(() => {})
  }

  const scan = async (code: string) => {
    if (!soId) {
      setError('Pick the order first.')
      beep(false)
      return
    }
    setBusy(true)
    setError(null)
    try {
      const r = await api.post<{ data: Loading }>('/garments/dispatch/scan', { soId, dcId: load?.dcId ?? null, code })
      setLoad(r.data)
      beep(true)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not add that piece.')
      beep(false)
    } finally {
      setBusy(false)
    }
  }

  const takeOff = async (id: string) => {
    if (!load) return
    setBusy(true)
    try {
      const r = await api.delete<{ message: string; data: Loading | null }>(`/garments/dispatch/${load.dcId}/pieces/${id}`)
      setLoad(r.data)
      if (!r.data) {
        setError(r.message)
        await refresh()
      }
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
      const r = await api.post<{ message: string; data: { available: Array<{ item: string; size: string; grade: string; qty: number }> } }>(
        `/garments/dispatch/${load.dcId}/dispatch`,
        { vehicleNumber: vehicle || null, lrNumber: lr || null, cartons: cartons ? Number(cartons) : null },
      )
      onDone({ message: r.message, available: r.data.available, link: { href: `/print/delivery-challan/${load.dcId}`, label: 'Print challan' } })
      setLoad(null)
      setVehicle('')
      setLr('')
      setCartons('')
      await refresh()
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
          <SmartSelect className="form-input h-11" value={soId} onChange={(e) => void pickOrder(e.target.value)}>
            <option value="">{orders.length ? 'Pick the order to send…' : 'No order has tagged pieces to send'}</option>
            {orders.map((o) => (
              <option key={o.soId} value={o.soId}>
                {o.soNumber} · {o.customer} · {o.ready} ready{o.poRef ? ` · PO ${o.poRef}` : ''}
              </option>
            ))}
          </SmartSelect>
        </div>
        {order && order.drafts.length > 0 && !load && (
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <span className="text-muted-foreground">Being loaded:</span>
            {order.drafts.map((d) => (
              <button key={d.dcId} className="btn-secondary h-8" onClick={() => void openDraft(d.dcId)}>
                {d.dcNumber} · {d.pieces} pcs
              </button>
            ))}
          </div>
        )}
        <Scanner onCode={(c) => void scan(c)} busy={busy} placeholder={soId ? 'Scan a garment onto the challan' : 'Pick the order first'} />
        {error && (
          <p className="flex items-start gap-2 rounded-lg border border-red-500/40 bg-red-500/5 p-3 text-sm text-red-400">
            <AlertTriangle size={16} className="mt-0.5 shrink-0" /> {error}
          </p>
        )}
        {load && (
          <div className="space-y-2 border-t border-border pt-3">
            <div className="grid grid-cols-3 gap-2">
              <input className="form-input h-10" placeholder="Vehicle no." value={vehicle} onChange={(e) => setVehicle(e.target.value)} aria-label="Vehicle number" />
              <input className="form-input h-10" placeholder="LR no." value={lr} onChange={(e) => setLr(e.target.value)} aria-label="LR number" />
              <input className="form-input h-10" placeholder="Cartons" inputMode="numeric" value={cartons} onChange={(e) => setCartons(e.target.value.replace(/\D/g, ''))} aria-label="Cartons" />
            </div>
            <button className="btn-primary h-12 w-full justify-center text-base" disabled={busy || !load.pieces.length} onClick={() => void dispatch()}>
              {busy ? <Loader2 size={18} className="animate-spin" /> : <Truck size={18} />}
              Dispatch {load.pieces.length} {load.pieces.length === 1 ? 'piece' : 'pieces'} on {load.dcNumber}
            </button>
            <p className="text-xs text-muted-foreground">Stock drops by exactly these pieces. Until then they are held for this challan.</p>
          </div>
        )}
      </div>

      <div className="glass-card overflow-hidden p-0">
        {load ? (
          <>
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-border px-4 py-2 text-sm">
              <span className="font-mono font-semibold text-foreground">{load.dcNumber}</span>
              <span className="text-muted-foreground">
                {load.soNumber} · {load.customer} · from {load.store}
              </span>
              <span className="ml-auto font-bold text-foreground">{load.pieces.length} {load.pieces.length === 1 ? 'piece' : 'pieces'}</span>
            </div>
            <div className="flex flex-wrap gap-2 border-b border-border px-4 py-2">
              {load.bySize.map((s, i) => (
                <span key={i} className="rounded-lg border border-border bg-secondary px-2.5 py-1 text-sm">
                  {s.what} · <span className="font-semibold">{s.size}</span>
                  {s.grade === 'B' ? ' (B)' : ''} <span className="font-bold text-primary">× {s.n}</span>
                </span>
              ))}
            </div>
            <PieceRows rows={load.pieces.map((p) => ({ id: p.id, code: p.code, text: `${p.what} · size ${p.size}${p.grade === 'B' ? ' · B' : ''}` }))} onRemove={(id) => void takeOff(id)} busy={busy} />
          </>
        ) : (
          <p className="p-10 text-center text-muted-foreground">Pick the order, then scan each piece as it is loaded. The first scan starts the challan.</p>
        )}
      </div>
    </div>
  )
}

/** Move, return and write-off: scan into a list, then confirm the whole list. */
function ListTab({ action, onDone }: { action: Exclude<Tab, 'dispatch'>; onDone: (d: { message: string; available?: Array<{ item: string; size: string; grade: string; qty: number }> }) => void }) {
  const [list, setList] = useState<Checked[]>([])
  const [stores, setStores] = useState<Array<{ id: string; name: string }>>([])
  const [store, setStore] = useState('')
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    api
      .get<{ data: Array<{ id: string; name: string }> }>('/masters/warehouses?limit=100&active=true')
      .then((r) => setStores(r.data))
      .catch(() => {})
  }, [])

  const scan = async (code: string) => {
    setError(null)
    try {
      const r = await api.get<{ data: Checked }>(`/garments/check/${encodeURIComponent(code)}?for=${action}`)
      const g = r.data
      if (list.some((x) => x.id === g.id)) {
        setError(`${g.code} is already in this list.`)
        beep(false)
        return
      }
      if (g.problem) {
        setError(g.problem)
        beep(false)
        return
      }
      setList((l) => [g, ...l])
      beep(true)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not look that up.')
      beep(false)
    }
  }

  const confirm = async () => {
    setBusy(true)
    setError(null)
    try {
      const codes = list.map((g) => g.code)
      const r =
        action === 'move'
          ? await api.post<{ message: string; data: { available: Array<{ item: string; size: string; grade: string; qty: number }> } }>('/garments/move', { codes, toWarehouseId: store })
          : action === 'return'
            ? await api.post<{ message: string; data: { available: Array<{ item: string; size: string; grade: string; qty: number }> } }>('/garments/return', { codes, warehouseId: store, reason })
            : await api.post<{ message: string; data: { available?: undefined } }>('/garments/scrap', { codes, reason })
      onDone({ message: r.message, available: r.data.available })
      setList([])
      setReason('')
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save.')
    } finally {
      setBusy(false)
    }
  }

  const fromStores = [...new Set(list.map((g) => g.store))]
  const ready =
    list.length > 0 &&
    (action === 'move' ? Boolean(store) : action === 'return' ? Boolean(store) && reason.trim().length >= 3 : reason.trim().length >= 5)
  const n = list.length
  const verb =
    action === 'move'
      ? `Move ${n} ${n === 1 ? 'piece' : 'pieces'}${store ? ` to ${stores.find((s) => s.id === store)?.name ?? ''}` : ''}`
      : action === 'return'
        ? `Take ${n} ${n === 1 ? 'piece' : 'pieces'} back in`
        : `Put ${n} ${n === 1 ? 'piece' : 'pieces'} up for write-off`

  return (
    <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]">
      <div className="glass-card space-y-3 p-4">
        {action !== 'scrap' && (
          <div>
            <label className="form-label">{action === 'move' ? 'Move to store' : 'Back into store'}</label>
            <SmartSelect className="form-input h-11" value={store} onChange={(e) => setStore(e.target.value)}>
              <option value="">Pick the store…</option>
              {stores.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </SmartSelect>
          </div>
        )}
        {action !== 'move' && (
          <div>
            <label className="form-label">{action === 'return' ? 'Why they came back' : 'What is wrong with them'}</label>
            <input
              className="form-input h-11"
              placeholder={action === 'return' ? 'e.g. wrong size sent' : 'e.g. oil stain, torn seam'}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            />
          </div>
        )}
        <Scanner onCode={(c) => void scan(c)} busy={busy} placeholder="Scan a garment" />
        {error && (
          <p className="flex items-start gap-2 rounded-lg border border-red-500/40 bg-red-500/5 p-3 text-sm text-red-400">
            <AlertTriangle size={16} className="mt-0.5 shrink-0" /> {error}
          </p>
        )}
        <button className="btn-primary h-12 w-full justify-center text-base" disabled={busy || !ready} onClick={() => void confirm()}>
          {busy ? <Loader2 size={18} className="animate-spin" /> : action === 'move' ? <ArrowLeftRight size={18} /> : action === 'return' ? <Undo2 size={18} /> : <PackageX size={18} />}
          {verb}
        </button>
        <p className="text-xs text-muted-foreground">
          {action === 'move'
            ? 'One stock transfer note for the whole list; company stock stays the same.'
            : action === 'return'
              ? 'A return credit note against the invoice these pieces were billed on.'
              : 'A stock adjustment waits for a store manager. The pieces are held until it is decided.'}
          {fromStores.length > 1 && action !== 'return' ? ' The list has pieces from more than one store — that will be refused.' : ''}
        </p>
      </div>
      <div className="glass-card overflow-hidden p-0">
        {list.length ? (
          <>
            <div className="flex items-center border-b border-border px-4 py-2 text-sm">
              <span className="text-muted-foreground">Scanned</span>
              <span className="ml-auto font-bold text-foreground">{list.length} {list.length === 1 ? 'piece' : 'pieces'}</span>
            </div>
            <PieceRows
              rows={list.map((g) => ({ id: g.id, code: g.code, text: `${g.what}${g.grade === 'B' ? ' · B' : ''} · ${g.store}${action === 'return' && g.invoice ? ` · ${g.invoice}` : ''}` }))}
              onRemove={(id) => setList((l) => l.filter((x) => x.id !== id))}
              busy={busy}
            />
          </>
        ) : (
          <p className="p-10 text-center text-muted-foreground">Scan each piece. Nothing moves until the button is pressed.</p>
        )}
      </div>
    </div>
  )
}

function PieceRows({ rows, onRemove, busy }: { rows: Array<{ id: string; code: string; text: string }>; onRemove: (id: string) => void; busy: boolean }) {
  return (
    <ul className="max-h-[60vh] divide-y divide-border overflow-y-auto">
      {rows.map((r) => (
        <li key={r.id} className="flex items-center gap-3 px-4 py-1.5 text-sm">
          <span className="font-mono font-semibold text-primary">{r.code}</span>
          <span className="min-w-0 flex-1 truncate text-foreground">{r.text}</span>
          <button className="btn-ghost p-1 text-muted-foreground hover:text-red-400" disabled={busy} onClick={() => onRemove(r.id)} title="Take it off the list" aria-label={`Remove ${r.code}`}>
            <X size={15} />
          </button>
        </li>
      ))}
    </ul>
  )
}
