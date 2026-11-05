'use client'

import { useEffect } from 'react'

/**
 * The wheel over a table goes to the page first.
 *
 * A table box is no taller than the screen and scrolls by itself, its header
 * held at the top and its sideways bar along the bottom (globals.css, "A long
 * table keeps its header and its sideways bar in sight"). Left to the
 * browser, the wheel over it would scroll its rows straight away, even while
 * the box still sat low on the page with its bottom edge, and that bar, under
 * the fold. So while the box's top is below the top of the screen (or of the
 * window it is in), the wheel scrolls the page or the window instead, until
 * the table is in full view, and only then its rows. Scrolling back up is as
 * it always was: the rows first, then the page.
 */
const BOX = '.list-rows, .overflow-x-auto, .overflow-auto'
/** Under the 64px top bar, with a little air. */
const PAGE_TOP = 72

function scrollsDown(el: Element) {
  const s = getComputedStyle(el)
  return (s.overflowY === 'auto' || s.overflowY === 'scroll') && el.scrollHeight > el.clientHeight + 1
}

/** The table box under the wheel, if it scrolls by itself. */
function tableBox(from: EventTarget | null): HTMLElement | null {
  for (let el = from instanceof Element ? from : null; el && el !== document.body; el = el.parentElement) {
    if (el.tagName === 'MAIN') return null
    if (el.matches(BOX) && (el.matches('.list-rows') || el.querySelector(':scope > table')) && scrollsDown(el)) {
      return el as HTMLElement
    }
  }
  return null
}

export function TableScrollLayer() {
  useEffect(() => {
    const onWheel = (e: WheelEvent) => {
      if (e.ctrlKey || e.deltaY <= 0 || Math.abs(e.deltaX) > Math.abs(e.deltaY)) return
      const box = tableBox(e.target)
      if (!box) return
      // What holds it: the window it is in, if that scrolls, else the page.
      let outer: HTMLElement | null = null
      for (let el = box.parentElement; el && el !== document.body; el = el.parentElement) {
        if (scrollsDown(el)) {
          outer = el
          break
        }
      }
      const holder = outer ?? (document.scrollingElement as HTMLElement | null)
      if (!holder) return
      const top = outer ? outer.getBoundingClientRect().top + 8 : PAGE_TOP
      const gap = box.getBoundingClientRect().top - top
      const room = holder.scrollHeight - holder.clientHeight - holder.scrollTop
      if (gap <= 1 || room <= 1) return
      const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? holder.clientHeight : 1
      e.preventDefault()
      holder.scrollBy({ top: Math.min(e.deltaY * unit, gap, room) })
    }
    document.addEventListener('wheel', onWheel, { passive: false })
    return () => document.removeEventListener('wheel', onWheel)
  }, [])
  return null
}
