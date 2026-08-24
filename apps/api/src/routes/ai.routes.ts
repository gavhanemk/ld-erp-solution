import { Router } from 'express'
import { prisma } from '@ld-erp/database'
import { AuthRequest } from '../middleware/auth'
import { chatWithERP, generateDailyMISReport } from '../services/ai.service'
import { z } from 'zod'
import { AppError } from '../middleware/errorHandler'

const router = Router()

const chatSchema = z.object({
  messages: z.array(z.object({
    role: z.enum(['user', 'model']),
    content: z.string(),
  })),
  conversationId: z.string().optional(),
})

// POST /api/ai/chat — Main AI chat endpoint
router.post('/chat', async (req: AuthRequest, res) => {
  const { messages, conversationId } = chatSchema.parse(req.body)
  const user = req.user!

  // Get or create conversation
  let convId = conversationId
  if (!convId) {
    const conv = await prisma.aIConversation.create({
      data: { userId: user.id, channel: 'IN_APP' },
    })
    convId = conv.id
  }

  // Save user message
  const lastMsg = messages[messages.length - 1]
  await prisma.aIMessage.create({
    data: {
      conversationId: convId,
      role: 'USER',
      content: lastMsg.content,
    },
  })

  // Get AI response
  // The permissions carried in the caller's token decide which ERP tools the
  // assistant may reach, so it can never answer something the person could not
  // have looked up themselves.
  const response = await chatWithERP(
    messages,
    user.id,
    user.name,
    user.role,
    user.permissions ?? [],
  )

  // Save AI response
  await prisma.aIMessage.create({
    data: {
      conversationId: convId,
      role: 'ASSISTANT',
      content: response,
    },
  })

  res.json({
    success: true,
    data: {
      response,
      conversationId: convId,
    },
  })
})

// GET /api/ai/conversations — Get user's conversations
router.get('/conversations', async (req: AuthRequest, res) => {
  const conversations = await prisma.aIConversation.findMany({
    where: { userId: req.user!.id },
    include: {
      messages: {
        orderBy: { createdAt: 'desc' },
        take: 1,
      },
      _count: { select: { messages: true } },
    },
    orderBy: { updatedAt: 'desc' },
    take: 20,
  })

  res.json({ success: true, data: conversations })
})

// GET /api/ai/conversations/:id — Get conversation history
router.get('/conversations/:id', async (req: AuthRequest, res) => {
  const conv = await prisma.aIConversation.findFirst({
    where: { id: req.params.id, userId: req.user!.id },
    include: { messages: { orderBy: { createdAt: 'asc' } } },
  })

  if (!conv) throw new AppError('Conversation not found', 404)
  res.json({ success: true, data: conv })
})

// POST /api/ai/mis/generate — Generate Daily MIS Report
router.post('/mis/generate', async (req: AuthRequest, res) => {
  const { date } = req.body
  const report = await generateDailyMISReport(date ? new Date(date) : new Date())
  res.json({ success: true, data: { report } })
})

// POST /api/ai/mis/send-whatsapp — Send MIS via WhatsApp
router.post('/mis/send-whatsapp', async (req: AuthRequest, res) => {
  const { phone } = req.body
  if (!phone) throw new AppError('Phone number required', 400)

  const report = await generateDailyMISReport()

  // WhatsApp Business API call
  const waRes = await fetch(
    `${process.env.WHATSAPP_API_URL}/${process.env.WHATSAPP_PHONE_NUMBER_ID}/messages`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.WHATSAPP_ACCESS_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to: phone,
        type: 'text',
        text: { body: report },
      }),
    }
  )

  if (!waRes.ok) throw new AppError('Failed to send WhatsApp message', 500)

  res.json({ success: true, message: 'MIS report sent via WhatsApp' })
})

export default router
