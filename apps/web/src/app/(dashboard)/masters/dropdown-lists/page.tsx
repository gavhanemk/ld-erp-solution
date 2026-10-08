'use client'

import { ActiveBadge, MasterTable, type Column } from '@/components/masters/MasterTable'
import { RETURN_REASON_TYPES, returnReasonFields } from '@/components/purchase/returnReasons'

/**
 * The small lists the mill keeps for itself, on one page.
 *
 * Each would otherwise be a Masters menu entry of its own for a handful of
 * values. One list so far — return reasons — and the next joins as another
 * tab here rather than another line in the menu.
 */

interface DropdownValue {
  id: string
  list: string
  label: string
  behavesAs: string | null
  isActive: boolean
}

const LISTS = [
  {
    key: 'RETURN_REASON',
    label: 'Return reasons',
    note: 'Offered on the return challan and the quality check. Material returned, Material damaged, Rejected on quality and Wrong material sent are always there; add your own here, or with "+ Add new" in those dropdowns.',
  },
]

const worksLike = (code: string | null) =>
  RETURN_REASON_TYPES.find((t) => t.value === code)?.label ?? '—'

const columns: Column<DropdownValue>[] = [
  {
    key: 'label',
    header: 'Reason',
    sortable: true,
    render: (r) => <span className="text-foreground font-medium">{r.label}</span>,
  },
  {
    key: 'behavesAs',
    header: 'Works like',
    render: (r) => <span className="text-muted-foreground">{worksLike(r.behavesAs)}</span>,
  },
  { key: 'isActive', header: 'Status', render: (r) => <ActiveBadge isActive={r.isActive} /> },
]

export default function DropdownListsPage() {
  const list = LISTS[0]
  return (
    <div className="space-y-3">
      {/* One tab per list. With one list it says which list this is. */}
      <div className="flex flex-wrap items-center gap-2">
        {LISTS.map((l) => (
          <span
            key={l.key}
            className="border-primary/30 bg-primary/10 text-primary rounded-full border px-3 py-1 text-xs font-medium"
          >
            {l.label}
          </span>
        ))}
        <p className="text-muted-foreground basis-full text-xs">{list.note}</p>
      </div>

      <MasterTable<DropdownValue>
        title="Dropdown Lists"
        entityName="Return reason"
        resource="dropdown-values"
        columns={columns}
        filters={{ list: list.key }}
        formFields={returnReasonFields}
        formColumns={4}
        defaultSort="label"
        searchPlaceholder="Search reasons..."
        emptyMessage="None of your own yet. The four built-in reasons are always offered; add one here when they are not specific enough."
      />
    </div>
  )
}
