'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { cn } from '@/lib/utils'
import { canOpen, useAccess } from '@/lib/access'
import { SETTINGS_SECTIONS as tabs, SectionHeader } from '@/components/settings/sections'

/**
 * Settings as a two-pane screen: the sections down the left, the open one on
 * the right under its own name. Seven tabs in a row across the top left no
 * room to say what each one held, and the open section's name sat in a
 * subtitle under "Settings" where nobody looked for it.
 *
 * On a phone the menu folds back into a row that scrolls sideways.
 */
export default function SettingsLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname()
  useAccess() // re-draw when the access arrives
  // Only the sections this role may open (Settings → People decides).
  const visible = tabs.filter((t) => canOpen(t.href))
  const active = tabs.find((t) => pathname.startsWith(t.href))

  return (
    <div className="space-y-5">
      <div className="page-header">
        <div>
          <h1 className="page-title">Settings</h1>
          <p className="page-subtitle">Set up the company, the people who use the ERP, and how it works</p>
        </div>
      </div>

      <div className="grid items-start gap-5 lg:grid-cols-[15.5rem_minmax(0,1fr)]">
        <nav
          aria-label="Settings sections"
          className="border-border bg-card no-scrollbar flex gap-1 overflow-x-auto rounded-xl border p-1.5 shadow-sm lg:sticky lg:top-4 lg:flex-col lg:overflow-visible"
        >
          {visible.map((tab) => {
            const Icon = tab.icon
            const isActive = pathname.startsWith(tab.href)
            return (
              <Link
                key={tab.href}
                href={tab.href}
                aria-current={isActive ? 'page' : undefined}
                className={cn(
                  'group flex shrink-0 items-center gap-3 rounded-lg px-3 py-2 transition-colors',
                  isActive ? 'bg-primary/10 text-primary' : 'text-muted-foreground hover:bg-secondary hover:text-foreground',
                )}
              >
                <span
                  className={cn(
                    'flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border transition-colors',
                    isActive ? 'border-primary/30 bg-primary/15' : 'border-border bg-secondary/60 group-hover:bg-card',
                  )}
                >
                  <Icon size={15} />
                </span>
                <span className="min-w-0">
                  <span className={cn('block whitespace-nowrap text-sm font-medium', isActive ? 'text-primary' : 'text-foreground')}>
                    {tab.label}
                  </span>
                  <span className="text-muted-foreground hidden truncate text-[11px] leading-tight lg:block">{tab.short}</span>
                </span>
              </Link>
            )
          })}
        </nav>

        <div className="min-w-0 space-y-5">
          {/* A section that has figures or tabs to show draws its own header. */}
          {active && !('ownHeader' in active && active.ownHeader) && <SectionHeader />}
          {children}
        </div>
      </div>
    </div>
  )
}
