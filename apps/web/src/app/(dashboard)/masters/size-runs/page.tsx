'use client'

import { useEffect, useMemo, useState } from 'react'
import { CheckCircle2 } from 'lucide-react'
import { ActiveBadge, MasterTable, type Column, type FilterDef } from '@/components/masters/MasterTable'
import { SizeRunDialog, sizeOrder, type SizeRun } from '@/components/masters/SizeRunDialog'

/**
 * Size runs.
 *
 * A shirt is cut as a run of sizes, and that breakup has to survive from the
 * order through cutting to the invoice. Typing sizes as free text is how "XL"
 * and "xl" end up as two different things and the totals quietly stop agreeing.
 *
 * A run and its sizes are edited together: click a run and every size in it
 * is a row of the one form.
 */

const GENDER_LABEL: Record<string, string> = {
  MALE: "Men's",
  FEMALE: "Women's",
  UNISEX: 'Unisex',
}

/*
 * Who the run is for, a size it holds (every run with an XL), and whether
 * any style is cut in it. Each counts what it would leave.
 */
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

export default function SizeRunsPage() {
  /** The open form: a new run, a run being edited, or nothing. */
  const [form, setForm] = useState<{ run: SizeRun | null } | null>(null)
  const [refreshKey, setRefreshKey] = useState(0)
  const [message, setMessage] = useState<string | null>(null)

  useEffect(() => {
    if (!message) return
    const t = setTimeout(() => setMessage(null), 5000)
    return () => clearTimeout(t)
  }, [message])

  const columns = useMemo<Column<SizeRun>[]>(
    () => [
      {
        key: 'name',
        header: 'Size Run',
        sortable: true,
        render: (g) => (
          <button
            type="button"
            className="text-foreground hover:text-primary text-left font-medium hover:underline"
            onClick={() => setForm({ run: g })}
            title="Open the run and its sizes"
          >
            {g.name}
          </button>
        ),
      },
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
            <button
              type="button"
              className="flex flex-wrap gap-1 text-left"
              onClick={() => setForm({ run: g })}
              title="Edit these sizes"
            >
              {g.sizes
                .slice()
                .sort((a, b) => a.sequence - b.sequence || sizeOrder(a.code, b.code))
                .map((s) => (
                  <span
                    key={s.id}
                    className="bg-secondary border-border rounded border px-1.5 py-0.5 font-mono text-[11px]"
                  >
                    {s.label}
                  </span>
                ))}
            </button>
          ) : (
            <button type="button" className="text-primary text-xs hover:underline" onClick={() => setForm({ run: g })}>
              No sizes yet — add them
            </button>
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
          g._count?.styles ? <span>{g._count.styles}</span> : <span className="text-muted-foreground">Not used</span>,
      },
      { key: 'isActive', header: 'Status', render: (g) => <ActiveBadge isActive={g.isActive} /> },
    ],
    [],
  )

  return (
    <>
      {message && (
        <div className="border-primary/30 bg-primary/5 text-primary mb-3 flex items-center gap-2 rounded-lg border px-3 py-2 text-sm">
          <CheckCircle2 size={15} className="shrink-0" /> {message}
        </div>
      )}
      <MasterTable<SizeRun>
        title="Size Runs"
        entityName="Size Run"
        resource="size-groups"
        columns={columns}
        refreshKey={refreshKey}
        onNew={() => setForm({ run: null })}
        onEdit={(run) => setForm({ run })}
        filterDefs={filterDefs}
        defaultSort="name"
        searchPlaceholder="Search size run or size..."
        emptyMessage="No size runs yet. Create one and type its sizes."
      />
      {form && (
        <SizeRunDialog
          record={form.run}
          onClose={() => setForm(null)}
          onSaved={(m) => {
            setForm(null)
            setMessage(m)
            setRefreshKey((k) => k + 1)
          }}
        />
      )}
    </>
  )
}
