/**
 * Numbers and dates, written the way they are read in Bhiwandi.
 *
 * Kept in step with apps/web/src/lib/utils.ts. A figure must not be formatted
 * one way on a laptop and another on a phone — the same order shown twice has
 * to look like the same order.
 */

/** Full rupee figure with Indian digit grouping: 8,74,650.00 */
export const money = (v: string | number): string =>
  Number(v || 0).toLocaleString('en-IN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })

/**
 * Shortened for tiles, where a full figure would wrap on a phone.
 * 87,46,500 becomes 87.47L. The full figure always appears on the detail
 * screen, so nothing is ever only visible in rounded form.
 */
export function shortMoney(amount: number | string): string {
  const n = Number(amount || 0)
  const sign = n < 0 ? '-' : ''
  const abs = Math.abs(n)
  if (abs >= 10000000) return `${sign}₹${(abs / 10000000).toFixed(2)}Cr`
  if (abs >= 100000) return `${sign}₹${(abs / 100000).toFixed(2)}L`
  if (abs >= 1000) return `${sign}₹${(abs / 1000).toFixed(1)}K`
  return `${sign}₹${abs.toLocaleString('en-IN')}`
}

/** 25 Aug 2026 */
export const shortDate = (v: string | Date | null | undefined): string =>
  v
    ? new Date(v).toLocaleDateString('en-GB', {
        day: '2-digit',
        month: 'short',
        year: 'numeric',
      })
    : '—'

/** "2h ago", "Yesterday" — for lists where the exact minute does not matter. */
export function relativeDate(v: string | Date): string {
  const d = new Date(v)
  const diff = Date.now() - d.getTime()
  const minutes = Math.floor(diff / 60000)
  const hours = Math.floor(diff / 3600000)
  const days = Math.floor(diff / 86400000)
  if (minutes < 1) return 'Just now'
  if (minutes < 60) return `${minutes}m ago`
  if (hours < 24) return `${hours}h ago`
  if (days === 1) return 'Yesterday'
  if (days < 7) return `${days}d ago`
  return shortDate(d)
}
