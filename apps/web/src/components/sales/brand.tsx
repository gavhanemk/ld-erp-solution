'use client'

import { api } from '@/lib/api'
import { cn } from '@/lib/utils'

/** One of the mill's own brands (Masters → In House Brands): what an order is made under. */
export interface OwnBrand {
  id: string
  name: string
  type: string
  /** Short: LD, ST, VH. */
  code?: string | null
  /** The brand B2B and job work go under, and the one an order falls back to: LD Cotton Mills. */
  isDefault?: boolean
}

/** The own brands an order's Brand box offers, switched-off ones left out. */
export async function loadInHouseBrands(): Promise<OwnBrand[]> {
  const res = await api.get<{ data: OwnBrand[] }>('/masters/brands?active=true&type=LD_COTTON_MILLS,VHAGAR&limit=100')
  return [...res.data].sort((a, b) => a.name.localeCompare(b.name))
}

/** The default brand: the one marked so, else the one named LD Cotton Mills, else the first. */
const defaultOf = (brands: OwnBrand[]) => brands.find((b) => b.isDefault) ?? brands.find((b) => /ld\s*cotton/i.test(b.name)) ?? brands[0]

/**
 * The brand an order starts under until someone picks one: the brand every
 * garment's style belongs to, when they all belong to one of ours; else —
 * a mix, a customer's label, a garment with no style, job work — the default
 * brand. The same rule the server uses when none is sent.
 */
export function suggestedBrand(brands: OwnBrand[], lineBrandIds: Array<string | null | undefined>, isJobWork: boolean): string {
  const fallback = defaultOf(brands)?.id ?? ''
  if (isJobWork || !lineBrandIds.length) return fallback
  const own = new Set(brands.map((b) => b.id))
  const first = lineBrandIds[0]
  return first && own.has(first) && lineBrandIds.every((id) => id === first) ? first : fallback
}

/**
 * The garments on the order that are another of our own brands' styles than
 * the one picked: an order carries one brand, so it cannot be saved with them.
 */
export function otherBrandLines(brand: OwnBrand | undefined, lineBrandIds: Array<string | null | undefined>, brands: OwnBrand[]): number {
  if (!brand) return 0
  const own = new Set(brands.map((b) => b.id))
  return lineBrandIds.filter((id) => id && own.has(id) && id !== brand.id).length
}

/** An order's brand, as a small tag: VHAGAR in its own colour, LD Cotton Mills quiet. */
export function BrandTag({ brand, className }: { brand?: { name: string; type?: string | null } | null; className?: string }) {
  if (!brand?.name) return null
  return (
    <span
      className={cn(
        'inline-flex items-center rounded border px-1.5 py-px text-[10px] font-bold uppercase leading-4 tracking-wide',
        brand.type === 'VHAGAR' ? 'vhagar-accent border-current' : 'border-border text-muted-foreground',
        className,
      )}
      title={`Brand: ${brand.name}`}
    >
      {brand.name}
    </span>
  )
}
