'use client'

import { ActiveBadge, MasterTable, type Column, type FilterDef } from '@/components/masters/MasterTable'
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
  _count?: { styles: number }
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
  {
    key: 'styles',
    header: 'Styles',
    align: 'right',
    render: (g) =>
      g._count?.styles ? (
        <span>{g._count.styles}</span>
      ) : (
        <span className="text-muted-foreground">Not used</span>
      ),
  },
  { key: 'isActive', header: 'Status', render: (g) => <ActiveBadge isActive={g.isActive} /> },
]

/*
 * Who the run is for, a size it holds (every run with an XL), and whether
 * any style is cut in it. Each counts what it would leave.
 */
/** Chest and waist sizes by number, then letter sizes smallest first. */
const LETTER = ['XXS', 'XS', 'S', 'M', 'L', 'XL', 'XXL', '2XL', '3XL', 'XXXL', '4XL', '5XL']
const sizeOrder = (a: string, b: string) => {
  const rank = (v: string) => {
    if (/^\d+(\.\d+)?$/.test(v)) return [0, Number(v)]
    const i = LETTER.indexOf(v.toUpperCase())
    return i >= 0 ? [1, i] : [2, 0]
  }
  const [ga, na] = rank(a)
  const [gb, nb] = rank(b)
  return ga - gb || na - nb || a.localeCompare(b)
}

const filterDefs: FilterDef[] = [
  {
    key: 'gender',
    label: 'For',
    facet: 'gender',
    options: Object.entries(GENDER_LABEL).map(([value, label]) => ({ value, label })),
    noneLabel: 'Not set',
  },
  { key: 'size', label: 'Size', facet: 'size', valuesFromFacet: true, sortValues: sizeOrder },
  {
    key: 'use',
    label: 'Use',
    facet: 'use',
    options: [
      { value: 'used', label: 'Used by a style' },
      { value: 'unused', label: 'Not used yet' },
    ],
  },
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
      filterDefs={filterDefs}
      defaultSort="name"
      searchPlaceholder="Search size run or size..."
      emptyMessage="No size runs yet. Create one, then add its sizes."
      actions={
        <a href="/masters/sizes" className="btn-secondary text-xs">
          Manage individual sizes
        </a>
      }
    />
  )
}
