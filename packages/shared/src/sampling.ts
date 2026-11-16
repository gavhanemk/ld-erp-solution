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

/**
 * What a file on a sample request is. The buyer's tech pack arrives first and
 * is filed against the request itself; photos, patterns, approvals and courier
 * slips usually belong to one round. Kept as plain codes so the database can
 * check them (sample_attachment_kind) and every screen labels them alike.
 */
export const SAMPLE_ATTACHMENT_KINDS = [
  'TECH_PACK',
  'PATTERN',
  'PHOTO',
  'APPROVAL',
  'DISPATCH',
  'OTHER',
] as const
export type SampleAttachmentKind = (typeof SAMPLE_ATTACHMENT_KINDS)[number]
export const SAMPLE_ATTACHMENT_KIND_LABEL: Record<SampleAttachmentKind, string> = {
  TECH_PACK: 'Tech pack',
  PATTERN: 'Pattern',
  PHOTO: 'Photo',
  APPROVAL: 'Buyer approval',
  DISPATCH: 'Dispatch slip',
  OTHER: 'Other',
}

/** One file kept against a sample request, or against one of its rounds. */
export interface SampleAttachment {
  id: string
  requestId: string
  /** Null for a file of the whole request, such as the buyer's tech pack. */
  roundId: string | null
  kind: SampleAttachmentKind
  fileName: string
  storagePath: string
  mimeType: string | null
  sizeBytes: number
  uploadedById: string
  uploadedBy?: { id: string; name: string } | null
  createdAt: string
  /** Sent by the file list: false once the file is kept as part of the record. */
  removable?: boolean
  /** Why it can no longer be removed, in words; null while it can. */
  lockedReason?: string | null
}

/**
 * Where a style stands. A new style the buyer sends for sampling is made as
 * DEVELOPMENT, kept off order, BOM and production screens, and becomes
 * PRODUCTION only when its sample is approved and handed over.
 */
export const STYLE_STAGES = ['DEVELOPMENT', 'PRODUCTION'] as const
export type StyleStage = (typeof STYLE_STAGES)[number]
export const STYLE_STAGE_LABEL: Record<StyleStage, string> = {
  DEVELOPMENT: 'In sampling',
  PRODUCTION: 'Production',
}

/** The request's style, as the request detail and the register carry it. */
export interface SampleRequestStyle {
  id: string
  code: string
  name: string
  stage: StyleStage
  brandId: string | null
  category: string | null
  season: string | null
  sizeGroupId: string | null
  colors: string[]
  isActive: boolean
}
