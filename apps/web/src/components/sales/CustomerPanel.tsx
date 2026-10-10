'use client'

import { AlertCircle, Loader2 } from 'lucide-react'
import { formatRupees } from '@/lib/utils'
import { GST_STATES } from '@/lib/gstStates'
import { SmartSelect } from '@/components/ui/SmartSelect'

export interface CustomerOption {
  id: string
  code: string
  name: string
  type: string
  gstin: string | null
  billingAddress: string | null
  billingCity: string | null
  billingState: string | null
  billingStateCode: string | null
  billingPincode: string | null
  shippingAddress: string | null
  shippingCity: string | null
  shippingState: string | null
  shippingStateCode: string | null
  shippingPincode: string | null
  creditLimit: string | number | null
  creditDays: number
  brokerId: string | null
  brokeragePercent: string | number | null
  isBlacklisted: boolean
}

/** What the API says about a customer the moment they are picked. */
export interface CustomerContext {
  credit: {
    limit: number | null
    creditDays: number
    isBlacklisted: boolean
    unpaid: number
    overdue: number
    openOrders: number
  }
  placeOfSupply: { code: string; state: string; isIntraState: boolean } | null
  placeOfSupplyProblem: string | null
}

/** Address lines joined, skipping the empty ones. */
export function joinAddress(...parts: Array<string | null | undefined>): string {
  return parts.map((p) => p?.trim()).filter(Boolean).join(', ')
}

/** The billing address, in one line. */
export function billingAddressOf(c: CustomerOption): string {
  return joinAddress(c.billingAddress, c.billingCity, c.billingState, c.billingPincode)
}

/** Where the goods go: the shipping address, else the billing one. */
export function deliveryAddressOf(c: CustomerOption): string {
  return c.shippingAddress || c.shippingCity
    ? joinAddress(c.shippingAddress, c.shippingCity, c.shippingState, c.shippingPincode)
    : billingAddressOf(c)
}

/** The tax split in words, from the place of supply. */
export function taxModeWords(ctx: CustomerContext | null): string | null {
  if (!ctx?.placeOfSupply) return null
  return ctx.placeOfSupply.isIntraState ? 'Within the state · CGST + SGST' : 'Other state · IGST'
}

const STATES = Object.entries(GST_STATES).sort((a, b) => a[1].localeCompare(b[1]))

/**
 * The picked customer, read back: their GSTIN, where the goods are taxed, and
 * where they stand against their credit limit with this order on top.
 *
 * The place of supply starts as the customer's own shipping state. An order
 * delivered to another state picks that state here, and the tax split follows
 * it — CGST + SGST inside the mill's state, IGST outside it.
 *
 * The credit result is worked out here from the figures the API sent and the
 * order's running total, so it moves as lines are typed. Over the limit is a
 * warning, not a block (the business's answer of 9 Oct 2026).
 */
export function CustomerPanel({
  customer,
  context,
  loading,
  orderValue,
  placeOfSupply,
  onPlaceOfSupply,
}: {
  customer: CustomerOption
  context: CustomerContext | null
  loading: boolean
  /** This order's total with GST, as it stands on screen. */
  orderValue: number
  /** A state picked for this order, or '' for the customer's own. */
  placeOfSupply: string
  onPlaceOfSupply: (code: string) => void
}) {
  const credit = context?.credit
  const exposure = credit ? credit.unpaid + credit.openOrders + orderValue : 0
  const overBy = credit?.limit != null ? exposure - credit.limit : 0
  const taxMode = taxModeWords(context)

  return (
    <div className="border-border bg-secondary/30 space-y-2.5 rounded-lg border p-3">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <p className="text-muted-foreground text-xs">
          <span className="text-foreground font-medium">{customer.name}</span>
          {' · '}
          {customer.gstin ? (
            <>
              GSTIN <span className="font-mono">{customer.gstin}</span>
            </>
          ) : (
            'Not registered for GST'
          )}
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <label htmlFor="so-pos" className="text-muted-foreground text-xs">
            Place of supply
          </label>
          <SmartSelect
            id="so-pos"
            className="form-input h-8 w-56 py-0 text-xs"
            value={placeOfSupply || context?.placeOfSupply?.code || ''}
            onChange={(e) => onPlaceOfSupply(e.target.value)}
            title="The state the goods are delivered to. It decides CGST + SGST or IGST."
          >
            <option value="">{context?.placeOfSupplyProblem ? 'Pick the state' : 'The customer’s state'}</option>
            {STATES.map(([code, name]) => (
              <option key={code} value={code}>
                {code} · {name}
              </option>
            ))}
          </SmartSelect>
          {loading ? (
            <span className="text-muted-foreground flex items-center gap-1.5 text-xs">
              <Loader2 size={13} className="animate-spin" /> Checking...
            </span>
          ) : taxMode ? (
            <span className="badge-info whitespace-nowrap">{taxMode}</span>
          ) : context?.placeOfSupplyProblem ? (
            <span className="warn-text flex max-w-sm items-start gap-1.5 text-xs">
              <AlertCircle size={13} className="mt-px shrink-0" />
              {context.placeOfSupplyProblem}
            </span>
          ) : null}
        </div>
      </div>

      {credit && (
        <div className="border-border bg-border grid grid-cols-2 gap-px overflow-hidden rounded-lg border text-xs sm:grid-cols-5">
          {[
            ['Credit limit', credit.limit != null ? formatRupees(credit.limit) : 'No limit set'],
            [
              'Unpaid invoices',
              credit.overdue > 0
                ? `${formatRupees(credit.unpaid)} (${formatRupees(credit.overdue)} overdue)`
                : formatRupees(credit.unpaid),
            ],
            ['Other open orders', formatRupees(credit.openOrders)],
            ['Credit days', `${credit.creditDays} days`],
          ].map(([label, value]) => (
            <div key={label} className="bg-card px-3 py-2">
              <p className="text-muted-foreground text-[11px]">{label}</p>
              <p className="text-foreground font-medium tabular-nums">{value}</p>
            </div>
          ))}
          <div className="bg-card col-span-2 px-3 py-2 sm:col-span-1">
            <p className="text-muted-foreground text-[11px]">Credit check</p>
            {credit.isBlacklisted ? (
              <span className="badge-danger">Blacklisted · needs release</span>
            ) : credit.limit != null && overBy > 0 ? (
              <span className="badge-danger" title="A manager releases it when approving, with a reason">
                Over by {formatRupees(overBy)} · needs release
              </span>
            ) : (
              <span className="badge-success">Within limit</span>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
