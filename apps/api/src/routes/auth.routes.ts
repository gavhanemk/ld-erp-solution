import { Router } from 'express'
import bcrypt from 'bcryptjs'
import jwt from 'jsonwebtoken'
import { prisma } from '@ld-erp/database'
import { z } from 'zod'
import { AppError } from '../middleware/errorHandler'

const router = Router()

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(6),
})

// POST /api/auth/login
router.post('/login', async (req, res) => {
  const { email, password } = loginSchema.parse(req.body)

  const user = await prisma.user.findUnique({
    where: { email },
    include: { role: { include: { permissions: { include: { permission: true } } } } },
  })

  if (!user || user.status !== 'ACTIVE') {
    throw new AppError('Invalid email or password', 401)
  }

  const passwordMatch = await bcrypt.compare(password, user.passwordHash)
  if (!passwordMatch) {
    throw new AppError('Invalid email or password', 401)
  }

  // Build permissions list
  const permissions = user.role.permissions.map(
    (rp) => `${rp.permission.module}:${rp.permission.action}`
  )

  const payload = {
    id: user.id,
    email: user.email,
    name: user.name,
    roleId: user.roleId,
    role: user.role.name,
    permissions,
  }

  const accessToken = jwt.sign(payload, process.env.JWT_SECRET!, {
    expiresIn: process.env.JWT_EXPIRES_IN || '15m',
  } as jwt.SignOptions)

  const refreshToken = jwt.sign(
    { id: user.id },
    process.env.JWT_REFRESH_SECRET!,
    { expiresIn: process.env.JWT_REFRESH_EXPIRES_IN || '7d' } as jwt.SignOptions
  )

  // Update last login
  await prisma.user.update({
    where: { id: user.id },
    data: { lastLoginAt: new Date() },
  })

  res.json({
    success: true,
    accessToken,
    refreshToken,
    user: {
      id: user.id,
      name: user.name,
      email: user.email,
      role: user.role.name,
      permissions,
      avatarUrl: user.avatarUrl,
    },
  })
})

// POST /api/auth/refresh
router.post('/refresh', async (req, res) => {
  const { refreshToken } = req.body
  if (!refreshToken) throw new AppError('Refresh token required', 400)

  try {
    const decoded = jwt.verify(refreshToken, process.env.JWT_REFRESH_SECRET!) as { id: string }

    const user = await prisma.user.findUnique({
      where: { id: decoded.id },
      include: { role: { include: { permissions: { include: { permission: true } } } } },
    })

    if (!user || user.status !== 'ACTIVE') throw new AppError('User not found or inactive', 401)

    // The permission matrix must be rebuilt here. Omitting it would hand back a
    // token with no grants, locking the user out 15 minutes after they log in.
    const permissions = user.role.permissions.map(
      (rp) => `${rp.permission.module}:${rp.permission.action}`
    )

    const newAccessToken = jwt.sign(
      {
        id: user.id,
        email: user.email,
        name: user.name,
        roleId: user.roleId,
        role: user.role.name,
        permissions,
      },
      process.env.JWT_SECRET!,
      { expiresIn: process.env.JWT_EXPIRES_IN || '15m' } as jwt.SignOptions
    )

    res.json({ success: true, accessToken: newAccessToken })
  } catch {
    throw new AppError('Invalid or expired refresh token', 401)
  }
})

// POST /api/auth/logout
router.post('/logout', (req, res) => {
  // Client-side token removal; server-side blacklist can be added with Redis
  res.json({ success: true, message: 'Logged out successfully' })
})

// GET /api/auth/me
router.get('/me', async (req, res) => {
  const authHeader = req.headers.authorization
  if (!authHeader?.startsWith('Bearer ')) throw new AppError('Unauthorized', 401)

  const token = authHeader.split(' ')[1]
  const decoded = jwt.verify(token, process.env.JWT_SECRET!) as { id: string }

  const user = await prisma.user.findUnique({
    where: { id: decoded.id },
    include: { role: true },
    omit: { passwordHash: true },
  } as Parameters<typeof prisma.user.findUnique>[0])

  if (!user) throw new AppError('User not found', 404)
  res.json({ success: true, user })
})

export default router
