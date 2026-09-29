import { prisma } from '@ld-erp/database'
import { AppError } from '../middleware/errorHandler'

/**
 * A finished good is one style in one colour. Zod can check the shape of
 * styleId and color; it cannot check that the colour is actually one of that
 * style's own colours, or that no other item already claims it — both need a
 * database lookup. This is the one place that lookup happens, shared by the
 * hand-written /items routes (master.routes.ts) and the AI assistant's
 * create_item tool, so the rule is only ever expressed once.
 *
 * On success it returns the colour exactly as the style spells it — the
 * caller may have typed "white" against a style whose colors[] says "White".
 * Style.colors[] is not itself case-normalised, so the style's own spelling
 * is the only thing that can be called correct.
 */
export async function assertItemStyleColorValid(
  type: string,
  styleId: string | null | undefined,
  color: string | null | undefined,
  currentItemId?: string,
): Promise<{ styleId: string | null; color: string | null; styleName: string | null }> {
  if (type !== 'FINISHED_GOOD') {
    if (styleId || color) {
      throw new AppError(
        'Style and colour only apply to finished goods. Clear them, or change the item type to Finished Good.',
        400,
        'STYLE_COLOR_NOT_ALLOWED',
      )
    }
    return { styleId: null, color: null, styleName: null }
  }

  if (!styleId) {
    throw new AppError('A finished good needs a style. Pick which garment this is.', 400, 'STYLE_REQUIRED')
  }

  const style = await prisma.style.findUnique({
    where: { id: styleId },
    select: { name: true, colors: true },
  })
  if (!style) throw new AppError('That style no longer exists', 400, 'INVALID_STYLE')

  if (style.colors.length === 0) {
    throw new AppError(
      `"${style.name}" has no colours set up yet. Add its colours in Styles first.`,
      400,
      'STYLE_HAS_NO_COLORS',
    )
  }

  const canonical = style.colors.find((c) => c.toLowerCase() === String(color ?? '').trim().toLowerCase())
  if (!canonical) {
    throw new AppError(
      `"${color}" is not one of ${style.name}'s colours (${style.colors.join(', ')}).`,
      400,
      'COLOR_NOT_IN_STYLE',
    )
  }

  const clash = await prisma.item.findFirst({
    where: {
      styleId,
      color: { equals: canonical, mode: 'insensitive' },
      ...(currentItemId ? { id: { not: currentItemId } } : {}),
    },
    select: { id: true, name: true, code: true },
  })
  if (clash) {
    throw new AppError(
      `${clash.name} (${clash.code}) is already "${style.name}" in ${canonical}. Each style + colour can only be one item.`,
      409,
      'STYLE_COLOR_ALREADY_EXISTS',
    )
  }

  return { styleId, color: canonical, styleName: style.name }
}

/**
 * assertItemStyleColorValid already checks for a clashing style + colour
 * before saving, so this only ever fires on the rare race where two people
 * save the same one at the same instant. Same shape as BOM's
 * rethrowVersionClash for the same reason: Prisma's own message names the
 * columns, not the item, which is not something anyone can act on.
 */
export function rethrowItemStyleColorClash(err: unknown, styleName: string, color: string): never {
  const e = err as { code?: string; meta?: { target?: unknown } }
  const target = e?.code === 'P2002' ? e.meta?.target : undefined
  const fields = Array.isArray(target) ? target.map(String) : []
  if (fields.includes('styleId') && fields.includes('color')) {
    throw new AppError(
      `Another item was just saved as "${styleName}" in ${color}. Each style + colour can only be one item.`,
      409,
      'STYLE_COLOR_ALREADY_EXISTS',
    )
  }
  throw err
}
