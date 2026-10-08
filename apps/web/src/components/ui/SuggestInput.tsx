'use client'

import { useMemo, useRef, useState, type InputHTMLAttributes, type KeyboardEvent } from 'react'
import * as Popover from '@radix-ui/react-popover'

/**
 * A text box that suggests as you type, styled like SmartSelect's list.
 *
 * For a field where anything may be typed but a known value is usually
 * meant — an item's HSN code, a requisition's style number. A <datalist>
 * did this before, but the browser draws that list in its own black box,
 * nothing like the rest of the app. Here the box stays a plain text field;
 * the list under it only offers, never forces.
 */

export interface Suggestion {
  value: string
  /** Shown under the value and searched as well: a code's description. */
  label?: string
}

type Props = Omit<InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange' | 'list'> & {
  value: string
  onValueChange: (value: string) => void
  suggestions: Suggestion[]
}

const fold = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')

export function SuggestInput({ value, onValueChange, suggestions, className, onKeyDown, onFocus, onBlur, ...rest }: Props) {
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(-1)
  const inputRef = useRef<HTMLInputElement>(null)

  const matches = useMemo(() => {
    const words = fold(value).split(/\s+/).filter(Boolean)
    const list = words.length
      ? suggestions.filter((s) => {
          const hay = fold(`${s.value} ${s.label ?? ''}`)
          return words.every((w) => hay.includes(w))
        })
      : suggestions
    // Nothing to suggest once the box already holds exactly one of them.
    if (list.length === 1 && list[0].value === value) return []
    return list.slice(0, 60)
  }, [value, suggestions])

  const show = open && matches.length > 0

  const pick = (s: Suggestion) => {
    onValueChange(s.value)
    setOpen(false)
    setActive(-1)
    inputRef.current?.focus()
  }

  const keys = (e: KeyboardEvent<HTMLInputElement>) => {
    if (show && e.key === 'ArrowDown') {
      e.preventDefault()
      setActive((a) => (a + 1) % matches.length)
    } else if (show && e.key === 'ArrowUp') {
      e.preventDefault()
      setActive((a) => (a <= 0 ? matches.length - 1 : a - 1))
    } else if (show && e.key === 'Enter' && active >= 0) {
      e.preventDefault()
      pick(matches[active])
    } else if (show && e.key === 'Escape') {
      // Closes the list only; the form around it stays open.
      e.preventDefault()
      e.stopPropagation()
      e.nativeEvent.stopImmediatePropagation()
      setOpen(false)
    } else if (!show && e.key === 'ArrowDown') {
      setOpen(true)
    }
    onKeyDown?.(e)
  }

  return (
    <Popover.Root open={show} onOpenChange={(next) => !next && setOpen(false)}>
      <Popover.Anchor asChild>
        <input
          {...rest}
          ref={inputRef}
          value={value}
          autoComplete="off"
          className={className}
          onChange={(e) => {
            onValueChange(e.target.value)
            setOpen(true)
            setActive(-1)
          }}
          onFocus={(e) => {
            setOpen(true)
            onFocus?.(e)
          }}
          onBlur={(e) => {
            setOpen(false)
            onBlur?.(e)
          }}
          onKeyDown={keys}
          role="combobox"
          aria-expanded={show}
          aria-autocomplete="list"
        />
      </Popover.Anchor>
      <Popover.Portal>
        <Popover.Content
          align="start"
          sideOffset={4}
          collisionPadding={8}
          // Typing stays in the box; the list never takes focus.
          onOpenAutoFocus={(e) => e.preventDefault()}
          onCloseAutoFocus={(e) => e.preventDefault()}
          onEscapeKeyDown={(e) => e.preventDefault()}
          onInteractOutside={(e) => {
            if (e.target === inputRef.current) e.preventDefault()
          }}
          className="border-border bg-card text-foreground z-[1000] max-h-[min(18rem,var(--radix-popover-content-available-height))] w-max max-w-[min(30rem,92vw)] min-w-[var(--radix-popover-trigger-width)] overflow-y-auto rounded-xl border py-1 shadow-xl"
        >
          <div role="listbox">
            {matches.map((s, i) => (
              <div
                key={s.value}
                role="option"
                aria-selected={i === active}
                onMouseEnter={() => setActive(i)}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => pick(s)}
                className={`cursor-pointer px-3 py-1.5 text-sm ${i === active ? 'bg-primary/15' : ''}`}
              >
                <span className="font-mono">{s.value}</span>
                {s.label && <span className="text-muted-foreground block text-xs">{s.label}</span>}
              </div>
            ))}
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  )
}
