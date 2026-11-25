'use client'

import type { ReactNode } from 'react'
import Link from 'next/link'
import { AlertCircle, ArrowLeft, ArrowRight, Check, CheckCircle2, type LucideIcon } from 'lucide-react'
import { cn } from '@/lib/utils'

/*
 * The frame the opening stock pages share, so adding by hand and importing
 * from Excel read as one flow: a heading with the steps under it, panels
 * with a titled head, figure tiles, the cards a kind is picked from, and the
 * finished card.
 */

/** The page's heading: back to Opening Stock, its title and line, and where in the steps it is. */
export function PageHead({ title, subtitle, steps, current }: { title: string; subtitle?: string; steps: string[]; current: number }) {
  return (
    <header className="space-y-4">
      <div className="min-w-0">
        <Link href="/inventory/opening-stock" className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1 text-xs font-medium">
          <ArrowLeft size={12} /> Opening Stock
        </Link>
        <h1 className="page-title mt-1">{title}</h1>
        {subtitle && <p className="page-subtitle">{subtitle}</p>}
      </div>
      <nav className="glass-card px-5 py-3.5" aria-label="Progress">
        <Stepper steps={steps} current={current} />
      </nav>
    </header>
  )
}

/** The steps in a line: those done ticked, this one marked, the rest to come. */
export function Stepper({ steps, current }: { steps: string[]; current: number }) {
  return (
    <ol className="flex items-center" aria-label="Steps">
      {steps.map((label, i) => {
        const done = i < current
        const here = i === current
        return (
          <li key={label} className={cn('flex items-center gap-2.5', i < steps.length - 1 && 'flex-1')} aria-current={here ? 'step' : undefined}>
            <span
              className={cn(
                'flex h-7 w-7 shrink-0 items-center justify-center rounded-full border text-xs font-semibold tabular-nums transition-colors',
                done && 'border-primary bg-primary text-primary-foreground',
                here && 'border-primary bg-primary/10 text-primary ring-primary/15 ring-4',
                !done && !here && 'border-border text-muted-foreground',
              )}
            >
              {done ? <Check size={14} strokeWidth={3} /> : i + 1}
            </span>
            <span className={cn('whitespace-nowrap text-sm', here ? 'text-foreground font-semibold' : done ? 'text-foreground' : 'text-muted-foreground', !here && 'hidden md:inline')}>
              {label}
            </span>
            {i < steps.length - 1 && <span className={cn('mx-2 h-px min-w-4 flex-1', done ? 'bg-primary' : 'bg-border')} aria-hidden />}
          </li>
        )
      })}
    </ol>
  )
}

/** A section of the page: a titled head (with its icon, a line under it and actions at the right), then its body. */
export function Panel({
  icon: Icon,
  title,
  description,
  actions,
  children,
  className,
  bodyClassName,
  label,
}: {
  icon?: LucideIcon
  title?: ReactNode
  description?: ReactNode
  actions?: ReactNode
  children?: ReactNode
  className?: string
  bodyClassName?: string
  label?: string
}) {
  return (
    <section className={cn('glass-card overflow-hidden', className)} aria-label={label}>
      {title && (
        <div className="border-border flex flex-wrap items-center gap-3 border-b px-5 py-3.5">
          {Icon && (
            <span className="bg-primary/10 text-primary flex h-9 w-9 shrink-0 items-center justify-center rounded-lg">
              <Icon size={18} />
            </span>
          )}
          <div className="min-w-0 flex-1">
            <h2 className="text-foreground text-sm font-semibold">{title}</h2>
            {description && <p className="text-muted-foreground mt-0.5 text-xs">{description}</p>}
          </div>
          {actions}
        </div>
      )}
      {children !== undefined && <div className={cn('p-5', bodyClassName)}>{children}</div>}
    </section>
  )
}

/** A labelled box: its name above (a * when it must be filled), a line of help under. */
export function Field({ label, required, hint, className, children }: { label: string; required?: boolean; hint?: ReactNode; className?: string; children: ReactNode }) {
  return (
    <label className={cn('block space-y-1.5', className)}>
      <span className="text-foreground block text-xs font-semibold">
        {label}
        {required && <span className="text-primary"> *</span>}
      </span>
      {children}
      {hint && <span className="text-muted-foreground block text-[11px] leading-snug">{hint}</span>}
    </label>
  )
}

/** A small labelled box for a bar: its name in small type above, nothing under. */
export function MiniField({ label, required, className, children }: { label: string; required?: boolean; className?: string; children: ReactNode }) {
  return (
    <label className={cn('flex min-w-0 flex-col gap-1', className)}>
      <span className="text-muted-foreground text-[11px] font-semibold">
        {label}
        {required && <span className="text-primary"> *</span>}
      </span>
      {children}
    </label>
  )
}

/** Figures in a row of tiles. */
export function Stats({ children, label }: { children: ReactNode; label?: string }) {
  return (
    <dl className="grid grid-cols-2 gap-3 md:grid-cols-4" aria-label={label}>
      {children}
    </dl>
  )
}
export function StatTile({ label, value, tone, hint }: { label: string; value: ReactNode; tone?: 'good' | 'bad'; hint?: ReactNode }) {
  return (
    <div className="border-border bg-card rounded-lg border px-4 py-3">
      <dt className="text-muted-foreground text-[11px] font-semibold uppercase tracking-wide">{label}</dt>
      <dd className={cn('text-foreground mt-1 text-xl font-semibold tabular-nums', tone === 'good' && 'text-emerald-500', tone === 'bad' && 'text-red-400')}>{value}</dd>
      {hint && <dd className="text-muted-foreground mt-0.5 text-[11px]">{hint}</dd>}
    </div>
  )
}

/** A card to pick what is entered or imported. */
export function ChoiceCard({
  icon: Icon,
  label,
  short,
  text,
  cta,
  ariaLabel,
  onClick,
  children,
}: {
  icon: LucideIcon
  label: string
  short: string
  text: string
  cta: string
  ariaLabel: string
  onClick: () => void
  children?: ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="glass-card hover:border-primary/60 group flex h-full flex-col p-5 text-left transition-[border-color,box-shadow] hover:shadow-lg"
      aria-label={ariaLabel}
    >
      <div className="flex items-start justify-between gap-3">
        <span className="bg-primary/10 text-primary flex h-11 w-11 items-center justify-center rounded-xl">
          <Icon size={22} />
        </span>
        <span className="border-border text-muted-foreground rounded-md border px-1.5 py-0.5 font-mono text-[11px] font-semibold">{short}</span>
      </div>
      <h3 className="text-foreground mt-4 text-base font-semibold">{label}</h3>
      <p className="text-muted-foreground mt-1 text-sm leading-relaxed">{text}</p>
      {children && <div className="mt-4 space-y-3">{children}</div>}
      <span className="text-primary mt-auto flex items-center gap-1.5 pt-5 text-sm font-semibold">
        {cta} <ArrowRight size={15} className="transition-transform group-hover:translate-x-0.5" />
      </span>
    </button>
  )
}

/** The finished card: what went in, its number, its figures and what to do next. */
export function DoneCard({ title, message, stats, children, actions }: { title: ReactNode; message?: ReactNode; stats?: ReactNode; children?: ReactNode; actions: ReactNode }) {
  return (
    <section className="glass-card space-y-5 p-6" aria-label="Done">
      <div className="flex items-start gap-4">
        <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-emerald-500/15 text-emerald-500">
          <CheckCircle2 size={26} />
        </span>
        <div className="min-w-0 space-y-1">
          <h2 className="text-foreground text-lg font-semibold">{title}</h2>
          {message && (
            <p className="text-muted-foreground text-sm" role="status">
              {message}
            </p>
          )}
        </div>
      </div>
      {stats}
      {children}
      <div className="border-border flex flex-wrap items-center gap-2 border-t pt-5">{actions}</div>
    </section>
  )
}

/** A line across the page: something wrong, something to know, or a note. */
export function Banner({ tone, children, action }: { tone: 'bad' | 'warn' | 'info'; children: ReactNode; action?: ReactNode }) {
  return (
    <div
      className={cn(
        'flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border px-4 py-2.5 text-sm',
        tone === 'bad' && 'border-red-500/30 bg-red-500/10 text-red-400',
        tone === 'warn' && 'border-amber-500/30 bg-amber-500/10 text-amber-600',
        tone === 'info' && 'border-primary/30 bg-primary/5 text-foreground',
      )}
      role={tone === 'bad' ? 'alert' : 'status'}
    >
      <AlertCircle size={15} className={cn('shrink-0', tone === 'info' && 'text-primary')} />
      <span className="min-w-0 flex-1">{children}</span>
      {action}
    </div>
  )
}
