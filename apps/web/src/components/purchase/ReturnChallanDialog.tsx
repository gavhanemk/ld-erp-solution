'use client'

import { useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  AlertCircle,
  FileText,
  Loader2,
  MessageSquare,
  Package,
  PackageMinus,
  Plus,
  Trash2,
  Truck,
  X,
} from 'lucide-react'
import { api, apiErrorMessage, can, masterResource } from '@/lib/api'
import { Section } from '@/components/purchase/Section'
import { SmartSelect } from '@/components/ui/SmartSelect'
import { MasterFormDialog } from '@/components/masters/MasterFormDialog'
import {
  optionFromCreated,
  returnReasonFields,
  type ReasonOption,
} from '@/components/purchase/returnReasons'

/**
 * A return challan — goods going back to the supplier against a bill.
 *
 * The physical half of a return. Saving it takes the goods out of stock at
 * once (they are on the vehicle) and writes a draft debit note for accounts,
 * linked back to it. The form therefore asks only what the loading bay knows:
 * what is going, how much, from which godown, why, and on what vehicle. The
 * money is priced from the bill and settled by accounts on the note.
 *
 * Opens pre-filled with every line of the bill that still has something left
 * to send back, each from the godown it was received into, with the quantity
 * empty — the store keeper types what is actually on the vehicle rather than
 * deleting what is not.
 */

interface ReturnableLine {
  billLineId: string
  itemId: string
  itemCode: string
  itemName: string
  uom: string | null
  hsnCode: string | null
  gstRate: number
  billedQty: number
  billedRate: number
  remainingQty: number
  rejectedQty: number
  adjustedQty: number
  warehouseId: string | null
  onHand: number | null
  /** Rejected on a quality check, and the reject godown it was moved to. */
  qcRejectedQty: number
  /** Why QC rejected it, as one of the challan's reasons; null if it did not say. */
  qcReasonCode: string | null
  /** The mill's own name for that reason, when QC picked one of theirs. */
  qcReasonName: string | null
  /** The checker's note on that rejection. */
  qcReasonNote: string | null
  qcWarehouseId: string | null
  qcWarehouseName: string | null
  qcOnHand: number | null
}

interface Returnable {
  bill: {
    id: string
    billNumber: string
    supplierInvoiceNo: string | null
    supplierInvoiceDate: string | null
    billDate: string
    status: string
    totalAmount: string | number
    supplier: { id: string; code: string; name: string; gstin: string | null }
  }
  /** The paperwork behind the bill, for the challan to quote. */
  references?: {
    orders: Array<{ poNumber: string; poDate: string }>
    receipts: Array<{
      grnNumber: string
      grnDate: string
      challanNo: string | null
      challanDate: string | null
      gateEntryNo: string | null
      gateEntryDate: string | null
      vehicleNo: string | null
      qc: { result: string; inspectionDate: string; rejectedQty: number } | null
    }>
  }
  lines: ReturnableLine[]
  /** Built-in reasons, then the mill's own from Masters → Dropdown Lists. */
  reasons: ReasonOption[]
}

/** A date as the mill writes it: 03 Oct 2026. */
const refDay = (iso: string | null | undefined) =>
  iso
    ? new Date(iso).toLocaleDateString('en-IN', {
        day: '2-digit',
        month: 'short',
        year: 'numeric',
        timeZone: 'Asia/Kolkata',
      })
    : null

/** One reference: a label, the number, and its date under it. */
function RefCell({ label, value, sub }: { label: string; value: string; sub?: string | null }) {
  return (
    <div className="min-w-0">
      <p className="text-muted-foreground text-[10px] font-semibold uppercase tracking-wider">
        {label}
      </p>
      <p className="text-foreground truncate font-mono text-sm" title={value}>
        {value}
      </p>
      {sub && <p className="text-muted-foreground truncate text-[11px]">{sub}</p>}
    </div>
  )
}

interface Row {
  key: string
  billLineId: string
  warehouseId: string
  qty: string
  remarks: string
  /** Why this row is going back. Required — each row says its own. */
  reason: string
}

interface Warehouse {
  id: string
  name: string
}

let seq = 0
const nextKey = () => 'r' + ++seq

const num = (v: string) => {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}

const inr = (v: number) =>
  v.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

const today = () => {
  const d = new Date()
  const two = (n: number) => String(n).padStart(2, '0')
  return d.getFullYear() + '-' + two(d.getMonth() + 1) + '-' + two(d.getDate())
}

export function ReturnChallanDialog({
  billId,
  onClose,
  onSaved,
}: {
  billId: string
  onClose: () => void
  /** The message the server sent, and the challan's id so the caller can open it. */
  onSaved: (message: string, id: string) => void
}) {
  const [data, setData] = useState<Returnable | null>(null)
  const [warehouses, setWarehouses] = useState<Warehouse[]>([])
  const [rows, setRows] = useState<Row[]>([])

  const [returnDate, setReturnDate] = useState(today)
  const [reasonNote, setReasonNote] = useState('')
  const [vehicleNo, setVehicleNo] = useState('')
  const [transporterName, setTransporterName] = useState('')
  const [lrNumber, setLrNumber] = useState('')
  const [ewayBillNo, setEwayBillNo] = useState('')
  const [driverName, setDriverName] = useState('')

  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  /** The row a new reason is being added for, and what had been typed. */
  const [newReasonFor, setNewReasonFor] = useState<{ rowKey: string; typed: string } | null>(
    null
  )

  useEffect(() => {
    let alive = true
    Promise.all([
      api.get<{ data: Returnable }>('/purchase/returns/returnable/' + billId),
      masterResource<Warehouse>('warehouses').list({ limit: 200, active: true }),
    ])
      .then(([r, w]) => {
        if (!alive) return
        setData(r.data)
        setWarehouses(w.data)
        setRows(
          r.data.lines
            .filter((l) => l.remainingQty > 0)
            .map((l) => ({
              key: nextKey(),
              billLineId: l.billLineId,
              // Goods rejected on QC are in the reject godown now, and they
              // are what is most often going back — so start there.
              warehouseId:
                (l.qcRejectedQty > 0 ? l.qcWarehouseId : null) ??
                l.warehouseId ??
                w.data[0]?.id ??
                '',
              /*
               * What QC rejected and has not yet gone back, why, and the
               * checker's note — straight off the check. A line QC did not
               * reject, or rejected without saying why, starts empty: nothing
               * here is guessed.
               */
              qty: (() => {
                const left = Math.min(l.qcRejectedQty - l.adjustedQty, l.remainingQty)
                return l.qcRejectedQty > 0 && left > 0 ? String(Number(left.toFixed(3))) : ''
              })(),
              remarks: l.qcRejectedQty > 0 ? (l.qcReasonNote ?? '') : '',
              reason:
                l.qcRejectedQty > 0
                  ? (r.data.reasons.find(
                      (o) => o.custom && o.label === l.qcReasonName && o.code === l.qcReasonCode
                    )?.value ??
                    l.qcReasonCode ??
                    '')
                  : '',
            }))
        )
      })
      .catch((err) => {
        if (alive) setError(apiErrorMessage(err, 'Could not read that bill.'))
      })
      .finally(() => {
        if (alive) setLoading(false)
      })
    return () => {
      alive = false
    }
  }, [billId])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !saving) onClose()
    }
    document.addEventListener('keydown', onKey)
    const previous = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.removeEventListener('keydown', onKey)
      document.body.style.overflow = previous
    }
  }, [onClose, saving])

  const lineById = useMemo(() => new Map((data?.lines ?? []).map((l) => [l.billLineId, l])), [data])
  const reasonByKey = useMemo(
    () => new Map((data?.reasons ?? []).map((o) => [o.value, o])),
    [data]
  )

  const setRow = (key: string, patch: Partial<Row>) =>
    setRows((prev) => prev.map((r) => (r.key === key ? { ...r, ...patch } : r)))


  /*
   * A second row for the same bill line.
   *
   * Usually to give part of it another reason — of fifty rejected, thirty
   * damaged and twenty off-shade — so the copy stays on the same godown and
   * starts on the next reason not yet used there. Change the godown instead
   * when the goods are in two places. The server refuses only the same line,
   * godown and reason twice, which two rows could never mean.
   */
  const splitRow = (key: string) =>
    setRows((prev) => {
      const at = prev.findIndex((r) => r.key === key)
      if (at < 0) return prev
      const from = prev[at]
      const taken = new Set(
        prev
          .filter((r) => r.billLineId === from.billLineId && r.warehouseId === from.warehouseId)
          .map((r) => r.reason)
      )
      const next = data?.reasons.find((x) => !taken.has(x.value))?.value ?? ''
      const copy: Row = {
        key: nextKey(),
        billLineId: from.billLineId,
        warehouseId: from.warehouseId,
        qty: '',
        remarks: '',
        reason: next,
      }
      return [...prev.slice(0, at + 1), copy, ...prev.slice(at + 1)]
    })

  const dropRow = (key: string) => setRows((prev) => prev.filter((r) => r.key !== key))

  /** What is going back per bill line, across every row for it. */
  const goingByLine = useMemo(() => {
    const m = new Map<string, number>()
    for (const r of rows) m.set(r.billLineId, (m.get(r.billLineId) ?? 0) + num(r.qty))
    return m
  }, [rows])

  const going = rows.filter((r) => num(r.qty) > 0)

  const value = going.reduce((t, r) => {
    const l = lineById.get(r.billLineId)
    return t + (l ? num(r.qty) * l.billedRate : 0)
  }, 0)

  /*
   * What stops the save, said before the press rather than after it. The
   * server checks all of this again — these are here so the store keeper is
   * not sent back to a form that has lost the vehicle number they just typed.
   */
  const problems = useMemo(() => {
    const out: string[] = []
    if (going.length === 0) out.push('Enter what is going back on at least one line')
    for (const [billLineId, qty] of goingByLine) {
      const l = lineById.get(billLineId)
      if (l && qty > l.remainingQty + 0.0005) {
        out.push(`Only ${l.remainingQty} ${l.uom ?? ''} of ${l.itemName} can still go back`)
      }
    }
    if (going.some((r) => !r.warehouseId)) out.push('Every line needs the godown it leaves from')
    if (going.some((r) => !r.reason)) out.push('Say why each row is going back')
    const seen = new Set<string>()
    for (const r of going) {
      const k = r.billLineId + '::' + r.warehouseId + '::' + r.reason
      if (seen.has(k)) {
        out.push(
          `${lineById.get(r.billLineId)?.itemName ?? 'An item'} is on two rows with the same godown and reason — give one of them another reason`
        )
        break
      }
      seen.add(k)
    }
    return out
  }, [going, goingByLine, lineById])

  const save = async () => {
    if (problems.length || saving) return
    setSaving(true)
    setError(null)
    try {
      const res = await api.post<{ data: { id: string }; message: string }>('/purchase/returns', {
        billId,
        returnDate,
        reasonNote: reasonNote.trim() || null,
        vehicleNo: vehicleNo.trim() || null,
        transporterName: transporterName.trim() || null,
        lrNumber: lrNumber.trim() || null,
        ewayBillNo: ewayBillNo.trim() || null,
        driverName: driverName.trim() || null,
        lines: going.map((r) => ({
          billLineId: r.billLineId,
          warehouseId: r.warehouseId,
          qty: num(r.qty),
          remarks: r.remarks.trim() || null,
          // The built-in reason stock and the note go by, and the mill's
          // own name for it when it is one of theirs.
          reason: reasonByKey.get(r.reason)?.code,
          reasonLabel: reasonByKey.get(r.reason)?.custom
            ? reasonByKey.get(r.reason)?.label
            : null,
        })),
      })
      onSaved(res.message, res.data.id)
    } catch (err) {
      setError(apiErrorMessage(err))
    } finally {
      setSaving(false)
    }
  }

  const bill = data?.bill
  const nothingLeft = !loading && data && rows.length === 0

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-stretch justify-center bg-black/60 p-2 backdrop-blur-sm sm:left-[var(--sidebar-current-width)] sm:p-3">
      <div
        className="glass-card po-form flex h-full max-h-full w-full flex-col overflow-hidden"
        role="dialog"
        aria-modal="true"
        aria-labelledby="return-dialog-title"
      >
        <div className="border-border flex shrink-0 items-center justify-between gap-4 border-b px-5 py-3.5">
          <div className="flex min-w-0 items-center gap-3">
            <div className="bg-primary/10 border-primary/20 flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border">
              <PackageMinus size={19} className="text-primary" />
            </div>
            <div className="min-w-0">
              <h2
                id="return-dialog-title"
                className="text-foreground truncate text-xl font-semibold tracking-tight"
              >
                Return challan
              </h2>
              <p className="text-muted-foreground mt-0.5 truncate text-[13px]">
                {bill
                  ? `Goods going back to ${bill.supplier.name} against ${bill.billNumber}` +
                    (bill.supplierInvoiceNo ? ` (their bill ${bill.supplierInvoiceNo})` : '')
                  : 'Reading the bill…'}
              </p>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <button
              type="button"
              className="btn-primary"
              onClick={() => void save()}
              disabled={saving || loading || problems.length > 0}
            >
              {saving ? <Loader2 size={15} className="animate-spin" /> : <Truck size={15} />}
              <span className="hidden sm:inline">Save &amp; dispatch</span>
            </button>
            <button
              type="button"
              onClick={onClose}
              className="btn-ghost p-1.5"
              aria-label="Close"
              disabled={saving}
            >
              <X size={18} />
            </button>
          </div>
        </div>

        <div className="flex-1 space-y-2.5 overflow-y-auto px-5 py-3">
          <p className="text-muted-foreground text-[11px]">
            Saving takes the goods out of stock and prints as the gate pass. A draft debit note for
            the same goods is written for accounts to check and post.
          </p>

          {error && (
            <div className="flex items-start gap-3 rounded-lg border border-red-500/40 bg-red-500/5 p-3">
              <AlertCircle size={16} className="mt-0.5 shrink-0 text-red-400" />
              <p className="text-sm text-red-400">{error}</p>
            </div>
          )}

          {loading ? (
            <p className="text-muted-foreground flex items-center gap-2 py-10 text-sm">
              <Loader2 size={15} className="animate-spin" /> Reading what is left on the bill…
            </p>
          ) : nothingLeft ? (
            <div className="border-border/70 rounded-lg border border-dashed p-6 text-center">
              <p className="text-foreground text-sm">Nothing on {bill?.billNumber} can go back.</p>
              <p className="text-muted-foreground mt-1 text-xs">
                Every line is already on an earlier return or debit note.
              </p>
            </div>
          ) : (
            <>
              {/* ── What this return is against ──────────────────────────────
                  Every number the supplier and the gate will ask for, read off
                  the bill and the receipts behind it. Nothing to type. */}
              {bill && (
                <Section icon={FileText} title="References">
                  <div className="grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-3 lg:grid-cols-6">
                    <RefCell
                      label="Their invoice"
                      value={bill.supplierInvoiceNo || '—'}
                      sub={refDay(bill.supplierInvoiceDate)}
                    />
                    <RefCell
                      label="Our bill"
                      value={bill.billNumber}
                      sub={[
                        refDay(bill.billDate),
                        '₹' +
                          Number(bill.totalAmount).toLocaleString('en-IN', {
                            maximumFractionDigits: 2,
                          }),
                      ]
                        .filter(Boolean)
                        .join(' · ')}
                    />
                    <RefCell
                      label={(data?.references?.orders.length ?? 0) > 1 ? 'Purchase orders' : 'Purchase order'}
                      value={data?.references?.orders.map((o) => o.poNumber).join(', ') || '—'}
                      sub={
                        data?.references?.orders.length === 1
                          ? refDay(data.references.orders[0].poDate)
                          : null
                      }
                    />
                    <RefCell
                      label={(data?.references?.receipts.length ?? 0) > 1 ? 'Goods receipts' : 'Goods receipt'}
                      value={data?.references?.receipts.map((g) => g.grnNumber).join(', ') || '—'}
                      sub={
                        data?.references?.receipts.length === 1
                          ? refDay(data.references.receipts[0].grnDate)
                          : null
                      }
                    />
                    <RefCell
                      label="Their delivery challan"
                      value={
                        data?.references?.receipts
                          .map((g) => g.challanNo)
                          .filter(Boolean)
                          .join(', ') || '—'
                      }
                      sub={
                        data?.references?.receipts.length === 1
                          ? refDay(data.references.receipts[0].challanDate)
                          : null
                      }
                    />
                    <RefCell
                      label="Quality check"
                      value={(() => {
                        const checked = (data?.references?.receipts ?? []).filter((g) => g.qc)
                        if (!checked.length) return 'Not checked'
                        const rejected = checked.reduce((n, g) => n + (g.qc?.rejectedQty ?? 0), 0)
                        return rejected > 0 ? `${rejected} rejected` : 'Passed'
                      })()}
                      sub={(() => {
                        const g = (data?.references?.receipts ?? []).find((x) => x.qc)
                        return g?.qc ? 'on ' + refDay(g.qc.inspectionDate) : null
                      })()}
                    />
                  </div>
                  {(data?.references?.receipts ?? []).some((g) => g.gateEntryNo || g.vehicleNo) && (
                    <p className="text-muted-foreground mt-2 text-[11px]">
                      Came in on{' '}
                      {(data?.references?.receipts ?? [])
                        .map((g) =>
                          [
                            g.gateEntryNo && `gate entry ${g.gateEntryNo}`,
                            g.vehicleNo && `vehicle ${g.vehicleNo}`,
                          ]
                            .filter(Boolean)
                            .join(', ')
                        )
                        .filter(Boolean)
                        .join(' · ')}
                    </p>
                  )}
                </Section>
              )}

              {/* ── Why, and when ────────────────────────────────────────── */}
              <Section icon={MessageSquare} title="Return Details">
                {/* No reason here: each row below says why it is going back, and
                  one box for the whole challan only ever disagreed with them. */}
                <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2 lg:grid-cols-4">
                  <label className="block sm:col-span-1 lg:col-span-3">
                    <span className="form-label">What was wrong/Remarks</span>
                    <input
                      className="form-input"
                      value={reasonNote}
                      onChange={(e) => setReasonNote(e.target.value)}
                      placeholder="e.g. shade does not match the approved swatch"
                    />
                  </label>
                  <label className="block">
                    <span className="form-label">Return date</span>
                    <input
                      type="date"
                      className="form-input"
                      value={returnDate}
                      onChange={(e) => setReturnDate(e.target.value)}
                    />
                  </label>
                </div>
              </Section>

              {/* ── What is going ────────────────────────────────────────── */}
              <Section icon={Package} title="Items Going Back">
                {/* On a phone, one card per row — the same rows and handlers
                  as the table below, which a phone would have to drag
                  sideways to reach the quantity box. */}
                <div className="space-y-3 sm:hidden">
                  {rows.map((r, i) => {
                    const l = lineById.get(r.billLineId)
                    if (!l) return null
                    const first = rows.findIndex((x) => x.billLineId === r.billLineId) === i
                    const over = (goingByLine.get(r.billLineId) ?? 0) > l.remainingQty + 0.0005
                    const onHand =
                      r.warehouseId === l.warehouseId
                        ? l.onHand
                        : r.warehouseId === l.qcWarehouseId
                          ? l.qcOnHand
                          : null
                    const short = onHand != null && num(r.qty) > onHand + 0.0005
                    const fieldLabel =
                      'text-muted-foreground text-[10px] font-semibold uppercase tracking-wider'
                    return (
                      <div key={r.key} className="border-border bg-card rounded-lg border p-3">
                        <div className="flex items-start justify-between gap-2">
                          <div className="min-w-0">
                            <p className="text-foreground text-sm font-medium">
                              {l.itemName}
                              {!first && (
                                <span className="text-muted-foreground font-normal">
                                  {' '}
                                  — split
                                </span>
                              )}
                            </p>
                            <p className="text-muted-foreground font-mono text-[10px]">
                              {l.itemCode}
                              {l.hsnCode ? ' · HSN ' + l.hsnCode : ''} · ₹{inr(l.billedRate)}
                            </p>
                            {first && l.rejectedQty > 0 && (
                              <p className="warn-text text-[11px] font-semibold">
                                {l.rejectedQty} rejected at the gate
                              </p>
                            )}
                            {first && l.qcRejectedQty > 0 && (
                              <p className="warn-text text-[11px] font-semibold">
                                {l.qcRejectedQty} {l.uom ?? ''} rejected on QC
                                {l.qcWarehouseName ? ` — in ${l.qcWarehouseName}` : ''}
                              </p>
                            )}
                          </div>
                          <div className="flex shrink-0 items-center gap-1">
                            <button
                              type="button"
                              className="btn-ghost text-muted-foreground p-1"
                              onClick={() => splitRow(r.key)}
                              aria-label={`${l.itemName}: split into another row, for another reason or godown`}
                            >
                              <Plus size={14} />
                            </button>
                            {!first && (
                              <button
                                type="button"
                                className="btn-ghost text-muted-foreground p-1 hover:text-red-400"
                                onClick={() => dropRow(r.key)}
                                aria-label="Remove this row"
                              >
                                <Trash2 size={14} />
                              </button>
                            )}
                          </div>
                        </div>

                        {first && (
                          <div className="border-border/70 mt-2 grid grid-cols-2 gap-2 border-t pt-2 text-xs">
                            <div>
                              <p className={fieldLabel}>Billed</p>
                              <p className="tabular-nums">
                                {l.billedQty} {l.uom ?? ''}
                              </p>
                            </div>
                            <div>
                              <p className={fieldLabel}>Can go back</p>
                              <p className={`tabular-nums ${over ? 'text-red-400' : ''}`}>
                                {l.remainingQty} {l.uom ?? ''}
                              </p>
                            </div>
                          </div>
                        )}

                        <div className="mt-2 space-y-1">
                          <label className={fieldLabel}>From godown</label>
                          <SmartSelect
                            className="form-input h-9 w-full"
                            value={r.warehouseId}
                            onChange={(e) => setRow(r.key, { warehouseId: e.target.value })}
                            aria-label={`${l.itemName} leaves from`}
                          >
                            <option value="">Pick…</option>
                            {warehouses.map((w) => (
                              <option key={w.id} value={w.id}>
                                {w.name}
                              </option>
                            ))}
                          </SmartSelect>
                          <p
                            className={`text-[10px] ${short ? 'text-red-400' : 'text-muted-foreground'}`}
                          >
                            {onHand != null
                              ? `${onHand} ${l.uom ?? ''} in this godown`
                              : 'Stock is checked when you save'}
                          </p>
                        </div>

                        <div className="mt-2 space-y-1">
                          <label className={fieldLabel}>Reason</label>
                          <SmartSelect
                            className="form-input h-9 w-full"
                            value={r.reason}
                            onChange={(e) => setRow(r.key, { reason: e.target.value })}
                            onCreate={
                              can('masters', 'create')
                                ? (typed) => setNewReasonFor({ rowKey: r.key, typed })
                                : undefined
                            }
                            createNoun="reason"
                            aria-label={`Why ${l.itemName} is going back`}
                          >
                            <option value="">Pick…</option>
                            {data?.reasons.map((x) => (
                              <option key={x.value} value={x.value}>
                                {x.label}
                              </option>
                            ))}
                          </SmartSelect>
                        </div>

                        <div className="mt-2 grid grid-cols-2 gap-2">
                          <div className="space-y-1">
                            <label className={fieldLabel}>Qty going back</label>
                            <input
                              type="number"
                              step="any"
                              min={0}
                              inputMode="decimal"
                              className={`form-input h-9 w-full text-right ${
                                over || short ? 'border-red-500/60' : ''
                              }`}
                              placeholder="0"
                              value={r.qty}
                              onChange={(e) => setRow(r.key, { qty: e.target.value })}
                              aria-label={`${l.itemName} quantity going back`}
                            />
                          </div>
                          <div className="space-y-1">
                            <label className={fieldLabel}>Remark</label>
                            <input
                              className="form-input h-9 w-full"
                              value={r.remarks}
                              onChange={(e) => setRow(r.key, { remarks: e.target.value })}
                              placeholder="Optional"
                              aria-label={`${l.itemName} remark`}
                            />
                          </div>
                        </div>
                      </div>
                    )
                  })}
                </div>

                <div className="border-border bg-card hidden overflow-x-auto rounded-lg border sm:block">
                  <table className="w-full min-w-[1120px] table-fixed border-collapse text-sm">
                    <thead>
                      <tr className="bg-secondary">
                        {[
                          ['Item', 'w-60', 'left'],
                          ['Billed', 'w-24', 'right'],
                          ['Can go back', 'w-28', 'right'],
                          ['From godown', 'w-44', 'left'],
                          ['In godown', 'w-24', 'right'],
                          ['Qty going back', 'w-28', 'right'],
                          ['Reason', 'w-44', 'left'],
                          ['Remark', 'w-40', 'left'],
                          ['', 'w-16', 'left'],
                        ].map(([label, width, align], i) => (
                          <th
                            key={label + i}
                            className={`${width} border-border text-muted-foreground border-b px-2 py-1.5 text-[10px] font-semibold uppercase tracking-wider ${
                              align === 'right' ? 'text-right' : 'text-left'
                            }`}
                          >
                            {label}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((r, i) => {
                        const l = lineById.get(r.billLineId)
                        if (!l) return null
                        const first = rows.findIndex((x) => x.billLineId === r.billLineId) === i
                        const over = (goingByLine.get(r.billLineId) ?? 0) > l.remainingQty + 0.0005
                        // The stock figure is only known for the godown the
                        // receipt named; for any other the server says so on
                        // save, in words, if the rack is short.
                        const onHand =
                          r.warehouseId === l.warehouseId
                            ? l.onHand
                            : r.warehouseId === l.qcWarehouseId
                              ? l.qcOnHand
                              : null
                        const short = onHand != null && num(r.qty) > onHand + 0.0005
                        return (
                          <tr
                            key={r.key}
                            className={`border-border/50 border-b last:border-0 [&>td]:px-2 [&>td]:py-1.5 [&>td]:align-top ${
                              i % 2 ? 'zebra-row' : ''
                            }`}
                          >
                            <td>
                              {first ? (
                                <>
                                  <p className="text-foreground truncate font-medium">
                                    {l.itemName}
                                  </p>
                                  <p className="text-muted-foreground font-mono text-[10px]">
                                    {l.itemCode}
                                    {l.hsnCode ? ' · HSN ' + l.hsnCode : ''} · ₹{inr(l.billedRate)}
                                    {l.rejectedQty > 0 && (
                                      <span className="warn-text font-semibold">
                                        {' '}
                                        · {l.rejectedQty} rejected at the gate
                                      </span>
                                    )}
                                    {l.qcRejectedQty > 0 && (
                                      <span className="warn-text font-semibold">
                                        {' '}
                                        · {l.qcRejectedQty} rejected on QC
                                        {l.qcWarehouseName ? ` (in ${l.qcWarehouseName})` : ''}
                                      </span>
                                    )}
                                  </p>
                                </>
                              ) : (
                                <p className="text-muted-foreground pt-2 text-xs">
                                  {l.itemName} — split
                                </p>
                              )}
                            </td>
                            <td className="text-muted-foreground whitespace-nowrap pt-2.5 text-right text-xs tabular-nums">
                              {first ? `${l.billedQty} ${l.uom ?? ''}` : ''}
                            </td>
                            <td
                              className={`whitespace-nowrap pt-2.5 text-right text-xs tabular-nums ${
                                over ? 'text-red-400' : 'text-foreground'
                              }`}
                            >
                              {first ? `${l.remainingQty} ${l.uom ?? ''}` : ''}
                            </td>
                            <td>
                              <SmartSelect
                                className="form-input h-8 text-xs"
                                value={r.warehouseId}
                                onChange={(e) => setRow(r.key, { warehouseId: e.target.value })}
                                aria-label={`${l.itemName} leaves from`}
                              >
                                <option value="">Pick…</option>
                                {warehouses.map((w) => (
                                  <option key={w.id} value={w.id}>
                                    {w.name}
                                  </option>
                                ))}
                              </SmartSelect>
                            </td>
                            <td
                              className={`whitespace-nowrap pt-2.5 text-right text-xs tabular-nums ${
                                short ? 'text-red-400' : 'text-muted-foreground'
                              }`}
                            >
                              {onHand != null ? `${onHand} ${l.uom ?? ''}` : '—'}
                            </td>
                            <td>
                              <input
                                type="number"
                                step="any"
                                min={0}
                                className={`form-input h-8 text-right text-xs ${
                                  over || short ? 'border-red-500/60' : ''
                                }`}
                                placeholder="0"
                                value={r.qty}
                                onChange={(e) => setRow(r.key, { qty: e.target.value })}
                                aria-label={`${l.itemName} quantity going back`}
                              />
                            </td>
                            <td>
                              <SmartSelect
                                className={`form-input h-8 text-xs ${
                                  num(r.qty) > 0 && !r.reason ? 'border-red-500/60' : ''
                                }`}
                                value={r.reason}
                                onChange={(e) => setRow(r.key, { reason: e.target.value })}
                                onCreate={
                                  can('masters', 'create')
                                    ? (typed) => setNewReasonFor({ rowKey: r.key, typed })
                                    : undefined
                                }
                                createNoun="reason"
                                aria-label={`Why ${l.itemName} is going back`}
                              >
                                <option value="">Pick…</option>
                                {data?.reasons.map((x) => (
                                  <option key={x.value} value={x.value}>
                                    {x.label}
                                  </option>
                                ))}
                              </SmartSelect>
                            </td>
                            <td>
                              <input
                                className="form-input h-8 text-xs"
                                value={r.remarks}
                                onChange={(e) => setRow(r.key, { remarks: e.target.value })}
                                placeholder="Optional"
                                aria-label={`${l.itemName} remark`}
                              />
                            </td>
                            <td>
                              <div className="flex h-8 items-center gap-1">
                                <button
                                  type="button"
                                  className="btn-ghost text-muted-foreground p-1"
                                  onClick={() => splitRow(r.key)}
                                  title="Split into another row — for another reason, or from another godown"
                                  aria-label={`${l.itemName}: split into another row`}
                                >
                                  <Plus size={13} />
                                </button>
                                {!first && (
                                  <button
                                    type="button"
                                    className="btn-ghost text-muted-foreground p-1 hover:text-red-400"
                                    onClick={() => dropRow(r.key)}
                                    aria-label="Remove this row"
                                  >
                                    <Trash2 size={13} />
                                  </button>
                                )}
                              </div>
                            </td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>
              </Section>

              {/* ── How it is going ──────────────────────────────────────── */}
              <Section icon={Truck} title="Transport">
                <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2 lg:grid-cols-5">
                  {(
                    [
                      ['Vehicle number', vehicleNo, setVehicleNo, 'MH 04 AB 1234'],
                      ['Transporter', transporterName, setTransporterName, ''],
                      ['LR number', lrNumber, setLrNumber, ''],
                      ['E-way bill no.', ewayBillNo, setEwayBillNo, 'Needed above ₹50,000'],
                      ['Driver', driverName, setDriverName, ''],
                    ] as const
                  ).map(([label, value, set, placeholder]) => (
                    <label key={label} className="block">
                      <span className="form-label">{label}</span>
                      <input
                        className="form-input"
                        value={value}
                        onChange={(e) => set(e.target.value)}
                        placeholder={placeholder}
                      />
                    </label>
                  ))}
                </div>
              </Section>
            </>
          )}
        </div>

        <div className="border-border flex shrink-0 flex-wrap items-center justify-between gap-3 border-t px-5 py-3">
          <div className="text-xs">
            <p className="text-muted-foreground">Value going back, at the bill&rsquo;s rates</p>
            <p className="text-foreground text-base font-semibold tabular-nums">
              ₹{inr(value)}
              <span className="text-muted-foreground ml-1.5 text-[11px] font-normal">
                before tax
              </span>
            </p>
          </div>
          <div className="flex items-center gap-3">
            {problems.length > 0 && !loading && (
              <span className="text-muted-foreground hidden text-xs md:inline">{problems[0]}</span>
            )}
            <button type="button" className="btn-secondary" onClick={onClose} disabled={saving}>
              Cancel
            </button>
            <button
              type="button"
              className="btn-primary"
              onClick={() => void save()}
              disabled={saving || loading || problems.length > 0}
            >
              {saving ? <Loader2 size={15} className="animate-spin" /> : <Truck size={15} />}
              Save &amp; dispatch
            </button>
          </div>
        </div>
      </div>

      {/* One of the mill's own reasons, added without leaving the form. It goes
        into Masters → Dropdown Lists, where it can be renamed or switched off. */}
      <MasterFormDialog<{ id: string; label: string; behavesAs: string | null }>
        open={newReasonFor !== null}
        onClose={() => setNewReasonFor(null)}
        onSaved={() => {}}
        onCreated={(row) => {
          const option = optionFromCreated(row)
          setData((prev) => (prev ? { ...prev, reasons: [...prev.reasons, option] } : prev))
          if (newReasonFor) setRow(newReasonFor.rowKey, { reason: option.value })
        }}
        resource="dropdown-values"
        fields={returnReasonFields}
        initialValues={newReasonFor?.typed ? { label: newReasonFor.typed } : undefined}
        title="Return reason"
        stacked
      />
    </div>,
    document.body
  )
}
