'use client'

import { useMemo, useRef, useState } from 'react'
import { ArrowLeftRight, Boxes, ClipboardCheck, Loader2, X } from 'lucide-react'
import { api, ApiError } from '@/lib/api'
import { formatDate } from '@/lib/utils'
import { FormFrame } from '@/components/ui/FormFrame'
import { Section } from '@/components/purchase/Section'
import { SmartSelect } from '@/components/ui/SmartSelect'
import { StepInput } from '@/components/ui/StepInput'
import { BundleQtyTable, type BundleRow, type ExtraColumn, type QtyValues } from './BundleQtyTable'
import { bundleShort, newClientKey, pcs, type FlowTransfer } from './types'

/**
 * Counting a transfer card in at the receiving desk. What was sent is kept as
 * the sender wrote it; what is counted is recorded beside it. More than was
 * sent is taken off the sender's count (they miscounted). Closing says
 * nothing more is coming: what has not been counted in is held as short until
 * somebody settles it — found, never sent, or written off.
 *
 * Counting in at stitching on our own floor (the caller passes the job card's
 * sizes), Change sizes puts a "Made as size" and its pieces on each bundle of
 * the table, so pieces made as another size are recorded with the count,
 * bundle by bundle: saved together, by the same rules as Change sizes on the
 * sheet (12 Nov 2026 — the user asked for the button here, bundle-wise).
 *
 * With sizes on, a bundle's count is split: the count box becomes "Same size",
 * the pieces that keep the bundle's size, and Pcs are those made as another
 * size — both are counted in. Pieces typed in Pcs come out of Same size, so a
 * bundle's count stays as it was. (The user counted a 20-piece bundle as 10 +
 * 10 made as M and expected 20 counted in, not 10.)
 *
 * For speed (the same change on a run of bundles was typed bundle by bundle):
 * bundles are ticked — Shift+click for a run, or a whole size — and one bar
 * sets them all, so many pieces from each, so many in all spread evenly, or
 * whole bundles. For accuracy, a table of the card's sizes as cut and as made,
 * beside the order's plan, follows every change as it is made.
 */

const SAME = '__same'
type How = 'each' | 'all' | 'whole'

/** So many pieces spread as evenly as the bundles allow, each taking no more than it holds. */
function spread(total: number, caps: number[]) {
  const out = caps.map(() => 0)
  let left = total
  let open = caps.map((_, i) => i).filter((i) => caps[i] > 0)
  while (left > 0 && open.length) {
    const share = Math.max(1, Math.floor(left / open.length))
    for (const i of open) {
      if (left <= 0) break
      const give = Math.min(share, caps[i] - out[i], left)
      out[i] += give
      left -= give
    }
    open = open.filter((i) => out[i] < caps[i])
  }
  return out
}

export function CountInDialog({
  transfer,
  moNumber,
  sizes,
  onClose,
  onSaved,
}: {
  transfer: FlowTransfer
  moNumber: string
  /** The job card's sizes (with the order's planned pieces), when this is a count-in at stitching on our own floor; null otherwise. */
  sizes?: Array<{ id: string; code: string; qty?: number }> | null
  onClose: () => void
  onSaved: (message: string) => void
}) {
  const rows = useMemo(
    () =>
      transfer.lines
        .map((l) => ({
          id: l.id,
          code: l.bundle.code,
          size: l.bundle.size?.code ?? null,
          line: null,
          available: l.dispatchedQty + l.excessQty - l.receivedQty - l.shortQty,
          note: l.receivedQty ? `${l.receivedQty} of ${l.dispatchedQty} already counted` : null,
        }))
        .filter((r) => r.available > 0),
    [transfer],
  )
  const lineOf = useMemo(() => new Map(transfer.lines.map((l) => [l.id, l])), [transfer])
  // Starts at what was sent: the receiver changes only what differs.
  const [values, setValues] = useState<QtyValues>(() => Object.fromEntries(rows.map((r) => [r.id, { qty: String(r.available) }])))
  const [close, setClose] = useState(false)
  const [receivedBy, setReceivedBy] = useState('')
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10))
  const [notes, setNotes] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [clientKey] = useState(newClientKey)
  // Change sizes: on each bundle, the size its pieces are made as and how many.
  const [sizing, setSizing] = useState(false)
  const [madeAs, setMadeAs] = useState<Record<string, { toSizeId: string; qty: string }>>({})
  const [reason, setReason] = useState('')
  const reasonRef = useRef<HTMLInputElement>(null)
  // Several bundles at once: those ticked, the last one clicked (for Shift+click), and what the bar sets.
  const [ticked, setTicked] = useState<string[]>([])
  const [lastTick, setLastTick] = useState<string | null>(null)
  const [bulkTo, setBulkTo] = useState('')
  const [bulkHow, setBulkHow] = useState<How>('each')
  const [bulkQty, setBulkQty] = useState('')
  const [bulkNote, setBulkNote] = useState<{ text: string; bad?: boolean } | null>(null)
  /** Save was pressed with something missing: marked from then on. */
  const [tried, setTried] = useState(false)
  const offerSizes = !!sizes && sizes.length > 1 && !transfer.vendor

  // A bundle's count: its box (Same size, with sizes on) and the pieces made as another size.
  const sameOf = (lineId: string) => Number(values[lineId]?.qty) || 0
  const madeOf = (lineId: string) => (sizing && madeAs[lineId]?.toSizeId ? Number(madeAs[lineId].qty) || 0 : 0)
  const countOf = (lineId: string) => sameOf(lineId) + madeOf(lineId)
  const counted = rows.map((r) => ({ lineId: r.id, qty: countOf(r.id) }))
  const total = counted.reduce((s, l) => s + l.qty, 0)
  const pending = rows.reduce((s, r) => s + r.available, 0)
  const shortBy = rows.reduce((s, r) => s + Math.max(0, r.available - countOf(r.id)), 0)
  const overBy = rows.reduce((s, r) => s + Math.max(0, countOf(r.id) - r.available), 0)
  const sizeCode = (id: string) => sizes?.find((z) => z.id === id)?.code ?? '—'

  // A bundle cut in a size, not made by an earlier change (pieces change size once), can change size here.
  const mayChange = (r: BundleRow) => !!r.size && !lineOf.get(r.id)?.bundle.parentId
  const changeable = rows.filter(mayChange)
  const changes = sizing
    ? rows.flatMap((r) => {
        const m = madeAs[r.id]
        return m?.toSizeId && mayChange(r) ? [{ row: r, toSizeId: m.toSizeId, qty: Number(m.qty) || 0 }] : []
      })
    : []
  const moving = changes.reduce((s, c) => s + c.qty, 0)
  /** What is wrong with one bundle's size change, if anything. */
  const changeProblem = (lineId: string) => {
    const m = madeAs[lineId]
    if (!sizing || !m?.toSizeId) return null
    return (Number(m.qty) || 0) <= 0 ? 'Enter how many pieces.' : null
  }
  const firstWrong = changes.find((c) => changeProblem(c.row.id))
  const reasonMissing = changes.length > 0 && reason.trim().length < 5
  const sizeBlocker = firstWrong
    ? `${bundleShort(firstWrong.row.code)}: ${changeProblem(firstWrong.row.id)}`
    : reasonMissing
      ? 'Say why the pieces are made as another size.'
      : null
  const blocker = !total && !close ? 'Enter what was counted in, or close it as short.' : sizeBlocker

  // The card's sizes as cut and as made, beside the order's plan — followed as changes are made.
  const sizeTable = (sizes ?? [])
    .map((z) => {
      const cut = rows.reduce((s, r) => s + (r.size === z.code ? countOf(r.id) : 0), 0)
      const out = changes.reduce((s, c) => s + (c.row.size === z.code ? c.qty : 0), 0)
      const into = changes.reduce((s, c) => s + (c.toSizeId === z.id ? c.qty : 0), 0)
      return { code: z.code, cut, made: cut - out + into, plan: z.qty }
    })
    .filter((z) => z.cut || z.made || z.plan)
  const cutTotal = sizeTable.reduce((s, z) => s + z.cut, 0)
  const planTotal = sizeTable.reduce((s, z) => s + (z.plan ?? 0), 0)
  const hasPlan = sizeTable.some((z) => z.plan != null)
  // Only when this card holds the whole order line does each size's figure have to match the plan.
  const wholeLine = hasPlan && planTotal > 0 && cutTotal === planTotal

  const setSame = (lineId: string, qty: number) => setValues((x) => ({ ...x, [lineId]: { ...x[lineId], qty: String(qty) } }))
  /** After a size is picked on a row: to its pieces box, once the list has handed focus back. */
  const toPieces = (lineId: string) =>
    setTimeout(() => {
      const box = [...document.querySelectorAll<HTMLInputElement>(`[data-size-pcs="${lineId}"] input`)].find((x) => x.offsetParent)
      box?.focus()
      box?.select()
    }, 80)
  const pick = (r: BundleRow, toSizeId: string) => {
    const had = madeAs[r.id]
    if (!toSizeId) {
      // Back to its own size: the pieces return to Same size.
      if (had?.toSizeId) setSame(r.id, sameOf(r.id) + (Number(had.qty) || 0))
      setMadeAs((x) => {
        const next = { ...x }
        delete next[r.id]
        return next
      })
      return
    }
    // Another size for the same pieces.
    if (had?.toSizeId) {
      setMadeAs((x) => ({ ...x, [r.id]: { ...x[r.id], toSizeId } }))
      return toPieces(r.id)
    }
    // The bundle's pieces not counted as the same size, if any; otherwise how many is typed, and taken from Same size.
    const rest = Math.max(0, r.available - sameOf(r.id))
    setMadeAs((x) => ({ ...x, [r.id]: { toSizeId, qty: rest ? String(rest) : '' } }))
    toPieces(r.id)
  }
  /** Pieces made as another size come out of Same size: the bundle's count stays as it was. */
  const setMade = (lineId: string, v: string) => {
    const moved = (Number(v) || 0) - (Number(madeAs[lineId]?.qty) || 0)
    const same = sameOf(lineId)
    const nextSame = Math.max(0, same - moved)
    setMadeAs((x) => ({ ...x, [lineId]: { ...x[lineId], qty: v } }))
    if (nextSame !== same) setSame(lineId, nextSame)
  }
  const stopSizing = () => {
    // The pieces made as other sizes go back to Same size: the count stays as it was.
    setValues((x) => {
      const next = { ...x }
      for (const [id, m] of Object.entries(madeAs)) if (m.toSizeId) next[id] = { ...next[id], qty: String((Number(next[id]?.qty) || 0) + (Number(m.qty) || 0)) }
      return next
    })
    setSizing(false)
    setMadeAs({})
    setTicked([])
    setBulkNote(null)
  }

  // Ticking: one bundle, a run with Shift (from the last one clicked), every bundle, or a whole size.
  const tick = (rowId: string, run: boolean) => {
    setBulkNote(null)
    const ids = changeable.map((r) => r.id)
    const from = lastTick ? ids.indexOf(lastTick) : -1
    const to = ids.indexOf(rowId)
    if (run && from >= 0 && to >= 0) {
      const runIds = ids.slice(Math.min(from, to), Math.max(from, to) + 1)
      setTicked((t) => [...new Set([...t, ...runIds])])
    } else {
      setTicked((t) => (t.includes(rowId) ? t.filter((x) => x !== rowId) : [...t, rowId]))
    }
    setLastTick(rowId)
  }
  const tickAll = () => {
    setBulkNote(null)
    setTicked((t) => (changeable.length && changeable.every((r) => t.includes(r.id)) ? [] : changeable.map((r) => r.id)))
  }
  const tickSize = (code: string) => {
    setBulkNote(null)
    setTicked(changeable.filter((r) => r.size === code).map((r) => r.id))
    setLastTick(null)
  }
  const tickedRows = changeable.filter((r) => ticked.includes(r.id))
  const tickedSizes = [...new Set(tickedRows.map((r) => r.size))]
  const tickedPcs = tickedRows.reduce((s, r) => s + countOf(r.id), 0)

  /** The bar: the same change on every bundle ticked, each bundle's count kept. */
  const applyBulk = () => {
    if (!tickedRows.length) return
    if (!bulkTo) return setBulkNote({ text: 'Pick the size they are made as.', bad: true })
    const nextValues = { ...values }
    const nextMade = { ...madeAs }
    const sameNow = (id: string) => Number(nextValues[id]?.qty) || 0
    const madeNow = (id: string) => (nextMade[id]?.toSizeId ? Number(nextMade[id].qty) || 0 : 0)
    if (bulkTo === SAME) {
      let n = 0
      for (const r of tickedRows) {
        if (!nextMade[r.id]) continue
        nextValues[r.id] = { ...nextValues[r.id], qty: String(sameNow(r.id) + madeNow(r.id)) }
        delete nextMade[r.id]
        n++
      }
      setValues(nextValues)
      setMadeAs(nextMade)
      setTicked([])
      // An undo is a one-off: the bar goes back to asking for a size, not to undoing the next run too.
      setBulkTo('')
      return setBulkNote({ text: n ? `${n} ${n === 1 ? 'bundle keeps its' : 'bundles keep their'} own size again.` : 'None of those bundles had a size change.' })
    }
    const asked = Number(bulkQty) || 0
    if (bulkHow !== 'whole' && asked <= 0) return setBulkNote({ text: 'Enter how many pieces.', bad: true })
    const to = sizeCode(bulkTo)
    const fit = tickedRows.filter((r) => r.size !== to)
    const caps = fit.map((r) => sameNow(r.id) + madeNow(r.id))
    const takes = bulkHow === 'whole' ? caps : bulkHow === 'each' ? caps.map((c) => Math.min(asked, c)) : spread(asked, caps)
    fit.forEach((r, i) => {
      if (takes[i] <= 0) return
      nextMade[r.id] = { toSizeId: bulkTo, qty: String(takes[i]) }
      nextValues[r.id] = { ...nextValues[r.id], qty: String(caps[i] - takes[i]) }
    })
    setValues(nextValues)
    setMadeAs(nextMade)
    setTicked([])
    setLastTick(null)
    const took = takes.reduce((s, x) => s + x, 0)
    const done = takes.filter((x) => x > 0).length
    const notes = [`${pcs(took)} pcs of ${done} ${done === 1 ? 'bundle' : 'bundles'} made as size ${to}.`]
    if (fit.length < tickedRows.length) notes.push(`${tickedRows.length - fit.length} already size ${to}, left as they are.`)
    if (bulkHow === 'each' && takes.some((x, i) => x < asked && caps[i] > 0)) notes.push('Bundles holding fewer gave all they had.')
    if (bulkHow === 'all' && took < asked) notes.push(`Only ${pcs(took)} of the ${pcs(asked)} asked: the bundles hold no more.`)
    setBulkNote({ text: notes.join(' ') })
  }

  const save = async () => {
    if (blocker) {
      setTried(true)
      // To what is missing: the bundle's size change, or the reason.
      if (firstWrong) {
        const el = [...document.querySelectorAll<HTMLElement>(`[data-size-change="${firstWrong.row.id}"]`)].find((x) => x.offsetParent)
        el?.scrollIntoView({ behavior: 'smooth', block: 'center' })
      } else if (sizeBlocker) {
        reasonRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' })
        reasonRef.current?.focus({ preventScroll: true })
      }
      return
    }
    setSaving(true)
    setError(null)
    try {
      const res = await api.post<{ message?: string }>(`/production/transfers/${transfer.id}/receive`, {
        // Each bundle's whole count, whatever size its pieces are made as.
        lines: counted.filter((l) => l.qty > 0),
        close,
        receivedBy: receivedBy.trim() || null,
        receivedAt: date,
        notes: notes.trim() || null,
        clientKey,
        ...(changes.length
          ? {
              sizeChanges: {
                lines: changes.map((c) => ({ bundleId: lineOf.get(c.row.id)!.bundle.id, toSizeId: c.toSizeId, qty: c.qty })),
                reason: reason.trim(),
              },
            }
          : {}),
      })
      onSaved(res.message ?? 'Counted in.')
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not count it in.')
    } finally {
      setSaving(false)
    }
  }

  // The two columns Change sizes puts on the table.
  const sizeColumns: ExtraColumn[] = sizing
    ? [
        {
          key: 'madeAs',
          label: 'Made as size',
          width: 'w-36',
          cell: (r) => {
            if (!r.size) return <span className="text-muted-foreground text-xs">—</span>
            if (!mayChange(r))
              return (
                <span className="text-muted-foreground text-[11px]" title="Made by an earlier size change; pieces change size once. To correct it, undo that change on the Stitching sheet.">
                  Changed once already
                </span>
              )
            const m = madeAs[r.id]
            return (
              <div data-size-change={r.id}>
                <SmartSelect
                  className={`form-input h-8 py-0 text-xs ${m?.toSizeId ? 'border-primary/60 text-primary font-medium' : ''}`}
                  value={m?.toSizeId ?? ''}
                  onChange={(e) => pick(r, e.target.value)}
                  aria-label={`${r.code} made as size`}
                >
                  <option value="">Same ({r.size})</option>
                  {(sizes ?? [])
                    .filter((z) => z.code !== r.size)
                    .map((z) => (
                      <option key={z.id} value={z.id}>
                        Size {z.code}
                      </option>
                    ))}
                </SmartSelect>
              </div>
            )
          },
        },
        {
          key: 'madeAsQty',
          label: 'Pcs',
          width: 'w-24',
          total: moving ? pcs(moving) : null,
          cell: (r) => {
            const m = madeAs[r.id]
            if (!m?.toSizeId || !mayChange(r)) return <span className="text-muted-foreground block text-right text-xs">—</span>
            const wrong = tried && !!changeProblem(r.id)
            return (
              <div data-size-change={r.id} data-size-pcs={r.id}>
                <StepInput
                  className={`form-input h-8 text-right text-xs tabular-nums ${wrong ? 'border-destructive/60' : ''}`}
                  value={m.qty}
                  max={r.available}
                  placeholder="0"
                  onValueChange={(v) => setMade(r.id, v)}
                  aria-label={`${r.code} pieces made as another size`}
                  aria-invalid={wrong}
                />
                {wrong && <span className="text-destructive mt-0.5 block text-[11px]">{changeProblem(r.id)}</span>}
              </div>
            )
          },
        },
      ]
    : []

  const countNote = overBy ? (
    <span className="text-primary">{pcs(overBy)} more than was sent — taken off {transfer.fromStep.name}&apos;s count.</span>
  ) : shortBy ? (
    close ? (
      <span className="warn-text">{pcs(shortBy)} short — held until settled.</span>
    ) : (
      `${pcs(shortBy)} still to come.`
    )
  ) : (
    `All ${pcs(pending)} counted.`
  )
  const signed = (v: number) => (v > 0 ? `+${pcs(v)}` : v < 0 ? `−${pcs(-v)}` : '—')

  return (
    <FormFrame
      icon={ClipboardCheck}
      // Named for where the pieces are counted in. The card's number begins with the department that
      // sent it (FUS/… from Fusing), so on its own it read as if the count were at the sending end.
      title={`Count in at ${transfer.toStep.name}`}
      subtitle={`Card ${transfer.transferNumber} from ${transfer.fromStep.name} · ${moNumber} · sent ${formatDate(transfer.dispatchDate)}${transfer.issuedBy ? ` by ${transfer.issuedBy}` : ''}`}
      width={sizing ? 'max-w-4xl' : 'max-w-3xl'}
      primary={
        <button type="button" className="btn-primary" onClick={() => void save()} disabled={saving} title={blocker ?? undefined}>
          {saving ? <Loader2 size={15} className="animate-spin" /> : <ClipboardCheck size={15} />} Count in {total ? `${pcs(total)} pcs` : ''}
        </button>
      }
      footer={
        <button type="button" className="btn-secondary" onClick={onClose} disabled={saving}>
          Cancel
        </button>
      }
      footerNote={
        blocker ? (
          <span className="warn-text">{blocker}</span>
        ) : (
          <>
            {countNote}
            {moving > 0 && (
              <span className="text-primary">
                {' '}
                {pcs(total - moving)} keep their size, {pcs(moving)} made as another size: {changes.length} new {changes.length === 1 ? 'bundle' : 'bundles'}, stickers
                after saving.
              </span>
            )}
          </>
        )
      }
      error={error}
      onClose={onClose}
      busy={saving}
    >
      {/* Who counted, when, and whether more is coming — first, as the sending window has its own. */}
      <Section icon={ClipboardCheck} title={`Counting in at ${transfer.toStep.name}`}>
        <div className="grid grid-cols-1 gap-x-4 gap-y-3 sm:grid-cols-3">
          <label className="block">
            <span className="form-label">Counted on</span>
            <input type="date" className="form-input" value={date} onChange={(e) => setDate(e.target.value)} />
          </label>
          <label className="block">
            <span className="form-label">Received by</span>
            <input className="form-input" value={receivedBy} maxLength={120} placeholder="Who counted them" onChange={(e) => setReceivedBy(e.target.value)} />
          </label>
          <label className="block">
            <span className="form-label">Note</span>
            <input className="form-input" value={notes} maxLength={1000} onChange={(e) => setNotes(e.target.value)} />
          </label>
        </div>
        <label className="mt-3 flex items-start gap-2 text-xs">
          <input type="checkbox" className="accent-primary mt-0.5" checked={close} onChange={(e) => setClose(e.target.checked)} />
          <span>
            Nothing more is coming on this card. What has not been counted in is <strong>short</strong>, and waits to be settled — found later, never sent, or written off by a manager.
          </span>
        </label>
      </Section>
      <Section
        icon={Boxes}
        title="Counted at the desk"
        actions={
          offerSizes ? (
            sizing ? (
              <button type="button" className="btn-ghost h-8 px-2.5 text-xs" onClick={stopSizing}>
                <X size={13} /> Cancel size changes
              </button>
            ) : (
              <button type="button" className="btn-secondary h-8 px-3 text-xs" onClick={() => setSizing(true)} title="Pieces of a bundle made as another size of the order">
                <ArrowLeftRight size={13} /> Change sizes
              </button>
            )
          ) : undefined
        }
      >
        {sizing && (
          <div className="border-primary/30 bg-primary/5 mb-3 rounded-lg border p-3">
            <p className="text-foreground text-xs">
              Tick the bundles to change — <b>Shift+click</b> ticks a run, or tick a whole size — then set the size and pieces once in the bar and <b>Apply</b>. A
              single bundle can be set in its own row. Pieces made as another size come out of <b>Same size</b>, so every bundle&apos;s count stays as it arrived;
              each bundle&apos;s changed pieces become a new bundle with its own sticker.
            </p>
            <label className="mt-2 block sm:max-w-lg">
              <span className="form-label">
                Why are they made as another size? {changes.length > 0 && <span className="text-destructive">*</span>}
              </span>
              <input
                ref={reasonRef}
                className={`form-input ${tried && reasonMissing ? 'border-destructive' : ''}`}
                value={reason}
                maxLength={500}
                placeholder="e.g. Buyer asked for more L; M pieces cut long"
                onChange={(e) => setReason(e.target.value)}
                aria-invalid={tried && reasonMissing}
              />
              {tried && reasonMissing && <span className="text-destructive mt-1 block text-[11px] font-medium">Say why, in a few words.</span>}
            </label>

            {/* The card's sizes, as cut and as they will be made — and against the order's plan. */}
            {sizeTable.length > 0 && (
              <div className="border-border bg-card mt-3 overflow-x-auto rounded-lg border">
                <table className="w-full text-xs tabular-nums" aria-label="Sizes on this card">
                  <thead>
                    <tr className="bg-secondary">
                      <th className="text-muted-foreground px-2.5 py-1.5 text-left font-medium">Sizes on this card</th>
                      {sizeTable.map((z) => (
                        <th key={z.code} className="px-2.5 py-1.5 text-right font-semibold">
                          {z.code}
                        </th>
                      ))}
                      <th className="px-2.5 py-1.5 text-right font-semibold">Total</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr className="border-border border-t">
                      <td className="text-muted-foreground px-2.5 py-1">As cut</td>
                      {sizeTable.map((z) => (
                        <td key={z.code} className="px-2.5 py-1 text-right">
                          {pcs(z.cut)}
                        </td>
                      ))}
                      <td className="px-2.5 py-1 text-right">{pcs(cutTotal)}</td>
                    </tr>
                    <tr className="border-border border-t">
                      <td className="text-foreground px-2.5 py-1 font-medium">As made</td>
                      {sizeTable.map((z) => (
                        <td
                          key={z.code}
                          className={`px-2.5 py-1 text-right font-semibold ${wholeLine ? (z.made === (z.plan ?? 0) ? 'text-emerald-600' : 'warn-text') : 'text-foreground'}`}
                        >
                          {pcs(z.made)}
                        </td>
                      ))}
                      <td className="text-foreground px-2.5 py-1 text-right font-semibold">{pcs(sizeTable.reduce((s, z) => s + z.made, 0))}</td>
                    </tr>
                    <tr className="border-border border-t">
                      <td className="text-muted-foreground px-2.5 py-1">Change</td>
                      {sizeTable.map((z) => (
                        <td key={z.code} className={`px-2.5 py-1 text-right ${z.made > z.cut ? 'text-emerald-600' : z.made < z.cut ? 'warn-text' : 'text-muted-foreground'}`}>
                          {signed(z.made - z.cut)}
                        </td>
                      ))}
                      <td className="text-muted-foreground px-2.5 py-1 text-right">—</td>
                    </tr>
                    {hasPlan && (
                      <tr className="border-border border-t">
                        <td className="text-muted-foreground px-2.5 py-1">Order plan</td>
                        {sizeTable.map((z) => (
                          <td key={z.code} className="text-muted-foreground px-2.5 py-1 text-right">
                            {z.plan != null ? pcs(z.plan) : '—'}
                          </td>
                        ))}
                        <td className="text-muted-foreground px-2.5 py-1 text-right">{pcs(planTotal)}</td>
                      </tr>
                    )}
                  </tbody>
                </table>
                <p className="text-muted-foreground border-border border-t px-2.5 py-1.5 text-[11px]">
                  {wholeLine
                    ? 'This card holds the whole order line: a size in green matches the order’s plan, one in amber does not yet.'
                    : 'Pieces only move between sizes; the total stays as counted.'}
                </p>
              </div>
            )}
          </div>
        )}

        {/* Ticking a whole size, and the bar that sets every bundle ticked — held at the top while the table scrolls. */}
        {sizing && changeable.length > 0 && (
          <div className="sticky top-0 z-20 mb-2">
            {tickedRows.length > 0 ? (
              <div className="border-primary/50 bg-card flex flex-wrap items-center gap-2 rounded-lg border p-2 shadow-md">
                <span className="text-foreground text-xs font-medium">
                  {tickedRows.length} {tickedRows.length === 1 ? 'bundle' : 'bundles'} ticked · {pcs(tickedPcs)} pcs
                  {tickedSizes.length === 1 ? ` of size ${tickedSizes[0]}` : ''}
                </span>
                <SmartSelect className="form-input h-8 w-36 py-0 text-xs" value={bulkTo} onChange={(e) => setBulkTo(e.target.value)} aria-label="Ticked bundles made as size">
                  <option value="">Made as…</option>
                  {(sizes ?? []).map((z) => (
                    <option key={z.id} value={z.id}>
                      Size {z.code}
                    </option>
                  ))}
                  <option value={SAME}>Their own size (undo)</option>
                </SmartSelect>
                {bulkTo !== SAME && (
                  <>
                    {bulkHow !== 'whole' && (
                      <StepInput
                        className="form-input h-8 w-20 text-right text-xs tabular-nums"
                        value={bulkQty}
                        placeholder="Pcs"
                        onValueChange={setBulkQty}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') {
                            e.preventDefault()
                            applyBulk()
                          }
                        }}
                        aria-label="Pieces for the ticked bundles"
                      />
                    )}
                    <SmartSelect className="form-input h-8 w-40 py-0 text-xs" value={bulkHow} onChange={(e) => setBulkHow(e.target.value as How)} aria-label="How the pieces are taken">
                      <option value="each">pcs from each bundle</option>
                      <option value="all">pcs in all, spread evenly</option>
                      <option value="whole">whole bundles</option>
                    </SmartSelect>
                  </>
                )}
                <button type="button" className="btn-primary h-8 px-3 text-xs" onClick={applyBulk}>
                  Apply to {tickedRows.length}
                </button>
                <button type="button" className="btn-ghost h-8 px-2 text-xs" onClick={() => setTicked([])}>
                  Untick
                </button>
                {bulkNote && <span className={`w-full text-[11px] ${bulkNote.bad ? 'text-destructive font-medium' : 'text-primary'}`}>{bulkNote.text}</span>}
              </div>
            ) : (
              <div className="bg-card flex flex-wrap items-center gap-1.5 text-xs">
                <span className="text-muted-foreground">Tick a whole size:</span>
                {[...new Set(changeable.map((r) => r.size as string))].map((code) => (
                  <button key={code} type="button" className="btn-secondary h-7 px-2.5 text-xs" onClick={() => tickSize(code)}>
                    {code} <span className="text-muted-foreground">({changeable.filter((r) => r.size === code).length})</span>
                  </button>
                ))}
                {bulkNote && <span className={`ml-1 text-[11px] ${bulkNote.bad ? 'text-destructive font-medium' : 'text-primary'}`}>{bulkNote.text}</span>}
              </div>
            )}
          </div>
        )}

        <BundleQtyTable
          rows={rows}
          columns={[{ key: 'qty', label: sizing ? 'Same size' : 'Counted' }]}
          values={values}
          onChange={(row, col, v) => setValues((x) => ({ ...x, [row]: { ...x[row], [col]: v } }))}
          availableLabel="Sent, not counted"
          fill={{ label: 'As sent', column: 'qty' }}
          allowOver
          empty="Everything on this card has been counted in."
          extraColumns={sizeColumns}
          // With sizes on, a bundle's pieces made as another size are part of its count.
          held={sizing ? madeOf : undefined}
          onFill={sizing ? () => setValues(Object.fromEntries(rows.map((r) => [r.id, { qty: String(Math.max(0, r.available - madeOf(r.id))) }]))) : undefined}
          onClear={
            sizing
              ? () => {
                  setValues(Object.fromEntries(rows.map((r) => [r.id, { qty: '' }])))
                  setMadeAs((x) => Object.fromEntries(Object.entries(x).map(([id, m]) => [id, { ...m, qty: '' }])))
                }
              : undefined
          }
          select={sizing ? { on: (id) => ticked.includes(id), can: mayChange, onTick: tick, onAll: tickAll } : undefined}
        />
        {/* Each change in a line, so nobody has to scroll the table to check them. */}
        {changes.length > 0 && (
          <p className="text-muted-foreground mt-2 text-xs">
            <span className="text-foreground font-medium">Changing size:</span>{' '}
            {changes.map((c) => `${bundleShort(c.row.code)} ${pcs(c.qty)} pcs ${c.row.size} → ${sizeCode(c.toSizeId)}`).join(' · ')}
          </p>
        )}
      </Section>
    </FormFrame>
  )
}
