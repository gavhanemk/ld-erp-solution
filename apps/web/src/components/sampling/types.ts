import type {
  SampleAttachment,
  SampleRequestStyle,
  SampleSpecification,
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
  warehouses: Choice[]
  styles: LookupStyle[]
  /** Active size runs, for the style a request makes for itself. */
  sizeGroups: Choice[]
  sizes: Array<{ id: string; code: string; sizeGroupId: string }>
  items: Array<Choice & { code: string; uom: { symbol: string } | null }>
  boms: Array<{ id: string; styleId: string; color: string | null; version: string }>
  routings: Array<Choice & { styleId: string | null; category: string | null; version: number }>
}
export interface SampleMaterial {
  id: string
  plannedQty: string
  issuedQty: string
  usedQty: string
  wasteQty: string
  returnedQty: string
  issuedValue?: string
  returnedValue?: string
  ownership: string
  item: { name: string; uom: { symbol: string } | null }
  warehouse: { name: string }
}
export interface SampleRound {
  id: string
  revision: number
  state: string
  specification: SampleSpecification
  stages: Array<{
    id: string
    sequence: number
    name: string
    doneQty: number | null
    rejectedQty: number | null
    responsible: string | null
    reference: string | null
    notes: string | null
    completedAt: string | null
  }>
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
