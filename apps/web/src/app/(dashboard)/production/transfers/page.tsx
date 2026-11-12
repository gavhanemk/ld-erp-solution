import { redirect } from 'next/navigation'

/**
 * Process Transfers is part of Production Floor now (12 Nov 2026): its board is
 * the Job cards tab, its lists of transfer cards the Transfer cards tab. A
 * bookmark or link here goes to the matching one, its list and search kept.
 */
export default async function TransfersPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = await searchParams
  const one = (k: string) => (Array.isArray(sp[k]) ? sp[k][0] : sp[k])
  const view = one('view')
  const q = one('q')
  const qs = new URLSearchParams()
  if (view && view !== 'board') {
    qs.set('tab', 'transfers')
    qs.set('view', view)
  }
  if (q) qs.set('q', q)
  redirect(`/production/floor${qs.size ? `?${qs}` : ''}`)
}
