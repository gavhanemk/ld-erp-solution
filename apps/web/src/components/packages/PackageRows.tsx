'use client'

import { useRef, type KeyboardEvent } from 'react'
import { Plus, Trash2 } from 'lucide-react'
import { StepInput } from '@/components/ui/StepInput'

/** One package as typed: its size, and a note when one is worth keeping. */
export interface SizeRow {
  qty: string
  note: string
}

export const emptyRow = (): SizeRow => ({ qty: '', note: '' })
/** Quantities as rows, for a list that was worked out: 49.333, 49.333, 49.334. */
export const rowsOf = (qtys: number[], notes: string[] = []): SizeRow[] => qtys.map((q, i) => ({ qty: String(q), note: notes[i] ?? '' }))
/** The sizes typed, in order, leaving out empty rows. */
export const sizesOf = (rows: SizeRow[]) => rows.map((r) => Number(r.qty)).filter((q) => Number.isFinite(q) && q > 0).map((q) => Math.round(q * 1000) / 1000)
/** The notes, lined up with `sizesOf`. */
export const notesOf = (rows: SizeRow[]) => rows.filter((r) => Number(r.qty) > 0).map((r) => r.note.trim())

/**
 * The size of each package, one box each, never a comma list: what every
 * window that makes stickers of different sizes shows. Enter in a size goes
 * to the next one and adds a row at the end, so a packing list is typed down
 * the way it is read. A long list scrolls inside its own box.
 */
export function PackageRows({
  rows,
  onChange,
  unit,
  withNotes = true,
  idPrefix = 'pack',
  max = 500,
}: {
  rows: SizeRow[]
  onChange: (rows: SizeRow[]) => void
  unit: string
  /** A note on each package: "short width", "torn bag". */
  withNotes?: boolean
  /** Keeps the boxes' ids apart when two lists are on one page. */
  idPrefix?: string
  max?: number
}) {
  const list = useRef<HTMLDivElement>(null)
  const box = (i: number) => list.current?.querySelector<HTMLInputElement>(`[data-size-row="${i}"]`) ?? null
  const set = (i: number, patch: Partial<SizeRow>) => onChange(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)))
  const add = () => {
    if (rows.length >= max) return
    onChange([...rows, emptyRow()])
    setTimeout(() => box(rows.length)?.focus(), 0)
  }
  const onKey = (i: number) => (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== 'Enter') return
    e.preventDefault()
    const next = box(i + 1)
    if (next) {
      next.focus()
      next.select()
    } else add()
  }

  return (
    <div className="space-y-2">
      <div ref={list} className="border-border max-h-[22rem] overflow-y-auto rounded-xl border">
        <table className="data-table w-full">
          <thead className="sticky top-0 z-10">
            <tr className="bg-secondary">
              <th style={{ width: 44 }}>#</th>
              <th style={{ width: withNotes ? 160 : undefined, textAlign: 'right' }}>Size ({unit})</th>
              {withNotes && <th>Note (optional)</th>}
              <th style={{ width: 44 }} />
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i}>
                <td className="text-muted-foreground text-xs tabular-nums">{i + 1}</td>
                <td>
                  <StepInput
                    id={`${idPrefix}-size-${i}`}
                    decimals
                    className="form-input h-9 w-full text-right tabular-nums"
                    value={r.qty}
                    onValueChange={(v) => set(i, { qty: v })}
                    onKeyDown={onKey(i)}
                    data-size-row={i}
                    aria-label={`Size of package ${i + 1}`}
                  />
                </td>
                {withNotes && (
                  <td>
                    <input
                      id={`${idPrefix}-note-${i}`}
                      className="form-input h-9 w-full text-sm"
                      value={r.note}
                      maxLength={120}
                      placeholder="e.g. short width, torn bag"
                      onChange={(e) => set(i, { note: e.target.value })}
                      aria-label={`Note on package ${i + 1}`}
                    />
                  </td>
                )}
                <td>
                  <button
                    type="button"
                    className="btn-ghost text-muted-foreground hover:text-destructive p-1.5"
                    onClick={() => onChange(rows.length > 1 ? rows.filter((_, j) => j !== i) : [emptyRow()])}
                    aria-label={`Remove package ${i + 1}`}
                  >
                    <Trash2 size={14} />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <button type="button" className="btn-ghost border-border h-9 w-full justify-center border border-dashed text-sm" onClick={add} disabled={rows.length >= max}>
        <Plus size={14} /> Add a package
      </button>
    </div>
  )
}
