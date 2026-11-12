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
/**
 * How the bar takes pieces from the ticked bundles, in the floor's words (12 Nov 2026: "pcs from each
 * bundle / pcs in all, spread evenly / whole bundles" read as unclear). A sentence under the bar says
 * what Apply will do with the numbers as they stand.
 */
const HOW: Array<[How, string]> = [
  ['each', 'From every bundle'],
  ['all', 'Total, divided equally'],
  ['whole', 'Full bundles'],
]
type BulkPlan =
  | { kind: 'error'; text: string }
  | { kind: 'undo'; rows: BundleRow[] }
  | { kind: 'move'; to: string; asked: number; rest: boolean; fit: BundleRow[]; caps: number[]; takes: number[]; took: number; kept: number; skipped: number }

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

/** Bundle numbers as runs, the way a person writes them: "B006–B013, B015". */
function bundleRuns(codes: string[]) {
  const parts = codes.map((code) => {
    const short = bundleShort(code)
    const m = /^(\D*)(\d+)$/.exec(short)
    return m ? { short, head: m[1], n: Number(m[2]) } : null
  })
  if (parts.some((x) => !x)) return codes.map(bundleShort).join(', ')
  const sorted = (parts as Array<{ short: string; head: string; n: number }>).sort((a, b) => a.head.localeCompare(b.head) || a.n - b.n)
  const runs: Array<{ first: (typeof sorted)[number]; last: (typeof sorted)[number] }> = []
  for (const x of sorted) {
    const run = runs[runs.length - 1]
    if (run && run.last.head === x.head && x.n === run.last.n + 1) run.last = x
    else runs.push({ first: x, last: x })
  }
  return runs.map((r) => (r.first === r.last ? r.first.short : `${r.first.short}–${r.last.short}`)).join(', ')
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
  /** Apply was pressed with something missing: the sentence under the bar turns red. */
  const [bulkTried, setBulkTried] = useState(false)
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

  // The changes by move — S → XS, L → M — each with its pieces and bundles: a line to check per change of
  // size, not one per bundle (12 Nov 2026: 26 bundles in one sentence read as a mess).
  const sizeOrder = (code: string | null) => (sizes ?? []).findIndex((z) => z.code === code)
  const moves = Object.values(
    changes.reduce<Record<string, { from: string; toSizeId: string; items: typeof changes }>>((acc, c) => {
      const key = `${c.row.size}|${c.toSizeId}`
      const move = acc[key] ?? (acc[key] = { from: c.row.size ?? '—', toSizeId: c.toSizeId, items: [] })
      move.items.push(c)
      return acc
    }, {}),
  ).sort((a, b) => sizeOrder(a.from) - sizeOrder(b.from) || sizeOrder(sizeCode(a.toSizeId)) - sizeOrder(sizeCode(b.toSizeId)))
  /** One move undone: its bundles keep their own size, their pieces back in Same size. */
  const undoMove = (m: (typeof moves)[number]) => {
    setValues((x) => {
      const next = { ...x }
      for (const c of m.items) next[c.row.id] = { ...next[c.row.id], qty: String(countOf(c.row.id)) }
      return next
    })
    setMadeAs((x) => {
      const next = { ...x }
      for (const c of m.items) delete next[c.row.id]
      return next
    })
  }

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
  const tickedPcs = tickedRows.reduce((s, r) => s + r.available, 0)
  /** Pieces of a bundle not kept in Same size — what the user meant as the other size by lowering it. */
  const restOf = (r: BundleRow) => Math.max(0, r.available - sameOf(r.id))

  /**
   * What the bar would do with what it holds now — said in a sentence before Apply, and what Apply
   * does. Each ticked bundle's pieces on the card are split: so many made as the new size, the rest
   * kept as its own size (Same size), and all of them counted in. With no number, the pieces not kept
   * in Same size are the ones made as the new size (12 Nov 2026: the user lowered Same size to 10 on
   * five 20-piece bundles, pressed Apply, and expected the other 10 of each as XS).
   */
  const bulkPlan = ((): BulkPlan | null => {
    if (!tickedRows.length) return null
    if (!bulkTo) return { kind: 'error', text: 'Pick the size they are made as.' }
    if (bulkTo === SAME) return { kind: 'undo', rows: tickedRows.filter((r) => madeAs[r.id]?.toSizeId) }
    const asked = Number(bulkQty) || 0
    const to = sizeCode(bulkTo)
    const fit = tickedRows.filter((r) => r.size !== to)
    const caps = fit.map((r) => r.available)
    const rests = fit.map(restOf)
    const rest = bulkHow === 'each' && asked <= 0
    if (rest && !rests.some((x) => x > 0)) return { kind: 'error', text: 'Enter how many pieces from every bundle.' }
    if (bulkHow === 'all' && asked <= 0) return { kind: 'error', text: 'Enter the total pieces.' }
    const takes = rest ? rests : bulkHow === 'whole' ? caps : bulkHow === 'each' ? caps.map((c) => Math.min(asked, c)) : spread(asked, caps)
    const took = takes.reduce((s, x) => s + x, 0)
    return { kind: 'move', to, asked, rest, fit, caps, takes, took, kept: caps.reduce((s, x) => s + x, 0) - took, skipped: tickedRows.length - fit.length }
  })()
  const bulkPreview = ((): { text: string; bad?: boolean } | null => {
    const p = bulkPlan
    if (!p) return null
    if (p.kind === 'error') return { text: p.text, bad: true }
    if (p.kind === 'undo') {
      const n = p.rows.length
      return n
        ? { text: `${n === tickedRows.length ? (n === 1 ? 'This bundle goes' : 'These bundles go') : `${n} of these bundles go`} back to their own size: their pieces return to Same size.` }
        : { text: 'None of these bundles has a size change to undo.', bad: true }
    }
    if (!p.fit.length) return { text: `They are all size ${p.to} already.`, bad: true }
    const bundles = `${p.fit.length} ${p.fit.length === 1 ? 'bundle' : 'bundles'}`
    const parts: string[] = []
    if (p.rest) {
      // No number: the pieces each bundle does not keep in Same size.
      const given = p.takes.filter((x) => x > 0)
      const lo = Math.min(...given)
      const hi = Math.max(...given)
      parts.push(
        lo === hi
          ? `The ${pcs(lo)} pcs not kept in Same size, from ${given.length === 1 ? 'the bundle' : `each of the ${given.length} bundles`} = ${pcs(p.took)} pcs become size ${p.to}`
          : `The pieces not kept in Same size (${pcs(lo)} to ${pcs(hi)} a bundle, ${given.length} bundles) = ${pcs(p.took)} pcs become size ${p.to}`,
      )
      if (given.length < p.fit.length) parts.push(`${p.fit.length - given.length} with all their pieces in Same size left as they are`)
    } else if (bulkHow === 'whole') parts.push(`All ${pcs(p.took)} pcs of the ${bundles} become size ${p.to}`)
    else if (bulkHow === 'each')
      parts.push(
        p.takes.some((x) => x < p.asked)
          ? `Up to ${pcs(p.asked)} pcs from every bundle (a bundle with fewer gives all it has) = ${pcs(p.took)} pcs become size ${p.to}`
          : `${pcs(p.asked)} pcs from every bundle × ${bundles} = ${pcs(p.took)} pcs become size ${p.to}`,
      )
    else {
      const even = p.takes.every((x) => x === p.takes[0])
      const split = even ? `${pcs(p.takes[0])} from each` : p.takes.length <= 8 ? p.takes.map(pcs).join(' + ') : `${pcs(Math.min(...p.takes))} or ${pcs(Math.max(...p.takes))} from each`
      parts.push(`${pcs(p.took)} pcs divided over ${bundles} (${split}) become size ${p.to}`)
      if (p.took < p.asked) parts.push(`only ${pcs(p.took)} of the ${pcs(p.asked)}: the bundles hold no more`)
    }
    if (p.kept > 0) parts.push(`${pcs(p.kept)} ${tickedSizes.length === 1 ? `stay size ${tickedSizes[0]}` : 'keep their size'}`)
    if (p.skipped) parts.push(`${p.skipped} already size ${p.to}, left as ${p.skipped === 1 ? 'it is' : 'they are'}`)
    return { text: parts.join(' · ') }
  })()

  /** The bar: the same change on every bundle ticked, each bundle's count kept. */
  const applyBulk = () => {
    const p = bulkPlan
    if (!p) return
    if (p.kind === 'error' || (p.kind === 'undo' && !p.rows.length) || (p.kind === 'move' && !p.fit.length)) return setBulkTried(true)
    const nextValues = { ...values }
    const nextMade = { ...madeAs }
    if (p.kind === 'undo') {
      for (const r of p.rows) {
        nextValues[r.id] = { ...nextValues[r.id], qty: String(countOf(r.id)) }
        delete nextMade[r.id]
      }
      // An undo is a one-off: the bar goes back to asking for a size, not to undoing the next run too.
      setBulkTo('')
      setBulkNote({ text: `${p.rows.length} ${p.rows.length === 1 ? 'bundle keeps its' : 'bundles keep their'} own size again.` })
    } else {
      p.fit.forEach((r, i) => {
        if (p.takes[i] <= 0) return
        nextMade[r.id] = { toSizeId: bulkTo, qty: String(p.takes[i]) }
        nextValues[r.id] = { ...nextValues[r.id], qty: String(p.caps[i] - p.takes[i]) }
      })
      const done = p.takes.filter((x) => x > 0).length
      setBulkNote({
        text: `Done: ${pcs(p.took)} pcs of ${done} ${done === 1 ? 'bundle' : 'bundles'} now size ${p.to}.${p.skipped ? ` ${p.skipped} already size ${p.to}, left as ${p.skipped === 1 ? 'it is' : 'they are'}.` : ''}`,
      })
    }
    setValues(nextValues)
    setMadeAs(nextMade)
    setTicked([])
    setLastTick(null)
    setBulkTried(false)
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
              Tick bundles (<b>Shift+click</b> ticks a run, or tick a whole size), set the size and pieces in the bar, and <b>Apply</b>. Pieces made as another
              size come out of <b>Same size</b>, so each bundle&apos;s count stays as it arrived.
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

            {/* The changes by move, to check before saving: a line per change of size, not one per bundle. */}
            {moves.length > 0 && (
              <div className="border-border bg-card mt-3 overflow-x-auto rounded-lg border">
                <table className="w-full text-xs tabular-nums" aria-label="Size changes">
                  <thead>
                    <tr className="bg-secondary text-muted-foreground">
                      <th className="px-2.5 py-1.5 text-left font-medium">Size change</th>
                      <th className="px-2.5 py-1.5 text-right font-medium">Pieces</th>
                      <th className="px-2.5 py-1.5 text-right font-medium">Bundles</th>
                      <th className="px-2.5 py-1.5 text-left font-medium">Which bundles</th>
                      <th className="px-2.5 py-1.5 text-right font-medium">From each</th>
                      <th className="px-2.5 py-1.5">
                        <span className="sr-only">Undo</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {moves.map((m) => {
                      const qtys = m.items.map((c) => c.qty)
                      const lo = Math.min(...qtys)
                      const hi = Math.max(...qtys)
                      const to = sizeCode(m.toSizeId)
                      return (
                        <tr key={`${m.from}-${m.toSizeId}`} className="border-border border-t">
                          <td className="text-foreground whitespace-nowrap px-2.5 py-1.5 font-semibold">
                            {m.from} → {to}
                          </td>
                          <td className="text-foreground px-2.5 py-1.5 text-right font-semibold">{pcs(qtys.reduce((s, q) => s + q, 0))}</td>
                          <td className="px-2.5 py-1.5 text-right">{m.items.length}</td>
                          <td className="px-2.5 py-1.5 font-mono text-[11px]">{bundleRuns(m.items.map((c) => c.row.code))}</td>
                          <td className="px-2.5 py-1.5 text-right">{lo === hi ? pcs(lo) : `${pcs(lo)}–${pcs(hi)}`}</td>
                          <td className="px-2.5 py-1 text-right">
                            <button type="button" className="btn-ghost h-6 px-2 text-[11px]" onClick={() => undoMove(m)} aria-label={`Undo ${m.from} to ${to}`}>
                              Undo
                            </button>
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                  {moves.length > 1 && (
                    <tfoot>
                      <tr className="bg-secondary border-border border-t">
                        <td className="px-2.5 py-1.5 font-semibold">Total</td>
                        <td className="px-2.5 py-1.5 text-right font-semibold">{pcs(moving)}</td>
                        <td className="px-2.5 py-1.5 text-right font-semibold">{changes.length}</td>
                        <td className="text-muted-foreground px-2.5 py-1.5" colSpan={3}>
                          {changes.length} new bundles, stickers after saving
                        </td>
                      </tr>
                    </tfoot>
                  )}
                </table>
              </div>
            )}
          </div>
        )}

        {/* Ticking a whole size, and the bar that sets every bundle ticked — held at the top while the table scrolls. */}
        {sizing && changeable.length > 0 && (
          <div className="sticky top-0 z-20 mb-2">
            {tickedRows.length > 0 ? (
              <div className="border-primary/50 bg-card space-y-2 rounded-lg border p-2.5 shadow-md">
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  <span className="text-foreground text-xs font-semibold">
                    {tickedRows.length} {tickedRows.length === 1 ? 'bundle' : 'bundles'} ticked
                  </span>
                  <span className="text-muted-foreground text-xs">
                    · {pcs(tickedPcs)} pcs{tickedSizes.length === 1 ? ` of size ${tickedSizes[0]}` : ''}
                  </span>
                  <button type="button" className="btn-ghost ml-auto h-7 px-2 text-xs" onClick={() => setTicked([])}>
                    Untick
                  </button>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-muted-foreground text-xs">Made as</span>
                  <SmartSelect className="form-input h-8 w-32 py-0 text-xs" value={bulkTo} onChange={(e) => setBulkTo(e.target.value)} aria-label="Ticked bundles made as size">
                    <option value="">Pick a size…</option>
                    {(sizes ?? []).map((z) => (
                      <option key={z.id} value={z.id}>
                        Size {z.code}
                      </option>
                    ))}
                    <option value={SAME}>Their own size (undo)</option>
                  </SmartSelect>
                  {bulkTo !== SAME && (
                    <>
                      <div className="border-border bg-secondary inline-flex flex-wrap rounded-lg border p-0.5" role="radiogroup" aria-label="How many pieces">
                        {HOW.map(([key, label]) => (
                          <button
                            key={key}
                            type="button"
                            role="radio"
                            aria-checked={bulkHow === key}
                            onClick={() => setBulkHow(key)}
                            className={`rounded-md px-2.5 py-1 text-xs ${bulkHow === key ? 'bg-card text-foreground font-semibold shadow-sm' : 'text-muted-foreground hover:text-foreground'}`}
                          >
                            {label}
                          </button>
                        ))}
                      </div>
                      {bulkHow !== 'whole' && (
                        <span className="flex items-center gap-1.5 text-xs">
                          <StepInput
                            className="form-input h-8 w-20 text-right text-xs tabular-nums"
                            value={bulkQty}
                            // Left empty after lowering Same size, the pieces not kept there are the ones changed.
                            placeholder={bulkHow === 'each' && tickedRows.some((r) => restOf(r) > 0) ? 'the rest' : '0'}
                            onValueChange={setBulkQty}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') {
                                e.preventDefault()
                                applyBulk()
                              }
                            }}
                            aria-label={bulkHow === 'each' ? 'Pieces from every bundle' : 'Total pieces'}
                          />
                          <span className="text-muted-foreground">pcs</span>
                        </span>
                      )}
                    </>
                  )}
                  <button type="button" className="btn-primary h-8 px-3 text-xs" onClick={applyBulk}>
                    Apply to {tickedRows.length}
                  </button>
                </div>
                {/* What Apply will do, with the numbers as they stand. */}
                {bulkPreview && (
                  <p className={`text-xs ${bulkPreview.bad ? (bulkTried ? 'text-destructive font-medium' : 'text-muted-foreground') : 'text-primary font-medium'}`} aria-live="polite">
                    {bulkPreview.bad ? '' : '→ '}
                    {bulkPreview.text}
                  </p>
                )}
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
      </Section>
    </FormFrame>
  )
}
