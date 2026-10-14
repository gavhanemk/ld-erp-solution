/**
 * Inventory, as a handful of screens instead of a dozen menu lines.
 *
 * Each section is one entry in the sidebar; the screens that do the same kind
 * of work sit inside it as tabs. The pages keep their own addresses — a link
 * to Stock Documents still opens Stock Documents — they are only gathered
 * under one heading, with tabs to move between them.
 */
export interface InventorySection {
  label: string
  /** The tabs, in order; the first is where the sidebar entry goes. */
  tabs: Array<{ label: string; href: string }>
}

export const INVENTORY_SECTIONS: InventorySection[] = [
  { label: 'Dashboard', tabs: [{ label: 'Dashboard', href: '/inventory/dashboard' }] },
  {
    label: 'Stock',
    tabs: [
      { label: 'Stock', href: '/inventory/stock' },
      { label: 'Stock Documents', href: '/inventory/documents' },
      { label: 'Stock Ledger', href: '/inventory/ledger' },
    ],
  },
  { label: 'Material Requisitions', tabs: [{ label: 'Material Requisitions', href: '/inventory/requisitions' }] },
  {
    label: 'Stickers & Scan',
    tabs: [
      { label: 'Stickers', href: '/inventory/packages' },
      { label: 'Scan', href: '/inventory/scan' },
    ],
  },
  {
    label: 'Finished Goods',
    tabs: [
      { label: 'Finished Goods In', href: '/inventory/finished-goods' },
      { label: 'Garment Tags', href: '/inventory/garment-tags' },
      { label: 'Garment In / Out', href: '/inventory/garment-moves' },
      { label: 'Track & Trace', href: '/inventory/trace' },
    ],
  },
  {
    label: 'Job Work & Customer Goods',
    tabs: [
      { label: 'Job Work', href: '/inventory/job-work' },
      { label: 'Customer Material', href: '/inventory/customer-material' },
    ],
  },
]

/** The page and anything under it: /inventory/stock covers /inventory/stock/abc. */
export const onPage = (pathname: string, href: string) => pathname === href || pathname.startsWith(href + '/')

/** The section a page belongs to, if any. */
export const sectionOf = (pathname: string) => INVENTORY_SECTIONS.find((s) => s.tabs.some((t) => onPage(pathname, t.href)))
