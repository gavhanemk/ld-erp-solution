'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { X, Loader2, AlertCircle, Plus, Trash2, Download, TriangleAlert } from 'lucide-react'
import { api, ApiError, masterResource, type Paginated } from '@/lib/api'

export interface BillLine {
  itemId: string
  grnLineId?: string | null
  description?: string | null
  qty: number | string
  unitPrice: number | string
  discount: number | string
  gstRate: number | string
  /** Only set when the line came from a receipt — drives the variance notes. */
  acceptedQty?: number
  pendingQty?: number
  orderedRate?: number
  /**
   * What to do about a rate that does not match the order. Only ever set on a
   * line where the two actually differ; the API refuses the bill until every
   * such line carries one.
   */
  rateAction?: 'ACCEPT' | 'DEBIT_NOTE' | null
  grnNumber?: string
}

export interface BillCharge {
  chargeTypeId: string
  amount: number | string
  gstRate: number | string
}

/** A file hanging off an order or a receipt. The bill itself holds none. */
export interface BillAttachment {
  id: string
  fileName: string
  mimeType: string | null
  sizeBytes: number
  createdAt: string
}

export interface PurchaseBill {
  id: string
  billNumber: string
  supplierId: string
  poId: string | null
  supplierInvoiceNo: string | null
  supplierInvoiceDate: string | null
  billDate: string
  dueDate: string | null
  subtotal: string | number
  discountAmount: string | number
  taxableAmount: string | number
  cgst: string | number
  sgst: string | number
  igst: string | number
  tdsSection: string | null
  tdsRate: string | number | null
  tdsAmount: string | number
  isReverseCharge: boolean
  roundOff: string | number
  totalAmount: string | number
  paidAmount: string | number
  balanceAmount: string | number
  status: string
  notes: string | null
  supplier?: { id: string; name: string; code: string; gstin: string | null; stateCode: string | null; isMsme?: boolean; creditDays?: number }
  po?: { id: string; poNumber: string; attachments?: BillAttachment[] } | null
  createdBy?: { id: string; name: string } | null
  createdAt?: string
  lines?: Array<
    BillLine & {
      id: string
      item?: { id: string; code: string; name: string; hsnCode: string | null; uom?: { symbol: string } | null }
      hsnCode?: string | null
      taxableValue?: string | number
      cgst?: string | number
      sgst?: string | number
      igst?: string | number
      amount?: string | number
      grnLine?: {
        id: string
        acceptedQty: string
        unitRate?: string | number
        grn: { id: string; grnNumber: string; attachments?: BillAttachment[] }
      } | null
    }
  >
  charges?: Array<
    BillCharge & {
      id: string
      chargeType?: { id: string; name: string } | null
      cgst?: string | number
      sgst?: string | number
      igst?: string | number
    }
  >
  payments?: Array<{
    id: string
    paymentNumber: string
    paymentDate: string
    amount: string | number
    mode: string
    referenceNo: string | null
    chequeDate: string | null
    createdBy?: { id: string; name: string } | null
  }>
  debitNotes?: Array<{
    id: string
    noteNumber: string
    noteDate: string
    reason: string | null
    subtotal: string | number
    totalAmount: string | number
    status: string
  }>
}

interface Option {
  id: string
  code?: string
  name: string
  gstin?: string | null
  stateCode?: string | null
  hsnCode?: string | null
  standardRate?: string | number | null
  taxRate?: { rate: string | number } | null
  uom?: { symbol: string } | null
  defaultGstRate?: string | number | null
  applyOnPurchase?: boolean
  /** Payment to an MSME supplier falls due within 45 days by law. */
  isMsme?: boolean
}

interface GrnOption {
  id: string
  grnNumber: string
  status: string
  /**
   * Shaped exactly as `/purchase/grn` returns it — the supplier arrives
   * nested inside the order, not flattened onto it.
   *
   * This was written as `supplierId` once, which is not a field the API has
   * ever sent. Nothing failed loudly: the filter below read `undefined`,
   * compared it against the chosen supplier, and quietly offered no receipts
   * at all, so a bill could never be started from one.
   */
  po?: {
    id: string
    poNumber: string
    supplier?: { id: string; name: string; code?: string } | null
  } | null
}

const emptyLine = (): BillLine => ({
  itemId: '',
  grnLineId: null,
  qty: '',
  unitPrice: '',
  discount: '0',
  gstRate: '',
})

const num = (v: unknown) => {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}

const inr = (v: number) =>
  v.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

export function PurchaseBillDialog({
  open,
  onClose,
  onSaved,
  record,
  initialGrnId,
}: {
  open: boolean
  onClose: () => void
  onSaved: () => void
  record?: PurchaseBill | null
  /**
   * A receipt to gather onto the bill the moment the form opens, for the
   * "Book a bill for this" shortcut on the goods receipt screen.
   *
   * The old ERP put an "Add Bill From GRN" button beside every receipt, which
   * is how the accounts team thinks about it — the receipt is on the desk and
   * the bill is raised against it. Reaching the same place by opening Bills,
   * pressing Book Bill, picking the supplier and then finding the receipt is
   * four steps to arrive where the button already was.
   */
  initialGrnId?: string | null
}) {
  const isEdit = Boolean(record)

  const [suppliers, setSuppliers] = useState<Option[]>([])
  const [items, setItems] = useState<Option[]>([])
  const [chargeTypes, setChargeTypes] = useState<Option[]>([])
  const [grns, setGrns] = useState<GrnOption[]>([])
  const [companyState, setCompanyState] = useState<string | null>(null)

  const [supplierId, setSupplierId] = useState('')
  const [poId, setPoId] = useState<string | null>(null)
  const [supplierInvoiceNo, setSupplierInvoiceNo] = useState('')
  const [supplierInvoiceDate, setSupplierInvoiceDate] = useState('')
  const [billDate, setBillDate] = useState(() => new Date().toISOString().slice(0, 10))
  const [dueDate, setDueDate] = useState('')
  const [discountAmount, setDiscountAmount] = useState('')
  const [isReverseCharge, setIsReverseCharge] = useState(false)
  const [tdsSection, setTdsSection] = useState('')
  const [tdsRate, setTdsRate] = useState('')
  const [notes, setNotes] = useState('')
  /** Why a rate above the order was agreed. Asked for once, not per line. */
  const [rateVarianceReason, setRateVarianceReason] = useState('')
  const [lines, setLines] = useState<BillLine[]>([emptyLine()])
  const [charges, setCharges] = useState<BillCharge[]>([])

  const [pullGrnId, setPullGrnId] = useState('')
  const [pulling, setPulling] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    setSupplierId(record?.supplierId ?? '')
    setPoId(record?.poId ?? null)
    setSupplierInvoiceNo(record?.supplierInvoiceNo ?? '')
    setSupplierInvoiceDate(record?.supplierInvoiceDate?.slice(0, 10) ?? '')
    setBillDate((record?.billDate ?? new Date().toISOString()).slice(0, 10))
    setDueDate(record?.dueDate?.slice(0, 10) ?? '')
    setDiscountAmount(num(record?.discountAmount) > 0 ? String(record?.discountAmount) : '')
    setIsReverseCharge(record?.isReverseCharge ?? false)
    setTdsSection(record?.tdsSection ?? '')
    setTdsRate(num(record?.tdsRate) > 0 ? String(record?.tdsRate) : '')
    setNotes(record?.notes ?? '')
    setRateVarianceReason('')
    setLines(
      record?.lines?.length
        ? record.lines.map((l) => ({
            itemId: l.itemId,
            grnLineId: l.grnLineId ?? null,
            description: l.description ?? '',
            qty: String(l.qty),
            unitPrice: String(l.unitPrice),
            discount: String(l.discount ?? 0),
            gstRate: String(l.gstRate ?? ''),
            acceptedQty: l.grnLine ? num(l.grnLine.acceptedQty) : undefined,
            grnNumber: l.grnLine?.grn?.grnNumber,
          }))
        : [emptyLine()],
    )
    setCharges(
      record?.charges?.map((c) => ({
        chargeTypeId: c.chargeTypeId,
        amount: String(c.amount),
        gstRate: String(c.gstRate ?? ''),
      })) ?? [],
    )
    setPullGrnId('')
    setError(null)
  }, [open, record])

  /*
   * Gathers the receipt the shortcut arrived with, once and once only.
   *
   * Waits for the receipt list to load, because the picker below is driven by
   * it and a bill that filled itself in while the box beside it still read
   * "choose a receipt" would look broken. The ref stops a re-render pulling
   * the same receipt twice, which the form would rightly refuse as a
   * duplicate.
   */
  const autoPulled = useRef<string | null>(null)
  useEffect(() => {
    if (!open || record || !initialGrnId) return
    if (autoPulled.current === initialGrnId) return
    if (!grns.length) return

    autoPulled.current = initialGrnId
    setPullGrnId(initialGrnId)
  }, [open, record, initialGrnId, grns])

  useEffect(() => {
    if (!open) autoPulled.current = null
  }, [open])

  // Separated from setting the id above so the pull runs with `pullGrnId`
  // already committed — `pullFromGrn` reads it rather than taking an argument.
  useEffect(() => {
    if (!open || record || !initialGrnId) return
    if (pullGrnId !== initialGrnId) return
    if (lines.some((l) => l.grnLineId)) return
    void pullFromGrn()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pullGrnId])

  useEffect(() => {
    if (!open) return
    let cancelled = false

    void Promise.all([
      masterResource<Option>('suppliers').list({ limit: 500, active: true }),
      masterResource<Option>('items').list({ limit: 500, active: true }),
      masterResource<Option>('charge-types').list({ limit: 100, active: true }).catch(() => null),
      api
        .get<{ success: boolean; data: { stateCode: string | null } }>('/settings/company')
        .catch(() => null),
      api.get<Paginated<GrnOption>>('/purchase/grn?limit=200').catch(() => null),
    ]).then(([s, i, c, co, g]) => {
      if (cancelled) return
      setSuppliers((s as Paginated<Option>).data)
      setItems((i as Paginated<Option>).data)
      // The charge master may have no screen yet; a bill without freight is
      // still a bill, so this degrades rather than breaking the form.
      setChargeTypes(
        c ? (c as Paginated<Option>).data.filter((x) => x.applyOnPurchase !== false) : [],
      )
      setCompanyState(co?.data?.stateCode ?? null)
      setGrns(g?.data ?? [])
    })

    return () => {
      cancelled = true
    }
  }, [open])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    const previous = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.removeEventListener('keydown', onKey)
      document.body.style.overflow = previous
    }
  }, [open, onClose])

  const itemById = useMemo(() => new Map(items.map((i) => [i.id, i])), [items])
  const chargeById = useMemo(() => new Map(chargeTypes.map((c) => [c.id, c])), [chargeTypes])
  const supplier = suppliers.find((s) => s.id === supplierId)

  // Receipts worth offering: this supplier's, and not cancelled. A cancelled
  // receipt is refused by the API anyway, so offering it would only waste a
  // save.
  const pullable = useMemo(
    () =>
      grns.filter(
        (g) => g.status !== 'CANCELLED' && (!supplierId || g.po?.supplier?.id === supplierId),
      ),
    [grns, supplierId],
  )

  /**
   * The receipts already gathered onto this bill, in order, without repeats.
   *
   * Drives the wording around the picker: the box has to say whether pressing
   * it starts the bill or adds to it, and somebody halfway through gathering a
   * week of deliveries needs to see which ones are already on.
   */
  const billedReceipts = useMemo(
    () => [...new Set(lines.map((l) => l.grnNumber).filter(Boolean))] as string[],
    [lines],
  )

  const taxMode = !supplier
    ? null
    : !supplier.gstin && !isReverseCharge
      ? 'NONE'
      : (supplier.stateCode ?? supplier.gstin?.slice(0, 2)) === companyState
        ? 'CGST_SGST'
        : 'IGST'

  /** Mirrors priceBill on the API, so the screen and the saved bill agree. */
  const totals = useMemo(() => {
    const lineGross = lines.map((l) => num(l.qty) * num(l.unitPrice) * (1 - num(l.discount) / 100))
    const subtotal = lineGross.reduce((s, n) => s + n, 0)
    const discount = Math.min(num(discountAmount), subtotal)
    const goodsTaxable = subtotal - discount
    const factor = subtotal > 0 ? goodsTaxable / subtotal : 1

    const chargeTotal = charges.reduce((s, c) => s + num(c.amount), 0)
    const taxable = goodsTaxable + chargeTotal

    const taxable0 = taxMode === 'NONE' ? 0 : 1
    const lineTax = lines.reduce(
      (s, l, i) => s + lineGross[i] * factor * (num(l.gstRate) / 100) * taxable0,
      0,
    )
    const chargeTax = charges.reduce((s, c) => s + num(c.amount) * (num(c.gstRate) / 100) * taxable0, 0)
    const tax = lineTax + chargeTax

    // Under reverse charge the supplier bills no tax; we owe it to the
    // government, so it must not swell what they are paid.
    const payable = isReverseCharge ? taxable : taxable + tax
    const total = Math.round(payable)
    const tds = taxable * (num(tdsRate) / 100)

    return {
      lineGross,
      subtotal,
      discount,
      taxable,
      chargeTotal,
      tax,
      roundOff: total - payable,
      total,
      tds,
      balance: total - tds,
    }
  }, [lines, charges, discountAmount, taxMode, isReverseCharge, tdsRate])

  if (!open) return null

  const setLine = (index: number, patch: Partial<BillLine>) =>
    setLines((prev) => prev.map((l, i) => (i === index ? { ...l, ...patch } : l)))

  /**
   * Clears a rate decision the moment the rate it was made about changes.
   *
   * Somebody who picks "book at the order's rate" and then retypes the rate
   * is answering a different question, and carrying the old answer forward
   * would raise a debit note for a difference nobody is looking at any more.
   */
  const setLineRate = (index: number, unitPrice: string) =>
    setLine(index, { unitPrice, rateAction: null })

  const pickItem = (index: number, itemId: string) => {
    const item = itemById.get(itemId)
    setLine(index, {
      itemId,
      // A manually added line is not matched to a receipt.
      grnLineId: null,
      acceptedQty: undefined,
      pendingQty: undefined,
      orderedRate: undefined,
      grnNumber: undefined,
      unitPrice:
        lines[index].unitPrice || (item?.standardRate != null ? String(item.standardRate) : ''),
      gstRate: lines[index].gstRate || (item?.taxRate ? String(item.taxRate.rate) : ''),
    })
  }

  /**
   * Adds a receipt's lines to the bill, so nobody retypes what they already
   * entered.
   *
   * Adds rather than replaces, and can be pressed again for another receipt.
   * Suppliers routinely bill a week of deliveries on one invoice, the mill's
   * old ERP let you tick several receipts and press Create Bill, and Mahesh
   * asked for that from day one — so a bill covers as many receipts as it
   * needs to. The three-way match already worked this way: it sums what has
   * been billed against each receipt line, from every bill, so nothing is
   * claimed twice however the lines were gathered.
   *
   * Two things are refused. A receipt from a different supplier, because a
   * bill is somebody's demand for money and it comes from one of them. And a
   * receipt already on this bill, which would double the quantity.
   */
  const pullFromGrn = async () => {
    if (!pullGrnId) return
    setPulling(true)
    setError(null)
    try {
      const res = await api.get<{
        success: boolean
        data: {
          grn: { grnNumber: string }
          po: { id: string; poNumber: string; supplier: { id: string } }
          lines: Array<{
            grnLineId: string
            item: { id: string; name: string }
            acceptedQty: number
            billedQty: number
            pendingQty: number
            orderedRate: number
            gstRate: number
          }>
        }
      }>(`/purchase/bills/match/${pullGrnId}`)

      const d = res.data
      const open = d.lines.filter((l) => l.pendingQty > 0)

      if (!open.length) {
        setError(
          `Everything on ${d.grn.grnNumber} has already been billed. Pick another receipt, or add the lines by hand.`,
        )
        return
      }

      const existing = lines.filter((l) => l.grnLineId)

      if (existing.length && supplierId && supplierId !== d.po.supplier.id) {
        setError(
          `${d.grn.grnNumber} is from a different supplier. One bill is one supplier's demand for money — start a separate bill for it.`,
        )
        return
      }

      const already = new Set(existing.map((l) => l.grnLineId))
      const fresh = open.filter((l) => !already.has(l.grnLineId))

      if (!fresh.length) {
        setError(`${d.grn.grnNumber} is already on this bill.`)
        return
      }

      setSupplierId(d.po.supplier.id)

      /*
       * The order link only survives while the bill is about one order.
       *
       * Once receipts from two orders are on it the header cannot honestly
       * name one, and naming the first would make the bill look like it
       * settles an order it only half touches. The lines still carry their
       * receipt, and the receipt still carries its order, so nothing is lost
       * — it is only the shortcut at the top that goes.
       */
      setPoId((prev) => (!prev || prev === d.po.id ? d.po.id : ''))

      const pulled = fresh.map((l) => ({
        itemId: l.item.id,
        grnLineId: l.grnLineId,
        description: '',
        qty: String(l.pendingQty),
        unitPrice: String(l.orderedRate),
        discount: '0',
        gstRate: String(l.gstRate),
        acceptedQty: l.acceptedQty,
        pendingQty: l.pendingQty,
        orderedRate: l.orderedRate,
        grnNumber: d.grn.grnNumber,
      }))

      /*
       * Blank rows typed before the first pull are dropped, and only then.
       * A new bill opens with one empty line and keeping it would leave a row
       * with no item on a bill somebody is about to save.
       */
      setLines((prev) => {
        const keep = prev.filter((l) => l.grnLineId || l.itemId)
        return [...keep, ...pulled]
      })

      // Cleared so the next receipt is a deliberate choice rather than a
      // second press of the same one.
      setPullGrnId('')
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not read that goods receipt.')
    } finally {
      setPulling(false)
    }
  }

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setSaving(true)
    setError(null)

    const payload = {
      supplierId,
      poId: poId || null,
      supplierInvoiceNo: supplierInvoiceNo.trim(),
      supplierInvoiceDate,
      billDate,
      dueDate: dueDate || null,
      discountAmount: num(discountAmount),
      isReverseCharge,
      tdsSection: tdsSection.trim() || null,
      tdsRate: num(tdsRate) || null,
      notes: notes.trim() || null,
      lines: lines.map((l) => ({
        itemId: l.itemId,
        grnLineId: l.grnLineId || null,
        description: (l.description as string)?.trim() || null,
        qty: num(l.qty),
        unitPrice: num(l.unitPrice),
        discount: num(l.discount),
        gstRate: num(l.gstRate),
        rateAction: l.rateAction ?? null,
      })),
      rateVarianceReason: rateVarianceReason.trim() || null,
      charges: charges
        .filter((c) => c.chargeTypeId && num(c.amount) > 0)
        .map((c) => ({
          chargeTypeId: c.chargeTypeId,
          amount: num(c.amount),
          gstRate: num(c.gstRate),
        })),
    }

    try {
      if (isEdit && record) {
        await api.patch(`/purchase/bills/${record.id}`, payload)
      } else {
        await api.post('/purchase/bills', payload)
      }
      onSaved()
      onClose()
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save. Is the API running?')
    } finally {
      setSaving(false)
    }
  }

  // Over-billing is shown but not blocked here — the API refuses it, and its
  // message says exactly how much is left on which receipt. A rate mismatch
  // does block, because the answer is a choice only a person can make.
  const overBilled = lines.filter((l) => l.pendingQty != null && num(l.qty) > l.pendingQty)
  const rateDrift = lines.filter(
    (l) => l.orderedRate != null && Math.abs(num(l.unitPrice) - l.orderedRate) > 0.005,
  )

  /** Every mismatch has to be answered — the API refuses the bill otherwise. */
  const undecidedRates = rateDrift.filter((l) => !l.rateAction)

  /**
   * A reason is owed only for agreeing to pay *more*. Accepting a rate below
   * the order costs the mill nothing and needs no explaining.
   */
  const needsRateReason = rateDrift.some(
    (l) => l.rateAction === 'ACCEPT' && num(l.unitPrice) - (l.orderedRate ?? 0) > 0.005,
  )

  const incomplete =
    !supplierId ||
    // The supplier's invoice is on the desk when a bill is booked, so its
    // number and date are part of the document rather than optional extras.
    !supplierInvoiceNo.trim() ||
    !supplierInvoiceDate ||
    lines.some((l) => !l.itemId || num(l.qty) <= 0) ||
    undecidedRates.length > 0 ||
    (needsRateReason && !rateVarianceReason.trim())

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/60 backdrop-blur-sm p-4 sm:p-8">
      <div className="glass-card w-full max-w-6xl my-auto" role="dialog" aria-modal="true">
        <div className="flex items-center justify-between px-6 py-4 border-b border-border">
          <div>
            <h2 className="text-lg font-semibold text-foreground">
              {isEdit ? `Edit ${record?.billNumber}` : 'Book a Supplier Bill'}
            </h2>
            <p className="text-xs text-muted-foreground mt-0.5">
              {isEdit
                ? 'A bill can be changed until a payment is made against it'
                : 'Our reference number is given when you save. Type the supplier’s own number below.'}
            </p>
          </div>
          <button onClick={onClose} className="btn-ghost p-2" aria-label="Close">
            <X size={18} />
          </button>
        </div>

        <form onSubmit={submit} className="px-6 py-5 space-y-5">
          {error && (
            <div className="flex items-start gap-3 p-3 rounded-lg border border-red-500/40 bg-red-500/5">
              <AlertCircle size={16} className="text-red-400 mt-0.5 shrink-0" />
              <p className="text-sm text-red-400">{error}</p>
            </div>
          )}

          {!isEdit && (
            <div className="rounded-lg border border-border bg-secondary/30 p-3">
              <div className="flex flex-wrap items-end gap-3">
                <div className="flex-1 min-w-[240px]">
                  <label className="form-label" htmlFor="bill-grn">
                    {billedReceipts.length ? 'Add another goods receipt' : 'Start from a goods receipt'}
                  </label>
                  <select
                    id="bill-grn"
                    className="form-input"
                    value={pullGrnId}
                    onChange={(e) => setPullGrnId(e.target.value)}
                  >
                    <option value="">Type the bill by hand instead</option>
                    {pullable.map((g) => (
                      <option key={g.id} value={g.id}>
                        {g.grnNumber}
                        {g.po ? ` — ${g.po.poNumber}` : ''}
                      </option>
                    ))}
                  </select>
                </div>
                <button
                  type="button"
                  className="btn-secondary"
                  onClick={() => void pullFromGrn()}
                  disabled={!pullGrnId || pulling}
                >
                  {pulling ? <Loader2 size={15} className="animate-spin" /> : <Download size={15} />}
                  {billedReceipts.length ? 'Add lines' : 'Pull lines'}
                </button>
              </div>
              <p className="text-xs text-muted-foreground mt-2">
                {pullable.length === 0
                  ? 'No receipts are waiting to be billed. Book the bill by hand, or receive the goods first.'
                  : billedReceipts.length
                    ? `On this bill: ${billedReceipts.join(', ')}. Pick another receipt to add it — one bill can settle as many deliveries as the supplier invoiced together.`
                    : 'Brings across what was accepted at the gate and the rate that was ordered, so the bill can be checked against it. You can add more than one receipt.'}
              </p>
            </div>
          )}

          <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
            <div className="md:col-span-2">
              <label className="form-label" htmlFor="bill-supplier">
                Supplier<span className="text-red-400 ml-0.5">*</span>
              </label>
              <select
                id="bill-supplier"
                className="form-input"
                value={supplierId}
                onChange={(e) => setSupplierId(e.target.value)}
              >
                <option value="">Select...</option>
                {suppliers.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.code ? `${s.code} — ${s.name}` : s.name}
                  </option>
                ))}
              </select>
              {supplier && (
                <p className="text-xs text-muted-foreground mt-1">
                  {supplier.gstin ? (
                    <>
                      GSTIN {supplier.gstin} ·{' '}
                      {taxMode === 'CGST_SGST' ? 'within the state, CGST + SGST' : 'other state, IGST'}
                    </>
                  ) : isReverseCharge ? (
                    'Not registered — the GST on this bill is ours to pay, not theirs'
                  ) : (
                    'No GSTIN on file — this bill will carry no GST'
                  )}
                </p>
              )}
            </div>

            <div>
              {/* The bill is booked with their invoice on the desk, so this is
                the document's own number rather than an afterthought. It is
                also what stops the same invoice being booked twice. */}
              <label className="form-label" htmlFor="bill-supplier-no">
                Bill no. <span className="text-muted-foreground">(theirs)</span>
              </label>
              <input
                id="bill-supplier-no"
                className="form-input"
                placeholder="As printed on their bill"
                value={supplierInvoiceNo}
                onChange={(e) => setSupplierInvoiceNo(e.target.value)}
                required
              />
              {!supplierInvoiceNo.trim() && (
                <span className="mt-1 block text-xs text-amber-400">
                  Put the supplier’s bill number in
                </span>
              )}
            </div>

            <div>
              <label className="form-label" htmlFor="bill-supplier-date">
                Bill date
              </label>
              <input
                id="bill-supplier-date"
                type="date"
                className="form-input"
                value={supplierInvoiceDate}
                onChange={(e) => setSupplierInvoiceDate(e.target.value)}
                required
              />
              {!supplierInvoiceDate && (
                <span className="mt-1 block text-xs text-amber-400">
                  Put the date on their bill
                </span>
              )}
            </div>

            <div>
              <label className="form-label" htmlFor="bill-date">
                Booked on
              </label>
              <input
                id="bill-date"
                type="date"
                className="form-input"
                value={billDate}
                onChange={(e) => setBillDate(e.target.value)}
              />
            </div>

            <div>
              <label className="form-label" htmlFor="bill-due">
                Payment due
              </label>
              <input
                id="bill-due"
                type="date"
                className="form-input"
                value={dueDate}
                onChange={(e) => setDueDate(e.target.value)}
              />
              {supplier?.isMsme && (
                <p className="text-xs text-amber-400 mt-1">
                  MSME supplier — payment is due within 45 days by law.
                </p>
              )}
            </div>

            <div className="md:col-span-2 flex items-end">
              <label className="flex items-start gap-2 text-sm text-foreground cursor-pointer">
                <input
                  type="checkbox"
                  className="mt-0.5"
                  checked={isReverseCharge}
                  onChange={(e) => setIsReverseCharge(e.target.checked)}
                />
                <span>
                  Reverse charge
                  <span className="block text-xs text-muted-foreground">
                    We pay the GST to the government, not to the supplier. Common on transport and on
                    bills from unregistered parties.
                  </span>
                </span>
              </label>
            </div>
          </div>

          {(overBilled.length > 0 || rateDrift.length > 0) && (
            <div className="flex items-start gap-3 p-3 rounded-lg border border-amber-500/40 bg-amber-500/5">
              <TriangleAlert size={16} className="text-amber-400 mt-0.5 shrink-0" />
              <div className="text-xs text-amber-400 space-y-1">
                {overBilled.map((l, i) => (
                  <p key={`o${i}`}>
                    {itemById.get(l.itemId)?.name ?? 'A line'}: the bill claims {num(l.qty)} but only{' '}
                    {l.pendingQty} is left to bill on {l.grnNumber}. Saving this will be refused.
                  </p>
                ))}
              </div>
            </div>
          )}

          {/*
            The rate half of the three-way match.

            Quantity has always been checked against the receipt. The rate was
            not, so a supplier could bill the goods that did arrive at any
            price. Each mismatch now has to be answered before the bill saves:
            take their rate, with a reason, or hold them to the order's and
            claim the difference back.
          */}
          {rateDrift.length > 0 && (
            <div className="rounded-lg border border-amber-500/40 bg-amber-500/5 p-3 space-y-3">
              <div className="flex items-start gap-2">
                <TriangleAlert size={15} className="mt-0.5 shrink-0 text-amber-400" />
                <p className="text-sm text-amber-300">
                  {rateDrift.length === 1
                    ? 'One line is billed at a different rate than the order agreed.'
                    : `${rateDrift.length} lines are billed at a different rate than the order agreed.`}{' '}
                  Say what to do with each before saving.
                </p>
              </div>

              {rateDrift.map((l) => {
                const index = lines.indexOf(l)
                const billed = num(l.unitPrice)
                const ordered = l.orderedRate!
                const diff = billed - ordered
                const totalDiff = diff * num(l.qty)
                const higher = diff > 0

                return (
                  <div
                    key={`rv${index}`}
                    className="rounded-md border border-border bg-secondary/40 p-2.5"
                  >
                    <p className="text-sm text-foreground">
                      {itemById.get(l.itemId)?.name ?? 'A line'}
                    </p>
                    <p className="text-xs text-muted-foreground mt-0.5">
                      Order ₹{inr(ordered)} · billed ₹{inr(billed)} ·{' '}
                      <span className={higher ? 'text-amber-400' : 'text-emerald-400'}>
                        {higher ? '+' : ''}
                        {inr(diff)} each, {higher ? '+' : ''}
                        {inr(totalDiff)} on this line
                      </span>
                    </p>

                    <div className="mt-2 flex flex-wrap gap-2">
                      <button
                        type="button"
                        onClick={() => setLine(index, { rateAction: 'ACCEPT' })}
                        className={`rounded-md border px-2.5 py-1.5 text-xs transition ${
                          l.rateAction === 'ACCEPT'
                            ? 'border-amber-500/60 bg-amber-500/15 text-amber-300'
                            : 'border-border text-muted-foreground hover:text-foreground'
                        }`}
                      >
                        Accept ₹{inr(billed)}
                      </button>
                      <button
                        type="button"
                        onClick={() => setLine(index, { rateAction: 'DEBIT_NOTE' })}
                        className={`rounded-md border px-2.5 py-1.5 text-xs transition ${
                          l.rateAction === 'DEBIT_NOTE'
                            ? 'border-teal-500/60 bg-teal-500/15 text-teal-300'
                            : 'border-border text-muted-foreground hover:text-foreground'
                        }`}
                      >
                        {higher
                          ? `Book ₹${inr(ordered)} and claim the difference`
                          : `Book ₹${inr(ordered)}`}
                      </button>
                    </div>

                    {l.rateAction === 'DEBIT_NOTE' && higher && (
                      <p className="mt-1.5 text-[11px] text-muted-foreground">
                        A debit note for ₹{inr(totalDiff)} plus tax is raised in draft. Nothing is
                        sent to the supplier until somebody sends it.
                      </p>
                    )}
                  </div>
                )
              })}

              {needsRateReason && (
                <label className="block">
                  <span className="form-label">Why the higher rate was agreed</span>
                  <input
                    className="form-input h-9"
                    value={rateVarianceReason}
                    onChange={(e) => setRateVarianceReason(e.target.value)}
                    placeholder="e.g. yarn price rose, agreed with the supplier on the phone"
                  />
                </label>
              )}
            </div>
          )}

          {/* Lines */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                What the supplier has charged for
              </h3>
              <button
                type="button"
                onClick={() => setLines((p) => [...p, emptyLine()])}
                className="btn-secondary text-xs"
              >
                <Plus size={14} /> Add line
              </button>
            </div>

            <div className="overflow-x-auto border border-border rounded-lg">
              <table className="w-full text-sm min-w-[900px]">
                <thead>
                  <tr className="border-b border-border bg-secondary/40">
                    {['Item', 'Against receipt', 'Qty', 'Rate', 'Disc %', 'GST %', 'Amount', ''].map(
                      (h, i) => (
                        <th
                          key={h || i}
                          className={`text-[10px] uppercase tracking-wider text-muted-foreground py-2 px-3 ${
                            ['Qty', 'Rate', 'Disc %', 'GST %', 'Amount'].includes(h)
                              ? 'text-right'
                              : 'text-left'
                          }`}
                        >
                          {h}
                        </th>
                      ),
                    )}
                  </tr>
                </thead>
                <tbody>
                  {lines.map((line, i) => {
                    const item = itemById.get(line.itemId)
                    return (
                      <tr key={i} className="border-b border-border/50 last:border-0">
                        <td className="py-2 px-3 min-w-[200px]">
                          <select
                            className="form-input h-9"
                            value={line.itemId}
                            onChange={(e) => pickItem(i, e.target.value)}
                            aria-label={`Line ${i + 1} item`}
                          >
                            <option value="">Select...</option>
                            {items.map((it) => (
                              <option key={it.id} value={it.id}>
                                {it.code ? `${it.code} — ${it.name}` : it.name}
                              </option>
                            ))}
                          </select>
                          {item?.hsnCode && (
                            <p className="text-[10px] text-muted-foreground mt-0.5 font-mono">
                              HSN {item.hsnCode}
                            </p>
                          )}
                        </td>
                        <td className="py-2 px-3 min-w-[130px]">
                          {line.grnNumber ? (
                            <>
                              <span className="badge-info">{line.grnNumber}</span>
                              {line.pendingQty != null && (
                                <p className="text-[10px] text-muted-foreground mt-0.5">
                                  {line.pendingQty} left to bill
                                </p>
                              )}
                            </>
                          ) : (
                            <span className="text-xs text-muted-foreground">Not matched</span>
                          )}
                        </td>
                        <td className="py-2 px-3 w-28">
                          <input
                            type="number"
                            step="0.001"
                            min={0}
                            className="form-input h-9 text-right"
                            value={String(line.qty)}
                            onChange={(e) => setLine(i, { qty: e.target.value })}
                            aria-label={`Line ${i + 1} quantity`}
                          />
                          {item?.uom?.symbol && (
                            <p className="text-[10px] text-muted-foreground mt-0.5 text-right">
                              {item.uom.symbol}
                            </p>
                          )}
                        </td>
                        <td className="py-2 px-3 w-28">
                          <input
                            type="number"
                            step="0.01"
                            min={0}
                            className="form-input h-9 text-right"
                            value={String(line.unitPrice)}
                            onChange={(e) => setLineRate(i, e.target.value)}
                            aria-label={`Line ${i + 1} rate`}
                          />
                          {line.orderedRate != null && (
                            <p className="text-[10px] text-muted-foreground mt-0.5 text-right">
                              ordered {inr(line.orderedRate)}
                            </p>
                          )}
                        </td>
                        <td className="py-2 px-3 w-20">
                          <input
                            type="number"
                            step="0.01"
                            min={0}
                            max={100}
                            className="form-input h-9 text-right"
                            value={String(line.discount)}
                            onChange={(e) => setLine(i, { discount: e.target.value })}
                            aria-label={`Line ${i + 1} discount`}
                          />
                        </td>
                        <td className="py-2 px-3 w-20">
                          <input
                            type="number"
                            step="0.01"
                            min={0}
                            max={100}
                            className="form-input h-9 text-right"
                            disabled={taxMode === 'NONE'}
                            value={taxMode === 'NONE' ? '' : String(line.gstRate)}
                            onChange={(e) => setLine(i, { gstRate: e.target.value })}
                            aria-label={`Line ${i + 1} GST rate`}
                          />
                        </td>
                        <td className="py-2 px-3 text-right font-medium tabular-nums w-32">
                          {inr(totals.lineGross[i] ?? 0)}
                        </td>
                        <td className="py-2 px-3 w-12">
                          <button
                            type="button"
                            onClick={() =>
                              setLines((p) => (p.length === 1 ? p : p.filter((_, x) => x !== i)))
                            }
                            disabled={lines.length === 1}
                            className="btn-ghost p-1 text-muted-foreground hover:text-red-400 disabled:opacity-25"
                            aria-label={`Remove line ${i + 1}`}
                          >
                            <Trash2 size={13} />
                          </button>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </div>

          {/* Charges — freight, transport, dyeing. Own GST rate each. */}
          {chargeTypes.length > 0 && (
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  Extras at the foot of the bill
                </h3>
                <button
                  type="button"
                  onClick={() =>
                    setCharges((p) => [...p, { chargeTypeId: '', amount: '', gstRate: '' }])
                  }
                  className="btn-secondary text-xs"
                >
                  <Plus size={14} /> Add charge
                </button>
              </div>

              {charges.length > 0 && (
                <div className="border border-border rounded-lg divide-y divide-border/50">
                  {charges.map((c, i) => (
                    <div key={i} className="flex flex-wrap items-end gap-3 p-3">
                      <div className="flex-1 min-w-[180px]">
                        <select
                          className="form-input h-9"
                          value={c.chargeTypeId}
                          onChange={(e) => {
                            const ct = chargeById.get(e.target.value)
                            setCharges((p) =>
                              p.map((x, y) =>
                                y === i
                                  ? {
                                      ...x,
                                      chargeTypeId: e.target.value,
                                      gstRate:
                                        x.gstRate ||
                                        (ct?.defaultGstRate != null ? String(ct.defaultGstRate) : ''),
                                    }
                                  : x,
                              ),
                            )
                          }}
                          aria-label={`Charge ${i + 1} type`}
                        >
                          <option value="">Select...</option>
                          {chargeTypes.map((ct) => (
                            <option key={ct.id} value={ct.id}>
                              {ct.name}
                            </option>
                          ))}
                        </select>
                      </div>
                      <div className="w-32">
                        <input
                          type="number"
                          step="0.01"
                          min={0}
                          className="form-input h-9 text-right"
                          placeholder="Amount"
                          value={String(c.amount)}
                          onChange={(e) =>
                            setCharges((p) =>
                              p.map((x, y) => (y === i ? { ...x, amount: e.target.value } : x)),
                            )
                          }
                          aria-label={`Charge ${i + 1} amount`}
                        />
                      </div>
                      <div className="w-24">
                        <input
                          type="number"
                          step="0.01"
                          min={0}
                          max={100}
                          className="form-input h-9 text-right"
                          placeholder="GST %"
                          disabled={taxMode === 'NONE'}
                          value={taxMode === 'NONE' ? '' : String(c.gstRate)}
                          onChange={(e) =>
                            setCharges((p) =>
                              p.map((x, y) => (y === i ? { ...x, gstRate: e.target.value } : x)),
                            )
                          }
                          aria-label={`Charge ${i + 1} GST rate`}
                        />
                      </div>
                      <button
                        type="button"
                        onClick={() => setCharges((p) => p.filter((_, y) => y !== i))}
                        className="btn-ghost p-1.5 text-muted-foreground hover:text-red-400"
                        aria-label={`Remove charge ${i + 1}`}
                      >
                        <Trash2 size={13} />
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Totals, TDS and notes */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
            <div className="space-y-4">
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div>
                  <label className="form-label" htmlFor="bill-tds-section">
                    TDS section
                  </label>
                  <input
                    id="bill-tds-section"
                    className="form-input"
                    placeholder="e.g. 194C"
                    value={tdsSection}
                    onChange={(e) => setTdsSection(e.target.value)}
                  />
                </div>
                <div>
                  <label className="form-label" htmlFor="bill-tds-rate">
                    TDS rate %
                  </label>
                  <input
                    id="bill-tds-rate"
                    type="number"
                    step="0.01"
                    min={0}
                    max={100}
                    className="form-input"
                    value={tdsRate}
                    onChange={(e) => setTdsRate(e.target.value)}
                  />
                </div>
              </div>
              <div>
                <label className="form-label" htmlFor="bill-notes">
                  Notes
                </label>
                <textarea
                  id="bill-notes"
                  rows={3}
                  className="form-input"
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                />
              </div>
            </div>

            <div className="rounded-lg border border-border bg-secondary/30 p-4 space-y-2 text-sm h-fit">
              <Row label="Goods subtotal" value={totals.subtotal} />
              <div className="flex items-center justify-between gap-4">
                <label htmlFor="bill-discount" className="text-muted-foreground">
                  Discount on the whole bill
                </label>
                <input
                  id="bill-discount"
                  type="number"
                  step="0.01"
                  min={0}
                  className="form-input h-8 w-32 text-right"
                  value={discountAmount}
                  onChange={(e) => setDiscountAmount(e.target.value)}
                />
              </div>
              {totals.chargeTotal > 0 && <Row label="Extras" value={totals.chargeTotal} />}
              <Row label="Taxable value" value={totals.taxable} />
              {taxMode === 'CGST_SGST' && (
                <>
                  <Row label="CGST" value={totals.tax / 2} />
                  <Row label="SGST" value={totals.tax / 2} />
                </>
              )}
              {taxMode === 'IGST' && <Row label="IGST" value={totals.tax} />}
              {taxMode === 'NONE' && (
                <p className="text-xs text-muted-foreground py-1">
                  No GST — this supplier is not registered.
                </p>
              )}
              {taxMode === null && (
                <>
                  <Row label="GST" value={totals.tax} />
                  <p className="text-xs text-muted-foreground py-1">
                    Choose a supplier to see whether this splits into CGST + SGST or is IGST.
                  </p>
                </>
              )}
              {isReverseCharge && totals.tax > 0 && (
                <p className="text-xs text-amber-400 py-1">
                  Reverse charge — the ₹{inr(totals.tax)} of GST above is payable by us to the
                  government and is not part of what the supplier is paid.
                </p>
              )}
              <Row label="Rounding" value={totals.roundOff} />
              <div className="flex items-center justify-between pt-2 border-t border-border">
                <span className="font-semibold text-foreground">Bill total</span>
                <span className="font-semibold text-foreground tabular-nums text-lg">
                  ₹{inr(totals.total)}
                </span>
              </div>
              {totals.tds > 0 && (
                <>
                  <Row label={`TDS withheld${tdsSection ? ` (${tdsSection})` : ''}`} value={-totals.tds} />
                  <div className="flex items-center justify-between pt-2 border-t border-border">
                    <span className="font-medium text-foreground">Payable to supplier</span>
                    <span className="font-semibold text-foreground tabular-nums">
                      ₹{inr(totals.balance)}
                    </span>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    Paying this smaller amount settles the bill in full — the TDS is accounted for
                    rather than left outstanding against them.
                  </p>
                </>
              )}
            </div>
          </div>

          <div className="flex items-center justify-end gap-3 pt-3 border-t border-border">
            <button type="button" onClick={onClose} className="btn-secondary" disabled={saving}>
              Cancel
            </button>
            <button type="submit" className="btn-primary" disabled={saving || incomplete}>
              {saving && <Loader2 size={15} className="animate-spin" />}
              {isEdit ? 'Save changes' : 'Book bill'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

function Row({ label, value }: { label: string; value: number }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-muted-foreground">{label}</span>
      <span className="tabular-nums text-foreground">{inr(value)}</span>
    </div>
  )
}
