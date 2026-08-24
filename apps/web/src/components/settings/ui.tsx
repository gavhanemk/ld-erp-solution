'use client'

import { AlertCircle, CheckCircle2, Loader2 } from 'lucide-react'
import { cn } from '@/lib/utils'

/** The small pieces every Settings screen is built from. */

export function SettingsCard({
  title,
  description,
  children,
  actions,
}: {
  title: string
  description?: string
  children: React.ReactNode
  /** Rendered top-right, usually an "Add" button. */
  actions?: React.ReactNode
}) {
  return (
    <section className="glass-card p-0 overflow-hidden">
      <header className="flex items-start justify-between gap-4 px-6 py-4 border-b border-border">
        <div>
          <h2 className="text-sm font-semibold text-foreground">{title}</h2>
          {description && <p className="text-xs text-muted-foreground mt-0.5">{description}</p>}
        </div>
        {actions}
      </header>
      <div className="p-6">{children}</div>
    </section>
  )
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
  help?: string
  required?: boolean
  span?: 1 | 2
  children: React.ReactNode
}) {
  return (
    <div className={span === 2 ? 'md:col-span-2' : undefined}>
      <label className="form-label" htmlFor={htmlFor}>
        {label}
        {required && <span className="text-red-400 ml-0.5">*</span>}
      </label>
      {children}
      {error ? (
        <p className="text-xs text-red-400 mt-1">{error}</p>
      ) : help ? (
        <p className="text-xs text-muted-foreground mt-1">{help}</p>
      ) : null}
    </div>
  )
}

/** A banner that says what happened, in the words the API used. */
export function Notice({
  kind,
  children,
}: {
  kind: 'success' | 'error' | 'info'
  children: React.ReactNode
}) {
  const style = {
    success: 'border-emerald-500/40 bg-emerald-500/5 text-emerald-400',
    error: 'border-red-500/40 bg-red-500/5 text-red-400',
    info: 'border-teal-500/40 bg-teal-500/5 text-teal-300',
  }[kind]

  const Icon = kind === 'success' ? CheckCircle2 : AlertCircle

  return (
    <div className={cn('flex items-start gap-3 p-3 rounded-lg border text-sm', style)}>
      <Icon size={16} className="mt-0.5 shrink-0" />
      <div className="flex-1">{children}</div>
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
    <div className="flex items-center gap-2 text-sm text-muted-foreground py-6">
      <Loader2 size={15} className="animate-spin" />
      {label}
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
        'relative w-11 h-6 rounded-full transition-colors shrink-0 disabled:opacity-50',
        checked ? 'bg-teal-500' : 'bg-slate-600',
      )}
    >
      <span
        className={cn(
          'absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white transition-transform',
          checked && 'translate-x-5',
        )}
      />
    </button>
  )
}
