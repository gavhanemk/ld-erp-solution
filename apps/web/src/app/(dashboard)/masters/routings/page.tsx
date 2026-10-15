'use client'

import { useState } from 'react'
import { AlertCircle, ListOrdered, Plus, RefreshCw, Shirt } from 'lucide-react'
import { can } from '@/lib/api'
import { cn } from '@/lib/utils'
import { RoutingFormDialog, type Routing } from '@/components/masters/RoutingFormDialog'
import { RoutingList } from '@/components/masters/routing/RoutingList'
import { StyleTrackList } from '@/components/masters/routing/StyleTrackList'

/**
 * Routings, by style first: every style with the routing it follows and where
 * its work stands on the floor, each opening the style's page. The routings
 * themselves, shared ones included, are on the second tab, to edit, lock,
 * stop using or delete.
 *
 * A manufacturing order still loads the stages of the routing that fits its
 * style once its materials are issued, and keeps its own copy; editing a
 * routing makes a new version for orders to come and never moves work
 * already running.
 */
export default function RoutingsPage() {
  const [tab, setTab] = useState<'styles' | 'routings'>('styles')
  const [error, setError] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [reloadKey, setReloadKey] = useState(0)
  const [dialog, setDialog] = useState<{ open: boolean; record: Routing | null }>({ open: false, record: null })

  const tabs = [
    { key: 'styles' as const, label: 'Styles', icon: Shirt },
    { key: 'routings' as const, label: 'All routings', icon: ListOrdered },
  ]

  return (
    <div className="space-y-4">
      <div className="page-header">
        <div>
          <h1 className="page-title text-xl sm:text-2xl">Routings</h1>
          <p className="page-subtitle hidden sm:block">Which processes each style goes through, in what order, and where its work has got to</p>
        </div>
        <div className="flex items-center gap-2">
          <button className="btn-ghost" onClick={() => setReloadKey((k) => k + 1)} aria-label="Refresh">
            <RefreshCw size={15} />
          </button>
          {can('masters', 'create') && (
            <button className="btn-primary" onClick={() => setDialog({ open: true, record: null })}>
              <Plus size={15} /> <span className="hidden sm:inline">New routing</span>
            </button>
          )}
        </div>
      </div>

      <div className="border-border flex gap-1 border-b" role="tablist" aria-label="Routings">
        {tabs.map((t) => (
          <button
            key={t.key}
            type="button"
            role="tab"
            aria-selected={tab === t.key}
            onClick={() => {
              setTab(t.key)
              setError(null)
            }}
            className={cn(
              '-mb-px flex items-center gap-1.5 border-b-2 px-3 py-2 text-sm font-medium transition-colors',
              tab === t.key ? 'border-primary text-primary' : 'text-muted-foreground hover:text-foreground border-transparent',
            )}
          >
            <t.icon size={15} /> {t.label}
          </button>
        ))}
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

      {tab === 'styles' ? (
        <StyleTrackList reloadKey={reloadKey} onError={setError} />
      ) : (
        <RoutingList reloadKey={reloadKey} onEdit={(record) => setDialog({ open: true, record })} onMessage={setMessage} onError={setError} />
      )}

      <p className="text-muted-foreground text-xs">
        A style&apos;s page shows where each step stands, from the production floor&apos;s records. A manufacturing order loads the stages of the routing for its style once its
        materials are issued, and can change them for itself. Changing a routing makes a new version for orders to come; orders already running keep theirs.
      </p>

      <RoutingFormDialog
        open={dialog.open}
        record={dialog.record}
        onClose={() => setDialog({ open: false, record: null })}
        onSaved={(m) => {
          setMessage(m)
          setReloadKey((k) => k + 1)
        }}
      />
    </div>
  )
}
