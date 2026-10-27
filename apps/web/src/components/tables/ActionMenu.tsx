'use client'

import { useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { createPortal } from 'react-dom'
import { MoreHorizontal } from 'lucide-react'
import { useEscape } from '@/lib/useEscape'

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
  /**
   * Present, but not available yet.
   *
   * For a step that is genuinely next in the workflow and genuinely blocked —
   * not for one the user has no right to, which should not be in the list at
   * all. `hint` says what is in the way, because a greyed line with no reason
   * beside it is worse than no line.
   */
  disabled?: boolean
  hint?: string
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
 *
 * From the keyboard: Enter, Space or ↓ on the button opens it on the first
 * line; ↑ ↓ Home End move; a letter jumps to the line starting with it;
 * Enter chooses; Escape or Tab shut it, and focus is back on the button.
 */
export function ActionMenu({
  label,
  items,
  compact = false,
}: {
  label: string
  items: RowAction[]
  /** Just the ⋯, square, for a header with buttons beside it; the word "Actions" otherwise. */
  compact?: boolean
}) {
  const [open, setOpen] = useState(false)
  const btnRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)

  // Shut, with focus back on the button, so the next Tab carries on from the row.
  const shut = (refocus = true) => {
    setOpen(false)
    if (refocus) btnRef.current?.focus()
  }

  // Open: the first line that can be chosen has focus.
  useEffect(() => {
    if (!open) return
    const t = setTimeout(() => menuRef.current?.querySelector<HTMLElement>('[role="menuitem"]:not([disabled])')?.focus(), 0)
    return () => clearTimeout(t)
  }, [open])

  const onMenuKey = (e: React.KeyboardEvent) => {
    const lines = [...(menuRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]:not([disabled])') ?? [])]
    const at = lines.indexOf(document.activeElement as HTMLElement)
    const to = (i: number) => {
      e.preventDefault()
      lines[(i + lines.length) % lines.length]?.focus()
    }
    if (e.key === 'ArrowDown') to(at + 1)
    else if (e.key === 'ArrowUp') to(at - 1)
    else if (e.key === 'Home') to(0)
    else if (e.key === 'End') to(lines.length - 1)
    else if (e.key === 'Tab') {
      e.preventDefault()
      shut()
    } else if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
      const ch = e.key.toLowerCase()
      const from = at + 1
      for (let n = 0; n < lines.length; n++) {
        const l = lines[(from + n) % lines.length]
        if ((l.textContent ?? '').trim().toLowerCase().startsWith(ch)) {
          e.preventDefault()
          l.focus()
          break
        }
      }
    }
  }
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
  useEscape(() => shut(), open)
  useEffect(() => {
    if (!open) return
    const shut = () => setOpen(false)
    window.addEventListener('resize', shut)
    window.addEventListener('scroll', shut, true)
    return () => {
      window.removeEventListener('resize', shut)
      window.removeEventListener('scroll', shut, true)
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
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown' && !open) {
            e.preventDefault()
            place()
            setOpen(true)
          }
        }}
        className={`border-border text-muted-foreground hover:bg-secondary hover:text-foreground inline-flex h-8 items-center gap-1.5 rounded-lg border text-xs font-medium transition-colors ${compact ? 'w-8 justify-center' : 'px-2.5'}`}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={label}
        title={compact ? label : undefined}
      >
        {!compact && 'Actions'}
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
              ref={menuRef}
              role="menu"
              aria-label={label}
              onKeyDown={onMenuKey}
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
                    className={`${ITEM} text-foreground focus:bg-secondary focus:outline-none`}
                    onClick={() => setOpen(false)}
                  >
                    {it.icon}
                    {/* A link's hint is a second line saying what is behind
                      it — "written automatically, not posted yet". */}
                    <span className="flex flex-col items-start">
                      {it.label}
                      {it.hint && (
                        <span className="text-muted-foreground text-[10px] leading-tight">
                          {it.hint}
                        </span>
                      )}
                    </span>
                  </Link>
                ) : (
                  <button
                    key={it.key}
                    type="button"
                    role="menuitem"
                    disabled={it.disabled}
                    title={it.hint}
                    className={`${ITEM} focus:bg-secondary focus:outline-none ${
                      it.disabled
                        ? 'text-muted-foreground cursor-not-allowed opacity-60'
                        : it.danger
                          ? 'text-red-400'
                          : 'text-foreground'
                    }`}
                    onClick={() => {
                      if (it.disabled) return
                      // Focus back on the button first: a window the action opens
                      // returns focus there when it closes.
                      shut()
                      it.onClick?.()
                    }}
                  >
                    {it.icon}
                    <span className="flex flex-col items-start">
                      {it.label}
                      {it.disabled && it.hint && (
                        <span className="text-[10px] leading-tight opacity-80">{it.hint}</span>
                      )}
                    </span>
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
