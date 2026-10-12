'use client'

import { useParams } from 'next/navigation'
import { StyleTracker } from '@/components/masters/routing/StyleTracker'

/** One style's routing and the start and stop of each of its steps. */
export default function StyleRoutingPage() {
  const { styleId } = useParams<{ styleId: string }>()
  return <StyleTracker styleId={styleId} />
}
