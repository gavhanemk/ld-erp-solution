import type { Prisma } from '@prisma/client'
import type { ReportDefinition, ReportFilter, ReportParams } from './types'

/**
 * What the reader actually asked for, in words.
 *
 * The filters arrive as query parameters, and a `select` filter's value is an
 * id. Printed raw — which is what the Notes sheet did — the pack said
 *
 *     Supplier    9f3c1e22-7b04-4f1e-9a55-2d0c8ab41f77
 *
 * which tells nobody anything and is worse than printing nothing, because it
 * looks like the report meant it. The ids are resolved to names here, inside
 * the same transaction the rows came from, so the caption cannot describe a
 * supplier who was renamed between the query and the file being written.
 */

/** Where a `select` filter's options come from, and how to name one. */
const LOOKUPS: Record<
  string,
  (tx: Prisma.TransactionClient, id: string) => Promise<string | null>
> = {
  suppliers: async (tx, id) =>
    (await tx.supplier.findUnique({ where: { id }, select: { name: true } }))?.name ?? null,
  customers: async (tx, id) =>
    (await tx.customer.findUnique({ where: { id }, select: { name: true } }))?.name ?? null,
  items: async (tx, id) => {
    const item = await tx.item.findUnique({ where: { id }, select: { code: true, name: true } })
    return item ? `${item.name} (${item.code})` : null
  },
  warehouses: async (tx, id) =>
    (await tx.warehouse.findUnique({ where: { id }, select: { name: true } }))?.name ?? null,
  itemCategories: async (tx, id) =>
    (await tx.itemCategory.findUnique({ where: { id }, select: { name: true } }))?.name ?? null,
}

const DAY = new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })

export interface AppliedFilter {
  label: string
  value: string
}

/** One filter's value, as a person would say it. */
async function describe(
  f: ReportFilter,
  raw: string,
  tx: Prisma.TransactionClient
): Promise<string> {
  if (f.type === 'boolean') return 'Yes'
  if (f.type === 'date') {
    const d = new Date(`${raw}T00:00:00`)
    return Number.isNaN(d.getTime()) ? raw : DAY.format(d)
  }
  if (f.type === 'select') {
    // A fixed list carries its own words; only a master lookup needs the
    // database. An id that no longer resolves prints as itself rather than as
    // a blank — a filter that silently disappears from the caption is a file
    // that claims to cover more than it does.
    const fixed = f.options?.find((o) => o.value === raw)
    if (fixed) return fixed.label
    if (f.optionsFrom) {
      const lookup = LOOKUPS[f.optionsFrom]
      if (lookup) return (await lookup(tx, raw)) ?? raw
    }
  }
  return raw
}

export async function describeFilters(
  def: ReportDefinition,
  params: ReportParams,
  tx: Prisma.TransactionClient
): Promise<AppliedFilter[]> {
  const out: AppliedFilter[] = []
  for (const f of def.filters) {
    const raw = params[f.key]
    if (!raw) continue
    out.push({ label: f.label, value: await describe(f, raw, tx) })
  }
  return out
}

/** The same thing as one line, for a caption under a title. */
export function filterLine(applied: AppliedFilter[]): string {
  if (!applied.length) return 'No filters set — everything on record'
  return applied.map((a) => `${a.label}: ${a.value}`).join('   ·   ')
}
