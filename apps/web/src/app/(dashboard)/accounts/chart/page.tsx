'use client'

import { Fragment, useCallback, useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { AlertCircle, CalendarCheck, FolderTree, Info, Loader2, Lock, Pencil, Plus, RefreshCw, Search, Trash2, Wallet, X } from 'lucide-react'
import { api, apiErrorMessage, can } from '@/lib/api'
import { useEscape } from '@/lib/useEscape'
import { SmartSelect } from '@/components/ui/SmartSelect'
import { LedgerDialog } from '@/components/accounts/LedgerDialog'
import { NATURE_LABEL, day, drCr, todayIst, type BooksSummary, type Group, type Ledger } from '@/components/accounts/books'

type Tab = 'ledgers' | 'groups' | 'settings'

const KIND_FILTERS: Array<{ value: string; label: string }> = [
  { value: '', label: 'Every ledger' },
  { value: 'customer', label: 'Customers' },
  { value: 'supplier', label: 'Suppliers' },
  { value: 'broker', label: 'Brokers' },
  { value: 'contractor', label: 'Contractors' },
  { value: 'bank', label: 'Banks' },
  { value: 'none', label: 'Not a party' },
]

/**
 * The chart of accounts: every ledger and the group it sits in, the group
 * tree, and the books' two dates — the day they start and the day they are
 * closed up to.
 *
 * The standard groups and the ledgers of customers, suppliers, brokers,
 * contractors and banks are made by the system; the rest — capital, loans,
 * expenses, fixed assets — are made here. Opening balances from the old books
 * are typed on each ledger, and the trial balance shows if they do not agree.
 *
 * ?tab=groups or ?tab=settings opens that tab.
 */
export default function ChartOfAccountsPage() {
  const [tab, setTab] = useState<Tab>('ledgers')
  const [summary, setSummary] = useState<BooksSummary | null>(null)
  const [ledgers, setLedgers] = useState<Ledger[]>([])
  const [groups, setGroups] = useState<Group[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)

  const [search, setSearch] = useState('')
  const [groupFilter, setGroupFilter] = useState('')
  const [kindFilter, setKindFilter] = useState('')
  const [editing, setEditing] = useState<Ledger | null | undefined>(undefined)
  const [groupForm, setGroupForm] = useState<{ group: Group | null; parentId: string } | null>(null)

  useEffect(() => {
    const t = new URLSearchParams(window.location.search).get('tab')
    if (t === 'groups' || t === 'settings') setTab(t)
  }, [])

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const [s, l, g] = await Promise.all([
        api.get<{ data: BooksSummary }>('/accounts/summary'),
        api.get<{ data: Ledger[] }>('/accounts/ledgers?balances=1'),
        api.get<{ data: Group[] }>('/accounts/groups'),
      ])
      setSummary(s.data)
      setLedgers(l.data)
      setGroups(g.data)
    } catch (err) {
      setError(apiErrorMessage(err, 'Could not load the chart of accounts.'))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  /** A group and every group under it. */
  const below = useMemo(() => {
    const kids = new Map<string, string[]>()
    for (const g of groups) if (g.parentId) kids.set(g.parentId, [...(kids.get(g.parentId) ?? []), g.id])
    return (id: string) => {
      const out = new Set([id])
      const walk = (x: string) => (kids.get(x) ?? []).forEach((k) => (out.add(k), walk(k)))
      walk(id)
      return out
    }
  }, [groups])

  const shown = useMemo(() => {
    const q = search.trim().toLowerCase()
    const inGroup = groupFilter ? below(groupFilter) : null
    return ledgers.filter((l) => {
      if (q && !l.name.toLowerCase().includes(q) && !(l.partyCode ?? '').toLowerCase().includes(q)) return false
      if (inGroup && !inGroup.has(l.groupId)) return false
      if (kindFilter === 'none') return !l.partyType
      if (kindFilter) return l.partyType === kindFilter.toUpperCase()
      return true
    })
  }, [ledgers, search, groupFilter, kindFilter, below])

  const openingDifference = useMemo(() => Math.round(ledgers.reduce((t, l) => t + l.openingBalance, 0) * 100) / 100, [ledgers])

  const groupTree = useMemo(() => {
    const byParent = new Map<string | null, Group[]>()
    for (const g of groups) byParent.set(g.parentId, [...(byParent.get(g.parentId) ?? []), g])
    const out: Array<{ g: Group; depth: number }> = []
    const walk = (p: string | null, depth: number) => {
      for (const g of (byParent.get(p) ?? []).sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name))) {
        out.push({ g, depth })
        walk(g.id, depth + 1)
      }
    }
    walk(null, 0)
    return out
  }, [groups])

  const deleteGroup = async (g: Group) => {
    if (!window.confirm(`Delete the group ${g.name}?`)) return
    try {
      await api.delete(`/accounts/groups/${g.id}`)
      setMessage(`${g.name} deleted`)
      void load()
    } catch (err) {
      setError(apiErrorMessage(err, 'Could not delete the group.'))
    }
  }

  return (
    <div className="space-y-5">
      <div className="page-header gap-3">
        <div className="flex min-w-0 flex-wrap items-center gap-4">
          <div className="min-w-0">
            <h1 className="page-title text-xl sm:text-2xl">Chart of Accounts</h1>
            <p className="page-subtitle hidden sm:block">Ledgers, the groups they sit in, and the books&apos; dates</p>
          </div>
          <div className="border-border bg-secondary flex rounded-lg border p-1" role="tablist">
            {(
              [
                { key: 'ledgers', label: 'Ledgers', icon: Wallet, count: ledgers.length },
                { key: 'groups', label: 'Groups', icon: FolderTree, count: groups.length },
                { key: 'settings', label: 'Books', icon: CalendarCheck, count: null },
              ] as const
            ).map((t) => (
              <button
                key={t.key}
                type="button"
                role="tab"
                aria-selected={tab === t.key}
                onClick={() => setTab(t.key)}
                className={`flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm transition-colors ${
                  tab === t.key ? 'bg-card text-foreground font-medium shadow-sm' : 'text-muted-foreground hover:text-foreground'
                }`}
              >
                <t.icon size={15} />
                {t.label}
                {t.count !== null && <span className="text-muted-foreground text-xs tabular-nums">{t.count}</span>}
              </button>
            ))}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <button className="btn-ghost" onClick={() => void load()} disabled={loading} aria-label="Refresh">
            <RefreshCw size={15} className={loading ? 'animate-spin' : undefined} />
          </button>
          {tab === 'ledgers' && can('accounts', 'create') && (
            <button className="btn-primary" onClick={() => setEditing(null)} data-hotkey="new" aria-keyshortcuts="Alt+N">
              <Plus size={15} /> <span className="hidden sm:inline">New ledger</span>
            </button>
          )}
          {tab === 'groups' && can('accounts', 'create') && (
            <button className="btn-primary" onClick={() => setGroupForm({ group: null, parentId: '' })} data-hotkey="new" aria-keyshortcuts="Alt+N">
              <Plus size={15} /> <span className="hidden sm:inline">New group</span>
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

      {tab === 'ledgers' && (
        <div className="glass-card overflow-hidden p-0">
          <div className="border-border flex flex-col gap-2 border-b px-3 py-2 sm:flex-row sm:flex-wrap sm:items-center">
            <div className="border-field-edge bg-field flex min-w-0 flex-1 items-center gap-2 rounded-lg border px-2.5 py-1.5 sm:max-w-[280px]">
              <Search size={14} className="text-muted-foreground shrink-0" />
              <input
                className="text-foreground placeholder:text-muted-foreground w-full bg-transparent text-sm outline-none"
                placeholder="Ledger name or party code"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                data-hotkey="search"
                aria-label="Search ledgers"
              />
            </div>
            <SmartSelect className="form-input h-9 sm:w-[220px]" value={groupFilter} onChange={(e) => setGroupFilter(e.target.value)} aria-label="Group">
              <option value="">Every group</option>
              {groupTree.map(({ g, depth }) => (
                <option key={g.id} value={g.id}>
                  {`${'— '.repeat(depth)}${g.name}`}
                </option>
              ))}
            </SmartSelect>
            <SmartSelect className="form-input h-9 sm:w-[170px]" value={kindFilter} onChange={(e) => setKindFilter(e.target.value)} aria-label="Kind of ledger">
              {KIND_FILTERS.map((k) => (
                <option key={k.value} value={k.value}>
                  {k.label}
                </option>
              ))}
            </SmartSelect>
            <p className="text-muted-foreground text-xs sm:ml-auto">
              {shown.length} of {ledgers.length}
            </p>
          </div>
          {loading && ledgers.length === 0 ? (
            <div className="space-y-2 p-4">
              {Array.from({ length: 8 }).map((_, i) => (
                <div key={i} className="skeleton h-10 w-full rounded-lg" />
              ))}
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="data-table w-full">
                <thead>
                  <tr>
                    <th>Ledger</th>
                    <th>Group</th>
                    <th className="hidden md:table-cell">Kind</th>
                    <th className="w-40 text-right">Opening</th>
                    <th className="w-40 text-right">Balance today</th>
                  </tr>
                </thead>
                <tbody>
                  {shown.map((l, i) => (
                    <tr key={l.id} data-row tabIndex={i === 0 ? 0 : -1} className={`cursor-pointer ${l.isActive ? '' : 'opacity-60'}`} onClick={() => setEditing(l)}>
                      <td>
                        <span className="text-foreground">{l.name}</span>
                        {!l.isActive && <span className="badge-neutral ml-2">Not in use</span>}
                        {l.billWise && <span className="text-muted-foreground block text-[11px]">bill by bill</span>}
                      </td>
                      <td className="text-muted-foreground">{l.group.name}</td>
                      <td className="text-muted-foreground hidden md:table-cell">
                        {l.partyLabel ? `${l.partyLabel}${l.partyCode ? ` · ${l.partyCode}` : ''}` : l.systemKey ? 'Used by postings' : ''}
                      </td>
                      <td className="text-right tabular-nums">{l.openingBalance ? drCr(l.openingBalance) : ''}</td>
                      <td className="text-right tabular-nums">{l.balance ? drCr(l.balance) : ''}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {openingDifference !== 0 && (
            <p className="border-border text-accent border-t px-4 py-2.5 text-xs">
              The opening balances are out by {drCr(openingDifference)}: debits and credits entered from the old books should agree.
            </p>
          )}
        </div>
      )}

      {tab === 'groups' && (
        <div className="glass-card overflow-hidden p-0">
          <div className="overflow-x-auto">
            <table className="data-table w-full">
              <thead>
                <tr>
                  <th>Group</th>
                  <th className="w-32">Holds</th>
                  <th className="w-28 text-right">Ledgers</th>
                  <th className="w-28" />
                </tr>
              </thead>
              <tbody>
                {groupTree.map(({ g, depth }, i) => (
                  <tr key={g.id} data-row tabIndex={i === 0 ? 0 : -1}>
                    <td>
                      <span style={{ paddingLeft: `${depth * 18}px` }} className={depth === 0 ? 'text-foreground font-semibold' : 'text-foreground'}>
                        {g.name}
                      </span>
                      {g.affectsGrossProfit && depth === 0 && <span className="text-muted-foreground ml-2 text-[11px]">trading account</span>}
                    </td>
                    <td className="text-muted-foreground">{NATURE_LABEL[g.nature]}</td>
                    <td className="text-right tabular-nums">{g._count.ledgers || ''}</td>
                    <td>
                      <div className="flex justify-end gap-1">
                        {can('accounts', 'create') && (
                          <button type="button" className="btn-ghost p-1.5" title="New group under this one" aria-label={`New group under ${g.name}`} onClick={() => setGroupForm({ group: null, parentId: g.id })}>
                            <Plus size={14} />
                          </button>
                        )}
                        {can('accounts', 'edit') && (
                          <button type="button" className="btn-ghost p-1.5" title="Rename" aria-label={`Rename ${g.name}`} onClick={() => setGroupForm({ group: g, parentId: g.parentId ?? '' })} data-row-open>
                            <Pencil size={14} />
                          </button>
                        )}
                        {!g.systemKey && can('accounts', 'delete') && (
                          <button type="button" className="btn-ghost p-1.5" title="Delete" aria-label={`Delete ${g.name}`} onClick={() => void deleteGroup(g)}>
                            <Trash2 size={14} />
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="border-border text-muted-foreground flex items-start gap-1.5 border-t px-4 py-2.5 text-xs">
            <Info size={13} className="mt-px shrink-0" />
            The standard groups are the ones SAB and Tally start with. They can be renamed but not moved or deleted; make groups of your own under them.
          </p>
        </div>
      )}

      {tab === 'settings' && summary && <BooksSettings summary={summary} onSaved={(m) => (setMessage(m), void load())} />}

      <LedgerDialog
        ledger={editing}
        groups={groups}
        booksStart={summary?.booksStart ?? null}
        onClose={() => setEditing(undefined)}
        onSaved={(m) => {
          setMessage(m)
          void load()
        }}
      />
      {groupForm && (
        <GroupDialog
          group={groupForm.group}
          parentId={groupForm.parentId}
          groups={groupTree}
          onClose={() => setGroupForm(null)}
          onSaved={(m) => {
            setMessage(m)
            void load()
          }}
        />
      )}
    </div>
  )
}

/** The day the books start, and the day they are closed up to. */
function BooksSettings({ summary, onSaved }: { summary: BooksSummary; onSaved: (message: string) => void }) {
  const [start, setStart] = useState(summary.booksStart ?? '')
  const [locked, setLocked] = useState(summary.lockedUpTo ?? '')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const may = can('accounts', 'approve')

  const save = async () => {
    setSaving(true)
    setError(null)
    try {
      await api.patch('/accounts/settings', { ...(start ? { booksStart: start } : {}), lockedUpTo: locked || null })
      onSaved('The books’ dates are saved')
    } catch (err) {
      setError(apiErrorMessage(err, 'Could not save the dates.'))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <div className="glass-card space-y-3 p-5">
        <h2 className="text-foreground flex items-center gap-2 text-lg font-semibold">
          <CalendarCheck size={18} /> The day the books start
        </h2>
        <p className="text-muted-foreground text-sm">
          Nothing can be dated before it. Opening balances on each ledger are as at this day — the old books&apos; trial balance on the day before. It can move only while no voucher is dated before the new day.
        </p>
        <input type="date" className="form-input max-w-[200px]" value={start} max={todayIst()} disabled={!may} onChange={(e) => setStart(e.target.value)} aria-label="Books start" />
        <p className="text-muted-foreground text-xs">
          {summary.counts.vouchers} vouchers in the books · {summary.counts.ledgers} ledgers · {summary.counts.costCentres} brands
        </p>
      </div>
      <div className="glass-card space-y-3 p-5">
        <h2 className="text-foreground flex items-center gap-2 text-lg font-semibold">
          <Lock size={18} /> Closed up to
        </h2>
        <p className="text-muted-foreground text-sm">
          Once a month is checked and filed, close it: no voucher dated on or before this day can be entered, altered or cancelled, by anyone. Leave it empty to keep every day open.
        </p>
        <div className="flex items-center gap-2">
          <input type="date" className="form-input max-w-[200px]" value={locked} min={start || undefined} max={todayIst()} disabled={!may} onChange={(e) => setLocked(e.target.value)} aria-label="Closed up to" />
          {locked && may && (
            <button type="button" className="btn-ghost h-9 px-2 text-xs" onClick={() => setLocked('')}>
              Reopen all
            </button>
          )}
        </div>
        {summary.lockedUpTo && <p className="text-muted-foreground text-xs">Closed now up to {day(summary.lockedUpTo)}.</p>}
      </div>
      {error && (
        <div className="border-destructive/40 bg-destructive/5 flex items-start gap-3 rounded-lg border p-3 lg:col-span-2">
          <AlertCircle size={16} className="text-destructive mt-0.5 shrink-0" />
          <p className="text-destructive text-sm">{error}</p>
        </div>
      )}
      {may ? (
        <div className="lg:col-span-2">
          <button className="btn-primary" onClick={() => void save()} disabled={saving || !start}>
            {saving ? <Loader2 size={15} className="animate-spin" /> : <CalendarCheck size={15} />} Save the dates
          </button>
        </div>
      ) : (
        <p className="text-muted-foreground text-xs lg:col-span-2">Only someone who can approve in Accounts sets these dates.</p>
      )}
    </div>
  )
}

/** Naming a group, or making one under another. */
function GroupDialog({
  group,
  parentId: startParent,
  groups,
  onClose,
  onSaved,
}: {
  group: Group | null
  parentId: string
  groups: Array<{ g: Group; depth: number }>
  onClose: () => void
  onSaved: (message: string) => void
}) {
  const [name, setName] = useState(group?.name ?? '')
  const [parentId, setParentId] = useState(startParent)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  useEscape(() => {
    if (!saving) onClose()
  })

  const save = async () => {
    setSaving(true)
    setError(null)
    try {
      if (group) await api.patch(`/accounts/groups/${group.id}`, { name: name.trim(), ...(group.systemKey ? {} : { parentId }) })
      else await api.post('/accounts/groups', { name: name.trim(), parentId })
      onSaved(group ? `${name.trim()} saved` : `Group ${name.trim()} made`)
      onClose()
    } catch (err) {
      setError(apiErrorMessage(err, 'Could not save the group.'))
    } finally {
      setSaving(false)
    }
  }

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm" onClick={onClose}>
      <div className="glass-card w-full max-w-md" role="dialog" aria-modal="true" aria-labelledby="grp-title" onClick={(e) => e.stopPropagation()}>
        <div className="border-border flex items-center justify-between border-b px-5 py-3.5">
          <h2 id="grp-title" className="text-foreground text-lg font-semibold">
            {group ? `Group: ${group.name}` : 'New group'}
          </h2>
          <button onClick={onClose} className="btn-ghost p-2" aria-label="Close">
            <X size={18} />
          </button>
        </div>
        <div className="space-y-3 px-5 py-4">
          {error && <p className="text-destructive text-sm">{error}</p>}
          <div>
            <label className="form-label" htmlFor="grp-name">
              Name<span className="text-destructive ml-0.5">*</span>
            </label>
            <input id="grp-name" className="form-input" maxLength={60} value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          {!group?.systemKey && (
            <div>
              <label className="form-label" htmlFor="grp-parent">
                Under<span className="text-destructive ml-0.5">*</span>
              </label>
              <SmartSelect id="grp-parent" className="form-input" value={parentId} onChange={(e) => setParentId(e.target.value)}>
                <option value="">Choose the group above it</option>
                {groups
                  .filter(({ g }) => g.id !== group?.id)
                  .map(({ g, depth }) => (
                    <Fragment key={g.id}>
                      <option value={g.id} data-sub={NATURE_LABEL[g.nature]}>
                        {`${'— '.repeat(depth)}${g.name}`}
                      </option>
                    </Fragment>
                  ))}
              </SmartSelect>
              <p className="text-muted-foreground mt-1 text-[11px]">A group holds the same kind of ledgers as the group it sits under.</p>
            </div>
          )}
        </div>
        <div className="border-border flex justify-end gap-2 border-t px-5 py-3">
          <button className="btn-ghost" onClick={onClose} disabled={saving}>
            Cancel
          </button>
          <button className="btn-primary" onClick={() => void save()} disabled={saving || name.trim().length < 2 || (!group?.systemKey && !parentId)} data-hotkey="save">
            {saving ? <Loader2 size={15} className="animate-spin" /> : null} Save group
          </button>
        </div>
      </div>
    </div>,
    document.body,
  )
}
