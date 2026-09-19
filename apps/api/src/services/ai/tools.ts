import { prisma } from '@ld-erp/database'
import { logger } from '../../utils/logger'
import { onHand } from '../stock.service'
import { isWriteTool, runWriteTool, writeToolsFor, type Proposal } from './writeTools'

/**
 * What the assistant is allowed to look up.
 *
 * This is the whole of the assistant's "training". Nobody trains a model on a
 * mill's data — you give it a small set of things it may look up, and it uses
 * them. That distinction matters in practice: an answer that came from a tool
 * is today's figure out of the real database, and an answer that did not is a
 * guess. Every tool here reads the live tables.
 *
 * Three rules hold this together:
 *
 *   1. **Read only.** There is no tool that writes. The assistant can tell you
 *      a purchase order is waiting; approving it is a button a person presses,
 *      with their name against it. An assistant that could approve things would
 *      make the audit trail a work of fiction.
 *   2. **Never more than the person could see themselves.** Each tool names the
 *      permission it needs. A stitching supervisor asking what customers owe us
 *      gets the same answer as clicking Accounts would: no access.
 *   3. **Only what exists.** There is no tool for a module that is not built.
 *      A tool returning an empty list would teach the assistant to say
 *      "nothing to report" about a feature nobody has written yet.
 */

/** A tool in a shape both OpenAI and Gemini can be handed. Plain JSON Schema. */
export interface ErpTool {
  name: string
  description: string
  /** The permission a person needs before this tool is offered to the model. */
  needs: string | null
  /**
   * What must be asked, in order, before this may be called at all.
   *
   * Write tools only. Without it the assistant fills the gaps itself — it read
   * "Vinayak Threads" and decided they supply thread, which is a good guess and
   * a bad way to open a supplier account. Everything here is a question put to
   * a person, in this order, one at a time.
   */
  gather?: string[]
  parameters: {
    type: 'object'
    properties: Record<string, { type: string; description: string; enum?: string[] }>
    required?: string[]
  }
}

export const ERP_TOOLS: ErpTool[] = [
  {
    name: 'get_dashboard_summary',
    description:
      "Today's headline figures: active orders, production against target, money invoiced this month, outstanding receivable, and how many documents are waiting for approval. Use this for broad questions like 'how are we doing'.",
    needs: 'dashboard:view',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'get_pending_approvals',
    description:
      'Documents waiting for somebody to approve them — purchase orders, sales orders and material requisitions.',
    needs: 'dashboard:view',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'get_sales_orders',
    description: 'Sales orders, newest first, with customer, value and delivery date.',
    needs: 'sales:view',
    parameters: {
      type: 'object',
      properties: {
        status: {
          type: 'string',
          description: 'Filter by status',
          enum: ['DRAFT', 'CONFIRMED', 'IN_PRODUCTION', 'PARTIALLY_DISPATCHED', 'COMPLETED', 'CANCELLED'],
        },
        customer: { type: 'string', description: 'Part of the customer name' },
        dueThisWeek: { type: 'boolean', description: 'Only orders due in the next seven days' },
        limit: { type: 'number', description: 'How many to return, default 10, max 50' },
      },
    },
  },
  {
    name: 'get_purchase_orders',
    description: 'Purchase orders raised on suppliers, with value, status and what was ordered.',
    needs: 'purchase:view',
    parameters: {
      type: 'object',
      properties: {
        status: {
          type: 'string',
          description: 'Filter by status',
          enum: ['DRAFT', 'SENT', 'PARTIALLY_RECEIVED', 'COMPLETED', 'CANCELLED'],
        },
        supplier: { type: 'string', description: 'Part of the supplier name' },
        limit: { type: 'number', description: 'How many to return, default 10, max 50' },
      },
    },
  },
  {
    name: 'get_stock_status',
    description:
      'What is on hand, item by item and store by store, with the rate it is carried at and its value. Use showLowStock for items at or below their reorder level.',
    needs: 'inventory:view',
    parameters: {
      type: 'object',
      properties: {
        search: { type: 'string', description: 'Part of an item name or code, e.g. "poplin"' },
        warehouse: { type: 'string', description: 'Part of a store name, e.g. "fabric godown"' },
        showLowStock: { type: 'boolean', description: 'Only items at or below reorder level' },
        limit: { type: 'number', description: 'How many rows, default 20, max 100' },
      },
    },
  },
  {
    name: 'get_stock_movements',
    description:
      'The history behind a stock figure for one item — what came in, what went out, and what it left behind. Use this to answer "why does it say that".',
    needs: 'inventory:view',
    parameters: {
      type: 'object',
      properties: {
        itemCodeOrName: { type: 'string', description: 'Item code or part of its name' },
        limit: { type: 'number', description: 'How many movements, default 15, max 50' },
      },
      required: ['itemCodeOrName'],
    },
  },
  {
    name: 'get_requisitions',
    description:
      'Material requisitions — what the floor has asked the store for, and whether it is waiting for approval, approved but not collected, or issued.',
    needs: 'inventory:view',
    parameters: {
      type: 'object',
      properties: {
        status: {
          type: 'string',
          description: 'Filter by status',
          enum: ['PENDING', 'APPROVED', 'REJECTED'],
        },
        limit: { type: 'number', description: 'How many, default 10, max 50' },
      },
    },
  },
  {
    name: 'get_production_status',
    description: 'What the floor made on a given day, against target, with rejections.',
    needs: 'production:view',
    parameters: {
      type: 'object',
      properties: {
        date: { type: 'string', description: 'Date as YYYY-MM-DD. Defaults to today.' },
        department: {
          type: 'string',
          description: 'Department name, e.g. Cutting, Stitching, Finishing, Packing',
        },
      },
    },
  },
  {
    name: 'get_outstanding_payments',
    description: 'Who owes us money, or who we owe, oldest due first.',
    needs: 'accounts:view',
    parameters: {
      type: 'object',
      properties: {
        type: {
          type: 'string',
          description: 'receivable for customers who owe us, payable for suppliers we owe',
          enum: ['receivable', 'payable'],
        },
      },
      required: ['type'],
    },
  },
  {
    name: 'offer_choices',
    description:
      "Ask a question whose answers are a fixed list. The choices are drawn as buttons the person taps, so they never have to type one back or guess your spelling. Use this for EVERY question with a set of answers — category, unit, type, department, store, yes/no. Say the question in your reply as one short line and do NOT list the choices in the text; they are already on screen.",
    needs: null,
    parameters: {
      type: 'object',
      properties: {
        question: { type: 'string', description: 'The question, in plain words' },
        choices: {
          type: 'string',
          description:
            'The answers, separated by a pipe |. Use the exact wording get_options returned — never a column value like PACKING_MATERIAL. Keep each under about 30 characters so it fits on a button.',
        },
      },
      required: ['question', 'choices'],
    },
  },
  {
    name: 'get_options',
    description:
      "Answers the question 'what categories/units/departments do we have?' when somebody asks it directly. DO NOT use this while adding a record — the create tool hands back its own choices, already drawn as buttons, and going round it means the create tool never gets to say what is still missing.",
    needs: 'masters:view',
    parameters: {
      type: 'object',
      properties: {
        what: {
          type: 'string',
          description: 'Which list',
          enum: [
            'item_categories',
            'units',
            'supplier_categories',
            'customer_types',
            'item_types',
            'departments',
            'warehouses',
            'gst_rates',
            'brands',
          ],
        },
      },
      required: ['what'],
    },
  },
  {
    name: 'find_party',
    description:
      'Look up a customer, supplier or broker: contact details, GSTIN, state, credit terms. Use this when somebody asks "what is X\'s number" or "where is X based".',
    needs: 'masters:view',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Part of the name or code' },
        kind: {
          type: 'string',
          description:
            'Ignored — customers, suppliers and brokers are all searched, and the answer says which register each result came from.',
          enum: ['customer', 'supplier', 'broker'],
        },
      },
      required: ['name'],
    },
  },
  {
    name: 'find_item',
    description:
      'Look up an item or a style: code, unit, HSN, GST rate, standard rate, reorder level. For a style it also returns what goes into it.',
    needs: 'masters:view',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Part of the name or code' },
        kind: {
          type: 'string',
          description: 'item for something in the godown, style for a garment design',
          enum: ['item', 'style'],
        },
      },
      required: ['name'],
    },
  },
]

/**
 * Only the tools this person's permissions allow. Admin holds everything.
 *
 * Reads and writes are gathered separately because they are gated differently:
 * a read needs one permission, a write needs two. See writeToolsFor.
 */
export function toolsFor(role: string, permissions: string[]): ErpTool[] {
  const reads =
    role === 'Admin' ? ERP_TOOLS : ERP_TOOLS.filter((t) => !t.needs || permissions.includes(t.needs))
  return [...reads, ...writeToolsFor(role, permissions)]
}

/** Just the reads, for counting what a role cannot reach. */
export const READ_TOOLS = ERP_TOOLS

// ── Formatting helpers ──────────────────────────────────────────────────────
//
// Figures go to the model already written the way a person in Bhiwandi says
// them. A model handed 4823910 will sometimes say "4.8 million", which is a
// correct number in the wrong language.

const lakh = (n: number): string => {
  const v = Number(n) || 0
  if (Math.abs(v) >= 10_000_000) return `₹${(v / 10_000_000).toFixed(2)} crore`
  if (Math.abs(v) >= 100_000) return `₹${(v / 100_000).toFixed(2)} lakh`
  return `₹${Math.round(v).toLocaleString('en-IN')}`
}

const qty = (n: number): string =>
  Number(n).toLocaleString('en-IN', { maximumFractionDigits: 3 })

const day = (d: Date | null | undefined): string | null =>
  d ? d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }) : null

const clamp = (v: unknown, fallback: number, max: number): number => {
  const n = Number(v)
  return Number.isFinite(n) && n > 0 ? Math.min(n, max) : fallback
}

const like = (v: unknown) => ({ contains: String(v), mode: 'insensitive' as const })

/**
 * Matches every word, in any order, anywhere in the field.
 *
 * A single "contains" looks reasonable until somebody asks for "cotton poplin
 * white" and the item is called "Cotton Poplin 40s — White". One substring
 * finds nothing and the assistant reports, honestly and uselessly, that there
 * is no such item. Splitting on spaces is what everyone means by search.
 */
const everyWord = (field: 'name' | 'code', v: unknown) => {
  const words = String(v).trim().split(/\s+/).filter(Boolean)
  return words.map((w) => ({ [field]: like(w) }))
}

// ── Running a tool ──────────────────────────────────────────────────────────

/** Who is asking. Read tools use it to narrow; write tools use it to refuse. */
export interface Caller {
  userId: string
  userName: string
  role: string
  permissions: string[]
  ip: string | null
  /** How many things this person has said. Write confirmations hang off it. */
  turnCount: number
  /** Told about a change that was described, so it can be recalled next turn. */
  onProposal?: (proposal: Proposal) => void
  /** Told when something was saved, so the waiting proposal can be cleared. */
  onCommitted?: () => void
  /** Told when a question with fixed answers is asked, so it can be drawn as buttons. */
  onQuestion?: (question: { question: string; choices: string[] }) => void
}

const can = (caller: Caller, needed: string) =>
  caller.role === 'Admin' || caller.permissions.includes(needed)

export async function executeTool(
  name: string,
  args: Record<string, unknown>,
  caller: Caller,
): Promise<unknown> {
  // Arguments are logged for the reads. For a write they are logged by
  // runWriteTool only once it commits, so a preview nobody agreed to does not
  // leave a line that reads as though something happened.
  if (isWriteTool(name)) {
    return runWriteTool(name, args, {
      userId: caller.userId,
      userName: caller.userName,
      ip: caller.ip,
      turnCount: caller.turnCount,
      can: (permission) => can(caller, permission),
      onProposal: caller.onProposal,
      onCommitted: caller.onCommitted,
      onQuestion: caller.onQuestion,
    })
  }

  logger.info(`AI tool: ${name} ${JSON.stringify(args)}`)

  switch (name) {
    case 'get_dashboard_summary': {
      const now = new Date()
      const sod = new Date(now.getFullYear(), now.getMonth(), now.getDate())
      const eod = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59)
      const som = new Date(now.getFullYear(), now.getMonth(), 1)

      const [orders, prod, pendingPO, pendingMR, revenue, receivable, payable] =
        await Promise.all([
          prisma.salesOrder.count({
            where: { status: { in: ['CONFIRMED', 'IN_PRODUCTION', 'PARTIALLY_DISPATCHED'] } },
          }),
          prisma.productionEntry.aggregate({
            where: { entryDate: { gte: sod, lte: eod } },
            _sum: { achieved: true, target: true, rejection: true },
          }),
          prisma.purchaseOrder.count({ where: { status: 'DRAFT', approvedAt: null, deletedAt: null } }),
          prisma.materialRequisition.count({ where: { status: 'PENDING' } }),
          prisma.salesInvoice.aggregate({
            where: { invoiceDate: { gte: som } },
            _sum: { totalAmount: true },
          }),
          prisma.salesInvoice.aggregate({
            where: { status: { in: ['UNPAID', 'PARTIAL'] } },
            _sum: { balanceAmount: true },
          }),
          prisma.purchaseInvoice.aggregate({
            where: { status: { in: ['UNPAID', 'PARTIAL'] } },
            _sum: { balanceAmount: true },
          }),
        ])

      const achieved = prod._sum.achieved ?? 0
      const target = prod._sum.target ?? 0

      // The summary is the one tool that mixes subjects — production, money and
      // stock in a single answer — so it is the one place where "this person may
      // open the dashboard" is not enough. A live test caught a Store Manager
      // being told what every customer owes, which is exactly the figure their
      // role exists to withhold. Each part is now gated on its own module.
      const showMoney = can(caller, 'accounts:view')
      const showStock = can(caller, 'inventory:view')

      const stockValue = showStock
        ? (await onHand(prisma, {}))
            .filter((r) => r.ownership === 'OWNED')
            .reduce((s, r) => s + r.value, 0)
        : null

      return {
        today: day(now),
        activeOrders: orders,
        productionToday: {
          made: achieved,
          target,
          efficiency: target > 0 ? `${Math.round((achieved / target) * 100)}%` : 'no target set',
          rejected: prod._sum.rejection ?? 0,
          note: target === 0 && achieved === 0 ? 'Nothing logged on the floor today' : undefined,
        },
        invoicedThisMonth: showMoney ? lakh(Number(revenue._sum.totalAmount)) : undefined,
        theyOweUs: showMoney ? lakh(Number(receivable._sum.balanceAmount)) : undefined,
        weOweThem: showMoney ? lakh(Number(payable._sum.balanceAmount)) : undefined,
        stockOnHand: stockValue === null ? undefined : lakh(stockValue),
        waitingForApproval: { purchaseOrders: pendingPO, requisitions: pendingMR },
        withheld: [
          ...(showMoney ? [] : ['money figures — this person has no accounts access']),
          ...(showStock ? [] : ['stock value — this person has no inventory access']),
        ],
      }
    }

    case 'get_pending_approvals': {
      const [pos, sos, mrs] = await Promise.all([
        prisma.purchaseOrder.findMany({
          where: { status: 'DRAFT', approvedAt: null, deletedAt: null },
          include: { supplier: { select: { name: true } } },
          orderBy: { createdAt: 'asc' },
          take: 15,
        }),
        prisma.salesOrder.findMany({
          where: { status: 'DRAFT', approvedAt: null },
          include: { customer: { select: { name: true } } },
          orderBy: { createdAt: 'asc' },
          take: 15,
        }),
        prisma.materialRequisition.findMany({
          where: { status: 'PENDING' },
          include: {
            department: { select: { name: true } },
            raisedBy: { select: { name: true } },
          },
          orderBy: { createdAt: 'asc' },
          take: 15,
        }),
      ])

      return {
        total: pos.length + sos.length + mrs.length,
        purchaseOrders: pos.map((p) => ({
          number: p.poNumber,
          supplier: p.supplier.name,
          value: lakh(Number(p.totalAmount)),
          raised: day(p.createdAt),
        })),
        salesOrders: sos.map((s) => ({
          number: s.soNumber,
          customer: s.customer.name,
          value: lakh(Number(s.totalAmount)),
          raised: day(s.createdAt),
        })),
        materialRequisitions: mrs.map((m) => ({
          number: m.mrNumber,
          department: m.department.name,
          raisedBy: m.raisedBy?.name ?? null,
          raised: day(m.createdAt),
        })),
      }
    }

    case 'get_sales_orders': {
      const where: Record<string, unknown> = {}
      if (args.status) where.status = args.status
      if (args.customer) where.customer = { name: like(args.customer) }
      if (args.dueThisWeek) {
        const now = new Date()
        const weekEnd = new Date(now)
        weekEnd.setDate(weekEnd.getDate() + 7)
        where.deliveryDate = { gte: now, lte: weekEnd }
      }

      const orders = await prisma.salesOrder.findMany({
        where,
        include: {
          customer: { select: { name: true } },
          brand: { select: { name: true } },
        },
        orderBy: { orderDate: 'desc' },
        take: clamp(args.limit, 10, 50),
      })

      if (orders.length === 0) return { found: 0, orders: [] }

      return {
        found: orders.length,
        orders: orders.map((o) => ({
          number: o.soNumber,
          customer: o.customer.name,
          brand: o.brand.name,
          status: o.status,
          value: lakh(Number(o.totalAmount)),
          ordered: day(o.orderDate),
          delivery: day(o.deliveryDate),
        })),
      }
    }

    case 'get_purchase_orders': {
      // The assistant sees what a person sees, and a binned order is not it.
      const where: Record<string, unknown> = { deletedAt: null }
      if (args.status) where.status = args.status
      if (args.supplier) where.supplier = { name: like(args.supplier) }

      const orders = await prisma.purchaseOrder.findMany({
        where,
        include: {
          supplier: { select: { name: true } },
          lines: { include: { item: { select: { name: true } } }, take: 5 },
        },
        orderBy: { poDate: 'desc' },
        take: clamp(args.limit, 10, 50),
      })

      if (orders.length === 0) return { found: 0, orders: [] }

      return {
        found: orders.length,
        orders: orders.map((o) => ({
          number: o.poNumber,
          supplier: o.supplier.name,
          status: o.status,
          value: lakh(Number(o.totalAmount)),
          ordered: day(o.poDate),
          wantedBy: day(o.deliveryDate),
          items: o.lines.map((l) => `${l.item.name} × ${qty(Number(l.qty))}`),
        })),
      }
    }

    case 'get_stock_status': {
      const warehouse = args.warehouse
        ? await prisma.warehouse.findFirst({ where: { name: like(args.warehouse) } })
        : null

      if (args.warehouse && !warehouse) {
        return { error: `No store called "${args.warehouse}".` }
      }

      const rows = await onHand(prisma, {
        searchWords: args.search ? String(args.search).trim().split(/\s+/).filter(Boolean) : undefined,
        warehouseId: warehouse?.id,
        lowOnly: args.showLowStock === true,
      })

      const limit = clamp(args.limit, 20, 100)
      const owned = rows.filter((r) => r.ownership === 'OWNED')

      return {
        found: rows.length,
        showing: Math.min(rows.length, limit),
        totalValue: lakh(owned.reduce((s, r) => s + r.value, 0)),
        belowReorderLevel: rows.filter((r) => r.isLow).length,
        rows: rows.slice(0, limit).map((r) => ({
          item: r.itemName,
          code: r.itemCode,
          store: r.warehouseName,
          onHand: `${qty(r.qty)} ${r.uom}`,
          rate: r.ownership === 'OWNED' ? `₹${r.avgRate}` : null,
          value: r.ownership === 'OWNED' ? lakh(r.value) : null,
          belowReorder: r.isLow,
          reorderLevel: r.reorderLevel,
          // Job work fabric is in our godown but belongs to the customer. It
          // must never be counted as ours in an answer about stock value.
          belongsTo: r.ownership === 'CUSTOMER_OWNED' ? (r.ownerName ?? 'a customer') : 'us',
        })),
      }
    }

    case 'get_stock_movements': {
      const needle = String(args.itemCodeOrName ?? '')
      const item = await prisma.item.findFirst({
        where: {
          OR: [{ code: like(needle) }, { AND: everyWord('name', needle) }],
        },
        include: { uom: { select: { symbol: true } } },
      })
      if (!item) return { error: `No item matching "${needle}".` }

      const movements = await prisma.stockLedger.findMany({
        where: { itemId: item.id },
        include: { warehouse: { select: { name: true } } },
        orderBy: [{ transactionDate: 'desc' }, { createdAt: 'desc' }],
        take: clamp(args.limit, 15, 50),
      })

      const balances = await onHand(prisma, { itemId: item.id })

      return {
        item: `${item.name} (${item.code})`,
        onHandNow: balances
          .map((b) => `${qty(b.qty)} ${b.uom} in ${b.warehouseName}`)
          .join(', ') || 'nothing on hand',
        movements: movements.map((m) => ({
          date: day(m.transactionDate),
          what: m.transactionType,
          store: m.warehouse.name,
          in: Number(m.inQty) > 0 ? qty(Number(m.inQty)) : null,
          out: Number(m.outQty) > 0 ? qty(Number(m.outQty)) : null,
          leftAfter: qty(Number(m.closingStock)),
          note: m.notes,
        })),
      }
    }

    case 'get_requisitions': {
      const rows = await prisma.materialRequisition.findMany({
        where: args.status ? { status: args.status as never } : {},
        include: {
          department: { select: { name: true } },
          raisedBy: { select: { name: true } },
          lines: {
            include: { item: { select: { name: true, uom: { select: { symbol: true } } } } },
          },
        },
        orderBy: { createdAt: 'desc' },
        take: clamp(args.limit, 10, 50),
      })

      return {
        found: rows.length,
        requisitions: rows.map((m) => ({
          number: m.mrNumber,
          department: m.department.name,
          raisedBy: m.raisedBy?.name ?? null,
          raised: day(m.requestDate),
          // Three stages, not two. "Approved but not collected" is a cutting
          // room waiting, and it must not read the same as "done".
          stage:
            m.status === 'REJECTED'
              ? 'refused'
              : m.status === 'PENDING'
                ? 'waiting for approval'
                : m.issuedAt
                  ? `issued on ${day(m.issuedAt)}`
                  : 'approved but not yet collected',
          items: m.lines.map(
            (l) => `${l.item.name} × ${qty(Number(l.requestedQty))} ${l.item.uom.symbol}`,
          ),
        })),
      }
    }

    case 'get_production_status': {
      const date = args.date ? new Date(String(args.date)) : new Date()
      if (Number.isNaN(date.getTime())) return { error: 'That date could not be read.' }

      const sod = new Date(date.getFullYear(), date.getMonth(), date.getDate())
      const eod = new Date(date.getFullYear(), date.getMonth(), date.getDate(), 23, 59, 59)

      const entries = await prisma.productionEntry.findMany({
        where: {
          entryDate: { gte: sod, lte: eod },
          ...(args.department ? { department: { name: like(args.department) } } : {}),
        },
        include: {
          department: { select: { name: true } },
          operation: { select: { name: true } },
        },
      })

      if (entries.length === 0) {
        return {
          date: day(sod),
          note: 'Nothing was logged on the floor for that day. Recording production output is not built yet, so this will usually be empty.',
        }
      }

      const made = entries.reduce((s, e) => s + e.achieved, 0)
      const target = entries.reduce((s, e) => s + e.target, 0)

      return {
        date: day(sod),
        made,
        target,
        efficiency: target > 0 ? `${Math.round((made / target) * 100)}%` : 'no target set',
        rejected: entries.reduce((s, e) => s + e.rejection, 0),
        byDepartment: entries.map((e) => ({
          department: e.department.name,
          operation: e.operation?.name ?? null,
          shift: e.shift,
          made: e.achieved,
          target: e.target,
          rejected: e.rejection,
        })),
      }
    }

    case 'get_outstanding_payments': {
      if (args.type === 'payable') {
        const bills = await prisma.purchaseInvoice.findMany({
          where: { status: { in: ['UNPAID', 'PARTIAL'] } },
          include: { supplier: { select: { name: true } } },
          orderBy: { dueDate: 'asc' },
          take: 20,
        })
        return {
          type: 'payable',
          total: lakh(bills.reduce((s, b) => s + Number(b.balanceAmount), 0)),
          bills: bills.map((b) => ({
            supplier: b.supplier.name,
            bill: b.billNumber,
            outstanding: lakh(Number(b.balanceAmount)),
            due: day(b.dueDate),
            overdue: b.dueDate ? b.dueDate < new Date() : false,
          })),
        }
      }

      const invoices = await prisma.salesInvoice.findMany({
        where: { status: { in: ['UNPAID', 'PARTIAL'] } },
        include: { customer: { select: { name: true } } },
        orderBy: { dueDate: 'asc' },
        take: 20,
      })
      return {
        type: 'receivable',
        total: lakh(invoices.reduce((s, i) => s + Number(i.balanceAmount), 0)),
        invoices: invoices.map((i) => ({
          customer: i.customer.name,
          invoice: i.invoiceNumber,
          outstanding: lakh(Number(i.balanceAmount)),
          due: day(i.dueDate),
          overdue: i.dueDate ? i.dueDate < new Date() : false,
        })),
      }
    }

    case 'offer_choices': {
      const choices = String(args.choices ?? '')
        .split('|')
        .map((c) => c.trim())
        .filter(Boolean)
        .slice(0, 12)

      if (choices.length < 2) {
        return { error: 'A choice needs at least two answers. Just ask it as a question instead.' }
      }

      caller.onQuestion?.({ question: String(args.question ?? '').trim(), choices })
      // (offer_choices already refuses fewer than two, above.)
      return {
        shown: true,
        instruction:
          'The buttons are on screen. Reply with the question as one short line and nothing else — do not repeat the choices, do not number them, do not ask them to type one.',
      }
    }

    case 'get_options': {
      switch (args.what) {
        case 'item_categories':
          return {
            choices: (await prisma.itemCategory.findMany({ where: { isActive: true }, select: { name: true }, orderBy: { name: 'asc' } })).map((c) => c.name),
          }
        case 'units':
          return {
            choices: (await prisma.uOM.findMany({ select: { symbol: true, name: true }, orderBy: { name: 'asc' } })).map((u) => `${u.symbol} (${u.name})`),
          }
        case 'departments':
          return {
            choices: (await prisma.department.findMany({ where: { isActive: true }, select: { name: true }, orderBy: { name: 'asc' } })).map((d) => d.name),
          }
        case 'warehouses':
          return {
            choices: (await prisma.warehouse.findMany({ where: { isActive: true }, select: { name: true }, orderBy: { name: 'asc' } })).map((w) => w.name),
          }
        case 'brands':
          return {
            choices: (await prisma.brand.findMany({ where: { isActive: true }, select: { name: true } })).map((b) => b.name),
          }
        case 'gst_rates':
          return {
            choices: (await prisma.taxRate.findMany({ where: { isActive: true }, select: { rate: true }, orderBy: { rate: 'asc' } })).map((t) => `${Number(t.rate)}%`),
          }
        // These are fixed in the software rather than set up per mill, so they
        // are listed here with the words a person would use — "Job work", not
        // "JOB_WORK", which is a column value and not something anybody says.
        case 'supplier_categories':
          return {
            choices: [
              'Fabric', 'Thread', 'Button', 'Lining', 'Label',
              'Packaging', 'Trim', 'Transport', 'Service', 'Other',
            ],
          }
        case 'customer_types':
          return {
            choices: [
              'Domestic — sold within India',
              'Export — sold abroad',
              'Job work — they send their own fabric',
              'VHAGAR dealer — sells our own brand',
            ],
          }
        case 'item_types':
          return {
            choices: [
              'Raw material — cloth, thread, anything consumed',
              'Trim — buttons, zips, labels',
              'Packing material — poly bags, cartons, tags',
              'Consumable — needles, oil, chalk',
              'Semi finished',
              'Finished good — a garment ready to sell',
            ],
          }
        default:
          return { error: 'There is no list called that.' }
      }
    }

    case 'find_party': {
      const needle = String(args.name ?? '')
      // The kind is a hint, not a filter. A model asked for "Sanskar Textiles"
      // guessed "customer" — reasonable, and wrong, because they are a fabric
      // supplier. Honouring the guess turned a record that exists into
      // "not found", which is the one answer an assistant must never get wrong.
      const kind = undefined as string | undefined
      void args.kind
      const where = { OR: [{ AND: everyWord('name', needle) }, { code: like(needle) }] }
      const found: Record<string, unknown[]> = {}

      if (!kind || kind === 'customer') {
        const rows = await prisma.customer.findMany({ where, take: 8 })
        found.customers = rows.map((c) => ({
          name: c.name,
          code: c.code,
          type: c.type,
          phone: c.phone,
          email: c.email,
          gstin: c.gstin,
          place: [c.billingCity, c.billingState].filter(Boolean).join(', '),
          creditDays: c.creditDays,
          creditLimit: c.creditLimit ? lakh(Number(c.creditLimit)) : null,
        }))
      }
      if (!kind || kind === 'supplier') {
        const rows = await prisma.supplier.findMany({ where, take: 8 })
        found.suppliers = rows.map((s) => ({
          name: s.name,
          code: s.code,
          supplies: s.category,
          phone: s.phone,
          email: s.email,
          gstin: s.gstin,
          place: [s.city, s.state].filter(Boolean).join(', '),
          leadTimeDays: s.leadTimeDays,
          creditDays: s.creditDays,
          // Payment to an MSME supplier is due within 45 days by law, so this
          // is not decoration.
          msme: s.isMsme,
          groupCompany: s.isGroupCompany,
        }))
      }
      if (!kind || kind === 'broker') {
        const rows = await prisma.broker.findMany({ where, take: 8 })
        found.brokers = rows.map((b) => ({
          name: b.name,
          code: b.code,
          phone: b.phone,
          brokeragePercent: Number(b.brokeragePercent),
        }))
      }

      const total = Object.values(found).reduce((s, arr) => s + arr.length, 0)
      return total === 0 ? { found: 0, note: `Nobody matching "${needle}".` } : found
    }

    case 'find_item': {
      const needle = String(args.name ?? '')
      const where = { OR: [{ AND: everyWord('name', needle) }, { code: like(needle) }] }
      const styleWhere = where

      if (args.kind === 'style') {
        const styles = await prisma.style.findMany({
          where: styleWhere,
          include: {
            sizeGroup: { select: { name: true } },
            boms: {
              where: { isActive: true },
              include: {
                lines: { include: { componentItem: { select: { name: true, code: true } } } },
              },
            },
          },
          take: 5,
        })
        if (styles.length === 0) return { found: 0, note: `No style matching "${needle}".` }

        return {
          styles: styles.map((s) => ({
            code: s.code,
            name: s.name,
            brand: s.brandType,
            season: s.season,
            fabric: s.fabricType,
            fit: s.fit,
            sizes: s.sizeGroup?.name,
            colours: s.colors,
            materialCost: s.boms[0]?.totalCost ? `₹${s.boms[0].totalCost}` : null,
            goesInto: s.boms[0]?.lines.map(
              (l) => `${l.componentItem.name} × ${qty(Number(l.effectiveQty))}`,
            ),
          })),
        }
      }

      const items = await prisma.item.findMany({
        where,
        include: {
          uom: { select: { symbol: true } },
          category: { select: { name: true } },
          taxRate: { select: { rate: true } },
          style: { select: { name: true } },
        },
        take: 10,
      })
      if (items.length === 0) return { found: 0, note: `No item matching "${needle}".` }

      return {
        items: items.map((i) => ({
          code: i.code,
          name: i.name,
          category: i.category.name,
          unit: i.uom.symbol,
          hsn: i.hsnCode,
          gst: i.taxRate ? `${Number(i.taxRate.rate)}%` : null,
          standardRate: i.standardRate ? `₹${Number(i.standardRate)}` : null,
          reorderLevel: i.reorderLevel ? Number(i.reorderLevel) : null,
          style: i.style?.name ?? null,
          color: i.color,
        })),
      }
    }

    default:
      return { error: `There is no tool called ${name}.` }
  }
}
