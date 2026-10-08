import type { FormField } from '@/components/masters/MasterFormDialog'

/**
 * Return reasons, as the return challan and the quality check offer them.
 *
 * Four are built in, and they are what stock and the debit note go by. The
 * mill adds its own under Masters → Dropdown Lists — "Shade variation",
 * "Short width" — each saying which built-in one it works like, and printed
 * under its own name.
 */

/** One choice in a reason dropdown, as the server sends it. */
export interface ReasonOption {
  /** The dropdown's key: the code for a built-in reason, `c:<id>` for the mill's own. */
  value: string
  /** The built-in reason it is, or works like. */
  code: string
  label: string
  hint?: string
  custom?: boolean
}

/** The four built-in reasons, for the "Works like" choice. */
export const RETURN_REASON_TYPES = [
  { value: 'PURCHASE_RETURN', label: 'Material returned' },
  { value: 'DAMAGED_MATERIAL', label: 'Material damaged' },
  { value: 'QUALITY_REJECTION', label: 'Rejected on quality' },
  { value: 'WRONG_MATERIAL', label: 'Wrong material sent' },
]

/** The form for one of the mill's own reasons — on the Masters page and in the dropdowns. */
export const returnReasonFields: FormField[] = [
  {
    name: 'label',
    label: 'Reason',
    required: true,
    placeholder: 'e.g. Shade variation',
    span: 2,
  },
  {
    name: 'behavesAs',
    label: 'Works like',
    type: 'select',
    required: true,
    options: RETURN_REASON_TYPES,
    help: 'Decides what happens to stock and the debit note',
    span: 2,
  },
]

/** A reason just added from a dropdown, as an option that dropdown can show. */
export const optionFromCreated = (row: {
  id: string
  label: string
  behavesAs?: string | null
}): ReasonOption => ({
  value: 'c:' + row.id,
  code: row.behavesAs ?? '',
  label: row.label,
  hint:
    'Works like ' + (RETURN_REASON_TYPES.find((t) => t.value === row.behavesAs)?.label ?? ''),
  custom: true,
})
