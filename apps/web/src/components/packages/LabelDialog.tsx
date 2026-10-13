'use client'

import { useMemo, useState } from 'react'
import { ClipboardPaste, Loader2, Plus, Printer, Tags, X } from 'lucide-react'
import { api, ApiError } from '@/lib/api'
import { FormFrame } from '@/components/ui/FormFrame'
import { Section } from '@/components/purchase/Section'
import { SmartSelect } from '@/components/ui/SmartSelect'
import { StepInput } from '@/components/ui/StepInput'
import { PACK_TYPES, openPrintTab, packCount, printLabels, qtyText } from './packageTypes'

/** Stock to be labelled: a GRN line, or what is already on the rack. */
export interface LabelTarget {
  itemId: string
  item: string
  itemCode: string
  unit: string
  warehouseId: string
  store: string
  ownership: 'OWNED' | 'CUSTOMER_OWNED'
  ownerCustomerId: string | null
  owner?: string | null
  grnLineId?: string | null
  grnNumber?: string | null
  supplier?: string | null
  lotNo?: string | null
  packType: string
  /** What one sticker holds, from the item's remembered setting or its unit. */
  perPack?: number | null
  /** How much can be labelled. */
  max: number
}

const r3 = (n: number) => Math.round(n * 1000) / 1000

/** "48.5, 51\n50.2" → [48.5, 51, 50.2]: a column pasted from Excel or typed. */
const parseList = (text: string) =>
  text
    .split(/[\s,;]+/)
    .map((t) => Number(t.replace(/[^\d.]/g, '')))
    .filter((n) => n > 0)

/**
 * Making stickers for stock: five boxes of ten, or one roll at a time with
 * its own metres. Every package gets its own QR, and the stickers open for
 * printing as soon as they are saved.
 */
export function LabelDialog({
  target,
  onClose,
  onDone,
}: {
  target: LabelTarget
  onClose: () => void
  /** The message, and the packages made, so their stickers can be printed again. */
  onDone: (message: string, ids: string[]) => void
}) {
  const [packType, setPackType] = useState(target.packType || 'BOX')
  // Starts from what one sticker usually holds: a roll a sticker, say.
  const start = target.perPack && target.perPack > 0 ? Math.floor(target.max / target.perPack + 1e-9) : 0
  const [mode, setMode] = useState<'same' | 'each'>(start > 0 || target.packType !== 'ROLL' ? 'same' : 'each')
  const [count, setCount] = useState(start > 0 && start <= 500 ? String(start) : '')
  const [each, setEach] = useState(start > 0 && start <= 500 ? String(target.perPack) : '')
  const [remember, setRemember] = useState(false)
  const [rows, setRows] = useState<string[]>(['', '', ''])
  const [paste, setPaste] = useState<string | null>(null)
  const [lotNo, setLotNo] = useState(target.lotNo ?? '')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const qtys = useMemo(() => {
    if (mode === 'same') {
      const n = Math.floor(Number(count) || 0)
      const q = Number(each) || 0
      return n > 0 && q > 0 ? Array.from({ length: Math.min(n, 500) }, () => q) : []
    }
    return rows.map((r) => Number(r) || 0).filter((q) => q > 0)
  }, [mode, count, each, rows])
  const total = r3(qtys.reduce((s, q) => s + q, 0))
  const left = r3(target.max - total)
  const unit = target.unit
  const kind = PACK_TYPES.find((p) => p.value === packType) ?? PACK_TYPES[6]

  const save = async () => {
    setSaving(true)
    setError(null)
    const tab = openPrintTab()
    try {
      const res = await api.post<{ message: string; data: Array<{ id: string }> }>('/packages', {
        itemId: target.itemId,
        warehouseId: target.warehouseId,
        ownership: target.ownership,
        ownerCustomerId: target.ownerCustomerId,
        grnLineId: target.grnLineId ?? null,
        packType,
        qtys,
        lotNo: lotNo.trim() || null,
        remember,
      })
      printLabels(res.data.map((p) => p.id), tab)
      onDone(res.message, res.data.map((p) => p.id))
    } catch (err) {
      tab?.close()
      setError(err instanceof ApiError ? err.message : 'Could not save. Is the API running?')
    } finally {
      setSaving(false)
    }
  }

  const blocker = !qtys.length
    ? 'Enter how many packages and what is in each.'
    : left < -1e-9
      ? `That is ${qtyText(total)} ${unit}; only ${qtyText(target.max)} can be labelled.`
      : null

  return (
    <FormFrame
      icon={Tags}
      title="Make stickers"
      subtitle={`${target.item} · ${target.store}${target.grnNumber ? ` · ${target.grnNumber}` : ''}`}
      onClose={onClose}
      busy={saving}
      error={error}
      width="max-w-3xl"
      primary={
        <button type="button" className="btn-primary" onClick={() => void save()} disabled={saving || Boolean(blocker)}>
          {saving ? <Loader2 size={15} className="animate-spin" /> : <Printer size={15} />}
          Save and print {qtys.length ? qtys.length : ''} {qtys.length === 1 ? 'sticker' : 'stickers'}
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
          <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
            {`${packCount(qtys.length, packType)}, ${qtyText(total)} ${unit}`}
            <label className="flex cursor-pointer items-center gap-1.5">
              <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
              Remember for this item
            </label>
          </span>
        )
      }
    >
      <Section icon={Tags} title="What is being labelled">
        <div className="grid gap-x-4 gap-y-3 sm:grid-cols-3">
          <div className="sm:col-span-2">
            <span className="form-label">Item</span>
            <div className="form-readout">
              <span className="font-mono text-xs text-muted-foreground">{target.itemCode}</span> {target.item}
              {target.owner ? ` · ${target.owner}'s` : ''}
            </div>
          </div>
          <div>
            <span className="form-label">Can be labelled</span>
            <div className="form-readout font-semibold">
              {qtyText(target.max)} {unit}
            </div>
          </div>
          <div>
            <label className="form-label">Each package is a</label>
            <SmartSelect className="form-input" value={packType} onChange={(e) => setPackType(e.target.value)}>
              {PACK_TYPES.map((p) => (
                <option key={p.value} value={p.value}>
                  {p.label}
                </option>
              ))}
            </SmartSelect>
          </div>
          <div>
            <label className="form-label">Lot / batch</label>
            <input className="form-input placeholder:text-muted-foreground/60" value={lotNo} onChange={(e) => setLotNo(e.target.value)} placeholder="Optional" maxLength={50} />
          </div>
          <div>
            <span className="form-label">Store</span>
            <div className="form-readout">{target.store}</div>
          </div>
        </div>
      </Section>

      <Section icon={Plus} title="How it is packed">
        <div className="mb-3 inline-flex rounded-lg border border-border p-1">
          {(
            [
              ['same', 'All the same size'],
              ['each', 'Each one different'],
            ] as const
          ).map(([m, label]) => (
            <button
              key={m}
              type="button"
              onClick={() => setMode(m)}
              className={`rounded-md px-4 py-2 text-sm font-semibold ${mode === m ? 'bg-primary text-white' : 'text-muted-foreground hover:text-foreground'}`}
            >
              {label}
            </button>
          ))}
        </div>

        {mode === 'same' ? (
          <div className="flex flex-wrap items-end gap-3">
            <div className="w-36">
              <label className="form-label">How many {kind.many}</label>
              <StepInput className="form-input h-11 text-lg" value={count} onValueChange={setCount} aria-label="Number of packages" />
            </div>
            <span className="pb-3 text-lg text-muted-foreground">×</span>
            <div className="relative w-44">
              <label className="form-label">Each holds</label>
              <StepInput className="form-input h-11 pr-12 text-lg" value={each} onValueChange={setEach} decimals aria-label="Quantity in each" />
              <span className="pointer-events-none absolute bottom-3 right-3 text-sm text-muted-foreground">{unit}</span>
            </div>
            {Number(each) > 0 && (
              <button type="button" className="btn-ghost h-11" onClick={() => setCount(String(Math.floor(target.max / Number(each) + 1e-9)))}>
                As many as fit
              </button>
            )}
          </div>
        ) : (
          <div className="space-y-3">
            <div className="grid gap-2 sm:grid-cols-3 lg:grid-cols-4">
              {rows.map((r, i) => (
                <div key={i} className="relative">
                  <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-xs font-semibold text-muted-foreground">#{i + 1}</span>
                  <StepInput
                    className="form-input h-11 pl-9 pr-12 text-lg"
                    value={r}
                    onValueChange={(v) => setRows((p) => p.map((x, j) => (j === i ? v : x)))}
                    decimals
                    aria-label={`${kind.label} ${i + 1}`}
                  />
                  <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">{unit}</span>
                </div>
              ))}
              <button type="button" className="btn-ghost h-11 justify-center border border-dashed border-border" onClick={() => setRows((p) => [...p, '', '', ''])}>
                <Plus size={15} /> More
              </button>
            </div>
            {paste === null ? (
              <button type="button" className="btn-ghost" onClick={() => setPaste('')}>
                <ClipboardPaste size={15} /> Paste a list (from Excel or the roll report)
              </button>
            ) : (
              <div className="space-y-2">
                <textarea
                  className="form-input font-mono"
                  rows={4}
                  autoFocus
                  placeholder={'One quantity a line, e.g.\n48.5\n51\n50.2'}
                  value={paste}
                  onChange={(e) => setPaste(e.target.value)}
                />
                <div className="flex gap-2">
                  <button
                    type="button"
                    className="btn-primary"
                    disabled={!parseList(paste).length}
                    onClick={() => {
                      setRows(parseList(paste).map(String))
                      setPaste(null)
                    }}
                  >
                    Use {parseList(paste).length} quantities
                  </button>
                  <button type="button" className="btn-ghost" onClick={() => setPaste(null)}>
                    <X size={15} /> Cancel
                  </button>
                </div>
              </div>
            )}
          </div>
        )}

        <p className={`mt-3 text-sm font-medium ${left < -1e-9 ? 'text-red-400' : 'text-muted-foreground'}`}>
          {qtys.length
            ? left < -1e-9
              ? `${packCount(qtys.length, packType)}, ${qtyText(total)} ${unit} — more than the ${qtyText(target.max)} that can be labelled.`
              : `${packCount(qtys.length, packType)}, ${qtyText(total)} ${unit}. ${left > 0 ? `${qtyText(left)} ${unit} stays without a sticker.` : 'Everything will be labelled.'}`
            : `Up to ${qtyText(target.max)} ${unit}.`}
        </p>
      </Section>
    </FormFrame>
  )
}
