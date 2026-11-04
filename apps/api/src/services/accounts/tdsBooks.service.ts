import type { Prisma } from '@prisma/client'
import { booksSettings, fyStartOf, istDay, ledgerFigures, r2 } from './books.service'

/**
 * TDS from the books.
 *
 * Deducted by us: every credit to a TDS Payable ledger — on a supplier's
 * bill, a supplier payment, a broker or contractor paid from Accounts — with
 * the party, their PAN and what it was deducted on; every debit to one is
 * TDS paid in to the government. Each month's TDS falls due on the 7th of the
 * next (the 30th of April for March), so what is still owed and late shows
 * by section.
 *
 * Deducted from us: every debit to TDS Receivable — a customer's TDS taken
 * on a receipt — by customer, to set against Form 26AS.
 */

type Tx = Prisma.TransactionClient
const range = (from: string, to: string) => ({ gte: new Date(`${from}T00:00:00+05:30`), lte: new Date(`${to}T23:59:59.999+05:30`) })

/** The day a month's TDS has to be paid in by. */
export function tdsDueDate(month: string): string {
  const y = Number(month.slice(0, 4))
  const m = Number(month.slice(5, 7))
  if (m === 3) return `${y}-04-30`
  const ny = m === 12 ? y + 1 : y
  const nm = m === 12 ? 1 : m + 1
  return `${ny}-${String(nm).padStart(2, '0')}-07`
}

const INPUT_GST = ['INPUT_CGST', 'INPUT_SGST', 'INPUT_IGST']

export async function tdsDeducted(tx: Tx, from: string, to: string, today: string) {
  const s = await booksSettings(tx)
  const ledgers = await tx.ledger.findMany({
    where: { systemKey: { startsWith: 'TDS_PAYABLE' } },
    select: { id: true, name: true, systemKey: true },
  })
  const sectionIds = ledgers.map((l) => l.systemKey!.split(':')[1]).filter(Boolean)
  const sections = new Map((await tx.tdsSection.findMany({ where: { id: { in: sectionIds } }, select: { id: true, section: true, label: true } })).map((x) => [x.id, x]))
  const sectionOf = (key: string) => sections.get(key.split(':')[1] ?? '')?.section ?? 'Not said'
  const ids = ledgers.map((l) => l.id)
  const lines = await tx.voucherLine.findMany({
    where: { ledgerId: { in: ids }, voucher: { status: 'POSTED', date: range(from, to) } },
    orderBy: { voucher: { date: 'asc' } },
    select: {
      ledgerId: true,
      debit: true,
      credit: true,
      voucher: {
        select: {
          id: true,
          voucherNo: true,
          kind: true,
          date: true,
          sourceType: true,
          sourceId: true,
          lines: {
            select: {
              debit: true,
              credit: true,
              ledger: {
                select: {
                  name: true,
                  systemKey: true,
                  partyType: true,
                  pan: true,
                  supplier: { select: { pan: true } },
                  broker: { select: { pan: true } },
                  customer: { select: { pan: true } },
                },
              },
            },
          },
        },
      },
    },
  })
  const billIds = lines.filter((l) => l.voucher.sourceType === 'PURCHASE_BILL').map((l) => l.voucher.sourceId!)
  const billTaxable = new Map(
    (await tx.purchaseInvoice.findMany({ where: { id: { in: billIds } }, select: { id: true, taxableAmount: true } })).map((b) => [b.id, Number(b.taxableAmount)]),
  )
  const keyOf = new Map(ledgers.map((l) => [l.id, l.systemKey!]))
  const deducted: Array<{ date: string; month: string; section: string; party: string; pan: string | null; base: number | null; tds: number; voucherNo: string; voucherId: string; from: string | null }> = []
  const paid: Array<{ date: string; section: string; amount: number; voucherNo: string; voucherId: string }> = []
  for (const l of lines) {
    const section = sectionOf(keyOf.get(l.ledgerId)!)
    const date = istDay(l.voucher.date)
    if (Number(l.debit) > 0) {
      paid.push({ date, section, amount: Number(l.debit), voucherNo: l.voucher.voucherNo, voucherId: l.voucher.id })
      continue
    }
    const party = l.voucher.lines.find((x) => x.ledger.partyType && x.ledger.partyType !== 'BANK')?.ledger
    const base =
      l.voucher.sourceType === 'PURCHASE_BILL'
        ? billTaxable.get(l.voucher.sourceId!) ?? null
        : r2(l.voucher.lines.filter((x) => Number(x.debit) > 0 && !INPUT_GST.includes(x.ledger.systemKey ?? '')).reduce((t, x) => t + Number(x.debit), 0)) || null
    deducted.push({
      date,
      month: date.slice(0, 7),
      section,
      party: party?.name ?? '—',
      pan: party ? party.supplier?.pan ?? party.broker?.pan ?? party.customer?.pan ?? party.pan ?? null : null,
      base,
      tds: Number(l.credit),
      voucherNo: l.voucher.voucherNo,
      voucherId: l.voucher.id,
      from: l.voucher.sourceType,
    })
  }

  // Where each section stands: what it opened at, took, paid in, and owes now.
  const figures = new Map((await ledgerFigures(tx, { from: from < fyStartOf(to, s.fyStartMonth) ? fyStartOf(to, s.fyStartMonth) : from, to }, s)).map((f) => [f.id, f]))
  const bySection = ledgers.map((l) => {
    const f = figures.get(l.id)
    const section = sectionOf(l.systemKey!)
    const months = new Map<string, number>()
    for (const d of deducted.filter((x) => x.section === section)) months.set(d.month, r2((months.get(d.month) ?? 0) + d.tds))
    // Paid in against the oldest month first, the way the government applies it.
    let paidIn = r2(paid.filter((p) => p.section === section).reduce((t, p) => t + p.amount, 0) - Math.max(0, -(f?.opening ?? 0)))
    const monthRows = [...months.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([month, amount]) => {
        const covered = r2(Math.min(amount, Math.max(0, paidIn)))
        paidIn = r2(paidIn - covered)
        const due = tdsDueDate(month)
        const owing = r2(amount - covered)
        return { month, deducted: amount, paid: covered, owing, due, late: owing > 0 && due < today }
      })
    return {
      ledgerId: l.id,
      ledger: l.name,
      section,
      opening: r2(-(f?.opening ?? 0)),
      deducted: r2(deducted.filter((d) => d.section === section).reduce((t, d) => t + d.tds, 0)),
      paid: r2(paid.filter((p) => p.section === section).reduce((t, p) => t + p.amount, 0)),
      closing: r2(-(f?.closing ?? 0)),
      months: monthRows,
    }
  })
  return {
    period: { from, to },
    sections: bySection.filter((x) => x.opening || x.deducted || x.paid || x.closing),
    deducted,
    paid,
    totals: {
      deducted: r2(deducted.reduce((t, d) => t + d.tds, 0)),
      paid: r2(paid.reduce((t, p) => t + p.amount, 0)),
      owing: r2(bySection.reduce((t, x) => t + x.closing, 0)),
      late: r2(bySection.flatMap((x) => x.months).filter((m) => m.late).reduce((t, m) => t + m.owing, 0)),
    },
  }
}

/** TDS customers deducted from what they paid us, to set against Form 26AS. */
export async function tdsByCustomers(tx: Tx, from: string, to: string) {
  const ledger = await tx.ledger.findUnique({ where: { systemKey: 'TDS_RECEIVABLE' }, select: { id: true } })
  if (!ledger) return { period: { from, to }, rows: [], customers: [], total: 0 }
  const lines = await tx.voucherLine.findMany({
    where: { ledgerId: ledger.id, debit: { gt: 0 }, voucher: { status: 'POSTED', date: range(from, to) } },
    orderBy: { voucher: { date: 'asc' } },
    select: {
      debit: true,
      voucher: {
        select: {
          id: true,
          voucherNo: true,
          date: true,
          sourceType: true,
          sourceId: true,
          lines: { select: { credit: true, ledger: { select: { id: true, name: true, partyType: true, customer: { select: { pan: true, gstin: true } } } } } },
        },
      },
    },
  })
  const receiptIds = lines.filter((l) => l.voucher.sourceType === 'SALES_RECEIPT').map((l) => l.voucher.sourceId!)
  const against = new Map<string, string[]>()
  for (const a of await tx.paymentReceiptAllocation.findMany({ where: { receiptId: { in: receiptIds }, tdsAmount: { gt: 0 } }, select: { receiptId: true, invoice: { select: { invoiceNumber: true } } } })) {
    against.set(a.receiptId, [...(against.get(a.receiptId) ?? []), a.invoice.invoiceNumber])
  }
  const rows = lines.map((l) => {
    const c = l.voucher.lines.find((x) => x.ledger.partyType === 'CUSTOMER')?.ledger
    return {
      date: istDay(l.voucher.date),
      customer: c?.name ?? '—',
      ledgerId: c?.id ?? null,
      pan: c?.customer?.pan ?? c?.customer?.gstin?.slice(2, 12) ?? null,
      tds: Number(l.debit),
      voucherNo: l.voucher.voucherNo,
      voucherId: l.voucher.id,
      invoices: against.get(l.voucher.sourceId ?? '') ?? [],
    }
  })
  const byCustomer = new Map<string, { customer: string; pan: string | null; tds: number; entries: number }>()
  for (const r of rows) {
    const e = byCustomer.get(r.customer) ?? { customer: r.customer, pan: r.pan, tds: 0, entries: 0 }
    e.tds = r2(e.tds + r.tds)
    e.entries++
    byCustomer.set(r.customer, e)
  }
  return {
    period: { from, to },
    rows,
    customers: [...byCustomer.values()].sort((a, b) => b.tds - a.tds),
    total: r2(rows.reduce((t, r) => t + r.tds, 0)),
  }
}
