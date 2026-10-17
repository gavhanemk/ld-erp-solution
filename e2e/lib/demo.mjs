// What every script here shares: where the demo is, and the guards that keep
// the tests on it. These tests WRITE data, so they run only against the local
// demo database (named lderp_demo) and an API that is using it.
import pg from 'pg'

export const DEMO_DB_NAME = 'lderp_demo'
export const API = (process.env.E2E_API || 'http://localhost:5101/api').replace(/\/+$/, '')
export const WEB = (process.env.E2E_WEB || 'http://localhost:3301').replace(/\/+$/, '')
export const DB_URL = process.env.E2E_DB || 'postgresql://postgres:demo@localhost:5433/lderp_demo'

const stop = (msg) => {
  console.error(msg)
  process.exit(2)
}
// Exiting straight after a network call can trip a Node assertion on Windows
// while its sockets close (the run then ends with code 127); a moment's wait
// lets them finish first. Every suite ends through this.
export const exit = async (code) => {
  await new Promise((r) => setTimeout(r, 1000))
  process.exit(code)
}
const halt = async (msg) => {
  console.error(msg)
  await exit(2)
}

/** An environment variable that must be set; there is no default. */
export function required(name, why = '') {
  const v = process.env[name]
  if (!v) stop(`${name} is not set${why ? ` (${why})` : ''}. Set it in your shell for this run; never write it into a file.`)
  return v
}

/** Connects to the demo database and refuses any database not named lderp_demo. */
export async function demoDb(url = DB_URL) {
  const db = new pg.Client({ connectionString: url })
  try {
    await db.connect()
  } catch (e) {
    await halt(`Cannot reach the demo database (${e.message}). Start it with "npm run db:start".`)
  }
  const { rows } = await db.query('SELECT current_database() AS d')
  if (rows[0].d !== DEMO_DB_NAME) {
    await db.end()
    await halt(`Refusing to run: the database is "${rows[0].d}", not ${DEMO_DB_NAME}. These tests write data and run only on the local demo.`)
  }
  await db.query('SET search_path TO ld_erp')
  return db
}

/** Signs in through the API; the access token, or null when refused. */
export async function login(email, password) {
  let r
  try {
    r = await fetch(`${API}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json', connection: 'close' }, body: JSON.stringify({ email, password }) })
  } catch (e) {
    await halt(`Cannot reach the API at ${API} (${e.message}). Start the demo API first.`)
  }
  const j = await r.json().catch(() => null)
  return j?.accessToken ?? null
}

/**
 * Signs in as E2E_EMAIL / E2E_PASSWORD, and proves the API is using this demo
 * database: a sign-in stamps the user's lastLoginAt in the API's database, so
 * the stamp must move here. If it does not, the API is on another database and
 * nothing is written.
 */
export async function adminLogin(db) {
  const email = required('E2E_EMAIL', 'the sign-in for the tests')
  const password = required('E2E_PASSWORD', 'the sign-in for the tests')
  const stamp = async () => (await db.query(`SELECT "lastLoginAt" AS t FROM users WHERE lower(email) = lower($1)`, [email])).rows[0]
  const before = await stamp()
  if (!before) await halt(`${email} is not a user in the demo database. Copy the masters first ("npm run db:copy-masters").`)
  const token = await login(email, password)
  if (!token) await halt(`Sign-in refused for ${email} at ${API}: check E2E_EMAIL and E2E_PASSWORD.`)
  const after = await stamp()
  if (!after?.t || (before.t && after.t.getTime() <= before.t.getTime()))
    await halt(`Refusing to run: the API at ${API} did not record the sign-in in the demo database, so it is using another database. Start it with DATABASE_URL and DIRECT_URL set to the demo.`)
  return token
}

// The test users some suites sign in as: a store keeper who receives but cannot
// approve, a QC checker with the same rights, and a sales manager who approves
// orders but not stock. Made in the demo if missing, with E2E_STAFF_PASSWORD
// (or, when that is not set, E2E_PASSWORD).
const STAFF_ROLES = {
  'ZZTEST Store Keeper': {
    description: 'Demo test: receives, cannot approve',
    permissions: ['inventory:create', 'inventory:edit', 'inventory:view', 'sales:view'],
  },
  'ZZTEST Sales Manager': {
    description: 'Demo only: approves orders, not stock',
    permissions: ['inventory:view', 'sales:approve', 'sales:create', 'sales:delete', 'sales:edit', 'sales:export', 'sales:post', 'sales:view'],
  },
}
const STAFF = {
  KEEPER: { email: 'zztest.keeper@ldcottonmills.com', name: 'ZZTEST Keeper', role: 'ZZTEST Store Keeper' },
  QC: { email: 'zztest.qc@ldcottonmills.com', name: 'ZZTEST QC Checker', role: 'ZZTEST Store Keeper' },
  SALES: { email: 'zztest.sales@ldcottonmills.com', name: 'ZZTEST Sales Manager', role: 'ZZTEST Sales Manager' },
}

/** Makes sure the test users exist (through the API, as the admin) and signs each in: { KEEPER, QC, SALES }. */
export async function staffLogins(adminToken) {
  const password = process.env.E2E_STAFF_PASSWORD || required('E2E_PASSWORD')
  const call = async (m, p, b) => {
    const r = await fetch(`${API}${p}`, { method: m, headers: { 'content-type': 'application/json', connection: 'close', authorization: `Bearer ${adminToken}` }, body: b ? JSON.stringify(b) : undefined })
    return { status: r.status, body: await r.json().catch(() => null) }
  }
  const roles = await call('GET', '/settings/roles')
  if (roles.status !== 200) await halt(`Cannot list roles (${roles.status}): E2E_EMAIL must be an administrator.`)
  const roleId = {}
  for (const r of roles.body.data) roleId[r.name] = r.id
  for (const [name, def] of Object.entries(STAFF_ROLES)) {
    if (roleId[name]) continue
    const made = await call('POST', '/settings/roles', { name, ...def })
    if (made.status !== 201) await halt(`Could not make the test role ${name}: ${made.status} ${made.body?.message ?? ''}`)
    roleId[name] = made.body.data.id
    console.log(`setup: made the test role ${name}`)
  }
  const users = await call('GET', '/settings/users?q=zztest')
  const have = new Set((users.body?.data ?? []).map((u) => u.email.toLowerCase()))
  const tokens = {}
  for (const [key, u] of Object.entries(STAFF)) {
    if (!have.has(u.email)) {
      const made = await call('POST', '/settings/users', { name: u.name, email: u.email, password, roleId: roleId[u.role] })
      if (made.status !== 201) await halt(`Could not make the test user ${u.email}: ${made.status} ${made.body?.message ?? ''}`)
      console.log(`setup: made the test user ${u.email}`)
    }
    tokens[key] = await login(u.email, password)
    if (!tokens[key]) await halt(`Sign-in refused for the test user ${u.email}. It already exists in the demo with another password: set E2E_STAFF_PASSWORD to it.`)
  }
  return tokens
}
