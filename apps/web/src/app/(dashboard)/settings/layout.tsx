'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { Building2, Users, SlidersHorizontal, Activity } from 'lucide-react'
import { cn } from '@/lib/utils'

/**
 * Four tabs, in the order someone actually sets an ERP up: describe the
 * business, let people in, then adjust how it behaves, and finally check on it.
 */
const tabs = [
  {
    href: '/settings/company',
    label: 'Company',
    icon: Building2,
    description: 'Your details, financial year, document numbers and GST rates',
  },
  {
    href: '/settings/people',
    label: 'People',
    icon: Users,
    description: 'Who can sign in, and what each of them may do',
  },
  {
    href: '/settings/preferences',
    label: 'Preferences',
    icon: SlidersHorizontal,
    description: 'How the ERP behaves day to day',
  },
  {
    href: '/settings/system',
    label: 'System',
    icon: Activity,
    description: 'Connections and a record of every change',
  },
]

export default function SettingsLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname()
  const active = tabs.find((t) => pathname.startsWith(t.href))

  return (
    <div className="space-y-6">
      <div className="page-header">
        <div>
          <h1 className="page-title">Settings</h1>
          <p className="page-subtitle">
            {active?.description ?? 'Everything that configures how LD ERP works'}
          </p>
        </div>
      </div>

      <nav
        className="flex flex-wrap gap-1 p-1 rounded-xl border border-border bg-secondary/40 w-fit"
        aria-label="Settings sections"
      >
        {tabs.map((tab) => {
          const Icon = tab.icon
          const isActive = pathname.startsWith(tab.href)

          return (
            <Link
              key={tab.href}
              href={tab.href}
              aria-current={isActive ? 'page' : undefined}
              className={cn(
                'flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-colors',
                isActive
                  ? 'bg-teal-500/15 text-teal-400 border border-teal-500/25'
                  : 'text-muted-foreground hover:text-foreground border border-transparent',
              )}
            >
              <Icon size={15} />
              {tab.label}
            </Link>
          )
        })}
      </nav>

      {children}
    </div>
  )
}
