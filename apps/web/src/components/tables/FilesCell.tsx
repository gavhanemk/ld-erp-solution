'use client'

import { Paperclip } from 'lucide-react'

/**
 * The files column of a purchase list.
 *
 * Every list in the module used to carry this as a paperclip tucked under
 * something else — under the order number, under the receipt number, beside
 * the receipts a bill settles — which meant four lists showed the same fact
 * in four places and the payment lists did not show it at all. A column of
 * its own puts it where you look for it, and one component means the five
 * lists cannot drift apart on what it looks like or how it reads out.
 *
 * A row with nothing scanned onto it gets a dash rather than a blank, so an
 * empty cell reads as "nothing attached" rather than as a column that failed
 * to load.
 */
export function FilesCell({
  count,
  onOpen,
  /** Finishes the sentence "Open the 3 files …" — e.g. "on this receipt". */
  what,
}: {
  count: number
  onOpen: () => void
  what: string
}) {
  if (!count) {
    return <span className="text-muted-foreground text-xs">—</span>
  }

  return (
    <button
      type="button"
      className="text-primary hover:text-primary/80 inline-flex items-center gap-1 text-xs underline-offset-2 transition hover:underline"
      onClick={onOpen}
      title={`Open the ${count} file${count === 1 ? '' : 's'} ${what}`}
    >
      <Paperclip size={12} className="shrink-0" />
      {count}
    </button>
  )
}
