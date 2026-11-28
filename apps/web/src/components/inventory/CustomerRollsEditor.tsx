'use client'

import { useState } from 'react'
import { CheckCircle2, ClipboardPaste, Plus, Trash2 } from 'lucide-react'
import { StepInput } from '@/components/ui/StepInput'

/**
 * A receipt line's rolls, roll by roll: the barcode the customer put on each,
 * its metres, and the design and lot written on it (the user's decision of
 * 28 Nov 2026). The job-work challan later names these rolls, so the pieces
 * going back can be told roll by roll, as the old ERP's job challan did.
 *
 * The rolls add up to what was received on the line; a list copied from the
 * customer's packing sheet can be pasted in one go, a row a roll.
 */

export interface RollDraft {
  barcode: string
  meters: string
  designNo: string
  lotNo: string
}

export const emptyRoll = (): RollDraft => ({ barcode: '', meters: '', designNo: '', lotNo: '' })

const round3 = (n: number) => Math.round(n * 1000) / 1000
const fmt = (n: number) => n.toLocaleString('en-IN', { maximumFractionDigits: 3 })

/** The rolls' metres added up. */
export const rollsTotal = (rolls: RollDraft[]) => round3(rolls.reduce((s, r) => s + (Number(r.meters) || 0), 0))

/** A roll row with anything typed in it. */
export const isFilled = (r: RollDraft) => Boolean(r.barcode.trim() || r.meters.trim() || r.designNo.trim() || r.lotNo.trim())

/**
 * Rows copied from a sheet, a roll a row: barcode, metres, then design and lot
 * if given, separated by tabs (as Excel copies them) or commas. A heading row
 * ("Barcode, Metres…") is skipped, as is any row without a barcode.
 */
export function parseRolls(text: string): RollDraft[] {
  return text
    .split(/\r?\n/)
    .map((row) => row.split(row.includes('\t') ? '\t' : ',').map((c) => c.trim()))
    .filter((cells) => cells[0] && !/^bar\s*code|^barcode/i.test(cells[0]))
    .map((cells) => ({
      barcode: cells[0],
      meters: String(Number((cells[1] ?? '').replace(/[^\d.]/g, '')) || ''),
      designNo: cells[2] ?? '',
      lotNo: cells[3] ?? '',
    }))
}

export function CustomerRollsEditor({
  rolls,
  onChange,
  received,
  unit,
  lineNo,
  onUseTotal,
}: {
  rolls: RollDraft[]
  onChange: (rolls: RollDraft[]) => void
  /** What the line says was received, for the rolls to add up to. */
  received: number
  unit: string
  lineNo: number
  /** Puts the rolls' total in the line's received box. */
  onUseTotal: (total: number) => void
}) {
  const [pasting, setPasting] = useState(false)
  const [pasted, setPasted] = useState('')
  const rows = rolls.length ? rolls : [emptyRoll()]
  const filled = rolls.filter(isFilled)
  const total = rollsTotal(filled)
  const diff = round3(total - received)

  const set = (i: number, patch: Partial<RollDraft>) => onChange(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)))
  const remove = (i: number) => onChange(rows.filter((_, j) => j !== i))
  const addPasted = () => {
    const more = parseRolls(pasted)
    if (!more.length) return
    onChange([...filled, ...more])
    setPasted('')
    setPasting(false)
  }

  return (
    <div className="border-border bg-secondary/30 space-y-2.5 rounded-lg border p-3">
      <div className="flex flex-wrap items-center gap-2">
        <p className="text-foreground mr-auto text-sm font-medium">
          Rolls on line {lineNo}
          <span className="text-muted-foreground ml-2 text-xs font-normal">
            {filled.length} {filled.length === 1 ? 'roll' : 'rolls'} · {fmt(total)} {unit}
          </span>
        </p>
        <button type="button" className="btn-ghost h-8 text-xs" onClick={() => setPasting((p) => !p)}>
          <ClipboardPaste size={14} /> Paste from sheet
        </button>
        <button type="button" className="btn-secondary h-8 text-xs" onClick={() => onChange([...rows, emptyRoll()])}>
          <Plus size={14} /> Add roll
        </button>
      </div>

      {pasting && (
        <div className="space-y-2">
          <textarea
            className="form-input min-h-[90px] font-mono text-xs"
            value={pasted}
            onChange={(e) => setPasted(e.target.value)}
            placeholder={'Copy the rows from their packing sheet and paste here, a roll a row:\nBarcode    Metres    Design    Lot\nC73142477  86.77     D-102     7'}
            aria-label={`Rolls to paste on line ${lineNo}`}
          />
          <div className="flex items-center justify-end gap-2">
            <span className="text-muted-foreground mr-auto text-xs">
              {parseRolls(pasted).length ? `${parseRolls(pasted).length} rolls found` : 'Barcode and metres, then design and lot if they have them'}
            </span>
            <button type="button" className="btn-ghost h-8 text-xs" onClick={() => setPasting(false)}>
              Cancel
            </button>
            <button type="button" className="btn-primary h-8 text-xs" onClick={addPasted} disabled={!parseRolls(pasted).length}>
              Add these rolls
            </button>
          </div>
        </div>
      )}

      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-muted-foreground text-left text-[11px] uppercase tracking-wide">
              <th className="w-8 pb-1.5 pr-2 font-medium">#</th>
              <th className="pb-1.5 pr-2 font-medium">Their barcode</th>
              <th className="w-32 pb-1.5 pr-4 text-right font-medium">Metres</th>
              <th className="pb-1.5 pr-2 font-medium">Design</th>
              <th className="pb-1.5 font-medium">Lot</th>
              <th className="w-10" />
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i}>
                <td className="text-muted-foreground py-1 pr-2 text-xs tabular-nums">{i + 1}</td>
                <td className="py-1 pr-2">
                  <input
                    className="form-input h-8 font-mono uppercase"
                    value={r.barcode}
                    maxLength={60}
                    onChange={(e) => set(i, { barcode: e.target.value.toUpperCase() })}
                    placeholder="Scan or type"
                    aria-label={`Barcode of roll ${i + 1} on line ${lineNo}`}
                  />
                </td>
                <td className="py-1 pr-2">
                  <StepInput
                    className="form-input h-8 text-right tabular-nums"
                    decimals
                    value={r.meters}
                    onValueChange={(v) => set(i, { meters: v })}
                    aria-label={`Metres of roll ${i + 1} on line ${lineNo}`}
                  />
                </td>
                <td className="py-1 pr-2">
                  <input
                    className="form-input h-8"
                    value={r.designNo}
                    maxLength={60}
                    onChange={(e) => set(i, { designNo: e.target.value })}
                    aria-label={`Design of roll ${i + 1} on line ${lineNo}`}
                  />
                </td>
                <td className="py-1 pr-2">
                  <input
                    className="form-input h-8"
                    value={r.lotNo}
                    maxLength={50}
                    onChange={(e) => set(i, { lotNo: e.target.value })}
                    aria-label={`Lot of roll ${i + 1} on line ${lineNo}`}
                  />
                </td>
                <td className="py-1 text-right">
                  <button
                    type="button"
                    className="btn-ghost text-muted-foreground p-1.5 hover:text-red-400"
                    onClick={() => remove(i)}
                    aria-label={`Remove roll ${i + 1} on line ${lineNo}`}
                  >
                    <Trash2 size={14} />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {filled.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 text-xs">
          {diff === 0 ? (
            <span className="flex items-center gap-1.5 text-emerald-500">
              <CheckCircle2 size={13} /> The rolls add up to the {fmt(received)} {unit} received.
            </span>
          ) : (
            <>
              <span className="warn-text">
                The rolls add up to {fmt(total)} {unit}; {received ? `${fmt(received)} ${unit} is entered as received` : 'nothing is entered as received yet'}.
              </span>
              <button type="button" className="btn-ghost h-7 text-xs" onClick={() => onUseTotal(total)}>
                Received = {fmt(total)} {unit}
              </button>
            </>
          )}
        </div>
      )}
    </div>
  )
}
