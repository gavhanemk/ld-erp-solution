import { prisma } from '@ld-erp/database'
import { AppError } from '../middleware/errorHandler'
import { createItemSchema } from '../schemas/master.schemas'
import { assertItemFitsCategory } from '../services/itemGroups.service'
import { assertUniqueFields } from './crud'
import { assertItemStyleColorValid, rethrowItemStyleColorClash } from './itemStyleColor'
import { cleanColour, cleanDesignNo, isFabricCategory } from './fabric'
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
export async function itemBeforeSave(
  data: Record<string, unknown>,
  before?: Record<string, unknown>,
): Promise<{ data: Record<string, unknown>; onSaveError: (err: unknown) => void }> {
  data = await departmentFromCategory(data, before)
  // A finished good is never filed under Fabric, nor a button under Finished Goods.
  await assertItemFitsCategory(data, before)

  /*
   * A fabric is set up one design and colour per item (lib/fabric): filed
   * under Fabric, it keeps the Design No. and Colour typed for it. Anything
   * else carries no design number, and only a finished good a colour.
   */
  const categoryId = (data.categoryId ?? before?.categoryId) as string | undefined
  const category = categoryId
    ? await prisma.itemCategory.findUnique({ where: { id: categoryId }, select: { name: true, parent: { select: { name: true } } } })
    : null
  if (String(data.type ?? before?.type ?? '') !== 'FINISHED_GOOD' && isFabricCategory(category)) {
    const designNo = data.designNo !== undefined ? cleanDesignNo(data.designNo) : ((before?.designNo as string | null | undefined) ?? null)
    const color = data.color !== undefined ? cleanColour(data.color) : ((before?.color as string | null | undefined) ?? null)
    return { data: { ...data, styleId: null, designNo, color }, onSaveError: () => undefined }
  }
  if (cleanDesignNo(data.designNo)) {
    throw new AppError('Design No. is for fabric. File the item under a Fabric category, or clear the Design No.', 400, 'DESIGN_NOT_FABRIC')
  }
  if (data.designNo !== undefined || before?.designNo) data = { ...data, designNo: null }
  if (String(data.type ?? before?.type ?? '') !== 'FINISHED_GOOD' && cleanColour(data.color)) {
    throw new AppError('Colour is for fabric and finished goods. File the item under a Fabric category, or clear the Colour.', 400, 'COLOUR_NOT_FABRIC')
  }

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
 * Where an item's name has to be unique. A finished good: among all items, as
 * before. Anything else: among items of the same design number and colour, so
 * "Cotton Twill" can be set up once for each design and colour it comes in.
 * Other items have neither, so for them nothing changes.
 */
export function itemUniqueScope(data: Record<string, unknown>, before?: Record<string, unknown>) {
  if (String(data.type ?? before?.type ?? '') === 'FINISHED_GOOD') return undefined
  const designNo = cleanDesignNo(data.designNo !== undefined ? data.designNo : before?.designNo)
  const color = cleanColour(data.color !== undefined ? data.color : before?.color)
  return {
    designNo: designNo ? { equals: designNo, mode: 'insensitive' } : null,
    color: color ? { equals: color, mode: 'insensitive' } : null,
  }
}

/**
 * Adds an item exactly as Masters → Items does (the factory's POST): the
 * item schema, a name no other item has, the department from the category,
 * the finished-good rules, and a code made from the category (FAB-007).
 * `types` narrows which kinds of item may be added from here. Returns the
 * item as the master returns it; the caller writes the masters audit row.
 */
export async function createItemRecord(raw: unknown, opts: { types?: readonly string[] } = {}) {
  const parsed = createItemSchema.parse(raw) as Record<string, unknown>
  if (opts.types && !opts.types.includes(String(parsed.type)))
    throw new AppError(
      'Only a raw material, trim, packing material or consumable can be added here.',
      400,
      'ITEM_TYPE_NOT_ALLOWED',
    )
  await assertUniqueFields('item', ITEM_UNIQUE_FIELDS, parsed, undefined, undefined, itemUniqueScope(parsed))
  const { data, onSaveError } = await itemBeforeSave(parsed)
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
