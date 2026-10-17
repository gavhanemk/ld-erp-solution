// Puts the DEMO database back to masters only: every table emptied, every
// sequence back to its start, then the masters copied fresh from live (read
// only). Refuses to run against anything but the local demo database.
//   LIVE_DIRECT_URL=… npm run db:reset
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { demoDb, required } from '../lib/demo.mjs'

// Checked before anything is emptied, so a missing source never leaves the demo bare.
required('LIVE_DIRECT_URL', 'the live database the masters are copied from, read only')
const c = await demoDb()
const tables = (await c.query(`SELECT tablename FROM pg_tables WHERE schemaname = 'ld_erp' AND tablename <> '_prisma_migrations'`)).rows.map((r) => r.tablename)
await c.query(`TRUNCATE ${tables.map((t) => `ld_erp."${t}"`).join(', ')} RESTART IDENTITY CASCADE`)
const seqs = (await c.query(`SELECT sequencename FROM pg_sequences WHERE schemaname = 'ld_erp'`)).rows.map((r) => r.sequencename)
for (const s of seqs) await c.query(`ALTER SEQUENCE ld_erp."${s}" RESTART`)
await c.end()
console.log(`emptied ${tables.length} tables, restarted ${seqs.length} sequences`)
const copy = fileURLToPath(new URL('./copy-masters.mjs', import.meta.url))
console.log(execFileSync(process.execPath, [copy], { encoding: 'utf8' }).trim().split('\n').slice(-2).join(' '))
