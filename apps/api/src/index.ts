import 'express-async-errors'
import express from 'express'
import cors from 'cors'
import helmet from 'helmet'
import compression from 'compression'
import morgan from 'morgan'
import { createServer } from 'http'
import { Server as SocketIO } from 'socket.io'
import rateLimit from 'express-rate-limit'
import dotenv from 'dotenv'

dotenv.config()

import authRoutes from './routes/auth.routes'
import dashboardRoutes from './routes/dashboard.routes'
import masterRoutes from './routes/master.routes'
import salesRoutes from './routes/sales.routes'
import purchaseRoutes from './routes/purchase.routes'
import purchaseNoteRoutes from './routes/purchase-notes.routes'
import purchaseEnquiryRoutes from './routes/purchase-enquiries.routes'
import purchaseReturnRoutes from './routes/purchase-returns.routes'
import grnQcRoutes from './routes/grn-qc.routes'
import purchaseDashboardRoutes from './routes/purchase-dashboard.routes'
import reportsRoutes from './routes/reports.routes'
import inventoryRoutes from './routes/inventory.routes'
import productionRoutes from './routes/production.routes'
import accountsRoutes from './routes/accounts.routes'
import hrRoutes from './routes/hr.routes'
import approvalRoutes from './routes/approvals.routes'
import aiRoutes from './routes/ai.routes'
import notificationRoutes from './routes/notification.routes'
import settingsRoutes from './routes/settings.routes'
import webhookRoutes from './routes/webhook.routes'

import { errorHandler } from './middleware/errorHandler'
import { storageConfigured } from './lib/storage'
import { authMiddleware } from './middleware/auth'
import { logger } from './utils/logger'
import { prisma } from '@ld-erp/database'

const app = express()
const httpServer = createServer(app)

export const io = new SocketIO(httpServer, {
  cors: {
    origin: process.env.FRONTEND_URL || 'http://localhost:3000',
    methods: ['GET', 'POST'],
    credentials: true,
  },
})

io.on('connection', (socket) => {
  logger.info(`WS connected: ${socket.id}`)
  socket.on('join', (room: string) => socket.join(room))
  socket.on('disconnect', () => logger.info(`WS disconnected: ${socket.id}`))
})

// Security
app.use(helmet({ contentSecurityPolicy: false }))

/**
 * In production only the configured front end may call the API.
 *
 * In development the web app does not always get port 3000 — another project on
 * the same machine may already hold it, and Next then starts on 3001 or higher.
 * Pinning CORS to one port made the whole app look broken in that case, so any
 * loopback origin is accepted while developing.
 */
const allowedOrigins = (process.env.FRONTEND_URL || 'http://localhost:3000')
  .split(',')
  .map((o) => o.trim())
  .filter(Boolean)

const isDevelopment = process.env.NODE_ENV !== 'production'

app.use(cors({
  origin(origin, callback) {
    // Same-origin and server-to-server calls arrive without an Origin header.
    if (!origin) return callback(null, true)
    if (allowedOrigins.includes(origin)) return callback(null, true)
    if (isDevelopment && /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) {
      return callback(null, true)
    }

    // Refusing by omitting the CORS headers is what the browser needs, and it
    // keeps a rejected origin out of the logs as if the server had crashed.
    logger.warn(`Blocked cross-origin request from ${origin}`)
    return callback(null, false)
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  /*
   * Response headers the browser is allowed to read.
   *
   * A cross-origin fetch can see six headers by default and no others, so
   * anything the server says about a file it is sending is invisible to the
   * page unless it is named here. Both of ours were:
   *
   *   Content-Disposition  carries the file name, and the file name is where
   *                        a truncated report says "_PARTIAL". Unreadable, the
   *                        download fell back to a guessed name and a report
   *                        that had dropped rows arrived looking complete.
   *   X-Report-*           the counts measured off the finished workbook, which
   *                        is the whole point of saying "6 charts" rather than
   *                        predicting it from the row count.
   *
   * Neither failure raises anything. The fetch succeeds, the header reads as
   * null, and the page quietly describes the file wrongly.
   */
  exposedHeaders: [
    'Content-Disposition',
    'X-Report-Charts',
    'X-Report-Pivots',
    'X-Report-Rows',
  ],
}))

/*
 * Rate limiting, counted per IP.
 *
 * 500 requests in fifteen minutes sounds generous until you notice what it is
 * counting. A screen like Stock or the purchase bills list makes a handful of
 * calls every time it is opened, and the whole mill reaches this server from
 * one office address, so the ceiling is shared by everybody behind that
 * router rather than being a per-person allowance. A busy afternoon with four
 * buyers and a store keeper is well inside it.
 *
 * What it looks like when it trips is the problem: the server answers "Too
 * many requests", the browser quietly gets nothing back, and a dropdown that
 * should list the open orders renders empty. Nothing on screen says the
 * request was refused — you simply cannot receive goods against an order that
 * appears not to exist. That is exactly how it was found.
 *
 * So development gets a ceiling high enough that it never interferes with
 * working on the thing, and production keeps a real one. The sign-in limits
 * below are the same in both, and count only wrong passwords.
 */
const inProduction = process.env.NODE_ENV === 'production'
/*
 * Both of these answer in the same shape as every other error the API sends
 * — `{ success, message, code }`. They used to answer `{ error: '…' }`, which
 * is a shape nothing on the front end reads: the browser client pulls
 * `body.message`, found nothing, and fell back to "Request failed (429)".
 * The one refusal a person most needs explained in words was the one that
 * arrived as a bare number.
 */
const globalLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: inProduction ? 2000 : 20_000,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    message: 'Too many requests — slow down and try again in a few minutes.',
    code: 'RATE_LIMITED',
  },
})
/*
 * Wrong passwords, not sign-ins.
 *
 * This used to allow twenty requests a quarter of an hour to everything under
 * /api/auth, counted by internet address. A mill's office shares one address,
 * and every open browser refreshes its token under /api/auth every fifteen
 * minutes, so the office used the twenty up between them and everybody was
 * told they had tried too many passwords (two testers were locked out in a
 * morning). Now only POST /login is limited, only failed attempts count, and
 * they count per account: ten wrong passwords for one email in a quarter of
 * an hour, which stops guessing at one person's password without anybody
 * else noticing. A looser ceiling per address still slows somebody trying
 * one password against many accounts.
 */
const failedSignIn = {
  windowMs: 15 * 60 * 1000,
  skipSuccessfulRequests: true,
  standardHeaders: true,
  legacyHeaders: false,
}
const accountLimit = rateLimit({
  ...failedSignIn,
  max: 10,
  keyGenerator: (req) =>
    `${req.ip}|${String((req.body as { email?: unknown } | undefined)?.email ?? '').trim().toLowerCase()}`,
  message: {
    success: false,
    message: 'Too many wrong passwords for this account. Wait a quarter of an hour and try again, or ask an administrator to reset it.',
    code: 'RATE_LIMITED',
  },
})
const addressLimit = rateLimit({
  ...failedSignIn,
  max: 100,
  message: {
    success: false,
    message: 'Too many failed sign-ins from this connection. Wait a quarter of an hour and try again.',
    code: 'RATE_LIMITED',
  },
})
app.use('/api/', globalLimit)

// Body & Logging
app.use(compression())
app.use(express.json({ limit: '10mb' }))
app.use(express.urlencoded({ extended: true, limit: '10mb' }))
app.use(morgan('dev', { stream: { write: (m) => logger.http(m.trim()) } }))

// Health
/**
 * Health check.
 *
 * This used to report only that the process was running, which let the host
 * show the service as live while it could not reach the database — an API that
 * answers every request with a 500 is not healthy, and the check said nothing
 * about it.
 *
 * The database is reached for real, with a short timeout so a stalled
 * connection cannot hold the request open. Only whether it answered is
 * reported: the error itself goes to the log, because a connection error can
 * carry the host and user from the connection string and this endpoint is
 * public.
 *
 * It answers 200 even when the database is down, deliberately. A failing health
 * check makes the host restart the service, and restarting does not repair a
 * database that is unreachable — it just replaces a diagnosable service with a
 * restart loop.
 */
app.get('/health', async (_, res) => {
  const started = Date.now()
  let database: 'ok' | 'unreachable' = 'ok'

  try {
    await Promise.race([
      prisma.$queryRaw`SELECT 1`,
      new Promise((_ok, reject) =>
        setTimeout(() => reject(new Error('timed out after 5s')), 5000),
      ),
    ])
  } catch (err) {
    database = 'unreachable'
    logger.error(`Health check — database unreachable: ${(err as Error).message}`)
  }

  res.json({
    status: 'ok',
    service: 'LD ERP Solution API',
    version: '1.0.0',
    database,
    databaseCheckMs: Date.now() - started,
    // Whether this server has somewhere to put files. Not a secret — true or
    // false, never the keys — and without it a deployment missing its storage
    // credentials looks perfectly healthy while every attachment in the mill
    // fails with nothing to point at.
    fileStorage: storageConfigured() ? 'ok' : 'not configured',
    timestamp: new Date().toISOString(),
    uptime: `${Math.floor(process.uptime())}s`,
  })
})

// Public Routes
app.post('/api/auth/login', addressLimit, accountLimit)
app.use('/api/auth', authRoutes)
app.use('/api/webhooks', webhookRoutes)

// Protected Routes
app.use('/api/dashboard', authMiddleware, dashboardRoutes)
app.use('/api/masters', authMiddleware, masterRoutes)
app.use('/api/sales', authMiddleware, salesRoutes)
app.use('/api/purchase/enquiries', authMiddleware, purchaseEnquiryRoutes)
app.use('/api/purchase/notes', authMiddleware, purchaseNoteRoutes)
// Ahead of the catch-all purchase router, for the same reason notes are.
app.use('/api/purchase/returns', authMiddleware, purchaseReturnRoutes)
app.use('/api/purchase/qc', authMiddleware, grnQcRoutes)
app.use('/api/purchase/orders-dashboard', authMiddleware, purchaseDashboardRoutes)
app.use('/api/purchase', authMiddleware, purchaseRoutes)
app.use('/api/reports', authMiddleware, reportsRoutes)
app.use('/api/inventory', authMiddleware, inventoryRoutes)
app.use('/api/production', authMiddleware, productionRoutes)
app.use('/api/accounts', authMiddleware, accountsRoutes)
app.use('/api/hr', authMiddleware, hrRoutes)
app.use('/api/approvals', authMiddleware, approvalRoutes)
app.use('/api/ai', authMiddleware, aiRoutes)
app.use('/api/notifications', authMiddleware, notificationRoutes)
app.use('/api/settings', authMiddleware, settingsRoutes)

// 404
app.use('*', (req, res) => res.status(404).json({ error: 'Route not found', path: req.originalUrl }))

// Error Handler
app.use(errorHandler)

const PORT = process.env.PORT || 5000
httpServer.listen(PORT, () => {
  logger.info(`🚀 LD ERP Solution API → http://localhost:${PORT}`)
  logger.info(`📡 Socket.io ready | 🌍 ${process.env.NODE_ENV}`)
})

export default app
