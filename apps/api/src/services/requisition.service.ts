import { prisma } from '@ld-erp/database'
import { AppError } from '../middleware/errorHandler'

/**
 * Records the approver's decision on a requisition that is still pending.
 *
 * The status is part of the condition, not just read beforehand: two people
 * deciding at once, or a refusal arriving after the material was issued,
 * would otherwise both pass a check made a moment earlier. Used by both
 * the inventory screen and the approvals inbox, which are two doors into
 * the same decision.
 */
export async function decidePending(
  id: string,
  mrNumber: string,
  data: {
    status: 'APPROVED' | 'REJECTED'
    approvedById: string
    approvedAt: Date
    rejectionReason?: string
  },
) {
  const done = await prisma.materialRequisition.updateMany({
    where: { id, status: 'PENDING' },
    data,
  })
  if (done.count === 0) {
    const now = await prisma.materialRequisition.findUnique({
      where: { id },
      select: { status: true, issuedAt: true },
    })
    throw new AppError(
      now?.issuedAt
        ? `${mrNumber} has already been issued, so it can no longer be approved or refused.`
        : `${mrNumber} was just ${now?.status === 'REJECTED' ? 'refused' : 'approved'} by somebody else. Refresh to see it.`,
      409,
      'ALREADY_DECIDED',
    )
  }
}
