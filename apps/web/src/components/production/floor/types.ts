/** The production picture of one order, as GET /production/orders/:id/flow returns it. */

export type Bucket = 'TRANSIT' | 'WIP' | 'DONE' | 'REWORK' | 'DAMAGED' | 'REJECTED' | 'SHORT' | 'B_GRADE' | 'SCRAPPED' | 'PACKED' | 'PACKED_B'

export interface StepFigures {
  stepId: string
  state: 'NOT_STARTED' | 'IN_PROGRESS' | 'DONE' | 'SKIPPED'
  flags: string[]
  received: number
  completed: number
  sentOn: number
  packed: number
  damaged: number
  rejected: number
  rework: number
  bGrade: number
  scrapped: number
  inTransit: number
  inHand: number
  atVendor: number
  inRework: number
  waiting: number
  damagedNow: number
  rejectedNow: number
  short: number
  bGradeNow: number
  yetToCome: number
  /** Size by size only: pieces made as this size here (in) or as another size (out) by a size change at stitching. */
  sizeIn?: number
  sizeOut?: number
}

export interface FlowStep {
  id: string
  sequence: number
  name: string
  kind: 'CUTTING' | 'STITCHING' | 'FINISHING' | 'QC' | 'PACKING' | 'OTHER'
  isQcStep: boolean
  execution: 'IN_HOUSE' | 'OUTSOURCED'
  skip: 'OPTIONAL' | 'WITH_APPROVAL' | 'NEVER'
  skippedAt: string | null
  skipReason: string | null
  skippedBy: { name: string } | null
  ratePerPiece: number | null
  instructions: string | null
  operationId: string
  departmentId: string
  department: { id: string; name: string }
  workstationId: string | null
  workstation: { id: string; name: string; type: string; supplier: { id: string; name: string } | null } | null
  /** Who normally does it, from the routing. */
  contractor?: { id: string; name: string } | null
  next: { id: string; name: string; execution: 'IN_HOUSE' | 'OUTSOURCED' } | null
  last: boolean
  lastActivity: string | null
  reworkForOthers: number
  figures: StepFigures | null
}

export interface Place {
  stepId: string
  bucket: Bucket
  vendorId: string | null
  reworkStepId: string | null
  qty: number
}

export interface FlowBundle {
  id: string
  code: string
  bundleNo: number
  qty: number
  size: { id: string; code: string; sequence: number } | null
  line: { id: string; style: string; color: string } | null
  cutting: string
  lotNo: string | null
  cancelled: boolean
  /** Made from this bundle by a size change at stitching (its pieces were cut there, as another size). */
  parent?: { id: string; code: string; size: string | null } | null
  madeAtStepId?: string | null
  /** Its size change was taken back. */
  undone?: boolean
  places: Place[]
}

export interface TransferLine {
  id: string
  dispatchedQty: number
  receivedQty: number
  shortQty: number
  settledQty: number
  excessQty: number
  /** parentId: made by an earlier size change, so its pieces change size no more. */
  bundle: { id: string; code: string; size: { code: string } | null; parentId?: string | null }
}

export interface FlowTransfer {
  id: string
  transferNumber: string
  status: 'DISPATCHED' | 'PARTLY_RECEIVED' | 'RECEIVED' | 'DISCREPANCY' | 'CANCELLED'
  isRework: boolean
  dispatchDate: string
  issuedBy: string | null
  receivedBy: string | null
  receivedAt: string | null
  notes: string | null
  cancelReason: string | null
  fromStep: { id: string; name: string }
  toStep: { id: string; name: string }
  vendor: { id: string; name: string } | null
  jobWorkOrder: { id: string; orderNumber: string } | null
  lines: TransferLine[]
}

export interface JobWorkReturn {
  eventId: string
  date: string
  theirChallanNo: string | null
  accepted: number
  rejected: number
  damaged: number
  chargeQty: number
  chargeRate: number
  amount: number
  billNo: string | null
  billDate: string | null
  reason: string | null
}

export interface FlowJobWorkOrder {
  id: string
  orderNumber: string
  status: 'OPEN' | 'CLOSED' | 'CANCELLED'
  rate: number
  expectedBy: string | null
  notes: string | null
  createdAt: string
  step: { id: string; name: string }
  vendor: { id: string; name: string; gstin: string | null }
  sent: number
  sentForRework: number
  accepted: number
  rejected: number
  damaged: number
  held: number
  charged: number
  billed: number
  challans: Array<{ id: string; number: string; isRework: boolean; date: string; cancelled: boolean }>
  returns: JobWorkReturn[]
}

export interface FlowEvent {
  id: string
  type: string
  date: string
  at: string
  step: string | null
  stepId: string | null
  person: string | null
  by: string
  vendor: string | null
  document: string | null
  reason: string | null
  notes: string | null
  undone: boolean
  isUndo: boolean
  pieces: number
}

export interface Flow {
  mo: {
    id: string
    moNumber: string
    status: string
    progress: string | null
    held: { at: string; reason: string | null; by: string | null } | null
    routing: { id: string | null; code: string; name: string; version: number | null; latest: number } | null
    totalPlannedQty: number
    totalCutQty: number
    totalPackedQty: number
    so: { soNumber: string; isJobWork: boolean; customer: { name: string } } | null
  }
  lines: Array<{
    id: string
    style: { code: string; name: string }
    color: string
    totalQty: number
    item: { id: string; code: string; name: string } | null
    /** qty is the planned count; changed is what size changes at stitching moved into (+) or out of (−) the size. */
    sizes: Array<{ id: string; code: string; sequence: number; qty: number; changed?: number }>
  }>
  steps: FlowStep[]
  bundles: FlowBundle[]
  transfers: FlowTransfer[]
  jobWorkOrders: FlowJobWorkOrder[]
  events: FlowEvent[]
}

/** A cutting sheet's lay: issued to a contractor, then received back cut. */
export interface JobCardCutting {
  id: string
  cutOrderNumber: string
  cutDate: string
  updatedAt: string
  status: 'PENDING' | 'IN_PROGRESS' | 'COMPLETED' | 'CANCELLED'
  cutterName: string | null
  lotNo: string | null
  ratio: string | null
  noOfLayers: number | string | null
  fabricIssued: string | number | null
  fabricUsed: string | number | null
  wastage: string | number | null
  bundleSize: number | null
  plannedPieces: number
  actualPieces: number
  plannedBreakup: Record<string, number> | null
  sizeBreakup: Record<string, number> | null
  notes: string | null
  fabricItem: { id: string; code: string; name: string; uom: { symbol: string } | null } | null
  createdBy: { name: string } | null
  _count: { bundles: number }
}

/** One entry of the floor, as a sheet's log reads it. */
export interface LogEntry {
  eventId: string
  type: string
  date: string
  person: string | null
  by: string
  reason: string | null
  document: string | null
  stepId: string
  bundleId: string
  sizeId: string | null
  bucket: Bucket
  qty: number
  vendorId: string | null
}

export interface JobCardHeader {
  id: string
  jobCardNumber: string
  moId: string
  moLineId: string
  orderNo: string | null
  projectId: string | null
  description: string | null
  fabricQuality: string | null
  designNo: string | null
  lotNo: string | null
  meters: number | null
  average: number | null
  ratio: string | null
  notes: string | null
  createdAt: string
  due: string | null
  so: { soNumber: string; customerPORef: string | null; reference: string | null; customer: { name: string } } | null
}

/**
 * A job card's fabric through cutting, one unit at a time: given to the
 * cutting contractors, used and wasted as each lay came back cut, and what is
 * left over with them. Worked out by the server from the lays.
 */
export interface FabricRecord {
  /** m, kg… or '' when the fabric has no unit. */
  unit: string
  given: number
  /** Of what was given, on lays still with their contractors. */
  withCutters: number
  used: number
  waste: number
  /** On received lays: given less used and waste, still with the contractor. */
  leftOver: number
  /** On received lays: used and waste above what was given. */
  overUsed: number
  leftWith: Array<{ name: string; qty: number }>
  overBy: Array<{ name: string; qty: number }>
  /** Lays received with no fabric given recorded. */
  notRecorded: number
}

/** A job card and everything its sheets show, as GET /production/job-cards/:id returns it. */
export interface JobCardDetail extends Flow {
  card: JobCardHeader
  line: Flow['lines'][number]
  /** Each stage's figures, size by size. */
  sizeFigures: Record<string, StepFigures[]>
  cuttings: JobCardCutting[]
  /** Fabric given to its cutting contractors, used, wasted and left over. */
  fabric: FabricRecord[]
  /** Cut the old way before the order had stages (cutting numbers): it carries on without them. */
  cutWithoutStages?: string[]
  /** Size changes made on this job card at stitching, newest first. */
  sizeChanges?: SizeChangeEntry[]
  log: LogEntry[]
  materials: { issued: boolean; requisitions: Array<{ id: string; mrNumber: string; status: string; department: string; issued: boolean; closed: boolean }> }
}

/** One save of a size change: pieces of bundles made as other sizes at a stitching step. */
export interface SizeChangeEntry {
  eventId: string
  moLineId: string
  at: string
  date: string
  by: string
  personName: string | null
  step: { id: string; name: string }
  reason: string
  undone: { at: string; by: string | null; reason: string | null } | null
  moves: Array<{
    from: { bundleId: string; code: string; bundleNo: number; size: string; sizeId: string }
    to: { bundleId: string; code: string; bundleNo: number; size: string; sizeId: string }
    qty: number
  }>
}

/** A size's count after size changes at stitching: what was planned, plus what moved into it, less what moved out. */
export const revisedQty = (z: { qty: number; changed?: number }) => Math.max(0, z.qty + (z.changed ?? 0))

/** The bundle's own number from its code: "B003" from "MO-2627-0042-B003". */
export const bundleShort = (code: string) => code.split('-').pop() ?? code

/**
 * The lot no. a sheet shows: the job card's own, or else the lots written on
 * its lays (issued to cutting contractors) — a lot put on a lay's Edit shows
 * at the top of the sheet without being typed twice.
 */
export function lotOf(d: Pick<JobCardDetail, 'card' | 'cuttings'>): { lot: string; fromLays: boolean } | null {
  if (d.card.lotNo?.trim()) return { lot: d.card.lotNo.trim(), fromLays: false }
  const lots = [...new Set(d.cuttings.filter((c) => c.status !== 'CANCELLED' && c.lotNo?.trim()).map((c) => c.lotNo!.trim()))]
  return lots.length ? { lot: lots.join(', '), fromLays: true } : null
}

/**
 * The reference the floor's papers carry: order no. / project ID / design no., as the paper sheets'
 * "LDCM-06/DC-46/DCSHRFS01001099-02" — a number written once even when two of them are the same.
 */
export const refNo = (c: Pick<JobCardHeader, 'orderNo' | 'projectId' | 'designNo' | 'jobCardNumber'>) =>
  [...new Set([c.orderNo, c.projectId, c.designNo].map((v) => v?.trim()).filter(Boolean))].join('/') || c.jobCardNumber

export type Stage = 'CUTTING' | 'STITCHING' | 'OTHER' | 'QC'
export const stageOf = (s: { kind: string; isQcStep: boolean }): Stage => (isCheck(s) ? 'QC' : s.kind === 'CUTTING' ? 'CUTTING' : s.kind === 'STITCHING' ? 'STITCHING' : 'OTHER')
/** A job card's sheet for one stage, on the production stages screen. */
export const sheetHref = (jobCardId: string, stepId: string) => `/production/floor?tab=stages&card=${jobCardId}&step=${stepId}`

/** How many pieces of a bundle sit in one place. */
export const heldAt = (b: FlowBundle, stepId: string, bucket: Bucket, opts: { vendorId?: string | null; reworkStepId?: string | null } = {}) =>
  b.places
    .filter(
      (p) =>
        p.stepId === stepId &&
        p.bucket === bucket &&
        (opts.vendorId === undefined ? !p.vendorId : p.vendorId === opts.vendorId) &&
        (opts.reworkStepId === undefined || p.reworkStepId === opts.reworkStepId),
    )
    .reduce((s, p) => s + p.qty, 0)

export function isCheck(s: { isQcStep: boolean; kind: string }) {
  return s.isQcStep || s.kind === 'QC'
}

export const PROGRESS: Record<string, { label: string; cls: string }> = {
  NOT_STARTED: { label: 'Not started', cls: 'badge-neutral' },
  IN_PROGRESS: { label: 'In progress', cls: 'badge-info' },
  QC_PENDING: { label: 'QC pending', cls: 'badge-warning' },
  REWORK: { label: 'Rework required', cls: 'badge-warning' },
  DISCREPANCY: { label: 'Count short', cls: 'badge-danger' },
  DONE: { label: 'All through', cls: 'badge-success' },
}

export const TRANSFER_STATUS: Record<FlowTransfer['status'], { label: string; cls: string }> = {
  DISPATCHED: { label: 'On its way', cls: 'badge-info' },
  PARTLY_RECEIVED: { label: 'Partly counted in', cls: 'badge-warning' },
  RECEIVED: { label: 'Received', cls: 'badge-success' },
  DISCREPANCY: { label: 'Short — to settle', cls: 'badge-danger' },
  CANCELLED: { label: 'Cancelled', cls: 'badge-neutral' },
}

/** A key the server uses to store the same save once, however often it is sent. */
export const newClientKey = () =>
  typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `k${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`

export const pcs = (n: number) => n.toLocaleString('en-IN')

/** A quantity of fabric with its unit: "7.5 m", "120 kg", or the figure alone. */
export const fabricQty = (n: number, unit: string) => `${n.toLocaleString('en-IN', { maximumFractionDigits: 3 })}${unit ? ` ${unit}` : ''}`

/** Who has the left over, or used more than given: "Ram" when it is one contractor, "Suresh 20 m, Ram 5 m" when more. */
export const whoHas = (list: Array<{ name: string; qty: number }>, unit: string) =>
  list.length === 1 ? list[0].name : list.map((x) => `${x.name} ${fabricQty(x.qty, unit)}`).join(', ')

/**
 * A job card's fabric in one line, as the floor reads it:
 * "950 m given · 900 m used · 30 m waste · 20 m left over with Suresh".
 */
export function fabricLine(r: FabricRecord) {
  return [
    r.given ? `${fabricQty(r.given, r.unit)} given` : null,
    r.withCutters ? `${fabricQty(r.withCutters, r.unit)} with cutters` : null,
    r.used || r.waste ? `${fabricQty(r.used, r.unit)} used · ${fabricQty(r.waste, r.unit)} waste` : null,
    r.leftOver ? `${fabricQty(r.leftOver, r.unit)} left over with ${whoHas(r.leftWith, r.unit)}` : null,
    r.overUsed ? `${fabricQty(r.overUsed, r.unit)} more used than given (${whoHas(r.overBy, r.unit)})` : null,
    r.notRecorded ? `fabric given not recorded on ${r.notRecorded} ${r.notRecorded === 1 ? 'lay' : 'lays'}` : null,
  ]
    .filter(Boolean)
    .join(' · ')
}
