'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { ArrowDown, ArrowDownUp, ArrowUp, Loader2, Plus, Ruler, Save, Trash2 } from 'lucide-react'
import { api, apiErrorMessage } from '@/lib/api'
import { FormFrame } from '@/components/ui/FormFrame'
import { Section } from '@/components/purchase/Section'
import { SmartSelect } from '@/components/ui/SmartSelect'

/**
 * A size run and every size in it, edited in one go.
 *
 * Sizes used to be a master of their own: each one opened its own form, with
 * its run picked from a list and its position typed as a number, so adding
 * 4XL to one run was a trip to another page and a guess at a number. Here the
 * run's sizes are rows. Type over a code, add a row, move one up, take one out,
 * and save the lot together. A size's position is simply its row.
 *
 * A size any document uses (an order, a BOM, stock, a bundle) cannot be taken
 * out, and renaming one shows the new code on those documents too, so the row
 * says what uses it.
 */

export interface SizeRun {
  id: string
  name: string
  gender: string | null
  isActive: boolean
  sizes: { id: string; code: string; label: string; sequence: number }[]
  _count?: { styles: number }
}

interface UsedSize {
  id: string
  code: string
  label: string
  sequence: number
  uses: number
  usedOn: string | null
}

interface Row {
  key: string
  id: string | null
  code: string
  label: string
  /** The code it was saved with, for a size kept. */
  was: string | null
  uses: number
  usedOn: string | null
}

/** Chest and waist sizes by number, then letter sizes smallest first. */
const LETTER = ['XXS', 'XS', 'S', 'M', 'L', 'XL', 'XXL', '2XL', '3XL', 'XXXL', '4XL', '5XL', '6XL']
const rank = (v: string): [number, number] => {
  if (/^\d+(\.\d+)?$/.test(v)) return [0, Number(v)]
  const i = LETTER.indexOf(v.toUpperCase())
  return i >= 0 ? [1, i] : [2, 0]
}
export const sizeOrder = (a: string, b: string) => {
  const [ga, na] = rank(a)
  const [gb, nb] = rank(b)
  return ga - gb || na - nb || a.localeCompare(b)
}
/** Whether every size is one the ranking knows, so "smallest first" means something. */
const allKnown = (codes: string[]) => codes.every((c) => rank(c)[0] < 2)
const inOrder = (codes: string[]) => codes.every((c, i) => i === 0 || sizeOrder(codes[i - 1], c) <= 0)

let seq = 0
const newRow = (code = ''): Row => ({ key: `n${++seq}`, id: null, code, label: code, was: null, uses: 0, usedOn: null })
const filled = (r: Row) => r.code.trim() !== '' || r.label.trim() !== ''

export function SizeRunDialog({
  record,
  onClose,
  onSaved,
}: {
  /** The run to edit; null for a new one. */
  record: SizeRun | null
  onClose: () => void
  onSaved: (message: string) => void
}) {
  const [name, setName] = useState(record?.name ?? '')
  const [gender, setGender] = useState(record?.gender ?? '')
  const [isActive, setIsActive] = useState(record?.isActive ?? true)
  const [rows, setRows] = useState<Row[]>(() =>
    [...(record?.sizes ?? [])]
      // Two sizes saved at the same position fall into size order.
      .sort((a, b) => a.sequence - b.sequence || sizeOrder(a.code, b.code))
      .map((s) => ({ key: s.id, id: s.id, code: s.code, label: s.label, was: s.code, uses: 0, usedOn: null })),
  )
  const [usageLoaded, setUsageLoaded] = useState(!record)
  const [quick, setQuick] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const codeRefs = useRef(new Map<string, HTMLInputElement>())
  const [focusKey, setFocusKey] = useState<string | null>(null)

  // What uses each size, so a size in use is not offered for removal.
  useEffect(() => {
    if (!record) return
    let alive = true
    api
      .get<{ data: UsedSize[] }>(`/masters/size-groups/${record.id}/sizes`)
      .then((r) => {
        if (!alive) return
        const byId = new Map(r.data.map((s) => [s.id, s]))
        setRows((rs) => rs.map((x) => (x.id && byId.has(x.id) ? { ...x, uses: byId.get(x.id)!.uses, usedOn: byId.get(x.id)!.usedOn } : x)))
        setUsageLoaded(true)
      })
      .catch(() => alive && setError('Could not check which sizes are in use. Close and open the run again.'))
    return () => {
      alive = false
    }
  }, [record])

  useEffect(() => {
    if (!focusKey) return
    codeRefs.current.get(focusKey)?.focus()
    setFocusKey(null)
  }, [focusKey, rows])

  const set = (key: string, patch: Partial<Row>) => setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...patch } : r)))
  /** "Shown as" follows the code until somebody types something else in it. */
  const setCode = (key: string, value: string) =>
    setRows((rs) =>
      rs.map((r) => {
        if (r.key !== key) return r
        const code = value.toUpperCase()
        return { ...r, code, label: r.label === '' || r.label === r.code ? code : r.label }
      }),
    )
  const move = (i: number, d: -1 | 1) =>
    setRows((rs) => {
      const j = i + d
      if (j < 0 || j >= rs.length) return rs
      const next = [...rs]
      ;[next[i], next[j]] = [next[j], next[i]]
      return next
    })
  /** A blank row after row i (at the end when i is left out), with the cursor in it. */
  const addRow = (i?: number) => {
    const row = newRow()
    setRows((rs) => {
      const at = i === undefined ? rs.length : i + 1
      return [...rs.slice(0, at), row, ...rs.slice(at)]
    })
    setFocusKey(row.key)
  }
  /** Enter in a row goes to the next one, or opens a new row after the last. */
  const onEnter = (i: number) => {
    const next = rows[i + 1]
    if (next) codeRefs.current.get(next.key)?.focus()
    else if (filled(rows[i])) addRow(i)
  }

  /**
   * Sizes typed together — "XS 4XL" or "36, 38, 40" — each added once. In a
   * run already smallest first, a size the ranking knows goes in its place
   * (XS before S); anything else goes at the end.
   */
  const addTyped = () => {
    const codes = quick
      .split(/[\s,;]+/)
      .map((c) => c.trim().toUpperCase())
      .filter(Boolean)
    if (!codes.length) return
    setRows((rs) => {
      let next = rs.filter(filled)
      for (const code of codes) {
        if (next.some((r) => r.code.trim().toUpperCase() === code)) continue
        const have = next.map((r) => r.code.trim())
        const row = newRow(code)
        if (allKnown([...have, code]) && inOrder(have)) {
          const at = next.findIndex((r) => sizeOrder(code, r.code.trim()) < 0)
          next = at < 0 ? [...next, row] : [...next.slice(0, at), row, ...next.slice(at)]
        } else next = [...next, row]
      }
      return next
    })
    setQuick('')
  }

  const codes = rows.filter(filled).map((r) => r.code.trim())
  const canSort = codes.length > 1 && !inOrder(codes)
  const smallestFirst = () =>
    setRows((rs) => [...rs.filter(filled)].sort((a, b) => sizeOrder(a.code.trim(), b.code.trim())))

  // A code typed twice, by row key, to mark both rows.
  const twice = useMemo(() => {
    const count = new Map<string, number>()
    for (const r of rows) if (r.code.trim()) count.set(r.code.trim().toUpperCase(), (count.get(r.code.trim().toUpperCase()) ?? 0) + 1)
    return new Set(rows.filter((r) => (count.get(r.code.trim().toUpperCase()) ?? 0) > 1).map((r) => r.key))
  }, [rows])

  const keep = rows.filter(filled)
  const blocker = !name.trim()
    ? 'Give the run a name.'
    : keep.length === 0
      ? 'Add its sizes.'
      : keep.some((r) => !r.code.trim())
        ? 'Every size needs a code. Fill it in or remove the row.'
        : twice.size
          ? `${rows.find((r) => twice.has(r.key))!.code.trim()} is in the list twice.`
          : !usageLoaded
            ? 'Checking which sizes are in use…'
            : null

  const save = async () => {
    if (blocker) return
    setSaving(true)
    setError(null)
    const payload = {
      name: name.trim(),
      gender: gender || null,
      isActive,
      sizes: keep.map((r) => ({ id: r.id, code: r.code.trim(), label: r.label.trim() || r.code.trim() })),
    }
    try {
      const res = record
        ? await api.patch<{ message?: string }>(`/masters/size-groups/${record.id}/with-sizes`, payload)
        : await api.post<{ message?: string }>('/masters/size-groups/with-sizes', payload)
      onSaved(res.message ?? 'Size run saved.')
    } catch (err) {
      setError(apiErrorMessage(err, 'Could not save the size run.'))
    } finally {
      setSaving(false)
    }
  }

  const styles = record?._count?.styles ?? 0

  return (
    <FormFrame
      icon={Ruler}
      title={record ? `Edit ${record.name}` : 'New size run'}
      subtitle={
        record
          ? `${styles ? `${styles} ${styles === 1 ? 'style is' : 'styles are'} cut in this run` : 'No style uses this run yet'} · new orders get the sizes as saved here`
          : 'Name the run, then type its sizes — smallest first, the way they go across a cutting sheet'
      }
      width="max-w-3xl"
      primary={
        <button type="button" className="btn-primary" onClick={() => void save()} disabled={saving || !!blocker}>
          {saving ? <Loader2 size={15} className="animate-spin" /> : <Save size={15} />} {record ? 'Save changes' : 'Create size run'}
        </button>
      }
      footer={
        <button type="button" className="btn-secondary" onClick={onClose} disabled={saving}>
          Cancel
        </button>
      }
      footerNote={blocker ? <span className="warn-text">{blocker}</span> : `${keep.length} ${keep.length === 1 ? 'size' : 'sizes'}`}
      error={error}
      onClose={onClose}
      busy={saving}
    >
      <Section icon={Ruler} title="Size run">
        <div className="grid grid-cols-1 gap-x-4 gap-y-3 sm:grid-cols-4">
          <label className="block sm:col-span-2">
            <span className="form-label">Name</span>
            <input
              className="form-input"
              value={name}
              placeholder="Men's Shirt (Collar)"
              onChange={(e) => setName(e.target.value)}
              autoFocus={!record}
            />
          </label>
          <label className="block">
            <span className="form-label">For</span>
            <SmartSelect className="form-input" value={gender} onChange={(e) => setGender(e.target.value)}>
              <option value="">Not set</option>
              <option value="MALE">Men&apos;s</option>
              <option value="FEMALE">Women&apos;s</option>
              <option value="UNISEX">Unisex</option>
            </SmartSelect>
          </label>
          <label className="flex items-center gap-2 self-end pb-2 text-sm">
            <input type="checkbox" className="accent-primary" checked={isActive} onChange={(e) => setIsActive(e.target.checked)} />
            Offered on new styles
          </label>
        </div>
      </Section>

      <Section
        icon={ArrowDownUp}
        title="Sizes, smallest first"
        actions={
          <>
            {canSort && allKnown(codes) && (
              <button type="button" className="btn-secondary h-8 px-3 text-xs" onClick={smallestFirst}>
                <ArrowDownUp size={13} /> Put in size order
              </button>
            )}
            <button type="button" className="btn-secondary h-8 px-3 text-xs" onClick={() => addRow()}>
              <Plus size={13} /> Add a size
            </button>
          </>
        }
      >
        {/* The quick way in: several sizes typed at once. */}
        <div className="mb-3 flex gap-2">
          <input
            className="form-input h-9 font-mono"
            value={quick}
            placeholder={rows.length ? 'Add more: e.g. XS 4XL' : 'Type the sizes: e.g. S M L XL XXL, or 38 40 42 44'}
            onChange={(e) => setQuick(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                addTyped()
              }
            }}
            aria-label="Sizes to add, separated by spaces or commas"
            autoFocus={!!record}
          />
          <button type="button" className="btn-secondary h-9 shrink-0 px-3 text-xs" onClick={addTyped} disabled={!quick.trim()}>
            <Plus size={13} /> Add
          </button>
        </div>

        {rows.length === 0 ? (
          <p className="text-muted-foreground py-4 text-center text-xs">
            No sizes yet. Type them in the box above and press Enter.
          </p>
        ) : (
          <div className="space-y-1.5">
            <div className="text-muted-foreground hidden grid-cols-[2rem_9rem_minmax(0,1fr)_minmax(0,1.3fr)_5.5rem] gap-x-2 px-1 text-[11px] font-medium uppercase tracking-wide sm:grid">
              <span>#</span>
              <span>Code</span>
              <span>Shown as</span>
              <span>Used on</span>
              <span />
            </div>
            {rows.map((r, i) => {
              const renamed = r.was !== null && r.code.trim() !== r.was
              return (
                <div
                  key={r.key}
                  className="border-border bg-card grid grid-cols-[1.75rem_minmax(0,1fr)_minmax(0,1fr)_auto] items-center gap-x-2 gap-y-1 rounded-lg border px-1 py-1.5 sm:grid-cols-[2rem_9rem_minmax(0,1fr)_minmax(0,1.3fr)_5.5rem]"
                >
                  <span className="text-primary pl-1 font-mono text-xs">{i + 1}</span>
                  <input
                    ref={(el) => {
                      if (el) codeRefs.current.set(r.key, el)
                      else codeRefs.current.delete(r.key)
                    }}
                    className={`form-input h-9 font-mono ${twice.has(r.key) ? 'border-destructive' : ''}`}
                    value={r.code}
                    maxLength={20}
                    placeholder="XL"
                    onChange={(e) => setCode(r.key, e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault()
                        onEnter(i)
                      }
                    }}
                    aria-label={`Size ${i + 1} code`}
                  />
                  <input
                    className="form-input h-9"
                    value={r.label}
                    maxLength={40}
                    placeholder={r.code || 'XL'}
                    onChange={(e) => set(r.key, { label: e.target.value })}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault()
                        onEnter(i)
                      }
                    }}
                    aria-label={`Size ${i + 1} shown as`}
                  />
                  <span
                    className={`order-last col-span-full min-w-0 truncate pl-9 text-[11px] sm:order-none sm:col-span-1 sm:pl-0 ${
                      renamed && r.uses ? 'warn-text' : 'text-muted-foreground'
                    }`}
                    title={r.usedOn ?? undefined}
                  >
                    {r.id === null
                      ? 'New'
                      : !usageLoaded
                        ? 'Checking…'
                        : renamed && r.uses
                          ? `Was ${r.was}: renamed on ${r.usedOn}`
                          : r.usedOn ?? 'Not used yet'}
                  </span>
                  <span className="flex items-center justify-end">
                    <button type="button" className="btn-ghost p-1" onClick={() => move(i, -1)} disabled={i === 0} aria-label={`Move size ${i + 1} up`}>
                      <ArrowUp size={13} />
                    </button>
                    <button
                      type="button"
                      className="btn-ghost p-1"
                      onClick={() => move(i, 1)}
                      disabled={i === rows.length - 1}
                      aria-label={`Move size ${i + 1} down`}
                    >
                      <ArrowDown size={13} />
                    </button>
                    <button
                      type="button"
                      className="btn-ghost text-muted-foreground hover:text-destructive p-1"
                      onClick={() => setRows((rs) => rs.filter((x) => x.key !== r.key))}
                      disabled={r.uses > 0 || (r.id !== null && !usageLoaded)}
                      title={r.uses > 0 ? `On ${r.usedOn}, so it stays in the run` : 'Remove this size'}
                      aria-label={`Remove size ${i + 1}`}
                    >
                      <Trash2 size={13} />
                    </button>
                  </span>
                </div>
              )
            })}
          </div>
        )}
        <p className="text-muted-foreground mt-2 text-[11px]">
          The code prints on orders, cutting sheets and invoices; &ldquo;Shown as&rdquo; is what the screens show, and is the code
          unless you type something else. Enter moves to the next row.
        </p>
      </Section>
    </FormFrame>
  )
}
