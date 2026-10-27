'use client'

import { useMemo, useState } from 'react'
import { CheckCircle2, ClipboardPaste, Package, Wand2 } from 'lucide-react'
import { FormFrame } from '@/components/ui/FormFrame'
import { SmartSelect } from '@/components/ui/SmartSelect'
import { StepInput } from '@/components/ui/StepInput'
import { parseSizes, splitEvenly } from '@/components/packages/packageTypes'
import { PackageRows, type SizeRow } from '@/components/packages/PackageRows'

export type PackageRow = SizeRow

const round3 = (n: number) => Math.round(n * 1000) / 1000
const fmt = (n: number) => round3(n).toLocaleString('en-IN', { maximumFractionDigits: 3 })
const num = (s: string) => {
  const n = Number(s)
  return Number.isFinite(n) ? n : 0
}

/**
 * The size of every package a receipt line came in, one row each, with a note
 * where one is worth keeping: "short width", "torn bag". One sticker is made
 * for each row, with its own quantity and note.
 *
 * Opened over the receipt from its "Packed as" cell. Many parcels are entered
 * the way a storekeeper reads a packing list: a quick fill for the standard
 * pack ("10 packets of 50"), a box to paste the supplier's list, then rows to
 * correct one by one. The total is checked against what arrived as it is
 * typed; when the parcels add up to something else, what arrived can be set
 * to their total from here.
 */
export function PackageSizesDialog({
  item,
  unit,
  received,
  packType,
  packNouns,
  perPack,
  initial,
  onSave,
  onClose,
}: {
  item: string
  unit: string
  /** What the receipt line says arrived. */
  received: number
  packType: string
  packNouns: Array<{ value: string; label: string }>
  /** The item's own qty per sticker, to start the quick fill with. */
  perPack?: number | null
  initial: PackageRow[]
  onSave: (r: { rows: Array<{ qty: number; note: string }>; packType: string; received?: number }) => void
  onClose: () => void
}) {
  const [rows, setRows] = useState<PackageRow[]>(initial.length ? initial : [{ qty: '', note: '' }])
  const [type, setType] = useState(packType)
  const [fillCount, setFillCount] = useState(() =>
    perPack && received > 0 ? String(Math.max(1, Math.ceil(received / perPack))) : '',
  )
  const [fillSize, setFillSize] = useState(() => (perPack ? String(perPack) : ''))
  const [pasting, setPasting] = useState(false)
  const [pasted, setPasted] = useState('')
  const noun = packNouns.find((n) => n.value === type)?.label.toLowerCase() ?? 'packages'

  const sizes = rows.map((r) => num(r.qty))
  const filled = sizes.filter((q) => q > 0)
  const total = round3(filled.reduce((s, q) => s + q, 0))
  const diff = round3(total - received)
  const empty = rows.findIndex((r) => !(num(r.qty) > 0))
  const matches = filled.length > 0 && empty < 0 && Math.abs(diff) <= 0.0005

  /** "10 packets of 50": the standard pack. Without a size, what arrived is split evenly. */
  const quickFill = () => {
    const n = Math.floor(num(fillCount))
    if (!(n >= 1)) return
    const each = num(fillSize)
    const qtys = each > 0 ? Array<number>(n).fill(round3(each)) : splitEvenly(received, n)
    setRows(qtys.map((q, i) => ({ qty: String(q), note: rows[i]?.note ?? '' })))
  }
  const usePasted = () => {
    const qtys = parseSizes(pasted)
    if (!qtys.length) return
    setRows(qtys.map((q) => ({ qty: String(q), note: '' })))
    setPasting(false)
    setPasted('')
  }

  const save = (alsoReceived?: number) =>
    onSave({
      rows: rows.filter((r) => num(r.qty) > 0).map((r) => ({ qty: round3(num(r.qty)), note: r.note.trim() })),
      packType: type,
      ...(alsoReceived != null ? { received: alsoReceived } : {}),
    })

  const status = useMemo(() => {
    if (!filled.length) return { tone: 'muted', text: `Enter the size of each ${noun.replace(/s$/, '')}, or fill them in above.` }
    if (empty >= 0) return { tone: 'warn', text: `Row ${empty + 1} has no size. Fill it in or remove it.` }
    if (Math.abs(diff) <= 0.0005) return { tone: 'ok', text: `${filled.length} ${noun} · ${fmt(total)} ${unit}, the same as arrived.` }
    return {
      tone: 'warn',
      text: `${filled.length} ${noun} add up to ${fmt(total)} ${unit}, but ${fmt(received)} ${unit} arrived: ${fmt(Math.abs(diff))} ${unit} ${diff < 0 ? 'short' : 'over'}.`,
    }
  }, [filled.length, empty, diff, total, received, unit, noun])

  return (
    <FormFrame
      icon={Package}
      title="Package sizes"
      subtitle={`${item} · ${fmt(received)} ${unit} arrived. One sticker is made for each package below.`}
      onClose={onClose}
      width="max-w-4xl"
      primaryInHeader={false}
      primary={
        <button type="button" className="btn-primary" disabled={!matches} onClick={() => save()}>
          <CheckCircle2 size={15} /> Save sizes
        </button>
      }
      footer={
        <>
          {!matches && filled.length > 0 && empty < 0 && (
            <button type="button" className="btn-secondary" onClick={() => save(total)} title="The parcels were weighed or measured: what arrived is their total">
              Use {fmt(total)} {unit} as received
            </button>
          )}
          <button type="button" className="btn-secondary" onClick={onClose}>
            Cancel
          </button>
        </>
      }
      footerNote={<span className={status.tone === 'ok' ? 'text-primary' : status.tone === 'warn' ? 'warn-text' : ''}>{status.text}</span>}
    >
      <div className="space-y-4">
        {/* The standard pack, in one line, and the supplier's list pasted in. */}
        <div className="border-border bg-secondary/40 space-y-2 rounded-xl border p-3">
          <div className="flex flex-wrap items-end gap-2 text-sm">
            <label className="text-muted-foreground flex flex-col text-xs">
              How many
              <StepInput id="pack-fill-count" className="form-input mt-1 h-9 w-20 text-right" value={fillCount} onValueChange={setFillCount} aria-label="How many packages" />
            </label>
            <label className="text-muted-foreground flex flex-col text-xs">
              Of what
              <SmartSelect id="pack-type" className="form-input mt-1 h-9 w-32" value={type} onChange={(e) => setType(e.target.value)} aria-label="What one package is">
                {packNouns.map((n) => (
                  <option key={n.value} value={n.value}>
                    {n.label}
                  </option>
                ))}
              </SmartSelect>
            </label>
            <label className="text-muted-foreground flex flex-col text-xs">
              Each holding
              <span className="mt-1 flex items-center gap-1.5">
                <StepInput id="pack-fill-size" decimals className="form-input h-9 w-24 text-right" value={fillSize} onValueChange={setFillSize} placeholder="even" aria-label="How much each holds" />
                <span className="text-foreground text-sm">{unit}</span>
              </span>
            </label>
            <button type="button" className="btn-secondary h-9" onClick={quickFill} disabled={!(num(fillCount) >= 1)}>
              <Wand2 size={14} /> Fill the rows
            </button>
            <button type="button" className="text-primary ml-auto text-xs font-medium hover:underline" onClick={() => setPasting((p) => !p)}>
              <ClipboardPaste size={13} className="mr-1 inline" />
              {pasting ? 'Close' : 'Paste a packing list'}
            </button>
          </div>
          <p className="text-muted-foreground text-[11px]">
            The standard pack fills every row at once: 10 packets of 50. Leave "each holding" empty to split what arrived evenly. Then change any row that differs.
          </p>
          {pasting && (
            <div className="space-y-1.5">
              <textarea
                id="pack-paste"
                className="form-input min-h-[5rem] w-full text-sm"
                placeholder={'One size a line, or with commas:\n100\n98.5\n101'}
                value={pasted}
                onChange={(e) => setPasted(e.target.value)}
              />
              <button type="button" className="btn-secondary h-8 text-xs" onClick={usePasted} disabled={!parseSizes(pasted).length}>
                Use {parseSizes(pasted).length || ''} sizes
              </button>
            </div>
          )}
        </div>

        {/* One row a package: its size, and a note when one is worth keeping. */}
        <PackageRows rows={rows} onChange={setRows} unit={unit} max={1000} />
      </div>
    </FormFrame>
  )
}
