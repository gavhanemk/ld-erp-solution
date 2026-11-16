import type { Prisma } from '@prisma/client'
import type { z } from 'zod'
import { AppError } from '../middleware/errorHandler'
import { userCan, type AuthRequest } from '../middleware/auth'
import { nextDocumentNumber } from '../lib/docNumber'
import { CODE_ATTEMPTS, nextStyleCode } from '../lib/masterCode'
import { MAX_FILE_BYTES, MAX_FILES_PER_DOCUMENT, removeObject, statObject } from '../lib/storage'
import { recordMovement } from './stock.service'
import { routingProblem } from './route.service'
import {
  SAMPLE_ATTACHMENT_KIND_LABEL,
  type SampleAttachmentKind,
  type SampleSpecification,
} from '../../../../packages/shared/src/sampling'
import {
  createSampleSchema,
  sampleAttachSchema,
  sampleCreateStyleSchema,
  sampleDetachSchema,
  sampleLinkStyleSchema,
  sampleUpdateStyleSchema,
  sampleActionSchema,
  sampleSpecificationSchema,
  sampleMaterialSchema,
  sampleStageSchema,
  sampleQcSchema,
  sampleSubmissionSchema,
  sampleDecisionSchema,
  sampleHandoverSchema,
  sampleDraftSchema,
  sampleDraftPatchSchema,
  updateSampleRequestSchema,
} from '../schemas/sampling.schemas'

type Tx = Prisma.TransactionClient
type Actor = NonNullable<AuthRequest['user']>
function fail(message: string, code = 'SAMPLE_RULE'): never {
  throw new AppError(message, 409, code)
}
const json = (value: unknown) => JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue
const n = (v: unknown) => Number(v)
const round3 = (v: number) => Math.round(v * 1000) / 1000
const round2 = (v: number) => Math.round(v * 100) / 100
/** Every sample file sits under samples/<request id>/, which is how a registered path is checked. */
export const SAMPLE_FILE_FOLDER = 'samples'
export const sampleStyleSelect = {
  id: true,
  code: true,
  name: true,
  stage: true,
  brandId: true,
  category: true,
  season: true,
  sizeGroupId: true,
  colors: true,
  isActive: true,
} satisfies Prisma.StyleSelect
export const sampleInclude = {
  customer: { select: { id: true, name: true } },
  brand: { select: { id: true, name: true } },
  style: { select: sampleStyleSelect },
  rounds: {
    orderBy: { revision: 'desc' as const },
    include: {
      stages: { orderBy: { sequence: 'asc' as const } },
      materials: {
        include: {
          item: { select: { name: true, code: true, uom: { select: { symbol: true } } } },
          warehouse: { select: { name: true } },
        },
      },
    },
  },
  events: { orderBy: { version: 'desc' as const } },
  attachments: {
    orderBy: { createdAt: 'asc' as const },
    include: { uploadedBy: { select: { id: true, name: true } } },
  },
} satisfies Prisma.SampleRequestInclude
export async function sampleDetail(tx: Tx, id: string) {
  const row = await tx.sampleRequest.findUnique({ where: { id }, include: sampleInclude })
  if (!row) throw new AppError('Sample request not found', 404, 'NOT_FOUND')
  return row
}
function grant(actor: Actor, module: string, action: string) {
  if (!userCan(actor, module, action))
    throw new AppError(`You need ${module} ${action} permission for this action.`, 403, 'FORBIDDEN')
}
async function event(
  tx: Tx,
  id: string,
  version: number,
  action: string,
  actor: Actor,
  detail: unknown
) {
  const latest = await tx.sampleRound.findFirstOrThrow({
    where: { requestId: id },
    orderBy: { revision: 'desc' },
    select: { state: true },
  })
  await tx.sampleRequest.update({
    where: { id },
    data: { version: version + 1, state: action === 'CANCEL' ? 'CANCELLED' : latest.state },
  })
  await tx.sampleEvent.create({
    data: {
      requestId: id,
      version: version + 1,
      action,
      actorId: actor.id,
      detail: json({ ...Object(detail), by: actor.name }),
    },
  })
}
export async function createSample(tx: Tx, data: z.infer<typeof createSampleSchema>, actor: Actor) {
  const old = await tx.sampleRequest.findUnique({ where: { clientKey: data.clientKey } })
  if (old) return sampleDetail(tx, old.id)
  const brand = await tx.brand.findFirst({ where: { id: data.brandId, isActive: true } })
  if (!brand) fail('Pick an active brand.')
  if (
    data.customerId &&
    !(await tx.customer.findFirst({ where: { id: data.customerId, isActive: true } }))
  )
    fail('Pick an active buyer.')
  const number = await nextDocumentNumber(tx, 'SAMPLE')
  const request = await tx.sampleRequest.create({
    data: {
      ...data,
      requiredAt: data.requiredAt ? new Date(data.requiredAt) : null,
      buyerStyleRef: data.buyerStyleRef || null,
      season: data.season || null,
      garmentCategory: data.garmentCategory || null,
      number,
      createdById: actor.id,
    },
  })
  await tx.sampleRound.create({
    data: {
      requestId: request.id,
      revision: 1,
      specification: {
        milestone: 'Development sample',
        styleId: '',
        color: '',
        construction: '',
        techPackRef: '',
        patternRef: '',
        sizes: [],
        measurements: [],
        stages: ['Cutting', 'Stitching', 'Finishing'],
        materials: [],
        notes: '',
      },
    },
  })
  await event(tx, request.id, 0, 'CREATE', actor, { number })
  return sampleDetail(tx, request.id)
}
async function validateSpec(
  tx: Tx,
  s: SampleSpecification,
  owner: { brandId: string; customerId: string | null; styleId: string | null },
  draft = false
) {
  const { brandId, customerId } = owner
  // Once the request has its style, every round samples that style; another
  // style is another request.
  if (owner.styleId && s.styleId && s.styleId !== owner.styleId)
    fail(
      'A round samples the request’s own style. Change the request’s style first to sample another.',
      'NOT_REQUEST_STYLE'
    )
  const style = s.styleId
    ? await tx.style.findFirst({
        where: { id: s.styleId, isActive: true },
        include: { sizeGroup: { include: { sizes: true } } },
      })
    : null
  if ((!draft || s.styleId) && !style) fail('Pick an active style.')
  if (style && style.brandId !== brandId)
    fail(
      'The style must belong to this request’s brand. Clear the draft style before changing the brand.'
    )
  if (s.color && (!style || !style.colors.some((c) => c.toLowerCase() === s.color.toLowerCase())))
    fail('Choose one of the style’s colours.')
  const sizeIds = new Set(style?.sizeGroup?.sizes.map((x) => x.id) ?? [])
  if (
    s.sizes.some((x) => (!draft || x.sizeId) && !sizeIds.has(x.sizeId)) ||
    s.measurements.some((x) => x.sizeId && !sizeIds.has(x.sizeId))
  )
    fail('Every sample size must belong to the style’s size run.')
  for (const m of s.materials) {
    const item = m.itemId
      ? await tx.item.findFirst({ where: { id: m.itemId, isActive: true } })
      : null
    if (
      (!draft || m.itemId) &&
      (!item || !['RAW_MATERIAL', 'TRIM', 'PACKING_MATERIAL', 'CONSUMABLE'].includes(item.type))
    )
      fail('Choose active materials, trims, packing or consumables.')
    if (
      (!draft || m.warehouseId) &&
      !(await tx.warehouse.findFirst({ where: { id: m.warehouseId, isActive: true } }))
    )
      fail('Pick an active store.')
    if (!draft && m.ownership === 'CUSTOMER_OWNED' && !customerId)
      fail('Buyer-owned material requires a buyer on the request.')
  }
}
function held(m: {
  issuedQty: unknown
  returnedQty: unknown
  usedQty: unknown
  wasteQty: unknown
}) {
  return round3(n(m.issuedQty) - n(m.returnedQty) - n(m.usedQty) - n(m.wasteQty))
}
type RoundState = { id: string; revision: number; state: string; releasedAt: Date | null }
const released = (x: RoundState) => !!x.releasedAt || x.state !== 'DRAFT'
/** Whether any round has left draft: from then on buyer, brand and style are history. */
function everReleased(request: { rounds: RoundState[] }) {
  return request.rounds.some(released)
}
/**
 * The style the first released round was made in, or ''. A request released
 * before requests named their own style has only this to say which it samples.
 */
function releasedStyleId(request: { rounds: Array<RoundState & { specification: unknown }> }) {
  const first = request.rounds.filter(released).sort((a, b) => a.revision - b.revision)[0]
  return first ? String((first.specification as SampleSpecification).styleId ?? '') : ''
}
const STYLE_FIXED =
  'The style is fixed once a round has been released, as the buyer and brand are. Raise a new request to sample another style.'

/**
 * Why a file can no longer be taken off the request, or null while it can.
 *
 * What a round was made and judged from is the files it had when it was
 * released, and the tech pack a release followed; those stay. A file added
 * after the release it would belong to (a photo of the finished sample, a
 * wrong upload) was no part of it, so it can still be removed, with a reason,
 * until the request is cancelled or handed over. Locking every file the
 * moment it landed made a wrong photo permanent and, with five a kind, could
 * fill a round for good. A newer version of a kept file is added beside it.
 * The file list and DETACH both ask here, so the screen and the rule agree.
 */
export function attachmentLock(
  request: { cancelledAt: Date | null; rounds: Array<RoundState & { handover: unknown }> },
  file: { roundId: string | null; kind: string; createdAt: Date }
): string | null {
  if (request.cancelledAt) return 'This request is cancelled; its files are kept with it.'
  if (request.rounds.some((x) => x.handover))
    return 'This request has a production handover; its files are kept with it.'
  // Out of draft but with no release time: from before the time was kept, so
  // nobody can say the file came later, and it stays.
  const releasedWith = (round: RoundState) =>
    round.releasedAt ? file.createdAt <= round.releasedAt : round.state !== 'DRAFT'
  const round = file.roundId ? request.rounds.find((x) => x.id === file.roundId) : undefined
  if (round && releasedWith(round))
    return `Round ${round.revision} was released with this file, so it is kept as the record of what was made.`
  // A tech pack is the request's, not one round's: kept once any round has
  // been released on it, so a newer one added before round 2 is kept by it.
  if (!file.roundId && file.kind === 'TECH_PACK' && request.rounds.some(releasedWith))
    return 'A round has been released on this tech pack, so it is kept. Add the newer version beside it instead.'
  return null
}

/**
 * Why one more file of this kind cannot be filed here, or null while it can.
 *
 * Five of a kind against the whole request, and five against each round: a
 * photo of round 3 must not be refused because rounds 1 and 2 already have
 * theirs, which could never be removed. Upload-url asks first, so nobody
 * sends a file only to be turned away, and ATTACH again under the lock.
 */
export function fileLimitProblem(
  request: {
    number: string
    cancelledAt: Date | null
    rounds: Array<RoundState & { handover: unknown }>
  },
  files: Array<{ roundId: string | null; kind: string; createdAt: Date }>,
  kind: SampleAttachmentKind,
  roundId: string | null
): string | null {
  const here = files.filter((f) => f.kind === kind && (f.roundId ?? null) === roundId)
  if (here.length < MAX_FILES_PER_DOCUMENT) return null
  const round = roundId ? request.rounds.find((x) => x.id === roundId) : undefined
  const where = round ? `Round ${round.revision} of ${request.number}` : request.number
  const what = `${MAX_FILES_PER_DOCUMENT} ${SAMPLE_ATTACHMENT_KIND_LABEL[kind].toLowerCase()} files`
  // "Remove one" only when one can be removed.
  if (here.every((f) => attachmentLock(request, f)))
    return `${where} already has ${what}, kept as the record of what was made. File the new one against ${roundId ? 'the whole request or a later round' : 'the round it is for'}.`
  return `${where} already has ${what}. Remove one before adding another.`
}

/**
 * A stored file's name as upload-url hands it out (storagePathFor: a random
 * part, a dash, the cleaned file name). Nothing else is filed. Cloud storage
 * reads "x.pdf#" or "x.pdf?v=2" as x.pdf, and a Windows disk reads "X.PDF" as
 * x.pdf, so another spelling would put a second row on a kept file, and
 * removing that row would delete the file under the kept one.
 */
const STORED_FILE_NAME = /^[a-z0-9]{1,8}-[A-Za-z0-9_.-]{1,80}$/

/**
 * A draft specification moved onto another style, or off one. What still fits
 * is kept; a colour, size or measurement the new style does not have is
 * cleared, as the specification form clears it when the style is changed.
 */
async function refitDrafts(
  tx: Tx,
  rounds: Array<{ id: string; state: string; specification: unknown }>,
  style: { id: string; colors: string[]; sizeGroupId: string | null } | null
) {
  const drafts = rounds.filter((x) => x.state === 'DRAFT')
  if (!drafts.length) return
  const sizeIds = new Set(
    style?.sizeGroupId
      ? (
          await tx.size.findMany({
            where: { sizeGroupId: style.sizeGroupId },
            select: { id: true },
          })
        ).map((x) => x.id)
      : []
  )
  const fits = (sizeId: string) => !sizeId || sizeIds.has(sizeId)
  for (const draft of drafts) {
    const s = draft.specification as SampleSpecification
    const colour = style?.colors.find((c) => c.toLowerCase() === s.color.trim().toLowerCase())
    const next: SampleSpecification = {
      ...s,
      styleId: style?.id ?? '',
      color: colour ?? '',
      sizes: s.sizes.filter((x) => fits(x.sizeId)),
      measurements: s.measurements.filter((x) => fits(x.sizeId)),
    }
    await tx.sampleRound.update({ where: { id: draft.id }, data: { specification: json(next) } })
  }
}

/** A size run the style can be made in: switched on, with sizes in it. */
async function assertSizeRun(tx: Tx, sizeGroupId: string) {
  const run = await tx.sizeGroup.findFirst({
    where: { id: sizeGroupId, isActive: true },
    select: { _count: { select: { sizes: true } } },
  })
  if (!run) fail('Pick an active size run.')
  if (!run._count.sizes) fail('That size run has no sizes yet. Add its sizes in the masters first.')
}

/*
 * A style's row lock. UPDATE_STYLE takes it to change the style; a release
 * takes it shared, so the colours and size run it checks cannot be changed
 * until it has committed, and a change that would remove a colour then sees
 * the released round. Always taken after the request's own lock.
 */
async function lockStyle(tx: Tx, styleId: string) {
  await tx.$queryRaw`SELECT id FROM ld_erp.styles WHERE id = ${styleId} FOR UPDATE`
}
async function shareStyle(tx: Tx, styleId: string) {
  if (styleId) await tx.$queryRaw`SELECT id FROM ld_erp.styles WHERE id = ${styleId} FOR SHARE`
}
/** Other open requests that sample this style (cancelled ones no longer do). */
function otherRequestsOn(tx: Tx, styleId: string, requestId: string) {
  return tx.sampleRequest.findMany({
    where: { styleId, id: { not: requestId }, cancelledAt: null },
    select: { number: true },
    orderBy: { number: 'asc' },
  })
}

let savepoints = 0
/**
 * The style a request makes for itself, coded the way the Styles master codes
 * one (brand, garment, season, number). It is made inside the request's own
 * transaction, where a clash on the code would otherwise abort everything, so
 * each try is wrapped in a savepoint and the next number is tried instead.
 */
async function createDevelopmentStyle(
  tx: Tx,
  data: {
    name: string
    category: string | null
    season: string | null
    sizeGroupId: string
    colors: string[]
    brandId: string
    brandType: Prisma.StyleCreateInput['brandType']
  }
) {
  for (let attempt = 0; attempt < CODE_ATTEMPTS; attempt++) {
    const code = await nextStyleCode(data, attempt)
    const savepoint = `sample_style_${++savepoints}`
    await tx.$executeRawUnsafe(`SAVEPOINT ${savepoint}`)
    try {
      const style = await tx.style.create({
        data: { ...data, code, stage: 'DEVELOPMENT' },
        select: sampleStyleSelect,
      })
      await tx.$executeRawUnsafe(`RELEASE SAVEPOINT ${savepoint}`)
      return style
    } catch (err) {
      await tx.$executeRawUnsafe(`ROLLBACK TO SAVEPOINT ${savepoint}`)
      await tx.$executeRawUnsafe(`RELEASE SAVEPOINT ${savepoint}`)
      const e = err as { code?: string; meta?: { target?: unknown } }
      if (e?.code !== 'P2002' || !String(e.meta?.target ?? '').includes('code')) throw err
    }
  }
  return fail(
    'Another style took the next code at the same moment. Save again.',
    'STYLE_CODE_TAKEN'
  )
}
const styleFacts = (s: {
  name: string
  category: string | null
  season: string | null
  sizeGroupId: string | null
  colors: string[]
}) => ({
  name: s.name,
  category: s.category,
  season: s.season,
  sizeGroupId: s.sizeGroupId,
  colors: s.colors,
})

/**
 * What the route does once the action has committed: files whose rows went
 * with it, and the audit rows, which name what the action really touched.
 */
export interface SampleAfterCommit {
  removeObjects: string[]
  /** The round the action's event names, which for a file is the file's own round. */
  eventRoundId?: string | null
  /** A style made or changed from the request: a masters record, audited as one. */
  styleAudit?: { action: 'CREATE' | 'UPDATE'; styleId: string; before?: unknown; after: unknown }
}
/** Actions on the request as a whole, which name no round of their own. */
const REQUEST_ACTIONS = [
  'CANCEL',
  'UPDATE_REQUEST',
  'ATTACH',
  'DETACH',
  'CREATE_STYLE',
  'LINK_STYLE',
  'UPDATE_STYLE',
]

/** Parent row lock + expected version serialize all decisions, quantities and retries. */
export async function actOnSample(
  tx: Tx,
  id: string,
  cmd: z.infer<typeof sampleActionSchema>,
  actor: Actor,
  after: SampleAfterCommit = { removeObjects: [] }
) {
  await tx.$queryRaw`SELECT id FROM ld_erp.sample_requests WHERE id = ${id} FOR UPDATE`
  const request = await sampleDetail(tx, id)
  if (request.version !== cmd.version)
    fail('This sample changed in another window. Refresh it before saving.', 'STALE_SAMPLE')
  if (request.cancelledAt) fail('This request is cancelled.')
  const r = request.rounds.find((x) => x.id === cmd.roundId)
  if (
    !REQUEST_ACTIONS.includes(cmd.action) &&
    (!r || (cmd.action !== 'MATERIAL' && request.rounds[0].id !== r.id))
  )
    fail('Only the latest sample round can be changed.')
  const round = r!
  const spec = round?.specification as unknown as SampleSpecification
  const approver = ['RELEASE', 'QC', 'DECIDE', 'HANDOVER', 'CANCEL'].includes(cmd.action)
  grant(actor, 'sampling', approver ? 'approve' : 'edit')
  if (
    ['ATTACH', 'DETACH', 'CREATE_STYLE', 'LINK_STYLE', 'UPDATE_STYLE'].includes(cmd.action) &&
    request.rounds.some((x) => x.handover)
  )
    fail('This request has a production handover. Its details are now frozen.')
  let detail: unknown = cmd.data
  let eventRoundId: string | undefined = round?.id
  const owner = {
    brandId: request.brandId,
    customerId: request.customerId,
    styleId: request.styleId,
  }
  switch (cmd.action) {
    case 'UPDATE_REQUEST': {
      if (request.rounds.some((x) => x.handover))
        fail('This request has a production handover. Its details are now frozen.')
      const { reason, ...d } = updateSampleRequestSchema.parse(cmd.data)
      const identityChanged = d.brandId !== request.brandId || d.customerId !== request.customerId
      if (identityChanged && everReleased(request))
        fail(
          'Buyer and brand are locked after the first release to preserve stock ownership and approval history.'
        )
      if (d.brandId !== request.brandId) {
        // A style belongs to one brand, so the request's style cannot follow it.
        if (request.style)
          fail(
            `${request.style.code} belongs to the current brand. Take the style off the request before changing its brand.`,
            'STYLE_BRAND'
          )
        if (!(await tx.brand.findFirst({ where: { id: d.brandId, isActive: true } })))
          fail('Pick an active brand.')
        for (const draft of request.rounds)
          await validateSpec(
            tx,
            draft.specification as unknown as SampleSpecification,
            { brandId: d.brandId, customerId: d.customerId, styleId: request.styleId },
            true
          )
      }
      if (
        d.customerId !== request.customerId &&
        d.customerId &&
        !(await tx.customer.findFirst({ where: { id: d.customerId, isActive: true } }))
      )
        fail('Pick an active buyer.')
      const before = {
        title: request.title,
        customerId: request.customerId,
        brandId: request.brandId,
        buyerRef: request.buyerRef ?? '',
        owner: request.owner,
        brief: request.brief,
        requiredAt: request.requiredAt?.toISOString().slice(0, 10) ?? null,
        buyerStyleRef: request.buyerStyleRef,
        season: request.season,
        garmentCategory: request.garmentCategory,
      }
      // Tech-pack details left out are unchanged (a screen that does not show
      // them must not wipe them); an emptied box is saved as nothing.
      const next = (value: string | null | undefined, was: string | null) =>
        value === undefined ? was : value || null
      const intake = {
        buyerStyleRef: next(d.buyerStyleRef, request.buyerStyleRef),
        season: next(d.season, request.season),
        garmentCategory: next(d.garmentCategory, request.garmentCategory),
      }
      await tx.sampleRequest.update({
        where: { id },
        data: { ...d, ...intake, requiredAt: d.requiredAt ? new Date(d.requiredAt) : null },
      })
      detail = { reason, before, after: { ...d, ...intake } }
      break
    }
    case 'SAVE_DRAFT': {
      if (round.state !== 'DRAFT')
        fail('Released specifications are frozen. Make a new round to change them.')
      const patch = sampleDraftPatchSchema.parse(cmd.data)
      const s = sampleDraftSchema.parse({ ...spec, ...patch })
      await validateSpec(tx, s, owner, true)
      await tx.sampleRound.update({ where: { id: round.id }, data: { specification: json(s) } })
      detail = { specification: s }
      break
    }
    case 'SAVE_SPEC': {
      if (round.state !== 'DRAFT')
        fail('Released specifications are frozen. Make a new round to change them.')
      const s = sampleSpecificationSchema.parse(cmd.data)
      await shareStyle(tx, s.styleId)
      await validateSpec(tx, s, owner)
      await tx.sampleRound.update({ where: { id: round.id }, data: { specification: json(s) } })
      break
    }
    case 'RELEASE': {
      if (round.state !== 'DRAFT') fail('Only a draft round can be released.')
      const s = sampleSpecificationSchema.parse(
        cmd.data && typeof cmd.data === 'object' && 'styleId' in cmd.data ? cmd.data : spec
      )
      await shareStyle(tx, s.styleId)
      await validateSpec(tx, s, owner)
      await tx.sampleStage.createMany({
        data: s.stages.map((name, i) => ({ roundId: round.id, sequence: i + 1, name })),
      })
      await tx.sampleMaterial.createMany({
        data: s.materials.map((m) => ({
          roundId: round.id,
          itemId: m.itemId,
          warehouseId: m.warehouseId,
          ownership: m.ownership,
          plannedQty: m.qty,
        })),
      })
      await tx.sampleRound.update({
        where: { id: round.id },
        data: {
          state: 'RELEASED',
          specification: json(s),
          releasedAt: new Date(),
          releasedById: actor.id,
        },
      })
      // A request begun before it named its style takes the style its first
      // released round was made in, so every released request says which it is.
      if (!request.styleId)
        await tx.sampleRequest.update({ where: { id }, data: { styleId: s.styleId } })
      detail = {
        revision: round.revision,
        milestone: s.milestone,
        ...(request.styleId ? {} : { styleId: s.styleId }),
      }
      break
    }
    case 'MATERIAL': {
      grant(actor, 'inventory', 'edit')
      if (round.state === 'DRAFT' || round.handover)
        fail('Release the round before issuing material; a handed-over round is frozen.')
      const d = sampleMaterialSchema.parse(cmd.data),
        m = round.materials.find((x) => x.id === d.materialId)
      if (!m) fail('This material is not on the round.')
      const material = m!
      const key = {
        itemId: material.itemId,
        warehouseId: material.warehouseId,
        ownership: material.ownership,
        ownerCustomerId: material.ownership === 'CUSTOMER_OWNED' ? request.customerId : null,
      }
      if (d.kind === 'ISSUE') {
        if (round.state !== 'RELEASED' || round.stages.some((x) => x.completedAt))
          fail('Issue materials before making starts; extra needs require a new round.')
        if (round3(n(material.issuedQty) + d.qty) > n(material.plannedQty))
          fail('Do not issue more than the frozen material plan.')
        const movement = await recordMovement(tx, {
          ...key,
          direction: 'OUT',
          qty: d.qty,
          transactionType: 'ISSUE',
          referenceType: 'SAMPLING',
          referenceId: round.id,
          notes: `${request.number}: ${d.reason}`,
        })
        await tx.sampleMaterial.update({
          where: { id: material.id },
          data: {
            issuedQty: { increment: d.qty },
            issuedValue: { increment: round2(d.qty * movement.unitRate) },
          },
        })
      } else {
        if (d.qty > held(material)) fail('That is more material than this round still holds.')
        if (d.kind === 'RETURN') {
          const rate =
            n(material.issuedQty) > 0 ? n(material.issuedValue) / n(material.issuedQty) : 0
          await recordMovement(tx, {
            ...key,
            direction: 'IN',
            qty: d.qty,
            unitRate: rate,
            transactionType: 'RETURN',
            referenceType: 'SAMPLING',
            referenceId: round.id,
            notes: `${request.number}: ${d.reason}`,
          })
          await tx.sampleMaterial.update({
            where: { id: material.id },
            data: {
              returnedQty: { increment: d.qty },
              returnedValue: { increment: round2(d.qty * rate) },
            },
          })
        } else
          await tx.sampleMaterial.update({
            where: { id: material.id },
            data:
              d.kind === 'USE'
                ? { usedQty: { increment: d.qty } }
                : { wasteQty: { increment: d.qty } },
          })
      }
      detail = { ...d, item: material.item.name }
      break
    }
    case 'STAGE': {
      if (round.state !== 'RELEASED') fail('Only a released round can be worked on.')
      if (round.materials.some((m) => n(m.issuedQty) < n(m.plannedQty)))
        fail('Issue every planned material before making starts.')
      const d = sampleStageSchema.parse(cmd.data),
        stage = round.stages.find((x) => x.id === d.stageId)
      if (!stage || stage.completedAt) fail('That step is missing or already recorded.')
      if (round.stages.some((x) => x.sequence < stage!.sequence && !x.completedAt))
        fail('Complete the preceding step first.')
      if (
        stage!.sequence === 1 &&
        round.materials.some((m) => round3(n(m.issuedQty) - n(m.returnedQty)) < n(m.plannedQty))
      )
        fail('Keep the planned material issued until the first making step is recorded.')
      const input =
        stage!.sequence === 1
          ? spec.sizes.reduce((t, z) => t + z.qty, 0)
          : round.stages.find((x) => x.sequence === stage!.sequence - 1)!.doneQty!
      if (spec.sizes.length > 1 && d.rejectedQty > 0)
        fail(
          'For a partially rejected size set, use separate size rounds so each size stays traceable in this pilot.'
        )
      if (d.doneQty + d.rejectedQty !== input)
        fail(`Done plus rejected must equal the ${input} pieces received by this step.`)
      await tx.sampleStage.update({
        where: { id: stage!.id },
        data: {
          doneQty: d.doneQty,
          rejectedQty: d.rejectedQty,
          responsible: d.responsible,
          reference: d.reference,
          notes: d.notes,
          completedAt: new Date(),
        },
      })
      detail = { ...d, stage: stage!.name }
      break
    }
    case 'QC': {
      if (round.state !== 'RELEASED' || round.stages.some((x) => !x.completedAt))
        fail('Complete the making route before recording QC.')
      const d = sampleQcSchema.parse(cmd.data)
      if (spec.sizes.length > 1 && d.passedQty !== round.stages.at(-1)!.doneQty!)
        fail(
          'Inspect the complete size set; use separate size rounds for partial size rejection in this pilot.'
        )
      if (d.passedQty > round.stages.at(-1)!.doneQty!)
        fail('QC cannot pass more pieces than finishing produced.')
      if (d.actuals.length !== spec.measurements.length)
        fail('Measure every point in the frozen specification.')
      const results = spec.measurements.map((m, i) => ({
        ...m,
        actual: d.actuals[i],
        pass: Math.abs(d.actuals[i] - m.target) <= m.tolerance + 1e-8,
      }))
      const passed = results.every((x) => x.pass)
      await tx.sampleRound.update({
        where: { id: round.id },
        data: {
          qc: json({ ...d, results, passed, by: actor.name, at: new Date() }),
          state: passed ? 'QC_PASSED' : 'RELEASED',
        },
      })
      detail = { ...d, passed }
      break
    }
    case 'SUBMIT': {
      if (round.state !== 'QC_PASSED') fail('Pass internal QC before submitting to the buyer.')
      const d = sampleSubmissionSchema.parse(cmd.data)
      if (spec.sizes.length > 1 && d.qty !== (round.qc as { passedQty: number }).passedQty)
        fail('Submit the complete inspected size set so approval covers every size.')
      if (d.qty > (round.qc as { passedQty: number }).passedQty)
        fail('Do not send more pieces than passed QC.')
      await tx.sampleRound.update({
        where: { id: round.id },
        data: { state: 'SUBMITTED', submission: json({ ...d, at: new Date(), by: actor.name }) },
      })
      break
    }
    case 'DECIDE': {
      if (round.state !== 'SUBMITTED') fail('Only a submitted round can receive a buyer decision.')
      const d = sampleDecisionSchema.parse(cmd.data)
      if (d.result === 'APPROVED' && d.conditions)
        fail(
          'Resolve conditions before approving for bulk. Record Changes required while conditions remain.'
        )
      await tx.sampleRound.update({
        where: { id: round.id },
        data: { state: d.result, decision: json({ ...d, at: new Date(), recordedBy: actor.name }) },
      })
      break
    }
    case 'NEW_ROUND': {
      if (round.handover)
        fail('A handed-over round is frozen; raise a separate request for new development.')
      if (
        !['APPROVED', 'REJECTED', 'CHANGES_REQUIRED'].includes(round.state) &&
        !(round.qc && (round.qc as { passed: boolean }).passed === false)
      )
        fail('Finish the buyer review before beginning another round.')
      const reason = String(cmd.data ?? '').trim()
      if (reason.length < 5 || reason.length > 2000)
        fail('Say why a revision or next milestone is needed (5–2000 characters).')
      if (round.state === 'RELEASED')
        await tx.sampleRound.update({
          where: { id: round.id },
          data: { state: 'CHANGES_REQUIRED' },
        })
      await tx.sampleRound.create({
        data: { requestId: id, revision: round.revision + 1, specification: json(spec) },
      })
      // A request released before requests named their style has none, and
      // the new draft could not be prepared or released without one: it takes
      // the style its rounds were made in, as RELEASE would have given it.
      const made = request.styleId ? '' : releasedStyleId(request)
      const filled =
        made &&
        (await tx.style.findFirst({
          where: { id: made, brandId: request.brandId },
          select: { id: true },
        }))
      if (filled) await tx.sampleRequest.update({ where: { id }, data: { styleId: filled.id } })
      detail = {
        fromRevision: round.revision,
        reason,
        ...(filled ? { styleId: filled.id } : {}),
      }
      break
    }
    case 'HANDOVER': {
      if (round.state !== 'APPROVED' || round.handover)
        fail('Handover requires buyer approval and can only be prepared once.')
      if (request.rounds.some((x) => x.materials.some((m) => held(m) > 0.0005)))
        fail('Account for used, wasted and returned material on every round before handover.')
      const d = sampleHandoverSchema.parse(cmd.data)
      // A style made in sampling has no BOM or route yet and cannot be given
      // one, so the usual "pick a BOM" would send people round in a circle.
      const madeHere = await tx.style.findUnique({
        where: { id: spec.styleId },
        select: { code: true, stage: true },
      })
      if (madeHere?.stage === 'DEVELOPMENT')
        fail(
          `${madeHere.code} is a new style made in sampling. Handing it over to production comes in a later update; keep the approved round as the record.`,
          'STYLE_IN_DEVELOPMENT'
        )
      const bom = await tx.bOM.findFirst({
        where: { id: d.bomId, styleId: spec.styleId, isActive: true, status: 'APPROVED' },
        include: { lines: { include: { sizes: true } } },
      })
      if (!bom || (bom.color && bom.color.toLowerCase() !== spec.color.toLowerCase()))
        fail('Pick an approved production BOM for this style and colour.')
      const routing = await tx.routing.findFirst({
        where: { id: d.routingId, isActive: true },
        include: { steps: { orderBy: { sequence: 'asc' } }, style: { select: { code: true } } },
      })
      const style = await tx.style.findUniqueOrThrow({ where: { id: spec.styleId } })
      if (!routing || routingProblem(routing, [style]))
        fail('Pick an active routing that fits this style.')
      await tx.sampleRound.update({
        where: { id: round.id },
        data: {
          handover: json({
            ...d,
            bomVersion: bom.version,
            bomSnapshot: {
              id: bom.id,
              version: bom.version,
              styleId: bom.styleId,
              color: bom.color,
              baseSizeId: bom.baseSizeId,
              approvedAt: bom.approvedAt,
              materials: bom.lines.map((l) => ({
                itemId: l.componentItemId,
                component: l.component,
                qtyPerUnit: l.qtyPerUnit,
                wastagePercent: l.wastagePercent,
                sizes: l.sizes.map((z) => ({ sizeId: z.sizeId, qtyPerUnit: z.qtyPerUnit })),
              })),
            },
            routingVersion: routing!.version,
            routingSnapshot: {
              id: routing!.id,
              name: routing!.name,
              version: routing!.version,
              steps: routing!.steps.map((x) => ({
                sequence: x.sequence,
                operationId: x.operationId,
                departmentId: x.departmentId,
                workstationId: x.workstationId,
                contractorId: x.contractorId,
                execution: x.execution,
                instructions: x.instructions,
              })),
            },
            specification: spec,
            decision: round.decision,
            preparedBy: actor.name,
            preparedAt: new Date(),
          }),
        },
      })
      break
    }
    case 'ACCEPT_HANDOVER': {
      grant(actor, 'production', 'approve')
      const h = round.handover as Record<string, unknown> | null
      if (!h || h.acceptedAt)
        fail('Prepare a handover first; an accepted handover cannot be accepted again.')
      await tx.sampleRound.update({
        where: { id: round.id },
        data: { handover: json({ ...h, acceptedBy: actor.name, acceptedAt: new Date() }) },
      })
      detail = { acceptedBy: actor.name }
      break
    }
    case 'CANCEL': {
      if (request.rounds.some((x) => x.materials.some((m) => held(m) > 0.0005)))
        fail('Return or account for material held by every round before cancelling.')
      if (request.rounds.some((x) => x.handover))
        fail('This request has a production handover and cannot be cancelled.')
      const reason = String(cmd.data ?? '').trim()
      if (reason.length < 5 || reason.length > 2000)
        fail('Record the reason and disposition of any samples already made (5–2000 characters).')
      await tx.sampleRequest.update({
        where: { id },
        data: { cancelledAt: new Date(), cancelReason: reason },
      })
      detail = { reason }
      break
    }
    case 'ATTACH': {
      // The file is already in storage (upload-url, then the browser sent it);
      // this files it against the request, or one of its rounds.
      const d = sampleAttachSchema.parse(cmd.data)
      const roundId = d.roundId || null
      if (roundId && !request.rounds.some((x) => x.id === roundId))
        fail('That round is not on this request.')
      // A path is handed out for one request only; this stops it being replayed on another.
      const [folder, docId, name, ...rest] = d.storagePath.split('/')
      if (folder !== SAMPLE_FILE_FOLDER || docId !== id || !name || rest.length)
        throw new AppError('That file does not belong to this request', 400, 'WRONG_DOCUMENT')
      if (!STORED_FILE_NAME.test(name))
        throw new AppError(
          'That file location is not one this server hands out. Upload the file again.',
          400,
          'BAD_STORAGE_PATH'
        )
      const kind = d.kind as SampleAttachmentKind
      const full = fileLimitProblem(request, request.attachments, kind, roundId)
      if (full) throw new AppError(full, 409, 'TOO_MANY_FILES')
      // Ignoring capitals, as a Windows disk does: one stored file, one row.
      if (
        await tx.sampleAttachment.findFirst({
          where: { storagePath: { equals: d.storagePath, mode: 'insensitive' } },
          select: { id: true },
        })
      )
        fail('That file is already attached.', 'ALREADY_ATTACHED')
      // The size as storage has it, not as the browser said.
      const { sizeBytes, mimeType } = await statObject(d.storagePath)
      if (sizeBytes > MAX_FILE_BYTES) {
        await removeObject(d.storagePath).catch(() => {})
        throw new AppError(
          `That file is ${(sizeBytes / 1024 / 1024).toFixed(1)}MB. The limit is ${MAX_FILE_BYTES / 1024 / 1024}MB.`,
          400,
          'FILE_TOO_LARGE'
        )
      }
      const file = await tx.sampleAttachment.create({
        data: {
          requestId: id,
          roundId,
          kind,
          fileName: d.fileName,
          storagePath: d.storagePath,
          mimeType,
          sizeBytes,
          uploadedById: actor.id,
          // By the same clock as releasedAt: the two are compared to tell a
          // file a round was released with from one added after it.
          createdAt: new Date(),
        },
      })
      detail = {
        attachmentId: file.id,
        storagePath: file.storagePath,
        fileName: file.fileName,
        mimeType,
        sizeBytes,
        kind,
        roundId,
      }
      eventRoundId = roundId ?? undefined
      break
    }
    case 'DETACH': {
      const d = sampleDetachSchema.parse(cmd.data)
      const file = request.attachments.find((x) => x.id === d.attachmentId)
      if (!file) throw new AppError('That file is no longer on this request.', 404, 'NOT_FOUND')
      const kept = attachmentLock(request, file)
      if (kept) fail(kept, 'FILE_KEPT')
      // The row goes with this transaction; the file itself only once it has
      // committed. A row pointing at a missing file is a broken download; a
      // file with no row merely wastes space.
      await tx.sampleAttachment.delete({ where: { id: file.id } })
      // Never the stored file while another row still names it, however that
      // row came to spell it: removing one row must not empty another.
      const twin = await tx.sampleAttachment.findFirst({
        where: { storagePath: { equals: file.storagePath, mode: 'insensitive' } },
        select: { id: true },
      })
      if (!twin) after.removeObjects.push(file.storagePath)
      detail = {
        attachmentId: file.id,
        reason: d.reason,
        fileName: file.fileName,
        kind: file.kind,
        roundId: file.roundId,
        storagePath: file.storagePath,
      }
      eventRoundId = file.roundId ?? undefined
      break
    }
    case 'CREATE_STYLE': {
      // The buyer's style is usually new to us: it is made here, kept in
      // sampling (DEVELOPMENT), and needs no masters rights to make.
      const d = sampleCreateStyleSchema.parse(cmd.data)
      if (request.styleId)
        fail(
          'This request already has its style. Change its details, or link another style instead.',
          'STYLE_ALREADY_SET'
        )
      if (everReleased(request)) fail(STYLE_FIXED, 'STYLE_FIXED')
      const brand = await tx.brand.findFirst({
        where: { id: request.brandId, isActive: true },
        select: { id: true, type: true },
      })
      if (!brand) fail('Pick an active brand for the request first.')
      // The tech-pack details on the request stand in for one left out here;
      // one sent empty was cleared on purpose and stays empty.
      const from = (value: string | null | undefined, onRequest: string | null) =>
        value === undefined ? onRequest : value || null
      const category = from(d.category, request.garmentCategory)
      // Its first letters go into the code, which never changes, as Masters →
      // Styles also insists: without it every such style is coded GN.
      if (!category)
        throw new AppError(
          'Name the garment. Its first letters go into the style code, which cannot change later.',
          400,
          'CATEGORY_REQUIRED'
        )
      await assertSizeRun(tx, d.sizeGroupId)
      const style = await createDevelopmentStyle(tx, {
        name: d.name,
        category,
        season: from(d.season, request.season),
        sizeGroupId: d.sizeGroupId,
        colors: d.colors,
        brandId: brand.id,
        brandType: brand.type,
      })
      await tx.sampleRequest.update({ where: { id }, data: { styleId: style.id } })
      await refitDrafts(tx, request.rounds, style)
      detail = { styleId: style.id, code: style.code, stage: style.stage, ...styleFacts(style) }
      after.styleAudit = {
        action: 'CREATE',
        styleId: style.id,
        after: await tx.style.findUniqueOrThrow({ where: { id: style.id } }),
      }
      eventRoundId = undefined
      break
    }
    case 'LINK_STYLE': {
      // A re-sample of a style we already have, or one no open request is
      // developing. Null takes the style off, so a draft can move brand.
      const d = sampleLinkStyleSchema.parse(cmd.data)
      if (everReleased(request)) {
        // A request released before requests named their style may still
        // take the one its released rounds were made in; nothing else.
        const made = request.styleId ? '' : releasedStyleId(request)
        if (!made || d.styleId !== made) fail(STYLE_FIXED, 'STYLE_FIXED')
      }
      if (d.styleId === request.styleId)
        fail(
          d.styleId
            ? 'This request already samples that style.'
            : 'This request has no style to take off.'
        )
      const style = d.styleId
        ? await tx.style.findFirst({
            where: { id: d.styleId, isActive: true },
            select: sampleStyleSelect,
          })
        : null
      if (d.styleId && !style) fail('Pick an active style.')
      if (style && style.brandId !== request.brandId)
        fail('The style must belong to this request’s brand.')
      if (style?.stage === 'DEVELOPMENT') {
        // A style in sampling belongs to the one request developing it. Two
        // requests on it would each refit only their own draft and overwrite
        // each other's colours. Locked first, so two requests cannot both
        // find it free at the same moment.
        await lockStyle(tx, style.id)
        const [developing] = await otherRequestsOn(tx, style.id, id)
        if (developing)
          fail(
            `${style.code} is being developed on ${developing.number}. Sample it from that request, or use a production style here.`,
            'STYLE_TAKEN'
          )
      }
      await tx.sampleRequest.update({ where: { id }, data: { styleId: style?.id ?? null } })
      await refitDrafts(tx, request.rounds, style)
      const named = (x: { id: string; code: string; stage: string } | null) =>
        x ? { id: x.id, code: x.code, stage: x.stage } : null
      detail = { before: named(request.style), after: named(style) }
      eventRoundId = undefined
      break
    }
    case 'UPDATE_STYLE': {
      const d = sampleUpdateStyleSchema.parse(cmd.data)
      const linked = request.style
      if (!linked) fail('Make or link the request’s style first.', 'NO_STYLE')
      if (linked.stage !== 'DEVELOPMENT')
        fail(
          `${linked.code} is a production style. Change it in Masters → Styles.`,
          'STYLE_IN_PRODUCTION'
        )
      // Locked, then read again: the copy read with the request may already
      // be out of date, and a release checking these colours waits for us.
      await lockStyle(tx, linked.id)
      const style = await tx.style.findUniqueOrThrow({ where: { id: linked.id } })
      // Changed from the one request developing it, which refits its own draft.
      // Another open request on it (from before only one could be) would be
      // left with a draft its style no longer fits, and no word of why.
      const sharing = await otherRequestsOn(tx, style.id, id)
      if (sharing.length)
        fail(
          `${style.code} is also the style of ${sharing.map((x) => x.number).join(', ')}. A style in sampling is changed from one request only: take it off the other request first.`,
          'STYLE_SHARED'
        )
      // What any released round (of any request) was made in stays true of the
      // style: its size run, and every colour a round was made in.
      const madeIn = await tx.sampleRound.findMany({
        where: { state: { not: 'DRAFT' }, specification: { path: ['styleId'], equals: style.id } },
        select: { specification: true },
      })
      if (d.sizeGroupId !== undefined && d.sizeGroupId !== style.sizeGroupId) {
        if (madeIn.length)
          fail(
            `${style.code} has been sampled in its current size run, so the run stays. Make another style for a new run.`,
            'STYLE_SIZE_RUN_IN_USE'
          )
        await assertSizeRun(tx, d.sizeGroupId)
      }
      if (d.colors) {
        const kept = new Set(d.colors.map((c) => c.toLowerCase()))
        const made = new Set(
          madeIn.map((x) =>
            String((x.specification as unknown as SampleSpecification).color ?? '').toLowerCase()
          )
        )
        const lost = style.colors.filter(
          (c) => !kept.has(c.toLowerCase()) && made.has(c.toLowerCase())
        )
        if (lost.length)
          fail(
            `${lost.join(', ')} ${lost.length === 1 ? 'has' : 'have'} been sampled in a released round, so ${lost.length === 1 ? 'it stays' : 'they stay'} on the style. Colours can still be added.`,
            'STYLE_COLOUR_IN_USE'
          )
      }
      const updated = await tx.style.update({
        where: { id: style.id },
        data: {
          ...(d.name !== undefined ? { name: d.name } : {}),
          ...(d.category !== undefined ? { category: d.category || null } : {}),
          ...(d.season !== undefined ? { season: d.season || null } : {}),
          ...(d.colors ? { colors: d.colors } : {}),
          ...(d.sizeGroupId !== undefined ? { sizeGroupId: d.sizeGroupId } : {}),
        },
      })
      await refitDrafts(tx, request.rounds, updated)
      detail = {
        styleId: style.id,
        code: style.code,
        before: styleFacts(style),
        after: styleFacts(updated),
      }
      after.styleAudit = { action: 'UPDATE', styleId: style.id, before: style, after: updated }
      eventRoundId = undefined
      break
    }
  }
  after.eventRoundId = eventRoundId ?? null
  await event(tx, id, request.version, cmd.action, actor, { roundId: eventRoundId, data: detail })
  return sampleDetail(tx, id)
}

export async function sampleLookups(tx: Tx) {
  const [customers, brands, styles, sizes, items, warehouses, boms, routings] = await Promise.all([
    tx.customer.findMany({
      where: { isActive: true },
      select: { id: true, name: true },
      orderBy: { name: 'asc' },
    }),
    tx.brand.findMany({ where: { isActive: true }, select: { id: true, name: true } }),
    tx.style.findMany({
      where: { isActive: true },
      select: {
        id: true,
        code: true,
        name: true,
        brandId: true,
        colors: true,
        sizeGroupId: true,
        stage: true,
        category: true,
        season: true,
        // The open requests on each style: one in sampling is offered only
        // to the request developing it (LINK_STYLE refuses it to any other).
        sampleRequests: {
          where: { cancelledAt: null },
          select: { id: true, number: true },
        },
      },
    }),
    tx.size.findMany({
      select: { id: true, code: true, sizeGroupId: true },
      orderBy: { sequence: 'asc' },
    }),
    tx.item.findMany({
      where: {
        isActive: true,
        type: { in: ['RAW_MATERIAL', 'TRIM', 'CONSUMABLE', 'PACKING_MATERIAL'] },
      },
      select: { id: true, code: true, name: true, uom: { select: { symbol: true } } },
    }),
    tx.warehouse.findMany({ where: { isActive: true }, select: { id: true, name: true } }),
    tx.bOM.findMany({
      where: { isActive: true, status: 'APPROVED' },
      select: { id: true, styleId: true, color: true, version: true },
    }),
    tx.routing.findMany({
      where: { isActive: true },
      select: { id: true, name: true, styleId: true, category: true, version: true },
    }),
  ])
  // The size runs a style made for a request can be cut in.
  const sizeGroups = await tx.sizeGroup.findMany({
    where: { isActive: true },
    select: { id: true, name: true },
    orderBy: { name: 'asc' },
  })
  return { customers, brands, styles, sizes, items, warehouses, boms, routings, sizeGroups }
}
