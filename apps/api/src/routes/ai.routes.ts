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

  // A change described on an earlier message and not yet answered.
  //
  // The client sends only the words either side said, so a confirmation code
  // handed out last time would be gone by now — the assistant would describe
  // the same change again for ever. It is remembered here instead, which is
  // better than trusting the model to: the values cannot drift between what
  // somebody read and what gets saved.
  const pending = await loadPendingProposal(convId)

  // The permissions carried in the caller's token decide which ERP tools the
  // assistant may reach, so it can never answer, or change, something the
  // person could not have done themselves on a screen.
  const result = await chatWithERP({
    messages,
    userId: user.id,
    userName: user.name,
    userRole: user.role,
    userPermissions: user.permissions ?? [],
    ip: req.ip ?? null,
    pending,
  })

  await prisma.aIMessage.create({
    data: {
      conversationId: convId,
      role: 'ASSISTANT',
      content: result.text,
    },
  })

  // A proposal is spent the moment anything is saved, and replaced whenever a
  // new one is described. Leaving a stale one behind would let "yes" a quarter
  // of an hour later save something nobody was still talking about.
  if (result.committed || result.proposal) {
    await clearPendingProposals(convId)
  }
  if (result.proposal) {
    await prisma.aIMessage.create({
      data: {
        conversationId: convId,
        role: PROPOSAL_ROLE,
        content: result.proposal.summary,
        toolCalls: result.proposal as never,
      },
    })
  }

  res.json({
    success: true,
    data: {
      response: result.text,
      conversationId: convId,
      /** True while a change is described and waiting for a yes. */
      awaitingConfirmation: Boolean(result.proposal),
      saved: result.committed,
    },
  })
})

/**
 * Proposals live as rows in the conversation, marked with a role no client
 * renders. Using the transcript rather than a new table means an abandoned
 * conversation takes its pending change with it when it is deleted.
 */
const PROPOSAL_ROLE = 'PROPOSAL'
const PROPOSAL_TTL_MS = 15 * 60 * 1000

async function loadPendingProposal(conversationId: string) {
  const row = await prisma.aIMessage.findFirst({
    where: { conversationId, role: PROPOSAL_ROLE },
    orderBy: { createdAt: 'desc' },
  })
  if (!row?.toolCalls) return null

  // The ticket inside carries its own expiry and the server checks it before
  // saving anything. This is only so the model is not reminded of something
  // stale that it would then have to be refused for using.
  if (Date.now() - row.createdAt.getTime() > PROPOSAL_TTL_MS) return null

  return row.toolCalls as unknown as {
    tool: string
    args: Record<string, unknown>
    ticket: string
    summary: string
  }
}

const clearPendingProposals = (conversationId: string) =>
  prisma.aIMessage.deleteMany({ where: { conversationId, role: PROPOSAL_ROLE } })

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
    include: {
      // PROPOSAL rows are bookkeeping for a waiting change, not something
      // either side said, so they never appear in the transcript.
      messages: { where: { role: { not: PROPOSAL_ROLE } }, orderBy: { createdAt: 'asc' } },
    },
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
