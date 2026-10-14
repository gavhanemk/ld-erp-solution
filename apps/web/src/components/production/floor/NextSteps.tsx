'use client'

import { ListChecks, type LucideIcon } from 'lucide-react'

/**
 * "What to do now" at the top of a sheet: each thing waiting at the stage in
 * plain words, with the button that does it beside it. When nothing waits,
 * a line saying what the stage is waiting for.
 */
export interface NextStep {
  key: string
  text: React.ReactNode
  tone?: 'act' | 'warn' | 'info'
  actions?: Array<{ label: string; icon: LucideIcon; onClick: () => void; primary?: boolean; disabled?: boolean }>
}

export function NextSteps({ items, idle }: { items: NextStep[]; idle: string }) {
  return (
    <div className="border-primary/30 bg-primary/5 rounded-lg border p-3">
      <p className="text-primary mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide">
        <ListChecks size={14} /> What to do now
      </p>
      {!items.length ? (
        <p className="text-muted-foreground text-sm">{idle}</p>
      ) : (
        <ul className="space-y-2">
          {items.map((it) => (
            <li key={it.key} className="flex flex-wrap items-center justify-between gap-2">
              <span className={`flex min-w-0 items-start gap-2 text-sm ${it.tone === 'warn' ? 'text-destructive' : it.tone === 'info' ? 'text-muted-foreground' : 'text-foreground'}`}>
                <span className={`mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full ${it.tone === 'warn' ? 'bg-destructive' : it.tone === 'info' ? 'bg-muted-foreground/50' : 'bg-primary'}`} aria-hidden />
                <span className="min-w-0">{it.text}</span>
              </span>
              {it.actions?.length ? (
                <span className="flex flex-wrap items-center gap-1.5">
                  {it.actions.map((a) => (
                    <button key={a.label} type="button" className={`${a.primary ? 'btn-primary' : 'btn-secondary'} h-8 px-3 text-xs`} onClick={a.onClick} disabled={a.disabled}>
                      <a.icon size={14} /> {a.label}
                    </button>
                  ))}
                </span>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
