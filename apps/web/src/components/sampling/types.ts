import type {
  ProcessKind,
  SampleAttachment,
  SampleItemOption,
  SampleMaterialSource,
  SampleOrderLine,
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
  warehouse: { name: string } | null
  /**
   * The purchase orders buying it (not cancelled), with what has arrived:
   * Sourcing sums them with sampleOrdered / sampleReceived. No rates.
   */
  orders?: SampleOrderLine[]
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
  doneQty: number | null
  rejectedQty: number | null
  responsible: string | null
  reference: string | null
  notes: string | null
  completedAt: string | null
}
export interface SampleRound {
  id: string
  revision: number
  state: string
  specification: SampleSpecification
  stages: SampleStage[]
  materials: SampleMaterial[]
  qc: {
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
    }>
  } | null
  submission: { qty: number; recipient: string; reference: string; notes: string } | null
  decision: { result: string; buyerName: string; evidence: string; conditions: string } | null
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
  customer: { name: string } | null
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
