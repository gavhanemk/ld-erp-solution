'use client'

import { Shirt } from 'lucide-react'
import { SheetImportDialog, type SheetImportConfig } from './SheetImportDialog'

interface RowPlan {
  row: number
  code: string
  name: string
  style: 'new' | 'existing' | 'none'
  sizeRun: string | null
  colours: number
  skipped: boolean
  problems: string[]
}

interface Summary {
  rows: number
  newStyles: number
  existing: number
  skipped: number
  problems: number
}

const count = (k: number, one: string, many: string) => `${k} ${k === 1 ? one : many}`

/** Styles from a spreadsheet. New styles only; one already there is skipped. */
const config: SheetImportConfig<RowPlan, Summary> = {
  icon: Shirt,
  title: 'Import styles',
  subtitle: 'From a spreadsheet: new styles with their brand, construction, size run and colours.',
  importPath: '/masters/styles/import',
  templatePath: (current) => `/masters/styles/import-template?withCurrent=${current}`,
  templates: {
    blank: {
      title: 'Blank template',
      text: 'For new styles. Dropdowns for brand and size run, and for the garments, seasons, fabrics and fits your styles already use.',
    },
    current: {
      title: 'With your current styles',
      text: 'Every style already listed, to copy from. Add new ones at the bottom; styles already there are skipped, not changed.',
    },
  },
  columns: [
    {
      head: 'Style',
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
      cell: (r) => <span className="text-xs">{r.style === 'new' ? 'New style' : r.style === 'existing' ? 'Already there' : '—'}</span>,
    },
    {
      head: 'Size run · colours',
      width: 240,
      cell: (r) => (
        <span className="text-xs">
          {r.sizeRun ?? '—'}
          {r.colours > 0 && <span className="text-muted-foreground"> · {count(r.colours, 'colour', 'colours')}</span>}
        </span>
      ),
    },
  ],
  chips: (s) => <span className="badge-success">{count(s.newStyles, 'new style', 'new styles')}</span>,
  toDo: (s) => (s.newStyles ? [count(s.newStyles, 'new style', 'new styles')] : []),
  created: (data) => (data as { created: Array<{ code: string; name: string }> }).created,
}

export function ImportStylesDialog({ onClose, onImported }: { onClose: () => void; onImported: () => void }) {
  return <SheetImportDialog config={config} onClose={onClose} onImported={onImported} />
}
