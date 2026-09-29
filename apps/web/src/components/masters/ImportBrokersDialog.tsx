'use client'

import { Handshake } from 'lucide-react'
import { SheetImportDialog, type SheetImportConfig } from './SheetImportDialog'

interface RowPlan {
  row: number
  name: string
  code: string | null
  broker: 'new' | 'existing' | 'none'
  brokerage: number | null
  skipped: boolean
  problems: string[]
}

interface Summary {
  rows: number
  newAgents: number
  existing: number
  skipped: number
  problems: number
}

const count = (k: number, one: string, many: string) => `${k} ${k === 1 ? one : many}`

/** Agents from a spreadsheet. New agents only; one already there is skipped. */
const config: SheetImportConfig<RowPlan, Summary> = {
  icon: Handshake,
  title: 'Import agents',
  subtitle: 'From a spreadsheet: new agents and brokers, checked the same way as the form, GSTIN included.',
  importPath: '/masters/brokers/import',
  templatePath: (current) => `/masters/brokers/import-template?withCurrent=${current}`,
  templates: {
    blank: {
      title: 'Blank template',
      text: 'For new agents. Dropdowns for state and TDS section; the state code and PAN come from the GSTIN.',
    },
    current: {
      title: 'With your current agents',
      text: 'Every agent already listed. Add new ones at the bottom; agents already there are skipped, not changed.',
    },
  },
  columns: [
    {
      head: 'Agent',
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
        <span className="text-xs">{r.broker === 'new' ? 'New agent' : r.broker === 'existing' ? 'Already there' : '—'}</span>
      ),
    },
    {
      head: 'Brokerage',
      width: 110,
      cell: (r) => <span className="text-xs tabular-nums">{r.brokerage != null ? `${r.brokerage}%` : '—'}</span>,
    },
  ],
  chips: (s) => <span className="badge-success">{count(s.newAgents, 'new agent', 'new agents')}</span>,
  toDo: (s) => (s.newAgents ? [count(s.newAgents, 'new agent', 'new agents')] : []),
  created: (data) => (data as { created: Array<{ code: string; name: string }> }).created,
}

export function ImportBrokersDialog({ onClose, onImported }: { onClose: () => void; onImported: () => void }) {
  return <SheetImportDialog config={config} onClose={onClose} onImported={onImported} />
}
