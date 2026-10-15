import { formatDate } from '@/lib/utils'
import type { Routing } from '@/components/masters/RoutingFormDialog'

/**
 * The shapes /api/masters/style-tracking answers with, and how each state is
 * shown. One place, so the list and the style's page say the same thing in
 * the same colour.
 *
 * Where a step stands comes from the production floor's records, across all
 * the style's orders — there is no Start or Stop to press (taken off on
 * 15 Oct 2026).
 */

export type StepState = 'NOT_STARTED' | 'IN_PROGRESS' | 'DONE' | 'SKIPPED'
export type StyleState = 'NO_ROUTING' | 'NOT_STARTED' | 'IN_PROGRESS' | 'DONE'
export type Applies = 'STYLE' | 'CATEGORY' | 'ANY'

export interface Overall {
  state: StyleState
  /** The step to show beside the state: the first not yet done, or the first of all. */
  step: string | null
  done: number
  total: number
  /** Pieces on the style's orders, closed orders left out. */
  planned: number
}

export interface StyleRow {
  style: { id: string; code: string; name: string; category: string | null; colors: string[]; isActive: boolean }
  routing: { id: string; code: string; name: string; version: number; applies: Applies; steps: number; alternatives: number; fabric: string | null } | null
  overall: Overall
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
  /** Pieces completed at this step for the style, from the floor's records. */
  completed: number
  note: string | null
  noteAt: string | null
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
  production: {
    planned: number
    orders: Array<{ moId: string; moNumber: string; status: string; color: string; planned: number; staged: boolean }>
  }
}

export const STYLE_STATE: Record<StyleState, { label: string; badge: string; dot: string }> = {
  NO_ROUTING: { label: 'No routing', badge: 'badge-neutral', dot: 'bg-slate-400' },
  NOT_STARTED: { label: 'Not started', badge: 'badge-neutral', dot: 'bg-slate-400' },
  IN_PROGRESS: { label: 'In progress', badge: 'badge-info', dot: 'bg-teal-500' },
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

/**
 * "Changed 15 Oct 2026, 3:20 pm by Aman" — when a routing was last saved, and
 * by whom. Routings made before that was recorded have only the time.
 */
export function changed(r: Pick<Routing, 'updatedAt' | 'updatedBy'>): string | null {
  if (!r.updatedAt) return null
  return `Changed ${when(r.updatedAt)}${r.updatedBy ? ` by ${r.updatedBy.name}` : ''}`
}

/** The style's state in a few words, for the list and the page's header. */
export function describe(o: Overall): string {
  switch (o.state) {
    case 'NO_ROUTING':
      return 'Give it a routing to see its steps'
    case 'NOT_STARTED':
      return o.planned ? (o.step ? `Not started — ${o.step} first` : 'Not started') : 'No orders yet'
    case 'IN_PROGRESS':
      return `At ${o.step}`
    case 'DONE':
      return 'Every order through every step'
  }
}

export const pcs = (n: number) => n.toLocaleString('en-IN')
