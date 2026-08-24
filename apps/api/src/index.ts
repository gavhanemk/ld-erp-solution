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
app.use(cors({
  origin: process.env.FRONTEND_URL || 'http://localhost:3000',
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
app.get('/health', (_, res) => res.json({
  status: 'ok', service: 'LD ERP Solution API', version: '1.0.0',
  timestamp: new Date().toISOString(), uptime: `${Math.floor(process.uptime())}s`,
}))

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
