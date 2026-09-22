'use client'

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { AlertCircle, BarChart3, FileSpreadsheet, RefreshCw } from 'lucide-react'
import { api, ApiError } from '@/lib/api'

/**
 * The picker.
 *
 * Built from the registry, so adding a report is a file on the server and a
 * line in `registry.ts` — nothing here changes. It lists only what this
 * person's role may see, because a report inherits its module's permission.
 */

interface ReportSummary {
  id: string
  module: string
  title: string
  description: string
  filters: Array<{ key: string; label: string; type: string }>
  columns: Array<{ key: string; label: string }>
}

const MODULE_WORDS: Record<string, string> = {
  purchase: 'Purchase',
  sales: 'Sales',
  inventory: 'Inventory',
  production: 'Production',
  accounts: 'Accounts',
  hr: 'HR & Payroll',
}

export default function ReportsPage() {
  const [reports, setReports] = useState<ReportSummary[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await api.get<{ data: ReportSummary[] }>('/reports')
      setReports(res.data)
    } catch (err) {
      setError(
        err instanceof ApiError ? err.message : 'Could not reach the server. Is the API running?'
      )
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const byModule = reports.reduce<Record<string, ReportSummary[]>>((acc, r) => {
    ;(acc[r.module] ??= []).push(r)
    return acc
  }, {})

  return (
    <div className="space-y-5">
      <div className="page-header flex-wrap gap-3">
        <div>
          <h1 className="page-title">Reports</h1>
          <p className="page-subtitle hidden sm:block">
            Each one opens on a dashboard, and exports to Excel with the charts built in
          </p>
        </div>
        <button className="btn-ghost" onClick={() => void load()} disabled={loading}>
          <RefreshCw size={15} className={loading ? 'animate-spin' : undefined} />
        </button>
      </div>

      {error && (
        <div className="flex items-start gap-3 rounded-lg border border-red-500/40 bg-red-500/5 p-3">
          <AlertCircle size={16} className="mt-0.5 shrink-0 text-red-400" />
          <p className="text-sm text-red-400">{error}</p>
        </div>
      )}

      {loading ? (
        <p className="text-muted-foreground text-sm">Loading...</p>
      ) : reports.length === 0 ? (
        <div className="glass-card px-4 py-10 text-center">
          <BarChart3 size={22} className="text-muted-foreground mx-auto" />
          <p className="text-foreground mt-2 text-sm font-medium">No reports you can open</p>
          <p className="text-muted-foreground mt-1 text-sm">
            A report inherits its module&rsquo;s permission. Ask for view access to a module and its
            reports come with it.
          </p>
        </div>
      ) : (
        Object.entries(byModule).map(([module, list]) => (
          <div key={module} className="space-y-3">
            <h2 className="text-muted-foreground text-[11px] font-semibold uppercase tracking-wide">
              {MODULE_WORDS[module] ?? module}
            </h2>
            <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
              {list.map((r) => (
                <Link
                  key={r.id}
                  href={`/reports/${r.id}`}
                  className="glass-card hover:border-primary/40 group p-4 transition-colors"
                >
                  <div className="flex items-start gap-3">
                    <div className="bg-primary/10 border-primary/20 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border">
                      <FileSpreadsheet size={17} className="text-primary" />
                    </div>
                    <div className="min-w-0">
                      <h3 className="text-foreground group-hover:text-primary text-sm font-semibold transition-colors">
                        {r.title}
                      </h3>
                      <p className="text-muted-foreground mt-1 text-xs leading-snug">
                        {r.description}
                      </p>
                      <p className="text-muted-foreground mt-2 text-[11px]">
                        {r.columns.length} columns
                        {r.filters.length > 0 && ` · ${r.filters.length} filters`}
                      </p>
                    </div>
                  </div>
                </Link>
              ))}
            </div>
          </div>
        ))
      )}
    </div>
  )
}
