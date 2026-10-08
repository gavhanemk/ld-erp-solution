'use client'

import {
  Children,
  forwardRef,
  isValidElement,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type KeyboardEvent,
  type ReactNode,
  type SelectHTMLAttributes,
} from 'react'
import * as Popover from '@radix-ui/react-popover'
import { Check, ChevronDown, Plus, Search } from 'lucide-react'

/**
 * A dropdown you can type into.
 *
 * Written as a drop-in for `<select>`: the same `value`, the same `onChange`
 * receiving `e.target.value`, the same `<option>` and `<optgroup>` children.
 * Every screen swapped `<select>` for this and kept its own logic untouched.
 *
 * What it adds over the browser's list:
 *   - a search box once there are more than a handful of choices, matching
 *     every word typed anywhere in an option ("crys wash" finds
 *     "SUP-JW-003 — Crystal Washing & Finishing");
 *   - arrow keys, Enter to pick, Escape to close (the dropdown only, never
 *     the form it sits in);
 *   - typing on a closed dropdown opens it with that letter already searched.
 *
 * The list opens in a layer above everything, so a dropdown inside a table
 * that scrolls sideways, or at the bottom of a dialog, is never cut off.
 */

interface Opt {
  value: string
  label: string
  /** A second, smaller line under the option, searched as well: an item code's name. */
  sub: string | null
  disabled: boolean
  hidden: boolean
  group: string | null
}

/** Text of an option's children, which arrive as strings, numbers or arrays of both. */
function textOf(node: ReactNode): string {
  if (node == null || typeof node === 'boolean') return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  if (isValidElement(node)) return textOf((node.props as { children?: ReactNode }).children)
  return ''
}

/** Every option in the children, flattened, with the group it sits under. */
function readOptions(children: ReactNode, group: string | null = null, out: Opt[] = []): Opt[] {
  Children.forEach(children, (child) => {
    if (!isValidElement(child)) return
    const props = child.props as {
      value?: string | number
      children?: ReactNode
      disabled?: boolean
      hidden?: boolean
      label?: string
      'data-sub'?: string
    }
    if (child.type === 'option') {
      const label = textOf(props.children)
      out.push({
        value: props.value === undefined ? label : String(props.value),
        label,
        sub: props['data-sub'] ? String(props['data-sub']) : null,
        disabled: Boolean(props.disabled),
        hidden: Boolean(props.hidden),
        group,
      })
    } else if (child.type === 'optgroup') {
      readOptions(props.children, props.label ?? null, out)
    } else if (props.children !== undefined) {
      // A fragment, or a wrapper around options.
      readOptions(props.children, group, out)
    }
  })
  return out
}

const fold = (s: string) =>
  s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')

/** Shows a search box above this many choices; fewer are quicker to just read. */
const SEARCH_FROM = 7

type SmartSelectProps = Omit<SelectHTMLAttributes<HTMLSelectElement>, 'onChange' | 'multiple' | 'size'> & {
  onChange?: (e: ChangeEvent<HTMLSelectElement>) => void
  /**
   * Offers "+ Add new …" at the top of the list, for adding the missing
   * choice without leaving the form. Given whatever was typed in the search,
   * so a name searched for and not found can be added as it is.
   */
  onCreate?: (typed: string) => void
  /** What a new one is called in that row: "supplier", "item". */
  createNoun?: string
}

export const SmartSelect = forwardRef<HTMLButtonElement, SmartSelectProps>(function SmartSelect(
  {
    value,
    defaultValue,
    onChange,
    children,
    className,
    disabled,
    id,
    name,
    title,
    style,
    autoFocus,
    'aria-label': ariaLabel,
    'aria-labelledby': ariaLabelledBy,
    'aria-describedby': ariaDescribedBy,
    'aria-invalid': ariaInvalid,
    onCreate,
    createNoun = 'one',
  },
  ref
) {
  const options = useMemo(() => readOptions(children), [children])
  const [inner, setInner] = useState(String(defaultValue ?? ''))
  const current = value !== undefined && value !== null ? String(value) : inner

  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const searchRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  const selected = options.find((o) => o.value === current)
  // The empty choice ("Select...", "All suppliers") reads as a hint, not a value.
  const placeholder = options.find((o) => o.value === '')
  const shown = selected ?? placeholder
  const showSearch = options.filter((o) => !o.hidden).length > SEARCH_FROM

  const visible = useMemo(() => {
    const words = fold(query).split(/\s+/).filter(Boolean)
    return options.filter((o) => {
      if (o.hidden) return false
      if (!words.length) return true
      const hay = fold(`${o.label} ${o.sub ?? ''} ${o.group ?? ''}`)
      return words.every((w) => hay.includes(w))
    })
  }, [options, query])

  // On opening, start at what is chosen now so Enter keeps it.
  useEffect(() => {
    if (!open) return
    const at = visible.findIndex((o) => o.value === current)
    setActive(at >= 0 ? at : Math.max(0, visible.findIndex((o) => !o.disabled)))
    // Only on open and when the list narrows, not on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, query])

  // Keep the highlighted row in view as the arrows move it.
  useEffect(() => {
    if (!open) return
    listRef.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [active, open])

  const choose = useCallback(
    (opt: Opt | undefined) => {
      if (!opt || opt.disabled) return
      setOpen(false)
      setQuery('')
      if (opt.value === current) return
      if (value === undefined) setInner(opt.value)
      if (onChange) {
        // Shaped like the change event a <select> sends, which is all the
        // screens read from it.
        const target = { value: opt.value, name: name ?? '', id: id ?? '' } as unknown as HTMLSelectElement
        onChange({
          target,
          currentTarget: target,
          type: 'change',
          preventDefault() {},
          stopPropagation() {},
          persist() {},
        } as unknown as ChangeEvent<HTMLSelectElement>)
      }
    },
    [current, value, onChange, name, id]
  )

  const move = (step: number) => {
    if (!visible.length) return
    let i = active
    for (let n = 0; n < visible.length; n++) {
      i = (i + step + visible.length) % visible.length
      if (!visible[i].disabled) break
    }
    setActive(i)
  }

  // Escape closes the list and stops there, so the dialog around it stays open.
  const stopEscape = (e: KeyboardEvent) => {
    e.preventDefault()
    e.stopPropagation()
    e.nativeEvent.stopImmediatePropagation()
    setOpen(false)
    setQuery('')
  }

  const onListKey = (e: KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      move(1)
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      move(-1)
    } else if (e.key === 'Home') {
      e.preventDefault()
      setActive(0)
    } else if (e.key === 'End') {
      e.preventDefault()
      setActive(visible.length - 1)
    } else if (e.key === 'Enter') {
      e.preventDefault()
      // Nothing matches what was typed: Enter adds it, if adding is offered.
      if (!visible.length && onCreate && query.trim()) create()
      else choose(visible[active])
    } else if (e.key === 'Escape') {
      stopEscape(e)
    } else if (e.key === 'Tab') {
      setOpen(false)
    }
  }

  // On the closed box: arrows and Enter open it, and a letter opens it
  // already searching for that letter.
  const onTriggerKey = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (open) return
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      setOpen(true)
    } else if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey && showSearch) {
      e.preventDefault()
      setQuery(e.key)
      setOpen(true)
    }
  }

  const create = () => {
    const typed = query.trim()
    setOpen(false)
    setQuery('')
    onCreate?.(typed)
  }

  let lastGroup: string | null = null

  return (
    <Popover.Root
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (!next) setQuery('')
      }}
    >
      <Popover.Trigger asChild disabled={disabled}>
        <button
          ref={ref}
          type="button"
          id={id}
          name={name}
          title={title ?? shown?.label}
          style={style}
          autoFocus={autoFocus}
          disabled={disabled}
          role="combobox"
          aria-expanded={open}
          aria-haspopup="listbox"
          aria-label={ariaLabel}
          aria-labelledby={ariaLabelledBy}
          aria-describedby={ariaDescribedBy}
          aria-invalid={ariaInvalid}
          onKeyDown={onTriggerKey}
          className={`smart-select-trigger inline-flex items-center justify-between gap-1.5 text-left ${className ?? ''}`}
        >
          <span className={`min-w-0 flex-1 truncate ${selected && selected.value !== '' ? '' : 'text-muted-foreground'}`}>
            {shown?.label || 'Select...'}
          </span>
          <ChevronDown size={14} className="text-muted-foreground shrink-0" aria-hidden />
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          align="start"
          sideOffset={4}
          collisionPadding={8}
          onOpenAutoFocus={(e) => {
            e.preventDefault()
            if (showSearch) searchRef.current?.focus()
            else listRef.current?.focus()
          }}
          onEscapeKeyDown={(e) => e.preventDefault()}
          className="border-border bg-card text-foreground z-[1000] flex max-h-[min(22rem,var(--radix-popover-content-available-height))] w-max max-w-[min(30rem,92vw)] min-w-[var(--radix-popover-trigger-width)] flex-col overflow-hidden rounded-xl border shadow-xl"
        >
          {showSearch && (
            <div className="border-border flex items-center gap-2 border-b px-2.5 py-2">
              <Search size={14} className="text-muted-foreground shrink-0" aria-hidden />
              <input
                ref={searchRef}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={onListKey}
                placeholder="Type to search…"
                aria-label="Search the list"
                aria-activedescendant={visible[active] ? `${id ?? name ?? 'smart'}-opt-${active}` : undefined}
                className="text-foreground placeholder:text-muted-foreground w-full bg-transparent text-sm outline-none"
              />
            </div>
          )}
          {/* First in the list, under the search, so it is found straight away
            when the search turns up nothing. */}
          {onCreate && (
            <button
              type="button"
              onMouseDown={(e) => e.preventDefault()}
              onClick={create}
              className="border-border text-primary hover:bg-primary/10 flex shrink-0 items-center gap-2 border-b px-3 py-2 text-left text-sm font-medium"
            >
              <Plus size={14} className="shrink-0" aria-hidden />
              <span className="min-w-0 truncate">
                {query.trim() ? `Add “${query.trim()}” as a new ${createNoun}` : `Add new ${createNoun}`}
              </span>
            </button>
          )}
          <div
            ref={listRef}
            role="listbox"
            tabIndex={-1}
            onKeyDown={showSearch ? undefined : onListKey}
            className="min-h-0 flex-1 overflow-y-auto py-1 outline-none"
          >
            {visible.length === 0 && (
              <p className="text-muted-foreground px-3 py-2.5 text-sm">No match for “{query}”</p>
            )}
            {visible.map((o, i) => {
              const header = o.group !== lastGroup && o.group ? o.group : null
              lastGroup = o.group
              const isActive = i === active
              const isChosen = o.value === current
              return (
                <div key={`${o.group ?? ''}|${o.value}|${i}`}>
                  {header && (
                    <p className="text-muted-foreground px-3 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-wider">
                      {header}
                    </p>
                  )}
                  <div
                    id={`${id ?? name ?? 'smart'}-opt-${i}`}
                    data-index={i}
                    role="option"
                    aria-selected={isChosen}
                    aria-disabled={o.disabled}
                    onMouseEnter={() => !o.disabled && setActive(i)}
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => choose(o)}
                    className={`flex cursor-pointer items-center gap-2 px-3 py-1.5 text-sm ${
                      o.group ? 'pl-5' : ''
                    } ${o.disabled ? 'cursor-not-allowed opacity-45' : ''} ${
                      isActive && !o.disabled ? 'bg-primary/15' : ''
                    } ${o.value === '' ? 'text-muted-foreground' : ''}`}
                  >
                    <span className="min-w-0 flex-1 whitespace-normal break-words">
                      {o.label || ' '}
                      {o.sub && <span className="text-muted-foreground block text-xs font-normal">{o.sub}</span>}
                    </span>
                    {isChosen && o.value !== '' && <Check size={14} className="text-primary shrink-0" aria-hidden />}
                  </div>
                </div>
              )
            })}
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  )
})
