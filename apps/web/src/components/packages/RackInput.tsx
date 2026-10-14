'use client'

import { useEffect, useId, useState } from 'react'
import { api } from '@/lib/api'

/** The racks in use — in one store, or in every store — for a rack box to offer. */
export function useRacks(warehouseId?: string | null) {
  const [racks, setRacks] = useState<string[]>([])
  useEffect(() => {
    let live = true
    api
      .get<{ data: Array<{ rack: string }> }>(`/packages/racks${warehouseId ? `?warehouseId=${warehouseId}` : ''}`)
      .then((r) => live && setRacks(r.data.map((x) => x.rack)))
      .catch(() => {})
    return () => {
      live = false
    }
  }, [warehouseId])
  return racks
}

/**
 * Where a rack is typed: B-3, SHELF 12. Offers the racks already in use, so
 * one rack is not typed three ways. Enter is "done typing".
 */
export function RackInput({
  value,
  onChange,
  racks,
  onEnter,
  placeholder = 'e.g. B-3',
  className = 'form-input',
  autoFocus,
  label = 'Rack',
}: {
  value: string
  onChange: (v: string) => void
  racks: string[]
  onEnter?: () => void
  placeholder?: string
  className?: string
  autoFocus?: boolean
  label?: string
}) {
  const listId = useId()
  return (
    <>
      <input
        className={className}
        value={value}
        onChange={(e) => onChange(e.target.value.toUpperCase())}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && onEnter) {
            e.preventDefault()
            onEnter()
          }
        }}
        list={listId}
        maxLength={20}
        placeholder={placeholder}
        autoFocus={autoFocus}
        autoComplete="off"
        autoCapitalize="characters"
        spellCheck={false}
        aria-label={label}
      />
      <datalist id={listId}>
        {racks.map((r) => (
          <option key={r} value={r} />
        ))}
      </datalist>
    </>
  )
}
