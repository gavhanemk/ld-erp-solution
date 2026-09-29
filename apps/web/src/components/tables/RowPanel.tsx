'use client'

import type { LucideIcon } from 'lucide-react'

/**
 * The panel that opens underneath a row.
 *
 * Every purchase list has one and each had built its own: the same card,
 * the same strip across the top, the same icon and the same count on the
 * right, written out four times with small differences — and one list, the
 * goods receipts, with no strip at all, so its detail arrived as a bare
 * table butted against the row above it.
 *
 * Capped and scrollable, because an order with thirty trims on it would
 * otherwise push the next row, and the pager, halfway down the screen. Give
 * the table inside it `subtable` and it will match the others.
 */
export function RowPanel({
  icon: Icon,
  title,
  /** The right-hand note: "4 lines on PO-0006", and the like. */
  note,
  children,
}: {
  icon: LucideIcon
  title: string
  note?: string
  children: React.ReactNode
}) {
  return (
    <div className="border-border bg-card overflow-hidden rounded-lg border">
      <div className="border-border flex items-center gap-1.5 border-b px-3 py-1.5">
        <Icon size={13} className="text-muted-foreground shrink-0" />
        <h4 className="text-foreground text-[11px] font-semibold">{title}</h4>
        {note && <span className="text-muted-foreground ml-auto text-[10px]">{note}</span>}
      </div>
      <div className="max-h-[22rem] overflow-y-auto">{children}</div>
    </div>
  )
}
