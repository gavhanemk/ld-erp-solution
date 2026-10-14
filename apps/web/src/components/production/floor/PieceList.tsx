'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { ArrowLeft, ExternalLink, Loader2, Search } from 'lucide-react'
import { api, ApiError } from '@/lib/api'
import { GarmentTrace, type GarmentStory } from '@/components/trace/GarmentTrace'
import { GARMENT_STATUS, badge } from '@/components/trace/traceTypes'
import type { SheetPiece } from './BundleTable'

/**
 * The job card's pieces, each with its own tag: which bundle it was sewn in,
 * its size, where it is now. Picking one shows its whole history here — from
 * the order to today — without leaving the sheet.
 */
export function PieceList({ pieces, code, onCode }: { pieces: SheetPiece[]; code: string | null; onCode: (code: string | null) => void }) {
  const [q, setQ] = useState('')
  const [story, setStory] = useState<GarmentStory | null>(null)
  const [error, setError] = useState<string | null>(null)
  const topRef = useRef<HTMLDivElement>(null)

  // A piece opened from a bundle further down: brought into view.
  useEffect(() => {
    if (code) topRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }, [code])

  useEffect(() => {
    if (!code) {
      setStory(null)
      return
    }
    let live = true
    setStory(null)
    setError(null)
    api
      .get<{ data: GarmentStory }>(`/trace/garment/${encodeURIComponent(code)}`)
      .then((r) => live && setStory(r.data))
      .catch((err) => live && setError(err instanceof ApiError ? err.message : 'Could not open its history.'))
    return () => {
      live = false
    }
  }, [code])

  const rows = useMemo(() => {
    const s = q.trim().toLowerCase()
    return s ? pieces.filter((p) => [p.code, p.size?.code ?? '', p.bundle?.code ?? '', p.status].some((v) => v.toLowerCase().includes(s))) : pieces
  }, [pieces, q])

  if (code) {
    return (
      <div ref={topRef} className="scroll-mt-4 space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" className="btn-secondary h-9" onClick={() => onCode(null)}>
            <ArrowLeft size={15} /> All pieces
          </button>
          <a href={`/inventory/trace?g=${encodeURIComponent(code)}`} target="_blank" rel="noreferrer" className="btn-ghost h-9">
            <ExternalLink size={15} /> Open in Track &amp; Trace
          </a>
        </div>
        {error ? (
          <p className="text-destructive text-sm">{error}</p>
        ) : !story ? (
          <p className="text-muted-foreground flex items-center gap-2 py-6 text-sm">
            <Loader2 size={16} className="animate-spin" /> Putting its history together…
          </p>
        ) : (
          <GarmentTrace g={story} open={(t) => window.open(`/inventory/trace?${t.kind}=${encodeURIComponent(t.id)}`, '_blank')} />
        )}
      </div>
    )
  }

  if (!pieces.length) {
    return (
      <p className="text-muted-foreground p-4 text-sm">
        No tagged pieces yet. Each piece gets its own tag — and its own history — when it goes into finished goods; until then the pieces are tracked bundle by bundle.
      </p>
    )
  }

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <div className="border-field-edge bg-field flex min-w-0 flex-1 items-center gap-2 rounded-lg border px-2 py-1.5 sm:max-w-xs">
          <Search size={14} className="text-muted-foreground shrink-0" />
          <input className="text-foreground min-w-0 flex-1 border-0 bg-transparent text-sm outline-none" placeholder="Tag, size or bundle…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Find a piece" />
        </div>
        <span className="text-muted-foreground text-xs">
          {rows.length} of {pieces.length} pieces · pick one to see its history
        </span>
      </div>
      <div className="border-border max-h-[60vh] overflow-auto rounded-lg border">
        <table className="data-table w-full min-w-[640px]">
          <thead className="sticky top-0 z-10 [&_th]:bg-secondary">
            <tr>
              <th>Tag</th>
              <th>Bundle</th>
              <th>Size</th>
              <th>Grade</th>
              <th>Where now</th>
              <th>Label</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.map((p) => {
              const st = badge(GARMENT_STATUS, p.status)
              return (
                <tr key={p.id} className="cursor-pointer" onClick={() => onCode(p.code)}>
                  <td className="text-primary font-mono text-xs font-semibold">{p.code}</td>
                  <td className="font-mono text-xs">{p.bundle?.code ?? '—'}</td>
                  <td className="font-semibold">{p.size?.code ?? '—'}</td>
                  <td>{p.grade === 'B' ? <span className="badge badge-warning">B</span> : 'A'}</td>
                  <td className="whitespace-nowrap">
                    <span className={`badge ${st.cls}`}>{st.label}</span>
                    {p.status !== 'DISPATCHED' && p.warehouse && <span className="text-muted-foreground text-xs"> {p.warehouse.name}</span>}
                  </td>
                  <td className="text-muted-foreground text-xs">{p.printCount ? 'Printed' : 'Not printed'}</td>
                  <td className="text-primary text-right text-xs font-medium">History →</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}
