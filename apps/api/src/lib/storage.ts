import { AppError } from '../middleware/errorHandler'

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

/** True when the server has been given somewhere to put files. */
export function storageConfigured(): boolean {
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
  const res = await storageFetch(`/object/upload/sign/${BUCKET}/${path}`, { method: 'POST' })
  const body = (await res.json()) as { url?: string }

  if (!body.url) {
    throw new AppError('File storage did not return an upload link', 502, 'STORAGE_FAILED')
  }

  const { url } = config()
  return { uploadUrl: `${url}/storage/v1${body.url}` }
}

/** A short-lived link to read one file back. */
export async function signedDownloadUrl(path: string): Promise<string> {
  const res = await storageFetch(`/object/sign/${BUCKET}/${path}`, {
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
  const { url, key } = config()
  const res = await fetch(`${url}/storage/v1/object/info/${BUCKET}/${path}`, {
    headers: { apikey: key, Authorization: `Bearer ${key}` },
  })

  if (!res.ok) {
    throw new AppError(
      'That file never arrived in storage. Try uploading it again.',
      400,
      'UPLOAD_NOT_FOUND',
    )
  }

  const info = (await res.json()) as { size?: number; contentType?: string; metadata?: { size?: number; mimetype?: string } }
  const size = info.size ?? info.metadata?.size ?? 0
  const type = info.contentType ?? info.metadata?.mimetype ?? null

  return { sizeBytes: Number(size), mimeType: type }
}

/** Removes the file itself. The row is the caller's problem. */
export async function removeObject(path: string): Promise<void> {
  await storageFetch(`/object/${BUCKET}/${path}`, { method: 'DELETE' })
}
