// Shared by the checks that raise sales orders on the demo: a test customer of their own, and closing
// each test order when the check finishes. Never the e2e sales test's ZZTEST Credit Watch Buyer: its
// credit limit is part of what that test checks, and open orders left on it count against the limit.
import type { prisma as Prisma } from '../packages/database/src/index'

type Call = (method: string, path: string, body?: unknown) => Promise<{ status: number; body: any }>

export const CHECKS_CUSTOMER = 'ZZTEST Checks Customer'

/** The checks' own customer (no credit limit), made once through the masters API. */
export async function checksCustomer(prisma: typeof Prisma, call: Call): Promise<{ id: string }> {
  const [{ current_database: dbName }] = await prisma.$queryRaw<{ current_database: string }[]>`select current_database()`
  if (dbName !== 'lderp_demo') throw new Error('Refusing to run: not lderp_demo.')
  const have = await prisma.customer.findFirst({ where: { name: CHECKS_CUSTOMER }, select: { id: true, isActive: true, isBlacklisted: true } })
  if (have) {
    if (!have.isActive || have.isBlacklisted) await call('PATCH', `/masters/customers/${have.id}`, { isActive: true, isBlacklisted: false })
    return { id: have.id }
  }
  const made = await call('POST', '/masters/customers', {
    name: CHECKS_CUSTOMER,
    type: 'DOMESTIC',
    billingAddress: 'Demo test customer for the checks in tools/',
    billingCity: 'Bhiwandi',
    billingStateCode: '27',
    creditDays: 30,
  })
  if (made.status !== 201) throw new Error(`could not make ${CHECKS_CUSTOMER}: ${made.status} ${made.body?.message ?? ''}`)
  return { id: made.body.data.id }
}

/**
 * Closes a check's order the way a person would: cancelled when nothing was made or sent,
 * short-closed once something was sent, cancelled by request when it has a manufacturing order.
 */
export async function closeTestOrder(call: Call, soId: string | undefined, reason = 'Test order from a check, closed when it finished'): Promise<string> {
  if (!soId) return 'none to close'
  const cancel = await call('POST', `/sales/orders/${soId}/cancel`, { reason })
  if (cancel.status === 200) return 'cancelled'
  const short = await call('POST', `/sales/orders/${soId}/short-close`, { reason })
  if (short.status === 200) return 'short-closed'
  if (short.body?.code === 'NOTHING_STARTED') {
    const asked = await call('POST', `/sales/orders/${soId}/cancellation/request`, { reason })
    const done = asked.status === 200 ? await call('POST', `/sales/orders/${soId}/cancellation/approve`, {}) : asked
    if (done.status === 200) return 'cancelled by request'
  }
  return `left open (${cancel.body?.code ?? cancel.status} / ${short.body?.code ?? short.status})`
}
