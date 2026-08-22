import { Router } from 'express'
import { prisma } from '@ld-erp/database'
import { AppError } from '../middleware/errorHandler'
import type { AuthRequest } from '../middleware/auth'

const router = Router()

// GET /api/notifications?unread=true&limit=20
// Only ever the signed-in user's own notifications.
router.get('/', async (req: AuthRequest, res) => {
  const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 20))

  const where: Record<string, unknown> = { userId: req.user!.id }
  if (req.query.unread === 'true') where.isRead = false

  const [notifications, unreadCount] = await Promise.all([
    prisma.notification.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: limit,
    }),
    prisma.notification.count({ where: { userId: req.user!.id, isRead: false } }),
  ])

  res.json({ success: true, data: notifications, unreadCount })
})

// PATCH /api/notifications/:id/read
router.patch('/:id/read', async (req: AuthRequest, res) => {
  const notification = await prisma.notification.findUnique({ where: { id: req.params.id } })
  if (!notification) throw new AppError('Notification not found', 404, 'NOT_FOUND')

  // Someone else's notification must not be readable, let alone markable.
  if (notification.userId !== req.user!.id) {
    throw new AppError('That notification belongs to another user', 403, 'FORBIDDEN')
  }

  const updated = await prisma.notification.update({
    where: { id: req.params.id },
    data: { isRead: true, readAt: new Date() },
  })

  res.json({ success: true, data: updated })
})

// PATCH /api/notifications/read-all
router.patch('/read-all', async (req: AuthRequest, res) => {
  const result = await prisma.notification.updateMany({
    where: { userId: req.user!.id, isRead: false },
    data: { isRead: true, readAt: new Date() },
  })

  res.json({ success: true, message: `${result.count} marked as read` })
})

export default router
