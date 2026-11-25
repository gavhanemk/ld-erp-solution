'use client'

import { AlertCircle, CheckCircle2, Info, Loader2, type LucideIcon } from 'lucide-react'
import { cn } from '@/lib/utils'

/**
 * The small pieces every Settings screen is built from.
 *
 * They wear the purchase forms' clothes on purpose — a titled panel with its
 * icon, labels in the body size, fields in even columns — so Settings reads
 * as part of the same application rather than a page from another one. The
 * fields used to run the full width of the screen, two to a row at best: a
 * 1,500px box for a two-digit state code, and rows that broke up unevenly
 * (an email alone on half a row, the website across all of it).
 */

export function SettingsCard({
  title,
  description,
  icon: Icon,
  children,
  actions,
  footer,
  flush = false,
  id,
}: {
  title: string
  description?: React.ReactNode
  /** The tile at the head of the panel, as on the purchase forms. */
  icon?: LucideIcon
  children: React.ReactNode
  /** Rendered top-right, usually an "Add" button. */
  actions?: React.ReactNode
  /** A strip under the body, for the panel's own Save. */
  footer?: React.ReactNode
  /** No padding round the body, for a table that runs edge to edge. */
  flush?: boolean
  id?: string
}) {
  return (
    <section id={id} className="border-border bg-card scroll-mt-4 overflow-hidden rounded-xl border shadow-sm">
      <header className="border-border/70 flex flex-wrap items-center justify-between gap-3 border-b px-5 py-3.5">
        <div className="flex min-w-0 items-center gap-3">
          {Icon && (
            <span className="bg-primary/10 border-primary/20 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border">
              <Icon size={16} className="text-primary" />
            </span>
          )}
          <div className="min-w-0">
            <h2 className="text-foreground text-[15px] font-semibold leading-tight">{title}</h2>
            {description && <p className="text-muted-foreground mt-1 text-xs leading-snug">{description}</p>}
          </div>
        </div>
        {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
      </header>
      <div className={flush ? undefined : 'p-5'}>{children}</div>
      {footer && (
        <div className="border-border/70 bg-secondary/30 flex flex-wrap items-center justify-end gap-3 border-t px-5 py-3">
          {footer}
        </div>
      )}
    </section>
  )
}

/**
 * Fields in even columns: one on a phone, two on a tablet, and three (or
 * four) on a desktop, so a box is about as wide as what goes in it.
 */
export function FieldGrid({
  cols = 3,
  children,
  className,
}: {
  cols?: 2 | 3 | 4
  children: React.ReactNode
  className?: string
}) {
  return (
    <div
      className={cn(
        'grid grid-cols-1 gap-x-5 gap-y-4 sm:grid-cols-2',
        cols === 3 && 'lg:grid-cols-3',
        cols === 4 && 'lg:grid-cols-3 xl:grid-cols-4',
        className,
      )}
    >
      {children}
    </div>
  )
}

const SPAN: Record<string, string> = {
  '2': 'sm:col-span-2',
  '3': 'sm:col-span-2 lg:col-span-3',
  full: 'col-span-full',
}

export function Field({
  label,
  htmlFor,
  error,
  help,
  required,
  span,
  children,
}: {
  label: string
  htmlFor?: string
  error?: string
  help?: React.ReactNode
  required?: boolean
  /** How many columns of a FieldGrid this field takes. */
  span?: 1 | 2 | 3 | 'full'
  children: React.ReactNode
}) {
  return (
    <div className={cn('min-w-0', span && span !== 1 ? SPAN[String(span)] : undefined)}>
      <label className="form-label" htmlFor={htmlFor}>
        {label}
        {required && <span className="ml-0.5 text-red-400">*</span>}
      </label>
      {children}
      {error ? (
        <p className="mt-1.5 text-xs text-red-500">{error}</p>
      ) : help ? (
        <p className="text-muted-foreground mt-1.5 text-xs leading-snug">{help}</p>
      ) : null}
    </div>
  )
}

/** A sub-heading inside a panel, for a group of fields that belong together. */
export function FieldGroup({
  title,
  description,
  children,
}: {
  title: string
  description?: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <div className="border-border/70 space-y-4 border-t pt-5 first:border-t-0 first:pt-0">
      <div>
        <h3 className="text-foreground text-sm font-semibold">{title}</h3>
        {description && <p className="text-muted-foreground mt-0.5 text-xs leading-snug">{description}</p>}
      </div>
      {children}
    </div>
  )
}

/**
 * The bar a long settings form saves from. It stays at the foot of the
 * screen while the form scrolls, so the button is never four panels away
 * from the field just changed. Ctrl+S presses it.
 */
export function SaveBar({
  saving,
  disabled,
  note,
  label = 'Save changes',
}: {
  saving: boolean
  disabled?: boolean
  note?: React.ReactNode
  label?: React.ReactNode
}) {
  return (
    <div className="border-border bg-card/95 sticky bottom-3 z-10 flex flex-wrap items-center justify-between gap-3 rounded-xl border px-5 py-3 shadow-lg backdrop-blur">
      <p className="text-muted-foreground flex min-w-0 items-center gap-2 text-xs">
        <Info size={14} className="shrink-0" />
        {note ?? 'Changes apply for everyone as soon as they are saved.'}
      </p>
      <button type="submit" className="btn-primary" disabled={saving || disabled} data-hotkey="save">
        {saving && <Loader2 size={15} className="animate-spin" />}
        {label}
      </button>
    </div>
  )
}

/** A banner that says what happened, in the words the API used. */
export function Notice({
  kind,
  children,
  action,
}: {
  kind: 'success' | 'error' | 'info'
  children: React.ReactNode
  /** A button at the right — "Try again" on a failed load. */
  action?: React.ReactNode
}) {
  const style = {
    success: 'border-emerald-500/40 bg-emerald-500/5 text-emerald-500',
    error: 'border-red-500/40 bg-red-500/5 text-red-500',
    info: 'border-primary/40 bg-primary/5 text-primary',
  }[kind]

  const Icon = kind === 'success' ? CheckCircle2 : AlertCircle

  return (
    <div className={cn('flex items-start gap-3 rounded-lg border p-3 text-sm', style)} role={kind === 'error' ? 'alert' : 'status'}>
      <Icon size={16} className="mt-0.5 shrink-0" />
      <div className="flex-1">{children}</div>
      {action}
    </div>
  )
}

export function SaveButton({
  saving,
  disabled,
  children = 'Save changes',
}: {
  saving: boolean
  disabled?: boolean
  children?: React.ReactNode
}) {
  return (
    <button type="submit" className="btn-primary" disabled={saving || disabled}>
      {saving && <Loader2 size={15} className="animate-spin" />}
      {children}
    </button>
  )
}

export function LoadingRow({ label = 'Loading...' }: { label?: string }) {
  return (
    <div className="text-muted-foreground flex items-center gap-2 py-6 text-sm">
      <Loader2 size={15} className="animate-spin" />
      {label}
    </div>
  )
}

/**
 * One on/off setting as a row: its name and what it does on the left, the
 * switch on the right.
 */
export function ToggleRow({
  label,
  description,
  checked,
  onChange,
  disabled,
}: {
  label: string
  description?: React.ReactNode
  checked: boolean
  onChange: (v: boolean) => void
  disabled?: boolean
}) {
  return (
    <div className="border-border/70 flex items-start justify-between gap-4 rounded-lg border px-4 py-3">
      <div className="min-w-0">
        <p className="text-foreground text-sm font-medium">{label}</p>
        {description && <p className="text-muted-foreground mt-0.5 text-xs leading-snug">{description}</p>}
      </div>
      <Toggle checked={checked} onChange={onChange} label={label} disabled={disabled} />
    </div>
  )
}

/** An accessible on/off switch. Checkboxes read as data entry; this reads as a setting. */
export function Toggle({
  checked,
  onChange,
  label,
  disabled,
}: {
  checked: boolean
  onChange: (v: boolean) => void
  label: string
  disabled?: boolean
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn(
        'relative h-6 w-11 shrink-0 rounded-full transition-colors disabled:opacity-50',
        checked ? 'bg-teal-500' : 'bg-slate-400',
      )}
    >
      <span
        className={cn(
          'absolute left-0.5 top-0.5 h-5 w-5 rounded-full bg-white shadow-sm transition-transform',
          checked && 'translate-x-5',
        )}
      />
    </button>
  )
}
