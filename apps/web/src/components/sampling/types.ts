import type {
  SampleChargeKind,
  SampleCostSheet,
  SampleDecision,
  SampleDispatchMode,
  SampleQc,
  MakingQtyCell,
  MakingReturnCell,
  MakingWorkCell,
  ProcessKind,
  SampleAttachment,
  SampleItemOption,
  SampleMaterialSource,
  SampleOrderLine,
  SamplePool,
  SampleCloseOutKind,
  SampleRequestStyle,
  SampleSpecification,
  StepExecution,
  StyleStage,
} from '@ld-erp/shared'
export interface Choice {
  id: string
  name: string
}
export type LookupStyle = Choice & {
  code: string
  brandId: string | null
  colors: string[]
  sizeGroupId: string | null
  stage: StyleStage
  category: string | null
  season: string | null
  /** Open sample requests on the style: one in sampling belongs to the request developing it. */
  sampleRequests?: Array<{ id: string; number: string }>
}
export interface Lookups {
  customers: Choice[]
  brands: Choice[]
  /** Stores in use, sample stores first (purpose SAMPLING: material bought for samples). */
  warehouses: Array<Choice & { purpose?: 'GENERAL' | 'SAMPLING' }>
  styles: LookupStyle[]
  /** Active size runs, for the style a request makes for itself. */
  sizeGroups: Choice[]
  sizes: Array<{ id: string; code: string; sizeGroupId: string }>
  /** The materials a sample BOM line can name, as the BOM's picker shows them. */
  items: SampleItemOption[]
  boms: Array<{ id: string; styleId: string; color: string | null; version: string }>
  routings: Array<Choice & { styleId: string | null; category: string | null; version: number }>
  /** What a round's making route is built from: the Operation master, in floor order. */
  operations: LookupOperation[]
  departments: Array<Choice & { code: string }>
  /** Floor contractors, with the processes each one takes. */
  contractors: LookupContractor[]
  /** Outside units a step can go to: every supplier in use, service suppliers first. */
  jobWorkers: Array<Choice & { code: string; category: string }>
  /** For adding a material the masters do not have yet. */
  itemCategories: Array<Choice & { parentId: string | null; departmentId: string | null }>
  uoms: Array<Choice & { symbol: string }>
}
export interface LookupOperation {
  id: string
  code: string
  name: string
  kind: ProcessKind
  departmentId: string
  defaultExecution: StepExecution
  instructions: string | null
  sortOrder: number
}
export interface LookupContractor {
  id: string
  code: string
  name: string
  operationIds: string[]
  operations: Choice[]
}
/**
 * One line of a round's sample BOM, as its row (sample_materials). Figures
 * arrive as text, as every decimal column does. The specification carries a
 * copy of these lines with the same ids; the rows are what is issued against.
 */
export interface SampleMaterial {
  id: string
  /** The order the lines are listed in. */
  sequence: number
  /** Which part of the garment it goes into: Body, Collar, Placket. */
  component: string
  /** Null on a draft line whose material is not picked yet. */
  itemId: string | null
  /** Null: every colour of the round. */
  colour: string | null
  departmentId: string | null
  qtyPerPiece: string
  wastagePct: string
  /** The required quantity: worked out, or typed by hand (requiredOverride). */
  plannedQty: string
  requiredOverride: boolean
  overrideReason: string | null
  source: SampleMaterialSource
  estRate: string | null
  remarks: string
  /** The store it is issued from: null until the first issue names it. */
  warehouseId: string | null
  issuedQty: string
  usedQty: string
  wasteQty: string
  returnedQty: string
  /** Sent only to people who can see accounts. */
  issuedValue?: string
  returnedValue?: string
  /** Follows the source: ours when we buy it, the buyer's when they send it. */
  ownership: string
  /** The item as the BOM's picker lists it, with whether it is still in use. */
  item: {
    id?: string
    name: string
    code: string
    type: string
    isActive?: boolean
    departmentId?: string | null
    /** Decimal: arrives as text. */
    standardRate?: string | number | null
    uom: { id?: string; name?: string; symbol: string } | null
  } | null
  /** Its store; purpose SAMPLING for a sample store. */
  warehouse: { name: string; purpose?: 'GENERAL' | 'SAMPLING' } | null
  /**
   * The purchase orders buying it (not cancelled), with what has arrived:
   * Sourcing sums them with sampleOrdered / sampleReceived. No rates.
   */
  orders?: SampleOrderLine[]
  /** Not needed after all: making may start without it (WAIVE_MATERIAL). */
  waivedAt?: string | null
  waivedReason?: string | null
  waivedBy?: string | null
}
/** A step of a released round's making route (sample_stages). */
export interface SampleStage {
  id: string
  sequence: number
  name: string
  /** As the route named it at release; null on a step released before routes named a process. */
  operationId: string | null
  kind: ProcessKind | null
  departmentId: string | null
  execution: StepExecution
  /** The floor contractor of a step done on our floor. */
  contractorId: string | null
  /** The outside unit (a supplier) of a step done outside. */
  vendorId: string | null
  instructions: string | null
  /** What the step's records add up to; on a whole step, what was recorded. */
  doneQty: number | null
  rejectedQty: number | null
  responsible: string | null
  reference: string | null
  notes: string | null
  completedAt: string | null
  /** Recorded in one go before work was recorded by colour and size. */
  wholeStep?: boolean
  /** The step's labour (₹, decimal as text): sent to those who record it, and to accounts. */
  labourAmount?: string
  labourNote?: string | null
}
/** Work recorded at a step on our own floor (STEP_WORK). */
export interface SampleWork {
  id: string
  stageId: string
  cells: MakingWorkCell[]
  doneBy: string
  workedOn: string
  notes: string | null
  createdAt: string
  undoneAt: string | null
  undoneBy: string | null
  undoneReason: string | null
}
/** Pieces handed on to the next step (STEP_SEND), and counted in there (STEP_RECEIVE). */
export interface SampleTransfer {
  id: string
  fromStageId: string
  toStageId: string
  cells: MakingQtyCell[]
  sentBy: string
  sentOn: string
  receivedCells: MakingQtyCell[] | null
  receivedBy: string | null
  receivedOn: string | null
  shortReason: string | null
  notes: string | null
  createdAt: string
  undoneAt: string | null
  undoneBy: string | null
  undoneReason: string | null
}
/** What came back from the unit on a challan (JOB_RETURN). */
export interface SampleJobReturn {
  id: string
  cells: MakingReturnCell[]
  theirChallanNo: string | null
  receivedBy: string
  receivedOn: string
  /** What the unit charged (₹): sent to those who record it, and to accounts. */
  chargeAmount?: string
  notes: string | null
  createdAt: string
  undoneAt: string | null
  undoneBy: string | null
  undoneReason: string | null
}
/** Samples sent to the buyer on a Sample Delivery Challan (DISPATCH). */
export interface SampleDispatch {
  id: string
  number: string
  cells: MakingQtyCell[]
  recipient: string
  address: string | null
  mode: SampleDispatchMode
  courier: string | null
  awb: string | null
  sentOn: string
  returnable: boolean
  expectedBack: string | null
  declaredValue: string | null
  /** What sending them cost (₹): to those who record sampling, and to accounts. */
  courierCharge?: string
  notes: string | null
  createdAt: string
  cancelledAt: string | null
  cancelledBy: string | null
  cancelReason: string | null
}
/** Pieces given to a step's outside unit on a job-work challan (JOB_SEND). */
export interface SampleJobWork {
  id: string
  number: string
  stageId: string
  vendorId: string
  vendor: { id: string; name: string } | null
  cells: MakingQtyCell[]
  sentBy: string
  sentOn: string
  expectedBack: string | null
  vehicleNo: string | null
  declaredValue: string | null
  notes: string | null
  createdAt: string
  cancelledAt: string | null
  cancelledBy: string | null
  cancelReason: string | null
  returns: SampleJobReturn[]
}
export interface SampleRound {
  id: string
  revision: number
  state: string
  specification: SampleSpecification
  stages: SampleStage[]
  /** How it is being made: work, hand-ons and outside units' challans, oldest first. */
  works: SampleWork[]
  transfers: SampleTransfer[]
  jobWorks: SampleJobWork[]
  materials: SampleMaterial[]
  /**
   * The latest inspection: colour by colour since phase 6 (colours), or one
   * of the whole set before. normaliseQc reads either in today's shape.
   */
  qc: {
    /** At least one colour passed. */
    passed: boolean
    passedQty: number
    notes: string
    results: Array<{
      name: string
      sizeId: string
      actual: number
      target: number
      unit: string
      pass: boolean
      colour?: string
    }>
    colours?: SampleQc['colours']
    by?: string
    at?: string
  } | null
  /** Sent to the buyer whole, before Sample Delivery Challans. */
  submission: { qty: number; recipient: string; reference: string; notes: string } | null
  /**
   * The buyer's word: colour by colour since phase 6 (colours), the round's
   * verdict once every colour has one. normaliseDecision reads either.
   */
  decision: {
    result?: string
    buyerName?: string
    evidence?: string
    conditions?: string
    colours?: SampleDecision['colours']
  } | null
  /** Samples sent to the buyer on Sample Delivery Challans, oldest first. */
  dispatches: SampleDispatch[]
  handover: {
    bomId: string
    bomVersion: string
    routingId: string
    routingVersion: number
    notes: string
    preparedBy: string
    acceptedBy?: string
    acceptedAt?: string
  } | null
}
export interface SampleRequest {
  id: string
  number: string
  title: string
  buyerRef: string | null
  brandId: string
  customerId: string | null
  /** With where samples go, sent with the request itself. */
  customer: {
    name: string
    phone?: string | null
    shippingAddress?: string | null
    shippingCity?: string | null
    shippingState?: string | null
    shippingPincode?: string | null
    billingAddress?: string | null
    billingCity?: string | null
    billingState?: string | null
    billingPincode?: string | null
  } | null
  brand: { name: string }
  owner: string
  brief: string
  requiredAt: string | null
  /** From the buyer's tech pack: their own style number, season and garment. */
  buyerStyleRef: string | null
  season: string | null
  garmentCategory: string | null
  styleId: string | null
  /** The register sends only code, name and stage; the request itself sends it whole. */
  style: SampleRequestStyle | null
  /** Oldest first. The register leaves them out. */
  attachments?: SampleAttachment[]
  createdAt: string
  version: number
  cancelledAt: string | null
  cancelReason: string | null
  rounds: SampleRound[]
  events: SampleEvent[]
  /**
   * The request's own material in the sample stores, and how it covers the
   * round being made (samplePool). Sent with the request itself; the register
   * leaves it out.
   */
  pool?: SamplePool | null
  /** Leftovers closed out, newest first. The value only to those who see accounts. */
  closeOuts?: SampleCloseOut[]
  /** Its other costs, oldest first; the amounts to those who record them. Sent with the request itself. */
  charges?: SampleCharge[]
  /** Set while the costs are finalised (FINALISE_COST): nothing that costs changes. */
  costFinalisedAt?: string | null
  costFinalisedBy?: string | null
  /** The finalised sheet, to those who see costs (approvers, accounts). */
  costSheet?: SampleCostSheet | null
}
/** A cost besides material and labour (ADD_CHARGE). */
export interface SampleCharge {
  id: string
  roundId: string | null
  kind: SampleChargeKind
  description: string
  /** Decimal as text; to those who record charges, and to accounts. */
  amount?: string
  billRef: string | null
  chargedOn: string
  createdAt: string
  removedAt: string | null
  removedBy: string | null
  removeReason: string | null
}
export interface SampleCloseOut {
  id: string
  roundId: string
  itemId: string
  warehouseId: string
  kind: SampleCloseOutKind
  toWarehouseId: string | null
  qty: string
  value?: string
  reason: string
  createdAt: string
  item: { name: string; code: string; uom: { symbol: string } | null }
  warehouse: { name: string }
  toWarehouse: { name: string } | null
  createdBy: { name: string }
}
export interface SampleEvent {
  id: string
  action: string
  createdAt: string
  detail: {
    by?: string
    roundId?: string
    data?: {
      reason?: string
      // Request edits: field values. Style actions: the style before and after.
      before?: Record<string, unknown> | null
      after?: Record<string, unknown> | null
      [key: string]: unknown
    }
  }
}
