import { formatDate } from '@/lib/utils'
import type { Routing } from '@/components/masters/RoutingFormDialog'

/**
 * The shapes /api/masters/style-tracking answers with, and how each state is
 * shown. One place, so the list and the style's page say the same thing in
 * the same colour.
 */

export type StepState = 'NOT_STARTED' | 'IN_PROGRESS' | 'DONE' | 'SKIPPED'
export type StyleState = 'NO_ROUTING' | 'NOT_STARTED' | 'IN_PROGRESS' | 'WAITING' | 'DONE'
export type Applies = 'STYLE' | 'CATEGORY' | 'ANY'

export interface Overall {
  state: StyleState
  /** The step to show beside the state: under way, or next to start. */
  step: string | null
  since: string | null
  done: number
  total: number
}

export interface StyleRow {
  style: { id: string; code: string; name: string; category: string | null; colors: string[]; isActive: boolean }
  routing: { id: string; code: string; name: string; version: number; applies: Applies; steps: number; alternatives: number } | null
  overall: Overall
  lastTouched: string | null
}

type Person = { id: string; name: string } | null

export interface StepRun {
  id: string
  operationId: string
  occurrence: number
  stepName: string
  sequence: number
  startedAt: string | null
  startedBy?: Person
  stoppedAt: string | null
  stoppedBy?: Person
  skippedAt: string | null
  skippedBy?: Person
  skipReason: string | null
  note: string | null
}

export interface TrackStep {
  key: string
  operationId: string
  occurrence: number
  sequence: number
  name: string
  kind: 'CUTTING' | 'STITCHING' | 'FINISHING' | 'QC' | 'PACKING' | 'OTHER'
  isQcStep: boolean
  execution: 'IN_HOUSE' | 'OUTSOURCED'
  skip: 'OPTIONAL' | 'WITH_APPROVAL' | 'NEVER'
  department: { id: string; name: string } | null
  workstation: { id: string; name: string; type: string } | null
  ratePerPiece: string | number | null
  instructions: string | null
  state: StepState
  /** The step that has to start first, when this one cannot start yet. */
  startBlockedBy: string | null
  run: StepRun | null
  /** Pieces completed at this step for the style, from the floor's records. */
  completed: number
}

export interface StyleDetail {
  style: {
    id: string
    code: string
    name: string
    category: string | null
    season: string | null
    colors: string[]
    isActive: boolean
    imageUrl: string | null
    sizeGroup: { name: string } | null
  }
  routing: Routing | null
  applies: Applies | null
  alternatives: number
  overall: Overall
  steps: TrackStep[]
  history: StepRun[]
  production: {
    planned: number
    orders: Array<{ moId: string; moNumber: string; status: string; color: string; planned: number; staged: boolean }>
  }
}

export const STYLE_STATE: Record<StyleState, { label: string; badge: string; dot: string }> = {
  NO_ROUTING: { label: 'No routing', badge: 'badge-neutral', dot: 'bg-slate-400' },
  NOT_STARTED: { label: 'Not started', badge: 'badge-neutral', dot: 'bg-slate-400' },
  IN_PROGRESS: { label: 'In progress', badge: 'badge-info', dot: 'bg-teal-500' },
  WAITING: { label: 'Waiting', badge: 'badge-warning', dot: 'bg-amber-500' },
  DONE: { label: 'Done', badge: 'badge-success', dot: 'bg-emerald-500' },
}

export const STEP_STATE: Record<StepState, { label: string; badge: string }> = {
  NOT_STARTED: { label: 'Not started', badge: 'badge-neutral' },
  IN_PROGRESS: { label: 'In progress', badge: 'badge-info' },
  DONE: { label: 'Done', badge: 'badge-success' },
  SKIPPED: { label: 'Left out', badge: 'badge-neutral' },
}

/** "14 Oct 2026, 10:32 am" — a date in the format chosen in Settings, and the time. */
export function when(d: string | Date): string {
  const at = new Date(d)
  return `${formatDate(at)}, ${at.toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit', hour12: true })}`
}

/** "2 days 3 hours", "45 minutes": how long a step took, or has been going. */
export function took(from: string | Date, to: string | Date = new Date()): string {
  const minutes = Math.max(0, Math.round((new Date(to).getTime() - new Date(from).getTime()) / 60000))
  const days = Math.floor(minutes / 1440)
  const hours = Math.floor((minutes % 1440) / 60)
  const mins = minutes % 60
  const part = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`
  if (days) return hours ? `${part(days, 'day')} ${part(hours, 'hour')}` : part(days, 'day')
  if (hours) return mins ? `${part(hours, 'hour')} ${part(mins, 'minute')}` : part(hours, 'hour')
  return part(mins, 'minute')
}

/** The style's state in a few words, for the list and the page's header. */
export function describe(o: Overall): string {
  switch (o.state) {
    case 'NO_ROUTING':
      return 'Give it a routing to track its steps'
    case 'NOT_STARTED':
      return o.step ? `Not started — ${o.step} first` : 'Not started'
    case 'IN_PROGRESS':
      return `${o.step} in progress${o.since ? ` since ${formatDate(o.since)}` : ''}`
    case 'WAITING':
      return `Waiting for ${o.step} to start`
    case 'DONE':
      return `All steps done${o.since ? ` on ${formatDate(o.since)}` : ''}`
  }
}

export const pcs = (n: number) => n.toLocaleString('en-IN')
