'use client'

import { useEffect, useMemo, useState } from 'react'
import { Factory, Loader2, Pencil, Plus, Search, Truck } from 'lucide-react'
import { masterResource, type Paginated } from '@/lib/api'
import { MasterFormDialog, type FormField } from '@/components/masters/MasterFormDialog'

/** A line, table, machine or outside unit, as the list gives it. */
export interface Line {
  id: string
  code: string
  name: string
  type: 'IN_HOUSE' | 'JOB_WORK'
  departmentId: string
  department: { id: string; name: string } | null
  operationId?: string | null
  operation?: { id: string; name: string } | null
  supplier: { id: string; name: string } | null
  capacityPerDay: number | null
  contactPerson: string | null
  phone: string | null
  isActive: boolean
  _count?: { routingSteps: number }
}

interface Process {
  id: string
  name: string
  departmentId: string
  sortOrder: number
  isActive: boolean
}

interface Group {
  key: string
  title: string
  /** For a line tied to no one process: it serves any of its department's. */
  note: string | null
  process: Process | null
  departmentId: string | null
  lines: Line[]
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`

/**
 * The lines, process by process: under Cutting its four tables, under
 * Stitching its lines and the outside units it sends to, and so on in the
 * order the garment moves. Each process adds its own line, so a new table
 * lands under the right one.
 */
export function LinesByProcess({
  fields,
  refreshKey,
  onChanged,
  startNew = false,
  onStartedNew,
}: {
  fields: FormField[]
  refreshKey: number
  onChanged: () => void
  /** The page's New Line button: a blank line form, its process to be picked. */
  startNew?: boolean
  onStartedNew?: () => void
}) {
  const [lines, setLines] = useState<Line[] | null>(null)
  const [processes, setProcesses] = useState<Process[]>([])
  const [q, setQ] = useState('')
  const [showOff, setShowOff] = useState(false)
  const [editing, setEditing] = useState<{ record: Line | null; initial?: Record<string, unknown> } | null>(null)
  const [reload, setReload] = useState(0)
  useEffect(() => {
    if (!startNew) return
    setEditing({ record: null, initial: { type: 'IN_HOUSE', isActive: true } })
    onStartedNew?.()
    // Once, when asked.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [startNew])

  useEffect(() => {
    let live = true
    void Promise.all([
      masterResource<Line>('workstations').list({ limit: 500, ...(showOff ? {} : { active: true }) }),
      masterResource<Process>('operations').list({ limit: 300, active: true, sort: 'sortOrder', order: 'asc' }),
    ])
      .then(([w, o]) => {
        if (!live) return
        setLines((w as Paginated<Line>).data)
        setProcesses((o as Paginated<Process>).data)
      })
      .catch(() => live && setLines([]))
    return () => {
      live = false
    }
  }, [refreshKey, reload, showOff])

  const groups = useMemo<Group[]>(() => {
    if (!lines) return []
    const words = q.trim().toLowerCase().split(/\s+/).filter(Boolean)
    const hit = (l: Line) =>
      !words.length ||
      words.every((w) => `${l.name} ${l.code} ${l.supplier?.name ?? ''} ${l.contactPerson ?? ''} ${l.operation?.name ?? ''} ${l.department?.name ?? ''}`.toLowerCase().includes(w))
    // Every process, in the order the garment moves, with the lines tied to it.
    const out: Group[] = processes.map((p) => ({ key: p.id, title: p.name, note: null, process: p, departmentId: p.departmentId, lines: [] }))
    const byProcess = new Map(out.map((g) => [g.key, g]))
    const loose = new Map<string, Group>()
    for (const l of lines) {
      if (!hit(l)) continue
      const g = l.operationId ? byProcess.get(l.operationId) : undefined
      if (g) {
        g.lines.push(l)
        continue
      }
      // Not tied to a process (or to one switched off): under its department.
      const key = `dept:${l.departmentId}`
      const d = loose.get(key) ?? { key, title: l.department?.name ?? 'No department', note: 'Any process of this department', process: null, departmentId: l.departmentId, lines: [] }
      d.lines.push(l)
      loose.set(key, d)
    }
    for (const g of [...out, ...loose.values()]) g.lines.sort((a, b) => Number(a.type === 'JOB_WORK') - Number(b.type === 'JOB_WORK') || a.name.localeCompare(b.name, undefined, { numeric: true }))
    // While searching, only the processes with something found.
    return [...out, ...loose.values()].filter((g) => !words.length || g.lines.length)
  }, [lines, processes, q])

  const open = (record: Line | null, initial?: Record<string, unknown>) => setEditing({ record, initial })

  return (
    <div className="space-y-3">
      <div className="glass-card flex flex-wrap items-center gap-3 p-3">
        <label className="border-border bg-secondary flex h-10 min-w-60 flex-1 items-center gap-2 rounded-lg border px-3">
          <Search size={15} className="text-muted-foreground" />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search a line, table, unit or who runs it..."
            className="text-foreground placeholder:text-muted-foreground flex-1 bg-transparent text-sm focus:outline-none"
            data-hotkey="search"
            aria-label="Search lines and tables"
          />
        </label>
        <label className="text-muted-foreground flex items-center gap-2 text-sm">
          <input type="checkbox" checked={showOff} onChange={(e) => setShowOff(e.target.checked)} className="accent-primary h-4 w-4" />
          Show switched-off
        </label>
      </div>

      {!lines ? (
        <div className="text-muted-foreground flex items-center gap-2 px-1 py-6 text-sm">
          <Loader2 size={15} className="animate-spin" /> Reading the lines…
        </div>
      ) : groups.length === 0 ? (
        <p className="text-muted-foreground px-1 py-6 text-sm">Nothing matches “{q}”.</p>
      ) : (
        <div className="grid gap-3 xl:grid-cols-2">
          {groups.map((g) => {
            const ours = g.lines.filter((l) => l.type === 'IN_HOUSE').length
            const outside = g.lines.length - ours
            return (
              <section key={g.key} className="glass-card overflow-hidden p-0" aria-label={g.title}>
                <header className="border-border flex items-center gap-3 border-b px-4 py-3">
                  <div className="min-w-0 flex-1">
                    <h3 className="text-foreground text-base font-semibold">{g.title}</h3>
                    <p className="text-muted-foreground text-xs">
                      {g.lines.length === 0
                        ? 'No lines yet'
                        : [ours ? plural(ours, 'on our floor', 'on our floor') : null, outside ? plural(outside, 'outside unit', 'outside units') : null].filter(Boolean).join(' · ')}
                      {g.note ? ` · ${g.note}` : ''}
                    </p>
                  </div>
                  {g.process && (
                    <button
                      type="button"
                      className="btn-secondary h-8 px-3 text-xs"
                      onClick={() => open(null, { departmentId: g.process!.departmentId, operationId: g.process!.id, type: 'IN_HOUSE', isActive: true })}
                      aria-label={`Add a line or table to ${g.title}`}
                    >
                      <Plus size={14} /> Add
                    </button>
                  )}
                </header>
                {g.lines.length > 0 && (
                  <ul className="divide-border divide-y">
                    {g.lines.map((l, i) => (
                      <li key={l.id} data-row tabIndex={i === 0 ? 0 : -1} className={`flex items-center gap-3 px-4 py-2.5 ${l.isActive ? '' : 'opacity-55'}`}>
                        {l.type === 'JOB_WORK' ? (
                          <Truck size={16} className="shrink-0 text-purple-400" aria-label="Outside unit" />
                        ) : (
                          <Factory size={16} className="text-primary shrink-0" aria-label="Our floor" />
                        )}
                        <div className="min-w-0 flex-1">
                          <p className="text-foreground truncate text-sm font-medium">
                            {l.name}
                            {!l.isActive && <span className="badge-neutral ml-2 align-middle text-[10px]">Switched off</span>}
                          </p>
                          <p className="text-muted-foreground truncate text-xs">
                            <span className="font-mono">{l.code}</span>
                            {l.type === 'JOB_WORK' ? ` · outside unit${l.supplier ? `, paid to ${l.supplier.name}` : ''}` : ' · our floor'}
                            {l.contactPerson || l.phone ? ` · ${[l.contactPerson, l.phone].filter(Boolean).join(' ')}` : ''}
                          </p>
                        </div>
                        <div className="text-right text-xs tabular-nums">
                          {l.capacityPerDay ? (
                            <>
                              <b className="text-foreground text-sm">{l.capacityPerDay.toLocaleString('en-IN')}</b>
                              <span className="text-muted-foreground block">pcs a day</span>
                            </>
                          ) : (
                            <span className="text-muted-foreground">—</span>
                          )}
                        </div>
                        <span className="text-muted-foreground shrink-0 whitespace-nowrap text-right text-xs" title="Routing steps that send work here">
                          {l._count?.routingSteps ? plural(l._count.routingSteps, 'routing', 'routings') : 'Not in routings'}
                        </span>
                        <button type="button" className="btn-ghost p-1.5" onClick={() => open(l)} aria-label={`Edit ${l.name}`} title="Edit" data-row-open>
                          <Pencil size={14} />
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            )
          })}
        </div>
      )}

      {editing && (
        <MasterFormDialog<Line>
          open
          onClose={() => setEditing(null)}
          onSaved={() => {
            setReload((n) => n + 1)
            onChanged()
          }}
          resource="workstations"
          fields={fields}
          record={editing.record}
          initialValues={editing.initial}
          title="Line"
          columns={4}
          wide
        />
      )}
    </div>
  )
}
