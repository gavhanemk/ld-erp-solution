'use client'

import { useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { createPortal } from 'react-dom'
import { MoreHorizontal } from 'lucide-react'

/** One line of a row's actions menu. */
export interface RowAction {
  key: string
  label: string
  icon: React.ReactNode
  /** A link opens a screen; a press does something to the row. */
  href?: string
  newTab?: boolean
  onClick?: () => void
  danger?: boolean
}

/**
 * What can be done to one row, in words, behind a single "Actions" button.
 *
 * Built for the purchase orders list, where this row used to carry six bare
 * icons. Printer and bin are read at a glance; a box, a clock and a curved
 * arrow are not — nobody should have to hover six squares to find out which
 * one books in a delivery. Words cost one press and remove the guessing.
 * Shared rather than copied, so every list that grows past two or three
 * actions gets the same menu instead of its own slightly different one.
 *
 * The panel is positioned `fixed` off the button's own rectangle rather than
 * absolutely inside the row, because these lists sit inside a card that clips
 * its overflow and the last row's menu would be cut in half by it. It closes
 * on a press outside, on Escape, and on a scroll — a menu that floats away
 * from the row it belongs to is worse than one that shuts.
 */
export function ActionMenu({ label, items }: { label: string; items: RowAction[] }) {
  const [open, setOpen] = useState(false)
  const btnRef = useRef<HTMLButtonElement>(null)
  const [pos, setPos] = useState<{ top: number; right: number } | null>(null)

  /**
   * Where the panel goes, measured off the button's own rectangle.
   *
   * Taken at the moment of the press rather than in an effect afterwards. An
   * effect runs a render later, by which time the row can have moved — and a
   * menu that opens a hand's width away from the button nobody pressed is
   * worse than no menu.
   *
   * Flipped above the button when the row is near the foot of the window, so
   * the last row on a full page is not the one whose menu runs off screen.
   */
  const place = () => {
    const r = btnRef.current?.getBoundingClientRect()
    if (!r) return
    const needed = items.length * 38 + 16
    const below = window.innerHeight - r.bottom - 12
    setPos({
      top: below < needed && r.top > needed ? r.top - needed - 6 : r.bottom + 6,
      right: Math.max(8, window.innerWidth - r.right),
    })
  }

  // A menu anchored to a row must not float away from it. Anything that moves
  // the row under it — a scroll, a resize — shuts it, and so does Escape.
  useEffect(() => {
    if (!open) return
    const shut = () => setOpen(false)
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    window.addEventListener('resize', shut)
    window.addEventListener('scroll', shut, true)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('resize', shut)
      window.removeEventListener('scroll', shut, true)
      window.removeEventListener('keydown', onKey)
    }
  }, [open])

  const ITEM =
    'flex w-full items-center gap-2.5 px-3 py-2 text-left text-sm transition-colors hover:bg-secondary disabled:cursor-not-allowed disabled:opacity-50'

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        onClick={() => {
          if (open) {
            setOpen(false)
            return
          }
          place()
          setOpen(true)
        }}
        className="border-border text-muted-foreground hover:bg-secondary hover:text-foreground inline-flex h-8 items-center gap-1.5 rounded-lg border px-2.5 text-xs font-medium transition-colors"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={label}
      >
        Actions
        <MoreHorizontal size={14} />
      </button>

      {/* Rendered into the body, not into the row.
          `.glass-card` carries a `backdrop-filter`, and that makes the card a
          containing block for anything positioned `fixed` inside it — so the
          panel took its coordinates from the card's corner rather than the
          window's and opened a couple of hundred pixels below the button. A
          portal puts it back on the viewport, and clears the card's
          `overflow-hidden` at the same time. */}
      {open &&
        pos &&
        createPortal(
          <>
            <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} aria-hidden />
            <div
              role="menu"
              aria-label={label}
              className="border-border bg-card fixed z-50 min-w-[14rem] overflow-hidden rounded-xl border py-1 shadow-xl"
              style={{ top: pos.top, right: pos.right }}
            >
              {items.map((it) =>
                it.href ? (
                  <Link
                    key={it.key}
                    href={it.href}
                    target={it.newTab ? '_blank' : undefined}
                    role="menuitem"
                    className={`${ITEM} text-foreground`}
                    onClick={() => setOpen(false)}
                  >
                    {it.icon}
                    {it.label}
                  </Link>
                ) : (
                  <button
                    key={it.key}
                    type="button"
                    role="menuitem"
                    className={`${ITEM} ${it.danger ? 'text-red-400' : 'text-foreground'}`}
                    onClick={() => {
                      setOpen(false)
                      it.onClick?.()
                    }}
                  >
                    {it.icon}
                    {it.label}
                  </button>
                )
              )}
            </div>
          </>,
          document.body
        )}
    </>
  )
}
