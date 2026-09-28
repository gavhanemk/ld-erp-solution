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
  ExternalLink,
} from 'lucide-react'
import { api, ApiError, type Paginated } from '@/lib/api'
import { cn, formatDate, formatRupees } from '@/lib/utils'
import { useAppSettings } from '@/lib/appSettings'
import { BomFormDialog, type Bom } from '@/components/masters/BomFormDialog'

/** The six status colours are fixed; a BOM uses three of them. */
const STATUS: Record<string, { label: string; cls: string }> = {
  DRAFT: { label: 'Draft', cls: 'badge-info' },
  APPROVED: { label: 'Approved', cls: 'badge-success' },
  OBSOLETE: { label: 'Obsolete', cls: 'badge-neutral' },
}

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
  const [activeOnly, setActiveOnly] = useState(true)
  const [status, setStatus] = useState('')
  const [page, setPage] = useState(1)

  const [expanded, setExpanded] = useState<string | null>(null)
  const [dialogOpen, setDialogOpen] = useState(false)
  const [editing, setEditing] = useState<Bom | null>(null)
  const [copying, setCopying] = useState<Bom | null>(null)

  // The same 350ms the master screens use, so typing does not fire a request
  // per keystroke.
  useEffect(() => {
    const t = setTimeout(() => setDebounced(search), 350)
    return () => clearTimeout(t)
  }, [search])

  useEffect(() => {
    setPage(1)
  }, [debounced, activeOnly, status])

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const params = new URLSearchParams({ page: String(page), limit: String(rowsPerPage) })
      if (debounced) params.set('q', debounced)
      if (activeOnly) params.set('active', 'true')
      if (status) params.set('status', status)

      const res = await api.get<Paginated<Bom>>(`/masters/bom?${params.toString()}`)
      setBoms(res.data)
      setPagination(res.pagination)
    } catch (err) {
      setError(
        err instanceof ApiError ? err.message : 'Could not reach the server. Is the API running?',
      )
      setBoms(null)
    } finally {
      setLoading(false)
    }
  }, [page, rowsPerPage, debounced, activeOnly, status])

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

  const approve = (bom: Bom) => {
    if (
      !confirm(
        `Approve ${bomLabel(bom)}?\n\nIt becomes the one approved BOM for this colour, and any BOM approved for it before is retired. The components and rates are locked after this — to change them, copy it to a new version.`,
      )
    )
      return
    void act(() => api.patch(`/masters/bom/${bom.id}/approve`, {}))
  }

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

  return (
    <div className="space-y-6">
      <div className="page-header">
        <div>
          <h1 className="page-title">Bill of Materials</h1>
          <p className="page-subtitle">
            {loading && !boms
              ? 'Loading...'
              : `${pagination.total} BOM${pagination.total === 1 ? '' : 's'}`}
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
          >
            <Plus size={16} />
            New BOM
          </button>
        </div>
      </div>

      <div className="glass-card p-4 flex flex-wrap items-center gap-3">
        <div className="flex-1 min-w-60 flex items-center gap-2 px-3 py-2 rounded-lg bg-secondary border border-border">
          <Search size={15} className="text-muted-foreground" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search by style name, code or version..."
            className="bg-transparent text-sm text-foreground placeholder:text-muted-foreground flex-1 focus:outline-none"
          />
        </div>
        <select
          className="form-input w-auto"
          value={status}
          onChange={(e) => setStatus(e.target.value)}
          aria-label="Filter by status"
        >
          <option value="">Any status</option>
          <option value="DRAFT">Draft</option>
          <option value="APPROVED">Approved</option>
          <option value="OBSOLETE">Obsolete</option>
        </select>
        <label className="flex items-center gap-2 text-sm text-muted-foreground cursor-pointer select-none">
          <input
            type="checkbox"
            checked={activeOnly}
            onChange={(e) => setActiveOnly(e.target.checked)}
            className="accent-teal-500"
          />
          Active only
        </label>
      </div>

      {notice && (
        <div className="glass-card p-4 flex items-start gap-3 border-amber-500/40">
          <AlertCircle size={18} className="text-amber-400 mt-0.5 shrink-0" />
          <p className="text-sm text-foreground">{notice}</p>
        </div>
      )}

      {error && (
        <div className="glass-card p-4 flex items-start gap-3 border-red-500/40">
          <AlertCircle size={18} className="text-red-400 mt-0.5 shrink-0" />
          <div>
            <p className="text-sm font-semibold text-red-400">Could not load bills of materials</p>
            <p className="text-xs text-muted-foreground mt-1">{error}</p>
          </div>
        </div>
      )}

      {loading && !boms && <div className="skeleton h-40 w-full rounded-xl" />}

      {empty && (
        <div className="glass-card p-10 text-center">
          <Layers size={22} className="text-muted-foreground mx-auto mb-3" />
          <p className="text-sm text-foreground font-medium">
            {debounced || status ? 'Nothing matches that' : 'No bills of materials yet'}
          </p>
          <p className="text-xs text-muted-foreground mt-1">
            {debounced || status
              ? 'Try the style code, or clear the filters.'
              : 'Pick a style and list what goes into one piece — fabric, trims, buttons, packing. The cost per garment comes out of it.'}
          </p>
        </div>
      )}

      <div className="space-y-3">
        {(boms ?? []).map((bom) => (
          <BomRow
            key={bom.id}
            bom={bom}
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
        ))}
      </div>

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

interface RowProps {
  bom: Bom
  open: boolean
  busy: boolean
  onToggle: () => void
  onEdit: () => void
  onApprove: () => void
  onCopy: () => void
  onRetire: () => void
}

function BomRow({ bom, open, busy, onToggle, onEdit, onApprove, onCopy, onRetire }: RowProps) {
  const status = STATUS[bom.status] ?? STATUS.DRAFT
  const material = num(bom.totalCost)
  const labour = num(bom.labourCost)
  const total = material + labour
  const lines = bom.lines ?? []
  const steps = bom.routing?.steps ?? []
  const totalSmv = steps.reduce((sum, s) => sum + num(s.smv), 0)

  // What the status means for this BOM, in words. A badge saying "Approved"
  // does not tell anyone what approving did, or what to do next.
  const who = `${bom.style?.code ?? 'this style'}${bom.color ? ` in ${bom.color}` : ''}`
  const note =
    bom.status === 'APPROVED'
      ? {
          icon: CheckCircle2,
          iconClass: 'text-emerald-400',
          title: `Approved — this is the BOM to use for ${who}`,
          body: 'Only one BOM per style and colour can be approved at a time. It is locked, so its costing stays fixed: to change it, copy it to a new version and approve that.',
        }
      : bom.status === 'OBSOLETE'
        ? {
            icon: Archive,
            iconClass: 'text-muted-foreground',
            title: 'Retired — kept for the record',
            body: `A newer BOM replaced it, or it was taken out of use. It is no longer the BOM for ${who}.`,
          }
        : {
            icon: PencilLine,
            iconClass: 'text-primary',
            title: 'Draft — not in use yet',
            body: `Check the components and the making steps, then approve it. Approving makes it the BOM for ${who} and retires any BOM approved for it before.`,
          }

  const sizeTotals = useMemo(() => {
    // A per-size cost only means something when at least one component varies.
    const ids = new Set<string>()
    for (const line of bom.lines ?? []) {
      for (const s of line.sizes ?? []) ids.add(s.sizeId)
    }
    if (ids.size === 0) return []

    const rows = new Map<string, { label: string; sequence: number; cost: number }>()
    for (const line of bom.lines ?? []) {
      const base = num(line.totalCost)
      for (const id of ids) {
        const own = (line.sizes ?? []).find((s) => s.sizeId === id)
        const label = own?.size?.label ?? own?.size?.code ?? ''
        const seq = own?.size?.sequence ?? 0
        const prev = rows.get(id) ?? { label, sequence: seq, cost: 0 }
        rows.set(id, {
          label: own ? label : prev.label,
          sequence: own ? seq : prev.sequence,
          // A size with no row of its own consumes what the line consumes.
          cost: prev.cost + (own ? num(own.totalCost) : base),
        })
      }
    }
    return [...rows.values()].sort((a, b) => a.sequence - b.sequence)
  }, [bom.lines])

  return (
    <div className="glass-card overflow-hidden">
      <div className="flex flex-wrap items-center gap-3 p-4">
        <button
          onClick={onToggle}
          className="btn-ghost p-1"
          aria-label={open ? 'Collapse' : 'Expand'}
        >
          {open ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
        </button>

        <div className="flex-1 min-w-48">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-mono text-xs text-teal-400">{bom.style?.code}</span>
            <span className="text-sm font-medium text-foreground truncate">{bom.style?.name}</span>
            {bom.color ? (
              <span className="text-sm text-foreground">· {bom.color}</span>
            ) : (
              (bom.style?.colors?.length ?? 0) > 0 && (
                // Made before BOMs were per colour. Copying it to each colour is
                // how it gets one, so it is flagged rather than left to look normal.
                <span className="badge-warning">Colour not set</span>
              )
            )}
            <span className="badge-neutral">v{bom.version}</span>
            <span className={status.cls}>{status.label}</span>
            {!bom.isActive && <span className="badge-danger">Not offered</span>}
          </div>
          <p className="text-xs text-muted-foreground mt-1">
            {bom.lines?.length ?? 0} component
            {bom.lines?.length === 1 ? '' : 's'}
            {bom.baseSize && ` · sized on ${bom.baseSize.label}`}
            {bom.routing && ` · ${bom.routing.steps?.length ?? 0} operations`}
            {bom.style?.brandType === 'VHAGAR' && (
              <span className="vhagar-accent font-bold ml-2">VHAGAR</span>
            )}
          </p>
        </div>

        <div className="text-right">
          <p className="font-mono text-sm font-bold text-foreground">{formatRupees(total)}</p>
          <p className="text-xs text-muted-foreground">per piece</p>
        </div>

        <div className="flex items-center gap-1">
          <button className="btn-ghost p-1.5" onClick={onEdit} disabled={busy} title="Edit">
            <Pencil size={14} />
          </button>
          {bom.status === 'DRAFT' && (
            <button
              className="btn-ghost p-1.5 text-emerald-400"
              onClick={onApprove}
              disabled={busy}
              title="Approve BOM"
            >
              <CheckCircle2 size={14} />
            </button>
          )}
          <button
            className="btn-ghost p-1.5"
            onClick={onCopy}
            disabled={busy}
            title="Copy to a new version or another colour"
          >
            <Copy size={14} />
          </button>
          <button
            className="btn-ghost p-1.5 text-red-400"
            onClick={onRetire}
            disabled={busy}
            title="Stop offering this BOM"
          >
            <Ban size={14} />
          </button>
        </div>
      </div>

      {open && (
        <div className="space-y-6 border-t border-border px-4 py-4">
          {/* What this BOM's status means, said once, in words, before any numbers. */}
          <div className="flex items-start gap-3 rounded-lg border border-border bg-secondary/40 px-4 py-3">
            <note.icon size={16} className={cn('mt-0.5 shrink-0', note.iconClass)} />
            <div className="space-y-0.5">
              <p className="text-sm font-semibold text-foreground">{note.title}</p>
              <p className="text-xs text-muted-foreground">{note.body}</p>
              {bom.approvedBy && (
                <p className="text-xs text-muted-foreground">
                  Approved by <span className="text-foreground">{bom.approvedBy.name}</span>
                  {bom.approvedAt && ` on ${formatDate(bom.approvedAt)}`}
                </p>
              )}
            </div>
          </div>

          {/* The answer first, as the sum it is. The tables below show where each part comes from. */}
          <section className="space-y-2">
            <h3 className={sectionTitle}>
              Cost of one piece{bom.baseSize && ` · size ${bom.baseSize.label}`}
            </h3>
            <div className="flex flex-col gap-2 md:flex-row md:items-stretch">
              <CostBox
                label="Material"
                amount={material}
                note={`${lines.length} component${lines.length === 1 ? '' : 's'}${
                  total > 0 ? ` · ${Math.round((material / total) * 100)}% of the cost` : ''
                }`}
              />
              <span className="flex items-center justify-center text-muted-foreground" aria-hidden>
                <Plus size={16} />
              </span>
              <CostBox
                label="Labour"
                amount={bom.routing ? labour : null}
                note={
                  bom.routing
                    ? `${steps.length} making step${steps.length === 1 ? '' : 's'}${
                        total > 0 ? ` · ${Math.round((labour / total) * 100)}% of the cost` : ''
                      }`
                    : 'No routing linked — not counted'
                }
              />
              <span className="flex items-center justify-center text-muted-foreground" aria-hidden>
                <Equal size={16} />
              </span>
              <CostBox label="Total" amount={total} note="for one piece" strong />
            </div>

            {sizeTotals.length > 0 && (
              <div className="overflow-x-auto rounded-lg border border-border">
                <table className="w-full text-sm">
                  <thead className="bg-secondary/60">
                    <tr className="border-b border-border">
                      <th className={cn(th, 'text-left')}>Total by size</th>
                      {sizeTotals.map((s) => (
                        <th key={s.label} className={cn(th, 'text-right')}>
                          {s.label}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    <tr>
                      <td className={cn(td, 'text-xs text-muted-foreground')}>Material + labour</td>
                      {sizeTotals.map((s) => (
                        <td key={s.label} className={cn(td, 'text-right font-mono text-foreground')}>
                          {formatRupees(s.cost + labour)}
                        </td>
                      ))}
                    </tr>
                  </tbody>
                </table>
              </div>
            )}
          </section>

          <section className="space-y-2">
            <div>
              <h3 className={sectionTitle}>Material — components ({lines.length})</h3>
              <p className="mt-0.5 text-xs text-muted-foreground">
                What goes into one piece. The material cost is the total of the Cost column.
              </p>
            </div>

            <div className="overflow-x-auto rounded-lg border border-border">
              <table className="w-full min-w-[980px] table-fixed text-sm">
                <colgroup>
                  <col className="w-10" />
                  <col />
                  <col className="w-24" />
                  <col className="w-32" />
                  <col className="w-24" />
                  <col className="w-24" />
                  <col className="w-24" />
                  <col className="w-16" />
                  <col className="w-24" />
                  <col className="w-28" />
                </colgroup>
                <thead className="bg-secondary/60">
                  <tr className="border-b border-border">
                    <th className={cn(th, 'text-center')}>#</th>
                    <th className={cn(th, 'text-left')}>Component</th>
                    <th className={cn(th, 'text-left')}>Part</th>
                    <th className={cn(th, 'text-left')} title="The department that draws it from the store">
                      Used by
                    </th>
                    <th className={cn(th, 'text-right')}>Qty / pc</th>
                    <th className={cn(th, 'text-right')}>Wastage</th>
                    <th className={cn(th, 'text-right')} title="Quantity with the wastage added">
                      Effective
                    </th>
                    <th className={cn(th, 'text-left')}>Unit</th>
                    <th className={cn(th, 'text-right')}>Rate</th>
                    <th className={cn(th, 'text-right')}>Cost</th>
                  </tr>
                </thead>

                <tbody>
                  {lines.map((line, index) => {
                    const bySize = line.sizes ?? []
                    return (
                      <Fragment key={line.id ?? index}>
                        {/* A line with size quantities keeps its divider below the size row instead. */}
                        <tr className={cn(bySize.length === 0 && 'border-b border-border/50')}>
                          <td className={cn(td, 'text-center font-mono text-xs text-muted-foreground')}>
                            {index + 1}
                          </td>
                          <td className={td}>
                            <div className="flex min-w-0 items-baseline gap-2">
                              <span className="shrink-0 font-mono text-xs text-muted-foreground">
                                {line.componentItem?.code}
                              </span>
                              <span className="truncate text-foreground" title={line.componentItem?.name}>
                                {line.componentItem?.name}
                              </span>
                            </div>
                          </td>
                          <td className={cn(td, 'truncate text-xs text-muted-foreground')}>
                            {line.component || '—'}
                          </td>
                          <td className={cn(td, 'truncate text-xs')}>
                            {line.department ? (
                              <span className="text-foreground">{line.department.name}</span>
                            ) : (
                              <span className="text-accent">Not set</span>
                            )}
                          </td>
                          <td className={cn(td, 'text-right font-mono')}>{qty(line.qtyPerUnit)}</td>
                          <td className={cn(td, 'text-right font-mono text-muted-foreground')}>
                            {percent(line.wastagePercent)}
                          </td>
                          <td className={cn(td, 'text-right font-mono font-medium')}>{qty(line.effectiveQty)}</td>
                          <td className={cn(td, 'text-xs text-muted-foreground')}>
                            {line.componentItem?.uom?.symbol ?? '—'}
                          </td>
                          <td className={cn(td, 'text-right font-mono text-muted-foreground')}>
                            {formatRupees(line.unitCost)}
                          </td>
                          <td className={cn(td, 'text-right font-mono font-semibold text-foreground')}>
                            {formatRupees(line.totalCost)}
                          </td>
                        </tr>

                        {bySize.length > 0 && (
                          <tr className="border-b border-border/50">
                            <td />
                            <td colSpan={9} className="px-3 pb-2.5">
                              <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1 text-xs text-muted-foreground">
                                <span>Effective by size:</span>
                                {bySize.map((s) => (
                                  <span key={s.id ?? s.sizeId} className="font-mono">
                                    {s.size?.label ?? s.size?.code}{' '}
                                    <span className="text-foreground">{qty(s.effectiveQty)}</span>
                                  </span>
                                ))}
                              </div>
                            </td>
                          </tr>
                        )}
                      </Fragment>
                    )
                  })}
                </tbody>

                <tfoot>
                  <tr className="bg-secondary/40">
                    <td colSpan={9} className={cn(td, 'text-right font-semibold text-foreground')}>
                      Material for one piece
                    </td>
                    <td className={cn(td, 'text-right font-mono font-bold text-foreground')}>
                      {formatRupees(material)}
                    </td>
                  </tr>
                </tfoot>
              </table>
            </div>
          </section>

          <section className="space-y-2">
            <div className="flex flex-wrap items-end justify-between gap-2">
              <div>
                <h3 className={sectionTitle}>Labour — making steps ({steps.length})</h3>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  {bom.routing ? (
                    <>
                      The steps from routing{' '}
                      <span className="font-mono text-foreground">{bom.routing.code}</span> ·{' '}
                      {bom.routing.name}. Labour is the total of the Paid column.
                    </>
                  ) : (
                    // The BOM form no longer links a routing, so this no longer
                    // sends anyone there to do it.
                    'No routing is linked, so labour is not in the cost yet.'
                  )}
                </p>
              </div>
              <a
                href="/masters/routings"
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
              >
                Open routings
                <ExternalLink size={13} />
              </a>
            </div>

            {bom.routing && (
              <div className="overflow-x-auto rounded-lg border border-border">
                <table className="w-full min-w-[640px] table-fixed text-sm">
                  <colgroup>
                    <col className="w-10" />
                    <col />
                    <col className="w-72" />
                    <col className="w-28" />
                    <col className="w-28" />
                  </colgroup>
                  <thead className="bg-secondary/60">
                    <tr className="border-b border-border">
                      <th className={cn(th, 'text-center')}>#</th>
                      <th className={cn(th, 'text-left')}>Step</th>
                      <th className={cn(th, 'text-left')} title="The line or outside unit that is paid for this step">
                        Done by
                      </th>
                      <th
                        className={cn(th, 'text-right')}
                        title="Standard minute value (SMV): the standard time one piece takes at this step"
                      >
                        Time / pc
                      </th>
                      <th className={cn(th, 'text-right')} title="What this step pays for one piece">
                        Paid / pc
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {steps.map((step) => (
                      <tr key={step.id} className="border-b border-border/50">
                        <td className={cn(td, 'text-center font-mono text-xs text-muted-foreground')}>
                          {step.sequence}
                        </td>
                        <td className={td}>
                          <div className="flex min-w-0 items-center gap-2">
                            <span className="truncate text-foreground">{step.operation?.name}</span>
                            {step.isQcStep && <span className="badge-warning">Quality check</span>}
                          </div>
                        </td>
                        <td className={td}>
                          {step.workstation ? (
                            <div className="flex min-w-0 items-center gap-2">
                              <span className="truncate text-xs text-foreground" title={step.workstation.name}>
                                {step.workstation.name}
                              </span>
                              {step.workstation.type === 'JOB_WORK' && (
                                <span className="badge-purple shrink-0">Job work</span>
                              )}
                            </div>
                          ) : (
                            <span className="text-xs text-muted-foreground">Not assigned</span>
                          )}
                        </td>
                        <td className={cn(td, 'text-right font-mono text-muted-foreground')}>
                          {step.smv != null ? `${qty(step.smv)} min` : '—'}
                        </td>
                        <td className={cn(td, 'text-right font-mono text-foreground')}>
                          {step.ratePerPiece != null ? formatRupees(step.ratePerPiece) : '—'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr className="bg-secondary/40">
                      <td colSpan={3} className={cn(td, 'text-right font-semibold text-foreground')}>
                        Labour for one piece
                      </td>
                      <td className={cn(td, 'text-right font-mono text-muted-foreground')}>
                        {totalSmv > 0 ? `${qty(totalSmv)} min` : '—'}
                      </td>
                      <td className={cn(td, 'text-right font-mono font-bold text-foreground')}>
                        {formatRupees(labour)}
                      </td>
                    </tr>
                  </tfoot>
                </table>
              </div>
            )}
          </section>

          {bom.notes && (
            <section className="space-y-1">
              <h3 className={sectionTitle}>Notes</h3>
              <p className="whitespace-pre-line text-sm text-foreground">{bom.notes}</p>
            </section>
          )}
        </div>
      )}
    </div>
  )
}

interface CostBoxProps {
  label: string
  /** null when this part is not costed at all — a different fact from ₹0.00. */
  amount: number | null
  note: string
  strong?: boolean
}

/** One term of the "material + labour = total" sum at the top of an expanded BOM. */
function CostBox({ label, amount, note, strong }: CostBoxProps) {
  return (
    <div className={cn('flex-1 rounded-lg border border-border px-4 py-3', strong && 'bg-secondary/40')}>
      <p className="text-xs font-medium text-muted-foreground">{label}</p>
      <p className={cn('mt-1 font-mono text-lg font-bold', strong ? 'text-primary' : 'text-foreground')}>
        {amount === null ? '—' : formatRupees(amount)}
      </p>
      <p className="mt-0.5 text-xs text-muted-foreground">{note}</p>
    </div>
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

  useEffect(() => {
    if (!source) return
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [source, onClose])

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
            <select
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
            </select>
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
