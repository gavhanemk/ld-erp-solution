'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { onPage, sectionOf } from '@/components/layout/inventorySections'

/**
 * The tabs across the top of an inventory screen: the other screens in the
 * same section — Stock, Stock Documents and the Stock Ledger
 * are one section, the garment screens another. A section of one screen has
 * no tabs.
 */
export default function InventoryLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname()
  const section = sectionOf(pathname)

  return (
    <>
      {section && section.tabs.length > 1 && (
        <nav className="-mt-1 mb-4 flex gap-1 overflow-x-auto border-b border-border" aria-label={section.label}>
          {section.tabs.map((t) => {
            const active = onPage(pathname, t.href)
            return (
              <Link
                key={t.href}
                href={t.href}
                aria-current={active ? 'page' : undefined}
                // On a phone the row scrolls: the tab you are on is the one to see.
                ref={active ? (el) => el?.scrollIntoView({ block: 'nearest', inline: 'center' }) : undefined}
                className={`-mb-px whitespace-nowrap border-b-2 px-3 py-2 text-sm font-semibold transition-colors ${
                  active ? 'border-primary text-primary' : 'border-transparent text-muted-foreground hover:text-foreground'
                }`}
              >
                {t.label}
              </Link>
            )
          })}
        </nav>
      )}
      {children}
    </>
  )
}
