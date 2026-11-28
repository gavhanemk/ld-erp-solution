/**
 * Restores a backup made by backup-db.ts into a SCRATCH database, to prove the
 * backup is whole before a live migration: the deployment checklist's restore
 * test. It refuses any host but localhost and any database whose name does not
 * start with lderp_restore, so it can never write to live or to the demo.
 *
 * The scratch database is first brought to the same migrations with
 * `prisma migrate deploy`. Then every table is emptied and filled from the
 * backup in one transaction, with the database's own triggers and foreign keys
 * held off for the load (session_replication_role = replica) and on again
 * after; each table's row count is then compared with the backup's. Compare
 * the reconciliation snapshots of the source and the copy after it
 * (tools/reconcile-snapshot.ts take, then compare): no difference = a backup
 * that restores.
 *
 * From apps/api, with DATABASE_URL set to the scratch database:
 *
 *   npx tsx ../../tools/restore-db.ts <backup.json>
 */
import { readFileSync } from 'node:fs'
import { prisma } from '../packages/database/src/index'

async function main() {
  const file = process.argv[2]
  if (!file) throw new Error('Usage: restore-db.ts <backup.json>')
  const url = new URL(process.env.DATABASE_URL ?? '')
  const name = url.pathname.replace(/^\//, '')
  if (url.hostname !== 'localhost' || !name.startsWith('lderp_restore')) {
    throw new Error('Refusing to run: a backup is restored only into a local scratch database named lderp_restore…')
  }
  const [{ db }] = await prisma.$queryRaw<{ db: string }[]>`SELECT current_database() AS db`
  if (db !== name) throw new Error('Refusing to run: connected to another database than the one named')

  const backup = JSON.parse(readFileSync(file, 'utf8')) as { takenAt: string; database: string; tables: Record<string, Record<string, unknown>[]> }
  // The migrations' own record stays as migrate deploy wrote it here.
  const tables = Object.keys(backup.tables).filter((t) => t !== '_prisma_migrations')
  const here = new Set(
    (await prisma.$queryRaw<{ table_name: string }[]>`SELECT table_name FROM information_schema.tables WHERE table_schema = 'ld_erp' AND table_type = 'BASE TABLE'`).map((r) => r.table_name),
  )
  const missing = tables.filter((t) => !here.has(t))
  if (missing.length) throw new Error(`The scratch database has no ${missing.slice(0, 5).join(', ')}${missing.length > 5 ? '…' : ''}: run migrate deploy on it first`)

  const ident = (t: string) => `ld_erp."${t.replace(/"/g, '""')}"`
  // A JSON column that may not be empty, read as null, held JSON's own null: it goes back as that.
  const columns = await prisma.$queryRaw<Array<{ t: string; c: string; json: boolean; required: boolean }>>`
    SELECT table_name t, column_name c, data_type IN ('json', 'jsonb') json, is_nullable = 'NO' required
    FROM information_schema.columns WHERE table_schema = 'ld_erp' ORDER BY table_name, ordinal_position`
  const selectList = (t: string) =>
    columns
      .filter((x) => x.t === t)
      .map((x) => (x.json && x.required ? `COALESCE(r."${x.c}", 'null'::jsonb)` : `r."${x.c}"`))
      .join(', ')
  await prisma.$transaction(
    async (tx) => {
      // The load bypasses triggers and foreign keys, so the order of tables does not matter; both are back at commit.
      await tx.$executeRawUnsafe(`SET LOCAL session_replication_role = replica`)
      // Emptied first: migrations seed some rows that the backup holds too.
      await tx.$executeRawUnsafe(`TRUNCATE ${tables.map(ident).join(', ')}`)
      for (const t of tables) {
        const rows = backup.tables[t]
        for (let i = 0; i < rows.length; i += 500) {
          // Each row back as it was read: Postgres turns the JSON into the table's own types.
          await tx.$executeRawUnsafe(`INSERT INTO ${ident(t)} SELECT ${selectList(t)} FROM json_populate_recordset(NULL::${ident(t)}, $1::json) r`, JSON.stringify(rows.slice(i, i + 500)))
        }
      }
    },
    { timeout: 900_000, maxWait: 60_000 },
  )

  let differ = 0
  let total = 0
  for (const t of tables) {
    const [{ n }] = await prisma.$queryRawUnsafe<{ n: number }[]>(`SELECT COUNT(*)::int AS n FROM ${ident(t)}`)
    total += n
    if (n !== backup.tables[t].length) {
      differ++
      console.log(`${t}: ${n} rows here, ${backup.tables[t].length} in the backup`)
    }
  }
  console.log(`Restored ${tables.length} tables, ${total} rows, from ${backup.database} as it was at ${backup.takenAt}: ${differ ? `${differ} tables differ` : "every table holds the backup's rows"}`)
  if (differ) process.exitCode = 1
}

main()
  .catch((e) => {
    // Neither the address nor a refused row's values (a setting may hold a key) are printed.
    console.error(String((e as Error).message ?? e).replace(/postgres(ql)?:\/\/\S+/g, '[address hidden]').replace(/Failing row contains \(.*?\)\.?/g, 'Failing row contains (values hidden).'))
    process.exitCode = 1
  })
  .finally(() => prisma.$disconnect())
