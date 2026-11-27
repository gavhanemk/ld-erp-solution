import { prisma } from '@ld-erp/database'
import { AppError } from '../middleware/errorHandler'
import { createItemSchema } from '../schemas/master.schemas'
import { assertItemFitsCategory, groupOfCategory } from '../services/itemGroups.service'
import { typeFitsGroup, type ItemGroup } from '@ld-erp/shared'
import { assertUniqueFields } from './crud'
import { assertItemStyleColorValid, rethrowItemStyleColorClash } from './itemStyleColor'
import { isGeneratedCode, withGeneratedCode } from './masterCode'

/**
 * The item master's own rules for adding an item, in one place: Masters →
 * Items (the CRUD factory in master.routes) and a sample's quick-add of a
 * material both go through them, so an item made from a sample request is
 * coded, named and filed exactly as one made in the masters.
 */

/**
 * What an item is sent back with.
 *
 * - taxRate travels with the item so an order form can fill the GST in from
 *   the item itself. Without it the purchase order screen read
 *   `item.taxRate.rate`, found nothing, and left the field blank for someone
 *   to type from memory — and a rate typed from memory is the one thing the
 *   business rules say must never happen. The alternative source, the tax
 *   rate list in Settings, needs a permission a purchase clerk does not have.
 * - The category's parent too, so the form can show a sub-category under the
 *   main one it belongs to.
 * - The style, for a finished good: which garment it is, with the colours it
 *   comes in.
 */
export const itemInclude = {
  category: { include: { parent: true } },
  uom: true,
  taxRate: true,
  department: { select: { id: true, name: true, code: true } },
  style: { select: { id: true, code: true, name: true, colors: true } },
  tdsSection: { select: { id: true, section: true, label: true } },
  // The packs it is bought in (1 Box = 20 pcs), the usual one first.
  buyUnits: {
    select: { id: true, factor: true, isDefault: true, uom: { select: { id: true, name: true, symbol: true, decimalPlaces: true } } },
    orderBy: [{ isDefault: 'desc' as const }, { factor: 'asc' as const }],
  },
}

/*
 * An item's department is its category's: the sub-category's own, or else its
 * main category's. The item form does not ask for it. Worked out when an item
 * is added, and again when its category changes; a department sent on purpose
 * is kept, and so is one an item already has while its category stays.
 */
export async function departmentFromCategory(
  data: Record<string, unknown>,
  before?: Record<string, unknown>,
) {
  if (data.departmentId !== undefined || typeof data.categoryId !== 'string') return data
  if (before && before.categoryId === data.categoryId && before.departmentId) return data
  const category = await prisma.itemCategory.findUnique({
    where: { id: data.categoryId },
    select: { departmentId: true, parent: { select: { departmentId: true } } },
  })
  return { ...data, departmentId: category?.departmentId ?? category?.parent?.departmentId ?? null }
}

/**
 * The checks an item needs that a schema cannot make, on adding and on
 * editing. Its type has to fit its category's tab. A finished good is one style in one colour, and the colour must be
 * one of that style's own. Checked here because it needs the style looked up,
 * which a schema cannot do. On an edit the saved type, style and colour stand
 * in for whatever the edit leaves out.
 */
/**
 * The type a category gives a new item: its group's one — a finished good, a
 * semi-finished piece, a fixed asset — and among raw materials what the
 * sub-category's items already are, else what its name says (Trims, Packing
 * Material, Consumables), else a raw material.
 */
async function typeForCategory(categoryId: string, group: ItemGroup): Promise<string> {
  if (group === 'FINISHED_GOODS') return 'FINISHED_GOOD'
  if (group === 'SEMI_FINISHED') return 'SEMI_FINISHED'
  if (group === 'FIXED_ASSETS') return 'FIXED_ASSET'
  if (group === 'EXPENSES') return 'CONSUMABLE'
  const like = await prisma.item.findFirst({
    where: { categoryId, isActive: true, type: { in: ['RAW_MATERIAL', 'TRIM', 'PACKING_MATERIAL', 'CONSUMABLE'] } },
    orderBy: { createdAt: 'desc' },
    select: { type: true },
  })
  if (like) return like.type
  const cat = await prisma.itemCategory.findUnique({ where: { id: categoryId }, select: { name: true, parent: { select: { name: true } } } })
  const said = `${cat?.name ?? ''} ${cat?.parent?.name ?? ''}`
  if (/trim|button|zip|label|tag|lace|elastic|accessor|fastener/i.test(said)) return 'TRIM'
  if (/pack|carton|poly ?bag|tape/i.test(said)) return 'PACKING_MATERIAL'
  if (/consumable|spare|stationer/i.test(said)) return 'CONSUMABLE'
  return 'RAW_MATERIAL'
}

/**
 * The item's type from its category, when it was not sent: a new item takes
 * the category's; an item moved to a category of another group takes the new
 * one's; otherwise it keeps its own (a trim stays a trim). A type sent is kept,
 * and checked against the category as before.
 */
async function typeFromCategory(data: Record<string, unknown>, before?: Record<string, unknown>) {
  if (data.type) return data
  const categoryId = (data.categoryId ?? before?.categoryId) as string | undefined
  if (!categoryId) return data
  const found = await groupOfCategory(categoryId)
  if (!found) return data
  const kept = before?.type as string | undefined
  if (kept && typeFitsGroup(kept, found.group)) return data
  return { ...data, type: await typeForCategory(categoryId, found.group) }
}

export async function itemBeforeSave(
  data: Record<string, unknown>,
  before?: Record<string, unknown>,
): Promise<{ data: Record<string, unknown>; onSaveError: (err: unknown) => void }> {
  data = await departmentFromCategory(data, before)
  data = await typeFromCategory(data, before)
  // A finished good is never filed under Fabric, nor a button under Finished Goods.
  await assertItemFitsCategory(data, before)
  const checked = await assertItemStyleColorValid(
    String(data.type ?? before?.type ?? ''),
    (data.styleId !== undefined ? data.styleId : before?.styleId) as string | null | undefined,
    (data.color !== undefined ? data.color : before?.color) as string | null | undefined,
    before?.id as string | undefined,
  )
  return {
    data: { ...data, styleId: checked.styleId, color: checked.color },
    // Two people saving the same style and colour at once: the database
    // catches the second, and this says so in words.
    onSaveError: (err: unknown) => {
      if (checked.styleName && checked.color) {
        rethrowItemStyleColorClash(err, checked.styleName, checked.color)
      }
    },
  }
}

/** Names unique without regard to capitals, as Masters → Items has them. */
export const ITEM_UNIQUE_FIELDS = ['name']

/**
 * Adds an item exactly as Masters → Items does (the factory's POST): the
 * item schema, a name no other item has, the department from the category,
 * the finished-good rules, and a code made from the category (FAB-007).
 * `types` narrows which kinds of item may be added from here. Returns the
 * item as the master returns it; the caller writes the masters audit row.
 */
export async function createItemRecord(raw: unknown, opts: { types?: readonly string[] } = {}) {
  const parsed = createItemSchema.parse(raw) as Record<string, unknown>
  await assertUniqueFields('item', ITEM_UNIQUE_FIELDS, parsed)
  const { data, onSaveError } = await itemBeforeSave(parsed)
  // The type as it comes out — sent, or from the category — has to be one this place may add.
  if (opts.types && !opts.types.includes(String(data.type)))
    throw new AppError(
      'Only a raw material, trim, packing material or consumable can be added here.',
      400,
      'ITEM_TYPE_NOT_ALLOWED',
    )
  try {
    if (isGeneratedCode('item') && !data.code)
      return await withGeneratedCode('item', data, (withCode) =>
        prisma.item.create({ data: withCode as never, include: itemInclude }),
      )
    return await prisma.item.create({ data: data as never, include: itemInclude })
  } catch (err) {
    onSaveError(err)
    throw err
  }
}
