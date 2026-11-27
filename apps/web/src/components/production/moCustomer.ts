/** A manufacturing order as far as who it is for goes. */
type MoFor = { so?: { customer: { name: string } } | null; customer?: { name: string } | null; purpose?: string | null }

/** Who a manufacturing order is for: its sales order's customer, or — a direct order made for a customer — its own. */
export function moCustomer(mo: MoFor | null | undefined): string | null {
  return mo?.so?.customer.name ?? mo?.customer?.name ?? null
}

/** What a direct order (no sales order) is for, in a few words: "stock", "samples", or the customer. */
export function directFor(mo: MoFor | null | undefined): string {
  if (mo?.purpose === 'SAMPLE') return 'samples'
  if (mo?.purpose === 'CUSTOMER') return mo.customer?.name ?? 'a customer'
  return 'stock'
}

/** The purposes a direct order can be made for, as the form offers them. */
export const DIRECT_PURPOSES = [
  { value: 'STOCK', label: 'For stock', sub: 'Into the finished goods store, to sell later' },
  { value: 'CUSTOMER', label: 'For a customer', sub: 'Their order is not raised (yet): link it when it is' },
  { value: 'SAMPLE', label: 'Samples', sub: "A trial or salesman's samples" },
] as const
export type DirectPurpose = (typeof DIRECT_PURPOSES)[number]['value']
