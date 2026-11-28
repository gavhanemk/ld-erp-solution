import type { Prisma, StockOwnership } from '@prisma/client'
import { AppError } from '../middleware/errorHandler'
import { financialYearOf, nextDocumentNumber } from '../lib/docNumber'
import { ITEM_SHADE, itemShadeText } from '../lib/fabric'
import { assertQtyFitsUnits } from './unitQuantity.service'

/*
 * Extra material for an MO (multi-brand phase 5, the user's rule of 28 Nov
 * 2026): more of a material than the MO's plan allows, or a material its plan
 * does not call for, is issued only on a separate authorisation — asked for
 * with a reason, approved by a production manager other than whoever asked.
 * An earmark says whose stock it is; it never says the MO may use more.
 *
 * Approved, an extra raises what the MO may be issued of that material by its
 * quantity, from whichever share the issue then uses (the brand's own first,
 * then free central stock, as decision 7 allows within what is permitted).
 * Nothing else raises it. An Admin may approve their own only as an
 * override, with a reason kept on it.
 */

type Tx = Prisma.TransactionClient
const round3 = (n: number) => Math.round(n * 1000) / 1000
/** A material's name with a fabric's design and colour beside it. */
const nameWithShade = (i: { name: string; designNo?: string | null; color?: string | null; styleId?: string | null }) => {
  const shade = itemShadeText(i)
  return shade ? `${i.name} (${shade})` : i.name
}

/** The number series, made the first time one is asked for in a year. */
async function nextNumber(tx: Tx, date: Date) {
  const company = await tx.company.findFirst({ select: { id: true, fyStartMonth: true } })
  if (company) {
    const financialYear = financialYearOf(date, company.fyStartMonth ?? 4)
    const have = await tx.numberSeries.findFirst({ where: { companyId: company.id, docType: 'EXM', financialYear }, select: { id: true } })
    if (!have) await tx.numberSeries.create({ data: { companyId: company.id, docType: 'EXM', prefix: 'EXM', separator: '-', financialYear, lastNumber: 0, padding: 4 } })
  }
  return nextDocumentNumber(tx, 'EXM', date)
}

const OPEN_MO = ['RELEASED', 'CUTTING', 'STITCHING', 'FINISHING', 'QC', 'PACKING']

/** What an MO may be issued of a material beyond its plan: its approved extras. */
export async function extraAllowed(tx: Tx, a: { moId: string; itemId: string; ownership: StockOwnership | string; ownerCustomerId?: string | null }) {
  const rows = await tx.materialExtra.findMany({
    where: { moId: a.moId, itemId: a.itemId, ownership: a.ownership as StockOwnership, ownerCustomerId: a.ownerCustomerId ?? null, status: 'APPROVED' },
    select: { qty: true },
  })
  return round3(rows.reduce((t, r) => t + Number(r.qty), 0))
}

/** Every approved extra of an MO, by material and owner: `${itemId}|${ownership}|${ownerCustomerId}`. */
export async function extrasOf(tx: Tx, moId: string) {
  const rows = await tx.materialExtra.groupBy({ by: ['itemId', 'ownership', 'ownerCustomerId'], where: { moId, status: 'APPROVED' }, _sum: { qty: true } })
  return new Map(rows.map((r) => [`${r.itemId}|${r.ownership}|${r.ownerCustomerId ?? ''}`, round3(Number(r._sum.qty ?? 0))]))
}

export interface RaiseExtra {
  itemId: string
  qty: number
  reason: string
  ownership?: 'OWNED' | 'CUSTOMER_OWNED'
}

/** Asks for extra material on an MO: waiting for a production manager. */
export async function raiseExtra(tx: Tx, moId: string, input: RaiseExtra, userId: string) {
  const mo = await tx.manufacturingOrder.findUnique({
    where: { id: moId },
    select: { id: true, moNumber: true, status: true, so: { select: { isJobWork: true, customerId: true } } },
  })
  if (!mo) throw new AppError('Manufacturing order not found', 404, 'NOT_FOUND')
  if (!OPEN_MO.includes(mo.status)) {
    throw new AppError(`${mo.moNumber} is ${mo.status.toLowerCase()}: extra material is asked for on an order being made.`, 409, 'MO_NOT_OPEN')
  }
  if (!(input.qty > 0)) throw new AppError('Ask for more than nothing.', 400, 'INVALID_QTY')
  if (input.reason.trim().length < 5) throw new AppError('Say why the extra is needed.', 400, 'REASON_REQUIRED')
  const item = await tx.item.findUnique({ where: { id: input.itemId }, select: { id: true, isActive: true, name: true, ...ITEM_SHADE } })
  if (!item) throw new AppError('That material does not exist', 404, 'NOT_FOUND')
  await assertQtyFitsUnits(tx, [{ itemId: input.itemId, qty: input.qty, what: 'Extra' }])
  const ownership = input.ownership ?? 'OWNED'
  if (ownership === 'CUSTOMER_OWNED' && !mo.so?.isJobWork) throw new AppError("A customer's material is asked for only on their job-work order.", 400, 'WRONG_OWNER')
  const now = new Date()
  return tx.materialExtra.create({
    data: {
      number: await nextNumber(tx, now),
      moId,
      itemId: input.itemId,
      ownership,
      ownerCustomerId: ownership === 'CUSTOMER_OWNED' ? (mo.so?.customerId ?? null) : null,
      qty: round3(input.qty),
      reason: input.reason.trim(),
      requestedById: userId,
    },
    include: { item: { select: { name: true, ...ITEM_SHADE } }, mo: { select: { moNumber: true } } },
  })
}

async function lockExtra(tx: Tx, id: string) {
  await tx.$queryRaw`SELECT id FROM ld_erp.material_extras WHERE id = ${id} FOR UPDATE`
  const row = await tx.materialExtra.findUnique({ where: { id }, include: { mo: { select: { moNumber: true, status: true } }, item: { select: { name: true, ...ITEM_SHADE } } } })
  if (!row) throw new AppError('That request for extra material does not exist', 404, 'NOT_FOUND')
  return row
}

/**
 * Approves an extra: a production manager other than whoever asked. An Admin
 * approving their own does so as an override, with a reason of at least ten
 * characters kept on it.
 */
export async function approveExtra(tx: Tx, id: string, user: { id: string; admin: boolean }, overrideReason?: string | null) {
  const row = await lockExtra(tx, id)
  if (row.status !== 'PENDING') throw new AppError(`${row.number} is ${row.status.toLowerCase()}, not waiting for approval.`, 409, 'NOT_PENDING')
  if (!OPEN_MO.includes(row.mo.status)) throw new AppError(`${row.mo.moNumber} is ${row.mo.status.toLowerCase()}: nothing more is issued for it.`, 409, 'MO_NOT_OPEN')
  const own = row.requestedById === user.id
  const said = (overrideReason ?? '').trim()
  if (own && !user.admin) throw new AppError(`You asked for ${row.number}, so another production manager approves it.`, 403, 'SELF_APPROVAL')
  if (own && said.length < 10) {
    throw new AppError(`You asked for ${row.number}. An Admin may approve their own only as an override: say why, in a sentence.`, 400, 'OVERRIDE_REASON_REQUIRED')
  }
  return tx.materialExtra.update({
    where: { id },
    data: { status: 'APPROVED', decidedById: user.id, decidedAt: new Date(), selfApproved: own, overrideReason: own ? said : null },
    include: { item: { select: { name: true, ...ITEM_SHADE } }, mo: { select: { moNumber: true } } },
  })
}

export async function rejectExtra(tx: Tx, id: string, userId: string, reason: string) {
  const row = await lockExtra(tx, id)
  if (row.status !== 'PENDING') throw new AppError(`${row.number} is ${row.status.toLowerCase()}, not waiting for approval.`, 409, 'NOT_PENDING')
  if (row.requestedById === userId) throw new AppError(`You asked for ${row.number}: withdraw it instead.`, 400, 'OWN_REJECT')
  if (reason.trim().length < 3) throw new AppError('Say why it is turned down.', 400, 'REASON_REQUIRED')
  return tx.materialExtra.update({ where: { id }, data: { status: 'REJECTED', decidedById: userId, decidedAt: new Date(), rejectReason: reason.trim() } })
}

/** Withdrawn by whoever asked (or an Admin), while it waits; or an approved one nothing has used yet. */
export async function withdrawExtra(tx: Tx, id: string, user: { id: string; admin: boolean }) {
  const row = await lockExtra(tx, id)
  if (row.requestedById !== user.id && !user.admin) throw new AppError(`Only whoever asked for ${row.number} withdraws it.`, 403, 'NOT_YOURS')
  if (row.status === 'APPROVED') {
    // Approved and not yet needed: what the MO has been issued must still fit its plan and the other extras.
    const room = await roomFor(tx, { moId: row.moId, itemId: row.itemId, ownership: row.ownership, ownerCustomerId: row.ownerCustomerId })
    if (room.room < Number(row.qty) - 0.0005) {
      throw new AppError(`${row.number} has been used: ${row.mo.moNumber} was issued more than its plan by it. It stands.`, 409, 'EXTRA_USED')
    }
  } else if (row.status !== 'PENDING') throw new AppError(`${row.number} is ${row.status.toLowerCase()}.`, 409, 'NOT_PENDING')
  return tx.materialExtra.update({ where: { id }, data: { status: 'WITHDRAWN' } })
}

/**
 * What an MO may still be issued of a material: its plan's requirement plus
 * its approved extras, less what is issued already (net of what came back).
 * `planned` false: the plan does not call for it at all.
 */
export async function roomFor(tx: Tx, a: { moId: string; itemId: string; ownership: StockOwnership | string; ownerCustomerId?: string | null }) {
  const { materialPlan } = await import('./manufacturing.service')
  const plan = await materialPlan(tx, a.moId)
  const rows = plan.rows.filter((r) => r.item.id === a.itemId && r.ownership === a.ownership && (r.ownerCustomerId ?? null) === (a.ownerCustomerId ?? null))
  const required = round3(rows.filter((r) => !r.extraOnly).reduce((t, r) => t + r.required, 0))
  const extra = await extraAllowed(tx, a)
  // Issued is counted from the requisitions themselves, so a material the plan does not call for counts too.
  const lines = await tx.materialRequisitionLine.findMany({
    where: { itemId: a.itemId, ownership: a.ownership as StockOwnership, ownerCustomerId: a.ownerCustomerId ?? null, mr: { moId: a.moId } },
    select: { issuedQty: true, returnedQty: true },
  })
  const issued = round3(lines.reduce((t, l) => t + Number(l.issuedQty) - Number(l.returnedQty), 0))
  return { required, extra, issued, room: round3(Math.max(0, required + extra - issued)), planned: rows.some((r) => !r.extraOnly) }
}

/**
 * Refuses an issue that would take an MO past what it may use of a material
 * (its plan and its approved extras), whichever share the material comes
 * from: an earmark never permits more. Says what to ask for instead.
 */
export async function assertWithinPermitted(
  tx: Tx,
  a: { mo: { id: string; moNumber: string }; itemId: string; ownership: StockOwnership | string; ownerCustomerId?: string | null; qty: number; alreadyThisIssue: number; unit: string },
) {
  const r = await roomFor(tx, { moId: a.mo.id, itemId: a.itemId, ownership: a.ownership, ownerCustomerId: a.ownerCustomerId })
  const room = round3(Math.max(0, r.room - a.alreadyThisIssue))
  if (a.qty <= room + 0.0005) return r
  const item = await tx.item.findUnique({ where: { id: a.itemId }, select: { name: true, ...ITEM_SHADE } })
  const name = item ? nameWithShade(item) : 'That material'
  const over = round3(a.qty - room)
  throw new AppError(
    r.planned || r.extra > 0
      ? `${a.mo.moNumber} may be issued ${round3(r.required + r.extra)} ${a.unit} of ${name} (its plan ${r.required}${r.extra ? ` and ${r.extra} extra approved` : ''}); ${r.issued} ${a.unit} is issued already${a.alreadyThisIssue ? ` and ${round3(a.alreadyThisIssue)} goes now` : ''}. ${round3(a.qty)} more goes past it by ${over} ${a.unit}. Ask for extra material on the MO (Production → Manufacturing Orders → Extra material), approved by a production manager; an earmark alone does not allow it.`
      : `${a.mo.moNumber}'s plan does not call for ${name}. Ask for it as extra material on the MO (Production → Manufacturing Orders → Extra material), approved by a production manager; an earmark alone does not allow it.`,
    409,
    'EXTRA_NEEDED',
  )
}

/** An MO's extra-material requests, newest first, for its screen. */
export async function listExtras(tx: Tx, moId: string) {
  const rows = await tx.materialExtra.findMany({
    where: { moId },
    orderBy: { requestedAt: 'desc' },
    include: {
      item: { select: { id: true, code: true, name: true, ...ITEM_SHADE, uom: { select: { symbol: true } } } },
      requestedBy: { select: { id: true, name: true } },
      decidedBy: { select: { id: true, name: true } },
    },
  })
  return rows.map((r) => ({ ...r, qty: Number(r.qty), itemName: nameWithShade(r.item), unit: r.item.uom?.symbol ?? '' }))
}
