'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import {
  Building2,
  Users,
  SlidersHorizontal,
  Activity,
  Sparkles,
  FileText,
  Trash2,
} from 'lucide-react'
import { cn } from '@/lib/utils'

/**
 * In the order someone actually sets an ERP up: describe the business, let
 * people in, decide what your paperwork says, adjust how it behaves, connect
 * the assistant, and finally check on it.
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
    href: '/settings/documents',
    label: 'Documents',
    icon: FileText,
    description: 'What appears on your printed invoices, orders and challans',
  },
  {
    href: '/settings/preferences',
    label: 'Preferences',
    icon: SlidersHorizontal,
    description: 'How the ERP behaves day to day',
  },
  {
    href: '/settings/assistant',
    label: 'Assistant',
    icon: Sparkles,
    description: 'Connect the AI assistant and decide what it may do',
  },
  {
    href: '/settings/recycle-bin',
    label: 'Recycle Bin',
    icon: Trash2,
    description: 'Documents that were deleted, and how to put them back',
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
        className="border-border bg-secondary/40 flex w-fit flex-wrap gap-1 rounded-xl border p-1"
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
                'flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-medium transition-colors',
                isActive
                  ? 'border border-teal-500/25 bg-teal-500/15 text-teal-400'
                  : 'text-muted-foreground hover:text-foreground border border-transparent'
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
