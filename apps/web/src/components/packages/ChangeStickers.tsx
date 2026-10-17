'use client'

import { useState } from 'react'
import { createPortal } from 'react-dom'
import { Loader2, Tags, X } from 'lucide-react'
import { api, ApiError } from '@/lib/api'
import { useEscape } from '@/lib/useEscape'
import { SmartSelect } from '@/components/ui/SmartSelect'
import { StepInput } from '@/components/ui/StepInput'
import { PACK_TYPES, parseSizes, qtyText, splitEvenly } from './packageTypes'

/** One line's stickers, as Ready to print and the window after stock comes in list them. */
export interface StickerLine {
  ids: string[]
  item: string
  unit: string
  qty: number
  store: string
  sourceRef: string | null
  packType?: string
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)

/**
 * How a line's stock is stickered, changed before it is printed: any number of
 * stickers, all the same size or each its own. 500 mtr can be 1 sticker, 5 of
 * 100, or 7 bundles of whatever each one holds. The stock does not change —
 * only how it is labelled.
 */
export function ChangeStickers({
  line,
  onClose,
  onDone,
}: {
  line: StickerLine
  onClose: () => void
  onDone: (message: string, ids: string[]) => void
}) {
  const [count, setCount] = useState(String(line.ids.length))
  const [type, setType] = useState(line.packType ?? 'BUNDLE')
  const [differ, setDiffer] = useState(false)
  const [sizes, setSizes] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Escape closes this window only — not the ones behind it.
  useEscape(() => {
    if (!busy) onClose()
  })

  const qtys = differ ? parseSizes(sizes) : splitEvenly(line.qty, Math.floor(Number(count) || 0))
  const total = Math.round(qtys.reduce((s, q) => s + q, 0) * 1000) / 1000
  const off = qtys.length > 0 && Math.abs(total - line.qty) > 0.0005
  const kind = PACK_TYPES.find((p) => p.value === type) ?? PACK_TYPES[6]
  const noun = qtys.length === 1 ? kind.one : kind.many
  const last = qtys[qtys.length - 1]

  let summary: string
  if (!qtys.length) summary = differ ? 'Type the size of each one, e.g. 120, 95.5, 110' : 'Enter how many stickers'
  else if (differ) summary = `${qtys.length} ${noun}, ${qtyText(total)} of ${qtyText(line.qty)} ${line.unit}`
  else if (last === qtys[0]) summary = `${qtys.length} ${noun} of ${qtyText(qtys[0])} ${line.unit}${qtys.length > 1 ? ' each' : ''}`
  else summary = `${qtys.length} ${noun}: ${qtyText(qtys[0])} ${line.unit} each, the last ${qtyText(last)}`

  const save = async () => {
    setError(null)
    if (!qtys.length) return setError(differ ? 'Type the size of each sticker.' : 'Enter how many stickers.')
    if (off) return setError(`The stickers add up to ${qtyText(total)} ${line.unit}, but there is ${qtyText(line.qty)} ${line.unit}. Make them match.`)
    if (qtys.length > 500) return setError('That is more than 500 stickers.')
    setBusy(true)
    try {
      const res = await api.post<{ message: string; data: { ids: string[] } }>('/packages/restick', { ids: line.ids, qtys, packType: type })
      onDone(res.message, res.data.ids)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not change the stickers.')
      setBusy(false)
    }
  }

  return createPortal(
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 p-3 backdrop-blur-sm sm:left-[var(--sidebar-current-width)]">
      <div className="glass-card w-full max-w-md overflow-hidden" role="dialog" aria-modal="true" aria-labelledby="change-stickers-title">
        <div className="flex items-start gap-3 p-5 pb-3">
          <span className="bg-primary/10 text-primary flex h-10 w-10 shrink-0 items-center justify-center rounded-lg">
            <Tags size={20} />
          </span>
          <div className="min-w-0 flex-1">
            <h2 id="change-stickers-title" className="text-foreground text-lg font-semibold">
              How many stickers?
            </h2>
            <p className="text-muted-foreground mt-0.5 text-sm">
              {line.item} · {qtyText(line.qty)} {line.unit}
              {line.sourceRef ? ` · ${line.sourceRef}` : ''}
            </p>
          </div>
          <button type="button" className="text-muted-foreground hover:text-foreground" onClick={onClose} aria-label="Close" disabled={busy}>
            <X size={18} />
          </button>
        </div>

        <div className="space-y-2 px-5">
          <div className={differ ? 'flex flex-col gap-2' : 'flex gap-2'}>
            {differ ? (
              <input
                className="form-input h-10 w-full"
                value={sizes}
                onChange={(e) => setSizes(e.target.value)}
                placeholder="120, 95.5, 110, 174.5"
                aria-label="Size of each sticker"
                autoFocus
              />
            ) : (
              <StepInput
                className="form-input h-10 w-24 shrink-0 text-right text-base"
                value={count}
                onValueChange={setCount}
                min={1}
                aria-label="How many stickers"
                autoFocus
              />
            )}
            <SmartSelect className={differ ? 'form-input h-10 w-full' : 'form-input h-10 min-w-0 flex-1'} value={type} onChange={(e) => setType(e.target.value)} aria-label="What each one is">
              {PACK_TYPES.map((p) => (
                <option key={p.value} value={p.value}>
                  {cap(p.many)}
                </option>
              ))}
            </SmartSelect>
          </div>
          <p className={`text-sm ${off ? 'text-red-400' : 'text-muted-foreground'}`}>
            {summary}
            <button
              type="button"
              className="text-primary ml-2 text-xs font-medium hover:underline"
              onClick={() => {
                if (differ) {
                  setCount(String(parseSizes(sizes).length || 1))
                  setDiffer(false)
                } else {
                  setSizes(qtys.join(', '))
                  setDiffer(true)
                }
              }}
            >
              {differ ? 'All the same' : 'Sizes differ?'}
            </button>
          </p>
          {error && <p className="text-sm text-red-400">{error}</p>}
        </div>

        <div className="flex justify-end gap-2 p-5">
          <button type="button" className="btn-secondary" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="button" className="btn-primary" onClick={() => void save()} disabled={busy || !qtys.length || off}>
            {busy ? <Loader2 size={15} className="animate-spin" /> : <Tags size={15} />}
            Make {qtys.length || ''} {qtys.length === 1 ? 'sticker' : 'stickers'}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  )
}
