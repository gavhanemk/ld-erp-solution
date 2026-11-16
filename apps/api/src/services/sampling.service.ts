import type { Prisma } from '@prisma/client'
import type { z } from 'zod'
import { AppError } from '../middleware/errorHandler'
import { userCan, type AuthRequest } from '../middleware/auth'
import { nextDocumentNumber } from '../lib/docNumber'
import { recordMovement } from './stock.service'
import { routingProblem } from './route.service'
import type { SampleSpecification } from '../../../../packages/shared/src/sampling'
import {
  createSampleSchema,
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
export const sampleInclude = {
  customer: { select: { id: true, name: true } },
  brand: { select: { id: true, name: true } },
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
  brandId: string,
  customerId: string | null,
  draft = false
) {
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

/** Parent row lock + expected version serialize all decisions, quantities and retries. */
export async function actOnSample(
  tx: Tx,
  id: string,
  cmd: z.infer<typeof sampleActionSchema>,
  actor: Actor
) {
  await tx.$queryRaw`SELECT id FROM ld_erp.sample_requests WHERE id = ${id} FOR UPDATE`
  const request = await sampleDetail(tx, id)
  if (request.version !== cmd.version)
    fail('This sample changed in another window. Refresh it before saving.', 'STALE_SAMPLE')
  if (request.cancelledAt) fail('This request is cancelled.')
  const r = request.rounds.find((x) => x.id === cmd.roundId)
  if (
    !['CANCEL', 'UPDATE_REQUEST'].includes(cmd.action) &&
    (!r || (cmd.action !== 'MATERIAL' && request.rounds[0].id !== r.id))
  )
    fail('Only the latest sample round can be changed.')
  const round = r!
  const spec = round?.specification as unknown as SampleSpecification
  const approver = ['RELEASE', 'QC', 'DECIDE', 'HANDOVER', 'CANCEL'].includes(cmd.action)
  grant(actor, 'sampling', approver ? 'approve' : 'edit')
  let detail: unknown = cmd.data
  switch (cmd.action) {
    case 'UPDATE_REQUEST': {
      if (request.rounds.some((x) => x.handover))
        fail('This request has a production handover. Its details are now frozen.')
      const { reason, ...d } = updateSampleRequestSchema.parse(cmd.data)
      const identityChanged = d.brandId !== request.brandId || d.customerId !== request.customerId
      if (identityChanged && request.rounds.some((x) => x.releasedAt || x.state !== 'DRAFT'))
        fail(
          'Buyer and brand are locked after the first release to preserve stock ownership and approval history.'
        )
      if (d.brandId !== request.brandId) {
        if (!(await tx.brand.findFirst({ where: { id: d.brandId, isActive: true } })))
          fail('Pick an active brand.')
        for (const draft of request.rounds)
          await validateSpec(
            tx,
            draft.specification as unknown as SampleSpecification,
            d.brandId,
            d.customerId,
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
      }
      await tx.sampleRequest.update({
        where: { id },
        data: { ...d, requiredAt: d.requiredAt ? new Date(d.requiredAt) : null },
      })
      detail = { reason, before, after: d }
      break
    }
    case 'SAVE_DRAFT': {
      if (round.state !== 'DRAFT')
        fail('Released specifications are frozen. Make a new round to change them.')
      const patch = sampleDraftPatchSchema.parse(cmd.data)
      const s = sampleDraftSchema.parse({ ...spec, ...patch })
      await validateSpec(tx, s, request.brandId, request.customerId, true)
      await tx.sampleRound.update({ where: { id: round.id }, data: { specification: json(s) } })
      detail = { specification: s }
      break
    }
    case 'SAVE_SPEC': {
      if (round.state !== 'DRAFT')
        fail('Released specifications are frozen. Make a new round to change them.')
      const s = sampleSpecificationSchema.parse(cmd.data)
      await validateSpec(tx, s, request.brandId, request.customerId)
      await tx.sampleRound.update({ where: { id: round.id }, data: { specification: json(s) } })
      break
    }
    case 'RELEASE': {
      if (round.state !== 'DRAFT') fail('Only a draft round can be released.')
      const s = sampleSpecificationSchema.parse(
        cmd.data && typeof cmd.data === 'object' && 'styleId' in cmd.data ? cmd.data : spec
      )
      await validateSpec(tx, s, request.brandId, request.customerId)
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
      detail = { revision: round.revision, milestone: s.milestone }
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
      detail = { fromRevision: round.revision, reason }
      break
    }
    case 'HANDOVER': {
      if (round.state !== 'APPROVED' || round.handover)
        fail('Handover requires buyer approval and can only be prepared once.')
      if (request.rounds.some((x) => x.materials.some((m) => held(m) > 0.0005)))
        fail('Account for used, wasted and returned material on every round before handover.')
      const d = sampleHandoverSchema.parse(cmd.data)
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
    }
  }
  await event(tx, id, request.version, cmd.action, actor, { roundId: round?.id, data: detail })
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
      select: { id: true, code: true, name: true, brandId: true, colors: true, sizeGroupId: true },
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
  return { customers, brands, styles, sizes, items, warehouses, boms, routings }
}
