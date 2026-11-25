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
    short: 'Details, numbering, tax',
    description: 'Your details, financial year, document numbers, GST rates and TDS sections',
  },
  {
    href: '/settings/people',
    label: 'People',
    icon: Users,
    short: 'Sign-ins and roles',
    description: 'Who can sign in, and what each of them may do',
  },
  {
    href: '/settings/documents',
    label: 'Documents',
    icon: FileText,
    short: 'Letterhead and print options',
    description: 'What appears on your printed invoices, orders and challans',
  },
  {
    href: '/settings/preferences',
    label: 'Preferences',
    icon: SlidersHorizontal,
    short: 'How the ERP behaves',
    description: 'How the ERP behaves day to day',
  },
  {
    href: '/settings/assistant',
    label: 'Assistant',
    icon: Sparkles,
    short: 'AI key and permissions',
    description: 'Connect the AI assistant and decide what it may do',
  },
  {
    href: '/settings/recycle-bin',
    label: 'Recycle Bin',
    icon: Trash2,
    short: 'Deleted documents',
    description: 'Documents that were deleted, and how to put them back',
  },
  {
    href: '/settings/system',
    label: 'System',
    icon: Activity,
    short: 'Status, password, activity',
    description: 'Connections, your password, and a record of every change',
  },
]

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
  const active = tabs.find((t) => pathname.startsWith(t.href))
  const ActiveIcon = active?.icon

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
          {tabs.map((tab) => {
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
          {active && ActiveIcon && (
            <div className="flex items-center gap-3">
              <span className="bg-primary/10 border-primary/20 text-primary flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border">
                <ActiveIcon size={19} />
              </span>
              <div className="min-w-0">
                <h2 className="text-foreground text-lg font-semibold leading-tight">{active.label}</h2>
                <p className="text-muted-foreground text-sm">{active.description}</p>
              </div>
            </div>
          )}
          {children}
        </div>
      </div>
    </div>
  )
}
