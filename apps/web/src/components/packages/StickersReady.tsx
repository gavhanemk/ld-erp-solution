'use client'

import { useCallback, useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { Printer, Tags, X } from 'lucide-react'
import { api, ApiError } from '@/lib/api'
import { useEscape } from '@/lib/useEscape'
import { openPrintTab, printLabels, qtyText } from './packageTypes'
import type { InwardRef } from './InwardStickers'
import { ChangeStickers } from './ChangeStickers'

interface Ready {
  count: number
  groups: Array<{ key: string; sourceRef: string | null; item: string; store: string; unit: string; qty: number; each?: number | null; packType?: string; ids: string[] }>
}

/**
 * The window in the middle of the screen after stock comes in: its stickers
 * were made by themselves, here they are to print. Nothing to fill in —
 * "Later" leaves them on Stickers → Ready to print.
 */
export function StickersReady({ source, onClose, onDone }: { source: InwardRef; onClose: () => void; onDone?: (message: string) => void }) {
  const [ready, setReady] = useState<Ready | null>(null)

  const load = useCallback(
    () =>
      api
        .get<{ data: Ready }>(`/packages/ready?${new URLSearchParams({ sourceType: source.type, sourceId: source.id })}`)
        .then((r) => r.data),
    [source.type, source.id],
  )

  useEffect(() => {
    let live = true
    load()
      .then((r) => {
        if (!live) return
        if (!r.count) return onClose()
        setReady(r)
      })
      .catch(() => live && onClose())
    return () => {
      live = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [load])

  if (!ready) return null
  return <ReadyWindow ready={ready} onClose={onClose} onDone={onDone} reload={() => load().then(setReady)} />
}

/** "1 sticker of 500 mtr", "5 stickers of 100 mtr", or "3 stickers, 250 mtr in all" when they differ. */
function stickerLine(g: Ready['groups'][number]) {
  const n = g.ids.length
  if (n === 1) return `1 sticker of ${qtyText(g.qty)} ${g.unit}`
  if (g.each != null) return `${n} stickers of ${qtyText(g.each)} ${g.unit} each`
  return `${n} stickers, ${qtyText(g.qty)} ${g.unit} in all`
}

function ReadyWindow({
  ready,
  onClose,
  onDone,
  reload,
}: {
  ready: Ready
  onClose: () => void
  onDone?: (message: string) => void
  reload: () => Promise<void>
}) {
  const ids = ready.groups.flatMap((g) => g.ids)
  const ref = ready.groups[0]?.sourceRef
  // One item's stickers being changed: how many, and how much on each.
  const [changing, setChanging] = useState<Ready['groups'][number] | null>(null)

  // Escape closes this window only — not the ones behind it.
  useEscape(() => {
    if (!changing) onClose()
  })

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-3 backdrop-blur-sm sm:left-[var(--sidebar-current-width)]">
      <div className="glass-card w-full max-w-md overflow-hidden" role="dialog" aria-modal="true" aria-labelledby="stickers-ready-title">
        <div className="flex items-start gap-3 p-5">
          <span className="bg-primary/10 text-primary flex h-10 w-10 shrink-0 items-center justify-center rounded-lg">
            <Tags size={20} />
          </span>
          <div className="min-w-0 flex-1">
            <h2 id="stickers-ready-title" className="text-foreground text-lg font-semibold">
              {ready.count} {ready.count === 1 ? 'sticker' : 'stickers'} ready{ref ? ` for ${ref}` : ''}
            </h2>
            <p className="text-muted-foreground mt-0.5 text-sm">Made automatically from what came in. Print them and stick them on.</p>
          </div>
          <button type="button" className="text-muted-foreground hover:text-foreground" onClick={onClose} aria-label="Close">
            <X size={18} />
          </button>
        </div>
        <ul className="border-border mx-5 divide-y divide-border rounded-lg border">
          {ready.groups.slice(0, 5).map((g) => (
            <li key={g.key} className="flex items-center gap-2 px-3 py-2.5">
              <div className="min-w-0 flex-1">
                <p className="text-foreground truncate text-sm font-medium">{g.item}</p>
                <p className="text-muted-foreground text-xs">
                  {stickerLine(g)} · {g.store}
                </p>
              </div>
              <button type="button" className="btn-secondary h-8 shrink-0 px-2.5 text-xs" onClick={() => setChanging(g)}>
                Change
              </button>
            </li>
          ))}
          {ready.groups.length > 5 && <li className="text-muted-foreground px-3 py-2 text-xs">and {ready.groups.length - 5} more items</li>}
        </ul>
        <p className="text-muted-foreground px-5 pt-3 text-xs">Later: they wait in Inventory → Stickers → Ready to print.</p>
        <div className="flex justify-end gap-2 p-5">
          <button type="button" className="btn-secondary" onClick={onClose}>
            Later
          </button>
          <button
            type="button"
            className="btn-primary"
            autoFocus
            onClick={() => {
              printLabels(ids)
              onDone?.(`The stickers for ${ref ?? 'it'} have opened in a new tab: press Print there.`)
              onClose()
            }}
          >
            <Printer size={15} /> Print now
          </button>
        </div>
      </div>
      {changing && (
        <ChangeStickers
          line={changing}
          onClose={() => setChanging(null)}
          onDone={() => {
            setChanging(null)
            void reload()
          }}
        />
      )}
    </div>,
    document.body,
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
