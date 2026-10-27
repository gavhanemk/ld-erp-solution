'use client'

import { useEffect, useRef } from 'react'

/*
 * The keyboard, the same everywhere: shortcuts that mean one thing across the
 * ERP, moving to the next field, and keeping focus inside an open dialog.
 *
 * "mod" is Ctrl on Windows and ⌘ on a Mac. A shortcut with Ctrl, ⌘ or Alt
 * works while typing in a box; a bare key ("/", "?") only when nobody is
 * typing, so it never eats a letter somebody meant to type.
 */

export const isMac = () => typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent)

/** How a shortcut reads on this machine: "Ctrl+S", or "⌘S" on a Mac. */
export function keyLabel(combo: string): string {
  const mac = isMac()
  return combo
    .split('+')
    .map((k) => {
      const l = k.toLowerCase()
      if (l === 'mod') return mac ? '⌘' : 'Ctrl'
      if (l === 'alt') return mac ? '⌥' : 'Alt'
      if (l === 'shift') return mac ? '⇧' : 'Shift'
      if (l === 'enter') return 'Enter'
      if (l === 'esc') return 'Esc'
      if (l === 'up') return '↑'
      if (l === 'down') return '↓'
      return k.length === 1 ? k.toUpperCase() : k
    })
    .join(mac ? '' : '+')
}

/** Somebody is typing: a text box, a text area, a list's search box. */
export function isTyping(el: Element | null): boolean {
  if (!el || !(el instanceof HTMLElement)) return false
  if (el.isContentEditable) return true
  const tag = el.tagName
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true
  if (tag !== 'INPUT') return false
  const type = (el as HTMLInputElement).type
  return !['checkbox', 'radio', 'button', 'submit', 'reset', 'range', 'color', 'file'].includes(type)
}

/**
 * Whether a key press is this shortcut. "mod+s", "alt+n", "alt+/", "/",
 * "shift+?" — letters by what they type, so a keyboard layout that moves
 * the key still works.
 */
export function matches(e: KeyboardEvent | React.KeyboardEvent, combo: string): boolean {
  const parts = combo.toLowerCase().split('+')
  const key = parts[parts.length - 1]
  const want = { mod: parts.includes('mod'), alt: parts.includes('alt'), shift: parts.includes('shift') }
  const mod = isMac() ? e.metaKey : e.ctrlKey
  if (want.mod !== mod) return false
  if (want.alt !== e.altKey) return false
  // Shift is part of "?", so only checked when the shortcut names it on a letter key.
  if (want.shift && !e.shiftKey) return false
  if (!want.shift && e.shiftKey && key.length === 1 && /[a-z0-9]/.test(key)) return false
  const pressed = e.key.toLowerCase()
  if (pressed === key) return true
  // Alt on a Mac turns letters into symbols: fall back to the physical key.
  if (want.alt && key.length === 1 && /[a-z0-9]/.test(key)) return e.code === `Key${key.toUpperCase()}` || e.code === `Digit${key}`
  if (want.alt && key === '/') return e.code === 'Slash'
  return false
}

/**
 * Registers shortcuts on the window for as long as the component is on the
 * page. `when` decides per press; a bare key is skipped while typing.
 */
export function useHotkeys(map: Record<string, (e: KeyboardEvent) => void>, opts: { when?: () => boolean } = {}) {
  const ref = useRef(map)
  ref.current = map
  const when = useRef(opts.when)
  when.current = opts.when
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.isComposing) return
      for (const [combo, run] of Object.entries(ref.current)) {
        if (!matches(e, combo)) continue
        const bare = !/mod|alt/.test(combo)
        if (bare && isTyping(document.activeElement)) continue
        if (when.current && !when.current()) continue
        run(e)
        return
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
}

const TABBABLE = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',')

/** What Tab can reach inside a container, in order, leaving out what is hidden. */
export function tabbables(root: ParentNode): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(TABBABLE)].filter((el) => {
    if (el.closest('[inert], [aria-hidden="true"]')) return false
    if (el.tabIndex < 0) return false
    const style = window.getComputedStyle(el)
    if (style.visibility === 'hidden' || style.display === 'none') return false
    return el.getClientRects().length > 0
  })
}

/** The open dialog on top, or null: where a shortcut acts, and where focus belongs. */
export function topDialog(): HTMLElement | null {
  const open = [...document.querySelectorAll<HTMLElement>('[role="dialog"][aria-modal="true"], [role="alertdialog"][aria-modal="true"]')].filter(
    (d) => d.getClientRects().length > 0,
  )
  return open[open.length - 1] ?? null
}

/**
 * Moves focus to the next (or previous) field after `from`, inside the dialog
 * it is in, or the page: what happens after a dropdown choice is made from the
 * keyboard, so the next field is ready to type in.
 */
export function focusNext(from: HTMLElement, dir: 1 | -1 = 1) {
  const scope = (from.closest('[role="dialog"]') as HTMLElement | null) ?? document.body
  const list = tabbables(scope)
  const i = list.indexOf(from)
  const next = i < 0 ? null : list[i + dir]
  if (next) {
    next.focus()
    if (next instanceof HTMLInputElement && typeof next.select === 'function' && isTyping(next)) next.select()
  }
}

/*
 * Where focus has been, newest last: so a window can hand focus back to the
 * button that opened it, even when something inside took focus before the
 * window's own code ran.
 */
const trail: HTMLElement[] = []
let tracking = false
export function trackFocus() {
  if (tracking || typeof document === 'undefined') return
  tracking = true
  document.addEventListener(
    'focusin',
    (e) => {
      if (!(e.target instanceof HTMLElement)) return
      trail.push(e.target)
      if (trail.length > 20) trail.shift()
    },
    true,
  )
}

/** The last thing focused outside this window, still on the page: what opened it. */
export function focusBefore(root: HTMLElement): HTMLElement | null {
  const now = document.activeElement
  if (now instanceof HTMLElement && now !== document.body && !root.contains(now)) return now
  for (let i = trail.length - 1; i >= 0; i--) {
    const el = trail[i]
    if (el.isConnected && el !== document.body && !root.contains(el) && !el.closest('[data-radix-popper-content-wrapper]')) return el
  }
  return null
}

const FIELDS = 'input:not([type="hidden"]), textarea, select, [role="combobox"]'

/**
 * Puts focus in a window that has just opened, unless something inside has
 * it already: the first box to fill — waited for while it is greyed out and
 * its list loads — or, in a window with nothing to fill, the window itself,
 * so Tab starts inside it. Never a button: Enter on Cancel would close the
 * form. Returns a function that stops the waiting.
 */
export function placeFocus(root: HTMLElement): () => void {
  let tries = 0
  let t: ReturnType<typeof setTimeout>
  const place = () => {
    if (!root.isConnected || root.contains(document.activeElement)) return
    const boxes = [...root.querySelectorAll<HTMLElement>(FIELDS)].filter(
      (el) => el.getClientRects().length > 0 && !el.closest('[inert], [aria-hidden="true"]') && el.tabIndex >= 0,
    )
    const usable = boxes.filter((el) => !(el as HTMLInputElement).disabled)
    tries++
    // The first box, once it can be used; after a second and a half, the first that can.
    if (boxes[0] && usable[0] === boxes[0]) return boxes[0].focus()
    if (boxes.length && tries < 15) return void (t = setTimeout(place, 100))
    if (usable[0]) return usable[0].focus()
    if (boxes.length && tries < 40) return void (t = setTimeout(place, 100))
    if (!root.hasAttribute('tabindex')) root.setAttribute('tabindex', '-1')
    root.focus({ preventScroll: true })
  }
  t = setTimeout(place, 60)
  return () => clearTimeout(t)
}

/**
 * Tab and Shift+Tab go round inside the window on top, never out to the page
 * behind it. A list opened from inside the window (drawn elsewhere on the
 * page, like a dropdown's) is left to itself.
 */
export function keepTabInside(e: KeyboardEvent) {
  if (e.key !== 'Tab' || e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey) return
  const root = topDialog()
  if (!root) return
  const at = document.activeElement as HTMLElement | null
  if (at?.closest('[data-radix-popper-content-wrapper]')) return
  const fields = tabbables(root)
  if (!fields.length) return
  const first = fields[0]
  const last = fields[fields.length - 1]
  if (!at || !root.contains(at)) {
    e.preventDefault()
    ;(e.shiftKey ? last : first).focus()
  } else if (e.shiftKey && (at === first || at === root)) {
    e.preventDefault()
    last.focus()
  } else if (!e.shiftKey && at === last) {
    e.preventDefault()
    first.focus()
  }
}

/**
 * Focus for a dialog: into it when it opens, and back to whatever opened it
 * when it closes. (Tab is kept inside by the keyboard layer, for every
 * window on the page.)
 */
export function useDialogFocus(ref: React.RefObject<HTMLElement | null>, active = true) {
  useEffect(() => {
    if (!active) return
    trackFocus()
    const root = ref.current
    const before = root ? focusBefore(root) : (document.activeElement as HTMLElement | null)
    const stop = root ? placeFocus(root) : () => {}
    return () => {
      stop()
      // Back where the person was, once the window has really gone (not when
      // this only runs again with it still open), and only if focus went
      // with it rather than somewhere on purpose.
      setTimeout(() => {
        if (!before || !before.isConnected || before === document.body) return
        const gone = !root || !root.isConnected || root.getClientRects().length === 0
        if (!gone) return
        const at = document.activeElement
        if (!at || at === document.body || !at.isConnected || root?.contains(at)) before.focus()
      }, 0)
    }
  }, [ref, active])
}
