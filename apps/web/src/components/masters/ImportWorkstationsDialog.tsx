'use client'

import { Factory } from 'lucide-react'
import { SheetImportDialog, type SheetImportConfig } from './SheetImportDialog'

interface RowPlan {
  row: number
  name: string
  code: string | null
  workstation: 'new' | 'existing' | 'none'
  process: string | null
  runBy: string | null
  skipped: boolean
  problems: string[]
}

interface Summary {
  rows: number
  newWorkstations: number
  existing: number
  skipped: number
  problems: number
}

const count = (k: number, one: string, many: string) => `${k} ${k === 1 ? one : many}`

/** Workstations from a spreadsheet. New ones only; one already there is skipped. */
const config: SheetImportConfig<RowPlan, Summary> = {
  icon: Factory,
  title: 'Import workstations',
  subtitle: 'From a spreadsheet: tables, lines and machines on our floor, and the outside units we send work to.',
  importPath: '/masters/workstations/import',
  templatePath: (current) => `/masters/workstations/import-template?withCurrent=${current}`,
  templates: {
    blank: {
      title: 'Blank template',
      text: 'For new workstations. Dropdowns for process, run by and the supplier paid for an outside unit.',
    },
    current: {
      title: 'With your current workstations',
      text: 'Every workstation already listed. Add new ones at the bottom; ones already there are skipped, not changed.',
    },
  },
  columns: [
    {
      head: 'Workstation',
      cell: (r) => (
        <>
          <div className="text-foreground font-medium">{r.name || '—'}</div>
          {r.code && <div className="font-mono text-[11px] text-teal-500">{r.code}</div>}
        </>
      ),
    },
    {
      head: 'What happens',
      width: 150,
      cell: (r) => (
        <span className="text-xs">
          {r.workstation === 'new' ? 'New workstation' : r.workstation === 'existing' ? 'Already there' : '—'}
        </span>
      ),
    },
    {
      head: 'Process · run by',
      width: 220,
      cell: (r) => <span className="text-xs">{[r.process, r.runBy].filter(Boolean).join(' · ') || '—'}</span>,
    },
  ],
  chips: (s) => <span className="badge-success">{count(s.newWorkstations, 'new workstation', 'new workstations')}</span>,
  toDo: (s) => (s.newWorkstations ? [count(s.newWorkstations, 'new workstation', 'new workstations')] : []),
  created: (data) => (data as { created: Array<{ code: string; name: string }> }).created,
}

export function ImportWorkstationsDialog({ onClose, onImported }: { onClose: () => void; onImported: () => void }) {
  return <SheetImportDialog config={config} onClose={onClose} onImported={onImported} />
}
