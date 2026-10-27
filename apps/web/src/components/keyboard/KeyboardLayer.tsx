'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { usePathname } from 'next/navigation'
import { focusBefore, isTyping, keepTabInside, keyLabel, matches, placeFocus, tabbables, topDialog, trackFocus, useHotkeys } from '@/lib/keys'
import { CommandPalette, earlyKeys, rememberVisit } from './CommandPalette'
import { ShortcutHelp } from './ShortcutHelp'
import { DocWindow } from './DocWindow'

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
 *   data-grid-row         one line of them; a second row belonging to the line
 *                         above (its sizes) is data-grid-row="sizes"
 *   data-grid-add         the "Add line" button (Alt+A); inside the grid, or
 *                         anywhere in the same dialog when it sits below the table.
 *                         data-grid-add="row" is a line's own add (another store
 *                         for this line): Alt+A on that line presses it instead
 *   data-grid-remove      the line's own remove button (Alt+Delete)
 *   data-grid-copy        the line's own copy button (Alt+C)
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

/**
 * Presses a button the way a person would: focus on it first, so a window it
 * opens hands focus back to it when that window closes.
 */
export function press(button: HTMLElement) {
  button.focus()
  button.click()
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

/** What Enter on a line presses: its marked button, or the line itself. */
const openTarget = (row: HTMLElement) => [...row.querySelectorAll<HTMLElement>('[data-row-open]')].find(shown) ?? row

/** A printed copy that opens in a new tab: from the keyboard, it opens in a window instead. */
const printedCopy = (el: HTMLElement): el is HTMLAnchorElement =>
  el instanceof HTMLAnchorElement && el.target === '_blank' && new URL(el.href, location.href).pathname.startsWith('/print/')

/** Opens a line in a list: its marked button, or the line itself. */
export function openRow(row: HTMLElement) {
  // Focus stays on the line, so ↑ ↓ carry on from it and a window it opens
  // hands focus back to it when it closes.
  const target = openTarget(row)
  if (printedCopy(target)) {
    window.dispatchEvent(new CustomEvent('ld:doc', { detail: { href: target.getAttribute('href'), title: (target.textContent ?? '').trim() || 'Document', row } }))
    return
  }
  target.click()
}

/** The other lines of the list a line is in, as the arrows see them. */
const linesBeside = (row: HTMLElement) => (row.parentElement ? [...row.parentElement.querySelectorAll<HTMLElement>(':scope > [data-row]')].filter(shown) : [])

/**
 * Enter in a box of a form, or of a window, goes on to the next box — it
 * never sends the form. A form is saved on purpose: its button, or Ctrl+S.
 *
 * Left alone: a box that does something with Enter itself (a scan box, a
 * reason box — they mark the key handled), a list's search box, a box with a
 * suggestion list open, a text area, and a form of one box (a barcode
 * scanner ends each code with Enter, and that Enter is the submit).
 */
function enterToNext(e: KeyboardEvent, el: HTMLElement) {
  if (e.key !== 'Enter' || e.shiftKey || e.altKey || e.ctrlKey || e.metaKey) return
  if (!(el instanceof HTMLInputElement) || !isTyping(el)) return
  if (el.matches('[data-hotkey="search"], [data-enter-own]') || el.getAttribute('aria-expanded') === 'true') return
  const form = el.form
  const dialog = el.closest<HTMLElement>('[role="dialog"]')
  if (!form && !dialog) return
  const scope = (form ?? dialog) as HTMLElement
  const boxes = tabbables(scope).filter((c) => c.matches('input, select, textarea, [role="combobox"]') && !c.matches('[type="checkbox"], [type="radio"]'))
  if (form && !dialog && boxes.filter((b) => b instanceof HTMLInputElement && isTyping(b)).length < 2) return
  e.preventDefault()
  const next = boxes[boxes.indexOf(el) + 1]
  if (next) {
    next.focus()
    if (next instanceof HTMLInputElement && isTyping(next)) next.select()
  } else if (form) {
    window.dispatchEvent(new CustomEvent('ld:note', { detail: `Last box. Press ${keyLabel('mod+s')}, or the save button, to save.` }))
  }
}

export function KeyboardLayer() {
  const pathname = usePathname()
  const [palette, setPalette] = useState(false)
  const [help, setHelp] = useState(false)
  const [note, setNote] = useState<string | null>(null)
  // A printed copy open in a window, and the list line it belongs to.
  const [doc, setDoc] = useState<{ href: string; title: string; row: HTMLElement } | null>(null)
  // Each open window, and what had focus before it opened (often a list line).
  const openersRef = useRef(new Map<HTMLElement, { before: HTMLElement | null; stop: () => void }>())
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
    const note = (e: Event) => flash(String((e as CustomEvent).detail ?? ''))
    const openDoc = (e: Event) => setDoc((e as CustomEvent).detail)
    window.addEventListener('ld:doc', openDoc)
    window.addEventListener('ld:palette', openPalette)
    window.addEventListener('ld:shortcuts', openHelp)
    window.addEventListener('ld:note', note)
    return () => {
      window.removeEventListener('ld:palette', openPalette)
      window.removeEventListener('ld:shortcuts', openHelp)
      window.removeEventListener('ld:note', note)
      window.removeEventListener('ld:doc', openDoc)
    }
  }, [flash])

  /*
   * Alt+PgDn / Alt+PgUp in a window opened from a list line: that window shuts
   * and the next (or previous) line's opens, as Esc, then the arrow and Enter
   * would. Only a window that is read, not one being filled in: typing is
   * never thrown away.
   */
  const step = useCallback(
    (dir: 1 | -1) => {
      const go = (row: HTMLElement) => {
        const list = linesBeside(row)
        const next = list[list.indexOf(row) + dir]
        if (!next) {
          flash(dir > 0 ? 'That was the last line of the list.' : 'That was the first line of the list.')
          return null
        }
        return next
      }
      if (doc) {
        const next = go(doc.row)
        if (!next) return
        next.focus()
        next.scrollIntoView({ block: 'nearest' })
        const target = openTarget(next)
        if (printedCopy(target)) setDoc({ href: target.getAttribute('href') ?? target.href, title: (target.textContent ?? '').trim() || 'Document', row: next })
        else {
          setDoc(null)
          setTimeout(() => openRow(next), 60)
        }
        return
      }
      const top = topDialog()
      if (!top) return
      const before = openersRef.current.get(top)?.before ?? null
      const row = before?.closest<HTMLElement>('[data-row]') ?? null
      if (!row || !row.isConnected) {
        flash('This window was not opened from a list, so there is no next one.')
        return
      }
      const filling =
        !!top.querySelector('[data-hotkey="save"]') ||
        [...top.querySelectorAll<HTMLInputElement>('input, textarea')].some((b) => shown(b) && isTyping(b) && !b.disabled && !b.readOnly)
      if (filling) {
        flash('This is a form: save it or close it (Esc) first.')
        return
      }
      const next = go(row)
      if (!next) return
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
      let n = 0
      const t = setInterval(() => {
        if (top.isConnected && top.getClientRects().length > 0 && ++n < 40) return
        clearInterval(t)
        if (top.isConnected && top.getClientRects().length > 0) return
        next.focus()
        next.scrollIntoView({ block: 'nearest' })
        openRow(next)
      }, 50)
    },
    [doc, flash],
  )

  /*
   * Every window, whoever drew it: focus goes into it when it opens, Tab stays
   * inside it, and focus goes back to what opened it when it closes. Done here
   * once, for all of them, so a window added later gets it without asking.
   */
  useEffect(() => {
    trackFocus()
    const open = openersRef.current
    let frame = 0
    const scan = () => {
      frame = 0
      const now = [...document.querySelectorAll<HTMLElement>('[role="dialog"][aria-modal="true"], [role="alertdialog"][aria-modal="true"]')].filter((d) => d.getClientRects().length > 0)
      for (const d of now) if (!open.has(d)) open.set(d, { before: focusBefore(d), stop: placeFocus(d) })
      for (const [d, { before, stop }] of open) {
        if (d.isConnected && now.includes(d)) continue
        open.delete(d)
        stop()
        setTimeout(() => {
          const at = document.activeElement
          if ((!at || at === document.body || !at.isConnected) && before?.isConnected) before.focus()
        }, 40)
      }
    }
    const watch = new MutationObserver(() => {
      if (!frame) frame = requestAnimationFrame(scan)
    })
    watch.observe(document.body, { childList: true, subtree: true })
    document.addEventListener('keydown', keepTabInside)
    scan()
    return () => {
      watch.disconnect()
      cancelAnimationFrame(frame)
      document.removeEventListener('keydown', keepTabInside)
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
          press(button)
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
        row.scrollIntoView({ block: 'nearest' })
        // Opened for the person — unless that means a new tab (a printed copy),
        // which the browser would block as a pop-up: then the line waits, with
        // focus, for their own Enter.
        const target = openTarget(row)
        // A printed copy opens in a window here; any other new tab waits for the person's own Enter.
        if (printedCopy(target) || !(target instanceof HTMLAnchorElement && target.target === '_blank')) openRow(row)
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
      if (!palette) earlyKeys.text = ''
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
      if (button) press(button)
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
    'alt+pagedown': (e) => {
      e.preventDefault()
      step(1)
    },
    'alt+pageup': (e) => {
      e.preventDefault()
      step(-1)
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

  // Letters typed before the palette's box is there are kept for it.
  useEffect(() => {
    const hold = (e: KeyboardEvent) => {
      if (earlyKeys.text === null || document.activeElement?.id === 'palette-input') return
      if (e.key.length !== 1 || e.ctrlKey || e.metaKey || e.altKey) return
      e.preventDefault()
      e.stopPropagation()
      earlyKeys.text += e.key
    }
    window.addEventListener('keydown', hold, true)
    return () => window.removeEventListener('keydown', hold, true)
  }, [])

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
        } else if (e.key === 'ContextMenu' || (e.key === 'F10' && e.shiftKey)) {
          // The line's own Actions menu, as a right-click would have offered.
          const menu = [...el.querySelectorAll<HTMLButtonElement>('[aria-haspopup="menu"]')].find((b) => shown(b) && !b.disabled)
          if (menu) {
            e.preventDefault()
            menu.focus()
            menu.click()
          }
        }
        return
      }

      // A row of tabs: ← → Home End go to the tab beside and show it.
      if (el.getAttribute('role') === 'tab' && !e.altKey && !e.ctrlKey && !e.metaKey && ['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) {
        const list = el.closest('[role="tablist"]')
        const tabs = list ? [...list.querySelectorAll<HTMLElement>('[role="tab"]')].filter((t) => shown(t) && !(t as HTMLButtonElement).disabled) : []
        const i = tabs.indexOf(el)
        const to = e.key === 'Home' ? 0 : e.key === 'End' ? tabs.length - 1 : i + (e.key === 'ArrowRight' ? 1 : -1)
        const tab = tabs[(to + tabs.length) % tabs.length]
        if (tab && tab !== el) {
          e.preventDefault()
          tab.focus()
          tab.click()
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
      if (!grid) {
        enterToNext(e, el)
        return
      }
      const row = el.closest<HTMLElement>('[data-grid-row]')
      const rows = [...grid.querySelectorAll<HTMLElement>('[data-grid-row]')].filter(shown)
      // A line's own row, not the sizes row under it.
      // (React writes a bare data-grid-row as "true".)
      const kindOf = (r: HTMLElement) => {
        const k = r.getAttribute('data-grid-row') ?? ''
        return k === 'true' ? '' : k
      }
      const cells = (r: HTMLElement) => tabbables(r).filter((c) => !c.matches('[data-grid-remove], [data-grid-add], [data-grid-copy]') && !c.closest('[data-grid-skip]'))
      // The Add button for new lines: in the grid, else the one in the same dialog.
      const usable = (b: HTMLButtonElement) => shown(b) && !b.disabled
      const addButton = () =>
        [...grid.querySelectorAll<HTMLButtonElement>('[data-grid-add]:not([data-grid-add="row"])')].find(usable) ??
        [...(grid.closest('[role="dialog"]') ?? document).querySelectorAll<HTMLButtonElement>('[data-grid-add]:not([data-grid-add="row"])')].find(usable)
      // Press an add, then put focus in the first box of the row it made.
      const addAndGo = (add: HTMLButtonElement) => {
        const before = new Set(rows)
        add.click()
        let n = 0
        const t = setInterval(() => {
          const now = [...grid.querySelectorAll<HTMLElement>('[data-grid-row]')].filter(shown)
          const fresh = now.find((r) => !before.has(r))
          if (fresh || ++n > 20) {
            clearInterval(t)
            if (fresh) cells(fresh)[0]?.focus()
          }
        }, 50)
      }

      // Alt+C: a copy of this line, under it, its first box ready to change.
      if (matches(e, 'alt+c') && row) {
        let line: HTMLElement | null = row
        while (line && kindOf(line) !== '') line = rows[rows.indexOf(line) - 1] ?? null
        const copy = line ? [...line.querySelectorAll<HTMLButtonElement>('[data-grid-copy]')].find(usable) : undefined
        if (!copy) return
        e.preventDefault()
        addAndGo(copy)
        return
      }

      // Alt+A: a new line (or this line's own add), its first box ready to type in.
      if (matches(e, 'alt+a')) {
        const own = row ? [...row.querySelectorAll<HTMLButtonElement>('[data-grid-add="row"]')].find(usable) : undefined
        const add = own ?? addButton()
        if (!add) return
        e.preventDefault()
        addAndGo(add)
        return
      }
      if (!row) return
      // Alt+Delete: this line's own remove button, with whatever check it has.
      if (matches(e, 'alt+delete')) {
        // From a sizes row, the line above it is the one removed.
        let line: HTMLElement | null = row
        while (line && kindOf(line) !== '') line = rows[rows.indexOf(line) - 1] ?? null
        const remove = line ? [...line.querySelectorAll<HTMLButtonElement>('[data-grid-remove]')].find((b) => shown(b) && !b.disabled) : undefined
        if (!line || !remove) return
        e.preventDefault()
        const at = rows.filter((r) => kindOf(r) === '').indexOf(line)
        remove.click()
        setTimeout(() => {
          const now = [...grid.querySelectorAll<HTMLElement>('[data-grid-row]')].filter(shown).filter((r) => kindOf(r) === '')
          const next = now[Math.min(at, now.length - 1)]
          if (next) cells(next)[0]?.focus()
        }, 80)
        return
      }
      // Alt+↑ / Alt+↓: the same box on the line above or below (↑ ↓ alone still step a number).
      if (e.altKey && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
        const peers = rows.filter((r) => kindOf(r) === kindOf(row))
        const at = peers.indexOf(row)
        const other = peers[at + (e.key === 'ArrowDown' ? 1 : -1)]
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
        const add = addButton()
        if (add) addAndGo(add)
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
      {doc && <DocWindow key={doc.href} href={doc.href} title={doc.title} onClose={() => setDoc(null)} onStep={step} />}
      {note && (
        <div role="status" aria-live="polite" className="bg-card border-border text-foreground fixed bottom-4 left-1/2 z-[1100] -translate-x-1/2 rounded-lg border px-4 py-2.5 text-sm shadow-xl">
          {note}
        </div>
      )}
    </>
  )
}
