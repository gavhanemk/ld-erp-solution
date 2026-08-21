import { GoogleGenerativeAI, FunctionDeclaration, Tool } from '@google/generative-ai'
import { prisma } from '@ld-erp/database'
import { logger } from '../utils/logger'

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY!)

const erpTools: FunctionDeclaration[] = [
  {
    name: 'get_dashboard_summary',
    description: "Get today's key business metrics: production, orders, financials",
    parameters: {
      type: 'object' as const,
      properties: { date: { type: 'string', description: 'Date YYYY-MM-DD, defaults to today' } },
    },
  },
  {
    name: 'get_sales_orders',
    description: 'Get sales orders with optional filters',
    parameters: {
      type: 'object' as const,
      properties: {
        status: { type: 'string', description: 'DRAFT, CONFIRMED, IN_PRODUCTION, PARTIALLY_DISPATCHED, COMPLETED' },
        dueThisWeek: { type: 'boolean', description: 'Orders due this week' },
        limit: { type: 'number', description: 'Max records, default 10' },
      },
    },
  },
  {
    name: 'get_production_status',
    description: 'Get current production status and line efficiency',
    parameters: {
      type: 'object' as const,
      properties: {
        date: { type: 'string', description: 'Date YYYY-MM-DD' },
        department: { type: 'string', description: 'CUTTING, STITCHING, FINISHING, PACKING' },
      },
    },
  },
  {
    name: 'get_outstanding_payments',
    description: 'Get outstanding receivables or payables',
    parameters: {
      type: 'object' as const,
      properties: {
        type: { type: 'string', description: '"receivable" for customers, "payable" for suppliers' },
        overdueDays: { type: 'number', description: 'Filter overdue by N days or more' },
      },
      required: ['type'],
    },
  },
  {
    name: 'get_pending_approvals',
    description: 'Get all documents pending approval (PO, MR, SO)',
    parameters: { type: 'object' as const, properties: {} },
  },
  {
    name: 'get_stock_status',
    description: 'Check stock levels and low stock alerts',
    parameters: {
      type: 'object' as const,
      properties: {
        showLowStock: { type: 'boolean', description: 'Only show items below reorder level' },
        itemCode: { type: 'string', description: 'Specific item code' },
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
        prisma.materialRequisition.findMany({ where: { status: 'PENDING' }, take: 10 }),
      ])
      return {
        total: pos.length + mrs.length,
        purchaseOrders: pos.map((p) => ({ number: p.poNumber, supplier: p.supplier.name, amount: `₹${(Number(p.totalAmount) / 1000).toFixed(1)}K` })),
        materialRequisitions: mrs.map((m) => ({ number: m.mrNumber, dept: m.department })),
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
      const entries = await prisma.productionEntry.findMany({ where: { entryDate: { gte: sod, lte: eod }, ...(args.department ? { department: args.department as string } : {}) } })
      const totalAchieved = entries.reduce((s, e) => s + e.achieved, 0)
      const totalTarget = entries.reduce((s, e) => s + e.target, 0)
      return { date: sod.toDateString(), totalAchieved, totalTarget, efficiency: `${totalTarget ? Math.round((totalAchieved / totalTarget) * 100) : 0}%`, lines: entries.length }
    }

    default:
      return { error: `Tool ${name} not yet implemented` }
  }
}

export interface AIMessage { role: 'user' | 'model'; content: string }

export async function chatWithERP(messages: AIMessage[], userId: string, userName: string, userRole: string): Promise<string> {
  const model = genAI.getGenerativeModel({
    model: process.env.GEMINI_MODEL || 'gemini-2.0-flash-exp',
    tools: [{ functionDeclarations: erpTools } as Tool],
    systemInstruction: `You are the LD ERP Solution AI Assistant for LD Cotton Mills — a garment manufacturing company.
You have real-time access to the ERP database and can answer queries and perform actions.

User: ${userName} | Role: ${userRole}

Rules:
- Respond in the same language as the user (Hindi/English/Hinglish)
- Always show amounts in Indian format: ₹, lakhs (L), crores (Cr)
- Reference specific document numbers when available
- Be concise but complete
- Confirm before any write/approval action

Company: LD Cotton Mills | Products: Men's shirts | Brands: LD Cotton Mills + VHAGAR`,
  })

  const chat = model.startChat({
    history: messages.slice(0, -1).map((m) => ({ role: m.role, parts: [{ text: m.content }] })),
  })

  let result = await chat.sendMessage(messages[messages.length - 1].content)
  let response = result.response

  while (response.functionCalls()?.length) {
    const calls = response.functionCalls()!
    const fnResponses = await Promise.all(
      calls.map(async (call) => ({
        functionResponse: {
          name: call.name,
          response: { result: await executeTool(call.name, call.args as Record<string, unknown>).catch((e) => ({ error: e.message })) },
        },
      }))
    )
    result = await chat.sendMessage(fnResponses)
    response = result.response
  }

  return response.text()
}

export async function generateDailyMISReport(date: Date = new Date()): Promise<string> {
  const model = genAI.getGenerativeModel({ model: process.env.GEMINI_MODEL || 'gemini-2.0-flash-exp', tools: [{ functionDeclarations: erpTools } as Tool] })

  const result = await model.generateContent(
    `Generate a daily MIS report for LD Cotton Mills for ${date.toDateString()}.
    Include: 1) Production (output, efficiency, rejections) 2) Active orders & delivery 3) Financial highlights 4) Low stock 5) Pending approvals 6) Key action items.
    Format as a clean WhatsApp message with emojis. Max 400 words.`
  )
  return result.response.text()
}
