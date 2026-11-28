'use client'

import { Fragment, useEffect, useMemo, useState } from 'react'
import { CheckCircle2, Info, ScanBarcode, Trash2 } from 'lucide-react'
import { api, ApiError } from '@/lib/api'
import { Section } from '@/components/purchase/Section'
import { SmartSelect } from '@/components/ui/SmartSelect'
import { StepInput } from '@/components/ui/StepInput'

/**
 * Fabric rolls used, on a job-work challan (the user's decision of 28 Nov
 * 2026): the customer's fabric rolls the garments were cut from, each with the
 * pieces cut from it, their grade and the bale they are packed in — what the
 * old ERP's job challan listed barcode by barcode. A roll is scanned (its
 * barcode typed) or picked; its metres and design come from the customer's
 * receipt. The rolls sit under the garment they were cut into, named as in
 * "Pieces to send" above, so the two read as one: fabric in, garments out.
 */

export interface ChallanRollDraft {
  rollId: string
  soLineId: string
  baleNo: string
  pieces: string
  grade: 'A' | 'B'
}

interface RollOption {
  id: string
  barcode: string
  meters: number
  designNo: string | null
  lotNo: string | null
  item: { code: string; name: string }
  grnNumber: string
  receiptDate: string
  partyChallan: string | null
  /** Pieces already sent from it on other challans. */
  sentPieces: number
  sentOn: string[]
}

const fmt = (n: number, dp = 2) => n.toLocaleString('en-IN', { maximumFractionDigits: dp })

export function ChallanRollsSection({
  soId,
  challanId,
  orderLines,
  rows,
  onChange,
}: {
  soId: string
  /** The challan being changed: its own pieces do not count as sent before. */
  challanId: string | null
  /** The order's garments, as "Pieces to send" names them, with their pieces on the challan now. */
  orderLines: Array<{ soLineId: string; label: string; pieces: { A: number; B: number } }>
  rows: ChallanRollDraft[]
  onChange: (rows: ChallanRollDraft[]) => void
}) {
  const [rolls, setRolls] = useState<RollOption[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [scan, setScan] = useState('')
  const [scanNote, setScanNote] = useState<string | null>(null)
  const [bale, setBale] = useState('')
  const [lineFor, setLineFor] = useState(orderLines.length === 1 ? orderLines[0].soLineId : '')
  const [focusRow, setFocusRow] = useState<number | null>(null)

  useEffect(() => {
    let alive = true
    const qs = new URLSearchParams({ soId })
    if (challanId) qs.set('dcId', challanId)
    api
      .get<{ data: RollOption[] }>(`/sales/challans/rolls?${qs}`)
      .then((res) => alive && setRolls(res.data))
      .catch((err) => alive && setError(err instanceof ApiError ? err.message : 'Could not read the customer’s rolls.'))
    return () => {
      alive = false
    }
  }, [soId, challanId])

  // A roll just added: its pieces box takes the cursor, ready to type.
  useEffect(() => {
    if (focusRow == null) return
    document.getElementById(`dc-roll-pieces-${focusRow}`)?.focus()
    setFocusRow(null)
  }, [focusRow, rows.length])

  const rollOf = useMemo(() => new Map((rolls ?? []).map((r) => [r.id, r])), [rolls])
  const multiLine = orderLines.length > 1

  const add = (roll: RollOption) => {
    const soLineId = lineFor || (orderLines.length === 1 ? orderLines[0].soLineId : '')
    if (rows.some((r) => r.rollId === roll.id && r.soLineId === soLineId && r.grade === 'A')) {
      setScanNote(`Roll ${roll.barcode} is already on the challan. Change its pieces there.`)
      return
    }
    onChange([...rows, { rollId: roll.id, soLineId, baleNo: bale.trim(), pieces: '', grade: 'A' }])
    setFocusRow(rows.length)
    setScanNote(null)
  }

  const scanIn = () => {
    const code = scan.trim().toUpperCase()
    if (!code) return
    const roll = (rolls ?? []).find((r) => r.barcode.toUpperCase() === code)
    if (!roll) {
      setScanNote(`No roll ${code} on this customer's receipts approved into stock.`)
      return
    }
    add(roll)
    setScan('')
  }

  const set = (i: number, patch: Partial<ChallanRollDraft>) => onChange(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)))

  const totals = useMemo(() => {
    let A = 0
    let B = 0
    let meters = 0
    const bales = new Set<string>()
    const counted = new Set<string>()
    for (const r of rows) {
      const n = Number(r.pieces) || 0
      if (r.grade === 'B') B += n
      else A += n
      if (r.baleNo.trim()) bales.add(r.baleNo.trim().toUpperCase())
      // A roll's metres once, however many rows it is on.
      if (!counted.has(r.rollId)) {
        counted.add(r.rollId)
        meters += rollOf.get(r.rollId)?.meters ?? 0
      }
    }
    return { A, B, meters, bales: bales.size, rolls: counted.size }
  }, [rows, rollOf])

  const notOn = (rolls ?? []).filter((r) => !rows.some((x) => x.rollId === r.id))

  // The rolls under the garment they were cut into, in the order's order; a
  // roll whose garment is not chosen yet (several garments) comes last.
  const groups = useMemo(() => {
    const at = rows.map((r, i) => ({ r, i }))
    const out = orderLines.map((line) => {
      const mine = at.filter((x) => x.r.soLineId === line.soLineId || (!multiLine && !x.r.soLineId))
      const sum = (g: 'A' | 'B') => Math.round(mine.filter((x) => x.r.grade === g).reduce((t, x) => t + (Number(x.r.pieces) || 0), 0) * 100) / 100
      return { key: line.soLineId, label: line.label, pieces: line.pieces, rows: mine, A: sum('A'), B: sum('B') }
    })
    const unset = multiLine ? at.filter((x) => !x.r.soLineId) : []
    if (unset.length) out.push({ key: '', label: '', pieces: { A: 0, B: 0 }, rows: unset, A: 0, B: 0 })
    return out.filter((g) => g.rows.length > 0)
  }, [rows, orderLines, multiLine])
  const cols = multiLine ? 9 : 8

  return (
    <Section icon={ScanBarcode} title="Fabric rolls used">
      <p className="text-muted-foreground mb-3 text-xs">
        Which of the customer&apos;s fabric rolls the garments above were cut from; the challan prints them. Scan or pick a
        roll, then enter the pieces cut from it. Its metres and design come from the customer&apos;s receipt; the bale no.
        stays for the next roll you add.
      </p>

      {error && <p className="text-destructive mb-2 text-sm">{error}</p>}
      {rolls && rolls.length === 0 && (
        <p className="text-muted-foreground mb-3 flex items-start gap-1.5 text-sm">
          <Info size={14} className="mt-0.5 shrink-0" />
          No rolls are recorded on this customer&apos;s approved receipts. List the rolls on their receipt (Inventory → Customer
          material) to name them here.
        </p>
      )}

      {rolls && rolls.length > 0 && (
        <div className="mb-3 grid gap-2 md:grid-cols-[minmax(0,1.3fr)_120px_minmax(0,1fr)_minmax(0,1.4fr)]">
          <div className="relative">
            <ScanBarcode size={14} className="text-muted-foreground pointer-events-none absolute left-3 top-1/2 -translate-y-1/2" />
            <input
              className="form-input pl-9 font-mono uppercase"
              value={scan}
              onChange={(e) => setScan(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  // Enter adds the roll here; it does not move on to the next box.
                  e.preventDefault()
                  e.stopPropagation()
                  scanIn()
                }
              }}
              placeholder="Scan a fabric roll barcode, Enter"
              aria-label="Scan or type a roll's barcode, then press Enter"
            />
          </div>
          <input
            className="form-input"
            value={bale}
            maxLength={30}
            onChange={(e) => setBale(e.target.value)}
            placeholder="Bale no."
            aria-label="Bale number for the rolls added next"
          />
          {multiLine ? (
            <SmartSelect className="form-input" value={lineFor} onChange={(e) => setLineFor(e.target.value)} aria-label="Garment the next rolls are for">
              <option value="">Garment…</option>
              {orderLines.map((l) => (
                <option key={l.soLineId} value={l.soLineId}>
                  {l.label}
                </option>
              ))}
            </SmartSelect>
          ) : (
            <span />
          )}
          <SmartSelect
            className="form-input"
            value=""
            onChange={(e) => {
              const roll = rollOf.get(e.target.value)
              if (roll) add(roll)
            }}
            aria-label="Pick a roll to add"
          >
            <option value="">Or pick a roll… ({notOn.length})</option>
            {notOn.map((r) => (
              <option key={r.id} value={r.id} data-sub={[r.grnNumber, r.sentPieces ? `${fmt(r.sentPieces)} pcs sent before` : null].filter(Boolean).join(' · ')}>
                {r.barcode} · {fmt(r.meters, 3)} m{r.designNo ? ` · ${r.designNo}` : ''}
              </option>
            ))}
          </SmartSelect>
        </div>
      )}
      {scanNote && <p className="warn-text mb-2 text-xs">{scanNote}</p>}

      {rows.length > 0 && (
        <div className="border-border overflow-x-auto rounded-lg border">
          <table className="w-full text-sm">
            <thead className="bg-secondary/50">
              <tr className="text-muted-foreground text-left text-[11px] uppercase tracking-wide">
                <th className="w-8 px-3 py-2 font-medium">#</th>
                <th className="px-2 py-2 font-medium">Barcode</th>
                <th className="px-2 py-2 font-medium">Design · Lot</th>
                <th className="px-2 py-2 text-right font-medium">Fabric (m)</th>
                {multiLine && <th className="px-2 py-2 font-medium">Garment</th>}
                <th className="w-28 px-2 py-2 font-medium">Grade</th>
                <th className="w-28 px-2 py-2 font-medium">Bale</th>
                <th className="w-32 px-2 py-2 text-right font-medium">Pcs cut from it</th>
                <th className="w-10" />
              </tr>
            </thead>
            <tbody className="divide-border/60 divide-y">
              {groups.map((g) => {
                const want = g.pieces.A + g.pieces.B
                const match = g.key !== '' && g.A === g.pieces.A && g.B === g.pieces.B
                return (
                  <Fragment key={g.key || 'unset'}>
                    {/* The garment these rolls were cut into, named as in "Pieces to send". */}
                    <tr className="bg-secondary/30">
                      <td colSpan={cols} className="px-3 py-1.5 text-xs">
                        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-0.5">
                          {g.key ? (
                            <span className="text-muted-foreground">
                              Cut into <span className="text-foreground font-medium">{g.label}</span>
                            </span>
                          ) : (
                            <span className="warn-text">Garment not chosen yet: pick it on each roll below.</span>
                          )}
                          {g.key &&
                            (match ? (
                              <span className="flex items-center gap-1.5 text-emerald-500">
                                <CheckCircle2 size={13} /> {fmt(want)} pcs on this challan, all from these rolls
                              </span>
                            ) : (
                              <span className="warn-text">
                                From these rolls {fmt(g.A + g.B)} pcs · on this challan {fmt(want)} pcs
                                {g.B || g.pieces.B ? ` (B-grade ${fmt(g.B)} vs ${fmt(g.pieces.B)})` : ''}
                              </span>
                            ))}
                        </div>
                      </td>
                    </tr>
                    {g.rows.map(({ r, i }) => {
                const roll = rollOf.get(r.rollId)
                return (
                  <tr key={`${r.rollId}-${i}`}>
                    <td className="text-muted-foreground px-3 py-1.5 text-xs tabular-nums">{i + 1}</td>
                    <td className="px-2 py-1.5">
                      <span className="font-mono text-xs font-medium">{roll?.barcode ?? '…'}</span>
                      {roll && roll.sentPieces > 0 && (
                        <span className="text-muted-foreground block text-[11px]">
                          {fmt(roll.sentPieces)} pcs sent before{roll.sentOn.length ? ` (${roll.sentOn.join(', ')})` : ''}
                        </span>
                      )}
                    </td>
                    <td className="text-muted-foreground px-2 py-1.5 text-xs">
                      {[roll?.designNo, roll?.lotNo && `Lot ${roll.lotNo}`].filter(Boolean).join(' · ') || '—'}
                    </td>
                    <td className="px-2 py-1.5 text-right text-xs tabular-nums">{roll ? fmt(roll.meters, 3) : '…'}</td>
                    {multiLine && (
                      <td className="px-2 py-1.5">
                        <SmartSelect className="form-input h-8" value={r.soLineId} onChange={(e) => set(i, { soLineId: e.target.value })} aria-label={`Garment for roll ${i + 1}`}>
                          <option value="">Garment…</option>
                          {orderLines.map((l) => (
                            <option key={l.soLineId} value={l.soLineId}>
                              {l.label}
                            </option>
                          ))}
                        </SmartSelect>
                      </td>
                    )}
                    <td className="px-2 py-1.5">
                      <SmartSelect className="form-input h-8" value={r.grade} onChange={(e) => set(i, { grade: e.target.value === 'B' ? 'B' : 'A' })} aria-label={`Grade for roll ${i + 1}`}>
                        <option value="A">Fresh</option>
                        <option value="B">B-grade</option>
                      </SmartSelect>
                    </td>
                    <td className="px-2 py-1.5">
                      <input className="form-input h-8" value={r.baleNo} maxLength={30} onChange={(e) => set(i, { baleNo: e.target.value })} aria-label={`Bale for roll ${i + 1}`} />
                    </td>
                    <td className="px-2 py-1.5">
                      <StepInput
                        id={`dc-roll-pieces-${i}`}
                        className="form-input h-8 text-right tabular-nums"
                        value={r.pieces}
                        onValueChange={(v) => set(i, { pieces: v })}
                        aria-label={`Pieces from roll ${i + 1}`}
                      />
                    </td>
                    <td className="px-2 py-1.5 text-right">
                      <button type="button" className="btn-ghost text-muted-foreground p-1.5 hover:text-red-400" onClick={() => onChange(rows.filter((_, j) => j !== i))} aria-label={`Remove roll ${i + 1}`}>
                        <Trash2 size={14} />
                      </button>
                    </td>
                  </tr>
                )
                    })}
                  </Fragment>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      {rows.length > 0 && (
        <div className="mt-2.5 flex flex-wrap items-center gap-x-5 gap-y-1 text-xs">
          <span className="text-muted-foreground">
            {totals.rolls} fabric {totals.rolls === 1 ? 'roll' : 'rolls'} · {fmt(totals.meters, 3)} m · {totals.bales}{' '}
            {totals.bales === 1 ? 'bale' : 'bales'} · {fmt(totals.A + totals.B)} pcs cut from them
          </span>
        </div>
      )}
    </Section>
  )
}
