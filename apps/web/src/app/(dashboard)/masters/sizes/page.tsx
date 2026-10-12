import { redirect } from 'next/navigation'

/**
 * Sizes are edited inside their run now (Masters → Size Runs, click a run), so
 * the old one-size-at-a-time list sends anyone with it bookmarked there.
 */
export default function SizesPage() {
  redirect('/masters/size-runs')
}
