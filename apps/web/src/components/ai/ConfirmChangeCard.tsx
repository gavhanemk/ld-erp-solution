'use client'

import { Check, X, Pencil, ShieldAlert } from 'lucide-react'

/**
 * What the assistant is about to save, laid out so it can actually be checked.
 *
 * The assistant already describes the change in words. That is not enough on
 * its own: prose is read the way people read terms and conditions, and a wrong
 * figure buried in a sentence gets waved through. A column of labels and values
 * with a button under it is read the way people read a form — which is what
 * this is, filled in for them.
 *
 * The buttons send ordinary chat messages rather than hitting an endpoint of
 * their own. That is deliberate: the yes has to arrive as something the person
 * said, on a later turn than the proposal, or the server refuses it. One path
 * in, one set of rules, and pressing the button is the same act as typing it.
 */

export interface PendingChange {
  title: string
  fields: Array<{ label: string; value: string }>
  note?: string | null
}

export function ConfirmChangeCard({
  change,
  busy,
  onConfirm,
  onCancel,
  onEdit,
}: {
  change: PendingChange
  busy: boolean
  onConfirm: () => void
  onCancel: () => void
  onEdit: () => void
}) {
  return (
    <div className="flex gap-3 animate-fade-in">
      <div className="w-8 h-8 rounded-full flex items-center justify-center shrink-0 mt-0.5 bg-amber-500/15 border border-amber-500/25">
        <ShieldAlert size={16} className="text-amber-400" />
      </div>

      <div
        className="glass-card max-w-[75%] w-full rounded-2xl rounded-bl-sm border-amber-500/25 bg-amber-500/[0.06] overflow-hidden"
        role="group"
        aria-label="Change waiting for your confirmation"
      >
        <div className="flex items-center justify-between gap-3 px-4 py-3 border-b border-amber-500/20">
          <p className="text-sm font-semibold text-foreground">{change.title}</p>
          <span className="badge-warning shrink-0">Not saved yet</span>
        </div>

        <dl className="px-4 py-3 space-y-2">
          {change.fields.map((f) => (
            <div key={f.label} className="flex items-baseline justify-between gap-4">
              <dt className="text-xs text-muted-foreground shrink-0">{f.label}</dt>
              <dd className="text-sm text-foreground text-right break-words">{f.value}</dd>
            </div>
          ))}
        </dl>

        {change.note && (
          <p className="px-4 pb-3 text-xs text-muted-foreground">{change.note}</p>
        )}

        <div className="flex flex-wrap gap-2 px-4 py-3 border-t border-amber-500/20 bg-black/10">
          <button className="btn-primary" onClick={onConfirm} disabled={busy}>
            <Check size={15} /> Confirm
          </button>
          <button className="btn-secondary" onClick={onEdit} disabled={busy}>
            <Pencil size={15} /> Change something
          </button>
          <button
            className="btn-ghost text-muted-foreground hover:text-red-400 ml-auto"
            onClick={onCancel}
            disabled={busy}
          >
            <X size={15} /> Cancel
          </button>
        </div>
      </div>
    </div>
  )
}
