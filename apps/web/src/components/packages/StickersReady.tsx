'use client'

import { useEffect, useState } from 'react'
import { Printer, Tags, X } from 'lucide-react'
import { api, ApiError } from '@/lib/api'
import { openPrintTab, printLabels, qtyText } from './packageTypes'
import type { InwardRef } from './InwardStickers'

interface Ready {
  count: number
  groups: Array<{ key: string; sourceRef: string | null; item: string; store: string; unit: string; qty: number; ids: string[] }>
}

/**
 * The note in the corner after stock comes in: its stickers were made by
 * themselves, here they are to print. Nothing to fill in and nothing in the
 * way — "Later" leaves them on Packages & Stickers → Ready to print.
 */
export function StickersReady({ source, onClose, onDone }: { source: InwardRef; onClose: () => void; onDone?: (message: string) => void }) {
  const [ready, setReady] = useState<Ready | null>(null)

  useEffect(() => {
    let live = true
    api
      .get<{ data: Ready }>(`/packages/ready?${new URLSearchParams({ sourceType: source.type, sourceId: source.id })}`)
      .then((r) => {
        if (!live) return
        if (!r.data.count) return onClose()
        setReady(r.data)
      })
      .catch(() => live && onClose())
    return () => {
      live = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source.type, source.id])

  if (!ready) return null
  const ids = ready.groups.flatMap((g) => g.ids)
  const ref = ready.groups[0]?.sourceRef

  return (
    <div className="border-border bg-card fixed bottom-4 right-4 z-50 w-[min(26rem,calc(100vw-2rem))] rounded-xl border p-4 shadow-xl" role="status">
      <div className="flex items-start gap-3">
        <span className="bg-primary/10 text-primary flex h-9 w-9 shrink-0 items-center justify-center rounded-lg">
          <Tags size={18} />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-foreground font-semibold">
            {ready.count} {ready.count === 1 ? 'sticker' : 'stickers'} made{ref ? ` for ${ref}` : ''}
          </p>
          <ul className="text-muted-foreground mt-0.5 space-y-0.5 text-xs">
            {ready.groups.slice(0, 3).map((g) => (
              <li key={g.key} className="truncate">
                {g.item} — {g.ids.length} × ({qtyText(g.qty / g.ids.length)} {g.unit}) · {g.store}
              </li>
            ))}
            {ready.groups.length > 3 && <li>and {ready.groups.length - 3} more</li>}
          </ul>
          <div className="mt-3 flex items-center gap-2">
            <button
              type="button"
              className="btn-primary h-9"
              onClick={() => {
                printLabels(ids)
                onDone?.(`The stickers for ${ref ?? 'it'} have opened in a new tab: press Print there.`)
                onClose()
              }}
            >
              <Printer size={15} /> Print now
            </button>
            <button type="button" className="btn-secondary h-9" onClick={onClose}>
              Later
            </button>
          </div>
        </div>
        <button type="button" className="text-muted-foreground hover:text-foreground" onClick={onClose} aria-label="Close">
          <X size={16} />
        </button>
      </div>
    </div>
  )
}

/**
 * "Print stickers" on a document: makes any stickers it has not had yet, by
 * the item rules, and opens all of its stickers to print. Call it from the
 * click itself, so the print tab is not blocked as a pop-up.
 */
export async function printDocStickers(source: { type: InwardRef['type']; id: string }): Promise<string> {
  const tab = openPrintTab()
  try {
    const res = await api.post<{ data: { made: number; ids: string[] } }>('/packages/auto', { sourceType: source.type, sourceId: source.id })
    if (!res.data.ids.length) {
      tab?.close()
      return 'Nothing to print: none of it is in stock with a sticker any more.'
    }
    printLabels(res.data.ids, tab)
    return `${res.data.ids.length} ${res.data.ids.length === 1 ? 'sticker has' : 'stickers have'} opened in a new tab: press Print there.`
  } catch (err) {
    tab?.close()
    return err instanceof ApiError ? err.message : 'Could not open the stickers.'
  }
}
