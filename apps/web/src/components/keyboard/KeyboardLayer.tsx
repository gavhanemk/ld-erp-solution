'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { usePathname } from 'next/navigation'
import { isTyping, matches, tabbables, topDialog, useHotkeys } from '@/lib/keys'
import { CommandPalette, rememberVisit } from './CommandPalette'
import { ShortcutHelp } from './ShortcutHelp'

/*
 * The shortcuts that mean the same thing on every screen, and the keys that
 * move through lists and line items. Mounted once, round the whole app.
 *
 * Nothing here does work of its own: every shortcut presses a button that is
 * already on the screen — the form's own Save, the page's own New — so the
 * same checks, the same permissions and the same "are you sure" run as with
 * a click. A button that is greyed out stays greyed out.
 *
 * Screens say which button is which with a mark:
 *   data-hotkey="save"    the form's main button (Ctrl+S)
 *   data-hotkey="new"     the page's New button (Alt+N)
 *   data-hotkey="search"  the list's search box ("/")
 *   data-row              a line in a list: ↑ ↓ move, Enter opens
 *   data-row-open         inside a line: what Enter presses (else the line)
 *   data-grid             line items of a form: Enter goes to the next box
 *   data-grid-row         one line of them
 *   data-grid-add         the "Add line" button (Alt+A)
 *   data-grid-remove      the line's own remove button (Alt+Delete)
 */

/** On screen and not hidden behind a closed tab or a phone-only copy. */
const shown = (el: Element | null): el is HTMLElement => !!el && el instanceof HTMLElement && el.getClientRects().length > 0 && !el.closest('[inert], [aria-hidden="true"]')

/** Where a shortcut acts: the dialog on top, or the page. */
const scope = (): HTMLElement => topDialog() ?? document.querySelector('main') ?? document.body

/** The first usable button a mark points at: the mark itself, or a button inside it. */
function markedButton(root: ParentNode, mark: string): { button: HTMLButtonElement | null; found: boolean } {
  // Not the marks themselves: a wrapper drawn as `display: contents` has no box of its own.
  const marks = [...root.querySelectorAll<HTMLElement>(`[data-hotkey="${mark}"]`)]
  const buttons = marks.flatMap((m) => (m instanceof HTMLButtonElement ? [m] : [...m.querySelectorAll<HTMLButtonElement>('button')])).filter(shown)
  return { button: buttons.find((b) => !b.disabled) ?? null, found: buttons.length > 0 }
}

/** Sets a text box's value so the screen's own onChange sees it, as if typed. */
function typeInto(input: HTMLInputElement, text: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  setter?.call(input, text)
  input.dispatchEvent(new Event('input', { bubbles: true }))
}

/** What the palette asked for on the next screen, kept across the move there. */
export type AfterMove = { path: string; do: 'new' } | { path: string; do: 'find'; term: string }
const AFTER = 'ld:after-move'

export function queueAfterMove(a: AfterMove) {
  try {
    sessionStorage.setItem(AFTER, JSON.stringify({ ...a, at: Date.now() }))
  } catch {
    /* private window: the screen still opens, the step after it is skipped */
  }
  window.dispatchEvent(new Event('ld:after-move'))
}

/** Opens a line in a list: its marked button, or the line itself. */
export function openRow(row: HTMLElement) {
  const target = [...row.querySelectorAll<HTMLElement>('[data-row-open]')].find(shown)
  ;(target ?? row).click()
}

export function KeyboardLayer() {
  const pathname = usePathname()
  const [palette, setPalette] = useState(false)
  const [help, setHelp] = useState(false)
  const [note, setNote] = useState<string | null>(null)
  const lastSave = useRef(0)
  const noteTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  const flash = useCallback((text: string) => {
    setNote(text)
    clearTimeout(noteTimer.current)
    noteTimer.current = setTimeout(() => setNote(null), 2600)
  }, [])

  // The search box in the top bar, and the "Keyboard shortcuts" links, open these.
  useEffect(() => {
    const openPalette = () => setPalette(true)
    const openHelp = () => setHelp(true)
    window.addEventListener('ld:palette', openPalette)
    window.addEventListener('ld:shortcuts', openHelp)
    return () => {
      window.removeEventListener('ld:palette', openPalette)
      window.removeEventListener('ld:shortcuts', openHelp)
    }
  }, [])

  // Each screen opened goes on the palette's "Recent" list.
  useEffect(() => {
    rememberVisit(pathname)
  }, [pathname])

  // The palette asks again when the record is on the screen already open.
  const [again, setAgain] = useState(0)
  useEffect(() => {
    const bump = () => setAgain((n) => n + 1)
    window.addEventListener('ld:after-move', bump)
    return () => window.removeEventListener('ld:after-move', bump)
  }, [])

  // The step after a move the palette made: press New, or find a record.
  useEffect(() => {
    let raw: string | null = null
    try {
      raw = sessionStorage.getItem(AFTER)
    } catch {
      return
    }
    if (!raw) return
    const a = JSON.parse(raw) as AfterMove & { at: number }
    if (a.path !== pathname) return
    sessionStorage.removeItem(AFTER)
    if (Date.now() - a.at > 15000) return
    let tries = 0
    let typed = false
    const t = setInterval(() => {
      tries++
      if (a.do === 'new') {
        const { button, found } = markedButton(document, 'new')
        if (button) {
          clearInterval(t)
          button.click()
        } else if (tries > 40) {
          clearInterval(t)
          flash(found ? 'New is not open to you on this screen.' : 'This screen has no New button.')
        }
        return
      }
      // Find: type the number into the list's search, then open the line that has it.
      const box = [...document.querySelectorAll<HTMLInputElement>('input[data-hotkey="search"]')].find(shown)
      if (!typed) {
        if (box) {
          typeInto(box, a.term)
          typed = true
        } else if (tries > 40) clearInterval(t)
        return
      }
      const want = a.term.toLowerCase()
      const row = [...document.querySelectorAll<HTMLElement>('[data-row]')].filter(shown).find((r) => (r.textContent ?? '').toLowerCase().includes(want))
      if (row) {
        clearInterval(t)
        row.focus()
        openRow(row)
      } else if (tries > 60) {
        clearInterval(t)
        box?.focus()
      }
    }, 100)
    return () => clearInterval(t)
  }, [pathname, again, flash])

  const save = useCallback(() => {
    if (Date.now() - lastSave.current < 1200) return
    const root = scope()
    let { button, found } = markedButton(root, 'save')
    // A form that saves on submit: its own submit button, the one Enter would press.
    if (!found) {
      const submit = [...root.querySelectorAll<HTMLButtonElement>('form button[type="submit"]')].filter(shown).filter((b) => !b.className.includes('btn-danger'))
      found = submit.length > 0
      button = submit.find((b) => !b.disabled) ?? null
    }
    if (button) {
      lastSave.current = Date.now()
      button.click()
      return
    }
    if (found) {
      // The button is greyed out: say so, and go to the first box that is wrong.
      const bad = [...root.querySelectorAll<HTMLElement>('[aria-invalid="true"]')].find(shown)
      bad?.focus()
      flash('Not ready to save yet: fill in what is missing first.')
    } else flash('Nothing to save on this screen.')
  }, [flash])

  useHotkeys({
    'mod+k': (e) => {
      e.preventDefault()
      setHelp(false)
      setPalette((p) => !p)
    },
    'mod+s': (e) => {
      // The browser's "Save page as" is never wanted in the ERP.
      e.preventDefault()
      if (e.repeat || palette || help) return
      save()
    },
    'alt+n': (e) => {
      if (palette || help || topDialog()) return
      const { button, found } = markedButton(document.querySelector('main') ?? document, 'new')
      e.preventDefault()
      if (button) button.click()
      else flash(found ? 'New is not open to you on this screen.' : 'This screen has no New button.')
    },
    '/': (e) => {
      if (palette || help) return
      const box = [...scope().querySelectorAll<HTMLInputElement>('[data-hotkey="search"]')].find(shown)
      if (!box) return
      e.preventDefault()
      box.focus()
      box.select?.()
    },
    'alt+/': (e) => {
      e.preventDefault()
      setPalette(false)
      setHelp((h) => !h)
    },
    '?': () => {
      if (palette || topDialog()) return
      setHelp(true)
    },
  })

  // Lists and line items: keys that only mean something where focus is.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.isComposing) return
      const el = document.activeElement as HTMLElement | null
      if (!el) return

      // A line in a list has focus: ↑ ↓ Home End move, Enter opens.
      if (el.hasAttribute('data-row')) {
        const list = el.parentElement ? [...el.parentElement.querySelectorAll<HTMLElement>(':scope > [data-row]')].filter(shown) : []
        const i = list.indexOf(el)
        const go = (j: number) => {
          const r = list[Math.max(0, Math.min(list.length - 1, j))]
          if (r) {
            e.preventDefault()
            r.focus()
            r.scrollIntoView({ block: 'nearest' })
          }
        }
        if (e.key === 'ArrowDown') go(i + 1)
        else if (e.key === 'ArrowUp') {
          // Above the first line: back to the search box, where the list came from.
          const box = i === 0 ? [...scope().querySelectorAll<HTMLInputElement>('[data-hotkey="search"]')].find(shown) : null
          if (box) {
            e.preventDefault()
            box.focus()
          } else go(i - 1)
        } else if (e.key === 'Home') go(0)
        else if (e.key === 'End') go(list.length - 1)
        else if (e.key === 'Enter' && !e.altKey && !e.ctrlKey && !e.metaKey && e.target === el) {
          e.preventDefault()
          openRow(el)
        }
        return
      }

      // The search box over a list: ↓ goes into the list.
      if (e.key === 'ArrowDown' && !e.altKey && el.matches('input[data-hotkey="search"]')) {
        const root = el.closest('[role="dialog"]') ?? document.querySelector('main') ?? document
        const first = [...root.querySelectorAll<HTMLElement>('[data-row]')].find(shown)
        if (first) {
          e.preventDefault()
          first.focus()
        }
        return
      }

      // Line items of a form.
      const grid = el.closest<HTMLElement>('[data-grid]')
      if (!grid) return
      const row = el.closest<HTMLElement>('[data-grid-row]')
      const rows = [...grid.querySelectorAll<HTMLElement>('[data-grid-row]')].filter(shown)
      const cells = (r: HTMLElement) => tabbables(r).filter((c) => !c.hasAttribute('data-grid-remove') && !c.closest('[data-grid-skip]'))

      // Alt+A: a new line, and its first box ready to type in.
      if (matches(e, 'alt+a')) {
        const add = [...grid.querySelectorAll<HTMLButtonElement>('[data-grid-add]')].find((b) => shown(b) && !b.disabled)
        if (!add) return
        e.preventDefault()
        const before = rows.length
        add.click()
        let n = 0
        const t = setInterval(() => {
          const now = [...grid.querySelectorAll<HTMLElement>('[data-grid-row]')].filter(shown)
          if (now.length > before || ++n > 20) {
            clearInterval(t)
            const fresh = now[now.length - 1]
            if (fresh) cells(fresh)[0]?.focus()
          }
        }, 50)
        return
      }
      if (!row) return
      // Alt+Delete: this line's own remove button, with whatever check it has.
      if (matches(e, 'alt+delete')) {
        const remove = [...row.querySelectorAll<HTMLButtonElement>('[data-grid-remove]')].find((b) => shown(b) && !b.disabled)
        if (!remove) return
        e.preventDefault()
        const at = rows.indexOf(row)
        remove.click()
        setTimeout(() => {
          const now = [...grid.querySelectorAll<HTMLElement>('[data-grid-row]')].filter(shown)
          const next = now[Math.min(at, now.length - 1)]
          if (next) cells(next)[0]?.focus()
        }, 80)
        return
      }
      // Alt+↑ / Alt+↓: the same box on the line above or below (↑ ↓ alone still step a number).
      if (e.altKey && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
        const at = rows.indexOf(row)
        const other = rows[at + (e.key === 'ArrowDown' ? 1 : -1)]
        if (!other) return
        e.preventDefault()
        const col = cells(row).indexOf(el)
        const target = cells(other)[Math.max(0, col)]
        target?.focus()
        if (target instanceof HTMLInputElement && isTyping(target)) target.select()
        return
      }
      // Enter in a box: the next box, then the next line; after the last box of
      // the last line, a new line if the form has an Add button. Never saves.
      if (e.key === 'Enter' && !e.shiftKey && !e.altKey && !e.ctrlKey && !e.metaKey && el instanceof HTMLInputElement && isTyping(el)) {
        // A list open under the box (a suggestion picker) takes Enter itself.
        if (el.getAttribute('aria-expanded') === 'true') return
        e.preventDefault()
        const all = rows.flatMap(cells)
        const i = all.indexOf(el)
        const next = all[i + 1]
        if (next) {
          next.focus()
          if (next instanceof HTMLInputElement && isTyping(next)) next.select()
          return
        }
        const add = [...grid.querySelectorAll<HTMLButtonElement>('[data-grid-add]')].find((b) => shown(b) && !b.disabled)
        if (add) {
          const before = rows.length
          add.click()
          let n = 0
          const t = setInterval(() => {
            const now = [...grid.querySelectorAll<HTMLElement>('[data-grid-row]')].filter(shown)
            if (now.length > before || ++n > 20) {
              clearInterval(t)
              const fresh = now[now.length - 1]
              if (fresh && now.length > before) cells(fresh)[0]?.focus()
            }
          }, 50)
        }
      }
    }
    // After the screen's own handlers, so a box that uses a key itself (a
    // suggestion list taking Enter) keeps it; still before a <form> around
    // the lines would submit, which only happens once the key has gone by.
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [])

  return (
    <>
      {palette && <CommandPalette onClose={() => setPalette(false)} onHelp={() => (setPalette(false), setHelp(true))} />}
      {help && <ShortcutHelp onClose={() => setHelp(false)} />}
      {note && (
        <div role="status" aria-live="polite" className="bg-card border-border text-foreground fixed bottom-4 left-1/2 z-[1100] -translate-x-1/2 rounded-lg border px-4 py-2.5 text-sm shadow-xl">
          {note}
        </div>
      )}
    </>
  )
}
