'use client'

import { useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  AlertCircle,
  Loader2,
  MessageSquare,
  Package,
  PackageMinus,
  Plus,
  Trash2,
  Truck,
  X,
} from 'lucide-react'
import { api, apiErrorMessage, masterResource } from '@/lib/api'
import { Section } from '@/components/purchase/Section'

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
}

interface Returnable {
  bill: {
    id: string
    billNumber: string
    supplierInvoiceNo: string | null
    billDate: string
    status: string
    supplier: { id: string; code: string; name: string; gstin: string | null }
  }
  lines: ReturnableLine[]
  reasons: Array<{ value: string; label: string; hint: string }>
}

interface Row {
  key: string
  billLineId: string
  warehouseId: string
  qty: string
  remarks: string
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
  const [reason, setReason] = useState('')
  const [reasonNote, setReasonNote] = useState('')
  const [vehicleNo, setVehicleNo] = useState('')
  const [transporterName, setTransporterName] = useState('')
  const [lrNumber, setLrNumber] = useState('')
  const [ewayBillNo, setEwayBillNo] = useState('')
  const [driverName, setDriverName] = useState('')
  const [remarks, setRemarks] = useState('')

  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

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
              warehouseId: l.warehouseId ?? w.data[0]?.id ?? '',
              qty: '',
              remarks: '',
            }))
        )
        // Rejected at the gate is the commonest reason a return is written,
        // and when the bill carries a rejection it is almost always the
        // reason for this one. Suggested, never forced.
        if (r.data.lines.some((l) => l.rejectedQty > l.adjustedQty)) setReason('QUALITY_REJECTION')
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

  const setRow = (key: string, patch: Partial<Row>) =>
    setRows((prev) => prev.map((r) => (r.key === key ? { ...r, ...patch } : r)))

  /*
   * A second row for the same bill line, from another godown.
   *
   * One delivery is routinely split across two stores, and the goods go back
   * from wherever they are. The server refuses the same line from the same
   * godown twice, so the copy starts on a different one where there is one.
   */
  const splitRow = (key: string) =>
    setRows((prev) => {
      const at = prev.findIndex((r) => r.key === key)
      if (at < 0) return prev
      const used = new Set(
        prev.filter((r) => r.billLineId === prev[at].billLineId).map((r) => r.warehouseId)
      )
      const other = warehouses.find((w) => !used.has(w.id))?.id ?? prev[at].warehouseId
      const copy: Row = {
        key: nextKey(),
        billLineId: prev[at].billLineId,
        warehouseId: other,
        qty: '',
        remarks: '',
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
    if (!reason) out.push('Say why the goods are going back')
    if (going.length === 0) out.push('Enter what is going back on at least one line')
    for (const [billLineId, qty] of goingByLine) {
      const l = lineById.get(billLineId)
      if (l && qty > l.remainingQty + 0.0005) {
        out.push(`Only ${l.remainingQty} ${l.uom ?? ''} of ${l.itemName} can still go back`)
      }
    }
    if (going.some((r) => !r.warehouseId)) out.push('Every line needs the godown it leaves from')
    return out
  }, [reason, going, goingByLine, lineById])

  const save = async () => {
    if (problems.length || saving) return
    setSaving(true)
    setError(null)
    try {
      const res = await api.post<{ data: { id: string }; message: string }>('/purchase/returns', {
        billId,
        returnDate,
        reason,
        reasonNote: reasonNote.trim() || null,
        vehicleNo: vehicleNo.trim() || null,
        transporterName: transporterName.trim() || null,
        lrNumber: lrNumber.trim() || null,
        ewayBillNo: ewayBillNo.trim() || null,
        driverName: driverName.trim() || null,
        remarks: remarks.trim() || null,
        lines: going.map((r) => ({
          billLineId: r.billLineId,
          warehouseId: r.warehouseId,
          qty: num(r.qty),
          remarks: r.remarks.trim() || null,
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
              {/* ── Why, and when ────────────────────────────────────────── */}
              <Section icon={MessageSquare} title="Return Details">
                <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2 lg:grid-cols-4">
                  <label className="block">
                    <span className="form-label">
                      Reason<span className="ml-0.5 text-red-400">*</span>
                    </span>
                    <select
                      className="form-input"
                      value={reason}
                      onChange={(e) => setReason(e.target.value)}
                    >
                      <option value="">Pick one…</option>
                      {data?.reasons.map((r) => (
                        <option key={r.value} value={r.value}>
                          {r.label}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="block lg:col-span-2">
                    <span className="form-label">What was wrong</span>
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
                <div className="border-border bg-card overflow-x-auto rounded-lg border">
                  <table className="w-full min-w-[980px] table-fixed border-collapse text-sm">
                    <thead>
                      <tr className="bg-secondary">
                        {[
                          ['Item', 'w-64', 'left'],
                          ['Billed', 'w-24', 'right'],
                          ['Can go back', 'w-28', 'right'],
                          ['From godown', 'w-44', 'left'],
                          ['In godown', 'w-24', 'right'],
                          ['Qty going back', 'w-32', 'right'],
                          ['Remark', 'w-44', 'left'],
                          ['', 'w-20', 'left'],
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
                        const onHand = r.warehouseId === l.warehouseId ? l.onHand : null
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
                                      <span className="text-amber-500">
                                        {' '}
                                        · {l.rejectedQty} rejected at the gate
                                      </span>
                                    )}
                                  </p>
                                </>
                              ) : (
                                <p className="text-muted-foreground pt-2 text-xs">
                                  {l.itemName} — from another godown
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
                              <select
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
                              </select>
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
                                  title="Also send some back from another godown"
                                  aria-label={`${l.itemName}: add another godown`}
                                >
                                  <Plus size={13} />
                                </button>
                                {!first && (
                                  <button
                                    type="button"
                                    className="btn-ghost text-muted-foreground p-1 hover:text-red-400"
                                    onClick={() => dropRow(r.key)}
                                    aria-label="Remove this godown row"
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
                  <label className="block sm:col-span-2 lg:col-span-5">
                    <span className="form-label">Remarks</span>
                    <input
                      className="form-input"
                      value={remarks}
                      onChange={(e) => setRemarks(e.target.value)}
                      placeholder="Printed on the challan"
                    />
                  </label>
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
    </div>,
    document.body
  )
}
