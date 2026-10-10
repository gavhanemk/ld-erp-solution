'use client'

import { useEffect, useRef, type InputHTMLAttributes, type KeyboardEvent } from 'react'

type Props = Omit<InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange' | 'type' | 'min' | 'max' | 'step'> & {
  value: string
  onValueChange: (value: string) => void
  /** How far one notch of the wheel, or one arrow press, moves it. */
  step?: number
  min?: number
  max?: number
  /** Accept a decimal point when typed (a rate); pieces are whole numbers. */
  decimals?: boolean
}

const round2 = (n: number) => Math.round(n * 100) / 100

/**
 * A number box that the mouse wheel and the up and down arrows move, one step
 * at a time, and never below `min` (nothing, unless told otherwise).
 *
 * A plain text box rather than `type="number"`, so it reads the same in every
 * browser and keeps what is typed as typed. The wheel only moves it while the
 * box has the cursor in it, as a browser's own number box does: a box that
 * changed whenever the pointer passed over it would change rates while the
 * form was being scrolled.
 */
export function StepInput({
  value,
  onValueChange,
  step = 1,
  min = 0,
  max,
  decimals = false,
  disabled,
  onKeyDown,
  ...rest
}: Props) {
  const ref = useRef<HTMLInputElement>(null)

  const clamp = (n: number) => Math.min(max ?? Infinity, Math.max(min, n))
  const bump = (direction: 1 | -1) => {
    if (disabled) return
    const next = clamp(round2((Number(value) || 0) + direction * step))
    onValueChange(next === 0 && min === 0 && !value ? '' : String(next))
  }

  // React's wheel handler cannot stop the page scrolling, so the listener is
  // the element's own. The latest bump is kept in a ref so it sees the
  // current value without re-binding on every keystroke.
  const bumpRef = useRef(bump)
  bumpRef.current = bump
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      if (document.activeElement !== el || e.deltaY === 0) return
      e.preventDefault()
      bumpRef.current(e.deltaY < 0 ? 1 : -1)
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [])

  const keys = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault()
      bump(e.key === 'ArrowUp' ? 1 : -1)
    }
    onKeyDown?.(e)
  }

  return (
    <input
      ref={ref}
      type="text"
      inputMode={decimals ? 'decimal' : 'numeric'}
      value={value}
      disabled={disabled}
      onKeyDown={keys}
      onChange={(e) => {
        let v = e.target.value.replace(decimals ? /[^\d.]/g : /[^\d]/g, '')
        // One decimal point at most.
        if (decimals) v = v.replace(/(\..*)\./g, '$1')
        if (max != null && Number(v) > max) v = String(max)
        onValueChange(v)
      }}
      {...rest}
    />
  )
}
