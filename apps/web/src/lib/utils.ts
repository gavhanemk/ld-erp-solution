import { type ClassValue, clsx } from 'clsx'
import { twMerge } from 'tailwind-merge'
import { appSettings } from './appSettings'

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

export function formatCurrency(amount: number, currency = 'INR'): string {
  if (currency === 'INR') {
    if (amount >= 10000000) return `₹${(amount / 10000000).toFixed(2)}Cr`
    if (amount >= 100000) return `₹${(amount / 100000).toFixed(2)}L`
    if (amount >= 1000) return `₹${(amount / 1000).toFixed(1)}K`
    return `₹${amount.toLocaleString('en-IN')}`
  }
  return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(amount)
}

/**
 * An exact rupee amount: ₹1,540.50 — always two places, Indian grouping. For
 * costing sheets and documents, where a figure gets checked with a calculator.
 *
 * formatCurrency above shortens to K, L and Cr, which suits a dashboard tile but
 * would show a ₹1,540.50 fabric line as ₹1.5K, and prints ₹2.4 beside ₹0.65 below
 * a thousand. This matches `money()` on the printed sheet, with the symbol added.
 */
export function formatRupees(amount: number | string | null | undefined): string {
  const value = Number(amount ?? 0)
  return `₹${value.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

export function formatDate(date: Date | string, format: 'short' | 'long' | 'relative' = 'short'): string {
  const d = new Date(date)

  if (format === 'relative') {
    const diff = Date.now() - d.getTime()
    const minutes = Math.floor(diff / 60000)
    const hours = Math.floor(diff / 3600000)
    const days = Math.floor(diff / 86400000)
    if (minutes < 1) return 'Just now'
    if (minutes < 60) return `${minutes}m ago`
    if (hours < 24) return `${hours}h ago`
    if (days === 1) return 'Yesterday'
    return `${days}d ago`
  }

  if (format === 'long') {
    return d.toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' })
  }

  // The short form follows whatever was chosen in Settings → Preferences.
  const pad = (n: number) => String(n).padStart(2, '0')

  switch (appSettings().dateFormat) {
    case 'DD/MM/YYYY':
      return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()}`
    case 'YYYY-MM-DD':
      return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
    default:
      return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })
  }
}

export function generateDocNumber(prefix: string, fy: string, sequence: number, padding = 4): string {
  return `${prefix}-${fy}-${String(sequence).padStart(padding, '0')}`
}

export function getCurrentFY(): string {
  const now = new Date()
  const year = now.getFullYear()
  const month = now.getMonth() + 1
  const startYear = month >= 4 ? year : year - 1
  return `${String(startYear).slice(2)}${String(startYear + 1).slice(2)}`
}

export function debounce<T extends (...args: unknown[]) => unknown>(fn: T, delay: number): T {
  let timer: NodeJS.Timeout
  return ((...args: Parameters<T>) => {
    clearTimeout(timer)
    timer = setTimeout(() => fn(...args), delay)
  }) as T
}

export function truncate(str: string, maxLength: number): string {
  if (str.length <= maxLength) return str
  return str.slice(0, maxLength - 3) + '...'
}

/**
 * The line-item names for an order or receipt row, condensed to what a
 * table cell can actually hold.
 *
 * Two names read as a preview; past that, a count says the rest without
 * trying to list a purchase order that runs to thirty lines. `full` is
 * every name, for a hover title on the truncated text — the one place
 * somebody genuinely needs to see all of them without opening the row.
 */
export function itemsPreview(names: Array<string | null | undefined>): {
  shown: string
  extra: string
  full: string
} {
  const clean = names.filter((n): n is string => Boolean(n))
  const shown = clean.slice(0, 2).join(', ')
  const extra = clean.length > 2 ? ` +${clean.length - 2} more` : ''
  return { shown, extra, full: clean.join(', ') }
}
