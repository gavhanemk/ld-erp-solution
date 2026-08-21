'use client'

import { useCallback, useEffect, useState } from 'react'
import { Plus, RefreshCw, AlertCircle, ChevronDown, ChevronRight, Layers } from 'lucide-react'
import { api, ApiError } from '@/lib/api'
import { formatCurrency } from '@/lib/utils'
import { BomFormDialog, type Bom } from '@/components/masters/BomFormDialog'

export default function BomPage() {
  const [boms, setBoms] = useState<Bom[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [expanded, setExpanded] = useState<string | null>(null)
  const [dialogOpen, setDialogOpen] = useState(false)
  const [editing, setEditing] = useState<Bom | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await api.get<{ success: boolean; data: Bom[] }>('/masters/bom?limit=100')
      setBoms(res.data)
    } catch (err) {
      setError(
        err instanceof ApiError ? err.message : 'Could not reach the server. Is the API running?',
      )
      setBoms(null)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  return (
    <div className="space-y-6">
      <div className="page-header">
        <div>
          <h1 className="page-title">Bill of Materials</h1>
          <p className="page-subtitle">
            {loading && !boms
              ? 'Loading...'
              : `${boms?.length ?? 0} BOM${boms?.length === 1 ? '' : 's'}`}
          </p>
        </div>
        <div className="flex items-center gap-3">
          <button onClick={() => void load()} className="btn-secondary">
            <RefreshCw size={15} className={loading ? 'animate-spin' : ''} />
            Refresh
          </button>
          <button
            className="btn-primary"
            onClick={() => {
              setEditing(null)
              setDialogOpen(true)
            }}
          >
            <Plus size={15} />
            New BOM
          </button>
        </div>
      </div>

      {error && (
        <div className="glass-card p-4 flex items-start gap-3 border-red-500/40">
          <AlertCircle size={18} className="text-red-400 mt-0.5 shrink-0" />
          <div>
            <p className="text-sm font-semibold text-red-400">Could not load bills of materials</p>
            <p className="text-xs text-muted-foreground mt-1">{error}</p>
          </div>
        </div>
      )}

      {!error && boms && boms.length === 0 && (
        <div className="glass-card p-10 text-center">
          <Layers size={22} className="text-muted-foreground mx-auto mb-3" />
          <p className="text-sm text-foreground font-medium">No bills of materials yet</p>
          <p className="text-xs text-muted-foreground mt-1">
            Add a style first, then build its BOM to cost the garment.
          </p>
        </div>
      )}

      {!error && loading && !boms && <div className="skeleton h-40 w-full rounded-lg" />}

      <div className="space-y-3">
        {(boms ?? []).map((bom) => {
          const open = expanded === bom.id

          return (
            <div key={bom.id} className="glass-card overflow-hidden">
              <div className="flex items-center gap-4 p-4">
                <button
                  onClick={() => setExpanded(open ? null : bom.id)}
                  className="btn-ghost p-1"
                  aria-label={open ? 'Collapse' : 'Expand'}
                >
                  {open ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
                </button>

                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-xs text-teal-400">{bom.style?.code}</span>
                    <span className="text-sm font-medium text-foreground truncate">
                      {bom.style?.name}
                    </span>
                    <span className="badge-neutral">v{bom.version}</span>
                    {!bom.isActive && <span className="badge-danger">Inactive</span>}
                  </div>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    {bom.lines?.length ?? 0} component
                    {bom.lines?.length === 1 ? '' : 's'}
                    {bom.style?.brandType === 'VHAGAR' && (
                      <span className="vhagar-accent font-bold ml-2">VHAGAR</span>
                    )}
                  </p>
                </div>

                <div className="text-right">
                  <p className="text-sm font-bold text-foreground">
                    {formatCurrency(Number(bom.totalCost ?? 0))}
                  </p>
                  <p className="text-[10px] text-muted-foreground">per piece</p>
                </div>

                <button
                  className="btn-secondary"
                  onClick={() => {
                    setEditing(bom)
                    setDialogOpen(true)
                  }}
                >
                  Edit
                </button>
              </div>

              {open && (
                <div className="border-t border-border px-4 py-3 overflow-x-auto">
                  <table className="data-table">
                    <thead>
                      <tr>
                        <th>Component</th>
                        <th className="text-right">Qty / pc</th>
                        <th className="text-right">Wastage</th>
                        <th className="text-right">Effective</th>
                        <th className="text-right">Rate</th>
                        <th className="text-right">Cost</th>
                      </tr>
                    </thead>
                    <tbody>
                      {(bom.lines ?? []).map((line) => (
                        <tr key={line.id}>
                          <td>
                            <span className="font-mono text-xs text-muted-foreground mr-2">
                              {line.componentItem?.code}
                            </span>
                            {line.componentItem?.name}
                          </td>
                          <td className="text-right">
                            {Number(line.qtyPerUnit)} {line.componentItem?.uom?.symbol ?? ''}
                          </td>
                          <td className="text-right text-muted-foreground">
                            {Number(line.wastagePercent)}%
                          </td>
                          <td className="text-right font-medium">
                            {Number(line.effectiveQty)} {line.componentItem?.uom?.symbol ?? ''}
                          </td>
                          <td className="text-right text-muted-foreground">
                            {formatCurrency(Number(line.unitCost ?? 0))}
                          </td>
                          <td className="text-right font-semibold">
                            {formatCurrency(Number(line.totalCost ?? 0))}
                          </td>
                        </tr>
                      ))}
                      <tr>
                        <td colSpan={5} className="text-right font-semibold">
                          Total material cost per piece
                        </td>
                        <td className="text-right font-bold text-teal-400">
                          {formatCurrency(Number(bom.totalCost ?? 0))}
                        </td>
                      </tr>
                    </tbody>
                  </table>
                  {bom.notes && (
                    <p className="text-xs text-muted-foreground mt-3 whitespace-pre-line">
                      {bom.notes}
                    </p>
                  )}
                </div>
              )}
            </div>
          )
        })}
      </div>

      <BomFormDialog
        open={dialogOpen}
        onClose={() => setDialogOpen(false)}
        onSaved={() => void load()}
        record={editing}
      />
    </div>
  )
}
