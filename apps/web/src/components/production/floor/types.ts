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
  places: Place[]
}

export interface TransferLine {
  id: string
  dispatchedQty: number
  receivedQty: number
  shortQty: number
  settledQty: number
  excessQty: number
  bundle: { id: string; code: string; size: { code: string } | null }
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
    sizes: Array<{ id: string; code: string; sequence: number; qty: number }>
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
  noOfLayers: number | null
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

/** A job card and everything its sheets show, as GET /production/job-cards/:id returns it. */
export interface JobCardDetail extends Flow {
  card: JobCardHeader
  line: Flow['lines'][number]
  /** Each stage's figures, size by size. */
  sizeFigures: Record<string, StepFigures[]>
  cuttings: JobCardCutting[]
  log: LogEntry[]
  materials: { issued: boolean; requisitions: Array<{ id: string; mrNumber: string; status: string; department: string; issued: boolean; closed: boolean }> }
}

/** The reference the floor's papers carry: order no. / project ID / design no. */
export const refNo = (c: Pick<JobCardHeader, 'orderNo' | 'projectId' | 'designNo' | 'jobCardNumber'>) =>
  [c.orderNo, c.projectId, c.designNo].filter(Boolean).join('/') || c.jobCardNumber

export type Stage = 'CUTTING' | 'STITCHING' | 'OTHER' | 'QC'
export const stageOf = (s: { kind: string; isQcStep: boolean }): Stage => (isCheck(s) ? 'QC' : s.kind === 'CUTTING' ? 'CUTTING' : s.kind === 'STITCHING' ? 'STITCHING' : 'OTHER')
/** A job card's sheet for one stage, on the production stages screen. */
export const sheetHref = (jobCardId: string, stepId: string) => `/production/stages?card=${jobCardId}&step=${stepId}`

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
