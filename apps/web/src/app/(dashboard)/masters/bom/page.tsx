'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
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
} from 'lucide-react'
import { api, ApiError, type Paginated } from '@/lib/api'
import { formatCurrency } from '@/lib/utils'
import { useAppSettings } from '@/lib/appSettings'
import { BomFormDialog, type Bom } from '@/components/masters/BomFormDialog'

/** The six status colours are fixed; a BOM uses three of them. */
const STATUS: Record<string, { label: string; cls: string }> = {
  DRAFT: { label: 'Draft', cls: 'badge-info' },
  APPROVED: { label: 'Approved', cls: 'badge-success' },
  OBSOLETE: { label: 'Obsolete', cls: 'badge-neutral' },
}

const num = (v: unknown) => Number(v ?? 0)

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
    const label = `${bom.style?.code} v${bom.version}`
    if (
      !confirm(
        `Approve ${label}?\n\nThe components and rates are frozen after this. To change them, copy it to a new version.`,
      )
    )
      return
    void act(() => api.patch(`/masters/bom/${bom.id}/approve`, {}))
  }

  const copy = (bom: Bom) => {
    const next = prompt(
      `Copy ${bom.style?.code} v${bom.version} to a new version.\n\nWhat is the new version called?`,
      '',
    )
    if (!next) return
    void act(() => api.post(`/masters/bom/${bom.id}/copy`, { version: next.trim() }))
  }

  const retire = (bom: Bom) => {
    const label = `${bom.style?.code} v${bom.version}`
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
          <p className="text-sm font-bold text-foreground">{formatCurrency(total)}</p>
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
            title="Copy to new version"
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
        <div className="border-t border-border px-4 py-4 space-y-5">
          <div className="overflow-x-auto">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Component</th>
                  <th>Part</th>
                  <th className="text-right">Qty / pc</th>
                  <th className="text-right">Wastage</th>
                  <th className="text-right">Effective</th>
                  <th className="text-right">Rate</th>
                  <th className="text-right">Cost</th>
                </tr>
              </thead>
              <tbody>
                {(bom.lines ?? []).map((line) => {
                  const unit = line.componentItem?.uom?.symbol ?? ''
                  return (
                    <tr key={line.id}>
                      <td>
                        <span className="font-mono text-xs text-muted-foreground mr-2">
                          {line.componentItem?.code}
                        </span>
                        {line.componentItem?.name}
                        {(line.sizes?.length ?? 0) > 0 && (
                          <span className="flex flex-wrap gap-2 mt-1">
                            {(line.sizes ?? []).map((s) => (
                              <span key={s.id ?? s.sizeId} className="badge-neutral">
                                {s.size?.label ?? s.size?.code} {num(s.effectiveQty)} {unit}
                              </span>
                            ))}
                          </span>
                        )}
                      </td>
                      <td className="text-xs text-muted-foreground">{line.component || '—'}</td>
                      <td className="text-right">
                        {num(line.qtyPerUnit)} {unit}
                      </td>
                      <td className="text-right text-muted-foreground">
                        {num(line.wastagePercent)}%
                      </td>
                      <td className="text-right font-medium">
                        {num(line.effectiveQty)} {unit}
                      </td>
                      <td className="text-right text-muted-foreground">
                        {formatCurrency(num(line.unitCost))}
                      </td>
                      <td className="text-right font-semibold">
                        {formatCurrency(num(line.totalCost))}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>

          {bom.routing && (
            <div>
              <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-2">
                Process — {bom.routing.name}
              </h3>
              <div className="flex flex-wrap gap-2">
                {(bom.routing.steps ?? []).map((step) => (
                  <span key={step.id} className={step.isQcStep ? 'badge-warning' : 'badge-info'}>
                    {step.sequence}. {step.operation?.name}
                    {step.ratePerPiece != null && ` · ${formatCurrency(num(step.ratePerPiece))}`}
                  </span>
                ))}
              </div>
            </div>
          )}

          <div className="flex flex-wrap items-end justify-between gap-4 pt-3 border-t border-border">
            <div className="text-xs text-muted-foreground space-y-1">
              {sizeTotals.length > 0 && (
                <p className="flex flex-wrap gap-2">
                  {sizeTotals.map((s) => (
                    <span key={s.label}>
                      {s.label} {formatCurrency(s.cost + labour)}
                    </span>
                  ))}
                </p>
              )}
              {bom.approvedBy && <p>Approved by {bom.approvedBy.name}</p>}
              {bom.notes && <p className="whitespace-pre-line">{bom.notes}</p>}
            </div>

            <table className="text-sm">
              <tbody>
                <tr>
                  <td className="pr-6 text-muted-foreground">Material</td>
                  <td className="text-right font-medium">{formatCurrency(material)}</td>
                </tr>
                <tr>
                  <td className="pr-6 text-muted-foreground">Labour</td>
                  <td className="text-right font-medium">
                    {bom.routing ? formatCurrency(labour) : '—'}
                  </td>
                </tr>
                <tr>
                  <td className="pr-6 font-semibold">
                    Total per piece
                    {bom.baseSize && ` (${bom.baseSize.label})`}
                  </td>
                  <td className="text-right font-bold text-teal-400">{formatCurrency(total)}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  )
}
