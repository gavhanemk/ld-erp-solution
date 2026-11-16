import express, { Router, type Request, type Response } from 'express'
import { pipeline } from 'stream'
import { AppError } from '../middleware/errorHandler'
import { logger } from '../utils/logger'
import {
  MAX_FILE_BYTES,
  claimLocalUpload,
  localStorageActive,
  openLocalObject,
  readLocalLink,
  settleLocalUpload,
  writeLocalObject,
  type LocalLink,
} from '../lib/storage'

/**
 * The other end of the links lib/storage.ts signs when the sampling pilot keeps
 * files on this machine (STORAGE_DRIVER=local). It stands in for Supabase
 * Storage's own upload and download addresses.
 *
 * Like them it needs no sign-in. The browser sends the file with no
 * Authorization header, and the signed token in the link is the whole
 * authorisation, which is why index.ts mounts this outside authMiddleware.
 * It also sits above the JSON body parser there: a file sent as
 * application/json would otherwise be parsed as a request body, and the bytes
 * written would not be the bytes sent.
 *
 * Wherever the local driver is not switched on, which includes every
 * production server, every address here answers 404 as if it did not exist.
 */
const router = Router()

router.use((_req, res, next) => {
  // Nothing from here is to be read as anything but what it says it is, or
  // kept by anything between this server and the browser.
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.setHeader('Cache-Control', 'private, no-store')
  if (!localStorageActive()) {
    return res.status(404).json({
      success: false,
      message: 'Files are kept on this machine only in the isolated local pilot.',
      code: 'NOT_FOUND',
    })
  }
  next()
})

/**
 * The types a download is labelled with. Anything else goes out as
 * application/octet-stream: a file sent as text/html or image/svg+xml must
 * never come back as a page that runs script on the API's own address. The
 * attachment disposition below already makes the browser save rather than
 * show it; this is the second lock on the same door.
 */
const SAFE_DOWNLOAD_TYPES = new Set([
  'application/pdf',
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
  'image/heic',
  'image/heif',
  'image/bmp',
  'image/tiff',
  'text/plain',
  'text/csv',
  'application/zip',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
])

/** Every refusal in the shape the rest of the API answers in. */
function refuse(res: Response, err: unknown) {
  if (res.headersSent) {
    res.destroy()
    return
  }
  if (err instanceof AppError) {
    res.status(err.statusCode).json({ success: false, message: err.message, code: err.code })
    return
  }
  logger.error(`Local file storage: ${err instanceof Error ? err.message : String(err)}`)
  res.status(500).json({
    success: false,
    message: 'The file could not be saved or read on this machine. Try again.',
    code: 'STORAGE_FAILED',
  })
}

function sizeText(bytes: number): string {
  return bytes >= 1024 * 1024
    ? `${(bytes / 1024 / 1024).toFixed(1).replace(/\.0$/, '')}MB`
    : `${bytes} bytes`
}

function tooLarge(bytes: number | null, limit: number): AppError {
  return new AppError(
    `${bytes === null ? 'That file is too large.' : `That file is ${sizeText(bytes)}.`} The limit is ${sizeText(limit)}.`,
    413,
    'FILE_TOO_LARGE',
  )
}

/** The browser sending a file to a link from signedUploadUrl. */
router.put('/put', (req: Request, res: Response) => {
  // The link is checked before a byte of the file is read, so a bad link costs
  // nothing but this answer.
  let link: LocalLink
  try {
    link = readLocalLink(req.query.token, 'put')
  } catch (err) {
    return refuse(res, err)
  }

  const limit = Math.min(link.maxBytes ?? MAX_FILE_BYTES, MAX_FILE_BYTES)
  const declared = Number(req.headers['content-length'])
  if (Number.isFinite(declared) && declared > limit) return refuse(res, tooLarge(declared, limit))

  if (!claimLocalUpload(link)) {
    return refuse(
      res,
      new AppError(
        'This upload link has already been used. Choose the file again to get a fresh one.',
        409,
        'LINK_USED',
      ),
    )
  }

  // Built per request so the link's own limit is what stops a body sent with
  // no length, never more than the 50MB everything else allows. Any type is
  // read as raw bytes: the file is kept exactly as sent whatever the browser
  // calls it, and a request with no Content-Type must not be left unread.
  const readBody = express.raw({ type: () => true, limit })
  readBody(req, res, async (bodyError?: unknown) => {
    let size = 0
    try {
      if (bodyError) {
        throw (bodyError as { type?: string }).type === 'entity.too.large'
          ? tooLarge(null, limit)
          : new AppError(
              'The file did not arrive in one piece. Check the connection and try again.',
              400,
              'UPLOAD_INCOMPLETE',
            )
      }
      const bytes: unknown = req.body
      if (!Buffer.isBuffer(bytes) || bytes.length === 0) {
        throw new AppError('That file is empty.', 400, 'EMPTY_FILE')
      }
      if (bytes.length > limit) throw tooLarge(bytes.length, limit)

      await writeLocalObject(link.path, bytes, req.headers['content-type'])
      size = bytes.length
    } catch (err) {
      // Not spent: a send that failed can be tried again on the same link.
      settleLocalUpload(link, false)
      return refuse(res, err)
    }

    settleLocalUpload(link, true)
    res.json({ success: true, data: { path: link.path, sizeBytes: size } })
  })
})

/** Opening a file from a link made by signedDownloadUrl. Good until it expires. */
router.get('/get', async (req: Request, res: Response) => {
  let file: Awaited<ReturnType<typeof openLocalObject>>
  try {
    const link = readLocalLink(req.query.token, 'get')
    file = await openLocalObject(link.path)
  } catch (err) {
    return refuse(res, err)
  }

  const type =
    file.mimeType && SAFE_DOWNLOAD_TYPES.has(file.mimeType)
      ? file.mimeType
      : 'application/octet-stream'
  res.status(200)
  res.setHeader('Content-Type', type)
  res.setHeader('Content-Length', String(file.sizeBytes))
  // The name is letters, digits and ". _ -" only by now, so it needs no
  // escaping inside the quotes.
  res.setHeader('Content-Disposition', `attachment; filename="${file.fileName}"`)

  if (req.method === 'HEAD') {
    file.stream.destroy()
    return res.end()
  }

  // The file must be closed however the download ends. From Node 26 a file
  // left open until the garbage collector finds it is an uncaught error that
  // stops the whole API, so a browser that left while the file was being
  // opened gets nothing sent, and the stream is shut here.
  if (res.destroyed) {
    file.stream.destroy()
    return
  }
  // Not pipe(): when the browser hangs up halfway (tab closed, Save cancelled,
  // connection dropped) pipe() lets go of the response but leaves the file
  // open. pipeline() shuts the stream, and with it the file, on a hang-up and
  // on a read error alike. A hang-up is the browser's choice, not a fault.
  pipeline(file.stream, res, (err) => {
    if (err && err.code !== 'ERR_STREAM_PREMATURE_CLOSE') {
      logger.error(`Local file storage: reading a download failed: ${err.message}`)
    }
  })
})

router.use((_req, res) =>
  res.status(404).json({
    success: false,
    message: 'That file link is not recognised. Go back to the document and try again.',
    code: 'NOT_FOUND',
  })
)

export default router
