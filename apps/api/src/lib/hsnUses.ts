import { prisma } from '@ld-erp/database'

/**
 * Everything that uses an HSN / SAC code, counted, for deciding whether the
 * code may be deleted from the HSN master.
 *
 * Most uses are not links: an item, or a line on an order, bill or invoice,
 * carries the code itself as text. So this reads the database's own list of
 * columns — every text column whose name has "hsn" in it holds a code; the
 * foreign keys to the master hold its id — instead of a list kept by hand,
 * which a new document's lines would quietly be missing from.
 */

interface HsnColumns {
  text: Array<{ table: string; column: string }>
  links: Array<{ table: string; column: string }>
}

let columns: Promise<HsnColumns> | null = null

/** The columns that hold an HSN code or link to one. They do not change while the server runs. */
function hsnColumns(): Promise<HsnColumns> {
  columns ??= (async () => {
    const links = await prisma.$queryRaw<Array<{ table: string; column: string }>>`
      SELECT ch.relname::text AS "table", a.attname::text AS "column"
      FROM pg_constraint con
      JOIN pg_class ch ON ch.oid = con.conrelid
      JOIN pg_namespace n ON n.oid = ch.relnamespace
      JOIN pg_class pa ON pa.oid = con.confrelid
      JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = con.conkey[1]
      WHERE con.contype = 'f' AND n.nspname = current_schema() AND pa.relname = 'hsn_codes'`
    const linkKeys = new Set(links.map((l) => `${l.table}.${l.column}`))
    const text = (
      await prisma.$queryRaw<Array<{ table: string; column: string }>>`
        SELECT table_name::text AS "table", column_name::text AS "column"
        FROM information_schema.columns
        WHERE table_schema = current_schema()
          AND column_name ILIKE '%hsn%'
          AND data_type IN ('text', 'character varying')
          AND table_name <> 'hsn_codes'`
    ).filter((c) => !linkKeys.has(`${c.table}.${c.column}`))
    return { text, links }
  })().catch((err) => {
    columns = null
    throw err
  })
  return columns
}

/** Names for the tables a person would recognise; any other is its table name in words. */
const NAMES: Record<string, [string, string]> = {
  items: ['item', 'items'],
  item_categories: ['item category', 'item categories'],
  charge_types: ['charge type', 'charge types'],
  grn_lines: ['GRN line', 'GRN lines'],
}

function named(table: string, n: number): string {
  const [one, many] =
    NAMES[table] ??
    (() => {
      const words = table.replace(/_/g, ' ').replace(/\bgrn\b/g, 'GRN')
      const single = words.replace(/ies$/, 'y').replace(/s$/, '')
      return [single, words]
    })()
  return `${n} ${n === 1 ? one : many}`
}

/** What uses this code, as "2 items", "3 purchase order lines". Empty when nothing does. */
export async function hsnUses(hsn: { id: string; code: string }): Promise<string[]> {
  const { text, links } = await hsnColumns()
  const code = hsn.code.replace(/\s+/g, '')
  const byTable = new Map<string, number>()
  const add = (table: string, n: number) => n > 0 && byTable.set(table, (byTable.get(table) ?? 0) + n)

  // Table and column names come from the database's own catalogue above, never from a request.
  for (const c of text) {
    const [row] = await prisma.$queryRawUnsafe<Array<{ n: number }>>(
      `SELECT COUNT(*)::int AS n FROM "${c.table}" WHERE replace(btrim("${c.column}"), ' ', '') = $1`,
      code,
    )
    add(c.table, row?.n ?? 0)
  }
  for (const l of links) {
    const [row] = await prisma.$queryRawUnsafe<Array<{ n: number }>>(
      `SELECT COUNT(*)::int AS n FROM "${l.table}" WHERE "${l.column}" = $1`,
      hsn.id,
    )
    add(l.table, row?.n ?? 0)
  }
  return [...byTable.entries()].map(([table, n]) => named(table, n))
}
