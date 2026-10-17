'use client'

import { useEffect, useRef } from 'react'

/**
 * Escape goes to the top window only.
 *
 * Every window used to listen for Escape on the whole page, so with a form open
 * over a stage sheet over a job card, one press closed all three and lost what
 * had been typed. Each window, and each open menu, now takes a place on one
 * stack while it is open, and Escape reaches only the newest. A list or box
 * that uses Escape itself (an open dropdown) marks the key handled with
 * preventDefault, and then nothing behind it closes.
 */
const stack: number[] = []
let last = 0

export function useEscape(onEscape: () => void, active = true) {
  const handler = useRef(onEscape)
  useEffect(() => {
    handler.current = onEscape
  })
  useEffect(() => {
    if (!active) return
    const id = ++last
    stack.push(id)
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented || stack[stack.length - 1] !== id) return
      handler.current()
    }
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('keydown', onKey)
      const at = stack.indexOf(id)
      if (at >= 0) stack.splice(at, 1)
    }
  }, [active])
}
