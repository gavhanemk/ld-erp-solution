'use client'

import { ActiveBadge, MasterTable, type Column } from '@/components/masters/MasterTable'
import type { FormField } from '@/components/masters/MasterFormDialog'

/**
 * Size runs.
 *
 * A shirt is cut as a run of sizes, and that breakup has to survive from the
 * order through cutting to the invoice. Typing sizes as free text is how "XL"
 * and "xl" end up as two different things and the totals quietly stop agreeing.
 */
interface SizeGroup {
  id: string
  name: string
  gender: string | null
  isActive: boolean
  sizes: { id: string; code: string; label: string; sequence: number }[]
}

const GENDER_LABEL: Record<string, string> = {
  MALE: "Men's",
  FEMALE: "Women's",
  UNISEX: 'Unisex',
}

const columns: Column<SizeGroup>[] = [
  { key: 'name', header: 'Size Run', sortable: true, className: 'font-medium' },
  {
    key: 'gender',
    header: 'For',
    render: (g) =>
      g.gender ? (
        <span className="badge-neutral">{GENDER_LABEL[g.gender] ?? g.gender}</span>
      ) : (
        <span className="text-muted-foreground">—</span>
      ),
  },
  {
    key: 'sizes',
    header: 'Sizes',
    render: (g) =>
      g.sizes?.length ? (
        <div className="flex flex-wrap gap-1">
          {g.sizes
            .slice()
            .sort((a, b) => a.sequence - b.sequence)
            .map((s) => (
              <span
                key={s.id}
                className="font-mono text-[11px] px-1.5 py-0.5 rounded bg-secondary border border-border"
              >
                {s.label}
              </span>
            ))}
        </div>
      ) : (
        <span className="text-muted-foreground text-xs">No sizes yet — add them below</span>
      ),
  },
  {
    key: 'count',
    header: 'Count',
    align: 'right',
    render: (g) => <span className="text-muted-foreground">{g.sizes?.length ?? 0}</span>,
  },
  { key: 'isActive', header: 'Status', render: (g) => <ActiveBadge isActive={g.isActive} /> },
]

const formFields: FormField[] = [
  {
    name: 'name',
    label: 'Name',
    required: true,
    placeholder: "Men's Shirt (Collar)",
    span: 2,
    help: 'What you would call this run on the cutting sheet',
  },
  {
    name: 'gender',
    label: 'For',
    type: 'select',
    options: [
      { value: 'MALE', label: "Men's" },
      { value: 'FEMALE', label: "Women's" },
      { value: 'UNISEX', label: 'Unisex' },
    ],
  },
  { name: 'isActive', label: 'Active', type: 'checkbox', placeholder: 'Available on new styles' },
]

export default function SizeRunsPage() {
  return (
    <MasterTable<SizeGroup>
      title="Size Runs"
      entityName="Size Run"
      resource="size-groups"
      columns={columns}
      formFields={formFields}
      defaultSort="name"
      searchPlaceholder="Search size runs..."
      emptyMessage="No size runs yet. Create one, then add its sizes."
      actions={
        <a href="/masters/sizes" className="btn-secondary text-xs">
          Manage individual sizes
        </a>
      }
    />
  )
}
