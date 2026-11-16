import { z } from 'zod'
const text = (max = 500) => z.string().trim().min(1, 'Fill in this field').max(max)
const id = text(100)
const qty = z.number().positive().max(999999).multipleOf(0.001)
// Drafts retain the same JSON shape as released specifications. Blank values and
// unfinished rows are allowed; bounds and any supplied master IDs remain checked.
const draftText = (max: number) => z.string().trim().max(max)
export const sampleDraftSchema = z
  .object({
    milestone: draftText(80),
    styleId: draftText(100),
    color: draftText(100),
    construction: draftText(4000),
    techPackRef: draftText(1000),
    patternRef: draftText(1000),
    sizes: z
      .array(z.object({ sizeId: draftText(100), qty: z.number().int().min(0).max(1000) }))
      .max(30),
    measurements: z
      .array(
        z.object({
          name: draftText(100),
          sizeId: draftText(100),
          target: z.number().min(0).max(10000),
          tolerance: z.number().min(0).max(100),
          unit: z.enum(['cm', 'in']),
        })
      )
      .max(200),
    stages: z.array(draftText(80)).max(20),
    materials: z
      .array(
        z.object({
          itemId: draftText(100),
          warehouseId: draftText(100),
          qty: z.number().min(0).max(999999).multipleOf(0.001),
          ownership: z.enum(['OWNED', 'CUSTOMER_OWNED']),
        })
      )
      .max(100),
    notes: draftText(4000),
  })
  .strict()
export const sampleDraftPatchSchema = sampleDraftSchema.partial()
export const sampleSpecificationSchema = z
  .object({
    milestone: text(80),
    styleId: id,
    color: text(100),
    construction: text(4000),
    techPackRef: text(1000),
    patternRef: text(1000),
    sizes: z
      .array(z.object({ sizeId: id, qty: z.number().int().positive().max(1000) }))
      .min(1)
      .max(30),
    measurements: z
      .array(
        z.object({
          name: text(100),
          sizeId: id,
          target: z.number().min(0).max(10000),
          tolerance: z.number().min(0).max(100),
          unit: z.enum(['cm', 'in']),
        })
      )
      .min(1)
      .max(200),
    stages: z.array(text(80)).min(2).max(20),
    materials: z
      .array(
        z.object({
          itemId: id,
          warehouseId: id,
          qty,
          ownership: z.enum(['OWNED', 'CUSTOMER_OWNED']),
        })
      )
      .min(1)
      .max(100),
    notes: z.string().trim().max(4000).default(''),
  })
  .superRefine((s, ctx) => {
    const unique = (keys: string[], field: string) => {
      if (new Set(keys).size !== keys.length)
        ctx.addIssue({ code: 'custom', path: [field], message: 'Each choice must appear once' })
    }
    unique(
      s.sizes.map((x) => x.sizeId),
      'sizes'
    )
    unique(
      s.stages.map((x) => x.toLowerCase()),
      'stages'
    )
    unique(
      s.materials.map((x) => [x.itemId, x.warehouseId, x.ownership].join('|')),
      'materials'
    )
    unique(
      s.measurements.map((x) => [x.name.toLowerCase(), x.sizeId].join('|')),
      'measurements'
    )
    if (s.stages[0].toLowerCase() !== 'cutting')
      ctx.addIssue({
        code: 'custom',
        path: ['stages'],
        message: 'The making route must start with Cutting',
      })
    if (!s.stages.some((x) => x.toLowerCase() === 'stitching'))
      ctx.addIssue({ code: 'custom', path: ['stages'], message: 'Include Stitching on the route' })
    if (s.measurements.some((x) => !s.sizes.some((z) => z.sizeId === x.sizeId)))
      ctx.addIssue({
        code: 'custom',
        path: ['measurements'],
        message: 'Measurements must use the sample sizes',
      })
    if (s.sizes.some((x) => !s.measurements.some((z) => z.sizeId === x.sizeId)))
      ctx.addIssue({
        code: 'custom',
        path: ['measurements'],
        message: 'Add measurements for every sample size',
      })
  })
export const createSampleSchema = z.object({
  clientKey: z.string().uuid(),
  title: text(150),
  customerId: id.nullable(),
  brandId: id,
  buyerRef: z.string().trim().max(150).default(''),
  owner: text(100),
  brief: text(4000),
  requiredAt: z.string().date().nullable(),
})
export const updateSampleRequestSchema = createSampleSchema
  .omit({ clientKey: true })
  .extend({
    reason: text(500),
  })
  .strict()
export const sampleActionSchema = z.object({
  version: z.number().int().min(0),
  roundId: id.optional(),
  action: z.enum([
    'SAVE_DRAFT',
    'UPDATE_REQUEST',
    'SAVE_SPEC',
    'RELEASE',
    'MATERIAL',
    'STAGE',
    'QC',
    'SUBMIT',
    'DECIDE',
    'NEW_ROUND',
    'HANDOVER',
    'ACCEPT_HANDOVER',
    'CANCEL',
  ]),
  data: z.unknown(),
})
export const sampleMaterialSchema = z.object({
  materialId: id,
  kind: z.enum(['ISSUE', 'RETURN', 'USE', 'WASTE']),
  qty,
  reason: text(500),
})
export const sampleStageSchema = z.object({
  stageId: id,
  doneQty: z.number().int().min(0),
  rejectedQty: z.number().int().min(0),
  responsible: text(100),
  reference: z.string().trim().max(300).default(''),
  notes: text(1000),
})
export const sampleQcSchema = z.object({
  actuals: z.array(z.number().min(0).max(10000)).max(200),
  passedQty: z.number().int().positive(),
  notes: text(2000),
})
export const sampleSubmissionSchema = z.object({
  qty: z.number().int().positive(),
  recipient: text(150),
  reference: text(500),
  notes: text(2000),
})
export const sampleDecisionSchema = z.object({
  result: z.enum(['APPROVED', 'CHANGES_REQUIRED', 'REJECTED']),
  buyerName: text(150),
  evidence: text(2000),
  conditions: z.string().trim().max(2000).default(''),
})
export const sampleHandoverSchema = z.object({ bomId: id, routingId: id, notes: text(2000) })
