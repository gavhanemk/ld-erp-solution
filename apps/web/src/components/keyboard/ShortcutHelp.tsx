'use client'

import { Fragment, useMemo, useRef, useState } from 'react'
import {
  BarChart3,
  ChevronsUpDown,
  FileText,
  Globe,
  Keyboard,
  List,
  Rows3,
  Search,
  X,
  type LucideIcon,
} from 'lucide-react'
import { keyLabel, useDialogFocus } from '@/lib/keys'
import { useEscape } from '@/lib/useEscape'

/**
 * Every shortcut, in one place: Alt+/ or ? anywhere.
 *
 * Each entry is a list of keys and what they do. A key is one key or a
 * combination ("mod+k"); two keys in the list are alternatives, or the two
 * halves of the description in order ("Next box, box before" is Tab, then
 * Shift+Tab). Each is drawn as keycaps, a combination joined by "+" and the
 * alternatives by "or", so it is plain which are pressed together.
 */
const GROUPS: Array<{ title: string; icon: LucideIcon; keys: Array<[string[], string]> }> = [
  {
    title: 'Anywhere',
    icon: Globe,
    keys: [
      [['mod+k'], 'Find a screen, a record or an action'],
      [['alt+n'], 'New — the New button of the list you are on'],
      [['/'], 'Go to the search box of the list'],
      [['mod+s'], 'Save — the open form’s save button (as a draft where it has one)'],
      [['Esc'], 'Close the list, then the window on top'],
      [['alt+/', '?'], 'This list of shortcuts'],
    ],
  },
  {
    title: 'In a list',
    icon: List,
    keys: [
      [['↓'], 'From the search box into the list'],
      [['↑', '↓'], 'Move up and down the lines'],
      [['Home', 'End'], 'First line, last line'],
      [['Enter'], 'Open the line'],
      [['shift+F10'], 'The line’s Actions menu'],
      [['alt+PgDn', 'alt+PgUp'], 'In a window opened from a line: the next line’s, the one before'],
      [['←', '→'], 'On a row of tabs: the tab beside'],
    ],
  },
  {
    title: 'In a form',
    icon: FileText,
    keys: [
      [['Tab', 'shift+Tab'], 'Next box, box before'],
      [['Enter'], 'Next box — from any box, a filled dropdown, a notes box or a tick'],
      [['shift+Enter'], 'In a notes or address box: a new line'],
      [['Space'], 'Tick or untick a checkbox'],
      [['↑', '↓'], 'In a number box: one more, one less'],
    ],
  },
  {
    title: 'In the item lines of a form',
    icon: Rows3,
    keys: [
      [['Enter'], 'Next box; after the last box, a new line'],
      [['alt+↓', 'alt+↑'], 'The same box on the next line, the line before'],
      [['alt+a'], 'Add a line'],
      [['alt+c'], 'Copy this line, under it'],
      [['alt+delete'], 'Remove this line'],
    ],
  },
  {
    title: 'In a dropdown',
    icon: ChevronsUpDown,
    keys: [
      [['↓', 'Space'], 'Open it (Enter opens an empty one)'],
      [['a–z'], 'Type to find'],
      [['↑', '↓'], 'Move through the choices'],
      [['Enter', 'Tab'], 'Choose, and go to the next box'],
      [['Esc'], 'Close it, keeping what was chosen'],
    ],
  },
  {
    title: 'On a chart (dashboards)',
    icon: BarChart3,
    keys: [
      [['Tab'], 'To the chart'],
      [['←', '→'], 'Choose a bar or slice: its name and figure show'],
      [['Enter'], 'Open it, as a click would'],
    ],
  },
]

/** "alt+PgDn" -> ["Alt", "PgDn"]; on a Mac, ⌥ and ⌘ for Alt and Ctrl. A lone "+"-free key stays as it is. */
const capsOf = (combo: string): string[] =>
  /^(mod|alt|shift)\+/i.test(combo)
    ? combo.split('+').map((k) => {
        const cap = keyLabel(k)
        // keyLabel leaves a word as written: "delete" reads better as "Delete".
        return cap.length > 1 ? cap[0].toUpperCase() + cap.slice(1) : cap
      })
    : [combo]

/** One key, drawn as a key: a raised cap with a deeper bottom edge. */
function Keycap({ children }: { children: string }) {
  return (
    <kbd className="border-border bg-background text-foreground inline-flex h-6 min-w-[1.6rem] items-center justify-center rounded-md border border-b-[3px] px-1.5 font-sans text-[11px] font-semibold leading-none shadow-sm">
      {children}
    </kbd>
  )
}

/** The keys of one entry: combinations joined by "+", alternatives by "or". */
function Keys({ keys }: { keys: string[] }) {
  return (
    <span className="flex shrink-0 flex-wrap items-center justify-end gap-1">
      {keys.map((combo, i) => (
        <Fragment key={combo}>
          {i > 0 && <span className="text-muted-foreground px-0.5 text-[11px]">or</span>}
          {capsOf(combo).map((cap, j) => (
            <Fragment key={j}>
              {j > 0 && <span className="text-muted-foreground text-[11px]">+</span>}
              <Keycap>{cap}</Keycap>
            </Fragment>
          ))}
        </Fragment>
      ))}
    </span>
  )
}

export function ShortcutHelp({ onClose }: { onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null)
  const [query, setQuery] = useState('')
  useDialogFocus(ref)
  useEscape(onClose)

  // A word finds a shortcut by what it does or by its key: "save", "line", "alt".
  const groups = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return GROUPS
    return GROUPS.map((g) => ({
      ...g,
      keys: g.keys.filter(
        ([keys, what]) =>
          what.toLowerCase().includes(q) ||
          g.title.toLowerCase().includes(q) ||
          keys.some((k) => capsOf(k).join(' ').toLowerCase().includes(q)),
      ),
    })).filter((g) => g.keys.length)
  }, [query])

  return (
    <div
      className="fixed inset-0 z-[1050] flex items-center justify-center bg-black/50 p-3 backdrop-blur-sm"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-labelledby="shortcut-help-title"
        className="bg-card border-border flex max-h-[88vh] w-full max-w-5xl flex-col overflow-hidden rounded-2xl border shadow-2xl"
      >
        <div className="border-border flex flex-wrap items-center gap-x-4 gap-y-3 border-b px-6 py-4">
          <span className="bg-primary/10 border-primary/20 text-primary flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border">
            <Keyboard size={19} aria-hidden />
          </span>
          <div className="min-w-0 flex-1">
            <h2 id="shortcut-help-title" className="text-foreground text-lg font-semibold leading-tight">
              Keyboard shortcuts
            </h2>
            <p className="text-muted-foreground mt-0.5 text-sm">Work through the ERP without reaching for the mouse.</p>
          </div>
          <label className="border-border bg-background focus-within:border-primary/50 order-last flex h-9 w-full items-center gap-2 rounded-lg border px-3 sm:order-none sm:w-64">
            <Search size={14} className="text-muted-foreground shrink-0" aria-hidden />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Find a shortcut…"
              aria-label="Find a shortcut"
              className="text-foreground placeholder:text-muted-foreground min-w-0 flex-1 bg-transparent text-sm outline-none"
            />
          </label>
          <button type="button" className="btn-ghost -mr-2 p-2" onClick={onClose} aria-label="Close">
            <X size={18} />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
          {groups.length === 0 ? (
            <p className="text-muted-foreground py-10 text-center text-sm">No shortcut matches “{query.trim()}”.</p>
          ) : (
            // Cards fill two columns top to bottom, so a short group never leaves a hole.
            <div className="gap-4 md:columns-2">
              {groups.map((g) => {
                const Icon = g.icon
                return (
                  <section key={g.title} className="border-border mb-4 break-inside-avoid overflow-hidden rounded-xl border">
                    <h3 className="bg-secondary/50 border-border text-foreground flex items-center gap-2 border-b px-4 py-2.5 text-[13px] font-semibold">
                      <Icon size={15} className="text-primary shrink-0" aria-hidden />
                      {g.title}
                    </h3>
                    <ul className="divide-border/60 divide-y">
                      {g.keys.map(([keys, what]) => (
                        <li key={what} className="flex items-center justify-between gap-4 px-4 py-2.5">
                          <span className="text-foreground/90 min-w-0 text-sm leading-snug">{what}</span>
                          <Keys keys={keys} />
                        </li>
                      ))}
                    </ul>
                  </section>
                )
              })}
            </div>
          )}
        </div>

        <div className="border-border text-muted-foreground flex flex-wrap items-center gap-x-4 gap-y-1 border-t px-6 py-3 text-xs">
          <span className="flex items-center gap-1.5">
            <Keys keys={['mod+k']} />
            <span className="ml-1">pressed together</span>
          </span>
          <span className="sm:ml-auto">A shortcut presses the same button a click would, with the same checks.</span>
        </div>
      </div>
    </div>
  )
}
