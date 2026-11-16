/** A round is one style/colour, one milestone and one frozen technical version. */
export const SAMPLE_STAGES = ['Cutting', 'Stitching', 'Finishing'] as const
export const SAMPLE_DECISIONS = ['APPROVED', 'CHANGES_REQUIRED', 'REJECTED'] as const
export const SAMPLE_STATES = [
  'DRAFT',
  'RELEASED',
  'QC_PASSED',
  'SUBMITTED',
  ...SAMPLE_DECISIONS,
] as const
export const SAMPLE_STATE_LABEL: Record<string, string> = {
  DRAFT: 'Draft specification',
  RELEASED: 'Being made',
  QC_PASSED: 'Ready to submit',
  SUBMITTED: 'Buyer review',
  APPROVED: 'Buyer approved',
  CHANGES_REQUIRED: 'Changes required',
  REJECTED: 'Rejected',
  CANCELLED: 'Cancelled',
}
export interface SampleSpecification {
  milestone: string
  styleId: string
  color: string
  construction: string
  techPackRef: string
  patternRef: string
  sizes: Array<{ sizeId: string; qty: number }>
  measurements: Array<{
    name: string
    sizeId: string
    target: number
    tolerance: number
    unit: 'cm' | 'in'
  }>
  stages: string[]
  materials: Array<{
    itemId: string
    warehouseId: string
    qty: number
    ownership: 'OWNED' | 'CUSTOMER_OWNED'
  }>
  notes: string
}
