import type { Prisma } from '@prisma/client'
import { AppError } from '../middleware/errorHandler'

const round2 = (n: number) => Math.round(n * 100) / 100

/**
 * What a receipt does to one invoice: the cash applied to it and any TDS the
 * customer deducted on it. Either may be nothing, not both.
 */
export interface AllocationInput {
  invoiceId: string
  amount: number
  tdsAmount?: number
}

/**
 * What is still owed on an invoice, summed from the receipts that are not
 * reversed rather than read off the invoice, so two people receiving at the
 * same moment cannot both pass the check against a stale figure.
 */
async function owedOn(tx: Prisma.TransactionClient, invoice: { id: string; totalAmount: Prisma.Decimal }) {
  const agg = await tx.paymentReceiptAllocation.aggregate({
    where: { invoiceId: invoice.id, receipt: { status: 'POSTED' } },
    _sum: { amount: true, tdsAmount: true },
  })
  const settled = Number(agg._sum.amount ?? 0) + Number(agg._sum.tdsAmount ?? 0)
  return round2(Number(invoice.totalAmount) - settled)
}

/**
 * Brings an invoice's paid, TDS, balance and status into line with the
 * receipts against it. Called after every receipt that touches it, and after
 * a receipt is reversed, so the invoice reopens by what the receipt had
 * settled. A cancelled invoice stays cancelled and owes nothing.
 */
export async function syncInvoiceFromReceipts(tx: Prisma.TransactionClient, invoiceId: string) {
  const invoice = await tx.salesInvoice.findUniqueOrThrow({
    where: { id: invoiceId },
    select: { id: true, totalAmount: true, status: true },
  })
  const agg = await tx.paymentReceiptAllocation.aggregate({
    where: { invoiceId, receipt: { status: 'POSTED' } },
    _sum: { amount: true, tdsAmount: true },
  })
  const paidAmount = round2(Number(agg._sum.amount ?? 0))
  const tdsAmount = round2(Number(agg._sum.tdsAmount ?? 0))
  const balance = round2(Math.max(0, Number(invoice.totalAmount) - paidAmount - tdsAmount))
  const status =
    invoice.status === 'CANCELLED'
      ? 'CANCELLED'
      : balance <= 0
        ? 'PAID'
        : paidAmount > 0 || tdsAmount > 0
          ? 'PARTIAL'
          : 'UNPAID'
  return tx.salesInvoice.update({
    where: { id: invoiceId },
    data: { paidAmount, tdsAmount, balanceAmount: status === 'CANCELLED' ? 0 : balance, status },
  })
}

/**
 * Checks what a receipt is to settle, writing nothing.
 *
 * Every invoice must be the customer's, and still owe something; each gets no
 * more than it still owes. Done before the receipt is written, so a refused
 * receipt leaves nothing behind and takes no number.
 */
export async function planAllocations(tx: Prisma.TransactionClient, customerId: string, allocations: AllocationInput[]) {
  const wanted = allocations.filter((a) => a.amount > 0 || (a.tdsAmount ?? 0) > 0)
  if (!wanted.length) return []

  const invoices = await tx.salesInvoice.findMany({
    where: { id: { in: wanted.map((a) => a.invoiceId) } },
    select: { id: true, invoiceNumber: true, customerId: true, status: true, totalAmount: true },
  })
  const byId = new Map(invoices.map((i) => [i.id, i]))

  const planned: Array<{ invoiceId: string; amount: number; tdsAmount: number }> = []
  for (const a of wanted) {
    const inv = byId.get(a.invoiceId)
    if (!inv) throw new AppError('One of the invoices does not exist', 400, 'BAD_INVOICE')
    if (inv.customerId !== customerId) {
      throw new AppError(`${inv.invoiceNumber} is another customer's invoice`, 400, 'WRONG_CUSTOMER')
    }
    if (inv.status === 'CANCELLED') throw new AppError(`${inv.invoiceNumber} is cancelled. Nothing is owed on it.`, 409, 'INVOICE_CANCELLED')
    const owed = await owedOn(tx, inv)
    if (owed <= 0) throw new AppError(`${inv.invoiceNumber} is already paid in full`, 409, 'INVOICE_PAID')
    const amount = round2(a.amount)
    const tdsAmount = round2(a.tdsAmount ?? 0)
    if (round2(amount + tdsAmount) > owed) {
      throw new AppError(
        tdsAmount > 0
          ? `₹${amount.toFixed(2)} and ₹${tdsAmount.toFixed(2)} TDS on ${inv.invoiceNumber} comes to more than the ₹${owed.toFixed(2)} still owed on it`
          : `₹${amount.toFixed(2)} is more than the ₹${owed.toFixed(2)} still owed on ${inv.invoiceNumber}`,
        400,
        'OVERPAYMENT',
      )
    }
    planned.push({ invoiceId: inv.id, amount, tdsAmount })
  }
  return planned
}

/**
 * Writes checked allocations against a receipt and brings their invoices up
 * to date. Applying to an invoice the receipt already settles part of adds to
 * that part. Returns the cash and TDS applied.
 */
export async function writeAllocations(
  tx: Prisma.TransactionClient,
  receiptId: string,
  planned: Array<{ invoiceId: string; amount: number; tdsAmount: number }>,
) {
  for (const a of planned) {
    const existing = await tx.paymentReceiptAllocation.findUnique({
      where: { receiptId_invoiceId: { receiptId, invoiceId: a.invoiceId } },
    })
    if (existing) {
      await tx.paymentReceiptAllocation.update({
        where: { id: existing.id },
        data: { amount: { increment: a.amount }, tdsAmount: { increment: a.tdsAmount } },
      })
    } else {
      await tx.paymentReceiptAllocation.create({ data: { receiptId, invoiceId: a.invoiceId, amount: a.amount, tdsAmount: a.tdsAmount } })
    }
  }
  for (const a of planned) await syncInvoiceFromReceipts(tx, a.invoiceId)
  return {
    cash: round2(planned.reduce((s, a) => s + a.amount, 0)),
    tds: round2(planned.reduce((s, a) => s + a.tdsAmount, 0)),
  }
}
