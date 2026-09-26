'use client'

import { useLayoutEffect, useRef, useState, type ReactNode } from 'react'

/**
 * A table that scrolls sideways instead of losing its columns, with the
 * scrollbar offered twice — once right above the header, once below the
 * last row — so reaching it never means scrolling all the way down a long
 * list first to find it.
 *
 * The two scrollbars are two separate elements, each perfectly capable of
 * scrolling on its own, kept in step by hand: moving one sets `scrollLeft`
 * on the other. `syncing` is what stops that from ricocheting — without it,
 * the second element's own `scroll` event would fire, try to move the
 * first one back, and so on.
 *
 * The table inside must not be told to shrink to fit (no `w-full`) — this
 * only has something to scroll if the table is left free to be as wide as
 * its columns actually need. `min-w-full` on the table itself still lets it
 * fill a container wider than that.
 */
export function ScrollableTable({
  children,
  className,
}: {
  children: ReactNode
  className?: string
}) {
  const topRef = useRef<HTMLDivElement>(null)
  const bodyRef = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(0)
  const syncing = useRef<'top' | 'body' | null>(null)

  useLayoutEffect(() => {
    const table = bodyRef.current?.firstElementChild as HTMLElement | null | undefined
    if (!table) return
    const measure = () => setWidth(table.getBoundingClientRect().width)
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(table)
    return () => ro.disconnect()
  }, [children])

  return (
    <div className={className}>
      <div
        ref={topRef}
        className="overflow-x-auto overflow-y-hidden"
        style={{ height: 14 }}
        aria-hidden
        onScroll={() => {
          if (syncing.current === 'body') return
          syncing.current = 'top'
          if (bodyRef.current && topRef.current)
            bodyRef.current.scrollLeft = topRef.current.scrollLeft
          syncing.current = null
        }}
      >
        <div style={{ width, height: 1 }} />
      </div>
      <div
        ref={bodyRef}
        className="overflow-x-auto"
        onScroll={() => {
          if (syncing.current === 'top') return
          syncing.current = 'body'
          if (topRef.current && bodyRef.current)
            topRef.current.scrollLeft = bodyRef.current.scrollLeft
          syncing.current = null
        }}
      >
        {children}
      </div>
    </div>
  )
}
