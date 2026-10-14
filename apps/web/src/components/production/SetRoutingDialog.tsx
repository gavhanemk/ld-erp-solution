'use client'

import { useEffect, useState } from 'react'
import { AlertCircle, Loader2, Route } from 'lucide-react'
import { api, ApiError } from '@/lib/api'
import { FormFrame } from '@/components/ui/FormFrame'
import { SmartSelect } from '@/components/ui/SmartSelect'

/**
 * Giving an order its route: one of the routings that suit its styles — the
 * style's own first, then its category's, then any style's. The order keeps
 * its own copy of the steps.
 */

interface RoutingOption {
  id: string
  code: string
  name: string
  version: number
  applies: 'STYLE' | 'CATEGORY' | 'ANY'
  category: string | null
  style: { code: string } | null
  problem: string | null
  steps: Array<{ id: string; execution: string; isQcStep: boolean; operation: { name: string } }>
}

export function SetRoutingDialog({ moId, moNumber, styleIds, onClose, onSaved }: { moId: string; moNumber: string; styleIds: string[]; onClose: () => void; onSaved: (message: string) => void }) {
  const [routings, setRoutings] = useState<RoutingOption[] | null>(null)
  const [routingId, setRoutingId] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    api
      .get<{ data: RoutingOption[] }>(`/production/routings/for?styleIds=${encodeURIComponent(styleIds.join(','))}`)
      .then((res) => {
        if (!alive) return
        setRoutings(res.data)
        setRoutingId(res.data.find((r) => !r.problem)?.id ?? '')
      })
      .catch((err) => alive && setError(err instanceof ApiError ? err.message : 'Could not load the routings.'))
    return () => {
      alive = false
    }
  }, [styleIds])

  const routing = routings?.find((r) => r.id === routingId)
  const save = async () => {
    if (!routingId) return
    setSaving(true)
    setError(null)
    try {
      const res = await api.post<{ message?: string }>(`/production/orders/${moId}/routing`, { routingId })
      onSaved(res.message ?? 'Route set.')
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not set the route.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <FormFrame
      icon={Route}
      title={`Load stages for ${moNumber}`}
      subtitle="From the routing for the style: the stages its pieces go through. The order keeps its own copy, which can be changed for it alone."
      width="max-w-2xl"
      primary={
        <button type="button" className="btn-primary" onClick={() => void save()} disabled={saving || !routingId}>
          {saving ? <Loader2 size={15} className="animate-spin" /> : <Route size={15} />} Load stages
        </button>
      }
      footer={
        <button type="button" className="btn-secondary" onClick={onClose} disabled={saving}>
          Cancel
        </button>
      }
      error={error}
      onClose={onClose}
      busy={saving}
    >
      {!routings ? (
        <div className="skeleton h-20 w-full rounded-lg" />
      ) : routings.every((r) => r.problem) ? (
        <p className="warn-text flex items-start gap-1.5 text-sm">
          <AlertCircle size={14} className="mt-0.5 shrink-0" />
          No routing suits this order&apos;s styles. Make one in Production → Routings — for the style, its category, or any style.
        </p>
      ) : (
        <div className="space-y-2">
          <label className="block">
            <span className="form-label">Routing</span>
            <SmartSelect className="form-input" value={routingId} onChange={(e) => setRoutingId(e.target.value)}>
              <option value="">Pick a routing…</option>
              {routings.map((r) => (
                <option
                  key={r.id}
                  value={r.id}
                  disabled={!!r.problem}
                  data-sub={r.problem ?? `${r.applies === 'STYLE' ? `For ${r.style?.code}` : r.applies === 'CATEGORY' ? `For every ${r.category} style` : 'For any style'} · ${r.steps.length} steps · v${r.version}`}
                >
                  {r.code} — {r.name}
                </option>
              ))}
            </SmartSelect>
          </label>
          {routing && (
            <div className="flex flex-wrap items-center gap-1.5">
              {routing.steps.map((s, i) => (
                <span key={s.id} className={`${s.isQcStep ? 'badge-info' : s.execution === 'OUTSOURCED' ? 'badge-purple' : 'badge-neutral'} whitespace-nowrap`}>
                  <span className="font-mono opacity-60">{i + 1}</span> {s.operation.name}
                  {s.execution === 'OUTSOURCED' ? ' ↗' : ''}
                </span>
              ))}
            </div>
          )}
        </div>
      )}
    </FormFrame>
  )
}
