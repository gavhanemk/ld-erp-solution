// A Postgres of its own for the demo: data in e2e/demo-db/data, port 5433, nothing shared.
//   npm run db:start -- --init    the first time: makes the data folder and the lderp_demo database
//   npm run db:start              every time after; Ctrl+C stops it
import EmbeddedPostgres from 'embedded-postgres'
import { fileURLToPath } from 'node:url'

const databaseDir = fileURLToPath(new URL('./data', import.meta.url))
const pg = new EmbeddedPostgres({ databaseDir, user: 'postgres', password: 'demo', port: 5433, persistent: true, initdbFlags: ['--encoding=UTF8', '--locale=C', '--lc-messages=C'] })
const fresh = process.argv.includes('--init')
if (fresh) await pg.initialise()
await pg.start()
if (fresh) await pg.createDatabase('lderp_demo')
console.log('demo postgres up on 5433 (database lderp_demo); Ctrl+C to stop')
process.on('SIGINT', async () => { await pg.stop(); process.exit(0) })
setInterval(() => {}, 1 << 30)
