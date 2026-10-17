// Copies the masters from the live database into the demo database.
//   LIVE_DIRECT_URL=… npm run db:copy-masters
//
// The live side is opened READ ONLY: the session refuses any write, so this
// script cannot change live data even by mistake. The demo side has its
// master tables emptied first, then filled with exactly what live holds.
// Number series start again from nought in the demo. It refuses to run unless
// the target is the local demo database (lderp_demo), and refuses a source
// that is the demo itself.
import pg from 'pg'
import { MASTERS } from './masters.mjs'
import { DEMO_DB_NAME, demoDb, required } from '../lib/demo.mjs'

const direct = required('LIVE_DIRECT_URL', 'the live database the masters are copied from, read only').replace(/\?.*$/, '')

const demo = await demoDb()
const live = new pg.Client({ connectionString: direct, ssl: { rejectUnauthorized: false } })
await live.connect()
await live.query('BEGIN TRANSACTION READ ONLY')
if ((await live.query('SELECT current_database() AS d')).rows[0].d === DEMO_DB_NAME) {
  console.error('LIVE_DIRECT_URL points at the demo database itself: refusing to copy it onto itself.')
  process.exit(2)
}

const q = (s) => `"${s}"`
const colsOf = async (client, table) =>
  (await client.query(`SELECT column_name, data_type FROM information_schema.columns WHERE table_schema = 'ld_erp' AND table_name = $1 ORDER BY ordinal_position`, [table])).rows

await demo.query('BEGIN')
// Foreign keys are checked at the end of a normal load; replica mode lets the
// tables go in any order. Every master is copied, so nothing is left dangling.
await demo.query('SET session_replication_role = replica')
await demo.query(`TRUNCATE ${MASTERS.map((t) => `ld_erp.${q(t)}`).join(', ')} CASCADE`)

const summary = []
for (const table of MASTERS) {
  const demoCols = await colsOf(demo, table)
  const liveCols = new Set((await colsOf(live, table)).map((c) => c.column_name))
  const cols = demoCols.filter((c) => liveCols.has(c.column_name))
  const missing = demoCols.filter((c) => !liveCols.has(c.column_name)).map((c) => c.column_name)
  const isJson = cols.map((c) => c.data_type === 'json' || c.data_type === 'jsonb')
  // JSON read as its text, so a JSON null stays a JSON null rather than turning into no value.
  const { rows } = await live.query(`SELECT ${cols.map((c, j) => (isJson[j] ? `${q(c.column_name)}::text AS ${q(c.column_name)}` : q(c.column_name))).join(', ')} FROM ld_erp.${q(table)}`)
  for (let i = 0; i < rows.length; i += 200) {
    const chunk = rows.slice(i, i + 200)
    const params = []
    const tuples = chunk.map((r) => {
      const ph = cols.map((c) => {
        params.push(r[c.column_name])
        return `$${params.length}`
      })
      return `(${ph.join(', ')})`
    })
    await demo.query(`INSERT INTO ld_erp.${q(table)} (${cols.map((c) => q(c.column_name)).join(', ')}) VALUES ${tuples.join(', ')}`, params)
  }
  summary.push(`${table}=${rows.length}${missing.length ? ` (defaults for: ${missing.join(', ')})` : ''}`)
}
// Every document number starts again in the demo: SO-2627-0001, MO-2627-0001…
const reset = await demo.query('UPDATE ld_erp.number_series SET "lastNumber" = 0')
await demo.query('COMMIT')
await live.query('ROLLBACK')
await live.end()
await demo.end()
console.log(summary.join('\n'))
console.log(`number series reset: ${reset.rowCount}`)
