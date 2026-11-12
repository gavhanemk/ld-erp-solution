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
 */
export function CountInDialog({
  transfer,
  moNumber,
  sizes,
  onClose,
  onSaved,
}: {
  transfer: FlowTransfer
  moNumber: string
  /** The job card's sizes, when this is a count-in at stitching on our own floor; null otherwise. */
  sizes?: Array<{ id: string; code: string }> | null
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

  const setSame = (lineId: string, qty: number) => setValues((x) => ({ ...x, [lineId]: { ...x[lineId], qty: String(qty) } }))
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
    if (had?.toSizeId) return setMadeAs((x) => ({ ...x, [r.id]: { ...x[r.id], toSizeId } }))
    // The bundle's pieces not counted as the same size, if any; otherwise how many is typed, and taken from Same size.
    const rest = Math.max(0, r.available - sameOf(r.id))
    setMadeAs((x) => ({ ...x, [r.id]: { toSizeId, qty: rest ? String(rest) : '' } }))
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
              <div data-size-change={r.id}>
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
              On a bundle whose pieces are made as another size, pick the size and enter how many. They are taken from <b>Same size</b>, so the bundle&apos;s count stays
              as it was: Same size + made as another size = what arrived, and all of it is counted in. Each bundle&apos;s changed pieces become a new bundle with its own
              sticker; the order&apos;s planned sizes stay as they are.
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
