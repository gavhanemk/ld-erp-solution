'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'

/**
 * Routing Masters: what a routing is built from, on one screen with a tab
 * each — the processes, the lines and tables each one runs on, and the
 * contractors who do them. Each tab keeps its own address, so a link to the
 * contractors still opens the contractors.
 */
export const ROUTING_MASTER_TABS = [
  { label: 'Processes', href: '/masters/processes' },
  { label: 'Lines & tables', href: '/masters/workstations' },
  { label: 'Contractors', href: '/masters/contractors' },
]

export function RoutingMastersTabs() {
  const pathname = usePathname()
  return (
    <nav className="border-border -mt-1 mb-4 flex items-center gap-1 overflow-x-auto border-b" aria-label="Routing Masters">
      <span className="text-muted-foreground mr-2 whitespace-nowrap py-2 text-xs font-semibold uppercase tracking-wide">Routing Masters</span>
      {ROUTING_MASTER_TABS.map((t) => {
        const active = pathname === t.href || pathname.startsWith(t.href + '/')
        return (
          <Link
            key={t.href}
            href={t.href}
            aria-current={active ? 'page' : undefined}
            className={`-mb-px whitespace-nowrap border-b-2 px-3 py-2 text-sm font-semibold transition-colors ${
              active ? 'border-primary text-primary' : 'text-muted-foreground hover:text-foreground border-transparent'
            }`}
          >
            {t.label}
          </Link>
        )
      })}
    </nav>
  )
}
