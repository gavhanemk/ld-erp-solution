import type { Prisma, PrismaClient } from '@prisma/client'
import { RETURN_REASONS } from '../schemas/purchase-return.schemas'
import { REASON_RULES } from '../services/purchaseNote.service'

/**
 * Every reason a return can be given, as the dropdowns offer them.
 *
 * The four built-in ones first, then the mill's own from Masters → Dropdown
 * Lists. Each of the mill's own says which built-in reason it works like
 * (`code`), which is what stock and the debit note go by; its `label` is
 * what is printed. `value` is the dropdown's key — the code for a built-in
 * one, `c:<id>` for the mill's own, so two can share a code.
 */
export interface ReasonOption {
  value: string
  code: (typeof RETURN_REASONS)[number]
  label: string
  hint: string
  custom: boolean
}

export async function returnReasonOptions(
  db: PrismaClient | Prisma.TransactionClient
): Promise<ReasonOption[]> {
  const own = await db.dropdownValue.findMany({
    where: { list: 'RETURN_REASON', isActive: true },
    orderBy: [{ sortOrder: 'asc' }, { label: 'asc' }],
    select: { id: true, label: true, behavesAs: true },
  })
  const builtIn = new Set<string>(RETURN_REASONS)
  return [
    ...RETURN_REASONS.map((r) => ({
      value: r,
      code: r,
      label: REASON_RULES[r].label,
      hint: REASON_RULES[r].hint,
      custom: false,
    })),
    ...own
      .filter((o) => o.behavesAs && builtIn.has(o.behavesAs))
      .map((o) => {
        const code = o.behavesAs as (typeof RETURN_REASONS)[number]
        return {
          value: 'c:' + o.id,
          code,
          label: o.label,
          hint: 'Works like ' + REASON_RULES[code].label,
          custom: true,
        }
      }),
  ]
}
