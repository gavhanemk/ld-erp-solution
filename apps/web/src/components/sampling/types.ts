import type { SampleSpecification } from '@ld-erp/shared'
export interface Choice {
  id: string
  name: string
}
export interface Lookups {
  customers: Choice[]
  brands: Choice[]
  warehouses: Choice[]
  styles: Array<
    Choice & { code: string; brandId: string | null; colors: string[]; sizeGroupId: string | null }
  >
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
  createdAt: string
  version: number
  cancelledAt: string | null
  cancelReason: string | null
  rounds: SampleRound[]
  events: Array<{
    id: string
    action: string
    createdAt: string
    detail: {
      by?: string
      data?: {
        reason?: string
        before?: Record<string, string | null>
        after?: Record<string, string | null>
      }
    }
  }>
}
