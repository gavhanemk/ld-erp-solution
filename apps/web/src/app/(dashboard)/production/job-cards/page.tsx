'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { AlertCircle, RefreshCw, Search } from 'lucide-react'
import { api, ApiError, type Paginated } from '@/lib/api'
import { formatDate } from '@/lib/utils'
import { useAppSettings } from '@/lib/appSettings'
import { Pagination } from '@/components/tables/Pagination'
import { SmartSelect } from '@/components/ui/SmartSelect'
import { JobCardView } from '@/components/production/floor/JobCardView'
import { pcs, refNo } from '@/components/production/floor/types'

/**
 * Job cards: one for each colour (or design) of a manufacturing order, made
 * when the order is released. Each carries the header every sheet of it
 * prints, and opens onto its process forms — cutting first, then each stage
 * of its route to the last check.
 */
interface Row {
  id: string
  jobCardNumber: string
  orderNo: string | null
  projectId: string | null
  designNo: string | null
  lotNo: string | null
  moLine: { id: string; color: string; totalQty: number; style: { code: string; name: string } }
  mo: { id: string; moNumber: string; status: string; heldAt: string | null; plannedEndDate: string | null; so: { soNumber: string; customer: { name: string } } | null; steps: unknown[] }
  cut: number
  withCutters: number
  packed: number
  atStages: string[]
  state: 'NO_STAGES' | 'NOT_STARTED' | 'IN_PROGRESS' | 'DONE'
}

const STATE: Record<Row['state'], { label: string; cls: string }> = {
  NO_STAGES: { label: 'Stages not loaded', cls: 'badge-warning' },
  NOT_STARTED: { label: 'Not started', cls: 'badge-neutral' },
  IN_PROGRESS: { label: 'In production', cls: 'badge-info' },
  DONE: { label: 'Completed', cls: 'badge-success' },
}

export default function JobCardsPage() {
  const { rowsPerPage } = useAppSettings()
  const [rows, setRows] = useState<Row[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [show, setShow] = useState('open')
  const [search, setSearch] = useState('')
  const [debounced, setDebounced] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [opened, setOpened] = useState<string | null>(null)
  const latest = useRef(0)

  useEffect(() => {
    const t = setTimeout(() => setDebounced(search), 350)
    return () => clearTimeout(t)
  }, [search])
  useEffect(() => setPage(1), [debounced, show])
  useEffect(() => {
    const id = new URLSearchParams(window.location.search).get('open')
    if (id) setOpened(id)
  }, [])

  const load = useCallback(async () => {
    const ticket = ++latest.current
    setLoading(true)
    setError(null)
    try {
      const qs = new URLSearchParams({ page: String(page), limit: String(rowsPerPage), show })
      if (debounced) qs.set('q', debounced)
      const res = await api.get<Paginated<Row>>(`/production/job-cards?${qs}`)
      if (ticket !== latest.current) return
      setRows(res.data)
      setTotal(res.pagination.total)
    } catch (err) {
      if (ticket === latest.current) setError(err instanceof ApiError ? err.message : 'Could not load the job cards.')
    } finally {
      if (ticket === latest.current) setLoading(false)
    }
  }, [page, rowsPerPage, show, debounced])

  useEffect(() => {
    void load()
  }, [load])

  return (
    <div className="space-y-4">
      <div className="page-header">
        <div>
          <h1 className="page-title text-xl sm:text-2xl">Job Cards</h1>
          <p className="page-subtitle hidden sm:block">One for each colour of a manufacturing order: its header, and its process forms from cutting to the last check</p>
        </div>
        <button className="btn-ghost" onClick={() => void load()} disabled={loading} aria-label="Refresh">
          <RefreshCw size={15} className={loading ? 'animate-spin' : undefined} />
        </button>
      </div>

      {error && (
        <div className="border-destructive/40 bg-destructive/5 flex items-start gap-3 rounded-lg border p-3">
          <AlertCircle size={16} className="text-destructive mt-0.5 shrink-0" />
          <p className="text-destructive text-sm">{error}</p>
        </div>
      )}

      <div className="glass-card overflow-hidden p-0">
        <div className="border-border flex flex-wrap items-center gap-2 border-b px-4 py-3">
          <div className="bg-field border-field-edge flex min-w-[200px] max-w-sm flex-1 items-center gap-2 rounded-lg border px-3 py-1.5">
            <Search size={14} className="text-muted-foreground" />
            <input
              className="text-foreground placeholder:text-muted-foreground flex-1 border-0 bg-transparent text-sm outline-none"
              placeholder="Job card, order, design, colour, customer…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              aria-label="Search"
              data-hotkey="search"
            />
          </div>
          <SmartSelect className="form-input h-8 w-40 py-0 text-xs" value={show} onChange={(e) => setShow(e.target.value)} aria-label="Show">
            <option value="open">Not finished</option>
            <option value="all">All</option>
          </SmartSelect>
          <span className="text-muted-foreground ml-auto text-xs">{total} job cards</span>
        </div>

        {loading && !rows.length ? (
          <div className="space-y-2 p-4">
            {[0, 1, 2].map((i) => (
              <div key={i} className="skeleton h-14 w-full rounded-lg" />
            ))}
          </div>
        ) : !rows.length ? (
          <p className="text-muted-foreground px-4 py-10 text-center text-sm">No job cards here. Each colour of a manufacturing order gets one when the order is released.</p>
        ) : (
          <div className="list-scope overflow-x-auto">
            <table className="data-table w-full min-w-[980px]">
              <thead>
                <tr className="bg-secondary">
                  <th>Job card</th>
                  <th>Ref no.</th>
                  <th>Order</th>
                  <th>Style · colour</th>
                  <th style={{ textAlign: 'right' }}>Qty</th>
                  <th style={{ textAlign: 'right' }}>Cut</th>
                  <th>Where now</th>
                  <th style={{ textAlign: 'right' }}>Packed</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => {
                  const st = STATE[r.state]
                  return (
                    <tr key={r.id} className="cursor-pointer" onClick={() => setOpened(r.id)} data-row tabIndex={i === 0 ? 0 : -1}>
                      <td className="text-primary font-mono text-xs">{r.jobCardNumber}</td>
                      <td className="font-mono text-[11px]">{refNo(r)}</td>
                      <td className="text-xs">
                        {r.mo.moNumber}
                        <span className="text-muted-foreground block text-[11px]">
                          {r.mo.so ? `${r.mo.so.soNumber} · ${r.mo.so.customer.name}` : ''}
                          {r.mo.plannedEndDate ? ` · due ${formatDate(r.mo.plannedEndDate)}` : ''}
                        </span>
                      </td>
                      <td className="text-xs">
                        <span className="font-medium">{r.moLine.style.code}</span> · {r.moLine.color}
                        {r.designNo ? <span className="text-muted-foreground block text-[11px]">Design {r.designNo}</span> : null}
                      </td>
                      <td className="text-right text-xs tabular-nums">{pcs(r.moLine.totalQty)}</td>
                      <td className="text-right text-xs tabular-nums">
                        {r.cut ? pcs(r.cut) : '—'}
                        {r.withCutters ? <span className="text-muted-foreground block text-[11px]">{pcs(r.withCutters)} with cutters</span> : null}
                      </td>
                      <td className="text-xs">{r.atStages.length ? r.atStages.join(', ') : '—'}</td>
                      <td className="text-right text-xs tabular-nums">{r.packed ? pcs(r.packed) : '—'}</td>
                      <td className="text-xs">
                        <span className={st.cls}>{st.label}</span>
                        {r.mo.heldAt && <span className="badge-warning ml-1">On hold</span>}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
        <Pagination page={page} pages={Math.ceil(total / rowsPerPage) || 1} onPageChange={setPage} busy={loading} />
      </div>

      {opened && (
        <JobCardView
          jobCardId={opened}
          onClose={() => {
            setOpened(null)
            void load()
          }}
        />
      )}
    </div>
  )
}
