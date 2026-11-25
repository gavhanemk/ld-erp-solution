'use client'

import { api } from '@/lib/api'
import { cn } from '@/lib/utils'

/** One of the mill's own brands (Masters → In House Brands): what an order is made under. */
export interface OwnBrand {
  id: string
  name: string
  type: 'LD_COTTON_MILLS' | 'VHAGAR'
}

/** The own brands an order's Brand box offers, switched-off ones left out. */
export async function loadInHouseBrands(): Promise<OwnBrand[]> {
  const res = await api.get<{ data: OwnBrand[] }>('/masters/brands?active=true&type=LD_COTTON_MILLS,VHAGAR&limit=100')
  return [...res.data].sort((a, b) => a.name.localeCompare(b.name))
}

/** The company's own brand of a kind: the one named for it, else the first. */
const mainOf = (brands: OwnBrand[], type: OwnBrand['type'], name: RegExp) => brands.find((b) => b.type === type && name.test(b.name)) ?? brands.find((b) => b.type === type)

/**
 * The brand an order starts under until someone picks one: VHAGAR when every
 * garment on it is a VHAGAR style, else LD Cotton Mills — job work always LD
 * Cotton Mills. The same rule the server uses when none is sent.
 */
export function suggestedBrand(brands: OwnBrand[], lineTypes: Array<string | null | undefined>, isJobWork: boolean): string {
  const own = mainOf(brands, 'LD_COTTON_MILLS', /ld\s*cotton/i) ?? brands[0]
  const vhagar = mainOf(brands, 'VHAGAR', /vhagar/i)
  if (!vhagar || isJobWork || !lineTypes.length) return own?.id ?? ''
  return lineTypes.every((t) => t === 'VHAGAR') ? vhagar.id : (own?.id ?? '')
}

/** How many garments on the order are another brand's styles than the one picked. */
export function otherBrandLines(brand: OwnBrand | undefined, lineTypes: Array<string | null | undefined>): number {
  if (!brand) return 0
  return lineTypes.filter((t) => t && t !== brand.type).length
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
