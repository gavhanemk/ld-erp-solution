'use client'

import { useEffect, useState } from 'react'
import { Loader2 } from 'lucide-react'
import { api } from '@/lib/api'

/**
 * The code a new style will get, shown while the form is filled in. Brand,
 * garment type and season decide it — LD-SH-2606 is the sixth LD Cotton Mills
 * shirt for a 26 season. The server works it out again when the style is
 * saved, so it is always the next free one even if somebody saved a shirt in
 * between.
 */
export function NextStyleCode({ brandType, category, season }: { brandType?: unknown; category?: unknown; season?: unknown }) {
  const [code, setCode] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const brand = typeof brandType === 'string' ? brandType : ''
  const type = typeof category === 'string' ? category.trim() : ''
  const year = typeof season === 'string' ? season.trim() : ''

  useEffect(() => {
    if (!brand) {
      setCode(null)
      return
    }
    let live = true
    setBusy(true)
    // Typing settles for a moment before asking.
    const t = setTimeout(() => {
      const qs = new URLSearchParams({ brandType: brand, category: type, season: year })
      api
        .get<{ data: { code: string } }>(`/masters/styles/next-code?${qs}`)
        .then((r) => live && setCode(r.data.code))
        .catch(() => live && setCode(null))
        .finally(() => live && setBusy(false))
    }, 250)
    return () => {
      live = false
      clearTimeout(t)
    }
  }, [brand, type, year])

  if (!brand) return <span className="text-muted-foreground text-sm">Pick the brand: the code follows from it</span>
  return (
    <span className="flex items-center gap-2">
      <span className="text-foreground font-mono text-sm font-semibold tracking-wide">{code ?? '…'}</span>
      {busy && <Loader2 size={13} className="text-muted-foreground animate-spin" aria-hidden />}
    </span>
  )
}
