'use client'

import { useState } from 'react'
import { ChevronDown, ChevronUp } from 'lucide-react'

/**
 * One titled panel of a purchase form.
 *
 * White (or the card colour in the dark theme) on the page's grey, rather
 * than grey on grey. The sections used to be tinted a shade off the page and
 * held white fields, which put three greys on top of each other and gave the
 * form no order at all — every box the same weight as the one above it. A
 * panel that sits above the ground reads as a panel; the eye finds five of
 * them instead of scanning one long sheet.
 *
 * `actions` is the right-hand side of the title bar, for the one control that
 * governs the whole section — the order type over the item table. It belongs
 * up here: a control that decides which cells below are live is read before
 * them, and in its own row it was a third size of text in a row of its own.
 *
 * It lives in its own file rather than in the order form that first drew it,
 * so a screen that wants one panel does not have to import three and a half
 * thousand lines of order form to get it. The order, bill and receipt forms
 * all wear it; `PurchaseOrderDialog` re-exports it for the imports that
 * already pointed there.
 */
export function Section({
  icon: Icon,
  title,
  actions,
  children,
  foldable = false,
  openByDefault = true,
  summary,
}: {
  icon: React.ElementType
  title: string
  actions?: React.ReactNode
  children: React.ReactNode
  /**
   * Whether this section can be folded away.
   *
   * Four of the seven panels on the order form — the terms, the notes, the
   * attachments, the template — are not touched on most orders: the terms are
   * the mill's standing ones and the notes are usually empty. Left open they
   * push the totals and the save buttons off the bottom of the screen on every
   * order, so raising a two-line purchase order means scrolling past four
   * panels nobody is going to fill in.
   *
   * Folded, not removed. A section that is not there reads as forgotten, and
   * the buyer who does need to change the terms this once has to be able to
   * find them.
   */
  foldable?: boolean
  openByDefault?: boolean
  /** Shown on the closed header, so a folded panel still says what it holds. */
  summary?: React.ReactNode
}) {
  const [open, setOpen] = useState(openByDefault)
  const shut = foldable && !open

  return (
    <section className="border-border bg-card rounded-xl border">
      <div
        className={`flex flex-wrap items-center gap-x-3 gap-y-1.5 px-3.5 py-2 ${
          shut ? '' : 'border-border/70 border-b'
        }`}
      >
        {foldable ? (
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            className="text-foreground hover:text-primary flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.08em] transition-colors"
            aria-expanded={open}
          >
            <Icon size={14} className="text-primary shrink-0" />
            {title}
            {open ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
          </button>
        ) : (
          <h3 className="text-foreground flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.08em]">
            <Icon size={14} className="text-primary shrink-0" />
            {title}
          </h3>
        )}
        {shut && summary && (
          <span className="text-muted-foreground min-w-0 truncate text-xs">{summary}</span>
        )}
        {actions && !shut && (
          <div className="ml-auto flex shrink-0 items-center gap-2 [&>*]:ml-0">{actions}</div>
        )}
      </div>
      {!shut && <div className="p-3.5">{children}</div>}
    </section>
  )
}
