'use client'

import { useMemo, useState } from 'react'
import { History } from 'lucide-react'
import { PHASE, dayKey, fmtDayLong, fmtTime, type Phase, type Step } from './traceTypes'

/**
 * What happened, in order, a day at a time: the time, what happened, the
 * document it happened on and who did it.
 *
 * Plain by default: the steps of the journey — ordered, materials issued,
 * cut, sent from one process to the next, any problem a check found, into
 * the store, despatched. "Every step" adds the details in between: counted
 * in, worked on, approvals, reprints. The chips narrow it to one part of the
 * journey — just the checks, just despatch.
 */
export function Timeline({ steps: all, newestFirst = false }: { steps: Step[]; newestFirst?: boolean }) {
  const [only, setOnly] = useState<Phase | null>(null)
  const [every, setEvery] = useState(false)
  const details = all.filter((s) => s.minor).length
  const steps = useMemo(() => (every ? all : all.filter((s) => !s.minor)), [all, every])
  const phases = useMemo(() => {
    const count = new Map<Phase, number>()
    for (const s of steps) count.set(s.phase, (count.get(s.phase) ?? 0) + 1)
    return (Object.keys(PHASE) as Phase[]).filter((p) => count.has(p)).map((p) => ({ p, n: count.get(p)! }))
  }, [steps])
  const shown = (only ? steps.filter((s) => s.phase === only) : steps).slice()
  if (newestFirst) shown.reverse()
  const days: Array<{ key: string; label: string; items: Step[] }> = []
  for (const s of shown) {
    const k = dayKey(s.at)
    const last = days[days.length - 1]
    if (last && last.key === k) last.items.push(s)
    else days.push({ key: k, label: fmtDayLong(s.at), items: [s] })
  }

  return (
    <div className="glass-card overflow-hidden p-0">
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-3">
        <History size={16} className="text-primary" />
        <h3 className="mr-1 text-sm font-semibold text-foreground">History</h3>
        {details > 0 && (
          <div className="mr-2 flex rounded-lg border border-border bg-secondary p-0.5 text-xs" role="tablist" aria-label="How much to show">
            {([
              { on: false, label: 'Key steps' },
              { on: true, label: `Every step (+${details})` },
            ] as const).map((t) => (
              <button
                key={t.label}
                type="button"
                role="tab"
                aria-selected={every === t.on}
                onClick={() => setEvery(t.on)}
                className={`rounded-md px-2.5 py-1 font-medium transition-colors ${every === t.on ? 'bg-card text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'}`}
              >
                {t.label}
              </button>
            ))}
          </div>
        )}
        <button
          type="button"
          onClick={() => setOnly(null)}
          className={`rounded-full border px-2.5 py-0.5 text-xs font-medium ${only === null ? 'border-primary bg-primary/10 text-primary' : 'border-border text-muted-foreground hover:text-foreground'}`}
        >
          All {steps.length}
        </button>
        {phases.map(({ p, n }) => (
          <button
            key={p}
            type="button"
            onClick={() => setOnly(only === p ? null : p)}
            className={`rounded-full border px-2.5 py-0.5 text-xs font-medium ${only === p ? PHASE[p].chip : 'border-border text-muted-foreground hover:text-foreground'}`}
          >
            {PHASE[p].label} {n}
          </button>
        ))}
      </div>
      {!days.length ? (
        <p className="p-6 text-center text-sm text-muted-foreground">Nothing recorded yet.</p>
      ) : (
        <div className="space-y-4 p-4">
          {days.map((d) => (
            <section key={d.key}>
              <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{d.label}</h4>
              <ol className="relative ml-[4.5rem] border-l border-border">
                {d.items.map((s, i) => {
                  const ph = PHASE[s.phase]
                  const Icon = ph.icon
                  return (
                    <li key={i} className={`relative pb-3 pl-5 last:pb-0 ${s.undone ? 'opacity-50' : s.minor ? 'opacity-70' : ''}`}>
                      <span className="absolute -left-[4.5rem] top-0.5 w-14 text-right text-xs tabular-nums text-muted-foreground">{fmtTime(s.at)}</span>
                      <span className={`absolute -left-[0.6rem] top-0 flex h-5 w-5 items-center justify-center rounded-full ${ph.dot} text-white ring-4 ring-card`}>
                        <Icon size={11} />
                      </span>
                      <div className="flex flex-wrap items-baseline gap-x-2">
                        <span className={`text-sm font-semibold text-foreground ${s.undone ? 'line-through' : ''}`}>{s.title}</span>
                        {s.ref && <span className="rounded border border-border bg-secondary px-1.5 font-mono text-[11px] text-foreground">{s.ref}</span>}
                        {s.undone && <span className="text-xs text-muted-foreground">undone later</span>}
                      </div>
                      {s.detail && <p className="text-sm text-muted-foreground">{s.detail}</p>}
                      {s.by && <p className="text-xs text-muted-foreground">by {s.by}</p>}
                    </li>
                  )
                })}
              </ol>
            </section>
          ))}
        </div>
      )}
    </div>
  )
}
