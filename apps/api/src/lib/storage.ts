import { createHmac, randomBytes, timingSafeEqual } from 'crypto'
import { constants as fsConstants, existsSync, type ReadStream } from 'fs'
import { copyFile, mkdir, open, readFile, rename, rm, stat, unlink, writeFile } from 'fs/promises'
import type { FileHandle } from 'fs/promises'
import nodePath from 'path'
import { AppError } from '../middleware/errorHandler'
import { samplingPilotEnabled } from './pilot'

/**
 * Files that belong to a document — a supplier's quotation, a signed copy that
 * came back, a sample approval.
 *
 * ── Why the browser uploads directly ────────────────────────────────────────
 *
 * The API never sees the bytes. It signs a one-use URL, the browser sends the
 * file straight to storage, and then tells us it is there so the row can be
 * written. Three reasons, in order of how much they matter:
 *
 * 1. A 5MB file through Express is 5MB of memory held for the length of a
 *    slow mill connection, on a free-plan server with one process.
 * 2. Parsing multipart form data needs a package, and the build rules say not
 *    to add one without asking.
 * 3. The signed URL expires and works once, so it is no weaker than posting
 *    through us.
 *
 * ── Why downloads are signed too ────────────────────────────────────────────
 *
 * The bucket is private. A purchase order carries prices and terms, and a
 * public URL on a bucket is a URL that can be guessed, shared, and indexed.
 * Every download is a fresh link that dies after a few minutes.
 *
 * Everything here is plain `fetch` against Supabase's storage API. No SDK, and
 * the service key never leaves the server.
 *
 * ── The local pilot ─────────────────────────────────────────────────────────
 *
 * The sampling pilot runs on one machine with no cloud keys, and can keep its
 * files in a folder instead (STORAGE_DRIVER=local, the section at the bottom).
 * Same functions, same answers, same three steps for the browser; only where
 * the links point changes. It never switches on outside that pilot.
 */

const BUCKET = process.env.SUPABASE_BUCKET || 'ld-erp-documents'

/** How long a download link lives. Long enough to click, short enough to be useless if it leaks. */
const DOWNLOAD_TTL_SECONDS = 300

/**
 * 50MB, which is also what the bucket itself is set to.
 *
 * Both have to agree. The bucket is the one that actually refuses an oversized
 * file — this is the check that refuses it early, before somebody spends five
 * minutes sending it on a mill connection only to be turned away at the end.
 *
 * Raising it here without raising it on the bucket would make the upload fail
 * at the last step with Supabase's own wording rather than ours.
 */
export const MAX_FILE_BYTES = 50 * 1024 * 1024
export const MAX_FILES_PER_DOCUMENT = 5

function config() {
  const url = process.env.SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY

  if (!url || !key) {
    throw new AppError(
      'File storage is not set up. Add SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY to the API environment.',
      501,
      'STORAGE_NOT_CONFIGURED',
    )
  }

  return { url: url.replace(/\/+$/, ''), key }
}

/**
 * A stored path as it goes into a storage URL: each part encoded. Pasted in
 * whole, a "#" or "?" in a path ends it early ("a.pdf#" reaches a.pdf), so a
 * path that merely looked different could read, or delete, another file.
 * Paths storagePathFor makes have nothing to encode and come out the same.
 */
function objectKey(path: string): string {
  return path.split('/').map(encodeURIComponent).join('/')
}

/** True when the server has been given somewhere to put files. */
export function storageConfigured(): boolean {
  if (localStorageActive()) return localStorageReady()
  return Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY)
}

async function storageFetch(path: string, init: RequestInit) {
  const { url, key } = config()
  const res = await fetch(`${url}/storage/v1${path}`, {
    ...init,
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      ...(init.headers ?? {}),
    },
  })

  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new AppError(
      `File storage refused the request (${res.status}). ${body.slice(0, 200)}`,
      502,
      'STORAGE_FAILED',
    )
  }

  return res
}

/**
 * Turns whatever the person called the file into something safe to put in a
 * path, then hangs it under a folder per document.
 *
 * The original name is kept on the row and shown in the list; it is never the
 * path, because two people both upload "scan.pdf" and the second must not
 * quietly replace the first. The random middle is what stops that, and it also
 * stops a path being guessable from the order number alone.
 */
export function storagePathFor(folder: string, documentId: string, fileName: string): string {
  const safe = fileName
    .normalize('NFKD')
    .replace(/[^\w.\- ]+/g, '')
    .replace(/\s+/g, '-')
    .slice(-80)
    .replace(/^[-.]+/, '')

  const unique = Math.random().toString(36).slice(2, 10)
  return `${folder}/${documentId}/${unique}-${safe || 'file'}`
}

/**
 * A one-use URL the browser can PUT the file to.
 *
 * The path that comes back already carries `?token=…`, and that query string
 * is the whole authorisation — rebuilding the URL by hand and sending the
 * token as a Bearer header instead gets a flat 400, which is exactly what this
 * did on the first attempt.
 */
export async function signedUploadUrl(path: string): Promise<{ uploadUrl: string }> {
  if (localStorageActive()) return localSignedUploadUrl(path)
  const res = await storageFetch(`/object/upload/sign/${BUCKET}/${objectKey(path)}`, { method: 'POST' })
  const body = (await res.json()) as { url?: string }

  if (!body.url) {
    throw new AppError('File storage did not return an upload link', 502, 'STORAGE_FAILED')
  }

  const { url } = config()
  return { uploadUrl: `${url}/storage/v1${body.url}` }
}

/** A short-lived link to read one file back. */
export async function signedDownloadUrl(path: string): Promise<string> {
  if (localStorageActive()) return localSignedDownloadUrl(path)
  const res = await storageFetch(`/object/sign/${BUCKET}/${objectKey(path)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ expiresIn: DOWNLOAD_TTL_SECONDS }),
  })

  const body = (await res.json()) as { signedURL?: string }
  if (!body.signedURL) {
    throw new AppError('File storage did not return a download link', 502, 'STORAGE_FAILED')
  }

  const { url } = config()
  return `${url}/storage/v1${body.signedURL}`
}

/**
 * Confirms the file is really in the bucket, and how big it actually is.
 *
 * The browser reports both, and the browser is not to be believed: the row
 * would otherwise claim a file that was never uploaded, or a size that was
 * never true. Called before the row is written.
 */
export async function statObject(path: string): Promise<{ sizeBytes: number; mimeType: string | null }> {
  if (localStorageActive()) return localStatObject(path)
  const { url, key } = config()
  const res = await fetch(`${url}/storage/v1/object/info/${BUCKET}/${objectKey(path)}`, {
    headers: { apikey: key, Authorization: `Bearer ${key}` },
  })

  if (!res.ok) {
    throw new AppError(
      'That file never arrived in storage. Try uploading it again.',
      400,
      'UPLOAD_NOT_FOUND',
    )
  }

  // Supabase answers this endpoint in snake_case — `content_type`, not
  // `contentType`. Reading only the camelCase spelling stored null as the type
  // of every file ever attached, so nothing downstream could tell a PDF from a
  // photograph. Both spellings are read now, and the nested `metadata` shape
  // some versions use is still the last resort.
  const info = (await res.json()) as { size?: number; content_type?: string; contentType?: string; metadata?: { size?: number; mimetype?: string } }
  const size = info.size ?? info.metadata?.size ?? 0
  const type = info.content_type ?? info.contentType ?? info.metadata?.mimetype ?? null

  return { sizeBytes: Number(size), mimeType: type }
}

/**
 * Copies a file to a new path inside the bucket.
 *
 * Used when one document's paperwork is carried onto another — a supplier's PI
 * onto the order raised from it. A copy rather than a shared path, so removing
 * the file from one document can never pull it out from under the other.
 */
export async function copyObject(from: string, to: string): Promise<void> {
  if (localStorageActive()) return localCopyObject(from, to)
  await storageFetch('/object/copy', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ bucketId: BUCKET, sourceKey: from, destinationKey: to }),
  })
}

/** Removes the file itself. The row is the caller's problem. */
export async function removeObject(path: string): Promise<void> {
  if (localStorageActive()) return localRemoveObject(path)
  await storageFetch(`/object/${BUCKET}/${objectKey(path)}`, { method: 'DELETE' })
}

// ── Local disk, for the sampling pilot only ─────────────────────────────────
//
// The pilot has no cloud keys, and tech packs and approval photos still have
// to be attachable to test it. So the five operations above can be pointed at
// a folder on this machine instead of the bucket.
//
// The browser cannot tell the difference. It still asks for a link, PUTs the
// file to it with no Authorization header, and opens a signed link to read it
// back. The links point at routes/localFiles.routes.ts instead of Supabase,
// and carry a token this server signed; the token is the whole authorisation,
// exactly as Supabase's is.
//
// On only when STORAGE_DRIVER=local AND the server is not running as
// production AND the sampling pilot's own gate is open (both database URLs on
// this machine's lderp_sampling). Any one missing and everything below is
// skipped: a stray STORAGE_DRIVER=local on the live server still goes to
// Supabase, or still answers 501 without its keys. Production never writes to
// its own disk.
//
// Settings, read on every call like the gate:
//   LOCAL_STORAGE_DIR       the folder, absolute or relative to the repo
//   LOCAL_STORAGE_SECRET    the key links are signed with, 32+ characters
//   LOCAL_STORAGE_BASE_URL  where the browser reaches localFiles.routes.ts,
//                           e.g. http://localhost:5102/api/local-files

/** True when files go to a folder on this machine rather than the bucket. */
export function localStorageActive(): boolean {
  return (
    process.env.STORAGE_DRIVER === 'local' &&
    process.env.NODE_ENV !== 'production' &&
    samplingPilotEnabled()
  )
}

/**
 * How long a local upload link lives: two hours, because that is how long the
 * Supabase upload links above live. signedUploadUrl asks Supabase for one
 * without naming an expiry, and Supabase's fixed lifetime for a signed upload
 * URL is two hours. Matching it keeps a slow upload behaving the same in the
 * pilot as on the live server.
 */
const LOCAL_UPLOAD_TTL_SECONDS = 2 * 60 * 60

/**
 * Shorter than this and the signing key could be guessed, which would let
 * anybody write files. Refused outright rather than accepted with a warning
 * nobody reads.
 */
const LOCAL_SECRET_MIN_LENGTH = 32

export interface LocalLink {
  op: 'put' | 'get'
  /** The storage path, exactly as the routes know it. */
  path: string
  /** When the link dies, in seconds since 1970. */
  exp: number
  /** Makes every link different, and is what marks an upload link spent. */
  nonce: string
  /** Upload links only: the most the file may weigh. */
  maxBytes?: number
}

function localSettings(): { root: string; secret: string; baseUrl: string } {
  const dir = (process.env.LOCAL_STORAGE_DIR ?? '').trim()
  const secret = process.env.LOCAL_STORAGE_SECRET ?? ''
  const baseUrl = (process.env.LOCAL_STORAGE_BASE_URL ?? '').trim().replace(/\/+$/, '')

  if (!dir || secret.length < LOCAL_SECRET_MIN_LENGTH || !/^https?:\/\/[^/]+/.test(baseUrl)) {
    throw new AppError(
      `Local file storage is not set up. Add LOCAL_STORAGE_DIR, LOCAL_STORAGE_BASE_URL and a LOCAL_STORAGE_SECRET of at least ${LOCAL_SECRET_MIN_LENGTH} characters to the API environment.`,
      501,
      'STORAGE_NOT_CONFIGURED',
    )
  }

  return { root: nodePath.resolve(repoRoot(), dir), secret, baseUrl }
}

function localStorageReady(): boolean {
  try {
    localSettings()
    return true
  } catch {
    return false
  }
}

/**
 * The repository's folder, so a relative LOCAL_STORAGE_DIR means the same
 * place whether the API was started from the repo (the pilot launcher) or
 * from apps/api (pnpm dev). Found by walking up to pnpm-workspace.yaml, which
 * works from src/ and from the built dist/ alike.
 */
let foundRepoRoot: string | undefined
function repoRoot(): string {
  if (foundRepoRoot) return foundRepoRoot
  let dir = __dirname
  for (;;) {
    if (existsSync(nodePath.join(dir, 'pnpm-workspace.yaml'))) return (foundRepoRoot = dir)
    const up = nodePath.dirname(dir)
    if (up === dir) return (foundRepoRoot = process.cwd())
    dir = up
  }
}

/*
 * What a storage path may look like on disk.
 *
 * Every path is made by storagePathFor, but the one sent back to register a
 * file comes from the browser and ends up here too. So it is checked when a
 * link is signed and again every time it is used:
 *
 *   - forward slashes only. A backslash is a separator on Windows, and
 *     "a\..\..\x" would walk straight past a check that only splits on "/";
 *   - not absolute, no empty parts ("a//b"), no NUL byte;
 *   - no part starting with a dot. That rules out "." and "..", and keeps the
 *     .meta folder and half-written .part files out of any path's reach;
 *   - letters, digits, "_", "-", "." and spaces only, which is all
 *     storagePathFor can produce. That keeps out ":" (a drive letter, or a
 *     Windows alternate data stream);
 *   - no part ending in a dot or a space, which Windows quietly drops, so two
 *     different paths would name the same file;
 *   - none of Windows' device names (CON, NUL, COM1, …), which open a device
 *     rather than a file in any folder.
 *
 * And after all of that, the resolved file must still be inside the root.
 */
const PATH_PART = /^[A-Za-z0-9_-][A-Za-z0-9_. -]*$/
const DEVICE_NAME = /^(con|prn|aux|nul|com\d|lpt\d) *(\..*)?$/i

function badLocalPath(): AppError {
  return new AppError(
    'That file location is not one this server hands out. Upload the file again.',
    400,
    'BAD_STORAGE_PATH',
  )
}

function localFile(root: string, key: unknown): string {
  if (
    typeof key !== 'string' ||
    key.length === 0 ||
    key.length > 1024 ||
    key.includes('\0') ||
    key.includes('\\') ||
    key.startsWith('/')
  ) {
    throw badLocalPath()
  }

  const parts = key.split('/')
  const partsOk = parts.every(
    (p) => p !== '' && p !== '..' && PATH_PART.test(p) && !/[. ]$/.test(p) && !DEVICE_NAME.test(p),
  )
  if (!partsOk) throw badLocalPath()

  const full = nodePath.resolve(root, ...parts)
  const rel = nodePath.relative(root, full)
  if (!rel || rel === '..' || rel.startsWith(`..${nodePath.sep}`) || nodePath.isAbsolute(rel)) {
    throw badLocalPath()
  }
  return full
}

/**
 * Where the type the browser sent with a file is kept, since a bare file on
 * disk has none. Beside the files under .meta, which no storage path can name.
 */
function localMetaFile(root: string, key: string): string {
  return `${nodePath.join(root, '.meta', ...key.split('/'))}.json`
}

/** "application/pdf; charset=x" → "application/pdf"; anything malformed → null. */
function cleanMimeType(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const type = value.split(';')[0].trim().toLowerCase()
  return /^[a-z0-9][\w!#$&^.+-]{0,63}\/[a-z0-9][\w!#$&^.+-]{0,127}$/.test(type) ? type : null
}

async function readLocalMeta(root: string, key: string): Promise<{ mimeType: string | null } | null> {
  try {
    const meta = JSON.parse(await readFile(localMetaFile(root, key), 'utf8')) as { mimeType?: unknown }
    return { mimeType: cleanMimeType(meta?.mimeType) }
  } catch {
    return null
  }
}

/** Written beside the target and renamed over it, so a reader never sees half a file. */
async function writeFileAtomic(target: string, data: Buffer | string): Promise<void> {
  const dir = nodePath.dirname(target)
  await mkdir(dir, { recursive: true })
  const temp = nodePath.join(dir, `.${randomBytes(8).toString('hex')}.part`)
  try {
    await writeFile(temp, data, { flag: 'wx' })
    await rename(temp, target)
  } finally {
    await rm(temp, { force: true }).catch(() => {})
  }
}

async function isLocalFile(full: string): Promise<boolean> {
  try {
    return (await stat(full)).isFile()
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw err
  }
}

const nowSeconds = () => Math.floor(Date.now() / 1000)

function signLocalLink(link: LocalLink, secret: string): string {
  const body = Buffer.from(JSON.stringify(link), 'utf8').toString('base64url')
  return `${body}.${createHmac('sha256', secret).update(body).digest('base64url')}`
}

/**
 * Checks the token from a local file link and says what it allows, or
 * refuses with a reason the person can act on.
 *
 * The signature is checked before anything inside the token is believed, or
 * even parsed, and compared in constant time so how long the refusal takes
 * says nothing about how close a forgery came. The path inside is checked
 * again too: a link signed before a rule was tightened gets no exemption.
 */
export function readLocalLink(token: unknown, op: 'put' | 'get'): LocalLink {
  const { root, secret } = localSettings()
  const invalid = () =>
    new AppError(
      'This file link is not valid. Go back to the document and try again.',
      403,
      'LINK_INVALID',
    )

  if (typeof token !== 'string' || token.length > 4096) throw invalid()
  const [body, signature, extra] = token.split('.')
  if (!body || !signature || extra !== undefined) throw invalid()

  const expected = Buffer.from(createHmac('sha256', secret).update(body).digest('base64url'))
  const given = Buffer.from(signature)
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) throw invalid()

  let link: Partial<LocalLink>
  try {
    link = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as Partial<LocalLink>
  } catch {
    throw invalid()
  }
  if (
    !link ||
    typeof link !== 'object' ||
    typeof link.exp !== 'number' ||
    typeof link.nonce !== 'string' ||
    link.nonce.length < 16 ||
    link.nonce.length > 64
  ) {
    throw invalid()
  }

  if (link.op !== op) {
    throw new AppError(
      op === 'put'
        ? 'This link is for opening a file, not for sending one.'
        : 'This link is for sending a file, not for opening one.',
      403,
      'LINK_WRONG_USE',
    )
  }
  if (link.exp <= nowSeconds()) {
    throw new AppError(
      op === 'put'
        ? 'This upload link has expired. Choose the file again.'
        : 'This file link has expired. Open the file again from its document.',
      403,
      'LINK_EXPIRED',
    )
  }

  localFile(root, link.path)

  if (op === 'put') {
    const max = link.maxBytes
    if (typeof max !== 'number' || !Number.isInteger(max) || max <= 0 || max > MAX_FILE_BYTES) {
      throw invalid()
    }
    return { op, path: link.path as string, exp: link.exp, nonce: link.nonce, maxBytes: max }
  }
  return { op, path: link.path as string, exp: link.exp, nonce: link.nonce }
}

/*
 * Upload links already spent, kept until they would have expired anyway.
 *
 * In this process's memory only, so a restart forgets them and a link handed
 * out before the restart could be used once more inside its two hours. That
 * is acceptable for the pilot, which is one process on one machine, and the
 * random path means a second send could only land where the first already
 * is, which is refused anyway. It would not do for a server running several
 * processes, which is one more reason this driver never runs in production.
 *
 * A link is marked spent only once its file is safely on disk, so a send that
 * dropped halfway can be retried on the same link. While a send is in
 * progress the link is held, so two sends at once cannot both write.
 */
const spentUploadLinks = new Map<string, number>()
const uploadsInProgress = new Set<string>()

/** Holds an upload link for one send. False if it is spent or already sending. */
export function claimLocalUpload(link: LocalLink): boolean {
  const now = nowSeconds()
  for (const [nonce, exp] of spentUploadLinks) if (exp <= now) spentUploadLinks.delete(nonce)

  if (spentUploadLinks.has(link.nonce) || uploadsInProgress.has(link.nonce)) return false
  uploadsInProgress.add(link.nonce)
  return true
}

/** Lets go of a held link: spent if the file was written, free to retry if not. */
export function settleLocalUpload(link: LocalLink, written: boolean): void {
  uploadsInProgress.delete(link.nonce)
  if (written) spentUploadLinks.set(link.nonce, link.exp)
}

/**
 * Puts an uploaded file on disk, along with the type the browser sent it as.
 *
 * Never on top of a file already there, as the bucket refuses to overwrite
 * without being told to. The file is written under a temporary name and
 * renamed into place, so statObject never measures half a file.
 */
export async function writeLocalObject(key: string, bytes: Buffer, contentType: unknown): Promise<void> {
  const { root } = localSettings()
  const full = localFile(root, key)
  const alreadyThere = () =>
    new AppError(
      'A file has already been sent to this link. Choose the file again to get a fresh one.',
      409,
      'ALREADY_UPLOADED',
    )

  if (await isLocalFile(full)) throw alreadyThere()

  const dir = nodePath.dirname(full)
  await mkdir(dir, { recursive: true })
  const temp = nodePath.join(dir, `.${randomBytes(8).toString('hex')}.part`)
  try {
    await writeFile(temp, bytes, { flag: 'wx' })
    await writeFileAtomic(localMetaFile(root, key), JSON.stringify({ mimeType: cleanMimeType(contentType) }))
    if (await isLocalFile(full)) throw alreadyThere()
    await rename(temp, full)
  } finally {
    await rm(temp, { force: true }).catch(() => {})
  }
}

/**
 * Opens a stored file for a download.
 *
 * Opened before it is measured, so a file removed in between is a clean "not
 * there" rather than a download that stops halfway. The stream closes the
 * file when it ends; a caller that decides not to send it must destroy it.
 */
export async function openLocalObject(key: string): Promise<{
  stream: ReadStream
  sizeBytes: number
  mimeType: string | null
  fileName: string
}> {
  const { root } = localSettings()
  const full = localFile(root, key)
  const gone = () => new AppError('That file is no longer in storage.', 404, 'FILE_NOT_FOUND')

  let handle: FileHandle
  try {
    handle = await open(full, 'r')
  } catch {
    throw gone()
  }

  try {
    const info = await handle.stat()
    if (!info.isFile()) throw gone()
    const meta = await readLocalMeta(root, key)
    return {
      stream: handle.createReadStream(),
      sizeBytes: info.size,
      mimeType: meta?.mimeType ?? null,
      fileName: localDownloadName(key),
    }
  } catch (err) {
    await handle.close().catch(() => {})
    throw err
  }
}

/**
 * The name a download is saved under. signedDownloadUrl has only ever been
 * given the path, never a name, so the name comes from the path: its last
 * part, without the random prefix storagePathFor put in front.
 */
function localDownloadName(key: string): string {
  const last = key.split('/').pop() ?? ''
  const name = last
    .replace(/^[0-9a-z]{1,8}-(?=.)/, '')
    .replace(/[^A-Za-z0-9_. -]+/g, '_')
    .slice(-120)
  return name || 'file'
}

async function localSignedUploadUrl(key: string): Promise<{ uploadUrl: string }> {
  const { root, secret, baseUrl } = localSettings()
  localFile(root, key)

  const token = signLocalLink(
    {
      op: 'put',
      path: key,
      exp: nowSeconds() + LOCAL_UPLOAD_TTL_SECONDS,
      nonce: randomBytes(16).toString('base64url'),
      maxBytes: MAX_FILE_BYTES,
    },
    secret,
  )
  return { uploadUrl: `${baseUrl}/put?token=${token}` }
}

async function localSignedDownloadUrl(key: string): Promise<string> {
  const { root, secret, baseUrl } = localSettings()

  // Supabase will not sign a link to a file that is not there, and answers
  // with an error the routes already pass on. The same here, rather than a
  // link that only fails once it is clicked.
  if (!(await isLocalFile(localFile(root, key)))) {
    throw new AppError('File storage could not find that file. It may have been removed.', 502, 'STORAGE_FAILED')
  }

  const token = signLocalLink(
    {
      op: 'get',
      path: key,
      exp: nowSeconds() + DOWNLOAD_TTL_SECONDS,
      nonce: randomBytes(16).toString('base64url'),
    },
    secret,
  )
  return `${baseUrl}/get?token=${token}`
}

async function localStatObject(key: string): Promise<{ sizeBytes: number; mimeType: string | null }> {
  const { root } = localSettings()
  const full = localFile(root, key)

  const info = await stat(full).catch(() => null)
  if (!info?.isFile()) {
    throw new AppError(
      'That file never arrived in storage. Try uploading it again.',
      400,
      'UPLOAD_NOT_FOUND',
    )
  }

  const meta = await readLocalMeta(root, key)
  return { sizeBytes: info.size, mimeType: meta?.mimeType ?? null }
}

async function localCopyObject(from: string, to: string): Promise<void> {
  const { root } = localSettings()
  const source = localFile(root, from)
  const target = localFile(root, to)

  try {
    await mkdir(nodePath.dirname(target), { recursive: true })
    // Never over a file already there, as the bucket's copy refuses to.
    await copyFile(source, target, fsConstants.COPYFILE_EXCL)
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    throw new AppError(
      code === 'ENOENT'
        ? 'File storage could not copy that file: the original is not there.'
        : code === 'EEXIST'
          ? 'File storage could not copy that file: there is already a file at the new place.'
          : 'File storage could not copy that file. Try again.',
      502,
      'STORAGE_FAILED',
    )
  }

  // The type goes with it. Best effort: the routes copy the type onto the new
  // row from the old one anyway, so losing it here costs nothing they show.
  const meta = await readLocalMeta(root, from)
  if (meta) await writeFileAtomic(localMetaFile(root, to), JSON.stringify(meta)).catch(() => {})
}

async function localRemoveObject(key: string): Promise<void> {
  const { root } = localSettings()
  const full = localFile(root, key)

  try {
    await unlink(full)
  } catch (err) {
    // A file that is not there is refused, as the bucket refuses it. Every
    // caller already treats removing the file as best effort and catches this.
    throw new AppError(
      (err as NodeJS.ErrnoException).code === 'ENOENT'
        ? 'File storage could not find that file to remove it.'
        : 'File storage could not remove that file. Try again.',
      502,
      'STORAGE_FAILED',
    )
  }

  await rm(localMetaFile(root, key), { force: true }).catch(() => {})
}
