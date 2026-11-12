import { redirect } from 'next/navigation'

/**
 * Production Stages is Production Floor's "By stage" tab now (12 Nov 2026). A
 * bookmark or link here — a stage's sheet for one job card too — opens there.
 */
export default async function ProductionStagesPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = await searchParams
  const qs = new URLSearchParams({ tab: 'stages' })
  for (const k of ['op', 'card', 'step']) {
    const v = Array.isArray(sp[k]) ? sp[k][0] : sp[k]
    if (v) qs.set(k, v)
  }
  redirect(`/production/floor?${qs}`)
}
