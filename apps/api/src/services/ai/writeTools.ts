import { prisma } from '@ld-erp/database'
import { recordAudit } from '../../lib/audit'
import { nextDocumentNumber } from '../../lib/docNumber'
import { withGeneratedCode } from '../../lib/masterCode'
import { logger } from '../../utils/logger'
import {
  createCustomerSchema,
  createItemSchema,
  createSupplierSchema,
  updateBrokerSchema,
  updateCustomerSchema,
  updateItemSchema,
  updateSupplierSchema,
} from '../../schemas/master.schemas'
import { checkTicket, mintTicket } from './confirm'
import type { ErpTool } from './tools'

/**
 * What the assistant is allowed to change.
 *
 * The read tools answer questions. These change the mill's records, so they
 * carry four guarantees the read side does not need:
 *
 *   1. **Two permissions, not one.** A role needs the module permission the same
 *      act would need on the screen — masters:create to add a supplier — *and*
 *      a chat switch: `ai:create` to change records, `ai:approve` to decide
 *      them. Someone can be allowed to add suppliers at their desk and not from
 *      a phone in a corridor, or to approve from a corridor and never type a
 *      supplier in at all. Both are per-role decisions in Settings → Roles
 *      rather than rules in this file.
 *   2. **Nothing happens on the first ask.** Every write validates, shows exactly
 *      what would be saved, and stops. It saves only when the person has said
 *      yes and handed back a ticket. See confirm.ts for why that cannot be
 *      faked by the model.
 *   3. **The same rules as the screens.** The same Zod schemas the web forms
 *      post through, the same document numbering, the same refusals. There is no
 *      second, laxer way into the database.
 *   4. **The audit row names the person, not the assistant.** Whoever confirmed
 *      it owns the change. The row also records that it came through the chat.
 *
 * What is deliberately absent: anything that moves money or stock. No invoices,
 * no payments, no stock issues, no goods receipts. Those carry a document
 * number, a tax position and a legal life, and they are worth the two minutes
 * it takes to fill the form in. Approving is here, because approving from a
 * corridor is the whole reason an MD wanted this.
 */

/**
 * The switches that say a role may change things through the chat at all.
 *
 * Two, not one, because they are different decisions. An MD approves from a
 * corridor and never types a new supplier in; a store clerk is the other way
 * round. Both map onto permissions that already exist in the grid, so this is
 * ticked in Settings → Roles rather than written here.
 */
export const AI_GATE = {
  change: 'ai:create',
  decide: 'ai:approve',
} as const

export const AI_WRITE_PERMISSIONS: string[] = [AI_GATE.change, AI_GATE.decide]

/** A change that has been described to somebody and is waiting on their answer. */
export interface Proposal {
  tool: string
  args: Record<string, unknown>
  ticket: string
  /** The same content as title/fields, flattened for the model. */
  summary: string
  /** For the chat to draw a card. */
  title: string
  fields: Array<{ label: string; value: string }>
  note?: string
}

export interface WriteContext {
  userId: string
  userName: string
  ip: string | null
  /** How many things the person has said. A ticket can only be spent on a later one. */
  turnCount: number
  can: (permission: string) => boolean
  /** Called when a change is described. The caller remembers it for next time. */
  onProposal?: (proposal: Proposal) => void
  /** Called once something is actually saved, so the waiting proposal is cleared. */
  onCommitted?: () => void
}

/**
 * What a write would do, once names have been turned into records.
 *
 * Structured rather than a paragraph, because the chat draws it as a card with
 * a Confirm button. A person checking figures wants them in a column, not in a
 * sentence — and a field the model quietly dropped is a field nobody can spot
 * missing from prose.
 */
export interface Built {
  /** "Add a supplier", "Change Meridian Zip Works". */
  title: string
  /** One row per thing that would be saved. */
  fields: Array<{ label: string; value: string }>
  /** Anything the person should know before agreeing. */
  note?: string
  /** Carried from build to commit so the lookups are not done twice. */
  payload: Record<string, unknown>
}

/** The same thing as text, for the model to read back if it needs to. */
export function asText(built: Built): string {
  return [
    `${built.title}:`,
    ...built.fields.map((f) => `  ${f.label}: ${f.value}`),
    ...(built.note ? ['', built.note] : []),
  ].join('\n')
}

/** Turns a data object into display rows, skipping anything empty. */
const rows = (o: Record<string, unknown>): Array<{ label: string; value: string }> =>
  Object.entries(o)
    .filter(([, v]) => has(v))
    .map(([label, value]) => ({ label, value: String(value) }))

interface WriteDefinition {
  tool: ErpTool
  /** Which of the two chat switches this one sits behind. */
  gate: (typeof AI_GATE)[keyof typeof AI_GATE]
  /**
   * Resolves names to records, validates, and describes. Runs on both passes —
   * on the second it re-checks, so a record deleted between the preview and the
   * confirmation cannot be written to.
   */
  build: (args: Args) => Promise<Built>
  commit: (built: Built, ctx: WriteContext) => Promise<{ saved: true; message: string }>
}

type Args = Record<string, unknown>

const has = (v: unknown) => v !== undefined && v !== null && v !== ''
const like = (v: string) => ({ contains: v, mode: 'insensitive' as const })

/** Only the keys the caller actually sent, so a partial update stays partial. */
const given = (args: Args, drop: string[] = []): Args =>
  Object.fromEntries(
    Object.entries(args).filter(([k, v]) => has(v) && k !== 'confirm' && !drop.includes(k)),
  )

/**
 * Field names as a person would say them.
 *
 * "creditDays" is what the column is called; "Days to pay" is what the person
 * checking the card needs to read. A summary they have to decode is a summary
 * they will wave through.
 */
const LABELS: Record<string, string> = {
  name: 'Name',
  type: 'Type',
  category: 'Supplies',
  phone: 'Phone',
  email: 'Email',
  gstin: 'GSTIN',
  pan: 'PAN',
  city: 'City',
  state: 'State',
  billingCity: 'City',
  billingState: 'State',
  billingStateCode: 'State code',
  stateCode: 'State code',
  creditDays: 'Days to pay',
  creditLimit: 'Credit limit',
  leadTimeDays: 'Lead time (days)',
  isMsme: 'MSME registered',
  hsnCode: 'HSN',
  standardRate: 'Rate',
  reorderLevel: 'Reorder level',
  minStock: 'Minimum stock',
  maxStock: 'Maximum stock',
  code: 'Code',
}

/** Display rows, in a sensible order, with the code left out — it is automatic. */
const readable = (data: Args, labels: Record<string, string>) =>
  Object.entries(data)
    .filter(([k, v]) => has(v) && k !== 'code')
    .map(([k, v]) => ({
      label: labels[k] ?? k,
      value: typeof v === 'boolean' ? (v ? 'yes' : 'no') : String(v),
    }))

/** Runs a Zod schema and turns the first complaint into one plain sentence. */
function check<T>(schema: { safeParse: (v: unknown) => { success: boolean; data?: T; error?: { errors: Array<{ path: (string | number)[]; message: string }> } } }, value: unknown): T {
  const result = schema.safeParse(value)
  if (!result.success) {
    const first = result.error!.errors[0]
    const field = first.path.filter((p) => p !== '').join('.')
    throw new Error(field ? `${field}: ${first.message}` : first.message)
  }
  return result.data as T
}

/**
 * Turns a name into the record it means, and refuses when it is not sure.
 *
 * "Update Kanha's credit days to 45" is only safe if exactly one customer is
 * called Kanha. Two matches has to become a question, never a coin toss.
 */
function one<T extends { name: string; code: string }>(rows: T[], needle: string, what: string): T {
  if (rows.length === 0) throw new Error(`No ${what} matching "${needle}".`)
  if (rows.length > 1) {
    throw new Error(
      `"${needle}" matches ${rows.length}: ${rows.map((r) => `${r.name} (${r.code})`).join(', ')}. Which one?`,
    )
  }
  return rows[0]
}

type PartyKind = 'customer' | 'supplier' | 'broker'

async function findParty(kind: PartyKind, needle: string) {
  const delegate = prisma[kind] as unknown as {
    findMany: (a: unknown) => Promise<Array<{ id: string; name: string; code: string }>>
  }
  const rows = await delegate.findMany({
    where: { OR: [{ name: like(needle) }, { code: like(needle) }] },
    select: { id: true, name: true, code: true },
    take: 5,
  })
  return one(rows, needle, kind)
}

async function findItem(needle: string) {
  const words = needle.trim().split(/\s+/).filter(Boolean)
  const rows = await prisma.item.findMany({
    where: { OR: [{ code: like(needle) }, { AND: words.map((w) => ({ name: like(w) })) }] },
    select: { id: true, name: true, code: true },
    take: 5,
  })
  return one(rows, needle, 'item')
}

async function auditWrite(
  ctx: WriteContext,
  module: string,
  action: 'CREATE' | 'UPDATE' | 'DELETE' | 'APPROVE' | 'REJECT',
  entityType: string,
  entityId: string,
  before: unknown,
  after: unknown,
) {
  await recordAudit(ctx.userId, ctx.ip, {
    module,
    action,
    entityType,
    entityId,
    before,
    // The trail says how as well as what. A change made through a chat window in
    // a corridor is worth telling apart from one typed into a form at a desk.
    after: { ...(after as object), viaAssistant: true },
  })
}

// ── Shared parameter shapes ─────────────────────────────────────────────────

const CONFIRM_PARAM = {
  confirm: {
    type: 'string',
    description: 'The confirmation code from the previous call, once the person has agreed.',
  },
} as const

const PARTY_FIELDS = {
  phone: { type: 'string', description: 'Phone number' },
  email: { type: 'string', description: 'Email address' },
  gstin: { type: 'string', description: '15-character GSTIN' },
  pan: { type: 'string', description: '10-character PAN' },
  creditDays: { type: 'number', description: 'Days they get to pay' },
} as const

// ── The writes ──────────────────────────────────────────────────────────────

const WRITES: WriteDefinition[] = [
  {
    tool: {
      name: 'create_customer',
      description:
        'Add a customer. Shows exactly what would be saved and saves nothing until the person agrees.',
      needs: 'masters:create',
      gather: [
        'their full name, as it should read on an invoice',
        'what kind of buyer they are — call get_options with customer_types and offer the list',
        'which city they are in',
        'their phone number',
        'their GSTIN, or that they do not have one',
        'how many days they get to pay',
      ],
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Their name' },
          type: {
            type: 'string',
            description: 'What kind of buyer',
            enum: ['DOMESTIC', 'EXPORT', 'JOB_WORK', 'VHAGAR_DEALER'],
          },
          ...PARTY_FIELDS,
          city: { type: 'string', description: 'Billing city' },
          state: { type: 'string', description: 'Billing state' },
          creditLimit: { type: 'number', description: 'Credit limit in rupees' },
          ...CONFIRM_PARAM,
        },
        required: ['name', 'type'],
      },
    },
    gate: AI_GATE.change,
    build: async (a) => {
      const data = check(createCustomerSchema, {
        name: a.name,
        type: a.type,
        phone: a.phone,
        email: a.email,
        gstin: a.gstin,
        pan: a.pan,
        billingCity: a.city,
        billingState: a.state,
        // The two-digit state code decides CGST+SGST against IGST, and it is the
        // first two characters of the GSTIN — so it is derived, never asked for.
        billingStateCode: has(a.gstin) ? String(a.gstin).slice(0, 2) : undefined,
        creditDays: a.creditDays,
        creditLimit: a.creditLimit,
      })
      return {
        title: 'Add a customer',
        fields: readable(data as Args, LABELS),
        note: 'A code will be given to it automatically.',
        payload: data as Args,
      }
    },
    commit: async ({ payload }, ctx) => {
      const row = await withGeneratedCode('customer', payload, (data) =>
        prisma.customer.create({ data: data as never }),
      )
      await auditWrite(ctx, 'masters', 'CREATE', 'Customer', row.id, undefined, row)
      return { saved: true, message: `${row.name} added as ${row.code}.` }
    },
  },

  {
    tool: {
      name: 'create_supplier',
      description:
        'Add a supplier. Shows exactly what would be saved and saves nothing until the person agrees.',
      needs: 'masters:create',
      gather: [
        'their full name',
        'what they supply — call get_options with supplier_categories and offer the list. NEVER guess this from their name.',
        'which city they are in',
        'their phone number',
        'their GSTIN, or that they do not have one',
        'how many days we get to pay them',
      ],
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Their name' },
          category: {
            type: 'string',
            description: 'What they supply',
            enum: ['FABRIC', 'THREAD', 'BUTTON', 'LINING', 'LABEL', 'PACKAGING', 'TRIM', 'TRANSPORT', 'SERVICE', 'OTHER'],
          },
          ...PARTY_FIELDS,
          city: { type: 'string', description: 'City' },
          state: { type: 'string', description: 'State' },
          leadTimeDays: { type: 'number', description: 'Days from order to delivery' },
          isMsme: {
            type: 'boolean',
            description: 'Registered under MSME — payment then falls due within 45 days by law',
          },
          ...CONFIRM_PARAM,
        },
        required: ['name', 'category'],
      },
    },
    gate: AI_GATE.change,
    build: async (a) => {
      const data = check(createSupplierSchema, {
        name: a.name,
        category: a.category,
        phone: a.phone,
        email: a.email,
        gstin: a.gstin,
        pan: a.pan,
        city: a.city,
        state: a.state,
        stateCode: has(a.gstin) ? String(a.gstin).slice(0, 2) : undefined,
        creditDays: a.creditDays,
        leadTimeDays: a.leadTimeDays,
        isMsme: a.isMsme,
      })
      return {
        title: 'Add a supplier',
        fields: readable(data as Args, LABELS),
        note: 'A code will be given to it automatically.',
        payload: data as Args,
      }
    },
    commit: async ({ payload }, ctx) => {
      const row = await withGeneratedCode('supplier', payload, (data) =>
        prisma.supplier.create({ data: data as never }),
      )
      await auditWrite(ctx, 'masters', 'CREATE', 'Supplier', row.id, undefined, row)
      return { saved: true, message: `${row.name} added as ${row.code}.` }
    },
  },

  {
    tool: {
      name: 'create_item',
      description:
        'Add an item to the item master. Category, unit and GST rate are given by name and matched to the existing masters.',
      needs: 'masters:create',
      gather: [
        'what the item is called',
        'which category — call get_options with item_categories and offer the real list',
        'which unit it is measured in — call get_options with units and offer the real list',
        'what kind of item it is — call get_options with item_types and offer the list',
        'its usual rate per unit',
        'the level at which it should be reordered',
      ],
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Item name' },
          category: { type: 'string', description: 'Category name, e.g. Fabric, Thread, Packing Material' },
          unit: { type: 'string', description: 'Unit symbol, e.g. mtr, pcs, kg, roll' },
          type: {
            type: 'string',
            description: 'What kind of item',
            enum: ['RAW_MATERIAL', 'SEMI_FINISHED', 'FINISHED_GOOD', 'CONSUMABLE', 'PACKING_MATERIAL', 'TRIM'],
          },
          hsnCode: { type: 'string', description: 'HSN code' },
          gstRate: { type: 'number', description: 'GST percentage, e.g. 5, 12, 18' },
          standardRate: { type: 'number', description: 'Usual rate per unit in rupees' },
          reorderLevel: { type: 'number', description: 'Order more when stock falls to this' },
          ...CONFIRM_PARAM,
        },
        required: ['name', 'category', 'unit', 'type'],
      },
    },
    gate: AI_GATE.change,
    build: async (a) => {
      const category = await prisma.itemCategory.findFirst({ where: { name: like(String(a.category)) } })
      if (!category) {
        const all = await prisma.itemCategory.findMany({ select: { name: true } })
        throw new Error(
          `No category called "${a.category}". There is: ${all.map((c) => c.name).join(', ')}.`,
        )
      }

      const uom = await prisma.uOM.findFirst({
        where: { OR: [{ symbol: like(String(a.unit)) }, { name: like(String(a.unit)) }] },
      })
      if (!uom) {
        const all = await prisma.uOM.findMany({ select: { symbol: true } })
        throw new Error(`No unit called "${a.unit}". There is: ${all.map((u) => u.symbol).join(', ')}.`)
      }

      let taxRateId: string | undefined
      if (has(a.gstRate)) {
        const tax = await prisma.taxRate.findFirst({ where: { rate: Number(a.gstRate) } })
        if (!tax) throw new Error(`There is no ${a.gstRate}% GST rate set up. Add it in Settings first.`)
        taxRateId = tax.id
      }

      const data = check(createItemSchema, {
        name: a.name,
        type: a.type,
        categoryId: category.id,
        uomId: uom.id,
        hsnCode: a.hsnCode,
        taxRateId,
        standardRate: a.standardRate,
        reorderLevel: a.reorderLevel,
      })

      const shown = {
        name: a.name,
        type: a.type,
        category: category.name,
        unit: uom.symbol,
        ...(has(a.hsnCode) ? { hsn: a.hsnCode } : {}),
        ...(has(a.gstRate) ? { gst: `${a.gstRate}%` } : {}),
        ...(has(a.standardRate) ? { rate: `₹${a.standardRate}` } : {}),
        ...(has(a.reorderLevel) ? { reorderLevel: a.reorderLevel } : {}),
      }
      return {
        title: 'Add an item',
        fields: rows(shown),
        payload: data as Args,
      }
    },
    commit: async ({ payload }, ctx) => {
      const row = await withGeneratedCode('item', payload, (data) =>
        prisma.item.create({ data: data as never }),
      )
      await auditWrite(ctx, 'masters', 'CREATE', 'Item', row.id, undefined, row)
      return { saved: true, message: `${row.name} added as ${row.code}.` }
    },
  },

  {
    tool: {
      name: 'update_party',
      description:
        'Change details on an existing customer, supplier or broker. Only the fields given are changed; everything else is left alone.',
      needs: 'masters:edit',
      parameters: {
        type: 'object',
        properties: {
          kind: { type: 'string', description: 'Which register', enum: ['customer', 'supplier', 'broker'] },
          find: { type: 'string', description: 'Their name or code' },
          name: { type: 'string', description: 'A new name' },
          ...PARTY_FIELDS,
          creditLimit: { type: 'number', description: 'Credit limit in rupees (customers)' },
          leadTimeDays: { type: 'number', description: 'Lead time in days (suppliers)' },
          ...CONFIRM_PARAM,
        },
        required: ['kind', 'find'],
      },
    },
    gate: AI_GATE.change,
    build: async (a) => {
      const kind = String(a.kind) as PartyKind
      const row = await findParty(kind, String(a.find))
      const changes = given(a, ['kind', 'find'])
      if (Object.keys(changes).length === 0) {
        throw new Error('Nothing to change — say what should be different.')
      }

      const schema =
        kind === 'customer' ? updateCustomerSchema : kind === 'supplier' ? updateSupplierSchema : updateBrokerSchema
      const data = check(schema, changes)

      return {
        title: `Change ${row.name}`,
        fields: readable(changes, LABELS),
        note: `${row.code} · only these are changed; everything else stays as it is.`,
        payload: { kind, id: row.id, name: row.name, data: data as Args },
      }
    },
    commit: async ({ payload }, ctx) => {
      const kind = payload.kind as PartyKind
      const delegate = prisma[kind] as unknown as {
        findUnique: (a: unknown) => Promise<unknown>
        update: (a: unknown) => Promise<{ id: string; name: string }>
      }
      const before = await delegate.findUnique({ where: { id: payload.id } })
      const after = await delegate.update({ where: { id: payload.id }, data: payload.data as never })
      await auditWrite(ctx, 'masters', 'UPDATE', kind[0].toUpperCase() + kind.slice(1), String(payload.id), before, after)
      return { saved: true, message: `${after.name} updated.` }
    },
  },

  {
    tool: {
      name: 'update_item',
      description:
        'Change details on an existing item — rate, reorder level, HSN. Only the fields given are changed.',
      needs: 'masters:edit',
      parameters: {
        type: 'object',
        properties: {
          find: { type: 'string', description: 'Item name or code' },
          name: { type: 'string', description: 'A new name' },
          hsnCode: { type: 'string', description: 'HSN code' },
          standardRate: { type: 'number', description: 'Usual rate per unit' },
          reorderLevel: { type: 'number', description: 'Order more when stock falls to this' },
          minStock: { type: 'number', description: 'Minimum stock' },
          maxStock: { type: 'number', description: 'Maximum stock' },
          ...CONFIRM_PARAM,
        },
        required: ['find'],
      },
    },
    gate: AI_GATE.change,
    build: async (a) => {
      const item = await findItem(String(a.find))
      const changes = given(a, ['find'])
      if (Object.keys(changes).length === 0) {
        throw new Error('Nothing to change — say what should be different.')
      }
      const data = check(updateItemSchema, changes)
      return {
        title: `Change ${item.name}`,
        fields: readable(changes, LABELS),
        note: `${item.code} · only these are changed; everything else stays as it is.`,
        payload: { id: item.id, data: data as Args },
      }
    },
    commit: async ({ payload }, ctx) => {
      const before = await prisma.item.findUnique({ where: { id: String(payload.id) } })
      const after = await prisma.item.update({
        where: { id: String(payload.id) },
        data: payload.data as never,
      })
      await auditWrite(ctx, 'masters', 'UPDATE', 'Item', after.id, before, after)
      return { saved: true, message: `${after.name} updated.` }
    },
  },

  {
    tool: {
      name: 'deactivate_record',
      description:
        'Stop a customer, supplier, broker or item being used. It leaves the dropdowns but stays on every document that already used it — master data is never truly deleted.',
      needs: 'masters:delete',
      parameters: {
        type: 'object',
        properties: {
          kind: {
            type: 'string',
            description: 'What to deactivate',
            enum: ['customer', 'supplier', 'broker', 'item'],
          },
          find: { type: 'string', description: 'Name or code' },
          ...CONFIRM_PARAM,
        },
        required: ['kind', 'find'],
      },
    },
    gate: AI_GATE.change,
    build: async (a) => {
      const kind = String(a.kind)
      const row = kind === 'item' ? await findItem(String(a.find)) : await findParty(kind as PartyKind, String(a.find))
      return {
        title: `Deactivate ${row.name}`,
        fields: [
          { label: 'Code', value: row.code },
          { label: 'Register', value: kind },
        ],
        note: 'It leaves the dropdowns. Every document that already used it keeps working, and it can be switched back on.',
        payload: { kind, id: row.id, name: row.name },
      }
    },
    commit: async ({ payload }, ctx) => {
      const kind = String(payload.kind)
      const delegate = prisma[kind as 'item'] as unknown as {
        findUnique: (a: unknown) => Promise<unknown>
        update: (a: unknown) => Promise<unknown>
      }
      const before = await delegate.findUnique({ where: { id: payload.id } })
      const after = await delegate.update({ where: { id: payload.id }, data: { isActive: false } })
      await auditWrite(ctx, 'masters', 'DELETE', kind[0].toUpperCase() + kind.slice(1), String(payload.id), before, after)
      return { saved: true, message: `${payload.name} deactivated.` }
    },
  },

  {
    tool: {
      name: 'create_requisition',
      description:
        'Raise a material requisition — a department asking the store for material. It is raised waiting for approval; somebody else approves it and the store issues it.',
      needs: 'inventory:create',
      gather: [
        'which department is asking — call get_options with departments and offer the list',
        'which store it comes from — call get_options with warehouses and offer the list',
        'what is wanted and how much of each',
        'what it is for',
      ],
      parameters: {
        type: 'object',
        properties: {
          department: { type: 'string', description: 'Department asking, e.g. Cutting' },
          warehouse: { type: 'string', description: 'Store to draw from, e.g. Fabric Godown' },
          items: {
            type: 'string',
            description:
              'What is wanted, as "item x quantity", separated by semicolons. e.g. "FAB-COT-001 x 400; Poly Cotton Thread White x 5"',
          },
          purpose: { type: 'string', description: 'What it is for' },
          ...CONFIRM_PARAM,
        },
        required: ['department', 'warehouse', 'items'],
      },
    },
    gate: AI_GATE.change,
    build: async (a) => {
      const department = await prisma.department.findFirst({
        where: { name: like(String(a.department)), isActive: true },
      })
      if (!department) throw new Error(`No department called "${a.department}".`)

      const warehouse = await prisma.warehouse.findFirst({
        where: { name: like(String(a.warehouse)), isActive: true },
      })
      if (!warehouse) throw new Error(`No store called "${a.warehouse}".`)

      const chunks = String(a.items)
        .split(';')
        .map((c) => c.trim())
        .filter(Boolean)
      if (chunks.length === 0) throw new Error('No items given.')

      const lines = []
      for (const chunk of chunks) {
        const match = chunk.match(/^(.*?)\s*[x×*]\s*([\d.]+)\s*\w*$/i)
        if (!match) throw new Error(`Could not read "${chunk}". Write it as "item x quantity".`)
        const qty = Number(match[2])
        if (!(qty > 0)) throw new Error(`"${chunk}" has no quantity.`)
        const item = await findItem(match[1].trim())
        lines.push({ itemId: item.id, name: item.name, code: item.code, qty })
      }

      return {
        title: 'Raise a material requisition',
        fields: [
          { label: 'Department', value: department.name },
          { label: 'From', value: warehouse.name },
          ...lines.map((l) => ({ label: l.name, value: `${l.qty}` })),
        ],
        note: 'It will wait for someone else to approve it before the store can issue anything.',
        payload: {
          departmentId: department.id,
          warehouseId: warehouse.id,
          purpose: has(a.purpose) ? String(a.purpose) : null,
          lines,
        },
      }
    },
    commit: async ({ payload }, ctx) => {
      const lines = payload.lines as Array<{ itemId: string; qty: number }>
      const mr = await prisma.$transaction(async (tx) => {
        const mrNumber = await nextDocumentNumber(tx, 'MR')
        return tx.materialRequisition.create({
          data: {
            mrNumber,
            departmentId: String(payload.departmentId),
            raisedById: ctx.userId,
            notes: (payload.purpose as string | null) ?? 'Raised through the assistant',
            lines: {
              create: lines.map((l) => ({
                itemId: l.itemId,
                requestedQty: l.qty,
                warehouseId: String(payload.warehouseId),
                purpose: (payload.purpose as string | null) ?? null,
              })),
            },
          },
        })
      })

      await auditWrite(ctx, 'inventory', 'CREATE', 'MaterialRequisition', mr.id, undefined, mr)
      return { saved: true, message: `${mr.mrNumber} raised. It is waiting for someone else to approve it.` }
    },
  },

  {
    tool: {
      name: 'decide_document',
      description:
        'Approve or refuse a purchase order, sales order or material requisition that is waiting. Find the number with get_pending_approvals first.',
      needs: null,
      parameters: {
        type: 'object',
        properties: {
          number: { type: 'string', description: 'The document number, e.g. PO-2627-0001' },
          decision: { type: 'string', description: 'What to do', enum: ['approve', 'reject'] },
          reason: { type: 'string', description: 'Why it is being refused. Required to refuse.' },
          ...CONFIRM_PARAM,
        },
        required: ['number', 'decision'],
      },
    },
    gate: AI_GATE.decide,
    build: async (a) => {
      const doc = await findDocument(String(a.number))
      const decision = String(a.decision)
      if (decision === 'reject' && !has(a.reason)) {
        throw new Error('A refusal needs a reason. What should it say?')
      }
      return {
        title: `${decision === 'approve' ? 'Approve' : 'Refuse'} ${doc.number}`,
        fields: [
          { label: 'Document', value: doc.describe },
          ...(decision === 'reject' ? [{ label: 'Reason', value: String(a.reason) }] : []),
        ],
        note: 'This cannot be undone.',
        payload: { number: doc.number, decision, reason: has(a.reason) ? String(a.reason) : null },
      }
    },
    commit: async ({ payload }, ctx) => {
      // Re-read rather than trusting the preview: somebody may have approved it
      // on the web in the seconds between being shown this and agreeing to it.
      const doc = await findDocument(String(payload.number))
      const approve = payload.decision === 'approve'

      // The permission depends on which document it turned out to be, so it
      // cannot be declared on the tool. Checked here, against the same module
      // the screen would check.
      if (!ctx.can(`${doc.module}:approve`)) {
        throw new Error(`Your role cannot approve ${doc.module} documents.`)
      }
      if (approve && doc.raisedById && doc.raisedById === ctx.userId) {
        throw new Error('You raised this one, so somebody else has to approve it.')
      }

      const after = await doc.decide(approve, ctx.userId, payload.reason as string | null)
      await auditWrite(
        ctx,
        doc.module,
        approve ? 'APPROVE' : 'REJECT',
        doc.entityType,
        doc.id,
        doc.before,
        after,
      )
      return { saved: true, message: `${doc.number} ${approve ? 'approved' : 'refused'}.` }
    },
  },
]

/** One waiting document, whichever of the three kinds it is. */
async function findDocument(number: string) {
  const trimmed = number.trim()

  const po = await prisma.purchaseOrder.findFirst({
    where: { poNumber: like(trimmed) },
    include: { supplier: { select: { name: true } } },
  })
  if (po) {
    return {
      id: po.id,
      number: po.poNumber,
      module: 'purchase',
      entityType: 'PurchaseOrder',
      raisedById: po.createdById,
      before: po,
      describe: `${po.supplier.name}, ₹${Number(po.totalAmount).toLocaleString('en-IN')}`,
      decide: async (approve: boolean, userId: string, reason: string | null) => {
        if (po.approvedAt) throw new Error(`${po.poNumber} is already approved.`)
        if (po.status === 'CANCELLED') throw new Error(`${po.poNumber} is cancelled.`)
        return prisma.purchaseOrder.update({
          where: { id: po.id },
          data: approve
            ? { approvedById: userId, approvedAt: new Date() }
            : { status: 'CANCELLED', notes: [po.notes, `Refused: ${reason}`].filter(Boolean).join('\n') },
        })
      },
    }
  }

  const so = await prisma.salesOrder.findFirst({
    where: { soNumber: like(trimmed) },
    include: { customer: { select: { name: true } } },
  })
  if (so) {
    return {
      id: so.id,
      number: so.soNumber,
      module: 'sales',
      entityType: 'SalesOrder',
      raisedById: so.createdById,
      before: so,
      describe: `${so.customer.name}, ₹${Number(so.totalAmount).toLocaleString('en-IN')}`,
      decide: async (approve: boolean, userId: string, reason: string | null) => {
        if (so.approvedAt) throw new Error(`${so.soNumber} is already approved.`)
        if (so.status === 'CANCELLED') throw new Error(`${so.soNumber} is cancelled.`)
        return prisma.salesOrder.update({
          where: { id: so.id },
          data: approve
            ? { status: 'CONFIRMED', approvedById: userId, approvedAt: new Date() }
            : { status: 'CANCELLED', notes: [so.notes, `Refused: ${reason}`].filter(Boolean).join('\n') },
        })
      },
    }
  }

  const mr = await prisma.materialRequisition.findFirst({
    where: { mrNumber: like(trimmed) },
    include: { department: { select: { name: true } }, lines: true },
  })
  if (mr) {
    return {
      id: mr.id,
      number: mr.mrNumber,
      module: 'inventory',
      entityType: 'MaterialRequisition',
      raisedById: mr.raisedById,
      before: mr,
      describe: `${mr.department.name}, ${mr.lines.length} item${mr.lines.length === 1 ? '' : 's'}`,
      decide: async (approve: boolean, userId: string, reason: string | null) => {
        if (mr.status !== 'PENDING') {
          throw new Error(`${mr.mrNumber} is already ${mr.status.toLowerCase()}.`)
        }
        return prisma.materialRequisition.update({
          where: { id: mr.id },
          data: approve
            ? { status: 'APPROVED', approvedById: userId, approvedAt: new Date() }
            : { status: 'REJECTED', approvedById: userId, approvedAt: new Date(), rejectionReason: reason },
        })
      },
    }
  }

  throw new Error(`No document numbered "${number}".`)
}

// ── What the rest of the system uses ────────────────────────────────────────

export const WRITE_TOOLS: ErpTool[] = WRITES.map((w) => w.tool)

export const isWriteTool = (name: string): boolean => WRITES.some((w) => w.tool.name === name)

/**
 * Which writes this person may do.
 *
 * Two gates, and both have to open: the chat switch (ai:create to change
 * things, ai:approve to decide them) and the module permission the same act
 * would need on the screen. A role with masters:create but no ai:create can add
 * suppliers at a desk and not from a corridor — a real distinction a mill owner
 * might want to draw, and one they draw for themselves in Settings → Roles.
 */
export function writeToolsFor(role: string, permissions: string[]): ErpTool[] {
  const granted = new Set(permissions)
  const can = (p: string) => role === 'Admin' || granted.has(p)

  return WRITES.filter((w) => can(w.gate) && (!w.tool.needs || can(w.tool.needs))).map(
    (w) => w.tool,
  )
}

/**
 * Runs a write: describe on the first ask, save on the second.
 *
 * Errors come back as answers rather than exceptions, because a refusal is
 * something the assistant should relay — "that matches two suppliers, which
 * one?" belongs in the conversation, not in a red banner.
 */
export async function runWriteTool(
  name: string,
  args: Args,
  ctx: WriteContext,
): Promise<unknown> {
  const write = WRITES.find((w) => w.tool.name === name)
  if (!write) return { error: `There is no tool called ${name}.` }

  if (!ctx.can(write.gate)) {
    return {
      error:
        write.gate === AI_GATE.decide
          ? `${ctx.userName}'s role cannot approve things through the assistant.`
          : `${ctx.userName}'s role cannot change records through the assistant.`,
    }
  }
  if (write.tool.needs && !ctx.can(write.tool.needs)) {
    return { error: `${ctx.userName}'s role is not allowed to do that.` }
  }

  const payload = given(args)

  try {
    // Build on both passes. Validating only on the way in would let a preview be
    // agreed to and then saved against a record that has since changed.
    const built = await write.build(args)

    const ticket_ = has(args.confirm)
      ? checkTicket(args.confirm, name, payload, ctx.userId, ctx.turnCount)
      : null

    // A ticket refused because the values moved is not a failure — it is the
    // check doing its job. Somebody added a phone number after seeing the card,
    // and what they agreed to is no longer what would be saved. So show the new
    // figures and ask again, rather than reporting a code that did not match.
    const valuesMoved = ticket_ !== null && !ticket_.ok && ticket_.reason.startsWith('The details have changed')

    if (!has(args.confirm) || valuesMoved) {
      const ticket = mintTicket(name, payload, ctx.userId, ctx.turnCount)
      const summary = asText(built)
      ctx.onProposal?.({
        tool: name,
        args: payload,
        ticket,
        summary,
        title: built.title,
        fields: built.fields,
        note: built.note,
      })
      return {
        nothingSavedYet: true,
        wouldDo: summary,
        confirm: ticket,
        instruction: valuesMoved
          ? 'The details moved since they last saw them, so this is a fresh card with the new values. Nothing has been saved. Say one short line — "The details changed, so here it is again — check it and press Confirm." Do NOT repeat the fields; they are on the card.'
          : 'Nothing has been saved. The person is being shown this as a card with a Confirm button, so do NOT repeat the fields — say one short line like "Here is what I will save — check it and press Confirm." You will be reminded of the confirm code on their next message.',
      }
    }

    if (!ticket_!.ok) return { error: ticket_!.reason }

    const result = await write.commit(built, ctx)
    ctx.onCommitted?.()
    logger.info(`AI write: ${name} confirmed by ${ctx.userName}`)
    return result
  } catch (err) {
    return { error: (err as Error).message }
  }
}
