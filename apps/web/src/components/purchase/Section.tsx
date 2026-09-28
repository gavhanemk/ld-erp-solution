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

  /*
   * The heading is a heading now.
   *
   * It used to be an 11px uppercase tracked caption, which at that size and
   * weight sat below the field labels beneath it in the reading order — so a
   * form of six panels read as one undifferentiated sheet and the eye had
   * nothing to jump between. A name in the body size, over a tinted tile
   * carrying the section's icon, is what makes a panel findable.
   */
  const heading = (
    <>
      <span className="bg-primary/10 border-primary/20 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border">
        <Icon size={15} className="text-primary" />
      </span>
      <span className="text-foreground text-[15px] font-semibold">{title}</span>
    </>
  )

  return (
    <section className="border-border bg-card rounded-xl border">
      <div
        className={`flex flex-wrap items-center gap-x-3 gap-y-1.5 px-4 py-3 ${
          shut ? '' : 'border-border/70 border-b'
        }`}
      >
        {foldable ? (
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            className="hover:text-primary flex min-w-0 items-center gap-2.5 transition-colors"
            aria-expanded={open}
          >
            {heading}
            {/* The chevron sits with the title rather than at the far right:
              it is part of the control you press, and a caret an arm's length
              away from the words reads as a separate button. */}
            {open ? (
              <ChevronUp size={15} className="text-muted-foreground shrink-0" />
            ) : (
              <ChevronDown size={15} className="text-muted-foreground shrink-0" />
            )}
          </button>
        ) : (
          <h3 className="flex min-w-0 items-center gap-2.5">{heading}</h3>
        )}
        {shut && summary && (
          <span className="text-muted-foreground min-w-0 truncate text-xs">{summary}</span>
        )}
        {actions && !shut && (
          // `flex-wrap`, not a rigid single line — a section whose actions
          // are a button and a labelled dropdown (Items, with "Select from
          // indent" beside "Order type") is wider than the actions ever
          // fit on a phone otherwise, and without somewhere to wrap to
          // they ran the dropdown's own text off the right edge of the
          // card instead of onto a second line under the button.
          <div className="ml-auto flex flex-wrap items-center gap-2 [&>*]:ml-0">{actions}</div>
        )}
      </div>
      {!shut && <div className="p-4">{children}</div>}
    </section>
  )
}
