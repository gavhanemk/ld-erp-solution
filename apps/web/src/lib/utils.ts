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
