import { Router } from 'express'
import { z } from 'zod'
import { prisma } from '@ld-erp/database'
import { AppError } from '../middleware/errorHandler'
import { isAdmin, requirePermission, type AuthRequest } from '../middleware/auth'
import { writeAuditLog } from '../lib/audit'
import { decidePending } from '../services/requisition.service'
import { approveSalesOrder, rejectSalesOrder } from '../services/salesOrder.service'
import { rejectRequisitionSchema } from '../schemas/inventory.schemas'

const router = Router()

const documentType = z.enum(['PO', 'SO', 'MR'])
type DocumentType = z.infer<typeof documentType>

/** Which permission module governs each document type. */
const MODULE_FOR: Record<DocumentType, string> = {
  PO: 'purchase',
  SO: 'sales',
  MR: 'inventory',
}

const rejectBody = z.object({
  reason: z.string().min(1, 'A reason is required when rejecting').max(500),
})

/**
 * A sales order for a customer over their credit limit, or blacklisted, is
 * approved only with a reason for releasing it. The first approve comes back
 * CREDIT_HOLD with the figures; the screen asks why and sends it again.
 */
const approveBody = z.object({
  creditReleaseReason: z
    .string()
    .trim()
    .min(5, 'Say why the credit hold is being released, in a few words')
    .max(500)
    .optional()
    .nullable(),
})

/**
 * Approving is guarded per module, so the route cannot know which permission to
 * demand until it has read the type off the URL. requirePermission is therefore
 * resolved per request rather than at mount time.
 */
function guard(action: 'approve') {
  return (req: AuthRequest, res: Parameters<ReturnType<typeof requirePermission>>[1], next: Parameters<ReturnType<typeof requirePermission>>[2]) => {
    const parsed = documentType.safeParse(req.params.type)
    if (!parsed.success) {
      throw new AppError(`Unknown document type '${req.params.type}'`, 400, 'BAD_TYPE')
    }
    return requirePermission(MODULE_FOR[parsed.data], action)(req, res, next)
  }
}

// POST /api/approvals/:type/:id/approve
router.post('/:type/:id/approve', guard('approve'), async (req: AuthRequest, res) => {
  const type = documentType.parse(req.params.type)
  const id = req.params.id
  const userId = req.user!.id
  const { creditReleaseReason } = approveBody.parse(req.body ?? {})

  const result = await approve(type, id, userId, isAdmin(req.user), creditReleaseReason)

  await writeAuditLog(req, {
    module: MODULE_FOR[type],
    action: 'APPROVE',
    entityType: result.entityType,
    entityId: id,
    before: result.before,
    after: result.after,
  })

  res.json({ success: true, message: `${result.number} approved`, data: result.after })
})

// POST /api/approvals/:type/:id/reject
router.post('/:type/:id/reject', guard('approve'), async (req: AuthRequest, res) => {
  const type = documentType.parse(req.params.type)
  const { reason } = rejectBody.parse(req.body)
  const id = req.params.id

  const result = await reject(type, id, reason, req.user!.id)

  await writeAuditLog(req, {
    module: MODULE_FOR[type],
    action: 'REJECT',
    entityType: result.entityType,
    entityId: id,
    before: result.before,
    // The reason is kept on the document — in its notes, or a column of its
    // own — so the after snapshot already carries it; the audit row needs no
    // separate field for it.
    after: result.after,
  })

  res.json({ success: true, message: `${result.number} rejected`, data: result.after })
})

async function approve(
  type: DocumentType,
  id: string,
  userId: string,
  admin = false,
  creditReleaseReason?: string | null,
) {
  if (type === 'PO') {
    const before = await prisma.purchaseOrder.findUnique({ where: { id } })
    if (!before || before.deletedAt) {
      throw new AppError('Purchase order not found', 404, 'NOT_FOUND')
    }
    if (before.approvedAt) {
      throw new AppError('This purchase order is already approved', 409, 'ALREADY_APPROVED')
    }

    const after = await prisma.purchaseOrder.update({
      where: { id },
      // SENT is the first post-approval state: the PO can now go to the supplier.
      data: { status: 'SENT', approvedById: userId, approvedAt: new Date() },
    })
    return { entityType: 'PurchaseOrder', number: before.poNumber, before, after }
  }

  if (type === 'SO') {
    // Draft only, never by the person who raised it, and a credit hold needs a
    // reason. The assistant approves through the same function.
    const { before, after } = await approveSalesOrder(id, userId, { admin, creditReleaseReason })
    return { entityType: 'SalesOrder', number: before.soNumber, before, after }
  }

  const before = await prisma.materialRequisition.findUnique({ where: { id } })
  if (!before) throw new AppError('Material requisition not found', 404, 'NOT_FOUND')
  if (before.status !== 'PENDING') {
    throw new AppError(`This requisition is already ${before.status.toLowerCase()}`, 409, 'ALREADY_DECIDED')
  }
  // Same rule as the inventory screen enforces. Approving from the inbox is a
  // different door into the same decision, and it cannot be the unlocked one.
  // The Admin may approve their own, as on the inventory screen.
  if (before.raisedById && before.raisedById === userId && !admin) {
    throw new AppError(
      'You raised this requisition, so somebody else has to approve it.',
      403,
      'SELF_APPROVAL',
    )
  }

  await decidePending(id, before.mrNumber, {
    status: 'APPROVED',
    approvedById: userId,
    approvedAt: new Date(),
  })
  const after = await prisma.materialRequisition.findUniqueOrThrow({ where: { id } })
  return { entityType: 'MaterialRequisition', number: before.mrNumber, before, after }
}

async function reject(type: DocumentType, id: string, reason: string, userId: string) {
  if (type === 'PO') {
    const before = await prisma.purchaseOrder.findUnique({ where: { id } })
    if (!before || before.deletedAt) {
      throw new AppError('Purchase order not found', 404, 'NOT_FOUND')
    }

    const after = await prisma.purchaseOrder.update({
      where: { id },
      data: { status: 'CANCELLED', notes: appendReason(before.notes, reason) },
    })
    return { entityType: 'PurchaseOrder', number: before.poNumber, before, after }
  }

  if (type === 'SO') {
    // A confirmed order is cancelled or short-closed, not rejected.
    const { before, after } = await rejectSalesOrder(id, userId, reason)
    return { entityType: 'SalesOrder', number: before.soNumber, before, after }
  }

  const before = await prisma.materialRequisition.findUnique({ where: { id } })
  if (!before) throw new AppError('Material requisition not found', 404, 'NOT_FOUND')

  // The same bar as the inventory screen sets: a reason somebody can act on.
  rejectRequisitionSchema.parse({ reason })

  // Only while it is still pending. This door checked nothing, so a
  // requisition already handed over could be marked refused here with its
  // stock still gone; and it did not record who refused.
  await decidePending(id, before.mrNumber, {
    status: 'REJECTED',
    approvedById: userId,
    approvedAt: new Date(),
    // The reason has a column of its own, so it can be shown as a reason
    // rather than as a line appended to whatever the notes already said.
    rejectionReason: reason,
  })
  const after = await prisma.materialRequisition.findUniqueOrThrow({ where: { id } })
  return { entityType: 'MaterialRequisition', number: before.mrNumber, before, after }
}

/** Keeps whatever the document already said and records why it was refused. */
function appendReason(existing: string | null, reason: string): string {
  const line = `Rejected: ${reason}`
  return existing ? `${existing}\n${line}` : line
}

export default router
