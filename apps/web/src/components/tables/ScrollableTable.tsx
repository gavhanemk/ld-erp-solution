import type { ReactNode } from 'react'

/**
 * A table that scrolls sideways instead of losing its columns.
 *
 * It used to offer the scrollbar twice — a second one mirrored above the
 * header — but that bar sat between the filters and the column names and
 * read as a stray line across the table, so there is now just the one, under
 * the last row. Shift + mouse wheel and trackpad swipes scroll it from
 * anywhere over the table.
 *
 * The table inside must not be told to shrink to fit (no `w-full`) — this
 * only has something to scroll if the table is left free to be as wide as
 * its columns actually need. `min-w-full` on the table itself still lets it
 * fill a container wider than that.
 */
export function ScrollableTable({
  children,
  className,
}: {
  children: ReactNode
  className?: string
}) {
  return <div className={`overflow-x-auto ${className ?? ''}`}>{children}</div>
}
