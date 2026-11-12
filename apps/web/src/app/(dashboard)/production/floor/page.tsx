'use client'

import { Suspense, useEffect, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import { ArrowLeftRight, Layers, LayoutGrid, Plus, RefreshCw } from 'lucide-react'
import { api, can } from '@/lib/api'
import { cn } from '@/lib/utils'
import { NewTransferDialog } from '@/components/production/floor/NewTransferDialog'
import { TransfersPanel } from '@/components/production/floor/TransfersPanel'
import { StagesPanel } from '@/components/production/floor/StagesPanel'

/**
 * Production Floor: the floor's work on one screen (12 Nov 2026 — it took the
 * place of Process Transfers, Production Stages and the Job Cards list, which
 * were three ways into the same stage sheets).
 *
 *   Job cards       each job card from cutting to packing: where its pieces
 *                   are and the one thing to do next (Board or Rows); its
 *                   job card window (header, process forms, print) and sheets
 *   By stage        each department's queue: the job cards waiting at a stage,
 *                   and that stage's report
 *   Transfer cards  the cards handed between departments: to count in, short,
 *                   at outside units, received
 *
 * The work itself is recorded on the stage sheets, the same from every tab.
 * The address says the tab (?tab=cards|stages|transfers) and what a link asks
 * for in it — a search (q), a list of cards (view), a stage (op), a sheet
 * (card + step) — and is followed while the page is open too, so a search
 * result or a sheet's link lands right from here as well. The old addresses
 * (/production/transfers, /production/stages, /production/job-cards) bring
 * their links here, to the matching tab.
 */

type Tab = 'cards' | 'stages' | 'transfers'

const TABS: Array<{ key: Tab; label: string; icon: React.ElementType; hint: string }> = [
  { key: 'cards', label: 'Job cards', icon: LayoutGrid, hint: 'Each job card from cutting to packing: where its pieces are, and the one thing to do next. Click a stage to open its sheet.' },
  { key: 'stages', label: 'By stage', icon: Layers, hint: "Each department's queue: pick a stage to see the job cards waiting there, or its report." },
  { key: 'transfers', label: 'Transfer cards', icon: ArrowLeftRight, hint: 'The cards handed from one department to the next: to count in where they arrive, short, out at a unit, received.' },
]

export default function ProductionFloorPage() {
  return (
    <Suspense>
      <Floor />
    </Suspense>
  )
}

function Floor() {
  const params = useSearchParams()
  const asked = params.get('tab')
  // A link to a stage's sheet (card + step) without a tab opens By stage.
  const tab: Tab = asked === 'stages' || asked === 'transfers' || asked === 'cards' ? asked : params.get('card') && params.get('step') ? 'stages' : 'cards'
  const [refreshKey, setRefreshKey] = useState(0)
  const [message, setMessage] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  /** Transfer cards waiting to be counted in, and short ones: said on their tab. */
  const [waiting, setWaiting] = useState<{ count: number; short: number } | null>(null)

  useEffect(() => {
    let alive = true
    api
      .get<{ data: Record<string, number> }>('/production/transfers/counts')
      .then((r) => alive && setWaiting({ count: r.data.count ?? 0, short: r.data.short ?? 0 }))
      .catch(() => {
        // The tab works without its number.
      })
    return () => {
      alive = false
    }
  }, [refreshKey])

  const choose = (t: Tab) => {
    setMessage(null)
    // A fresh address for the tab: the last one's stage, sheet, list or search does not follow.
    const url = new URL(window.location.href)
    url.search = ''
    url.searchParams.set('tab', t)
    window.history.replaceState(null, '', url)
  }
  const said = (m: string) => {
    setMessage(m)
    setRefreshKey((k) => k + 1)
  }
  const current = TABS.find((t) => t.key === tab)
  const transferLink = { view: params.get('view'), q: params.get('q') }

  return (
    <div className="space-y-4">
      <div className="page-header">
        <div>
          <h1 className="page-title text-xl sm:text-2xl">Production Floor</h1>
          <p className="page-subtitle hidden sm:block">Each job card from cutting to packing — where its pieces are, each department&apos;s queue, and the cards handed between them</p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <button className="btn-ghost" onClick={() => setRefreshKey((k) => k + 1)} aria-label="Refresh" title="Refresh">
            <RefreshCw size={15} />
          </button>
          {can('production', 'create') && (
            <button className="btn-primary" onClick={() => setCreating(true)} data-hotkey="new" aria-keyshortcuts="Alt+N">
              <Plus size={15} /> New transfer
            </button>
          )}
        </div>
      </div>

      {/* overflow-y-hidden: the tabs' 1px overlap on the line otherwise gives Windows a vertical scrollbar here. */}
      <div className="border-border flex gap-1 overflow-x-auto overflow-y-hidden border-b" role="tablist" aria-label="Production floor">
        {TABS.map((t) => {
          const on = t.key === tab
          return (
            <button
              key={t.key}
              type="button"
              role="tab"
              aria-selected={on}
              onClick={() => choose(t.key)}
              className={cn(
                '-mb-px flex shrink-0 items-center gap-1.5 border-b-2 px-3 py-2 text-sm font-medium transition-colors',
                on ? 'border-primary text-primary' : 'text-muted-foreground hover:text-foreground border-transparent',
              )}
            >
              <t.icon size={15} /> {t.label}
              {t.key === 'transfers' && waiting && (waiting.count > 0 || waiting.short > 0) && (
                <span
                  className={cn('rounded-full px-1.5 text-[11px] font-semibold tabular-nums', waiting.short ? 'bg-destructive text-white' : 'bg-primary text-primary-foreground')}
                  title={[waiting.count ? `${waiting.count} to count in` : null, waiting.short ? `${waiting.short} short` : null].filter(Boolean).join(', ')}
                >
                  {waiting.count + waiting.short}
                </span>
              )}
            </button>
          )
        })}
      </div>
      {current && <p className="text-muted-foreground -mt-2 text-xs">{current.hint}</p>}

      {message && (
        <div className="border-primary/40 bg-primary/5 rounded-lg border p-3">
          <p className="text-primary text-sm">{message}</p>
        </div>
      )}

      {tab === 'cards' && <TransfersPanel mode="board" link={transferLink} refreshKey={refreshKey} onMessage={said} />}
      {tab === 'stages' && <StagesPanel link={{ op: params.get('op'), card: params.get('card'), step: params.get('step') }} refreshKey={refreshKey} onMessage={said} />}
      {tab === 'transfers' && <TransfersPanel mode="cards" link={transferLink} refreshKey={refreshKey} onMessage={said} />}

      {creating && (
        <NewTransferDialog
          onClose={() => setCreating(false)}
          onSaved={(m, transferId) => {
            setCreating(false)
            said(m)
            if (transferId) window.open(`/print/transfer/${transferId}`, '_blank', 'noopener')
          }}
        />
      )}
    </div>
  )
}
