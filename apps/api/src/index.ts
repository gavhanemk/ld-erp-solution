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
}))

// Rate Limiting
const globalLimit = rateLimit({ windowMs: 15 * 60 * 1000, max: 500, standardHeaders: true, legacyHeaders: false })
const authLimit = rateLimit({ windowMs: 15 * 60 * 1000, max: 20, message: { error: 'Too many login attempts' } })
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
    timestamp: new Date().toISOString(),
    uptime: `${Math.floor(process.uptime())}s`,
  })
})

// Public Routes
app.use('/api/auth', authLimit, authRoutes)
app.use('/api/webhooks', webhookRoutes)

// Protected Routes
app.use('/api/dashboard', authMiddleware, dashboardRoutes)
app.use('/api/masters', authMiddleware, masterRoutes)
app.use('/api/sales', authMiddleware, salesRoutes)
app.use('/api/purchase', authMiddleware, purchaseRoutes)
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
