'use client'

import { Suspense, useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { useRouter, useSearchParams } from 'next/navigation'
import { AlertTriangle, CheckCircle2, Loader2, MapPin, Package, Tags, X } from 'lucide-react'
import { api, ApiError, can } from '@/lib/api'
import { Scanner } from '@/components/packages/Scanner'
import { PackageCard } from '@/components/packages/PackageCard'
import { RackInput, useRacks } from '@/components/packages/RackInput'
import { qtyText, type PackageDetail } from '@/components/packages/packageTypes'
import { GarmentCard, looksLikeGarment, type GarmentDetail } from '@/components/packages/GarmentCard'

/** A sticker just scanned onto a rack. */
interface PutAway {
  id: string
  code: string
  item: string
  qty: number
  unit: string
  store: string
  rack: string
  was: string | null
  changed: boolean
}

/**
 * The store's one screen for a sticker: scan it, see what it is, act on it.
 *
 * Built for a phone held in one hand as much as a desk with a scanner gun:
 * one box that takes the scan, big type, big buttons, and the next scan ready
 * as soon as the last one is done.
 *
 * With a rack typed in, scanning puts stock away instead: every sticker
 * scanned goes on that rack, one after another.
 */
function ScanScreen() {
  const params = useSearchParams()
  const router = useRouter()
  const [pkg, setPkg] = useState<PackageDetail | null>(null)
  // A garment's own tag (G-…) rather than a package of stock (PK-…).
  const [garment, setGarment] = useState<GarmentDetail | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  // Putting away: the rack, and what has gone on it this time.
  const mayPutAway = can('inventory', 'edit')
  const racks = useRacks()
  const [rack, setRack] = useState('')
  const [putAway, setPutAway] = useState<PutAway[]>([])
  const [focusKey, setFocusKey] = useState(0)
  const onRack = rack.trim()

  const find = useCallback(
    async (code: string) => {
      setBusy(true)
      setError(null)
      setMessage(null)
      try {
        if (onRack) {
          const res = await api.post<{ message: string; data: PutAway }>('/packages/put-away', { code, rack: onRack })
          setPkg(null)
          setGarment(null)
          setPutAway((p) => [res.data, ...p.filter((x) => x.id !== res.data.id)].slice(0, 50))
          setMessage(res.message)
        } else if (looksLikeGarment(code)) {
          const res = await api.get<{ data: GarmentDetail }>(`/garments/scan/${encodeURIComponent(code)}`)
          setPkg(null)
          setGarment(res.data)
          router.replace(`/inventory/scan?code=${res.data.code}`, { scroll: false })
        } else {
          const res = await api.get<{ data: PackageDetail }>(`/packages/scan/${encodeURIComponent(code)}`)
          setGarment(null)
          setPkg(res.data)
          router.replace(`/inventory/scan?code=${res.data.code}`, { scroll: false })
        }
      } catch (err) {
        setPkg(null)
        setGarment(null)
        setError(err instanceof ApiError ? err.message : 'Could not look that up. Is the API running?')
        if (onRack) navigator.vibrate?.([80, 60, 80])
      } finally {
        setBusy(false)
      }
    },
    [router, onRack],
  )

  // Opened from a link to one package.
  const linked = params.get('code')
  useEffect(() => {
    if (linked && linked !== pkg?.code && linked !== garment?.code) void find(linked)
    // Only when the link changes, not after every action on the package.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [linked])

  const stopPutAway = () => {
    setRack('')
    setPutAway([])
    setMessage(null)
    setError(null)
    setFocusKey((k) => k + 1)
  }

  return (
    <div className="mx-auto max-w-5xl space-y-4">
      <div className="page-header">
        <div>
          <h1 className="page-title">Scan</h1>
          <p className="page-subtitle">Scan a package sticker to issue, move or split it, or a garment tag to see where it came from</p>
        </div>
        <Link href="/inventory/packages" className="btn-ghost">
          <Tags size={15} /> Stickers
        </Link>
      </div>

      <div className="glass-card space-y-3 p-4">
        <Scanner onCode={(c) => void find(c)} busy={busy} focusKey={focusKey} placeholder={onRack ? `Scan stickers for rack ${onRack}` : undefined} />
        {mayPutAway && (
          <div className={`flex flex-wrap items-center gap-2 rounded-lg border p-2.5 ${onRack ? 'border-primary/50 bg-primary/5' : 'border-dashed border-border'}`}>
            <MapPin size={16} className="shrink-0 text-primary" />
            <span className="text-sm font-medium text-foreground">Putting stock on a rack?</span>
            <RackInput
              value={rack}
              onChange={setRack}
              racks={racks}
              className="form-input h-9 w-32"
              placeholder="e.g. B-3"
              label="Rack to put stock on"
              // Done typing: back to the scan box for the stickers.
              onEnter={() => setFocusKey((k) => k + 1)}
            />
            {onRack ? (
              <>
                <span className="text-sm text-foreground">
                  Every sticker scanned now goes on rack <span className="font-semibold">{onRack}</span>.
                </span>
                <button type="button" className="btn-ghost ml-auto h-9" onClick={stopPutAway}>
                  <X size={15} /> Done
                </button>
              </>
            ) : (
              <span className="text-xs text-muted-foreground">Type the rack, then scan each sticker on it.</span>
            )}
          </div>
        )}
      </div>

      {busy && !pkg && (
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 size={16} className="animate-spin" /> {onRack ? 'Putting it on the rack…' : 'Looking it up…'}
        </p>
      )}
      {error && (
        <div className="flex items-start gap-3 rounded-xl border border-red-500/40 bg-red-500/5 p-4 text-red-400">
          <AlertTriangle size={20} className="mt-0.5 shrink-0" />
          <p className="text-base">{error}</p>
        </div>
      )}
      {message && (
        <div className="flex items-start gap-3 rounded-xl border border-emerald-500/40 bg-emerald-500/10 p-4 text-emerald-600">
          <CheckCircle2 size={20} className="mt-0.5 shrink-0" />
          <p className="text-base font-medium">{message}</p>
        </div>
      )}

      {onRack ? (
        putAway.length > 0 && (
          <div className="glass-card overflow-hidden p-0">
            <div className="flex items-center gap-2 border-b border-border px-4 py-3">
              <MapPin size={16} className="text-primary" />
              <h3 className="text-sm font-semibold text-foreground">Put away just now ({putAway.length})</h3>
            </div>
            <div className="divide-y divide-border/60">
              {putAway.map((p) => (
                <div key={p.id} className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 px-4 py-2.5 text-sm">
                  <Link href={`/inventory/scan?code=${p.code}`} onClick={stopPutAway} className="font-mono font-semibold text-primary hover:underline">
                    {p.code}
                  </Link>
                  <span className="min-w-0 flex-1 text-foreground">
                    {p.item} <span className="text-muted-foreground">· {qtyText(p.qty)} {p.unit} · {p.store}</span>
                  </span>
                  <span className="font-semibold text-foreground">
                    Rack {p.rack}
                    {p.was && p.was !== p.rack && <span className="font-normal text-muted-foreground"> (was {p.was})</span>}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )
      ) : garment ? (
        <GarmentCard key={garment.id} g={garment} onChange={setGarment} onDone={setMessage} />
      ) : pkg ? (
        <PackageCard key={pkg.id} pkg={pkg} onChange={setPkg} onDone={setMessage} />
      ) : (
        !busy &&
        !error && (
          <div className="glass-card flex flex-col items-center gap-3 p-10 text-center">
            <Package size={36} className="text-muted-foreground" />
            <p className="max-w-md text-muted-foreground">
              Scan the QR on a box, roll or carton. With a scanner gun, just scan — the box above is ready. On a phone, press{' '}
              <span className="font-semibold text-foreground">Use camera</span>.
            </p>
          </div>
        )
      )}
    </div>
  )
}

export default function ScanPage() {
  return (
    <Suspense fallback={null}>
      <ScanScreen />
    </Suspense>
  )
}
