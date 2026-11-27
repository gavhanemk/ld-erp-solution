'use client'

import { useState } from 'react'
import { Layers } from 'lucide-react'
import { api, ApiError, can } from '@/lib/api'
import { ActiveBadge, MasterTable, type Column } from '@/components/masters/MasterTable'
import type { FormField } from '@/components/masters/MasterFormDialog'

interface Department {
  id: string
  code: string
  name: string
  isActive: boolean
  /** What it rolls up into as a cost centre: Line QC into Quality Control. */
  parent?: { id: string; name: string } | null
  /** How many of each thing point at this department. */
  _count?: Record<string, number>
}

/** A count, or a quiet dash for none, so the eye goes to what is in use. */
const used = (n: number | undefined) =>
  n ? <span className="tabular-nums">{n}</span> : <span className="text-muted-foreground">—</span>

const columns: Column<Department>[] = [
  {
    key: 'code',
    header: 'Code',
    sortable: true,
    className: 'whitespace-nowrap font-mono text-xs text-teal-400',
  },
  { key: 'name', header: 'Department', sortable: true, className: 'font-medium' },
  {
    key: 'parent',
    header: 'Rolls up into',
    render: (d) => <span className="text-xs">{d.parent?.name ?? <span className="text-muted-foreground">—</span>}</span>,
  },
  // What each department is holding up, so nobody deactivates Cutting without
  // seeing that nine requisitions and two workstations sit under it.
  { key: 'items', header: 'Items', align: 'right', render: (d) => used(d._count?.items) },
  {
    key: 'workstations',
    header: 'Workstations',
    align: 'right',
    render: (d) => used(d._count?.workstations),
  },
  {
    key: 'operations',
    header: 'Operations',
    align: 'right',
    render: (d) => used(d._count?.operations),
  },
  {
    key: 'requisitions',
    header: 'Requisitions',
    align: 'right',
    render: (d) => used(d._count?.requisitions),
  },
  { key: 'isActive', header: 'Status', render: (d) => <ActiveBadge isActive={d.isActive} /> },
]

// The code is made from the name when the department is saved ("Printing QC"
// becomes PRIQC), and companyId is filled in by the API.
const formFields: FormField[] = [
  { name: 'code', label: 'Department Code', generated: true },
  {
    name: 'name',
    label: 'Department Name',
    required: true,
    placeholder: 'Printing',
    help: 'Renaming changes it everywhere it is used, past documents included',
  },
  {
    name: 'parentId',
    label: 'Rolls up into',
    type: 'select',
    optionsFrom: {
      resource: 'departments',
      // Never itself: the server also refuses one that rolls up into it.
      filter: (row, values) => row.id !== values.id && row.isActive !== false,
    },
    emptyLabel: 'Nothing: it is at the top',
    help: 'As a cost centre its spending also counts under this one: Line QC under Quality Control, Quality Control under Production',
  },
  {
    name: 'isActive',
    label: 'Active',
    type: 'checkbox',
    placeholder: 'Offered on items, requisitions and routings',
  },
]

/** What the one-click set-up adds and rolls up, said before it is done. */
const STANDARD = [
  'Adds the cost centres the multi-brand plan names that are missing: Production, Quality Control, Administration, Purchase, Sales & Marketing, Maintenance, Shared Overheads.',
  'Rolls up the four QC departments under Quality Control; Cutting, Fusing, Embroidery, Stitching, Kaj Button, Washing, Finishing, Packing, Job Work and Quality Control under Production; Accounts and HR & Admin under Administration.',
  'A department already rolled up somewhere is left where it is. Nothing is renamed or merged, so routings and process floors are untouched.',
]

export default function DepartmentsPage() {
  const [asking, setAsking] = useState(false)
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null)
  const [refreshKey, setRefreshKey] = useState(0)

  const addStandard = async () => {
    setBusy(true)
    setNote(null)
    try {
      const res = await api.post<{ message: string }>('/masters/departments/standard-cost-centres', {})
      setNote({ ok: true, text: res.message })
      setAsking(false)
      setRefreshKey((k) => k + 1)
    } catch (err) {
      setNote({ ok: false, text: err instanceof ApiError ? err.message : 'Could not set up the cost centres. Try again.' })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-3">
      {(asking || note) && (
        <div className="glass-card space-y-2 p-4 text-sm" role="status">
          {asking && (
            <>
              <p className="font-medium">Set up the plan&apos;s cost centres</p>
              <ul className="list-disc space-y-1 pl-5 text-muted-foreground">
                {STANDARD.map((t) => (
                  <li key={t}>{t}</li>
                ))}
              </ul>
              <div className="flex gap-2 pt-1">
                <button type="button" className="btn-primary" onClick={() => void addStandard()} disabled={busy}>
                  {busy ? 'Setting up…' : 'Add and roll up'}
                </button>
                <button type="button" className="btn-secondary" onClick={() => setAsking(false)} disabled={busy}>
                  Cancel
                </button>
              </div>
            </>
          )}
          {note && <p className={note.ok ? 'text-emerald-500' : 'text-red-400'}>{note.text}</p>}
        </div>
      )}
      <MasterTable<Department>
        title="Departments"
        entityName="Department"
        resource="departments"
        columns={columns}
        formFields={formFields}
        allowDelete
        defaultSort="name"
        refreshKey={refreshKey}
        actions={
          can('masters', 'create') ? (
            <button
              type="button"
              className="btn-secondary"
              onClick={() => setAsking(true)}
              title="Add the cost centres the multi-brand plan names and roll today's departments up under them"
            >
              <Layers size={15} />
              Cost centres
            </button>
          ) : undefined
        }
        searchPlaceholder="Search department name or code..."
        emptyMessage="No departments yet. Add Cutting, Stitching, Finishing and the rest of the floor."
      />
    </div>
  )
}
