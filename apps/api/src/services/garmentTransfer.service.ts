import type { Prisma, StockOwnership } from '@prisma/client'
import { AppError } from '../middleware/errorHandler'
import { balanceOf } from './stock.service'
import { normaliseGarmentCode } from './garment.service'
import { event } from './garmentHooks.service'

/*
 * Garment tags on stock transfers.
 *
 * A tagged garment is a piece with its own identity, so when tagged pieces
 * move between stores the tags move with them, piece by piece, on the same
 * transfer that moves the stock. Typed transfers name the tags (picked or
 * scanned) wherever the stock alone cannot say which pieces went: when
 * moving only untagged pieces would leave the store's tags claiming more than
 * it holds. On the road, the tags wait in the transit store with the goods;
 * each receipt, send-back or write-off names the tags it covers unless there
 * is no doubt (all of it arrived, none damaged), and a cancellation brings
 * them all back. The ledger and the tags can then never disagree.
 */

type Tx = Prisma.TransactionClient

/** One balance's identity, as a transfer line names it. */
export interface TagKey {
  itemId: string
  sizeId: string | null
  grade: string
  ownership: StockOwnership
  ownerCustomerId: string | null
}

const tagSelect = {
  id: true,
  code: true,
  status: true,
  grade: true,
  itemId: true,
  sizeId: true,
  warehouseId: true,
  ownership: true,
  ownerCustomerId: true,
  dcId: true,
  adjustmentId: true,
  item: { select: { name: true } },
  size: { select: { code: true } },
} satisfies Prisma.GarmentSelect
type Tag = Prisma.GarmentGetPayload<{ select: typeof tagSelect }>

const keyWhere = (k: TagKey) => ({ itemId: k.itemId, sizeId: k.sizeId, grade: k.grade, ownership: k.ownership, ownerCustomerId: k.ownerCustomerId })
const what = (name: string, sizeCode: string | null) => `${name}${sizeCode ? ` size ${sizeCode}` : ''}`

/** The tags named, normalised and locked; refused if any is unknown. */
async function lockTags(tx: Tx, codes: string[]): Promise<Tag[]> {
  const wanted = [...new Set(codes.map(normaliseGarmentCode).filter(Boolean))]
  if (!wanted.length) return []
  const found = await tx.garment.findMany({ where: { code: { in: wanted } }, select: { id: true, code: true } })
  const missing = wanted.filter((c) => !found.some((g) => g.code === c))
  if (missing.length) throw new AppError(`No garment with the tag ${missing.join(', ')}.`, 404, 'NOT_FOUND')
  await tx.$queryRaw`SELECT id FROM ld_erp.garments WHERE id = ANY(${found.map((g) => g.id)}::text[]) FOR UPDATE`
  return tx.garment.findMany({ where: { id: { in: found.map((g) => g.id) } }, select: tagSelect })
}

/** Why a named tag cannot go on this line, or null when it can. */
function notThis(g: Tag, k: TagKey, warehouseId: string, storeName: string): string | null {
  if (g.warehouseId !== warehouseId) return `${g.code} is not in ${storeName}.`
  if (g.itemId !== k.itemId || (g.sizeId ?? null) !== (k.sizeId ?? null)) return `${g.code} is ${what(g.item.name, g.size?.code ?? null)}, not this line's item and size.`
  if (g.grade !== k.grade) return `${g.code} is grade ${g.grade}, not this line's grade ${k.grade}.`
  if (g.ownership !== k.ownership || (g.ownerCustomerId ?? null) !== (k.ownerCustomerId ?? null)) return `${g.code} belongs to someone else's stock.`
  if (g.status === 'PACKED') return `${g.code} is sealed in a carton: open the carton first.`
  if (g.status !== 'IN_STOCK') return `${g.code} is not in stock (${g.status.toLowerCase()}).`
  if (g.dcId) return `${g.code} is held on a delivery challan.`
  if (g.adjustmentId) return `${g.code} is waiting for a write-off to be approved.`
  return null
}

/**
 * How a store stands for one balance: what the ledger holds, how many tags
 * claim pieces of it, and so how many pieces carry no tag.
 */
export async function tagPosition(tx: Tx, warehouseId: string, k: TagKey) {
  const [ledger, tagged] = await Promise.all([
    balanceOf(tx, { itemId: k.itemId, warehouseId, sizeId: k.sizeId, grade: k.grade, ownership: k.ownership, ownerCustomerId: k.ownerCustomerId }),
    tx.garment.count({ where: { ...keyWhere(k), warehouseId, status: { in: ['IN_STOCK', 'PACKED'] } } }),
  ])
  const held = Math.round(ledger.qty)
  return { held, tagged, untagged: Math.max(0, held - tagged) }
}

/**
 * The tags a typed transfer line moves, checked. Moving untagged pieces
 * needs no tag; beyond what the store holds untagged, each piece moved must
 * be named by its tag, or the tags left behind would claim more than the
 * store holds. Returns the tags to move with the stock.
 */
export async function tagsForTransferLine(
  tx: Tx,
  args: { fromWarehouseId: string; fromName: string; key: TagKey; qty: number; codes?: string[] | null },
): Promise<Tag[]> {
  const pos = await tagPosition(tx, args.fromWarehouseId, args.key)
  const named = await lockTags(tx, args.codes ?? [])
  if (!pos.tagged && !named.length) return []
  for (const g of named) {
    const why = notThis(g, args.key, args.fromWarehouseId, args.fromName)
    if (why) throw new AppError(why, 409, 'WRONG_TAG')
  }
  const qty = Math.round(args.qty)
  const sample = named[0] ?? (await tx.garment.findFirst({ where: { ...keyWhere(args.key) }, select: { item: { select: { name: true } }, size: { select: { code: true } } } }))
  const label = sample ? what(sample.item.name, sample.size?.code ?? null) : 'this item'
  if (named.length > qty) throw new AppError(`${named.length} tags named for ${label}, but only ${qty} pieces moving.`, 400, 'TOO_MANY_TAGS')
  const needed = Math.max(0, qty - pos.untagged)
  if (named.length < needed) {
    throw new AppError(
      `${label}: ${args.fromName} holds ${pos.held}, ${pos.tagged} of them tagged, so ${needed} of the ${qty} moving must be named by their tags${named.length ? ` (${named.length} named so far)` : ''}. Scan them, or pick them from the store's tags.`,
      400,
      'TAGS_NEEDED',
    )
  }
  return named
}

/** Tags moved with their stock, each with a TRANSFERRED event naming the transfer. */
export async function moveTags(
  tx: Tx,
  tags: Array<{ id: string }>,
  toWarehouseId: string,
  ref: { transferId: string; transferNumber: string; notes: string },
  userId: string | null,
  change: { grade?: string; status?: 'SCRAPPED' } = {},
) {
  if (!tags.length) return
  const ids = tags.map((g) => g.id)
  await tx.garment.updateMany({ where: { id: { in: ids } }, data: { warehouseId: toWarehouseId, ...(change.grade ? { grade: change.grade } : {}), ...(change.status ? { status: change.status } : {}) } })
  await event(tx, ids, change.status === 'SCRAPPED' ? 'SCRAPPED' : 'TRANSFERRED', { type: 'STOCK_TRANSFER', id: ref.transferId, number: ref.transferNumber, notes: ref.notes }, userId)
}

/** The tags a transfer moved that are in one store now, still in stock: on the road, or arrived. */
export async function transferTagsIn(tx: Tx, transferId: string, warehouseId: string, k: TagKey) {
  const moved = await tx.garmentEvent.findMany({ where: { referenceId: transferId, type: 'TRANSFERRED' }, select: { garmentId: true }, distinct: ['garmentId'] })
  if (!moved.length) return []
  return tx.garment.findMany({
    where: { id: { in: moved.map((m) => m.garmentId) }, warehouseId, status: 'IN_STOCK', ...keyWhere(k) },
    select: tagSelect,
    orderBy: { code: 'asc' },
  })
}

/**
 * The tags one step on the road covers. `onTheWay` is what of the line is
 * still on the road; `qty` and `damaged` what this step takes. With every
 * piece on the road taken and none damaged, every tag on the road goes with
 * them; otherwise the step names the tags it covers, unless the pieces it
 * leaves unnamed can all be untagged ones.
 */
export async function tagsForRoadStep(
  tx: Tx,
  args: { transferId: string; transitWarehouseId: string; key: TagKey; onTheWay: number; qty: number; damaged?: number; codes?: string[] | null; damagedCodes?: string[] | null; label: string; verb: string },
): Promise<{ good: Tag[]; damaged: Tag[] }> {
  const onRoad = await transferTagsIn(tx, args.transferId, args.transitWarehouseId, args.key)
  const good = await lockTags(tx, args.codes ?? [])
  const bad = await lockTags(tx, args.damagedCodes ?? [])
  if (!onRoad.length) {
    if (good.length || bad.length) throw new AppError(`${args.label} has no tags on the road on this transfer.`, 409, 'WRONG_TAG')
    return { good: [], damaged: [] }
  }
  const onRoadIds = new Set(onRoad.map((g) => g.id))
  for (const g of [...good, ...bad]) {
    if (!onRoadIds.has(g.id)) throw new AppError(`${g.code} is not one of ${args.label}'s tags on the road.`, 409, 'WRONG_TAG')
  }
  if (good.some((g) => bad.some((b) => b.id === g.id))) throw new AppError('A tag is named both as arrived good and as damaged.', 400, 'TAG_TWICE')
  const qty = Math.round(args.qty)
  const damaged = Math.round(args.damaged ?? 0)
  if (good.length > qty) throw new AppError(`${good.length} tags named, but only ${qty} ${args.verb}.`, 400, 'TOO_MANY_TAGS')
  if (bad.length > damaged) throw new AppError(`${bad.length} tags named as damaged, but only ${damaged} damaged.`, 400, 'TOO_MANY_TAGS')
  const untaggedOnRoad = Math.max(0, Math.round(args.onTheWay) - onRoad.length)
  const rest = onRoad.filter((g) => !good.some((x) => x.id === g.id) && !bad.some((x) => x.id === g.id))
  const whole = qty + damaged >= Math.round(args.onTheWay)
  const unnamedGood = qty - good.length
  const unnamedBad = damaged - bad.length
  if (whole && unnamedBad === 0) return { good: [...good, ...rest], damaged: bad }
  if (unnamedGood + unnamedBad > untaggedOnRoad) {
    const need = unnamedGood + unnamedBad - untaggedOnRoad
    throw new AppError(
      `${args.label}: ${onRoad.length} of the pieces on the road carry tags, so name ${need} more tag${need === 1 ? '' : 's'} for what is ${args.verb}${damaged ? ' (and which arrived damaged)' : ''}. Scan them, or pick them.`,
      400,
      'TAGS_NEEDED',
    )
  }
  return { good, damaged: bad }
}
