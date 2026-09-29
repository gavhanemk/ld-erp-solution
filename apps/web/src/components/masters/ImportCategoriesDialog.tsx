'use client'

import { FolderTree } from 'lucide-react'
import { SheetImportDialog, type SheetImportConfig } from './SheetImportDialog'

interface RowPlan {
  row: number
  category: string
  subCategory: string | null
  department: string | null
  action: 'new-main' | 'new-sub' | 'set-department' | 'none'
  alsoMain: boolean
  skipped: boolean
  problems: string[]
}

interface Summary {
  rows: number
  newMains: number
  newSubs: number
  departmentsSet: number
  skipped: number
  problems: number
}

const count = (k: number, one: string, many: string) => `${k} ${k === 1 ? one : many}`

const WHAT: Record<RowPlan['action'], string> = {
  'new-main': 'New category',
  'new-sub': 'New sub-category',
  'set-department': 'Department set',
  none: '—',
}

/** Item categories and sub-categories from a spreadsheet. Items are not touched. */
const config: SheetImportConfig<RowPlan, Summary> = {
  icon: FolderTree,
  title: 'Import item categories',
  subtitle: 'From a spreadsheet: categories, sub-categories and their departments. Items are not changed.',
  importPath: '/masters/item-categories/import',
  templatePath: (current) => `/masters/item-categories/import-template?withCurrent=${current}`,
  templates: {
    blank: {
      title: 'Blank template',
      text: 'For new categories. One row each: the category, the sub-category under it if any, and its department.',
    },
    current: {
      title: 'With your current categories',
      text: 'Every category and sub-category already listed with its department. Change a department, or add new rows at the bottom; rows left as they are are skipped.',
    },
  },
  columns: [
    {
      head: 'Category',
      cell: (r) => (
        <span className="text-foreground font-medium">
          {r.category || '—'}
          {r.subCategory && (
            <>
              <span className="text-muted-foreground font-normal"> / </span>
              {r.subCategory}
            </>
          )}
        </span>
      ),
    },
    {
      head: 'What happens',
      width: 190,
      cell: (r) => (
        <span className="text-xs">
          {WHAT[r.action]}
          {r.alsoMain && <span className="text-muted-foreground"> (and its category {r.category})</span>}
        </span>
      ),
    },
    {
      head: 'Department',
      width: 170,
      cell: (r) => <span className="text-xs">{r.department ?? '—'}</span>,
    },
  ],
  chips: (s) => (
    <>
      <span className="badge-success">{count(s.newMains, 'new category', 'new categories')}</span>
      <span className="badge-success">{count(s.newSubs, 'new sub-category', 'new sub-categories')}</span>
      {s.departmentsSet > 0 && (
        <span className="badge-info">{count(s.departmentsSet, 'department changed', 'departments changed')}</span>
      )}
    </>
  ),
  toDo: (s) =>
    [
      s.newMains ? count(s.newMains, 'category', 'categories') : '',
      s.newSubs ? count(s.newSubs, 'sub-category', 'sub-categories') : '',
      s.departmentsSet ? count(s.departmentsSet, 'department change', 'department changes') : '',
    ].filter(Boolean),
  created: (data) => (data as { created: string[] }).created.map((name) => ({ name })),
}

export function ImportCategoriesDialog({ onClose, onImported }: { onClose: () => void; onImported: () => void }) {
  return <SheetImportDialog config={config} onClose={onClose} onImported={onImported} />
}
