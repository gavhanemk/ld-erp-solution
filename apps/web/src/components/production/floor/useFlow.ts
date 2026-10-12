'use client'

import { useCallback, useEffect, useState } from 'react'
import { api, ApiError } from '@/lib/api'
import { isCheck, type Bucket, type FlowBundle, type FlowStep, type JobCardDetail } from './types'
import type { BundleRow } from './BundleQtyTable'

/** One job card and everything its sheets show, loaded and reloadable. */
export function useJobCard(jobCardId: string | null) {
  const [detail, setDetail] = useState<JobCardDetail | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const reload = useCallback(async () => {
    if (!jobCardId) return
    setLoading(true)
    try {
      setDetail((await api.get<{ data: JobCardDetail }>(`/production/job-cards/${jobCardId}`)).data)
      setError(null)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not open that job card.')
    } finally {
      setLoading(false)
    }
  }, [jobCardId])
  useEffect(() => {
    setDetail(null)
    void reload()
  }, [reload])
  return { detail, error, loading, reload }
}

/** A working step on our own floor sends pieces on straight from in hand; a check, cutting or a unit only what it has done. */
export const sendsFromHand = (s: Pick<FlowStep, 'kind' | 'isQcStep' | 'execution'>) => s.kind !== 'CUTTING' && !isCheck(s) && s.execution === 'IN_HOUSE'

/** The bundles holding pieces in one place (or several), as rows for the quantity table, oldest first. */
export function bundleRows(
  bundles: FlowBundle[],
  where: { stepId: string; bucket: Bucket | Bucket[]; vendorId?: string | null; reworkStepId?: string | null },
): BundleRow[] {
  const buckets = Array.isArray(where.bucket) ? where.bucket : [where.bucket]
  return bundles
    .map((b) => {
      const available = b.places
        .filter(
          (p) =>
            p.stepId === where.stepId &&
            buckets.includes(p.bucket) &&
            (where.vendorId === undefined ? !p.vendorId : p.vendorId === where.vendorId) &&
            (where.reworkStepId === undefined || p.reworkStepId === where.reworkStepId),
        )
        .reduce((s, p) => s + p.qty, 0)
      return {
        id: b.id,
        code: b.code,
        size: b.size?.code ?? null,
        line: b.line ? `${b.line.style}${b.line.color ? ` ${b.line.color}` : ''}` : null,
        available,
        bundleNo: b.bundleNo,
      }
    })
    .filter((r) => r.available > 0)
    .sort((a, b) => a.bundleNo - b.bundleNo)
}
