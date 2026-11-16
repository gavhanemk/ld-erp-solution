'use client'

import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react'
import { Copy, Search, X, ChevronDown, Loader2 } from 'lucide-react'
import { api, type Paginated } from '@/lib/api'
import { formatRupees } from '@/lib/utils'
import { compareBomLines, type BomComparableLine } from '@ld-erp/shared'
import type { Bom } from './BomFormDialog'

type Comparison = ReturnType<typeof compareBomLines>
interface Match {
  bom: Bom
  comparison: Comparison
  kind: string
}
export interface BomReuseHandle {
  checkBeforeSave: (proceed: () => void) => Promise<void>
}
interface Props {
  styleId: string
  color: string
  lines: BomComparableLine[]
  onCopy: (bom: Bom) => void
  source?: Bom | null
  itemLabels: Record<string, { name: string; unit?: string; category?: string }>
  processLabels: Record<string, string>
  disabled?: boolean
}
const nameOf = (b: Bom) => `${b.style?.code ?? 'BOM'} · ${b.color || 'No colour'} · v${b.version}`
const asLines = (b: Bom): BomComparableLine[] =>
  (b.lines ?? []).map((l) => ({
    componentItemId: l.componentItemId,
    departmentId: l.departmentId,
    component: l.component,
    qtyPerUnit: Number(l.qtyPerUnit),
    wastagePercent: Number(l.wastagePercent),
    unitCost: l.unitCost == null ? null : Number(l.unitCost),
    sizes: l.sizes?.map((s) => ({ sizeId: s.sizeId, qtyPerUnit: Number(s.qtyPerUnit) })),
  }))

export const BomReusePanel = forwardRef<BomReuseHandle, Props>(function BomReusePanel(
  { styleId, color, lines, source, onCopy, disabled, itemLabels, processLabels },
  ref
) {
  const panelRef = useRef<HTMLElement>(null)
  const [browse, setBrowse] = useState(false)
  const [query, setQuery] = useState('')
  const [page, setPage] = useState(1)
  const [pages, setPages] = useState(1)
  const [results, setResults] = useState<Bom[]>([])
  const [selected, setSelected] = useState<Bom | null>(null)
  const [matches, setMatches] = useState<Match[]>([])
  const [compare, setCompare] = useState(false)
  const [busy, setBusy] = useState(false)
  const [searching, setSearching] = useState(false)
  const [error, setError] = useState('')
  const [dismissed, setDismissed] = useState(false)
  const pendingSave = useRef<(() => void) | null>(null)
  const reviewed = useRef('')
  const checking = useRef(false)
  const fingerprint = JSON.stringify({ styleId, color, lines, excludeId: source?.id })
  const currentFingerprint = useRef(fingerprint)
  currentFingerprint.current = fingerprint
  const lastSuggestions = useRef('')
  const fetchMatches = async () => {
    const response = await api.post<{ data: Match[] }>(
      '/masters/bom/similar',
      JSON.parse(fingerprint)
    )
    return response.data
  }
  useEffect(() => {
    pendingSave.current = null
    let live = true
    const timer = setTimeout(() => {
      if (!styleId && !lines.length) {
        setMatches([])
        return
      }
      void fetchMatches()
        .then((data) => {
          if (!live) return
          setMatches(data)
          const key = data.map((m) => `${m.bom.id}:${m.kind}`).join('|')
          if (key !== lastSuggestions.current) {
            setDismissed(false)
            lastSuggestions.current = key
          }
        })
        .catch(() => {
          /* Save checks expose failures with a retry/continue choice. */
        })
    }, 650)
    return () => {
      live = false
      clearTimeout(timer)
    }
  }, [fingerprint]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!browse) {
      setSearching(false)
      return
    }
    let live = true
    setSearching(true)
    const timer = setTimeout(() => {
      void api
        .get<Paginated<Bom>>(`/masters/bom?q=${encodeURIComponent(query)}&page=${page}&limit=12`)
        .then((r) => {
          if (live) {
            setResults(r.data)
            setPages(r.pagination.pages)
            setError('')
          }
        })
        .catch(() => {
          if (live) setError('Could not load BOMs. Try searching again.')
        })
        .finally(() => {
          if (live) setSearching(false)
        })
    }, 250)
    return () => {
      live = false
      clearTimeout(timer)
    }
  }, [browse, query, page])
  useImperativeHandle(ref, () => ({
    checkBeforeSave: async (proceed) => {
      if (checking.current) return
      if (reviewed.current === fingerprint) {
        proceed()
        return
      }
      checking.current = true
      setBusy(true)
      try {
        const data = await fetchMatches()
        if (currentFingerprint.current !== fingerprint) return
        if (!data.length) {
          reviewed.current = fingerprint
          proceed()
          return
        }
        setMatches(data)
        setDismissed(false)
        pendingSave.current = proceed
        panelRef.current?.scrollIntoView({ block: 'start', behavior: 'smooth' })
      } catch {
        setError('Similarity check is unavailable. You can continue creating your BOM.')
        pendingSave.current = proceed
        panelRef.current?.scrollIntoView({ block: 'start', behavior: 'smooth' })
        setDismissed(false)
      } finally {
        checking.current = false
        setBusy(false)
      }
    },
  }))
  const continueNew = () => {
    reviewed.current = fingerprint
    setDismissed(true)
    setError('')
    const proceed = pendingSave.current
    pendingSave.current = null
    proceed?.()
  }
  const useBom = (bom: Bom) => {
    pendingSave.current = null
    reviewed.current = ''
    setBrowse(false)
    setSelected(null)
    setCompare(false)
    setDismissed(true)
    onCopy(bom)
  }
  const comparison = selected ? compareBomLines(lines, asLines(selected)) : null
  return (
    <section ref={panelRef} className="border-border bg-card space-y-3 rounded-xl border p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-sm font-semibold">Start with a proven BOM</p>
          <p className="text-muted-foreground text-xs">
            {source
              ? `Copied from ${nameOf(source)}. Your changes are independent.`
              : 'Reuse materials and costing, then adjust for your new style.'}
          </p>
        </div>
        <button
          type="button"
          className="btn-secondary"
          disabled={disabled}
          onClick={() => {
            setBrowse(!browse)
            setCompare(false)
          }}
        >
          <Copy size={15} />
          Create from Existing BOM
        </button>
      </div>
      {!dismissed && (matches.length > 0 || error) && (
        <div
          role="status"
          className="border-primary/20 bg-primary/5 space-y-2 rounded-lg border p-3"
        >
          <div className="flex justify-between gap-2">
            <p className="text-sm font-semibold">
              {matches.length ? 'A similar BOM already exists!' : 'Similarity check'}
            </p>
            <button type="button" aria-label="Dismiss BOM suggestions" onClick={continueNew}>
              <X size={15} />
            </button>
          </div>
          {error && <p className="text-destructive text-xs">{error}</p>}
          {matches.slice(0, 3).map((m) => (
            <div
              key={m.bom.id}
              className="border-border/50 flex flex-wrap items-center justify-between gap-2 border-t pt-2"
            >
              <div className="text-xs">
                <p className="font-medium">
                  {nameOf(m.bom)} <span className="text-muted-foreground">· {m.bom.status}</span>
                </p>
                <p className="text-muted-foreground">
                  {m.comparison.matched} of {Math.max(lines.length, m.bom.lines?.length ?? 0)}{' '}
                  components match ·{' '}
                  {m.kind === 'EXACT'
                    ? 'Exact match'
                    : m.kind === 'IDENTICAL_COMPONENTS'
                      ? 'Identical components'
                      : m.kind === 'SAME_TARGET'
                        ? 'Same style and colour'
                        : `${m.comparison.rows.filter((r) => r.kind !== 'unchanged').length} differences`}{' '}
                  · {formatRupees(Number(m.bom.costPerPiece ?? m.bom.totalCost ?? 0))}
                </p>
              </div>
              <div className="flex gap-2">
                <button
                  type="button"
                  className="btn-secondary text-xs"
                  disabled={disabled}
                  onClick={() => useBom(m.bom)}
                >
                  Use Existing BOM
                </button>
                <button
                  type="button"
                  className="btn-ghost text-xs"
                  onClick={() => {
                    setSelected(m.bom)
                    setCompare(true)
                    setBrowse(true)
                  }}
                >
                  View Comparison
                </button>
              </div>
            </div>
          ))}
          <button
            type="button"
            className="btn-ghost text-xs"
            disabled={busy || disabled}
            onClick={continueNew}
          >
            Create New BOM
          </button>
        </div>
      )}
      {browse && (
        <div className="border-border space-y-3 border-t pt-3">
          <div className="flex items-center gap-2">
            <Search size={16} />
            <input
              aria-label="Search existing BOMs"
              className="form-input flex-1"
              placeholder="Style code, name, colour, version or BOM reference"
              value={query}
              onChange={(e) => {
                setQuery(e.target.value)
                setPage(1)
              }}
            />
            <button type="button" aria-label="Close BOM browser" onClick={() => setBrowse(false)}>
              <X size={18} />
            </button>
          </div>
          <div className="grid gap-4 lg:grid-cols-[minmax(230px,1fr)_2fr]">
            <div className="max-h-96 space-y-1 overflow-auto">
              {searching && (
                <p className="flex gap-2 text-xs">
                  <Loader2 size={14} className="animate-spin" />
                  Loading BOMs…
                </p>
              )}
              {!searching && !results.length && (
                <p className="text-muted-foreground text-xs">No BOMs found.</p>
              )}
              {results.map((b) => (
                <button
                  type="button"
                  key={b.id}
                  className={`w-full rounded-lg border p-3 text-left text-xs ${selected?.id === b.id ? 'border-primary bg-primary/5' : 'hover:bg-secondary border-transparent'}`}
                  onClick={() => {
                    setSelected(b)
                    setCompare(false)
                  }}
                >
                  <span className="block font-semibold">{nameOf(b)}</span>
                  <span className="text-muted-foreground block">
                    {b.style?.name} · {b.status} · {b.lines?.length ?? 0} components
                  </span>
                </button>
              ))}
              <div className="flex items-center justify-between pt-2 text-xs">
                <button
                  type="button"
                  disabled={page <= 1 || searching}
                  onClick={() => setPage((p) => p - 1)}
                >
                  Previous
                </button>
                <span>
                  {page} / {pages}
                </span>
                <button
                  type="button"
                  disabled={page >= pages || searching}
                  onClick={() => setPage((p) => p + 1)}
                >
                  Next
                </button>
              </div>
            </div>
            {selected ? (
              <div className="border-border min-w-0 space-y-3 rounded-lg border p-3">
                <div className="flex flex-wrap justify-between gap-2">
                  <div>
                    <p className="text-sm font-semibold">{nameOf(selected)}</p>
                    <p className="text-muted-foreground text-xs">
                      {selected.status} · {selected.id}
                    </p>
                  </div>
                  <button
                    type="button"
                    className="btn-primary text-xs"
                    disabled={disabled}
                    onClick={() => useBom(selected)}
                  >
                    Use Existing BOM
                  </button>
                </div>
                <div className="flex flex-wrap gap-4 text-xs">
                  <span>Materials {formatRupees(Number(selected.totalCost ?? 0))}</span>
                  {selected.costPerPiece != null && (
                    <span>Total cost {formatRupees(Number(selected.costPerPiece))}</span>
                  )}
                  {selected.sellingPrice != null && (
                    <span>Selling price {formatRupees(Number(selected.sellingPrice))}</span>
                  )}
                </div>
                <button
                  type="button"
                  className="btn-ghost text-xs"
                  onClick={() => setCompare(!compare)}
                >
                  <ChevronDown size={13} />
                  {compare ? 'Show source components' : 'View Comparison'}
                </button>
                <div className="max-h-72 overflow-auto">
                  <table className="w-full text-xs">
                    <thead>
                      <tr>
                        <th className="p-2 text-left">Component / process</th>
                        <th className="p-2 text-right">Qty / unit</th>
                        <th className="p-2 text-right">Rate</th>
                        <th className="p-2 text-right">Cost</th>
                      </tr>
                    </thead>
                    <tbody>
                      {!compare
                        ? selected.lines?.map((l, i) => (
                            <tr key={l.id ?? i} className="border-border/50 border-t">
                              <td className="p-2">
                                {l.componentItem?.code} · {l.componentItem?.name}
                                <span className="text-muted-foreground block">
                                  {itemLabels[l.componentItemId]?.category} ?{' '}
                                  {l.department?.name ?? 'No process'}
                                </span>
                              </td>
                              <td className="p-2 text-right">
                                {Number(l.qtyPerUnit)} {l.componentItem?.uom?.symbol}
                              </td>
                              <td className="p-2 text-right">
                                {l.unitCost == null ? '—' : formatRupees(Number(l.unitCost))}
                              </td>
                              <td className="p-2 text-right">
                                {l.totalCost == null ? '—' : formatRupees(Number(l.totalCost))}
                              </td>
                            </tr>
                          ))
                        : comparison?.rows.map((row, i) => {
                            const l = row.current ?? row.existing!
                            const item = selected.lines?.find(
                              (x) => x.componentItemId === l.componentItemId
                            )?.componentItem
                            return (
                              <tr
                                key={i}
                                className={`border-border/50 border-t ${row.kind === 'added' ? 'bg-emerald-500/10' : row.kind === 'removed' ? 'bg-red-500/10' : row.kind === 'modified' ? 'bg-amber-500/10' : ''}`}
                              >
                                <td className="p-2">
                                  {item?.name ?? itemLabels[l.componentItemId]?.name ?? 'Component'}
                                  <span className="text-muted-foreground block">
                                    {row.kind} {row.changes.join(', ')}
                                    {row.changes.includes('Process') &&
                                      ` \u00b7 ${processLabels[row.existing?.departmentId ?? ''] ?? 'None'} \u2192 ${processLabels[row.current?.departmentId ?? ''] ?? 'None'}`}
                                  </span>
                                </td>
                                <td className="p-2 text-right">
                                  {row.existing?.qtyPerUnit ?? '—'} →{' '}
                                  {row.current?.qtyPerUnit ?? '—'}{' '}
                                  {item?.uom?.symbol ?? itemLabels[l.componentItemId]?.unit}
                                </td>
                                <td className="p-2 text-right">
                                  {row.existing?.unitCost ?? '—'} → {row.current?.unitCost ?? '—'}
                                </td>
                                <td className="p-2 text-right">
                                  {row.current?.unitCost == null
                                    ? '—'
                                    : formatRupees(
                                        row.current.qtyPerUnit *
                                          (1 + (row.current.wastagePercent ?? 0) / 100) *
                                          row.current.unitCost
                                      )}
                                </td>
                              </tr>
                            )
                          })}
                    </tbody>
                  </table>
                </div>
                {compare && (
                  <p className="text-muted-foreground text-[11px]">
                    Existing → current. Green: added · Red: removed · Amber: modified. Category and
                    unit follow the existing item master.
                  </p>
                )}
                {selected.costLines?.length ? (
                  <details className="text-xs">
                    <summary className="cursor-pointer">Labour and overheads</summary>
                    {selected.costLines.map((c, i) => (
                      <p key={c.id ?? i} className="flex justify-between py-1">
                        <span>
                          {c.name} · {c.basis === 'PERCENT' ? `${c.value}%` : 'per piece'}
                        </span>
                        <span>{formatRupees(Number(c.amount))}</span>
                      </p>
                    ))}
                  </details>
                ) : null}
                {selected.notes && (
                  <p className="text-muted-foreground text-xs">{selected.notes}</p>
                )}
              </div>
            ) : (
              <p className="text-muted-foreground p-4 text-xs">
                Select a BOM to preview its materials and costing.
              </p>
            )}
          </div>
        </div>
      )}
    </section>
  )
})
