'use client'

import { use, useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { useSearchParams } from 'next/navigation'
import { AlertCircle, ArrowLeft, FileText, LayoutDashboard, Printer, RefreshCw } from 'lucide-react'
import { api, ApiError, masterResource } from '@/lib/api'
import { ExportButton } from '@/components/tables/ExportButton'
import { ReportDashboard, type Analysis, type Tone } from '@/components/reports/Dashboard'
import { SummaryTable } from '@/components/reports/SummaryTable'
import { MODULE_WORDS, moduleReportsHref } from '@/components/reports/modules'
import { FilterBar, type Filter } from '@/components/reports/FilterBar'
import { RegisterSheet, type RegisterData } from '@/components/reports/RegisterSheet'
import { describeReport, downloadReport, openRegisterPrint } from '@/lib/reportDownload'

interface Column {
  key: string
  label: string
  type: string
  unit?: string
  /** For `badge`: the word to print, and what it means. */
  badges?: Record<string, string>
  badgeTones?: Record<string, Tone>
}

interface RunResult {
  report: { id: string; title: string; description: string }
  periodLabel: string
  appliedFilters: RegisterData['appliedFilters']
  /** The KPI Summary tab. Absent on a report that has none. */
  analysis?: Analysis
  rowCount: number
  totalRows: number
  truncated: boolean
  columns: Column[]
  /** Every row the query returned: the register, and the KPI tab's totals by group. */
  rows: Array<Record<string, unknown>>
  register: RegisterData['register']
}

export default function ReportPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params)
  const search = useSearchParams()

  const [filters, setFilters] = useState<Filter[]>([])
  /*
   * Seeded from the address, so a link to a filtered report — the way back
   * from its printed page, or a refresh — opens on the same question rather
   * than on everything on record.
   */
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      [...search.entries()].filter(([k, v]) => v && k !== 'print' && k !== 'tab')
    )
  )
  /** What the result on screen was actually built from, so the bar can say
      when the two have drifted apart. */
  const [ranWith, setRanWith] = useState<Record<string, string>>({})
  const [result, setResult] = useState<RunResult | null>(null)
  const [options, setOptions] = useState<Record<string, Array<{ id: string; name: string }>>>({})
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  /** What the report groups its totals by, and which figures it totals — its own Pivot sheet's. */
  const [grouping, setGrouping] = useState<{ rows: string[]; values: string[] }>({
    rows: [],
    values: [],
  })
  /** The report's module, for the way back to that module's reports. */
  const [module, setModule] = useState<string | null>(null)
  /*
   * Which tab is showing. A report opens on its summary — the KPIs, what
   * needs attention and the totals — with the detailed report, the one the
   * PDF prints, on the tab beside it. `tab=report` in the address opens on
   * the detailed one, which is where the way back from the printed page goes.
   */
  const [view, setView] = useState<'summary' | 'report'>(() =>
    search.get('tab') === 'report' ? 'report' : 'summary'
  )

  /** The address for these filters and this tab, so a refresh lands where it was. */
  const keepAddress = (asked: Record<string, string>, tab: 'summary' | 'report') => {
    const q = new URLSearchParams(asked)
    if (tab === 'report') q.set('tab', 'report')
    const qs = q.toString()
    window.history.replaceState(null, '', `${window.location.pathname}${qs ? `?${qs}` : ''}`)
  }

  // The definition, for the filter bar. Fetched from the same registry the
  // server runs from, so a filter added there appears here with no change.
  useEffect(() => {
    void (async () => {
      try {
        const res = await api.get<{
          data: Array<{
            id: string
            module: string
            filters: Filter[]
            pivot?: { rows: string | string[]; values: string[] }
          }>
        }>('/reports')
        const mine = res.data.find((r) => r.id === id)
        setModule(mine?.module ?? null)
        setFilters(mine?.filters ?? [])
        const rowsSpec = mine?.pivot?.rows
        setGrouping({
          rows: rowsSpec == null ? [] : Array.isArray(rowsSpec) ? rowsSpec : [rowsSpec],
          values: mine?.pivot?.values ?? [],
        })

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
    const asked = Object.fromEntries(
      Object.entries(values).filter(([, v]) => v)
    ) as Record<string, string>
    try {
      const res = await api.get<{ data: RunResult }>(
        `/reports/${id}/run?${new URLSearchParams(asked)}`
      )
      setResult(res.data)
      // Recorded on success only. Marking the bar clean before the server has
      // answered means a failed run leaves the screen showing the previous
      // period's figures under the new period's filters.
      setRanWith(asked)
      // And into the address, so a refresh asks the same question again.
      keepAddress(asked, view)
    } catch (err) {
      setError(
        err instanceof ApiError ? err.message : 'Could not reach the server. Is the API running?'
      )
    } finally {
      setLoading(false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keepAddress is redrawn each render
  }, [id, values, view])

  const showTab = (tab: 'summary' | 'report') => {
    setView(tab)
    keepAddress(ranWith, tab)
  }

  // Runs once on arrival with no filters, so the screen is never empty.
  useEffect(() => {
    void run()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id])

  const applied = useMemo(
    () => Object.fromEntries(Object.entries(values).filter(([, v]) => v)) as Record<string, string>,
    [values]
  )

  const exportFile = async (format: 'xlsx' | 'csv' | 'summary') => {
    setError(null)
    try {
      setMessage(describeReport(await downloadReport(id, format, applied)))
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The report could not be built.')
    }
  }

  // The printed report is the one on screen, so it prints what was last run
  // — not filters typed since and not yet run.
  const printRegister = () => openRegisterPrint(id, ranWith)
  const hasSummary = Boolean(result?.analysis)

  return (
    <div className="space-y-5">
      <div className="page-header flex-wrap gap-3">
        <div className="min-w-0">
          <Link
            href={module ? moduleReportsHref(module) : '/reports'}
            className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1 text-xs"
          >
            <ArrowLeft size={13} /> {module ? `${MODULE_WORDS[module] ?? module} reports` : 'All reports'}
          </Link>
          <h1 className="page-title mt-1">{result?.report.title ?? 'Report'}</h1>
          {result && <p className="page-subtitle hidden sm:block">{result.report.description}</p>}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <button className="btn-ghost" onClick={() => void run()} disabled={loading}>
            <RefreshCw size={15} className={loading ? 'animate-spin' : undefined} />
          </button>
          <button
            className="btn-ghost"
            onClick={printRegister}
            disabled={loading || !result}
            title="Print, or save as PDF"
          >
            <Printer size={15} />
            <span className="hidden sm:inline">Print</span>
          </button>
          <ExportButton
            onExport={exportFile}
            onPdf={printRegister}
            disabled={loading || !result}
          />
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
        <FilterBar
          filters={filters}
          values={values}
          applied={ranWith}
          options={options}
          onChange={setValues}
          onRun={() => void run()}
          loading={loading}
        />
      )}

      {loading && !result ? (
        <p className="text-muted-foreground text-sm">Running...</p>
      ) : result ? (
        <>
          {hasSummary && (
            <div className="border-border bg-secondary inline-flex rounded-lg border p-1" role="tablist">
              {(
                [
                  { key: 'summary', label: 'Summary', icon: LayoutDashboard },
                  { key: 'report', label: 'Detailed Report', icon: FileText },
                ] as const
              ).map((t) => (
                <button
                  key={t.key}
                  type="button"
                  role="tab"
                  aria-selected={view === t.key}
                  onClick={() => showTab(t.key)}
                  className={`flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm transition-colors ${
                    view === t.key
                      ? 'bg-card text-foreground font-medium shadow-sm'
                      : 'text-muted-foreground hover:text-foreground'
                  }`}
                >
                  <t.icon size={15} /> {t.label}
                </button>
              ))}
            </div>
          )}

          {view === 'summary' && result.analysis ? (
            <>
              <p className="text-muted-foreground text-xs">
                {result.periodLabel} · {result.rowCount.toLocaleString('en-IN')}{' '}
                {result.rowCount === 1 ? 'row' : 'rows'}
                {result.truncated && (
                  <span className="text-amber-400">
                    {' '}
                    of {result.totalRows.toLocaleString('en-IN')} — the export will be marked PARTIAL
                  </span>
                )}
              </p>

              {/* Figures only: the KPI cards, one table of totals under them,
                then what needs attention. No charts. */}
              <ReportDashboard analysis={result.analysis}>
                <SummaryTable
                  columns={(result as RegisterData).columns}
                  rows={result.rows}
                  spec={result.register.spec}
                  grand={result.register.totals.grand}
                  groupKeys={grouping.rows}
                  valueKeys={grouping.values}
                />
              </ReportDashboard>
            </>
          ) : (
            // The detailed report: the sheet the PDF prints and the workbook holds.
            <RegisterSheet data={result as RegisterData} mode="screen" />
          )}
        </>
      ) : null}
    </div>
  )
}
