'use client'

import { useRef } from 'react'
import { Keyboard, X } from 'lucide-react'
import { keyLabel, useDialogFocus } from '@/lib/keys'
import { useEscape } from '@/lib/useEscape'

/** Every shortcut, in one place: Alt+/ or ? anywhere. */
const GROUPS: Array<{ title: string; keys: Array<[string[], string]> }> = [
  {
    title: 'Anywhere',
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
    keys: [
      [['↓'], 'From the search box into the list'],
      [['↑', '↓'], 'Move up and down the lines'],
      [['Home', 'End'], 'First line, last line'],
      [['Enter'], 'Open the line'],
      [['shift+F10'], 'The line’s Actions menu'],
      [['←', '→'], 'On a row of tabs: the tab beside'],
    ],
  },
  {
    title: 'In a form',
    keys: [
      [['Tab', 'shift+Tab'], 'Next box, box before'],
      [['Enter'], 'In a dropdown: choose, and go to the next box'],
      [['Space'], 'Tick or untick a checkbox'],
      [['↑', '↓'], 'In a number box: one more, one less'],
    ],
  },
  {
    title: 'In the item lines of a form',
    keys: [
      [['Enter'], 'Next box; after the last box, a new line'],
      [['alt+↓', 'alt+↑'], 'The same box on the next line, the line before'],
      [['alt+a'], 'Add a line'],
      [['alt+delete'], 'Remove this line'],
    ],
  },
  {
    title: 'In a dropdown',
    keys: [
      [['Enter', '↓'], 'Open it'],
      [['a–z'], 'Type to find'],
      [['↑', '↓'], 'Move through the choices'],
      [['Enter', 'Tab'], 'Choose, and go to the next box'],
      [['Esc'], 'Close it, keeping what was chosen'],
    ],
  },
]

const label = (k: string) => (/^(mod|alt|shift)\+/i.test(k) ? keyLabel(k) : k)

export function ShortcutHelp({ onClose }: { onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null)
  useDialogFocus(ref)
  useEscape(onClose)
  return (
    <div className="fixed inset-0 z-[1050] flex items-center justify-center bg-black/50 p-3 backdrop-blur-sm" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={ref} role="dialog" aria-modal="true" aria-labelledby="shortcut-help-title" className="bg-card border-border flex max-h-[85vh] w-full max-w-3xl flex-col overflow-hidden rounded-xl border shadow-2xl">
        <div className="border-border flex items-center gap-3 border-b px-5 py-3.5">
          <Keyboard size={18} className="text-primary" aria-hidden />
          <h2 id="shortcut-help-title" className="text-foreground mr-auto text-lg font-semibold">
            Keyboard shortcuts
          </h2>
          <button type="button" className="btn-ghost p-2" onClick={onClose} aria-label="Close">
            <X size={18} />
          </button>
        </div>
        <div className="grid gap-x-8 gap-y-5 overflow-y-auto px-5 py-4 sm:grid-cols-2">
          {GROUPS.map((g) => (
            <section key={g.title}>
              <h3 className="text-muted-foreground mb-1.5 text-[11px] font-semibold uppercase tracking-wider">{g.title}</h3>
              <ul className="space-y-1">
                {g.keys.map(([keys, what]) => (
                  <li key={what} className="flex items-baseline gap-3 text-sm">
                    <span className="flex w-36 shrink-0 flex-wrap gap-1">
                      {keys.map((k) => (
                        <kbd key={k} className="kbd">
                          {label(k)}
                        </kbd>
                      ))}
                    </span>
                    <span className="text-foreground/90">{what}</span>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
        <p className="border-border text-muted-foreground border-t px-5 py-2.5 text-xs">
          A shortcut presses the same button a click would, with the same checks. A greyed-out button stays greyed out.
        </p>
      </div>
    </div>
  )
}
