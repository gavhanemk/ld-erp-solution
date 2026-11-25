/**
 * Buying for a sample, as the purchase screens say it (sampling phase 3).
 *
 * An order line can name the sample BOM line it buys for — "the body fabric
 * for SMP-2627-0012" — and from then on two things follow it: the sample
 * counts it as ordered, and the goods may only be received into a sample
 * store, so a sample's cloth never lands in the main godown and gets cut for
 * production by mistake.
 *
 * Kept free of React and of anything the browser alone has, so the same
 * rules can be checked from a plain script without starting the web app.
 */

/** How the server names the sample line an order line buys for (`sampleLineSelect` in the API). */
export interface SampleMaterialRef {
  id: string
  component: string
  /** Null: every colour of the round. */
  colour: string | null
  round: { id: string; revision: number; request: { id: string; number: string } }
}

/**
 * "SMP-2627-0012 · Body", or "SMP-2627-0012 · Collar (White)" for a line
 * bought for one colour only.
 *
 * The part of the garment says which of the sample's materials this is far
 * better than the item does — two lines of the same rib can be the collar and
 * the cuffs. A line with no part named falls back to the item's own name
 * rather than reading "SMP-2627-0012 · ".
 */
export function sampleLineLabel(x: {
  requestNumber: string
  component: string
  colour: string | null
  itemName: string
}): string {
  const part = x.component.trim() || x.itemName.trim()
  const colour = x.colour?.trim()
  return `${x.requestNumber}${part ? ` · ${part}` : ''}${colour ? ` (${colour})` : ''}`
}

/** The same label, off the `sampleMaterial` the server sends on an order line. */
export function sampleLabelOf(
  m: Pick<SampleMaterialRef, 'component' | 'colour'> & { round: { request: { number: string } } },
  itemName: string
): string {
  return sampleLineLabel({
    requestNumber: m.round.request.number,
    component: m.component,
    colour: m.colour,
    itemName,
  })
}

/**
 * The order's reference, said from the samples its lines buy for: "Sample
 * SMP-2627-0012, SMP-2627-0015". Each sample once, however many of its lines
 * are on the order.
 *
 * Kept inside the 100 characters the reference box holds by naming as many as
 * fit and counting the rest — "+3 more" — the way the indent's reference does,
 * so the supplier's copy never shows a number cut off halfway.
 */
export function sampleReference(needs: Array<{ requestNumber: string }>, max = 100): string {
  const numbers = [...new Set(needs.map((n) => n.requestNumber).filter(Boolean))]
  if (!numbers.length) return ''
  const say = (keep: number) =>
    'Sample ' +
    (numbers.length > keep ? [...numbers.slice(0, keep), `+${numbers.length - keep} more`] : numbers).join(', ')
  for (let keep = numbers.length; keep >= 1; keep--) {
    const text = say(keep)
    if (text.length <= max) return text
  }
  return say(1).slice(0, max)
}

/** A sample store: a store kept for samples' material only. A store saying nothing is an ordinary one. */
export const isSampleStore = (s: { purpose?: string | null }) => (s.purpose ?? 'GENERAL') === 'SAMPLING'

/**
 * The stores a receipt line may go into.
 *
 * A sample's material goes into a sample store and nowhere else; everything
 * else goes anywhere but. The server refuses both the other way round, so
 * offering only these means the store keeper cannot pick a store the save
 * would then throw back at them.
 */
export function storesForLine<S extends { id: string; purpose?: string | null }>(
  stores: S[],
  isSampleLine: boolean
): S[] {
  return stores.filter((s) => isSampleStore(s) === isSampleLine)
}

/**
 * The store a receipt line starts in.
 *
 * Where the supplier was told to deliver, when that store can take this line.
 * Otherwise, for a sample's material the first sample store, and for anything
 * else whatever the screen's own rule picks (`fallback`, handed only the
 * stores the line may use) — so an order delivered to the sample store still
 * opens its ordinary lines in a store they can actually go into.
 */
export function defaultStoreFor<S extends { id: string; purpose?: string | null }>(
  stores: S[],
  isSampleLine: boolean,
  deliveryWarehouseId: string | null,
  fallback: (stores: S[]) => string
): string {
  const fitting = storesForLine(stores, isSampleLine)
  if (deliveryWarehouseId && fitting.some((s) => s.id === deliveryWarehouseId)) return deliveryWarehouseId
  return isSampleLine ? (fitting[0]?.id ?? '') : fallback(fitting)
}

const round3 = (n: number) => Math.round(n * 1000) / 1000

/**
 * Whether a line orders more than the sample still needed when it was picked.
 *
 * Only when that is known: an order reopened for editing does not know it,
 * because what the sample needs now already counts this order's own lines.
 * Compared to the thousandth, the same as the server, so 2.0004 metres
 * against 2 is not "more".
 */
export function needsOverReason(qty: number, open: number | null | undefined): boolean {
  if (open == null || !Number.isFinite(open) || !Number.isFinite(qty)) return false
  return round3(qty) > round3(open)
}
