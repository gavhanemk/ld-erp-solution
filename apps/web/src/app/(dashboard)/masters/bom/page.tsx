'use client'

import { Fragment, useCallback, useEffect, useMemo, useState } from 'react'
import {
  Plus,
  RefreshCw,
  AlertCircle,
  ChevronDown,
  ChevronRight,
  ChevronLeft,
  Layers,
  Search,
  Ban,
  Copy,
  CheckCircle2,
  Pencil,
  X,
  Loader2,
  Equal,
  PencilLine,
  Archive,
} from 'lucide-react'
import { api, ApiError, can, type Paginated } from '@/lib/api'
import { cn, formatDate, formatRupees } from '@/lib/utils'
import { useAppSettings } from '@/lib/appSettings'
import { useEscape } from '@/lib/useEscape'
import { BomFormDialog, type Bom } from '@/components/masters/BomFormDialog'
import { BomDetail } from '@/components/masters/BomDetail'
import { BomReviewDialog } from '@/components/masters/BomReviewDialog'
import { SmartSelect } from '@/components/ui/SmartSelect'
import { KpiTile, TONE } from '@/components/dashboard/DashKit'
import { ActionMenu, type RowAction } from '@/components/tables/ActionMenu'
import { ScrollableTable } from '@/components/tables/ScrollableTable'
import { FilterMenu, type FilterChoice } from '@/components/masters/FilterMenu'

/** The six status colours are fixed; a BOM uses three of them. */
const STATUS: Record<string, { label: string; cls: string }> = {
  DRAFT: { label: 'Draft', cls: 'badge-info' },
  APPROVED: { label: 'Approved', cls: 'badge-success' },
  OBSOLETE: { label: 'Obsolete', cls: 'badge-neutral' },
}

/** What a status means for using the BOM, beside its badge. */
const MEANS: Record<string, string> = {
  APPROVED: 'In use',
  DRAFT: 'Not in use yet',
  OBSOLETE: 'Replaced',
}

/** What the list shows: what is in use and on the way, one status, or everything. */
type View = 'live' | 'APPROVED' | 'DRAFT' | 'OBSOLETE' | 'all'
const VIEW_STATUS: Record<View, string> = { live: 'DRAFT,APPROVED', APPROVED: 'APPROVED', DRAFT: 'DRAFT', OBSOLETE: 'OBSOLETE', all: '' }

/** The dropdowns over the list: the main things a BOM is about. */
type Facet = 'styles' | 'colours' | 'brands' | 'items' | 'priced'
const FACETS: Array<{ key: Facet; label: string }> = [
  { key: 'styles', label: 'Style' },
  { key: 'colours', label: 'Colour' },
  { key: 'brands', label: 'Brand' },
  { key: 'items', label: 'Item used' },
  { key: 'priced', label: 'Price' },
]
const NO_PICKS: Record<Facet, string[]> = { styles: [], colours: [], brands: [], items: [], priced: [] }

const num = (v: unknown) => Number(v ?? 0)

/** "LD-SH-2601 in Dusty Blue v1.0" — the colour is part of which BOM it is. */
const bomLabel = (bom: Bom) =>
  `${bom.style?.code}${bom.color ? ` in ${bom.color}` : ''} v${bom.version}`

/**
 * Quantities to four places at most — the precision a BOM stores — and never
 * fewer than two, so a column of them lines up on the decimal point.
 */
const qty = (v: unknown) =>
  Number(v ?? 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 4 })

const percent = (v: unknown) =>
  `${Number(v ?? 0).toLocaleString('en-IN', { maximumFractionDigits: 2 })}%`

/*
 * Cells for the tables in an expanded BOM. The same header type and row dividers
 * as .data-table, with tighter cells: its reading-table padding does not leave
 * ten columns room to line up.
 */
const th = 'px-3 py-2.5 text-xs font-semibold uppercase tracking-wider text-muted-foreground'
const td = 'px-3 py-2.5 align-middle'
const sectionTitle = 'text-xs font-semibold uppercase tracking-wide text-muted-foreground'

export default function BomPage() {
  const { rowsPerPage } = useAppSettings()

  const [boms, setBoms] = useState<Bom[] | null>(null)
  const [pagination, setPagination] = useState({ page: 1, limit: 25, total: 0, pages: 1 })
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)

  const [search, setSearch] = useState('')
  const [debounced, setDebounced] = useState('')
  // Retired BOMs are kept for the record, out of the way until asked for.
  const [view, setView] = useState<View>('live')
  const [page, setPage] = useState(1)
  /** What each dropdown has picked, and what each offers (with how many BOMs a choice leaves). */
  const [picked, setPicked] = useState<Record<Facet, string[]>>(NO_PICKS)
  const [facets, setFacets] = useState<Record<Facet, FilterChoice[]> | null>(null)
  /** How many BOMs are approved, drafts and retired, over the whole list. */
  const [counts, setCounts] = useState<{ APPROVED: number; DRAFT: number; OBSOLETE: number } | null>(null)

  const [expanded, setExpanded] = useState<string | null>(null)
  const [dialogOpen, setDialogOpen] = useState(false)
  const [editing, setEditing] = useState<Bom | null>(null)
  const [copying, setCopying] = useState<Bom | null>(null)
  /** A draft being looked over before it is approved. */
  const [reviewing, setReviewing] = useState<Bom | null>(null)

  // The same 350ms the master screens use, so typing does not fire a request
  // per keystroke.
  useEffect(() => {
    const t = setTimeout(() => setDebounced(search), 350)
    return () => clearTimeout(t)
  }, [search])

  useEffect(() => {
    setPage(1)
  }, [debounced, view, picked])

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      // A style's BOMs together, colour by colour, newest first.
      const params = new URLSearchParams({ page: String(page), limit: String(rowsPerPage), sort: 'style', order: 'asc' })
      if (debounced) params.set('q', debounced)
      if (VIEW_STATUS[view]) params.set('status', VIEW_STATUS[view])
      for (const f of FACETS) if (picked[f.key].length) params.set(f.key, picked[f.key].join(','))
      // The dropdowns' choices for the same search, status and picks.
      const facetParams = new URLSearchParams(params)
      for (const k of ['page', 'limit', 'sort', 'order']) facetParams.delete(k)

      const count = (st: string) => api.get<Paginated<Bom>>(`/masters/bom?status=${st}&limit=1`).then((r) => r.pagination.total)
      const [res, approved, draft, retired, choices] = await Promise.all([
        api.get<Paginated<Bom>>(`/masters/bom?${params.toString()}`),
        count('APPROVED'),
        count('DRAFT'),
        count('OBSOLETE'),
        api.get<{ data: Record<Facet, FilterChoice[]> }>(`/masters/bom/facets?${facetParams.toString()}`).then((r) => r.data),
      ])
      setFacets(choices)
      setBoms(res.data)
      setPagination(res.pagination)
      setCounts({ APPROVED: approved, DRAFT: draft, OBSOLETE: retired })
    } catch (err) {
      setError(
        err instanceof ApiError ? err.message : 'Could not reach the server. Is the API running?',
      )
      setBoms(null)
    } finally {
      setLoading(false)
    }
  }, [page, rowsPerPage, debounced, view, picked])

  useEffect(() => {
    void load()
  }, [load])

  const act = async (run: () => Promise<unknown>) => {
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      const res = (await run()) as { message?: string }
      if (res?.message) setNotice(res.message)
      await load()
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save. Is the API running?')
    } finally {
      setBusy(false)
    }
  }

  // Approving goes through the review: what it changes, and the whole BOM, first.
  const approve = (bom: Bom) => setReviewing(bom)

  const copy = (bom: Bom) => setCopying(bom)

  const retire = (bom: Bom) => {
    const label = bomLabel(bom)
    if (
      !confirm(
        `Stop offering ${label}?\n\nIt stays on past orders and costings. It will not be offered on new ones. You can bring it back by editing it.`,
      )
    )
      return
    void act(() => api.delete(`/masters/bom/${bom.id}`))
  }

  const empty = !error && boms && boms.length === 0
  const canCost = can('masters', 'approve')
  const COLS = canCost ? 9 : 7
  /** The picks as chips under the dropdowns, each with its own ×. */
  const chips = FACETS.flatMap((f) =>
    picked[f.key].map((v) => ({ key: f.key, value: v, text: `${f.label}: ${facets?.[f.key]?.find((c) => c.value === v)?.label ?? '…'}` })),
  )
  const narrowed = chips.length > 0 || !!debounced
  const clearAll = () => {
    setPicked(NO_PICKS)
    setSearch('')
  }
  /** A tile filters the list to its BOMs; pressed again, back to what is in use. */
  const pick = (v: View) => setView((cur) => (cur === v ? 'live' : v))

  // The page's BOMs under their style, each style where its first BOM falls.
  const styleOf = (b: Bom) => b.styleId ?? b.style?.code ?? b.id
  const rows = boms ?? []
  const perStyle = new Map<string, Bom[]>()
  for (const b of rows) {
    const k = styleOf(b)
    if (!perStyle.has(k)) perStyle.set(k, [])
    perStyle.get(k)!.push(b)
  }

  return (
    <div className="space-y-6">
      <div className="page-header">
        <div>
          <h1 className="page-title">Bill of Materials</h1>
          <p className="page-subtitle">
            What goes into one piece of each style and colour, and what it costs. The approved BOM is the one orders use.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <button onClick={() => void load()} className="btn-secondary" disabled={busy}>
            <RefreshCw size={16} className={loading ? 'animate-spin' : ''} />
            Refresh
          </button>
          <button
            className="btn-primary"
            disabled={busy}
            onClick={() => {
              setEditing(null)
              setDialogOpen(true)
            }}
            data-hotkey="new"
            aria-keyshortcuts="Alt+N"
          >
            <Plus size={16} />
            New BOM
          </button>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <KpiTile
          icon={CheckCircle2}
          tone={TONE.emerald}
          label="Approved"
          value={counts ? String(counts.APPROVED) : '…'}
          sub={view === 'APPROVED' ? 'showing only these · click to show all' : 'in use: orders and MOs take these'}
          onClick={() => pick('APPROVED')}
          active={view === 'APPROVED'}
        />
        <KpiTile
          icon={PencilLine}
          tone={TONE.amber}
          label="Drafts"
          value={counts ? String(counts.DRAFT) : '…'}
          valueClass={counts?.DRAFT ? 'text-amber-500' : 'text-foreground'}
          sub={view === 'DRAFT' ? 'showing only these · click to show all' : 'to check and approve'}
          onClick={() => pick('DRAFT')}
          active={view === 'DRAFT'}
        />
        <KpiTile
          icon={Archive}
          tone={TONE.sky}
          label="Retired"
          value={counts ? String(counts.OBSOLETE) : '…'}
          sub={view === 'OBSOLETE' ? 'showing only these · click to show all' : 'replaced or no longer offered · kept for the record'}
          onClick={() => pick('OBSOLETE')}
          active={view === 'OBSOLETE'}
        />
      </div>

      <div className="glass-card relative z-20 flex flex-wrap items-center gap-3 p-4">
        <div className="flex min-w-60 flex-1 items-center gap-2 rounded-lg border border-border bg-secondary px-3 py-2">
          <Search size={15} className="text-muted-foreground" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search style code, style name, colour or version..."
            className="flex-1 bg-transparent text-sm text-foreground placeholder:text-muted-foreground focus:outline-none"
            aria-label="Search BOMs"
            data-hotkey="search"
          />
        </div>
        <SmartSelect className="form-input w-auto" value={view} onChange={(e) => setView(e.target.value as View)} aria-label="Show">
          <option value="live">In use and drafts</option>
          <option value="APPROVED">Approved only</option>
          <option value="DRAFT">Drafts only</option>
          <option value="OBSOLETE">Retired only</option>
          <option value="all">All, retired too</option>
        </SmartSelect>
        {FACETS.map((f) => (
          <FilterMenu
            key={f.key}
            label={f.label}
            choices={facets?.[f.key]}
            selected={picked[f.key]}
            onChange={(next) => setPicked((p) => ({ ...p, [f.key]: next }))}
          />
        ))}
        <div className="flex w-full flex-wrap items-center gap-1.5">
          {chips.map((c) => (
            <button
              key={`${c.key}-${c.value}`}
              type="button"
              onClick={() => setPicked((p) => ({ ...p, [c.key]: p[c.key].filter((v) => v !== c.value) }))}
              className="flex items-center gap-1 rounded-full border border-primary/30 bg-primary/10 px-2 py-0.5 text-xs text-foreground"
            >
              {c.text} <X size={11} />
            </button>
          ))}
          {narrowed && (
            <button type="button" onClick={clearAll} className="text-xs text-teal-500 hover:underline">
              Clear all
            </button>
          )}
          <span className="ml-auto text-xs text-muted-foreground">
            {loading && !boms ? 'Loading…' : `${pagination.total} ${pagination.total === 1 ? 'BOM' : 'BOMs'}`}
          </span>
        </div>
      </div>

      {notice && (
        <div className="glass-card flex items-start gap-3 border-amber-500/40 p-4">
          <AlertCircle size={18} className="mt-0.5 shrink-0 text-amber-400" />
          <p className="text-sm text-foreground">{notice}</p>
        </div>
      )}

      {error && (
        <div className="glass-card flex items-start gap-3 border-red-500/40 p-4">
          <AlertCircle size={18} className="mt-0.5 shrink-0 text-red-400" />
          <div>
            <p className="text-sm font-semibold text-red-400">Could not load bills of materials</p>
            <p className="mt-1 text-xs text-muted-foreground">{error}</p>
          </div>
        </div>
      )}

      {loading && !boms && <div className="skeleton h-40 w-full rounded-xl" />}

      {empty && (
        <div className="glass-card p-10 text-center">
          <Layers size={22} className="mx-auto mb-3 text-muted-foreground" />
          <p className="text-sm font-medium text-foreground">
            {narrowed || view !== 'live' ? 'Nothing matches that' : 'No bills of materials yet'}
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            {narrowed || view !== 'live'
              ? 'Try fewer filters, or show all.'
              : 'Pick a style and list what goes into one piece — fabric, trims, buttons, packing. The cost per garment comes out of it.'}
          </p>
        </div>
      )}

      {rows.length > 0 && (
        <div className={cn('glass-card list-scope overflow-hidden p-0 transition-opacity', loading && 'opacity-60')}>
          <ScrollableTable>
            <table className="data-table table-compact min-w-full">
              <thead>
                <tr className="bg-secondary">
                  <th style={{ width: 44 }} />
                  <th className="whitespace-nowrap">Colour · version</th>
                  <th className="whitespace-nowrap">Status</th>
                  <th className="whitespace-nowrap" style={{ textAlign: 'right' }}>
                    Components
                  </th>
                  <th className="whitespace-nowrap" style={{ textAlign: 'right' }}>
                    Material / pc
                  </th>
                  {canCost && (
                    <th className="whitespace-nowrap" style={{ textAlign: 'right' }}>
                      Cost / pc
                    </th>
                  )}
                  {canCost && (
                    <th className="whitespace-nowrap" style={{ textAlign: 'right' }}>
                      Selling price
                    </th>
                  )}
                  <th className="whitespace-nowrap">Approved</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {rows.map((bom, i) => {
                  const k = styleOf(bom)
                  const head = i === 0 || styleOf(rows[i - 1]) !== k
                  const mine = perStyle.get(k) ?? []
                  const colours = [...new Set(mine.map((b) => b.color).filter(Boolean))]
                  return (
                    <Fragment key={bom.id}>
                      {head && (
                        <tr className="border-t border-t-border bg-secondary/60">
                          <td colSpan={COLS} className="!p-0">
                            <div className="sticky left-0 flex w-[100cqw] flex-wrap items-center gap-x-2.5 gap-y-1 px-4 py-2">
                              <Layers size={15} className="shrink-0 text-primary" />
                              <span className="font-mono text-sm font-semibold text-primary">{bom.style?.code}</span>
                              <span className="text-sm font-medium text-foreground">{bom.style?.name}</span>
                              {bom.style?.brandType === 'VHAGAR' && <span className="vhagar-accent text-xs font-bold">VHAGAR</span>}
                              <span className="rounded-full border border-border bg-card px-2 py-0.5 text-[11px] text-muted-foreground tabular-nums">
                                {mine.length} {mine.length === 1 ? 'BOM' : 'BOMs'}
                                {colours.length > 0 ? ` · ${colours.length} ${colours.length === 1 ? 'colour' : 'colours'}` : ''}
                              </span>
                            </div>
                          </td>
                        </tr>
                      )}
                      <BomLine
                        bom={bom}
                        first={i === 0}
                        cols={COLS}
                        canCost={canCost}
                        open={expanded === bom.id}
                        busy={busy}
                        onToggle={() => setExpanded(expanded === bom.id ? null : bom.id)}
                        onEdit={() => {
                          setEditing(bom)
                          setDialogOpen(true)
                        }}
                        onApprove={() => approve(bom)}
                        onCopy={() => copy(bom)}
                        onRetire={() => retire(bom)}
                      />
                    </Fragment>
                  )
                })}
              </tbody>
            </table>
          </ScrollableTable>
        </div>
      )}

      {pagination.pages > 1 && (
        <div className="glass-card p-4 flex items-center justify-between">
          <p className="text-xs text-muted-foreground">
            Page {pagination.page} of {pagination.pages}
          </p>
          <div className="flex items-center gap-2">
            <button
              className="btn-ghost"
              disabled={page <= 1 || loading}
              onClick={() => setPage((p) => Math.max(1, p - 1))}
            >
              <ChevronLeft size={16} />
              Previous
            </button>
            <button
              className="btn-ghost"
              disabled={page >= pagination.pages || loading}
              onClick={() => setPage((p) => p + 1)}
            >
              Next
              <ChevronRight size={16} />
            </button>
          </div>
        </div>
      )}

      <BomFormDialog
        open={dialogOpen}
        onClose={() => setDialogOpen(false)}
        onSaved={(message) => {
          if (message) setNotice(message)
          void load()
        }}
        record={editing}
      />

      {reviewing && (
        <BomReviewDialog
          bomId={reviewing.id}
          onClose={() => setReviewing(null)}
          onEdit={() => {
            setEditing(reviewing)
            setReviewing(null)
            setDialogOpen(true)
          }}
          onApproved={(message) => {
            setReviewing(null)
            setNotice(message)
            void load()
          }}
        />
      )}

      <CopyBomDialog
        source={copying}
        onClose={() => setCopying(null)}
        onCopied={(message) => {
          if (message) setNotice(message)
          void load()
        }}
      />
    </div>
  )
}

interface LineProps {
  bom: Bom
  open: boolean
  busy: boolean
  canCost: boolean
  /** Columns in the table, for the detail row under a line. */
  cols: number
  onToggle: () => void
  onEdit: () => void
  onApprove: () => void
  onCopy: () => void
  onRetire: () => void
  /** The first line in the list: the one Tab lands on. */
  first?: boolean
}

/**
 * One BOM as a line of the table: its colour and version, what its status
 * means, its figures, who approved it, and what can be done to it. Opened,
 * the full detail sits under it.
 */
function BomLine({ bom, open, busy, canCost, cols, onToggle, onEdit, onApprove, onCopy, onRetire, first }: LineProps) {
  const status = STATUS[bom.status] ?? STATUS.DRAFT
  const material = num(bom.totalCost)
  const cost = bom.costPerPiece != null ? num(bom.costPerPiece) : material + num(bom.labourCost) + num(bom.overheadCost)
  const price = bom.sellingPrice != null ? num(bom.sellingPrice) : null
  const n = bom.lines?.length ?? 0
  const mayApprove = bom.status === 'DRAFT' && can('masters', 'approve')

  const actions: RowAction[] = [
    { key: 'edit', label: bom.status === 'APPROVED' ? 'Edit (a change makes a new version)' : 'Edit', icon: <Pencil size={14} />, onClick: onEdit },
    ...(mayApprove ? [{ key: 'approve', label: 'Approve', icon: <CheckCircle2 size={14} />, onClick: onApprove }] : []),
    { key: 'copy', label: 'Copy to a new version or colour', icon: <Copy size={14} />, onClick: onCopy },
    ...(bom.status !== 'OBSOLETE' || bom.isActive
      ? [{ key: 'retire', label: 'Stop offering', icon: <Ban size={14} />, onClick: onRetire, danger: true }]
      : []),
  ]

  return (
    <>
      <tr data-row tabIndex={first ? 0 : -1} className={cn(bom.status === 'OBSOLETE' && 'opacity-70')}>
        <td>
          <button
            onClick={onToggle}
            className="flex h-7 w-7 items-center justify-center rounded-lg bg-primary/10 text-primary transition-colors hover:bg-primary/20"
            aria-label={`${open ? 'Hide' : 'Show'} the components and costing of ${bomLabel(bom)}`}
            aria-expanded={open}
            title={open ? 'Hide details' : 'Show components and costing'}
            data-row-open
          >
            {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          </button>
        </td>
        <td className="whitespace-nowrap">
          <div className="text-sm font-medium text-foreground">
            {bom.color ?? (
              (bom.style?.colors?.length ?? 0) > 0 ? (
                // Made before BOMs were per colour. Copying it to each colour is
                // how it gets one, so it is flagged rather than left to look normal.
                <span className="badge-warning">Colour not set</span>
              ) : (
                <span className="text-muted-foreground">All colours</span>
              )
            )}
          </div>
          <div className="font-mono text-[11px] text-muted-foreground">
            v{bom.version}
            {bom.baseSize && ` · sized on ${bom.baseSize.label}`}
          </div>
        </td>
        <td className="whitespace-nowrap">
          <span className={status.cls}>{status.label}</span>
          {!bom.isActive && <span className="badge-danger ml-1.5">Not offered</span>}
          <div className="mt-0.5 text-[11px] text-muted-foreground">{MEANS[bom.status] ?? ''}</div>
        </td>
        <td className="whitespace-nowrap text-right tabular-nums">{n}</td>
        <td className="whitespace-nowrap text-right font-mono text-sm">{formatRupees(material)}</td>
        {canCost && <td className="whitespace-nowrap text-right font-mono text-sm font-semibold text-foreground">{formatRupees(cost)}</td>}
        {canCost && (
          <td className="whitespace-nowrap text-right">
            {price !== null ? (
              <>
                <div className="font-mono text-sm font-semibold text-primary">{formatRupees(price)}</div>
                {bom.marginPercent != null && <div className="text-[11px] text-muted-foreground">{percent(bom.marginPercent)} margin</div>}
              </>
            ) : (
              <span className="text-xs text-muted-foreground">Not priced</span>
            )}
          </td>
        )}
        <td className="whitespace-nowrap text-xs">
          {bom.approvedBy ? (
            <>
              <div className="text-foreground">{bom.approvedBy.name}</div>
              {bom.approvedAt && <div className="text-muted-foreground">{formatDate(bom.approvedAt)}</div>}
            </>
          ) : (
            <span className="text-muted-foreground">—</span>
          )}
        </td>
        <td className="whitespace-nowrap text-right">
          <div className="flex justify-end gap-1.5">
            {mayApprove ? (
              <button className="btn-primary h-7 px-2.5 text-xs" onClick={onApprove} disabled={busy} title="Review it, then approve">
                <CheckCircle2 size={13} /> Review & approve
              </button>
            ) : (
              <button className="btn-secondary h-7 px-2.5 text-xs" onClick={onEdit} disabled={busy}>
                <Pencil size={13} /> Edit
              </button>
            )}
            <ActionMenu label={`Actions for ${bomLabel(bom)}`} items={actions} />
          </div>
        </td>
      </tr>
      {open && (
        <tr>
          <td colSpan={cols} className="!p-0 bg-secondary/30">
            {/* Sized to the visible list, not the scrolling table. */}
            <div className="sticky left-0 w-[100cqw]">
              <BomDetail bom={bom} />
            </div>
          </td>
        </tr>
      )}
    </>
  )
}

interface CopyProps {
  source: Bom | null
  onClose: () => void
  onCopied: (message?: string) => void
}

/**
 * Copying makes both a new version and a new colour's BOM, so one dialog asks
 * for both. Picking another colour keeps the version, because White v1.0 copied
 * to Dusty Blue is naturally Dusty Blue v1.0 — the version only needs typing
 * when the colour stays the same.
 */
function CopyBomDialog({ source, onClose, onCopied }: CopyProps) {
  const [colour, setColour] = useState('')
  const [version, setVersion] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!source) return
    setColour(source.color ?? '')
    setVersion('')
    setError(null)
  }, [source])

  // Escape closes this window only — not the ones behind it.
  useEscape(onClose, Boolean(source))

  if (!source) return null

  const colours = source.style?.colors ?? []
  const sameColour = (colour || null) === (source.color ?? null)

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)

    if (sameColour && !version.trim()) {
      setError('Pick another colour, or give the copy a new version.')
      return
    }

    setSaving(true)
    try {
      const res = await api.post<{ message?: string }>(`/masters/bom/${source.id}/copy`, {
        ...(sameColour ? {} : { color: colour || null }),
        ...(version.trim() ? { version: version.trim() } : {}),
      })
      onCopied(res?.message)
      onClose()
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not copy. Is the API running?')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/60 backdrop-blur-sm p-4 sm:p-8">
      <div className="glass-card w-full max-w-md my-auto" role="dialog" aria-modal="true">
        <div className="flex items-center justify-between px-6 py-4 border-b border-border">
          <h2 className="text-lg font-semibold text-foreground">Copy BOM</h2>
          <button onClick={onClose} className="btn-ghost p-2" aria-label="Close">
            <X size={18} />
          </button>
        </div>

        <form onSubmit={submit} className="px-6 py-5 space-y-4">
          <p className="text-sm text-muted-foreground">
            From {bomLabel(source)}. Every component, rate and size quantity is carried over, and
            the copy starts as a draft.
          </p>

          {error && (
            <div className="flex items-start gap-3 p-3 rounded-lg border border-red-500/40 bg-red-500/5">
              <AlertCircle size={16} className="text-red-400 mt-0.5 shrink-0" />
              <p className="text-sm text-red-400">{error}</p>
            </div>
          )}

          <div>
            <label className="form-label" htmlFor="copy-colour">
              Colour
            </label>
            <SmartSelect
              id="copy-colour"
              className="form-input"
              value={colour}
              onChange={(e) => setColour(e.target.value)}
            >
              {!source.color && <option value="">Colour not set</option>}
              {colours.map((c) => (
                <option key={c} value={c}>
                  {c === source.color ? `${c} (same colour)` : c}
                </option>
              ))}
            </SmartSelect>
            <p className="text-xs text-muted-foreground mt-1">
              {colours.length === 0
                ? 'This style has no colours listed, so the copy can only be a new version.'
                : 'For another colour, usually only the fabric needs changing afterwards.'}
            </p>
          </div>

          <div>
            <label className="form-label" htmlFor="copy-version">
              Version
            </label>
            <input
              id="copy-version"
              className="form-input"
              value={version}
              onChange={(e) => setVersion(e.target.value)}
              placeholder={sameColour ? 'For example 1.1' : `Blank keeps v${source.version}`}
            />
          </div>

          <div className="flex items-center justify-end gap-3 pt-3 border-t border-border">
            <button type="button" onClick={onClose} className="btn-secondary" disabled={saving}>
              Cancel
            </button>
            <button type="submit" className="btn-primary" disabled={saving}>
              {saving && <Loader2 size={15} className="animate-spin" />}
              Copy BOM
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
