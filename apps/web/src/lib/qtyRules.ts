'use client'

import { useEffect, useState } from 'react'
import { fitsPlaces, MAX_QTY_PLACES, placesMessage, qtyProblem, roundDownToPlaces, roundUpToPlaces } from '@ld-erp/shared'
import { api } from '@/lib/api'

/**
 * How finely each item may be counted, for the quantity boxes on any screen.
 *
 * Most screens only know an item's unit symbol ("pcs", "mtr"), not how its
 * unit is counted, so this reads it once — every unit, and the few items set
 * to differ from their unit — from GET /masters/qty-places and keeps it for a
 * minute. The API refuses a quantity that does not fit whatever the screen
 * shows; this only lets the screen say so beside the box first.
 */
interface QtyPlaces {
  units: Record<string, number>
  unitsById: Record<string, number>
  items: Record<string, number>
}

let cached: { at: number; data: Promise<QtyPlaces | null> } | null = null
const load = () => {
  if (!cached || Date.now() - cached.at > 60_000) {
    cached = {
      at: Date.now(),
      data: api
        .get<{ data: QtyPlaces }>('/masters/qty-places')
        .then((r) => r.data)
        .catch(() => null),
    }
  }
  return cached.data
}

/** Whatever a screen knows of an item: its id, its own setting, its unit (by symbol, id or with its setting). */
export interface ItemLike {
  id?: string | null
  itemId?: string | null
  decimalPlaces?: number | null
  uomId?: string | null
  uom?: { symbol?: string | null; decimalPlaces?: number | null } | null
}

export function placesFrom(rules: QtyPlaces | null, item: ItemLike | null | undefined): number {
  if (!item) return MAX_QTY_PLACES
  const id = item.id ?? item.itemId ?? undefined
  const own = item.decimalPlaces ?? (id ? rules?.items[id] : undefined)
  if (own != null) return own
  const unit =
    item.uom?.decimalPlaces ??
    (item.uom?.symbol ? rules?.units[item.uom.symbol] : undefined) ??
    (item.uomId ? rules?.unitsById[item.uomId] : undefined)
  return unit ?? MAX_QTY_PLACES
}

/** The rules for the quantity boxes on this screen: places, the message under a box, and rounding. */
export function useQtyRules() {
  const [rules, setRules] = useState<QtyPlaces | null>(null)
  useEffect(() => {
    let live = true
    void load().then((r) => live && setRules(r))
    return () => {
      live = false
    }
  }, [])
  const places = (item: ItemLike | null | undefined) => placesFrom(rules, item)
  return {
    places,
    /** What is wrong with a typed quantity for this item, or null. */
    problem: (value: string | number | null | undefined, item: ItemLike | null | undefined, opts?: { allowZero?: boolean }) =>
      qtyProblem(value, { decimalPlaces: places(item) }, opts),
    /** Just the places rule (no zero / blank rules): for boxes where nought means "none". */
    placesProblem: (value: string | number | null | undefined, item: ItemLike | null | undefined) => {
      const v = Number(value)
      if (value == null || String(value).trim() === '' || !Number.isFinite(v) || v === 0) return null
      const p = places(item)
      return fitsPlaces(v, p) ? null : placesMessage(p)
    },
    up: (qty: number, item: ItemLike | null | undefined) => roundUpToPlaces(qty, places(item)),
    down: (qty: number, item: ItemLike | null | undefined) => roundDownToPlaces(qty, places(item)),
  }
}
