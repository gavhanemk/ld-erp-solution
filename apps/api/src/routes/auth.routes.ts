import { Router } from 'express'
import bcrypt from 'bcryptjs'
import jwt from 'jsonwebtoken'
import { prisma } from '@ld-erp/database'
import { z } from 'zod'
import { AppError } from '../middleware/errorHandler'
import { authMiddleware, type AuthRequest } from '../middleware/auth'
import { SCREENS, SUPER_ROLE } from '../lib/accessCatalog'

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

  // The grants travel with the user for the screen's first paint; the token
  // itself carries only who this is. What they may do is read on every
  // request (lib/access.ts), so it no longer has to fit in a header.
  const permissions = user.role.permissions.map(
    (rp) => `${rp.permission.module}:${rp.permission.action}`
  )

  const payload = {
    id: user.id,
    email: user.email,
    name: user.name,
    roleId: user.roleId,
    role: user.role.name,
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
      superAdmin: user.role.name === SUPER_ROLE,
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

    const newAccessToken = jwt.sign(
      {
        id: user.id,
        email: user.email,
        name: user.name,
        roleId: user.roleId,
        role: user.role.name,
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
// Who is signed in and what they may open, read fresh: the screen uses it to
// draw the menu and to turn away a page this role may not see. The screens
// come with their pages, so the menu needs no list of its own to keep in step.
router.get('/me', authMiddleware, async (req: AuthRequest, res) => {
  const u = req.user!
  const user = await prisma.user.findUnique({
    where: { id: u.id },
    // The rest is for the profile window under the initials in the top bar.
    select: {
      id: true,
      name: true,
      email: true,
      avatarUrl: true,
      phone: true,
      employeeCode: true,
      lastLoginAt: true,
      createdAt: true,
    },
  })
  if (!user) throw new AppError('User not found', 404)
  res.json({
    success: true,
    user: { ...user, role: u.role, superAdmin: Boolean(u.superAdmin), permissions: u.permissions ?? [] },
    screens: [...SCREENS.values()].filter((sc) => sc.hrefs.length).map((sc) => ({ key: sc.key, hrefs: sc.hrefs })),
  })
})

export default router
