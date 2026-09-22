'use client'

import { use, useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { AlertCircle, ArrowLeft, Play, RefreshCw } from 'lucide-react'
import { api, ApiError, masterResource } from '@/lib/api'
import { ExportButton } from '@/components/tables/ExportButton'
import { ReportDashboard, type Analysis } from '@/components/reports/Dashboard'
import { describeReport, downloadReport } from '@/lib/reportDownload'
import { formatDate } from '@/lib/utils'

interface Filter {
  key: string
  label: string
  type: 'date' | 'select' | 'text' | 'boolean'
  required?: boolean
  optionsFrom?: string
  options?: Array<{ value: string; label: string }>
  help?: string
}

interface Column {
  key: string
  label: string
  type: string
  unit?: string
}

interface RunResult {
  report: { id: string; title: string; description: string }
  periodLabel: string
  analysis: Analysis
  rowCount: number
  totalRows: number
  truncated: boolean
  columns: Column[]
  preview: Array<Record<string, unknown>>
}

const money = (v: number) =>
  v.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

function cellText(c: Column, v: unknown): string {
  if (v == null || v === '') return '—'
  if (c.type === 'date') return formatDate(String(v))
  if (c.type === 'money') return `₹${money(Number(v))}`
  if (c.type === 'percent') return `${(Number(v) * 100).toFixed(1)}%`
  if (c.type === 'qty') {
    return `${Number(v).toLocaleString('en-IN', { maximumFractionDigits: 3 })}${c.unit ? ` ${c.unit}` : ''}`
  }
  if (c.type === 'integer') return Number(v).toLocaleString('en-IN')
  return String(v)
}

export default function ReportPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params)

  const [filters, setFilters] = useState<Filter[]>([])
  const [values, setValues] = useState<Record<string, string>>({})
  const [result, setResult] = useState<RunResult | null>(null)
  const [options, setOptions] = useState<Record<string, Array<{ id: string; name: string }>>>({})
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)

  // The definition, for the filter bar. Fetched from the same registry the
  // server runs from, so a filter added there appears here with no change.
  useEffect(() => {
    void (async () => {
      try {
        const res = await api.get<{ data: Array<{ id: string; filters: Filter[] }> }>('/reports')
        const mine = res.data.find((r) => r.id === id)
        setFilters(mine?.filters ?? [])

        const needed = [...new Set((mine?.filters ?? []).map((f) => f.optionsFrom).filter(Boolean))]
        const loaded: Record<string, Array<{ id: string; name: string }>> = {}
        await Promise.all(
          needed.map(async (resource) => {
            try {
              const list = await masterResource<{ id: string; name: string }>(
                resource as string
              ).list({ limit: 500 })
              loaded[resource as string] = [...list.data].sort((a, b) =>
                a.name.localeCompare(b.name)
              )
            } catch {
              // The filter simply comes up empty; the report still runs.
            }
          })
        )
        setOptions(loaded)
      } catch {
        // The run below will report anything that matters.
      }
    })()
  }, [id])

  const run = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const qs = new URLSearchParams(
        Object.entries(values).filter(([, v]) => v) as Array<[string, string]>
      )
      const res = await api.get<{ data: RunResult }>(`/reports/${id}/run?${qs}`)
      setResult(res.data)
    } catch (err) {
      setError(
        err instanceof ApiError ? err.message : 'Could not reach the server. Is the API running?'
      )
    } finally {
      setLoading(false)
    }
  }, [id, values])

  // Runs once on arrival with no filters, so the screen is never empty.
  useEffect(() => {
    void run()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id])

  const applied = useMemo(
    () => Object.fromEntries(Object.entries(values).filter(([, v]) => v)) as Record<string, string>,
    [values]
  )

  const exportFile = async (format: 'xlsx' | 'csv') => {
    setError(null)
    try {
      setMessage(describeReport(await downloadReport(id, format, applied)))
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The report could not be built.')
    }
  }

  return (
    <div className="space-y-5">
      <div className="page-header flex-wrap gap-3">
        <div className="min-w-0">
          <Link
            href="/reports"
            className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1 text-xs"
          >
            <ArrowLeft size={13} /> All reports
          </Link>
          <h1 className="page-title mt-1">{result?.report.title ?? 'Report'}</h1>
          {result && <p className="page-subtitle hidden sm:block">{result.report.description}</p>}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <button className="btn-ghost" onClick={() => void run()} disabled={loading}>
            <RefreshCw size={15} className={loading ? 'animate-spin' : undefined} />
          </button>
          <ExportButton onExport={exportFile} disabled={loading || !result} />
        </div>
      </div>

      {error && (
        <div className="flex items-start gap-3 rounded-lg border border-red-500/40 bg-red-500/5 p-3">
          <AlertCircle size={16} className="mt-0.5 shrink-0 text-red-400" />
          <p className="text-sm text-red-400">{error}</p>
        </div>
      )}
      {message && (
        <div className="rounded-lg border border-emerald-500/40 bg-emerald-500/5 p-3">
          <p className="text-sm text-emerald-400">{message}</p>
        </div>
      )}

      {filters.length > 0 && (
        <div className="glass-card flex flex-wrap items-end gap-3 p-3">
          {filters.map((f) => (
            <div key={f.key} className="min-w-[10rem]">
              <label className="form-label text-[11px]" htmlFor={`f-${f.key}`}>
                {f.label}
                {f.required && <span className="ml-0.5 text-red-400">*</span>}
              </label>
              {f.type === 'boolean' ? (
                <label className="text-foreground flex h-8 cursor-pointer items-center gap-2 text-xs">
                  <input
                    id={`f-${f.key}`}
                    type="checkbox"
                    checked={values[f.key] === 'true'}
                    onChange={(e) =>
                      setValues((v) => ({ ...v, [f.key]: e.target.checked ? 'true' : '' }))
                    }
                  />
                  Yes
                </label>
              ) : f.type === 'select' ? (
                <select
                  id={`f-${f.key}`}
                  className="form-input h-8 w-full py-0 text-xs"
                  value={values[f.key] ?? ''}
                  onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))}
                >
                  <option value="">All</option>
                  {(f.options ?? []).map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                  {(options[f.optionsFrom ?? ''] ?? []).map((o) => (
                    <option key={o.id} value={o.id}>
                      {o.name}
                    </option>
                  ))}
                </select>
              ) : (
                <input
                  id={`f-${f.key}`}
                  type={f.type === 'date' ? 'date' : 'text'}
                  className="form-input h-8 w-full py-0 text-xs"
                  value={values[f.key] ?? ''}
                  onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))}
                />
              )}
            </div>
          ))}
          <button className="btn-primary h-8 text-xs" onClick={() => void run()} disabled={loading}>
            <Play size={13} /> Run
          </button>
        </div>
      )}

      {loading && !result ? (
        <p className="text-muted-foreground text-sm">Running...</p>
      ) : result ? (
        <>
          <p className="text-muted-foreground text-xs">
            {result.periodLabel} · {result.rowCount.toLocaleString('en-IN')} rows
            {result.truncated && (
              <span className="text-amber-400">
                {' '}
                of {result.totalRows.toLocaleString('en-IN')} — the export will be marked PARTIAL
              </span>
            )}
          </p>

          <ReportDashboard analysis={result.analysis} />

          {result.preview.length > 0 && (
            <div className="glass-card overflow-hidden p-0">
              <div className="border-border flex items-center justify-between border-b px-4 py-2.5">
                <h3 className="text-foreground text-sm font-semibold">The rows</h3>
                <span className="text-muted-foreground text-xs">
                  first {result.preview.length} of {result.rowCount.toLocaleString('en-IN')} — every
                  row is in the export
                </span>
              </div>
              <div className="overflow-x-auto">
                <table className="subtable w-full">
                  <thead>
                    <tr>
                      {result.columns.map((c) => (
                        <th
                          key={c.key}
                          className={
                            ['money', 'qty', 'integer', 'percent'].includes(c.type)
                              ? 'text-right'
                              : undefined
                          }
                        >
                          {c.label}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {result.preview.map((r, i) => (
                      <tr key={i}>
                        {result.columns.map((c) => (
                          <td
                            key={c.key}
                            className={
                              ['money', 'qty', 'integer', 'percent'].includes(c.type)
                                ? 'whitespace-nowrap text-right tabular-nums'
                                : 'whitespace-nowrap'
                            }
                          >
                            {cellText(c, r[c.key])}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </>
      ) : null}
    </div>
  )
}
