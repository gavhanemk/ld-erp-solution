'use client'

import { useQtyRules } from '@/lib/qtyRules'
import { useState } from 'react'
import { api, ApiError } from '@/lib/api'
import { openPrintTab, printLabels, qtyText } from './packageTypes'
import { newPack, PackagingDialog, type PackPlan, type PackValue } from './PackagingEditor'

/** One line's stickers, as Ready to print and the window after stock comes in list them. */
export interface StickerLine {
  ids: string[]
  item: string
  unit: string
  qty: number
  store: string
  sourceRef: string | null
  packType?: string
  /** What each sticker holds, when they all hold the same. */
  each?: number | null
}

/**
 * How a line's stock is stickered, changed — before it is printed, or any
 * time while its stickers are still whole on the rack: one package, split
 * equally, full packages of a fixed size, each its own size, or part of it
 * (or all) left without stickers until they are known. The stock does not
 * change — only how it is labelled.
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
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const qtyRules = useQtyRules()
  // Only its unit symbol is known here: pieces and cartons split whole (10 in 3 is 3, 3, 4).
  const places = qtyRules.places({ uom: { symbol: line.unit } })
  const type = line.packType ?? 'BUNDLE'
  // As they are now: one sticker, or so many of the same size.
  const initial: PackValue = line.ids.length > 1 ? { ...newPack(type, 'EQUAL'), count: String(line.ids.length) } : newPack(type, 'ONE')

  const save = async (plan: PackPlan, value: PackValue, andPrint: boolean) => {
    // Opened on the click itself, so the browser does not block it as a pop-up.
    const tab = andPrint ? openPrintTab() : null
    setBusy(true)
    setError(null)
    try {
      const res = await api.post<{ message: string; data: { ids: string[] } }>('/packages/restick', {
        ids: line.ids,
        qtys: plan.qtys,
        packType: value.type,
        leaveLoose: plan.loose > 0.0005,
        ...(plan.notes.some(Boolean) ? { notes: plan.notes } : {}),
      })
      if (andPrint) printLabels(res.data.ids, tab)
      onDone(res.message, res.data.ids)
    } catch (err) {
      tab?.close()
      setError(err instanceof ApiError ? err.message : 'Could not change the stickers.')
      setBusy(false)
    }
  }

  return (
    <PackagingDialog
      title="Change stickers"
      subtitle={`${line.item} · ${qtyText(line.qty)} ${line.unit}${line.sourceRef ? ` · ${line.sourceRef}` : ''} · now on ${line.ids.length} ${line.ids.length === 1 ? 'sticker' : 'stickers'}`}
      initial={initial}
      total={line.qty}
      unit={line.unit}
      places={places}
      laterText="Takes these stickers off: the stock stays in the store with packaging pending until new ones are made (Stickers → Packaging pending)."
      busy={busy}
      error={error}
      saveLabel={(plan) => (plan.qtys.length ? `Make ${plan.qtys.length} ${plan.qtys.length === 1 ? 'sticker' : 'stickers'}` : 'Take the stickers off')}
      onSave={(plan, value) => void save(plan, value, false)}
      onSaveAndPrint={(plan, value) => void save(plan, value, true)}
      onClose={onClose}
    />
  )
}
