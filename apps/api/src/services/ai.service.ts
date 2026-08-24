import {
  GoogleGenerativeAI,
  FunctionDeclarationSchemaType as SchemaType,
  type FunctionDeclaration,
  type Tool,
} from '@google/generative-ai'
import { prisma } from '@ld-erp/database'
import { logger } from '../utils/logger'
import { DEFAULT_MODEL, getAiConfig } from '../lib/aiConfig'
import { AppError } from '../middleware/errorHandler'

/**
 * The assistant is built per request rather than once at start-up, because the
 * API key is set from Settings and can change without restarting the server.
 */
async function assistant(): Promise<{ genAI: GoogleGenerativeAI; model: string }> {
  const config = await getAiConfig()

  if (!config.apiKey) {
    throw new AppError(
      'The assistant has no API key yet. Add one in Settings → Assistant.',
      409,
      'AI_NOT_CONFIGURED',
    )
  }
  if (!config.enabled) {
    throw new AppError('The assistant is switched off in Settings.', 409, 'AI_DISABLED')
  }

  return { genAI: new GoogleGenerativeAI(config.apiKey), model: config.model || DEFAULT_MODEL }
}

/**
 * Which permission each tool needs.
 *
 * The assistant runs as the person asking, so it must not become a way around
 * the permission grid — a stitching supervisor asking "what do customers owe
 * us?" should get the same answer as clicking Accounts would: no access.
 */
const TOOL_PERMISSIONS: Record<string, string> = {
  get_dashboard_summary: 'dashboard:view',
  get_sales_orders: 'sales:view',
  get_production_status: 'production:view',
  get_outstanding_payments: 'accounts:view',
  get_pending_approvals: 'dashboard:view',
  get_stock_status: 'inventory:view',
}

/** Admin holds everything, mirroring requirePermission in the auth middleware. */
function toolsFor(role: string, permissions: string[]): FunctionDeclaration[] {
  if (role === 'Admin') return erpTools
  const granted = new Set(permissions)
  return erpTools.filter((t) => {
    const needed = TOOL_PERMISSIONS[t.name]
    return !needed || granted.has(needed)
  })
}

const erpTools: FunctionDeclaration[] = [
  {
    name: 'get_dashboard_summary',
    description: "Get today's key business metrics: production, orders, financials",
    parameters: {
      type: SchemaType.OBJECT,
      properties: { date: { type: SchemaType.STRING, description: 'Date YYYY-MM-DD, defaults to today' } },
    },
  },
  {
    name: 'get_sales_orders',
    description: 'Get sales orders with optional filters',
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        status: { type: SchemaType.STRING, description: 'DRAFT, CONFIRMED, IN_PRODUCTION, PARTIALLY_DISPATCHED, COMPLETED' },
        dueThisWeek: { type: SchemaType.BOOLEAN, description: 'Orders due this week' },
        limit: { type: SchemaType.NUMBER, description: 'Max records, default 10' },
      },
    },
  },
  {
    name: 'get_production_status',
    description: 'Get current production status and line efficiency',
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        date: { type: SchemaType.STRING, description: 'Date YYYY-MM-DD' },
        department: { type: SchemaType.STRING, description: 'CUTTING, STITCHING, FINISHING, PACKING' },
      },
    },
  },
  {
    name: 'get_outstanding_payments',
    description: 'Get outstanding receivables or payables',
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        type: { type: SchemaType.STRING, description: '"receivable" for customers, "payable" for suppliers' },
        overdueDays: { type: SchemaType.NUMBER, description: 'Filter overdue by N days or more' },
      },
      required: ['type'],
    },
  },
  {
    name: 'get_pending_approvals',
    description: 'Get all documents pending approval (PO, MR, SO)',
    parameters: { type: SchemaType.OBJECT, properties: {} },
  },
  {
    name: 'get_stock_status',
    description: 'Check stock levels and low stock alerts',
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        showLowStock: { type: SchemaType.BOOLEAN, description: 'Only show items below reorder level' },
        itemCode: { type: SchemaType.STRING, description: 'Specific item code' },
      },
    },
  },
]

async function executeTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  logger.info(`AI Tool: ${name}`, args)

  switch (name) {
    case 'get_dashboard_summary': {
      const today = new Date()
      const sod = new Date(today.getFullYear(), today.getMonth(), today.getDate())
      const eod = new Date(today.getFullYear(), today.getMonth(), today.getDate(), 23, 59, 59)
      const som = new Date(today.getFullYear(), today.getMonth(), 1)

      const [orders, prod, pendingPO, revenue, receivable] = await Promise.all([
        prisma.salesOrder.count({ where: { status: { in: ['CONFIRMED', 'IN_PRODUCTION', 'PARTIALLY_DISPATCHED'] } } }),
        prisma.productionEntry.aggregate({ where: { entryDate: { gte: sod, lte: eod } }, _sum: { achieved: true, target: true, rejection: true } }),
        prisma.purchaseOrder.count({ where: { status: 'DRAFT', approvedAt: null } }),
        prisma.salesInvoice.aggregate({ where: { invoiceDate: { gte: som } }, _sum: { totalAmount: true } }),
        prisma.salesInvoice.aggregate({ where: { status: { in: ['UNPAID', 'PARTIAL'] } }, _sum: { balanceAmount: true } }),
      ])

      const achieved = prod._sum.achieved || 0
      const target = prod._sum.target || 1
      return {
        activeOrders: orders,
        production: { achieved, target, efficiency: `${Math.round((achieved / target) * 100)}%`, rejection: prod._sum.rejection || 0 },
        pendingApprovals: pendingPO,
        revenueMTD: `₹${((Number(revenue._sum.totalAmount) || 0) / 100000).toFixed(2)} Lakh`,
        outstandingReceivable: `₹${((Number(receivable._sum.balanceAmount) || 0) / 100000).toFixed(2)} Lakh`,
      }
    }

    case 'get_sales_orders': {
      const where: Record<string, unknown> = {}
      if (args.status) where.status = args.status
      if (args.dueThisWeek) {
        const now = new Date()
        const weekEnd = new Date(now)
        weekEnd.setDate(weekEnd.getDate() + 7)
        where.deliveryDate = { gte: now, lte: weekEnd }
      }
      const orders = await prisma.salesOrder.findMany({
        where,
        include: { customer: { select: { name: true } }, brand: { select: { name: true } } },
        orderBy: { deliveryDate: 'asc' },
        take: (args.limit as number) || 10,
      })
      return orders.map((o) => ({
        soNumber: o.soNumber,
        customer: o.customer.name,
        brand: o.brand.name,
        status: o.status,
        amount: `₹${(Number(o.totalAmount) / 100000).toFixed(2)}L`,
        delivery: o.deliveryDate?.toDateString(),
      }))
    }

    case 'get_pending_approvals': {
      const [pos, mrs] = await Promise.all([
        prisma.purchaseOrder.findMany({ where: { status: 'DRAFT', approvedAt: null }, include: { supplier: { select: { name: true } } }, take: 10 }),
        prisma.materialRequisition.findMany({
          where: { status: 'PENDING' },
          take: 10,
          include: { department: { select: { name: true } } },
        }),
      ])
      return {
        total: pos.length + mrs.length,
        purchaseOrders: pos.map((p) => ({ number: p.poNumber, supplier: p.supplier.name, amount: `₹${(Number(p.totalAmount) / 1000).toFixed(1)}K` })),
        materialRequisitions: mrs.map((m) => ({ number: m.mrNumber, dept: m.department.name })),
      }
    }

    case 'get_outstanding_payments': {
      if (args.type === 'receivable') {
        const inv = await prisma.salesInvoice.findMany({ where: { status: { in: ['UNPAID', 'PARTIAL'] } }, include: { customer: { select: { name: true } } }, take: 15, orderBy: { dueDate: 'asc' } })
        return inv.map((i) => ({ customer: i.customer.name, invoice: i.invoiceNumber, balance: `₹${(Number(i.balanceAmount) / 1000).toFixed(1)}K`, due: i.dueDate?.toDateString() }))
      } else {
        const bills = await prisma.purchaseInvoice.findMany({ where: { status: { in: ['UNPAID', 'PARTIAL'] } }, include: { supplier: { select: { name: true } } }, take: 15, orderBy: { dueDate: 'asc' } })
        return bills.map((b) => ({ supplier: b.supplier.name, bill: b.billNumber, balance: `₹${(Number(b.balanceAmount) / 1000).toFixed(1)}K`, due: b.dueDate?.toDateString() }))
      }
    }

    case 'get_production_status': {
      const date = args.date ? new Date(args.date as string) : new Date()
      const sod = new Date(date.getFullYear(), date.getMonth(), date.getDate())
      const eod = new Date(date.getFullYear(), date.getMonth(), date.getDate(), 23, 59, 59)
      // The department arrives as a name from the assistant's caller, so it is
      // matched against the department record rather than a free-text column.
      const entries = await prisma.productionEntry.findMany({
        where: {
          entryDate: { gte: sod, lte: eod },
          ...(args.department
            ? { department: { name: { equals: args.department as string, mode: 'insensitive' } } }
            : {}),
        },
      })
      const totalAchieved = entries.reduce((s, e) => s + e.achieved, 0)
      const totalTarget = entries.reduce((s, e) => s + e.target, 0)
      return { date: sod.toDateString(), totalAchieved, totalTarget, efficiency: `${totalTarget ? Math.round((totalAchieved / totalTarget) * 100) : 0}%`, lines: entries.length }
    }

    default:
      return { error: `Tool ${name} not yet implemented` }
  }
}

export interface AIMessage { role: 'user' | 'model'; content: string }

export async function chatWithERP(
  messages: AIMessage[],
  userId: string,
  userName: string,
  userRole: string,
  userPermissions: string[] = [],
): Promise<string> {
  const { genAI, model: modelName } = await assistant()

  const allowed = toolsFor(userRole, userPermissions)
  const withheld = erpTools.length - allowed.length

  const company = await prisma.company.findFirst({ select: { name: true, currentFY: true } })

  const model = genAI.getGenerativeModel({
    model: modelName,
    tools: [{ functionDeclarations: allowed } as Tool],
    systemInstruction: `You are the assistant inside LD ERP Solution, the ERP for ${company?.name ?? 'this company'} — a garment manufacturer making men's shirts.
You can read the live ERP database through the tools provided.

You are speaking to ${userName}, whose role is ${userRole}.
${
  withheld > 0
    ? `Their role does not give them access to everything. ${withheld} tool(s) have been withheld. If they ask about something you have no tool for, say plainly that their role does not have access to it and suggest they ask an administrator. Never guess at a figure you cannot look up.`
    : 'They have full access.'
}

Rules:
- Answer in the language they used — English, Hindi or Hinglish.
- Money in Indian format: ₹, lakh, crore.
- Quote document numbers whenever you have them.
- If a tool returns nothing, say so. Never invent a number, a customer or an order.
- Be brief. This is read on a phone between the cutting table and the office.

Financial year: ${company?.currentFY ?? 'not set'}.`,
  })

  const chat = model.startChat({
    history: messages.slice(0, -1).map((m) => ({ role: m.role, parts: [{ text: m.content }] })),
  })

  let result = await chat.sendMessage(messages[messages.length - 1].content)
  let response = result.response

  while (response.functionCalls()?.length) {
    const calls = response.functionCalls()!
    const allowedNames = new Set(allowed.map((t) => t.name))

    const fnResponses = await Promise.all(
      calls.map(async (call) => ({
        functionResponse: {
          name: call.name,
          response: {
            // A second gate. The model is only offered the tools this person may
            // use, but it must not be the only thing standing between a role and
            // data it cannot see.
            result: allowedNames.has(call.name)
              ? await executeTool(call.name, call.args as Record<string, unknown>).catch((e) => ({
                  error: e.message,
                }))
              : { error: `${userName}'s role does not have access to this information.` },
          },
        },
      }))
    )
    result = await chat.sendMessage(fnResponses)
    response = result.response
  }

  return response.text()
}

export async function generateDailyMISReport(date: Date = new Date()): Promise<string> {
  const { genAI, model: modelName } = await assistant()
  // The daily summary is for the owner, so it is not narrowed by role.
  const model = genAI.getGenerativeModel({
    model: modelName,
    tools: [{ functionDeclarations: erpTools } as Tool],
  })

  const result = await model.generateContent(
    `Generate a daily MIS report for LD Cotton Mills for ${date.toDateString()}.
    Include: 1) Production (output, efficiency, rejections) 2) Active orders & delivery 3) Financial highlights 4) Low stock 5) Pending approvals 6) Key action items.
    Format as a clean WhatsApp message with emojis. Max 400 words.`
  )
  return result.response.text()
}
