'use client'

import Link from 'next/link'
import { ArrowRight } from 'lucide-react'

/**
 * What to do after a routing is made, for a style with no orders yet: the
 * routing waits until an order for the style reaches production, and these
 * are the screens that take it there, in order.
 */
const STEPS: Array<{ title: string; what: string; href: string; go: string }> = [
  {
    title: 'Take a sales order for this style',
    what: 'The customer, the colours and the pieces in each size. Confirm it.',
    href: '/sales/orders',
    go: 'Sales Orders',
  },
  {
    title: 'Make a manufacturing order from it',
    what: 'Pick the sales order; the style and quantities come across. Release it.',
    href: '/production/orders',
    go: 'Manufacturing Orders',
  },
  {
    title: 'Issue its materials',
    what: 'Raise the requisition from the order and let the store issue the fabric and trims.',
    href: '/inventory/requisitions',
    go: 'Material Requisitions',
  },
  {
    title: 'Set up its stages — this routing comes in here',
    what: 'On the manufacturing order press "Set up stages": it takes this routing’s steps, lines and contractors. Then record the work stage by stage.',
    href: '/production/stages',
    go: 'Production Stages',
  },
]

export function NextSteps({ styleCode }: { styleCode: string }) {
  return (
    <div className="space-y-3">
      <p className="text-foreground text-sm">
        The routing for <b>{styleCode}</b> is ready. It is used when an order for this style goes into production — here is how:
      </p>
      <ol className="space-y-2">
        {STEPS.map((s, i) => (
          <li key={s.title} className="border-border flex items-start gap-3 rounded-lg border px-3 py-2.5">
            <span className="bg-primary/10 text-primary flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-bold">{i + 1}</span>
            <div className="min-w-0 flex-1">
              <p className="text-foreground text-sm font-semibold">{s.title}</p>
              <p className="text-muted-foreground text-xs">{s.what}</p>
            </div>
            <Link href={s.href} className="btn-secondary h-8 shrink-0 px-3 text-xs">
              {s.go} <ArrowRight size={13} />
            </Link>
          </li>
        ))}
      </ol>
      <p className="text-muted-foreground text-xs">Once stages are set up, this page shows where each order has got to.</p>
    </div>
  )
}
