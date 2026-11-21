import { z } from 'zod'
import {
  PROCESS_KINDS,
  SAMPLE_ATTACHMENT_KINDS,
  SAMPLE_CLOSEOUT_KINDS,
  SAMPLE_REASON_MIN,
  SAMPLE_MATERIAL_SOURCES,
  SAMPLE_MEASURE_MAX_ENTRIES,
  SAMPLE_MEASURE_MAX_POINTS,
  SAMPLE_ROUTE_MAX_STEPS,
  SAMPLE_ROUTE_MIN_STEPS,
  STEP_EXECUTIONS,
  SAMPLE_MONEY_MAX,
  SAMPLE_DECISION_RESULTS,
  SAMPLE_DISPATCH_MODES,
  SAMPLE_CHARGE_KINDS,
} from '@ld-erp/shared'
import { MAX_FILE_BYTES } from '../lib/storage'
const text = (max = 500) => z.string().trim().min(1, 'Fill in this field').max(max)
// Optional words from the tech pack. Left out on an edit means unchanged; an
// empty box is saved as nothing.
const optionalText = (max: number) =>
  z.string().trim().max(max, `Keep this to ${max} characters`).nullable().optional()
const id = text(100)
const qty = z.number().positive().max(999999).multipleOf(0.001)
// Drafts keep the same JSON shape as released specifications. Blank values and
// unfinished rows are allowed; bounds and any supplied master IDs remain checked.
const draftText = (max: number) => z.string().trim().max(max, `Keep this to ${max} characters`)
// A link that may be empty: a blank box is no link.
const optionalLink = draftText(100)
  .nullable()
  .default(null)
  .transform((v) => v || null)

/** One colour of the round and its pieces by size. */
const colourRow = z.object({
  colour: draftText(50),
  sizes: z
    .array(
      z.object({
        sizeId: draftText(100),
        qty: z
          .number()
          .int('Pieces are whole numbers')
          .min(0, 'Pieces cannot be negative')
          .max(1000, 'Up to 1000 pieces of one size'),
      })
    )
    .max(30, 'Up to 30 sizes in one colour'),
})
const measurement = z.object({
  name: draftText(100),
  sizeId: draftText(100),
  target: z.number().min(0).max(10000),
  tolerance: z.number().min(0).max(100),
  unit: z.enum(['cm', 'in']),
})
/**
 * A step of the making route. Name, kind and department follow the process
 * when left out. The name may be as long as the process's own (the Operation
 * master's 200), which fills it; the instructions as long as a routing step's
 * (500), which the route becomes at handover.
 */
const routeStep = z.object({
  operationId: draftText(100),
  name: draftText(200).default(''),
  kind: z.enum(PROCESS_KINDS).default('OTHER'),
  departmentId: draftText(100).default(''),
  execution: z
    .enum(STEP_EXECUTIONS, {
      errorMap: () => ({ message: 'Say whether the step is done here or outside' }),
    })
    .default('IN_HOUSE'),
  contractorId: optionalLink,
  vendorId: optionalLink,
  instructions: draftText(500).default(''),
})
/**
 * A line of the sample BOM, as the screen sends it. requiredQty counts only
 * when overridden. The part is kept to the production BOM's own 60, as the
 * line becomes one at handover.
 */
const bomLine = z.object({
  id: draftText(100).optional(),
  component: draftText(60).default(''),
  itemId: draftText(100).default(''),
  colour: draftText(50)
    .nullable()
    .default(null)
    .transform((v) => v || null),
  departmentId: optionalLink,
  qtyPerPiece: z
    .number()
    .min(0, 'A quantity cannot be negative')
    .max(99999)
    .multipleOf(0.0001, 'Up to 4 decimal places')
    .default(0),
  wastagePct: z
    .number()
    .min(0, 'Wastage cannot be negative')
    .max(100, 'Wastage is at most 100%')
    .multipleOf(0.01, 'Up to 2 decimal places')
    .default(0),
  requiredQty: z
    .number()
    .min(0, 'A quantity cannot be negative')
    .max(999999)
    .multipleOf(0.001, 'Up to 3 decimal places')
    .default(0),
  requiredOverride: z.boolean().default(false),
  overrideReason: draftText(500).default(''),
  source: z
    .enum(SAMPLE_MATERIAL_SOURCES, {
      errorMap: () => ({ message: 'Say whether we buy it or the buyer sends it' }),
    })
    .default('PURCHASE'),
  estRate: z
    .number()
    .min(0, 'A rate cannot be negative')
    .max(999999)
    .multipleOf(0.0001, 'Up to 4 decimal places')
    .nullable()
    .default(null),
  remarks: draftText(500).default(''),
})
// One target per point per size: the matrix's points times the sizes made.
const measurementList = z
  .array(measurement)
  .max(
    SAMPLE_MEASURE_MAX_ENTRIES,
    `Up to ${SAMPLE_MEASURE_MAX_ENTRIES} measurement targets in one round (points × sizes). Use fewer points or sizes.`
  )
// The matrix's points, however many sizes each is measured in.
const pointsWithin = (list: Array<{ name: string }>) =>
  new Set(list.map((m) => m.name.trim().toLowerCase())).size <= SAMPLE_MEASURE_MAX_POINTS
const POINTS_LIMIT = `Up to ${SAMPLE_MEASURE_MAX_POINTS} measurement points in one round.`
const specFields = {
  milestone: draftText(80),
  styleId: draftText(100),
  construction: draftText(4000),
  techPackRef: draftText(1000),
  patternRef: draftText(1000),
  colours: z.array(colourRow).max(30, 'Up to 30 colours in one round'),
  measurements: measurementList.refine(pointsWithin, POINTS_LIMIT),
  route: z
    .array(routeStep)
    .max(
      SAMPLE_ROUTE_MAX_STEPS,
      `The making route can have up to ${SAMPLE_ROUTE_MAX_STEPS} steps.`
    ),
  materials: z.array(bomLine).max(100, 'Up to 100 material lines'),
  notes: draftText(4000),
}
export const sampleDraftSchema = z.object(specFields).strict()
export const sampleDraftPatchSchema = sampleDraftSchema.partial()
/**
 * A complete specification, for SAVE_SPEC and RELEASE: the same shape with the
 * round's own details filled in and every list started. What each row still
 * lacks, and how the rows fit together, is sampleSpecGaps (packages/shared),
 * the same list the screen shows before release.
 */
export const sampleSpecificationSchema = z
  .object({
    ...specFields,
    milestone: text(80),
    styleId: id,
    construction: text(4000),
    techPackRef: text(1000),
    patternRef: text(1000),
    colours: specFields.colours.min(1, 'Add at least one colour to make.'),
    measurements: measurementList
      .min(1, 'Add at least one measurement point.')
      .refine(pointsWithin, POINTS_LIMIT),
    route: specFields.route.min(
      SAMPLE_ROUTE_MIN_STEPS,
      'The making route needs at least two steps, starting with cutting.'
    ),
    materials: specFields.materials.min(1, 'Add the materials the sample needs.'),
    notes: draftText(4000).default(''),
  })
  .strict()
export const createSampleSchema = z.object({
  clientKey: z.string().uuid(),
  title: text(150),
  customerId: id.nullable(),
  brandId: id,
  buyerRef: z.string().trim().max(150).default(''),
  owner: text(100),
  brief: text(4000),
  requiredAt: z.string().date().nullable(),
  buyerStyleRef: optionalText(100),
  season: optionalText(50),
  garmentCategory: optionalText(100),
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
    'STEP_WORK',
    'STEP_SEND',
    'STEP_RECEIVE',
    'JOB_SEND',
    'JOB_RETURN',
    'STEP_LABOUR',
    'JOB_CHARGE',
    'MAKING_UNDO',
    'QC',
    'DISPATCH',
    'DISPATCH_CANCEL',
    'DECIDE',
    'DROP_COLOUR',
    'ADD_CHARGE',
    'REMOVE_CHARGE',
    'DISPATCH_CHARGE',
    'FINALISE_COST',
    'REOPEN_COST',
    'NEW_ROUND',
    'HANDOVER',
    'ACCEPT_HANDOVER',
    'CANCEL',
    'ATTACH',
    'DETACH',
    'CREATE_STYLE',
    'LINK_STYLE',
    'UPDATE_STYLE',
    'WAIVE_MATERIAL',
    'CLOSE_MATERIAL',
  ]),
  data: z.unknown(),
})
export const sampleMaterialSchema = z.object({
  materialId: id,
  kind: z.enum(['ISSUE', 'RETURN', 'USE', 'WASTE']),
  qty,
  reason: text(500),
  // The store it is issued from, needed at the first issue only: the line
  // keeps it, and every later issue and return goes through it.
  warehouseId: id.optional(),
})
/** A line not needed after all, or needed again (undo). */
export const sampleWaiveSchema = z
  .object({
    materialId: id,
    reason: z.string().trim().max(500).default(''),
    undo: z.boolean().default(false),
  })
  .strict()
  .refine((d) => d.undo || d.reason.length >= SAMPLE_REASON_MIN, {
    message: 'Say why this line is not needed — a few words is enough',
    path: ['reason'],
  })
/** Leftover material in a sample store closed out: used in the sample, or moved to a general store. */
export const sampleCloseOutSchema = z
  .object({
    itemId: id,
    warehouseId: id,
    qty,
    kind: z.enum(SAMPLE_CLOSEOUT_KINDS, {
      errorMap: () => ({ message: 'Say whether it was used in the sample or moved to a general store' }),
    }),
    toWarehouseId: id.nullable().optional(),
    reason: z.string().trim().min(SAMPLE_REASON_MIN, 'Say why, in a few words').max(500),
  })
  .strict()
  .refine((d) => d.kind !== 'MOVED' || !!d.toWarehouseId, {
    message: 'Pick the general store it goes to',
    path: ['toWarehouseId'],
  })
// ── Making, cell by cell (phase 5) ────────────────────────────────────────────
//
// A cell is one colour and size of the round's grid, named as the grid names
// it; the server matches the colour as the grid compares colours. Pieces are
// whole numbers. A date left out is today; the server refuses one still to come.
const pieces = z
  .number()
  .int('Pieces are whole numbers')
  .min(0, 'Pieces cannot be negative')
  .max(100000, 'That is more pieces than a sample has')
// As long as any round's colour may be: rounds of the first pilot took 100.
const cell = { colour: text(100), sizeId: id }
const qtyCell = z.object({ ...cell, qty: pieces }).strict()
const MAX_CELLS = 900
const qtyCells = z.array(qtyCell).min(1, 'Say how many pieces').max(MAX_CELLS)
const person = text(100)
const day = z.string().date('Give the date as a date').optional()
const note = (max: number) => z.string().trim().max(max, `Keep this to ${max} characters`).default('')
/** Rupees, to the paisa. */
const money = z
  .number()
  .min(0, 'An amount cannot be negative')
  .max(SAMPLE_MONEY_MAX, 'That amount is too large')
  .multipleOf(0.01, 'Rupees to two places of paise')
/** Work at a step on our own floor: done and rejected, cell by cell. */
export const sampleWorkSchema = z
  .object({
    stageId: id,
    cells: z
      .array(z.object({ ...cell, done: pieces, rejected: pieces }).strict())
      .min(1, 'Say how many pieces')
      .max(MAX_CELLS),
    doneBy: person,
    workedOn: day,
    notes: note(1000),
  })
  .strict()
/** Done pieces handed on to the next step on our floor. */
export const sampleSendSchema = z
  .object({ fromStageId: id, cells: qtyCells, sentBy: person, sentOn: day, notes: note(500) })
  .strict()
/** Pieces counted in from the step before: a cell left out came to nothing. */
export const sampleReceiveSchema = z
  .object({
    transferId: id,
    cells: z.array(qtyCell).max(MAX_CELLS),
    receivedBy: person,
    receivedOn: day,
    shortReason: note(500),
  })
  .strict()
/** Pieces given to a step's outside unit on a job-work challan. */
export const sampleJobSendSchema = z
  .object({
    stageId: id,
    vendorId: id,
    cells: qtyCells,
    sentBy: person,
    sentOn: day,
    expectedBack: z.string().date('Give the date as a date').nullable().default(null),
    vehicleNo: note(30),
    declaredValue: money.nullable().default(null),
    notes: note(500),
  })
  .strict()
/** What came back on a challan, accepted and rejected, and what the unit charged. */
export const sampleJobReturnSchema = z
  .object({
    jobWorkId: id,
    cells: z
      .array(z.object({ ...cell, accepted: pieces, rejected: pieces }).strict())
      .min(1, 'Say how many pieces')
      .max(MAX_CELLS),
    receivedBy: person,
    receivedOn: day,
    theirChallanNo: note(50),
    chargeAmount: money.default(0),
    notes: note(1000),
  })
  .strict()
// ── What a sample cost (phase 7) ──────────────────────────────────────────────
/** A cost besides material, labour and outside units: testing, pattern, a setup, a courier. */
export const sampleChargeSchema = z
  .object({
    /** The round it was for; none: the request as a whole. */
    roundId: id.nullable().default(null),
    kind: z.enum(SAMPLE_CHARGE_KINDS, {
      errorMap: () => ({ message: 'Say what the charge is for' }),
    }),
    description: text(300),
    amount: money.refine((v) => v > 0, 'Give the amount'),
    billRef: note(100),
    chargedOn: day,
  })
  .strict()
export const sampleChargeRemoveSchema = z
  .object({
    chargeId: id,
    reason: z.string().trim().min(SAMPLE_REASON_MIN, 'Say why, in a few words').max(500),
  })
  .strict()
/** What sending a challan cost, put right once the courier's bill is known. */
export const sampleDispatchChargeSchema = z
  .object({ dispatchId: id, courierCharge: money, reason: note(300) })
  .strict()
/** The costs finalised: the sheet as it stands, kept, and nothing that costs changes after. */
export const sampleFinaliseCostSchema = z.object({ notes: note(1000) }).strict()
export const sampleReopenCostSchema = z
  .object({ reason: z.string().trim().min(SAMPLE_REASON_MIN, 'Say why, in a few words').max(500) })
  .strict()
/** A unit's charge on one receipt, put right once its bill is known; the pieces stay as they are. */
export const sampleJobChargeSchema = z
  .object({ returnId: id, chargeAmount: money, reason: note(300) })
  .strict()
/** A step's labour, as the merchandiser has it (₹). */
export const sampleLabourSchema = z
  .object({ stageId: id, amount: money, note: note(300) })
  .strict()
/** A making record taken back: entered by mistake. */
export const sampleMakingUndoSchema = z
  .object({
    kind: z.enum(['WORK', 'TRANSFER', 'JOB_SEND', 'JOB_RETURN']),
    id,
    reason: z.string().trim().min(SAMPLE_REASON_MIN, 'Say why, in a few words').max(500),
  })
  .strict()
// ── QC, the buyer's samples and the buyer's word, colour by colour (phase 6) ──
/**
 * One inspection of the finished round: for each colour that finished
 * pieces, a reading for each point of each size it finished (in the
 * specification's order), and the pieces of each size that passed workmanship.
 */
export const sampleQcSchema = z
  .object({
    colours: z
      .array(
        z
          .object({
            colour: text(100),
            actuals: z
              .array(z.number().min(0, 'A reading cannot be negative').max(10000))
              .max(SAMPLE_MEASURE_MAX_ENTRIES, `Up to ${SAMPLE_MEASURE_MAX_ENTRIES} readings for one colour.`),
            cells: z.array(z.object({ sizeId: id, passed: pieces }).strict()).max(MAX_CELLS),
            notes: note(1000),
          })
          .strict()
      )
      // None only when nothing finished: the inspection then records that.
      .max(MAX_CELLS),
    notes: text(2000),
  })
  .strict()
/** Pieces that passed QC sent to the buyer on a Sample Delivery Challan. */
export const sampleDispatchSchema = z
  .object({
    cells: qtyCells,
    recipient: text(150),
    address: note(500),
    mode: z.enum(SAMPLE_DISPATCH_MODES, {
      errorMap: () => ({ message: 'Say how it goes: courier, by hand or transport' }),
    }),
    courier: note(100),
    awb: note(60),
    sentOn: day,
    returnable: z.boolean().default(false),
    expectedBack: z.string().date('Give the date as a date').nullable().default(null),
    declaredValue: money.nullable().default(null),
    courierCharge: money.default(0),
    notes: note(1000),
  })
  .strict()
  .refine((d) => d.mode !== 'COURIER' || !!d.courier, {
    message: 'Name the courier',
    path: ['courier'],
  })
  .refine((d) => d.returnable || !d.expectedBack, {
    message: 'A date to come back is for samples the buyer returns',
    path: ['expectedBack'],
  })
/** A colour not to go on with: not sent, or failed QC and not to be made again. */
export const sampleDropColourSchema = z
  .object({
    colour: text(100),
    reason: z.string().trim().min(SAMPLE_REASON_MIN, 'Say why, in a few words').max(500),
  })
  .strict()
/** A challan sent by mistake, before the buyer has decided on any of its colours. */
export const sampleDispatchCancelSchema = z
  .object({
    dispatchId: id,
    reason: z.string().trim().min(SAMPLE_REASON_MIN, 'Say why, in a few words').max(500),
  })
  .strict()
/** The buyer's word on one or more colours, with who said it and where. */
export const sampleDecisionSchema = z
  .object({
    buyerName: text(150),
    evidence: text(2000),
    colours: z
      .array(
        z
          .object({
            colour: text(100),
            result: z.enum(SAMPLE_DECISION_RESULTS),
            conditions: note(2000),
          })
          .strict()
      )
      .min(1, 'Record the buyer’s word on at least one colour')
      .max(200),
  })
  .strict()
export const sampleHandoverSchema = z.object({ bomId: id, routingId: id, notes: text(2000) })

// ── Files and the request's style ─────────────────────────────────────────────
export const sampleAttachmentKindSchema = z.enum(SAMPLE_ATTACHMENT_KINDS, {
  errorMap: () => ({
    message: 'Say what the file is: tech pack, pattern, photo, approval, dispatch slip or other',
  }),
})
/** Step one of a file: the link to send it to. Kind is optional so the shared file box can ask unchanged. */
export const sampleUploadUrlSchema = z.object({
  fileName: z.string().trim().min(1, 'The file needs a name').max(255),
  sizeBytes: z
    .number()
    .int()
    .positive('That file is empty')
    .max(MAX_FILE_BYTES, `Files have to be ${MAX_FILE_BYTES / 1024 / 1024}MB or smaller`),
  kind: sampleAttachmentKindSchema.optional(),
  roundId: id.nullable().optional(),
})
/** Step three: the file is in storage, so it is filed against the request. */
export const sampleAttachSchema = z
  .object({
    fileName: z.string().trim().min(1, 'The file needs a name').max(255),
    storagePath: z.string().min(1).max(1024),
    kind: sampleAttachmentKindSchema,
    roundId: id.nullable().optional(),
  })
  .strict()
export const sampleDetachSchema = z.object({ attachmentId: id, reason: text(500) }).strict()
export const sampleAttachmentListSchema = z.object({
  // 'none' lists only the files of the whole request.
  roundId: z.string().trim().max(100).optional(),
  kind: sampleAttachmentKindSchema.optional(),
})
// The same rules the Styles master has for colours: each once, however it is capitalised.
const styleColors = z
  .array(z.string().trim().min(1, 'A colour needs a name').max(50))
  .min(1, 'Add at least one colour')
  .max(30, 'A style can have up to 30 colours')
  .refine(
    (list) => new Set(list.map((c) => c.toLowerCase())).size === list.length,
    'A colour is listed twice. Each colour once, however it is capitalised.'
  )
export const sampleCreateStyleSchema = z
  .object({
    name: text(200),
    category: optionalText(100),
    sizeGroupId: id,
    colors: styleColors,
    season: optionalText(50),
  })
  .strict()
/** Null takes the style off the request, so a draft can move to another brand. */
export const sampleLinkStyleSchema = z.object({ styleId: id.nullable() }).strict()
export const sampleUpdateStyleSchema = z
  .object({
    name: text(200).optional(),
    category: optionalText(100),
    colors: styleColors.optional(),
    sizeGroupId: id.optional(),
    season: optionalText(50),
  })
  .strict()
  .refine(
    (d) => Object.values(d).some((v) => v !== undefined),
    'Change at least one detail of the style'
  )

// ── The sample BOM's item picker ─────────────────────────────────────────────
export const sampleItemSearchSchema = z.object({
  q: z.string().trim().max(100, 'Keep the search to 100 characters').default(''),
  limit: z.coerce.number().int().min(1).max(50).default(20),
})
