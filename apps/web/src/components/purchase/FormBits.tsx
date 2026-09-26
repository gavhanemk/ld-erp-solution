'use client'

import type { LucideIcon } from 'lucide-react'

/**
 * The two pieces every purchase form kept rebuilding.
 *
 * `.form-readout` has been in the stylesheet since the forms were first laid
 * out — "a read-only fact the form shows rather than asks for … boxed so it is
 * plainly not a field somebody failed to fill in" — and nothing used it. Each
 * form rolled its own instead, so the supplier's address reads as a boxed
 * panel on one screen, a bare line of 11px grey on another, and a bordered
 * grid on a third. One component, so the class and its markup travel together
 * and the next form gets the look for free.
 */

/**
 * A fact, not a field.
 *
 * The icon says at a glance which kind of fact it is — a pin on an address, a
 * lorry on where goods are going — and is muted, because it labels the box
 * rather than competing with what is in it.
 */
export function Readout({
  label,
  icon: Icon,
  children,
}: {
  /** Printed above, in the same style as a field's own label. */
  label?: string
  icon?: LucideIcon
  children: React.ReactNode
}) {
  return (
    <div className="min-w-0">
      {label && <span className="form-label">{label}</span>}
      <div className="form-readout">
        {Icon && <Icon size={15} />}
        <span className="min-w-0 flex-1 break-words">{children}</span>
      </div>
    </div>
  )
}

/**
 * A field that carries the same leading icon as the readout beside it.
 *
 * For the case where a fact becomes a choice: one supplier address is read,
 * three are picked from. Without this the two sit side by side looking like
 * different kinds of thing, when the only difference is how many there are.
 *
 * The icon is `pointer-events-none` so it never swallows the click that opens
 * the control underneath it.
 */
export function IconField({
  label,
  icon: Icon,
  children,
}: {
  label?: string
  icon: LucideIcon
  /** The control. Give it `pl-9` so its text clears the icon. */
  children: React.ReactNode
}) {
  return (
    <div className="min-w-0">
      {label && <span className="form-label">{label}</span>}
      <div className="relative">
        <Icon
          size={15}
          className="text-muted-foreground pointer-events-none absolute left-3 top-1/2 z-10 -translate-y-1/2"
        />
        {children}
      </div>
    </div>
  )
}
