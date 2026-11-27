/**
 * A full copy of every table in ld_erp, read in one consistent moment and
 * written as JSON: the backup taken before every live migration. Read-only:
 * it runs nothing but SELECTs. From apps/api, with the database to copy in
 * DATABASE_URL (for live, node --env-file=<the live settings file>):
 *
 *   node --env-file=<settings> ../../node_modules/tsx/dist/cli.mjs ../../tools/backup-db.ts <file.json>
 *
 * The address is never printed. Restoring needs a script that inserts
 * parents before children.
 */
import { writeFileSync } from 'node:fs'
import { prisma } from '../packages/database/src/index'

async function main() {
  const out = process.argv[2]
  if (!out) throw new Error('Usage: backup-db.ts <file>')
  const [{ db }] = await prisma.$queryRaw<{ db: string }[]>`SELECT current_database() AS db`
  const tables = await prisma.$queryRaw<{ table_name: string }[]>`
    SELECT table_name FROM information_schema.tables
    WHERE table_schema = 'ld_erp' AND table_type = 'BASE TABLE' ORDER BY table_name`
  const data: Record<string, unknown[]> = {}
  let rows = 0
  await prisma.$transaction(
    async (tx) => {
      for (const t of tables) {
        const r = await tx.$queryRawUnsafe<unknown[]>(`SELECT * FROM ld_erp."${t.table_name}"`)
        data[t.table_name] = r
        rows += r.length
      }
    },
    { isolationLevel: 'RepeatableRead', timeout: 300_000, maxWait: 60_000 },
  )
  writeFileSync(
    out,
    JSON.stringify({ takenAt: new Date().toISOString(), database: db, schema: 'ld_erp', tables: data }, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)),
  )
  console.log(`Backed up ${tables.length} tables, ${rows} rows of ${db} → ${out}`)
}

main()
  .catch((e) => {
    console.error(String((e as Error).message ?? e).replace(/postgres(ql)?:\/\/\S+/g, '[address hidden]'))
    process.exitCode = 1
  })
  .finally(() => prisma.$disconnect())
