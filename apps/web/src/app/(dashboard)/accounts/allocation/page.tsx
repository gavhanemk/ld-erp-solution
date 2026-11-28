'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AlertCircle, AlertTriangle, CalendarRange, ListChecks, Pencil, Plus, RefreshCw, Trash2 } from 'lucide-react'
import { api, apiErrorMessage, can } from '@/lib/api'
import { newRequestId } from '@/lib/utils'
import { StepInput } from '@/components/ui/StepInput'
import { inr, todayIst } from '@/components/accounts/books'
import { AllocationRuleDialog, type AllocationChoices, type AllocationRule } from '@/components/accounts/AllocationRuleDialog'
import { AllocationRunView, RUN_STATUS, type AllocationRunRow } from '@/components/accounts/AllocationRunView'

type Tab = 'months' | 'rules'
interface Overview extends AllocationChoices {
  rules: AllocationRule[]
  runs: Array<AllocationRunRow & { allocated: number; inputs: Record<string, Record<string, number>> }>
}
interface Worked {
  period: string
  words: string
  rules: Array<{ ruleId: string; name: string; basis: string; shares: Array<{ costCentreId: string; name: string; basisValue: number; percent: number }>; covers: number; problem: string | null }>
  lines: Array<{ ruleId: string; ledgerId: string; ledger: string; departmentId: string | null; department: string | null; sharedAmount: number; splits: Array<{ costCentreId: string; name: string; basisValue: number; percent: number; amount: number }> }>
  notCovered: Array<{ ledgerId: string; ledger: string; departmentId: string | null; department: string | null; amount: number }>
  totals: { shared: number; allocated: number; notCovered: number }
  problems: string[]
  live: { id: string; runNumber: string; status: AllocationRunRow['status'] } | null
}

/** The month before this one, as 2026-10: the usual month to split. */
const lastMonth = (today: string) => {
  const d = new Date(`${today.slice(0, 7)}-01T00:00:00Z`)
  d.setUTCMonth(d.getUTCMonth() - 1)
  return d.toISOString().slice(0, 7)
}
const pct = (p: number) => `${Math.round(p * 100) / 100}%`

/**
 * Accounts → Expense Allocation. Shared expenses — booked with no brand —
 * split between the brands month by month, by rules set here: worked out
 * and previewed, saved as a draft, approved by someone else, posted as one
 * journal, reversed if it must be done again. Ledger, department and company
 * totals never move; only the brand split does.
 */
export default function ExpenseAllocationPage() {
  const today = todayIst()
  const [tab, setTab] = useState<Tab>('months')
  const [data, setData] = useState<Overview | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [month, setMonth] = useState(lastMonth(today))
  const [inputs, setInputs] = useState<Record<string, Record<string, string>>>({})
  const [worked, setWorked] = useState<Worked | null>(null)
  const [working, setWorking] = useState(false)
  const [saving, setSaving] = useState(false)
  const [openRun, setOpenRun] = useState<string | null>(null)
  const [editing, setEditing] = useState<AllocationRule | 'new' | null>(null)
  const requestId = useRef(newRequestId())
  const may = (action: string) => can('accounts.allocation', action)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      setData((await api.get<{ data: Overview }>('/accounts/allocation')).data)
    } catch (err) {
      setError(apiErrorMessage(err, 'Could not load expense allocation.'))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
    // Opened from a journal in the day book: ?q=ALC-2627-0001 opens its run.
    const q = new URLSearchParams(window.location.search).get('q')
    if (q) {
      api
        .get<{ data: Overview }>('/accounts/allocation')
        .then((r) => {
          const hit = r.data.runs.find((x) => x.runNumber === q)
          if (hit) setOpenRun(hit.id)
        })
        .catch(() => undefined)
    }
  }, [load])

  const typedNumbers = useCallback(
    () =>
      Object.fromEntries(
        Object.entries(inputs).map(([ruleId, byBrand]) => [ruleId, Object.fromEntries(Object.entries(byBrand).map(([c, v]) => [c, Number(v) || 0]))]),
      ),
    [inputs],
  )

  const workItOut = useCallback(async () => {
    setWorking(true)
    setError(null)
    try {
      setWorked((await api.post<{ data: Worked }>('/accounts/allocation/preview', { period: month, inputs: typedNumbers() })).data)
    } catch (err) {
      setWorked(null)
      setError(apiErrorMessage(err, 'Could not work the month out.'))
    } finally {
      setWorking(false)
    }
  }, [month, typedNumbers])

  // A new month is worked out at once; typed figures wait for the button.
  useEffect(() => {
    if (tab === 'months') void workItOut()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [month, tab])

  const saveDraft = async () => {
    setSaving(true)
    setError(null)
    try {
      const res = await api.post<{ data: { id: string }; message: string }>('/accounts/allocation/runs', { period: month, inputs: typedNumbers(), requestId: requestId.current })
      requestId.current = newRequestId()
      setMessage(res.message)
      setOpenRun(res.data.id)
      await Promise.all([load(), workItOut()])
    } catch (err) {
      setError(apiErrorMessage(err, 'Could not save the run.'))
    } finally {
      setSaving(false)
    }
  }

  const deleteRule = async (r: AllocationRule) => {
    if (!window.confirm(`Delete the rule ${r.name}?`)) return
    try {
      setMessage((await api.delete<{ message: string }>(`/accounts/allocation/rules/${r.id}`)).message)
      await load()
    } catch (err) {
      setError(apiErrorMessage(err, 'Could not delete the rule.'))
    }
  }

  // Rules typed on the run (machine hours, typed percentages) that cover something this month.
  const typedRules = useMemo(() => {
    if (!data || !worked) return []
    return data.rules
      .filter((r) => r.isActive && r.typed && (worked.rules.find((w) => w.ruleId === r.id)?.covers ?? 0) > 0)
      .map((r) => ({ rule: r, brands: r.brands.length ? r.brands : data.brands }))
  }, [data, worked])

  const brandCols = useMemo(() => {
    const seen = new Map<string, string>()
    for (const l of worked?.lines ?? []) for (const x of l.splits) if (!seen.has(x.costCentreId)) seen.set(x.costCentreId, x.name)
    return [...seen.entries()].map(([id, name]) => ({ id, name }))
  }, [worked])

  return (
    <div className="space-y-5">
      <div className="page-header gap-3">
        <div className="flex min-w-0 flex-wrap items-center gap-4">
          <div className="min-w-0">
            <h1 className="page-title text-xl sm:text-2xl">Expense Allocation</h1>
            <p className="page-subtitle hidden sm:block">Shared expenses split between the brands, month by month</p>
          </div>
          <div className="border-border bg-secondary flex rounded-lg border p-1" role="tablist">
            {(
              [
                { key: 'months', label: 'Months', icon: CalendarRange },
                { key: 'rules', label: 'Rules', icon: ListChecks },
              ] as const
            ).map((t) => (
              <button
                key={t.key}
                type="button"
                role="tab"
                aria-selected={tab === t.key}
                onClick={() => setTab(t.key)}
                className={`flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm transition-colors ${tab === t.key ? 'bg-card text-foreground font-medium shadow-sm' : 'text-muted-foreground hover:text-foreground'}`}
              >
                <t.icon size={15} />
                {t.label}
              </button>
            ))}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <button className="btn-ghost" onClick={() => void (tab === 'months' ? Promise.all([load(), workItOut()]) : load())} disabled={loading || working} aria-label="Refresh">
            <RefreshCw size={15} className={loading || working ? 'animate-spin' : undefined} />
          </button>
          {tab === 'rules' && may('create') && (
            <button type="button" className="btn-primary" onClick={() => setEditing('new')} disabled={!data}>
              <Plus size={15} /> <span className="hidden sm:inline">New rule</span>
            </button>
          )}
        </div>
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
      {loading && !data && <div className="skeleton h-48 w-full rounded-xl" />}

      {tab === 'months' && data && (
        <>
          <div className="glass-card flex flex-wrap items-center gap-2 p-3">
            <span className="text-muted-foreground text-xs">Month</span>
            <input type="month" className="form-input h-9 w-[170px]" value={month} max={today.slice(0, 7)} onChange={(e) => e.target.value && setMonth(e.target.value)} aria-label="Month" />
            <button type="button" className="btn-ghost h-9" onClick={() => void workItOut()} disabled={working}>
              {working ? 'Working out…' : 'Work it out'}
            </button>
            {!data.rules.some((r) => r.isActive) && (
              <span className="text-muted-foreground text-xs">
                No rule yet.{' '}
                <button type="button" className="text-primary hover:underline" onClick={() => setTab('rules')}>
                  Add one under Rules
                </button>
                .
              </span>
            )}
          </div>

          {worked && (
            <>
              {worked.live && (
                <div className="flex flex-wrap items-center gap-3 rounded-lg border border-amber-500/40 bg-amber-500/5 p-3">
                  <AlertTriangle size={16} className="shrink-0 text-amber-600" />
                  <p className="text-foreground text-sm">
                    {worked.words} already has {worked.live.runNumber} ({RUN_STATUS[worked.live.status].label.toLowerCase()}).{' '}
                    {worked.live.status === 'POSTED' ? 'Reverse it to run the month again.' : 'Approve and post it, or discard it to start again.'}
                  </p>
                  <button type="button" className="btn-ghost h-8 text-xs" onClick={() => setOpenRun(worked.live!.id)}>
                    Open {worked.live.runNumber}
                  </button>
                </div>
              )}

              <div className="grid grid-cols-2 gap-2 lg:grid-cols-3">
                {[
                  { label: `Shared expenses, ${worked.words}`, value: worked.totals.shared },
                  { label: 'Split by the rules', value: worked.totals.allocated },
                  { label: 'Left shared (no rule covers it)', value: worked.totals.notCovered },
                ].map((x) => (
                  <div key={x.label} className="glass-card p-3">
                    <p className="text-muted-foreground text-[11px]">{x.label}</p>
                    <p className="text-foreground mt-0.5 text-lg font-semibold tabular-nums">₹{inr(x.value)}</p>
                  </div>
                ))}
              </div>

              {typedRules.map(({ rule, brands }) => (
                <div key={rule.id} className="glass-card p-3">
                  <p className="text-foreground text-sm font-medium">
                    {rule.name} <span className="text-muted-foreground font-normal">— {rule.basis === 'MACHINE_HOURS' ? 'machine hours this month' : 'percentages this month (making 100%)'}</span>
                  </p>
                  <div className="mt-2 flex flex-wrap gap-3">
                    {brands.map((b) => (
                      <label key={b.id} className="block w-40">
                        <span className="form-label truncate">{b.name}</span>
                        <StepInput
                          className="form-input h-9 text-right"
                          value={inputs[rule.id]?.[b.id] ?? ''}
                          onValueChange={(v) => setInputs({ ...inputs, [rule.id]: { ...(inputs[rule.id] ?? {}), [b.id]: v } })}
                          min={0}
                          max={rule.basis === 'MANUAL' ? 100 : 1_000_000}
                          decimals
                          aria-label={`${rule.name}: ${b.name}`}
                        />
                      </label>
                    ))}
                    <button type="button" className="btn-ghost h-9 self-end" onClick={() => void workItOut()} disabled={working}>
                      Work it out
                    </button>
                  </div>
                </div>
              ))}

              {worked.problems.length > 0 && (
                <div className="flex items-start gap-3 rounded-lg border border-amber-500/40 bg-amber-500/5 p-3">
                  <AlertTriangle size={16} className="mt-0.5 shrink-0 text-amber-600" />
                  <div className="text-foreground space-y-1 text-sm">
                    {worked.problems.map((p) => (
                      <p key={p}>{p}</p>
                    ))}
                  </div>
                </div>
              )}

              {worked.lines.length > 0 && (
                <div className="glass-card overflow-hidden p-0">
                  <div className="border-border flex flex-wrap items-center justify-between gap-2 border-b px-4 py-2.5">
                    <p className="text-foreground text-sm font-semibold">How {worked.words} splits</p>
                    {may('create') && !worked.live && (
                      <button type="button" className="btn-primary h-9" onClick={() => void saveDraft()} disabled={saving || working}>
                        {saving ? 'Saving…' : 'Save as a draft run'}
                      </button>
                    )}
                  </div>
                  <div className="overflow-x-auto">
                    <table className="data-table table-compact table-totals w-full min-w-[720px]">
                      <thead>
                        <tr>
                          <th>Ledger</th>
                          <th>Department</th>
                          <th>Rule</th>
                          <th className="text-right">Shared</th>
                          {brandCols.map((b) => (
                            <th key={b.id} className="text-right">
                              {b.name}
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {worked.lines.map((l) => (
                          <tr key={`${l.ledgerId}|${l.departmentId ?? ''}`}>
                            <td>{l.ledger}</td>
                            <td>{l.department ?? <span className="text-muted-foreground">None</span>}</td>
                            <td>{worked.rules.find((r) => r.ruleId === l.ruleId)?.name ?? ''}</td>
                            <td className="text-right tabular-nums">{inr(l.sharedAmount)}</td>
                            {brandCols.map((b) => {
                              const x = l.splits.find((y) => y.costCentreId === b.id)
                              return (
                                <td key={b.id} className="text-right tabular-nums">
                                  {x && x.amount !== 0 ? (
                                    <>
                                      {inr(x.amount)}
                                      <span className="text-muted-foreground block text-[11px]">{pct(x.percent)}</span>
                                    </>
                                  ) : (
                                    ''
                                  )}
                                </td>
                              )
                            })}
                          </tr>
                        ))}
                      </tbody>
                      <tfoot>
                        <tr>
                          <td colSpan={3} className="text-right">
                            Total
                          </td>
                          <td className="text-right tabular-nums">{inr(worked.totals.allocated)}</td>
                          {brandCols.map((b) => (
                            <td key={b.id} className="text-right tabular-nums">
                              {inr(worked.lines.reduce((t, l) => t + (l.splits.find((y) => y.costCentreId === b.id)?.amount ?? 0), 0))}
                            </td>
                          ))}
                        </tr>
                      </tfoot>
                    </table>
                  </div>
                </div>
              )}

              {worked.notCovered.length > 0 && (
                <div className="glass-card overflow-hidden p-0">
                  <p className="border-border text-foreground border-b px-4 py-2.5 text-sm font-semibold">
                    Left shared: no rule covers these <span className="text-muted-foreground font-normal">— add a rule to split them, or leave them with no brand</span>
                  </p>
                  <table className="data-table table-compact w-full">
                    <thead>
                      <tr>
                        <th>Ledger</th>
                        <th>Department</th>
                        <th className="text-right">Amount</th>
                      </tr>
                    </thead>
                    <tbody>
                      {worked.notCovered.map((x) => (
                        <tr key={`${x.ledgerId}|${x.departmentId ?? ''}`}>
                          <td>{x.ledger}</td>
                          <td>{x.department ?? ''}</td>
                          <td className="text-right tabular-nums">{inr(x.amount)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              {worked.totals.shared === 0 && <p className="text-muted-foreground text-sm">No shared expense was booked in {worked.words}: every expense line carries its brand.</p>}
            </>
          )}

          <div className="glass-card overflow-hidden p-0">
            <p className="border-border text-foreground border-b px-4 py-2.5 text-sm font-semibold">Runs</p>
            {data.runs.length === 0 ? (
              <p className="text-muted-foreground px-4 py-3 text-sm">No month has been run yet.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="data-table table-compact w-full min-w-[720px]">
                  <thead>
                    <tr>
                      <th>Month</th>
                      <th>Run</th>
                      <th>Status</th>
                      <th className="text-right">Split</th>
                      <th>Worked out by</th>
                      <th>Approved by</th>
                      <th>Posted by</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.runs.map((r) => (
                      <tr key={r.id} className="cursor-pointer" onClick={() => setOpenRun(r.id)}>
                        <td>{r.words}</td>
                        <td>
                          <button type="button" className="text-primary font-mono text-xs hover:underline" onClick={() => setOpenRun(r.id)}>
                            {r.runNumber}
                          </button>
                        </td>
                        <td>
                          <span className={RUN_STATUS[r.status].badge}>{RUN_STATUS[r.status].label}</span>
                        </td>
                        <td className="text-right tabular-nums">{inr(r.allocated)}</td>
                        <td>{r.createdBy ?? ''}</td>
                        <td>{r.approvedBy ?? ''}</td>
                        <td>{r.postedBy ?? ''}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
          <p className="text-muted-foreground text-xs">
            Splitting moves shared expenses onto the brands only: every ledger’s and department’s total, and the company’s, stay as booked. Stock purchases are never shared — stock stays central until it moves to a brand.
          </p>
        </>
      )}

      {tab === 'rules' && data && (
        <div className="glass-card overflow-hidden p-0">
          {data.rules.length === 0 ? (
            <p className="text-muted-foreground px-4 py-3 text-sm">No rule yet. A rule says which shared expenses it covers, which brands share them, and on what basis.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="data-table table-compact w-full min-w-[860px]">
                <thead>
                  <tr>
                    <th className="w-14">Order</th>
                    <th>Rule</th>
                    <th>Split by</th>
                    <th>Covers</th>
                    <th>Brands</th>
                    <th className="w-20" />
                  </tr>
                </thead>
                <tbody>
                  {data.rules.map((r) => (
                    <tr key={r.id} className={r.isActive ? '' : 'opacity-60'}>
                      <td className="tabular-nums">{r.sortOrder}</td>
                      <td>
                        {r.name}
                        {!r.isActive && <span className="badge-neutral ml-1.5">Off</span>}
                        {r.notes && <span className="text-muted-foreground block text-[11px]">{r.notes}</span>}
                      </td>
                      <td>{r.basisWords}</td>
                      <td className="text-xs">
                        {r.ledgers.length ? r.ledgers.map((l) => l.name).join(', ') : 'Every shared expense ledger'}
                        <span className="text-muted-foreground block">{r.departments.length ? r.departments.map((d) => d.name).join(', ') : 'any department'}</span>
                      </td>
                      <td className="text-xs">
                        {r.basis === 'FIXED_PERCENT'
                          ? r.shares.map((s) => `${s.name} ${pct(s.percent)}`).join(', ')
                          : r.brands.length
                            ? r.brands.map((b) => b.name).join(', ')
                            : 'Every own brand'}
                      </td>
                      <td className="whitespace-nowrap text-right">
                        {may('edit') && (
                          <button type="button" className="btn-ghost h-7 px-2" onClick={() => setEditing(r)} aria-label={`Edit ${r.name}`}>
                            <Pencil size={13} />
                          </button>
                        )}
                        {may('delete') && r.usedInRuns === 0 && (
                          <button type="button" className="btn-ghost text-destructive h-7 px-2" onClick={() => void deleteRule(r)} aria-label={`Delete ${r.name}`}>
                            <Trash2 size={13} />
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {editing && data && (
        <AllocationRuleDialog
          rule={editing === 'new' ? null : editing}
          choices={data}
          onClose={() => setEditing(null)}
          onSaved={(m) => {
            setEditing(null)
            setMessage(m)
            void load()
          }}
        />
      )}
      {openRun && (
        <AllocationRunView
          id={openRun}
          onClose={() => setOpenRun(null)}
          onChanged={(m) => {
            setMessage(m)
            void load()
            void workItOut()
          }}
        />
      )}
    </div>
  )
}
