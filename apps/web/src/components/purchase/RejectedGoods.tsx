'use client'

import { useCallback, useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import Link from 'next/link'
import { AlertCircle, CheckCircle2, Loader2, PackageX, Search, Truck, Undo2, X } from 'lucide-react'
import { api, ApiError, can } from '@/lib/api'
import { useEscape } from '@/lib/useEscape'
import { StepInput } from '@/components/ui/StepInput'
import { ReturnChallanDialog } from './ReturnChallanDialog'

interface QcEvent {
  at: string
  by: string
  kind: 'USED' | 'RETURNED' | 'RETURN_CANCELLED'
  qty: number
  note?: string | null
  refNumber?: string | null
}

interface RejectedRow {
  qcId: string
  grnLineId: string
  checkedOn: string
  checkedBy: string | null
  grn: { id: string; grnNumber: string; grnDate: string; challanNo: string | null; poNumber: string }
  supplier: { id: string; name: string }
  item: { id: string; code: string; name: string; unit: string }
  store: { id: string; name: string }
  heldIn: 'SAME_STORE' | 'GODOWN' | 'NOTED'
  godown: string | null
  rejected: number
  used: number
  returned: number
  /** Still held as rejected; null on a check that moved them to a godown or only noted them. */
  held: number | null
  reason: string | null
  note: string | null
  bill: { id: string; billNumber: string; supplierInvoiceNo: string | null } | null
  events: QcEvent[]
}

const qty = (n: number) => n.toLocaleString('en-IN', { maximumFractionDigits: 3 })
const day = (d: string) => new Date(d).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: '2-digit' })

/** What happened to a line's rejected goods, in one line. */
const story = (r: RejectedRow) =>
  r.events
    .map((e) =>
      e.kind === 'USED'
        ? `${qty(e.qty)} used after all ${day(e.at)}${e.by ? ` by ${e.by}` : ''}${e.note ? ` — ${e.note}` : ''}`
        : e.kind === 'RETURNED'
          ? `${qty(e.qty)} sent back on ${e.refNumber ?? 'a return'} ${day(e.at)}`
          : `${e.refNumber ?? 'A return'} cancelled ${day(e.at)}: ${qty(e.qty)} held again`,
    )
    .join(' · ')

/**
 * Purchase → Rejected Goods: everything a quality check rejected, held in its
 * store where it cannot be issued, until somebody decides — send it back to
 * the supplier on a return challan against the bill, or use it after all.
 */
export function RejectedGoods() {
  const [rows, setRows] = useState<RejectedRow[] | null>(null)
  const [summary, setSummary] = useState<{ heldLines: number; heldReceipts: number } | null>(null)
  const [view, setView] = useState<'held' | 'all'>('held')
  const [search, setSearch] = useState('')
  const [q, setQ] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [using, setUsing] = useState<RejectedRow | null>(null)
  const [returning, setReturning] = useState<RejectedRow | null>(null)
  const mayUse = can('purchase', 'edit')
  const mayReturn = can('purchase', 'create')

  useEffect(() => {
    const t = setTimeout(() => setQ(search.trim()), 300)
    return () => clearTimeout(t)
  }, [search])

  const load = useCallback(async () => {
    setError(null)
    try {
      const qs = new URLSearchParams({ view })
      if (q) qs.set('q', q)
      const res = await api.get<{ data: RejectedRow[]; summary: { heldLines: number; heldReceipts: number } }>(`/purchase/qc/rejected?${qs}`)
      setRows(res.data)
      setSummary(res.summary)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load the rejected goods.')
    }
  }, [view, q])
  useEffect(() => {
    void load()
  }, [load])

  const actions = (r: RejectedRow) => {
    const held = r.held ?? (r.heldIn === 'GODOWN' ? r.rejected : 0)
    if (!(held > 0)) return <span className="text-muted-foreground text-xs">Settled</span>
    return (
      <div className="flex flex-wrap justify-end gap-1.5">
        {mayReturn &&
          (r.bill ? (
            <button type="button" className="btn-secondary h-8 px-2.5 text-xs" onClick={() => setReturning(r)} title={`Return challan against ${r.bill.billNumber}`}>
              <Truck size={13} /> Send back
            </button>
          ) : (
            <Link href={`/purchase/bills?fromGrn=${r.grn.id}`} className="btn-ghost h-8 px-2.5 text-xs" title="Goods go back against the supplier's bill. Book it first.">
              Book the bill first
            </Link>
          ))}
        {mayUse && r.heldIn === 'SAME_STORE' && (
          <button type="button" className="btn-ghost h-8 px-2.5 text-xs" onClick={() => setUsing(r)}>
            <Undo2 size={13} /> Use after all
          </button>
        )}
      </div>
    )
  }

  return (
    <div className="space-y-4">
      <div className="page-header">
        <div>
          <h1 className="page-title text-xl sm:text-2xl">Rejected Goods</h1>
          <p className="page-subtitle">
            What a quality check rejected. It stays in its store, held apart so it cannot be issued, until it goes back to the supplier or is used after all.
          </p>
        </div>
      </div>

      {error && (
        <div className="border-destructive/40 bg-destructive/5 flex items-start gap-3 rounded-lg border p-3">
          <AlertCircle size={16} className="text-destructive mt-0.5 shrink-0" />
          <p className="text-destructive text-sm">{error}</p>
        </div>
      )}
      {message && (
        <div className="flex items-start gap-3 rounded-lg border border-emerald-500/40 bg-emerald-500/10 p-3">
          <CheckCircle2 size={16} className="mt-0.5 shrink-0 text-emerald-600" />
          <p className="text-foreground text-sm">{message}</p>
          <button type="button" className="text-muted-foreground ml-auto" onClick={() => setMessage(null)} aria-label="Dismiss">
            <X size={14} />
          </button>
        </div>
      )}

      <div className="glass-card overflow-hidden p-0">
        <div className="border-border flex flex-wrap items-center gap-2 border-b px-4 py-3">
          <div className="bg-secondary/60 flex shrink-0 gap-1 rounded-lg p-0.5" role="tablist">
            {(
              [
                ['held', `Still held${summary ? ` (${summary.heldLines})` : ''}`],
                ['all', 'All'],
              ] as const
            ).map(([key, label]) => (
              <button
                key={key}
                type="button"
                role="tab"
                aria-selected={view === key}
                onClick={() => setView(key)}
                className={`rounded-md px-2.5 py-1.5 text-xs font-medium ${view === key ? 'bg-primary/15 text-primary' : 'text-muted-foreground hover:text-foreground'}`}
              >
                {label}
              </button>
            ))}
          </div>
          <div className="bg-field border-field-edge flex min-w-0 max-w-sm flex-1 basis-full items-center gap-2 rounded-lg border px-3 py-1.5 sm:basis-auto">
            <Search size={14} className="text-muted-foreground" />
            <input
              className="text-foreground placeholder:text-muted-foreground flex-1 border-0 bg-transparent text-sm outline-none"
              placeholder="GRN, challan, PO, supplier, item…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              aria-label="Search rejected goods"
            />
          </div>
          {summary && summary.heldLines > 0 && (
            <span className="text-muted-foreground ml-auto text-xs">
              {summary.heldLines} {summary.heldLines === 1 ? 'line' : 'lines'} held on {summary.heldReceipts} {summary.heldReceipts === 1 ? 'receipt' : 'receipts'}
            </span>
          )}
        </div>

        {!rows ? (
          <div className="space-y-2 p-4">
            {[0, 1, 2].map((i) => (
              <div key={i} className="skeleton h-12 w-full rounded-lg" />
            ))}
          </div>
        ) : !rows.length ? (
          <div className="px-4 py-12 text-center">
            <PackageX size={28} className="text-muted-foreground mx-auto" />
            <p className="text-foreground mt-2 text-sm font-medium">{view === 'held' ? 'Nothing is held as rejected.' : 'No quality check has rejected anything yet.'}</p>
            <p className="text-muted-foreground mt-1 text-sm">Rejections recorded on a goods receipt&apos;s quality check show here, with what to do about them.</p>
          </div>
        ) : (
          <>
            <div className="hidden overflow-x-auto md:block">
              <table className="data-table table-compact w-full">
                <thead>
                  <tr className="bg-secondary">
                    <th>Checked</th>
                    <th>Receipt</th>
                    <th>Item</th>
                    <th>Store</th>
                    <th style={{ textAlign: 'right' }}>Rejected</th>
                    <th style={{ textAlign: 'right' }}>Used</th>
                    <th style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>Sent back</th>
                    <th style={{ textAlign: 'right' }}>Held</th>
                    <th>Why</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={`${r.qcId}-${r.grnLineId}`}>
                      <td className="whitespace-nowrap text-xs">
                        {day(r.checkedOn)}
                        {r.checkedBy && <span className="text-muted-foreground block">{r.checkedBy}</span>}
                      </td>
                      <td className="text-xs">
                        <span className="text-foreground font-mono font-semibold">{r.grn.grnNumber}</span>
                        <span className="text-muted-foreground block">
                          {[r.grn.challanNo ? `challan ${r.grn.challanNo}` : null, r.grn.poNumber, r.supplier.name].filter(Boolean).join(' · ')}
                        </span>
                        {r.bill && <span className="text-muted-foreground block">bill {r.bill.billNumber}</span>}
                      </td>
                      <td>
                        <span className="text-foreground text-sm">{r.item.name}</span>
                        <span className="text-muted-foreground block font-mono text-[11px]">{r.item.code}</span>
                        {r.events.length > 0 && (
                          <span className="text-muted-foreground line-clamp-2 block max-w-xs text-[11px]" title={story(r)}>
                            {story(r)}
                          </span>
                        )}
                      </td>
                      <td className="whitespace-nowrap text-sm">
                        {r.heldIn === 'GODOWN' && r.godown ? r.godown : r.store.name}
                        {r.heldIn === 'SAME_STORE' && <span className="text-muted-foreground block text-[11px]">held apart</span>}
                      </td>
                      <td className="whitespace-nowrap text-right tabular-nums">
                        {qty(r.rejected)} <span className="text-muted-foreground text-xs">{r.item.unit}</span>
                      </td>
                      <td className="text-right tabular-nums">{r.used ? qty(r.used) : <span className="text-muted-foreground">—</span>}</td>
                      <td className="text-right tabular-nums">{r.returned ? qty(r.returned) : <span className="text-muted-foreground">—</span>}</td>
                      <td className="whitespace-nowrap text-right font-semibold tabular-nums">
                        {r.held == null ? <span className="text-muted-foreground font-normal">—</span> : r.held > 0 ? <span className="warn-text">{qty(r.held)}</span> : '0'}
                      </td>
                      <td className="max-w-[200px] text-xs">{r.reason ?? <span className="text-muted-foreground">—</span>}</td>
                      <td>{actions(r)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="divide-border/60 divide-y md:hidden">
              {rows.map((r) => (
                <div key={`${r.qcId}-${r.grnLineId}`} className="space-y-1.5 px-4 py-3">
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="text-foreground text-sm font-medium">{r.item.name}</span>
                    <span className="whitespace-nowrap text-sm font-semibold tabular-nums">
                      {r.held != null && r.held > 0 ? <span className="warn-text">{qty(r.held)} held</span> : `${qty(r.rejected)} rejected`} {r.item.unit}
                    </span>
                  </div>
                  <p className="text-muted-foreground text-xs">
                    {[r.grn.grnNumber, r.grn.challanNo ? `challan ${r.grn.challanNo}` : null, r.supplier.name, r.store.name, r.reason].filter(Boolean).join(' · ')}
                  </p>
                  {r.events.length > 0 && <p className="text-muted-foreground text-[11px]">{story(r)}</p>}
                  <div className="flex justify-end">{actions(r)}</div>
                </div>
              ))}
            </div>
          </>
        )}
      </div>

      {using && (
        <UseAfterAll
          row={using}
          onClose={() => setUsing(null)}
          onDone={(m) => {
            setUsing(null)
            setMessage(m)
            void load()
          }}
        />
      )}
      {returning?.bill && (
        <ReturnChallanDialog
          billId={returning.bill.id}
          onClose={() => setReturning(null)}
          onSaved={(m, id) => {
            setReturning(null)
            setMessage(m)
            void load()
            // The gate pass the vehicle leaves with.
            window.open('/print/purchase-return/' + id, '_blank', 'noopener')
          }}
        />
      )}
    </div>
  )
}

/** Taking rejected goods back into good stock: how much, and why. */
function UseAfterAll({ row, onClose, onDone }: { row: RejectedRow; onClose: () => void; onDone: (message: string) => void }) {
  const held = row.held ?? 0
  const [amount, setAmount] = useState(String(held))
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const n = Number(amount) || 0
  const problem = !(n > 0) ? 'Say how much is used after all.' : n > held + 1e-9 ? `Only ${qty(held)} ${row.item.unit} is held.` : reason.trim().length < 5 ? 'Say why it can be used after all.' : null

  // Escape closes this window only — not the ones behind it.
  useEscape(() => {
    if (!busy) onClose()
  })

  const save = async () => {
    if (problem) return
    setBusy(true)
    setError(null)
    try {
      const res = await api.post<{ message: string }>(`/purchase/qc/${row.qcId}/use`, { grnLineId: row.grnLineId, qty: n, reason: reason.trim() })
      onDone(res.message)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save.')
      setBusy(false)
    }
  }

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-3 backdrop-blur-sm sm:left-[var(--sidebar-current-width)]">
      <div className="glass-card w-full max-w-md p-0" role="dialog" aria-modal="true" aria-labelledby="use-after-all-title">
        <div className="flex items-start gap-3 p-5 pb-3">
          <span className="bg-primary/10 text-primary flex h-10 w-10 shrink-0 items-center justify-center rounded-lg">
            <Undo2 size={20} />
          </span>
          <div className="min-w-0 flex-1">
            <h2 id="use-after-all-title" className="text-foreground text-lg font-semibold">
              Use after all
            </h2>
            <p className="text-muted-foreground mt-0.5 text-sm">
              {row.item.name} from {row.grn.grnNumber} goes back into good stock in {row.store.name}, and can be issued again.
            </p>
          </div>
          <button type="button" className="text-muted-foreground hover:text-foreground" onClick={onClose} aria-label="Close" disabled={busy}>
            <X size={18} />
          </button>
        </div>
        <div className="space-y-3 px-5">
          <label className="block">
            <span className="form-label">How much</span>
            <div className="flex items-center gap-2">
              <StepInput className="form-input w-36 text-right" value={amount} onValueChange={setAmount} max={held} decimals aria-label="How much is used after all" />
              <span className="text-muted-foreground text-sm">
                {row.item.unit} of {qty(held)} held
              </span>
            </div>
          </label>
          <label className="block">
            <span className="form-label">Why</span>
            <input className="form-input" value={reason} maxLength={500} placeholder="e.g. Shade close enough for the lining; supplier gave 8% off" onChange={(e) => setReason(e.target.value)} />
          </label>
          {(error || (problem && amount !== '')) && <p className="text-sm text-red-500">{error ?? problem}</p>}
        </div>
        <div className="flex justify-end gap-2 p-5">
          <button type="button" className="btn-secondary" onClick={onClose} disabled={busy}>
            Not now
          </button>
          <button type="button" className="btn-primary" onClick={() => void save()} disabled={busy || !!problem}>
            {busy ? <Loader2 size={15} className="animate-spin" /> : <Undo2 size={15} />} Use {n > 0 ? `${qty(n)} ${row.item.unit}` : ''}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  )
}
