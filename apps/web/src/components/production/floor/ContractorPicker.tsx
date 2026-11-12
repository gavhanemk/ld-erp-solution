'use client'

import { useState } from 'react'
import { SmartSelect } from '@/components/ui/SmartSelect'
import { SuggestInput } from '@/components/ui/SuggestInput'

/** One name on the pick list, with why it is there ("on the routing", "3 cuttings before"). */
export interface KnownContractor {
  value: string
  label: string
}

const NEW = '__new__'

/**
 * The cutting contractor, picked from a dropdown — the names in `known`, in
 * the order given — so another one is one click away. A typing box with
 * suggestions only listed names matching what was already in it, so with a
 * name filled in nobody else could be seen. "+ New contractor…" switches to
 * typing, for somebody not on the list yet; "Pick from the list instead"
 * switches back, to `resetTo`.
 */
export function ContractorPicker({
  value,
  onChange,
  known,
  resetTo = '',
  ariaLabel = 'Cutting contractor',
}: {
  value: string
  onChange: (name: string) => void
  known: KnownContractor[]
  resetTo?: string
  ariaLabel?: string
}) {
  const [typing, setTyping] = useState(false)
  // A name nobody has used before is fine, but worth a second look for spelling.
  const typedNew = !!value.trim() && !known.some((k) => k.value.toLowerCase() === value.trim().replace(/\s+/g, ' ').toLowerCase())

  if (typing) {
    return (
      <>
        <SuggestInput className="form-input" value={value} maxLength={120} placeholder="Ramesh (cutting master)" onValueChange={onChange} suggestions={known} aria-label={ariaLabel} autoFocus />
        <span className="form-help">
          {typedNew && known.length > 0 ? 'A new contractor. Check the spelling: the same name written two ways counts as two people. ' : ''}
          <button
            type="button"
            className="text-primary hover:underline"
            onClick={() => {
              setTyping(false)
              onChange(resetTo)
            }}
          >
            Pick from the list instead
          </button>
        </span>
      </>
    )
  }
  return (
    <SmartSelect
      className="form-input"
      value={known.some((k) => k.value === value) ? value : ''}
      onChange={(e) => {
        if (e.target.value === NEW) {
          setTyping(true)
          onChange('')
        } else {
          onChange(e.target.value)
        }
      }}
      aria-label={ariaLabel}
    >
      <option value="">Choose the cutting contractor…</option>
      {known.map((k) => (
        <option key={k.value} value={k.value}>
          {k.label ? `${k.value} — ${k.label}` : k.value}
        </option>
      ))}
      <option value={NEW}>+ New contractor…</option>
    </SmartSelect>
  )
}
