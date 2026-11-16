// Local file storage checks (lib/storage.ts with STORAGE_DRIVER=local, and
// routes/localFiles.routes.ts). No database: the URLs below are only strings
// the pilot gate reads, and nothing here opens a connection. Files go to a
// fresh folder under .local-sampling/check-files, removed at the end.
const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const http = require('node:http')
const path = require('node:path')
const v8 = require('node:v8')
const vm = require('node:vm')

// The garbage collector, without needing `node --expose-gc` on the command
// line, so the plain `node tools/check-local-storage.cjs` covers downloads
// cut short (see that section).
v8.setFlagsFromString('--expose-gc')
const gc = vm.runInNewContext('gc')

const repo = path.resolve(__dirname, '..')
const PILOT_DB = 'postgresql://postgres@127.0.0.1:55439/lderp_sampling?schema=ld_erp'
const SHARED_DB = 'postgresql://someone@db.example.supabase.co:5432/postgres'
const SECRET = 'check-local-storage-only-' + crypto.randomBytes(24).toString('hex')

process.env.SAMPLING_ENABLED = 'true'
process.env.NODE_ENV = 'test'
process.env.DATABASE_URL = PILOT_DB
process.env.DIRECT_URL = PILOT_DB
process.env.STORAGE_DRIVER = 'local'
process.env.LOCAL_STORAGE_SECRET = SECRET
// The non-local path must not reach anywhere real while it is being checked.
delete process.env.SUPABASE_URL
delete process.env.SUPABASE_SERVICE_ROLE_KEY

const checkFiles = path.join(repo, '.local-sampling', 'check-files')
fs.mkdirSync(checkFiles, { recursive: true })
const root = fs.mkdtempSync(path.join(checkFiles, 'run-'))
// Given relative to the repo, and the working directory is moved to apps/api
// below (where `pnpm dev` runs the API), to prove the folder is found from the
// repo rather than from wherever the API happened to start.
process.env.LOCAL_STORAGE_DIR = path.relative(repo, root).split(path.sep).join('/')

require('./register-ts.cjs')
const express = require('express')
const storage = require('../apps/api/src/lib/storage.ts')
const { samplingPilotEnabled } = require('../apps/api/src/lib/pilot.ts')
const router = require('../apps/api/src/routes/localFiles.routes.ts').default

const MAX = storage.MAX_FILE_BYTES
let passed = 0
let server
const startedIn = process.cwd()

async function check(label, fn) {
  await fn()
  passed++
  console.log('PASS ' + label)
}

const now = () => Math.floor(Date.now() / 1000)
const nonce = () => crypto.randomBytes(16).toString('base64url')
const forge = (payload, secret = SECRET) => {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url')
  return body + '.' + crypto.createHmac('sha256', secret).update(body).digest('base64url')
}
const tokenOf = (url) => new URL(url).searchParams.get('token')
const payloadOf = (url) => JSON.parse(Buffer.from(tokenOf(url).split('.')[0], 'base64url'))
const flip = (s, i) => s.slice(0, i) + (s[i] === 'A' ? 'B' : 'A') + s.slice(i + 1)
const onDisk = (key) => path.join(root, ...key.split('/'))
const newKey = (name, folder = 'sales-orders', doc = 'so-check-1') =>
  storage.storagePathFor(folder, doc, name)

async function rejectsWith(promiseOrFn, statusCode, code) {
  await assert.rejects(promiseOrFn, (err) => {
    assert.equal(err.statusCode, statusCode, `${err.code}: ${err.message}`)
    assert.equal(err.code, code)
    assert.ok(err.message.length > 0)
    return true
  })
}

async function refused(res, status, code) {
  const body = await res.json()
  assert.equal(res.status, status, JSON.stringify(body))
  assert.equal(body.success, false)
  assert.equal(body.code, code)
  assert.equal(typeof body.message, 'string')
  assert.ok(body.message.length > 0)
}

const put = (url, body, type = 'application/pdf') =>
  fetch(url, { method: 'PUT', headers: type ? { 'Content-Type': type } : {}, body })

/** A request with headers exactly as given; resolves on the response, not on the upload. */
function rawRequest(url, { method = 'PUT', headers = {}, chunks = [], end = true } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method, headers }, (res) => {
      const parts = []
      res.on('data', (c) => parts.push(c))
      res.on('end', () => {
        const text = Buffer.concat(parts).toString('utf8')
        resolve({ status: res.statusCode, headers: res.headers, body: text ? JSON.parse(text) : null })
        if (!end) req.destroy()
      })
    })
    req.on('error', (err) => (err.code === 'ECONNRESET' ? undefined : reject(err)))
    for (const c of chunks) req.write(c)
    if (end) req.end()
  })
}

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** Opens a download and hangs up as soon as the first piece of the file arrives. */
function cutShortAfterFirstPiece(url) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      res.on('error', () => {})
      res.once('data', () => {
        req.destroy()
        resolve(res.statusCode)
      })
      res.once('end', () => resolve(res.statusCode))
    })
    req.on('error', (err) => (err.code === 'ECONNRESET' ? undefined : reject(err)))
  })
}

/** Asks for a download and hangs up before any answer, while the file is still being opened. */
function leaveBeforeAnswer(url) {
  return new Promise((resolve) => {
    const req = http.get(url)
    req.on('error', () => {})
    req.on('close', resolve)
    req.on('socket', (socket) => socket.once('connect', () => setImmediate(() => req.destroy())))
  })
}

function filesUnder(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
    const full = path.join(dir, d.name)
    return d.isDirectory() ? filesUnder(full) : [full]
  })
}

async function withEnv(changes, fn) {
  const saved = {}
  for (const k of Object.keys(changes)) {
    saved[k] = process.env[k]
    if (changes[k] === undefined) delete process.env[k]
    else process.env[k] = changes[k]
  }
  try {
    await fn()
  } finally {
    for (const k of Object.keys(saved)) {
      if (saved[k] === undefined) delete process.env[k]
      else process.env[k] = saved[k]
    }
  }
}

async function main() {
  const app = express()
  app.use('/api/local-files', router)
  // As in index.ts: the JSON parser comes after the file routes.
  app.use(express.json({ limit: '10mb' }))
  app.use((req, res) => res.status(404).json({ error: 'Route not found' }))
  server = app.listen(0, '127.0.0.1')
  await new Promise((resolve) => server.once('listening', resolve))
  const origin = `http://127.0.0.1:${server.address().port}`
  const base = `${origin}/api/local-files`
  process.env.LOCAL_STORAGE_BASE_URL = base
  process.chdir(path.join(repo, 'apps', 'api'))

  // ── The gate ──────────────────────────────────────────────────────────────
  await check('local driver is on with the pilot gate open', () => {
    assert.equal(samplingPilotEnabled(), true)
    assert.equal(storage.localStorageActive(), true)
    assert.equal(storage.storageConfigured(), true)
  })
  await check('sampling routes ask the same gate as file storage', () => {
    const src = fs.readFileSync(path.join(repo, 'apps/api/src/routes/sampling.routes.ts'), 'utf8')
    assert.match(src, /import \{ samplingPilotEnabled \} from '\.\.\/lib\/pilot'/)
    assert.match(src, /export function samplingEnabled\(\) \{\s*return samplingPilotEnabled\(\)\s*\}/)
  })

  // ── Upload, measure, download ─────────────────────────────────────────────
  const key1 = newKey('Buyer quote.pdf')
  const bytes1 = crypto.randomBytes(4096)
  const { uploadUrl: up1 } = await storage.signedUploadUrl(key1)
  await check('upload link points at the local routes and lives two hours', () => {
    assert.ok(up1.startsWith(base + '/put?token='), up1)
    const p = payloadOf(up1)
    assert.equal(p.op, 'put')
    assert.equal(p.path, key1)
    assert.equal(p.maxBytes, MAX)
    assert.equal(MAX, 50 * 1024 * 1024)
    assert.ok(p.exp - now() > 7200 - 10 && p.exp - now() <= 7200, String(p.exp - now()))
  })
  let r = await put(up1, bytes1)
  await check('file sent to the signed link with no auth header is accepted', async () => {
    assert.equal(r.status, 200)
    assert.equal((await r.json()).success, true)
  })
  await check('statObject measures the file on disk and returns the type it was sent as', async () => {
    assert.deepEqual(await storage.statObject(key1), { sizeBytes: 4096, mimeType: 'application/pdf' })
  })
  await check('relative LOCAL_STORAGE_DIR is read from the repo, not the working directory', () => {
    assert.ok(fs.existsSync(onDisk(key1)))
    assert.ok(!fs.existsSync(path.join(process.cwd(), process.env.LOCAL_STORAGE_DIR)))
    assert.deepEqual(fs.readFileSync(onDisk(key1)), bytes1)
  })

  const down1 = await storage.signedDownloadUrl(key1)
  await check('download link points at the local routes and lives 300 seconds', () => {
    assert.ok(down1.startsWith(base + '/get?token='), down1)
    const p = payloadOf(down1)
    assert.equal(p.op, 'get')
    assert.ok(p.exp - now() > 290 && p.exp - now() <= 300)
  })
  r = await fetch(down1)
  await check('download returns the same bytes with safe headers', async () => {
    assert.equal(r.status, 200)
    assert.deepEqual(Buffer.from(await r.arrayBuffer()), bytes1)
    assert.equal(r.headers.get('x-content-type-options'), 'nosniff')
    assert.equal(r.headers.get('content-disposition'), 'attachment; filename="Buyer-quote.pdf"')
    assert.equal(r.headers.get('content-type'), 'application/pdf')
    assert.equal(r.headers.get('content-length'), '4096')
    assert.match(r.headers.get('cache-control'), /no-store/)
  })
  r = await fetch(down1)
  await check('download link can be opened again until it expires', async () => {
    assert.equal(r.status, 200)
    assert.deepEqual(Buffer.from(await r.arrayBuffer()), bytes1)
  })

  // ── Downloads cut short ───────────────────────────────────────────────────
  // Closing the tab, cancelling the Save dialog or a dropped connection must
  // still close the file. From Node 26 an open file swept up by the garbage
  // collector is an uncaught error that stops the whole API, at some later
  // moment nobody can tie back to the download. The file is big enough that
  // it cannot all be sent before the hang-up; the collector is then run by
  // hand so a file left open shows up here, under this check's name.
  const bigKey = newKey('Tech pack scan.pdf')
  const { uploadUrl: bigUp } = await storage.signedUploadUrl(bigKey)
  r = await put(bigUp, Buffer.alloc(16 * 1024 * 1024, 7))
  assert.equal(r.status, 200, JSON.stringify(await r.json()))
  const bigDown = await storage.signedDownloadUrl(bigKey)
  const leftOpen = []
  const noteLeftOpen = (err) => leftOpen.push(`${err.code}: ${err.message}`)
  process.on('uncaughtException', noteLeftOpen)
  const cutStatuses = []
  try {
    for (let i = 0; i < 3; i++) cutStatuses.push(await cutShortAfterFirstPiece(bigDown))
    for (let i = 0; i < 3; i++) await leaveBeforeAnswer(bigDown)
    await pause(150)
    for (let i = 0; i < 3; i++) {
      gc()
      await pause(50)
    }
  } finally {
    process.off('uncaughtException', noteLeftOpen)
  }
  await check('downloads cut short, mid-file or before the answer, leave no file open', () => {
    assert.deepEqual(cutStatuses, [200, 200, 200])
    assert.deepEqual(leftOpen, [])
  })
  r = await fetch(bigDown)
  await check('the same link still downloads the whole file after the hang-ups', async () => {
    assert.equal(r.status, 200)
    assert.equal(Buffer.from(await r.arrayBuffer()).length, 16 * 1024 * 1024)
  })

  // ── One use ───────────────────────────────────────────────────────────────
  r = await put(up1, crypto.randomBytes(10))
  await check('upload link refused the second time, file untouched', async () => {
    await refused(r, 409, 'LINK_USED')
    assert.deepEqual(fs.readFileSync(onDisk(key1)), bytes1)
  })
  const again = await storage.signedUploadUrl(key1)
  r = await put(again.uploadUrl, crypto.randomBytes(10))
  await check('a fresh link to a path already holding a file does not overwrite it', async () => {
    await refused(r, 409, 'ALREADY_UPLOADED')
    assert.deepEqual(fs.readFileSync(onDisk(key1)), bytes1)
  })
  const key2 = newKey('race.pdf')
  const { uploadUrl: up2 } = await storage.signedUploadUrl(key2)
  const race = await Promise.all([put(up2, Buffer.from('first')), put(up2, Buffer.from('second'))])
  await check('two sends on one link at once: exactly one is written', () => {
    assert.deepEqual(race.map((x) => x.status).sort(), [200, 409])
    assert.ok(['first', 'second'].includes(fs.readFileSync(onDisk(key2), 'utf8')))
  })

  // ── Forged and stale links ────────────────────────────────────────────────
  const key3 = newKey('tamper.pdf')
  const { uploadUrl: up3 } = await storage.signedUploadUrl(key3)
  const [body3, sig3] = tokenOf(up3).split('.')
  r = await put(`${base}/put?token=${body3}.${flip(sig3, 10)}`, Buffer.from('x'))
  await check('tampered signature refused', async () => {
    await refused(r, 403, 'LINK_INVALID')
    assert.ok(!fs.existsSync(onDisk(key3)))
  })
  const moved = { ...payloadOf(up3), path: newKey('elsewhere.pdf'), exp: now() + 99999 }
  r = await put(`${base}/put?token=${Buffer.from(JSON.stringify(moved)).toString('base64url')}.${sig3}`, Buffer.from('x'))
  await check('payload changed under the old signature refused', async () => {
    await refused(r, 403, 'LINK_INVALID')
    assert.ok(!fs.existsSync(onDisk(moved.path)))
  })
  r = await put(`${base}/put?token=${forge(payloadOf(up3), 'another-secret-of-more-than-32-characters')}`, Buffer.from('x'))
  await check('link signed with another key refused', () => refused(r, 403, 'LINK_INVALID'))
  r = await put(`${base}/put`, Buffer.from('x'))
  await check('link without a token refused', () => refused(r, 403, 'LINK_INVALID'))
  r = await put(`${base}/put?token=${tokenOf(up3)}&token=${tokenOf(up3)}`, Buffer.from('x'))
  await check('token given twice refused', () => refused(r, 403, 'LINK_INVALID'))
  r = await put(up3, Buffer.from('genuine'))
  await check('refused forgeries do not spend the genuine link', async () => {
    assert.equal(r.status, 200)
    assert.equal(fs.readFileSync(onDisk(key3), 'utf8'), 'genuine')
  })
  r = await fetch(`${base}/get?token=${flip(tokenOf(down1), 20)}`)
  await check('tampered download link refused', () => refused(r, 403, 'LINK_INVALID'))

  const key4 = newKey('late.pdf')
  r = await put(`${base}/put?token=${forge({ op: 'put', path: key4, exp: now() - 1, nonce: nonce(), maxBytes: MAX })}`, Buffer.from('x'))
  await check('expired upload link refused', async () => {
    await refused(r, 403, 'LINK_EXPIRED')
    assert.ok(!fs.existsSync(onDisk(key4)))
  })
  r = await fetch(`${base}/get?token=${forge({ op: 'get', path: key1, exp: now() - 1, nonce: nonce() })}`)
  await check('expired download link refused', () => refused(r, 403, 'LINK_EXPIRED'))

  r = await put(`${base}/put?token=${tokenOf(down1)}`, Buffer.from('x'))
  await check('download link cannot be used to send a file', async () => {
    await refused(r, 403, 'LINK_WRONG_USE')
    assert.deepEqual(fs.readFileSync(onDisk(key1)), bytes1)
  })
  const { uploadUrl: up4 } = await storage.signedUploadUrl(key4)
  r = await fetch(`${base}/get?token=${tokenOf(up4)}`)
  await check('upload link cannot be used to open a file', () => refused(r, 403, 'LINK_WRONG_USE'))
  r = await put(`${base}/put?token=${forge({ op: 'delete', path: key4, exp: now() + 60, nonce: nonce(), maxBytes: MAX })}`, Buffer.from('x'))
  await check('unknown link purpose refused', () => refused(r, 403, 'LINK_WRONG_USE'))

  // ── Paths ─────────────────────────────────────────────────────────────────
  const badPaths = [
    '../evil.txt',
    'sales-orders/../../evil.txt',
    'sales-orders/so-check-1/..',
    '/etc/passwd',
    'C:/Windows/win.ini',
    'sales-orders\\..\\..\\evil.txt',
    'sales-orders//x.pdf',
    'sales-orders/so-check-1/',
    'sales-orders/so-check-1/a\0b.pdf',
    'sales-orders/./x.pdf',
    '.meta/sales-orders/so-check-1/x.pdf.json',
    'sales-orders/so-check-1/.hidden',
    'sales-orders/so-check-1/NUL',
    'sales-orders/so-check-1/con.txt',
    'sales-orders/so-check-1/file.pdf.',
    'sales-orders/so-check-1/file.pdf ',
    'sales-orders/so-check-1/a.pdf:stream',
    'sales-orders/so-check-1/%2e%2e',
    '',
  ]
  for (const bad of badPaths) {
    await rejectsWith(storage.signedUploadUrl(bad), 400, 'BAD_STORAGE_PATH')
    await rejectsWith(storage.signedDownloadUrl(bad), 400, 'BAD_STORAGE_PATH')
    await rejectsWith(storage.statObject(bad), 400, 'BAD_STORAGE_PATH')
    await rejectsWith(storage.removeObject(bad), 400, 'BAD_STORAGE_PATH')
    await rejectsWith(storage.copyObject(key1, bad), 400, 'BAD_STORAGE_PATH')
    await rejectsWith(storage.copyObject(bad, newKey('copy.pdf')), 400, 'BAD_STORAGE_PATH')
  }
  await check(`unsafe paths refused when signing and when used (${badPaths.length} paths x 6 calls)`, () => {})

  const outside = path.join(root, '..', `outside-${process.pid}.txt`)
  r = await put(`${base}/put?token=${forge({ op: 'put', path: `../${path.basename(outside)}`, exp: now() + 60, nonce: nonce(), maxBytes: MAX })}`, Buffer.from('escape'))
  await check('validly signed link to a path outside the folder refused', async () => {
    await refused(r, 400, 'BAD_STORAGE_PATH')
    assert.ok(!fs.existsSync(outside))
  })
  r = await put(`${base}/put?token=${forge({ op: 'put', path: 'sales-orders\\..\\..\\..\\escape.txt', exp: now() + 60, nonce: nonce(), maxBytes: MAX })}`, Buffer.from('escape'))
  await check('validly signed link using backslashes refused', () => refused(r, 400, 'BAD_STORAGE_PATH'))
  r = await fetch(`${base}/get?token=${forge({ op: 'get', path: '../../../package.json', exp: now() + 60, nonce: nonce() })}`)
  await check('validly signed download of a file outside the folder refused', () =>
    refused(r, 400, 'BAD_STORAGE_PATH')
  )
  r = await fetch(`${base}/get?token=${forge({ op: 'get', path: `.meta/${key1}.json`, exp: now() + 60, nonce: nonce() })}`)
  await check('stored file details cannot be downloaded', () => refused(r, 400, 'BAD_STORAGE_PATH'))

  // ── Size ──────────────────────────────────────────────────────────────────
  const key5 = newKey('small.pdf')
  const small = forge({ op: 'put', path: key5, exp: now() + 60, nonce: nonce(), maxBytes: 16 })
  r = await put(`${base}/put?token=${small}`, Buffer.alloc(17, 1))
  await check('file over the link limit refused on its declared length', async () => {
    await refused(r, 413, 'FILE_TOO_LARGE')
    assert.ok(!fs.existsSync(onDisk(key5)))
  })
  let raw = await rawRequest(`${base}/put?token=${small}`, {
    headers: { 'Content-Type': 'application/pdf', 'Transfer-Encoding': 'chunked' },
    chunks: [Buffer.alloc(9, 1), Buffer.alloc(8, 1)],
  })
  await check('file over the link limit refused when sent without a length', () => {
    assert.equal(raw.status, 413)
    assert.equal(raw.body.code, 'FILE_TOO_LARGE')
    assert.equal(raw.body.success, false)
    assert.ok(!fs.existsSync(onDisk(key5)))
  })
  r = await put(`${base}/put?token=${small}`, Buffer.alloc(16, 1))
  await check('refusals for size do not spend the link', async () => {
    assert.equal(r.status, 200)
    assert.equal(fs.statSync(onDisk(key5)).size, 16)
  })
  const key6 = newKey('huge.pdf')
  const { uploadUrl: up6 } = await storage.signedUploadUrl(key6)
  raw = await rawRequest(up6, {
    headers: { 'Content-Type': 'application/pdf', 'Content-Length': String(MAX + 1) },
    chunks: [Buffer.alloc(1024, 1)],
    end: false,
  })
  await check('file over 50MB refused before it is read', () => {
    assert.equal(raw.status, 413)
    assert.equal(raw.body.code, 'FILE_TOO_LARGE')
    assert.ok(!fs.existsSync(onDisk(key6)))
  })
  r = await put(`${base}/put?token=${forge({ op: 'put', path: key6, exp: now() + 60, nonce: nonce(), maxBytes: MAX + 1 })}`, Buffer.from('x'))
  await check('link claiming a limit over 50MB refused', () => refused(r, 403, 'LINK_INVALID'))
  const key7 = newKey('empty.pdf')
  const { uploadUrl: up7 } = await storage.signedUploadUrl(key7)
  r = await put(up7, Buffer.alloc(0))
  await check('empty file refused', async () => {
    await refused(r, 400, 'EMPTY_FILE')
    assert.ok(!fs.existsSync(onDisk(key7)))
  })
  r = await put(up7, Buffer.from('now with content'))
  await check('empty send does not spend the link', () => assert.equal(r.status, 200))

  // ── Types ─────────────────────────────────────────────────────────────────
  const key8 = newKey('settings.json')
  const json = Buffer.from('{"a": 1,\n  "b": [true]}\n')
  const { uploadUrl: up8 } = await storage.signedUploadUrl(key8)
  r = await put(up8, json, 'application/json')
  await check('a file sent as application/json is stored byte for byte, not parsed', async () => {
    assert.equal(r.status, 200)
    assert.deepEqual(fs.readFileSync(onDisk(key8)), json)
    assert.equal((await storage.statObject(key8)).mimeType, 'application/json')
  })
  r = await fetch(await storage.signedDownloadUrl(key8))
  await check('a type not on the safe list downloads as octet-stream', async () => {
    assert.equal(r.headers.get('content-type'), 'application/octet-stream')
    assert.deepEqual(Buffer.from(await r.arrayBuffer()), json)
  })
  const key9 = newKey('page.html')
  const { uploadUrl: up9 } = await storage.signedUploadUrl(key9)
  r = await put(up9, Buffer.from('<script>alert(1)</script>'), 'text/html')
  assert.equal(r.status, 200, JSON.stringify(await r.json()))
  r = await fetch(await storage.signedDownloadUrl(key9))
  await check('HTML is never served as a page', async () => {
    assert.equal(r.headers.get('content-type'), 'application/octet-stream')
    assert.equal(r.headers.get('x-content-type-options'), 'nosniff')
    assert.match(r.headers.get('content-disposition'), /^attachment; filename="page\.html"$/)
    await r.arrayBuffer()
  })
  const key10 = newKey('no-type.bin')
  const { uploadUrl: up10 } = await storage.signedUploadUrl(key10)
  raw = await rawRequest(up10, { headers: { 'Content-Length': '5' }, chunks: [Buffer.from('plain')] })
  await check('a file sent with no Content-Type is still read and stored', async () => {
    assert.equal(raw.status, 200, JSON.stringify(raw.body))
    assert.deepEqual(await storage.statObject(key10), { sizeBytes: 5, mimeType: null })
  })

  // ── Copy and remove ───────────────────────────────────────────────────────
  const copyKey = newKey('Buyer quote.pdf', 'purchase-orders', 'po-check-1')
  await storage.copyObject(key1, copyKey)
  await check('copyObject makes an independent copy with its type', async () => {
    assert.deepEqual(fs.readFileSync(onDisk(copyKey)), bytes1)
    assert.deepEqual(await storage.statObject(copyKey), { sizeBytes: 4096, mimeType: 'application/pdf' })
  })
  await check('copyObject never lands on a file already there', () =>
    rejectsWith(storage.copyObject(key2, copyKey), 502, 'STORAGE_FAILED')
  )
  await check('copyObject of a file that is not there is refused', () =>
    rejectsWith(storage.copyObject(newKey('missing.pdf'), newKey('copy.pdf')), 502, 'STORAGE_FAILED')
  )
  const copyLink = await storage.signedDownloadUrl(copyKey)
  await storage.removeObject(copyKey)
  await check('removeObject deletes the file and its stored details', async () => {
    assert.ok(!fs.existsSync(onDisk(copyKey)))
    assert.ok(!fs.existsSync(path.join(root, '.meta', ...copyKey.split('/')) + '.json'))
    await rejectsWith(storage.statObject(copyKey), 400, 'UPLOAD_NOT_FOUND')
    assert.deepEqual(fs.readFileSync(onDisk(key1)), bytes1)
  })
  r = await fetch(copyLink)
  await check('a link to a removed file says it is gone', () => refused(r, 404, 'FILE_NOT_FOUND'))
  await check('no download link is signed for a file that is not there', () =>
    rejectsWith(storage.signedDownloadUrl(copyKey), 502, 'STORAGE_FAILED')
  )
  await check('removing a file that is not there is refused as the bucket refuses it', () =>
    rejectsWith(storage.removeObject(copyKey), 502, 'STORAGE_FAILED')
  )
  await check('statObject of a file never sent says it never arrived', () =>
    rejectsWith(storage.statObject(newKey('never.pdf')), 400, 'UPLOAD_NOT_FOUND')
  )

  r = await fetch(`${base}/elsewhere`)
  await check('unknown address under the file routes answers 404 in the API shape', () =>
    refused(r, 404, 'NOT_FOUND')
  )
  await check('no half-written files left behind', () => {
    assert.deepEqual(filesUnder(root).filter((f) => f.endsWith('.part')), [])
  })

  // ── Driver off ────────────────────────────────────────────────────────────
  const key11 = newKey('while-off.pdf')
  const { uploadUrl: up11 } = await storage.signedUploadUrl(key11)
  const offCases = [
    ['NODE_ENV=production', { NODE_ENV: 'production' }],
    ['DATABASE_URL not the pilot', { DATABASE_URL: SHARED_DB }],
    ['DIRECT_URL not the pilot', { DIRECT_URL: SHARED_DB }],
    [
      'a ?host= override on a loopback-looking URL',
      { DATABASE_URL: 'postgresql://postgres@127.0.0.1:55439/lderp_sampling?schema=ld_erp&host=db.example.supabase.co' },
    ],
    [
      'a ?hostaddr= override on a loopback-looking URL',
      { DIRECT_URL: 'postgresql://postgres@localhost:55439/lderp_sampling?HostAddr=10.0.0.5' },
    ],
    ['SAMPLING_ENABLED off', { SAMPLING_ENABLED: 'false' }],
    ['STORAGE_DRIVER unset', { STORAGE_DRIVER: undefined }],
  ]
  for (const [label, env] of offCases) {
    await withEnv(env, async () => {
      await check(`driver off with ${label}: storage takes the Supabase path`, async () => {
        assert.equal(storage.localStorageActive(), false)
        assert.equal(storage.storageConfigured(), false)
        await rejectsWith(storage.signedUploadUrl(key1), 501, 'STORAGE_NOT_CONFIGURED')
        await rejectsWith(storage.signedDownloadUrl(key1), 501, 'STORAGE_NOT_CONFIGURED')
        await rejectsWith(storage.statObject(key1), 501, 'STORAGE_NOT_CONFIGURED')
        await rejectsWith(storage.copyObject(key1, newKey('x.pdf')), 501, 'STORAGE_NOT_CONFIGURED')
        await rejectsWith(storage.removeObject(key1), 501, 'STORAGE_NOT_CONFIGURED')
        assert.ok(fs.existsSync(onDisk(key1)))
      })
      r = await put(up11, Buffer.from('x'))
      const g = await fetch(down1)
      await check(`driver off with ${label}: file routes answer 404 and write nothing`, async () => {
        await refused(r, 404, 'NOT_FOUND')
        await refused(g, 404, 'NOT_FOUND')
        assert.ok(!fs.existsSync(onDisk(key11)))
      })
    })
  }

  // With the gate shut, STORAGE_DRIVER=local must leave the Supabase calls as they were.
  const realFetch = globalThis.fetch
  const seen = []
  await withEnv(
    { NODE_ENV: 'production', SUPABASE_URL: 'https://storage.example.invalid/', SUPABASE_SERVICE_ROLE_KEY: 'service-key' },
    async () => {
      globalThis.fetch = async (url, init) => {
        seen.push({ url: String(url), method: init?.method, apikey: init?.headers?.apikey })
        return new Response(JSON.stringify({ url: `/object/upload/sign/ld-erp-documents/${key1}?token=abc` }), { status: 200 })
      }
      try {
        const signed = await storage.signedUploadUrl(key1)
        await check('gate shut with STORAGE_DRIVER=local: upload link still comes from Supabase', () => {
          assert.equal(signed.uploadUrl, `https://storage.example.invalid/storage/v1/object/upload/sign/ld-erp-documents/${key1}?token=abc`)
          assert.deepEqual(seen, [
            { url: `https://storage.example.invalid/storage/v1/object/upload/sign/ld-erp-documents/${key1}`, method: 'POST', apikey: 'service-key' },
          ])
          assert.equal(storage.storageConfigured(), true)
        })
      } finally {
        globalThis.fetch = realFetch
      }
    }
  )

  // ── Settings ──────────────────────────────────────────────────────────────
  await withEnv({ LOCAL_STORAGE_SECRET: 'x'.repeat(31) }, async () => {
    await check('secret shorter than 32 characters: nothing is signed', async () => {
      assert.equal(storage.storageConfigured(), false)
      await rejectsWith(storage.signedUploadUrl(newKey('short.pdf')), 501, 'STORAGE_NOT_CONFIGURED')
      await rejectsWith(storage.signedDownloadUrl(key1), 501, 'STORAGE_NOT_CONFIGURED')
      await rejectsWith(storage.statObject(key1), 501, 'STORAGE_NOT_CONFIGURED')
    })
    r = await put(`${base}/put?token=${forge({ op: 'put', path: key11, exp: now() + 60, nonce: nonce(), maxBytes: MAX }, 'x'.repeat(31))}`, Buffer.from('x'))
    const g = await fetch(down1)
    await check('secret shorter than 32 characters: file routes refuse to work', async () => {
      await refused(r, 501, 'STORAGE_NOT_CONFIGURED')
      await refused(g, 501, 'STORAGE_NOT_CONFIGURED')
      assert.ok(!fs.existsSync(onDisk(key11)))
    })
  })
  await withEnv({ LOCAL_STORAGE_SECRET: undefined }, () =>
    check('missing secret: nothing is signed', () =>
      rejectsWith(storage.signedUploadUrl(newKey('none.pdf')), 501, 'STORAGE_NOT_CONFIGURED')
    )
  )
  await withEnv({ LOCAL_STORAGE_BASE_URL: undefined }, () =>
    check('missing base URL: nothing is signed', () =>
      rejectsWith(storage.signedUploadUrl(newKey('none.pdf')), 501, 'STORAGE_NOT_CONFIGURED')
    )
  )
  await withEnv({ LOCAL_STORAGE_DIR: '  ' }, () =>
    check('missing folder: nothing is signed', () =>
      rejectsWith(storage.signedUploadUrl(newKey('none.pdf')), 501, 'STORAGE_NOT_CONFIGURED')
    )
  )

  r = await put(up11, Buffer.from('back on'))
  await check('with everything restored, a link signed earlier still works once', async () => {
    assert.equal(r.status, 200)
    assert.equal(fs.readFileSync(onDisk(key11), 'utf8'), 'back on')
  })

  console.log(`\n${passed} checks passed. Local file storage only; no database opened.`)
}

main()
  .catch((e) => {
    console.error(e)
    process.exitCode = 1
  })
  .finally(async () => {
    process.chdir(startedIn)
    if (server) {
      server.closeAllConnections?.()
      await new Promise((resolve) => server.close(resolve))
    }
    fs.rmSync(root, { recursive: true, force: true })
    try {
      fs.rmdirSync(checkFiles)
    } catch {
      // Another run's folder is still there; leave it to that run.
    }
  })
