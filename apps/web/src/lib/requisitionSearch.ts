import { itemShadeCols, type ShadeFields } from '@/lib/items'

/** Search individual requisitions before filtering/grouping/paging the register. */
interface SearchableRequisition {
  id: string
  mrNumber: string
  status: string
  department: { name: string; code?: string }
  mo?: { moNumber: string } | null
  so?: { soNumber: string; customer?: { name: string } | null } | null
  raisedBy?: { name: string } | null
  approvedBy?: { name: string } | null
  issuedBy?: { name: string } | null
  closedBy?: { name: string } | null
  notes?: string | null
  lines: Array<{
    item: ShadeFields & { code: string; name: string; category?: { name: string; parent?: { name: string } | null } | null }
    warehouse?: { name: string } | null
    purpose?: string | null
    styleNo?: string | null
    ownerCustomer?: { name: string } | null
  }>
}

type Reference = 'mr' | 'mo' | 'so'
export interface RequisitionSearchEntry {
  id: string
  references: Record<Reference, string>
  fields: string[]
}

const normalize = (value: string | null | undefined) => (value ?? '').trim().toLowerCase().replace(/\s+/g, ' ')

/** Normalize once per dataset change, not on each keystroke or filter count. */
export function indexRequisitions<T extends SearchableRequisition>(
  rows: readonly T[],
  statusLabel: (row: T) => string,
): RequisitionSearchEntry[] {
  return rows.map((row) => {
    const references = { mr: normalize(row.mrNumber), mo: normalize(row.mo?.moNumber), so: normalize(row.so?.soNumber) }
    return {
      id: row.id,
      references,
      fields: [
        ...Object.values(references), row.department.name, row.department.code,
        row.so?.customer?.name, row.status, statusLabel(row),
        row.raisedBy?.name, row.approvedBy?.name, row.issuedBy?.name, row.closedBy?.name, row.notes,
        ...row.lines.flatMap((line) => {
          // A fabric's name with its design no. and colour as one field, so
          // "twill 1164" or "1164 navy" finds the line — never two items mixed.
          const shade = itemShadeCols(line.item)
          return [
            line.item.code, line.item.name, [line.item.name, shade.designNo, shade.colour].filter(Boolean).join(' '),
            line.item.category?.name, line.item.category?.parent?.name,
            line.warehouse?.name, line.purpose, line.styleNo, line.ownerCustomer?.name,
          ]
        }),
      ].map(normalize).filter(Boolean),
    }
  })
}

export function searchRequisitions(index: readonly RequisitionSearchEntry[], query: string): Set<string> {
  const term = normalize(query)
  const explicit = /^(mr|mo|so)-/.exec(term)
  const reference = explicit?.[1] as Reference | undefined
  // A bare financial-year/number ("2627-0002") is a document number, never an
  // item or a note: it finds every requisition whose MR, MO or SO number holds
  // it, so MO-2627-0002's requisitions and MR-2627-0002 both show. An explicit
  // MR-/MO-/SO- narrows it to that kind of number alone.
  const anyNumber = !reference && /^\d{2,4}-\d+$/.test(term)

  const words = term.split(' ').filter(Boolean)
  return new Set(index.filter((entry) => {
    if (!term) return true
    if (reference) return entry.references[reference].includes(term)
    if (anyNumber) return Object.values(entry.references).some((number) => number.includes(term))
    // All words must match one real field; never assemble a match from
    // different items, or from an order reference plus unrelated notes.
    return entry.fields.some((field) => words.every((word) => field.includes(word)))
  }).map((entry) => entry.id))
}
