'use client'

/**
 * The footer that moves a list between pages.
 *
 * Extracted from the stock ledger, which was the only screen that had one. The
 * transaction lists all fetched a single page and printed the total beside it,
 * so a mill with 26 purchase orders saw 25 of them, the words "26 orders", and
 * no way to reach the last one. Nothing said a page had been left behind.
 *
 * It renders nothing at all when everything fits on one page — a pager under a
 * four-row table is furniture that only asks to be read.
 */
export function Pagination({
  page,
  pages,
  onPageChange,
  busy = false,
}: {
  page: number
  pages: number
  onPageChange: (page: number) => void
  /** Disables both buttons while a fetch is in flight. */
  busy?: boolean
}) {
  if (pages <= 1) return null

  return (
    <div className="flex items-center justify-between px-4 py-3 border-t border-border">
      <button
        className="btn-ghost text-xs"
        onClick={() => onPageChange(Math.max(1, page - 1))}
        disabled={page === 1 || busy}
      >
        Previous
      </button>
      <span className="text-xs text-muted-foreground">
        Page {page} of {pages}
      </span>
      <button
        className="btn-ghost text-xs"
        onClick={() => onPageChange(Math.min(pages, page + 1))}
        disabled={page === pages || busy}
      >
        Next
      </button>
    </div>
  )
}
