'use client'

import { usePathname } from 'next/navigation'
import { Activity, Building2, FileText, Sparkles, SlidersHorizontal, Trash2, Users } from 'lucide-react'

/**
 * The sections of Settings, in the order someone actually sets an ERP up:
 * describe the business, let people in, decide what your paperwork says,
 * adjust how it behaves, connect the assistant, and finally check on it.
 *
 * `ownHeader`: the page draws its own SectionHeader, with figures and tabs in
 * it, instead of the plain one the Settings layout puts above every page.
 */
export const SETTINGS_SECTIONS = [
  {
    href: '/settings/company',
    label: 'Company',
    icon: Building2,
    short: 'Details, numbering, tax',
    description: 'Your details, financial year, document numbers, GST rates and TDS sections',
    ownHeader: true,
  },
  {
    href: '/settings/people',
    label: 'People',
    icon: Users,
    short: 'Sign-ins and roles',
    description: 'Who can sign in, and what each of them may do',
    ownHeader: true,
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
] as const

/**
 * The head of a Settings section, as one card: its name and what it is for on
 * the left, anything worth knowing at a glance on the right, and a strip
 * underneath for the section's tabs and its main button.
 *
 * It replaced a title floating over the page with nothing beside it, then a
 * row of tabs, then a card with a title of its own — three headings, each a
 * short line across a wide screen, so the top of the page read as empty.
 */
export function SectionHeader({ right, below }: { right?: React.ReactNode; below?: React.ReactNode }) {
  const pathname = usePathname()
  const section = SETTINGS_SECTIONS.find((s) => pathname.startsWith(s.href))
  if (!section) return null
  const Icon = section.icon
  return (
    <div className="border-border bg-card overflow-hidden rounded-xl border shadow-sm">
      <div className="flex flex-wrap items-center gap-x-6 gap-y-4 px-5 py-4">
        <div className="flex min-w-0 flex-1 items-center gap-3.5">
          <span className="bg-primary/10 border-primary/20 text-primary flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border">
            <Icon size={20} />
          </span>
          <div className="min-w-0">
            <h2 className="text-foreground text-lg font-semibold leading-tight">{section.label}</h2>
            <p className="text-muted-foreground mt-0.5 text-sm">{section.description}</p>
          </div>
        </div>
        {right && <div className="flex flex-wrap items-center gap-2">{right}</div>}
      </div>
      {below && (
        <div className="border-border/70 bg-secondary/30 flex flex-wrap items-center gap-3 border-t px-5 py-2.5">{below}</div>
      )}
    </div>
  )
}

/** A figure in a section header: the number above, what it counts below. */
export function HeaderStat({ value, label, tone }: { value: React.ReactNode; label: string; tone?: 'amber' | 'emerald' | 'muted' }) {
  return (
    <div className="border-border/70 min-w-[92px] rounded-lg border px-3.5 py-2">
      <p
        className={`text-lg font-semibold tabular-nums leading-none ${
          tone === 'amber' ? 'text-amber-500' : tone === 'emerald' ? 'text-emerald-500' : tone === 'muted' ? 'text-muted-foreground' : 'text-foreground'
        }`}
      >
        {value}
      </p>
      <p className="text-muted-foreground mt-1 text-[11px]">{label}</p>
    </div>
  )
}
