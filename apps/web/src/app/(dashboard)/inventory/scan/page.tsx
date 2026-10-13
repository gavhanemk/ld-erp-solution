'use client'

import { Suspense, useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { useRouter, useSearchParams } from 'next/navigation'
import { AlertTriangle, CheckCircle2, Loader2, Package, Tags } from 'lucide-react'
import { api, ApiError } from '@/lib/api'
import { Scanner } from '@/components/packages/Scanner'
import { PackageCard } from '@/components/packages/PackageCard'
import type { PackageDetail } from '@/components/packages/packageTypes'
import { GarmentCard, looksLikeGarment, type GarmentDetail } from '@/components/packages/GarmentCard'

/**
 * The store's one screen for a sticker: scan it, see what it is, act on it.
 *
 * Built for a phone held in one hand as much as a desk with a scanner gun:
 * one box that takes the scan, big type, big buttons, and the next scan ready
 * as soon as the last one is done.
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

  const find = useCallback(
    async (code: string) => {
      setBusy(true)
      setError(null)
      setMessage(null)
      try {
        if (looksLikeGarment(code)) {
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
      } finally {
        setBusy(false)
      }
    },
    [router],
  )

  // Opened from a link to one package.
  const linked = params.get('code')
  useEffect(() => {
    if (linked && linked !== pkg?.code && linked !== garment?.code) void find(linked)
    // Only when the link changes, not after every action on the package.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [linked])

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

      <div className="glass-card p-4">
        <Scanner onCode={(c) => void find(c)} busy={busy} />
      </div>

      {busy && !pkg && (
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 size={16} className="animate-spin" /> Looking it up…
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

      {garment ? (
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
