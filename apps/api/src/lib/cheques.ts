import type { Prisma } from '@prisma/client'

/**
 * A cheque dated after today is held: recorded as a cheque in hand, it settles
 * no invoice and does not count against the credit limit until the date on it
 * (the business's answer of 19 Oct 2026). From that date it is applied to the
 * invoices like any advance, then marked cleared when the bank credits it.
 */

const IST = 330 * 60_000
const DAY = 86_400_000
const CHEQUE_MODES = ['CHEQUE', 'PDC'] as const

/** A moment's calendar day in India, as YYYY-MM-DD. */
export const istDay = (d: Date) => new Date(d.getTime() + IST).toISOString().slice(0, 10)

/** The first moment of tomorrow, in India. */
function startOfTomorrow(now: Date) {
  return new Date(Date.parse(`${istDay(now)}T00:00:00Z`) + DAY - IST)
}

/** The date a receipt's cheque is held until, or null when it is not held. */
export function heldUntil(r: { mode: string; chequeDate: Date | null }, now = new Date()): Date | null {
  if (!(CHEQUE_MODES as readonly string[]).includes(r.mode) || !r.chequeDate) return null
  return istDay(r.chequeDate) > istDay(now) ? r.chequeDate : null
}

/** Receipts whose money counts today: everything but cheques dated after today. */
export function notHeld(now = new Date()): Prisma.PaymentReceiptWhereInput {
  return {
    OR: [{ mode: { notIn: [...CHEQUE_MODES] } }, { chequeDate: null }, { chequeDate: { lt: startOfTomorrow(now) } }],
  }
}

/** "3 Nov 2026", in India. */
export const longDay = (d: Date) =>
  d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' })
