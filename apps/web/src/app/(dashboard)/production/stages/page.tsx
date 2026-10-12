'use client'

import { useCallback, useEffect, useState } from 'react'
import { AlertCircle, Info, RefreshCw } from 'lucide-react'
import { api, ApiError } from '@/lib/api'
import { StageList } from '@/components/production/floor/StageList'
import { SheetView } from '@/components/production/floor/SheetView'
import type { Stage } from '@/components/production/floor/types'

/**
 * Production stages: every stage of the open orders' routes on one screen, a
 * tab each — cutting first, then in the process master's order — with how many
 * job cards have work waiting there. Under a tab, the job cards at that stage
 * and what waits for each; opening one opens its sheet for the stage.
 */
interface Tab {
  operationId: string
  name: string
  stage: Stage
  sheets: number
  active: number
  toCountIn: number
}

const HOW: Record<Stage, string> = {
  CUTTING: 'Issue sizes to a cutting contractor, receive the cut pieces back — the bundles and their stickers are made then — and transfer them to the next stage.',
  STITCHING: 'Count in the bundles transferred here, record any damaged pieces, and transfer the finished pieces to the next stage.',
  OTHER: 'Count in what was transferred here, record the work and any damaged pieces, and transfer the pieces on. At an outside unit, the pieces go on a job-work challan and you record what comes back.',
  QC: 'Count in the pieces sent for checking, record what passed, failed or needs rework, and send the passed pieces on.',
}

export default function ProductionStagesPage() {
  const [tabs, setTabs] = useState<Tab[] | null>(null)
  const [current, setCurrent] = useState<string>('')
  const [error, setError] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [opened, setOpened] = useState<{ jobCardId: string; stepId: string } | null>(null)
  const [refreshKey, setRefreshKey] = useState(0)

  const loadTabs = useCallback(async () => {
    try {
      const res = await api.get<{ data: Tab[] }>('/production/stage-tabs')
      setTabs(res.data)
      setCurrent((c) => (c && res.data.some((t) => t.operationId === c) ? c : res.data[0]?.operationId ?? ''))
      setError(null)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load the stages.')
    }
  }, [])

  useEffect(() => {
    // A link from a transfer or a job card opens its tab, or its sheet straight away.
    const qs = new URLSearchParams(window.location.search)
    const op = qs.get('op')
    if (op) setCurrent(op)
    const card = qs.get('card')
    const step = qs.get('step')
    if (card && step) setOpened({ jobCardId: card, stepId: step })
    void loadTabs()
  }, [loadTabs])

  const choose = (id: string) => {
    setCurrent(id)
    const url = new URL(window.location.href)
    url.searchParams.set('op', id)
    url.searchParams.delete('card')
    url.searchParams.delete('step')
    window.history.replaceState(null, '', url)
  }
  const refresh = () => {
    setRefreshKey((k) => k + 1)
    void loadTabs()
  }
  const tab = tabs?.find((t) => t.operationId === current)

  return (
    <div className="space-y-4">
      <div className="page-header">
        <div>
          <h1 className="page-title text-xl sm:text-2xl">Production Stages</h1>
          <p className="page-subtitle hidden sm:block">Every stage on one screen: pick a stage, open a job card, and record its work there</p>
        </div>
        <button className="btn-ghost" onClick={refresh} aria-label="Refresh">
          <RefreshCw size={15} />
        </button>
      </div>

      {error && (
        <div className="border-destructive/40 bg-destructive/5 flex items-start gap-3 rounded-lg border p-3">
          <AlertCircle size={16} className="text-destructive mt-0.5 shrink-0" />
          <p className="text-destructive text-sm">{error}</p>
        </div>
      )}
      {message && (
        <div className="border-primary/40 bg-primary/5 rounded-lg border p-3">
          <p className="text-primary text-sm">{message}</p>
        </div>
      )}

      {!tabs ? (
        <div className="skeleton h-12 w-full rounded-xl" />
      ) : !tabs.length ? (
        <div className="glass-card p-6 text-center text-sm">
          <p className="text-foreground font-medium">No order is in production yet.</p>
          <p className="text-muted-foreground mt-1">
            Open a manufacturing order, release it, raise and issue its materials, then load its stages. Each stage then gets a tab here.
          </p>
        </div>
      ) : (
        <>
          <div className="glass-card -mx-1 flex gap-1 overflow-x-auto p-1.5" role="tablist" aria-label="Stages">
            {tabs.map((t, i) => {
              const on = t.operationId === current
              return (
                <button
                  key={t.operationId}
                  type="button"
                  role="tab"
                  aria-selected={on}
                  onClick={() => choose(t.operationId)}
                  className={`flex shrink-0 items-center gap-2 rounded-lg px-3 py-2 text-sm transition-colors ${on ? 'bg-primary/10 text-primary font-semibold' : 'text-foreground hover:bg-secondary'}`}
                >
                  <span className={`flex h-5 w-5 items-center justify-center rounded-full text-[10px] font-semibold tabular-nums ${on ? 'bg-primary text-primary-foreground' : 'bg-secondary text-muted-foreground'}`}>
                    {i + 1}
                  </span>
                  {t.name}
                  {t.active > 0 && (
                    <span className={`rounded-full px-1.5 text-[11px] font-semibold tabular-nums ${t.toCountIn ? 'bg-primary text-primary-foreground' : 'bg-secondary text-foreground'}`} title={`${t.active} job ${t.active === 1 ? 'card has' : 'cards have'} work here${t.toCountIn ? `, ${t.toCountIn} to count in` : ''}`}>
                      {t.active}
                    </span>
                  )}
                </button>
              )
            })}
          </div>

          {tab && (
            <>
              <p className="text-muted-foreground flex items-start gap-1.5 text-xs">
                <Info size={13} className="mt-px shrink-0" />
                <span>
                  <span className="text-foreground font-medium">{tab.name}:</span> {HOW[tab.stage]}
                </span>
              </p>
              <StageList operationId={tab.operationId} stage={tab.stage} refreshKey={refreshKey} onOpen={(r) => setOpened({ jobCardId: r.card.id, stepId: r.step.id })} />
            </>
          )}
        </>
      )}

      {opened && (
        <SheetView
          jobCardId={opened.jobCardId}
          stepId={opened.stepId}
          onClose={() => {
            setOpened(null)
            refresh()
          }}
          onChanged={(m) => m && setMessage(m)}
        />
      )}
    </div>
  )
}
