'use client'

import { FileSpreadsheet, ReceiptText } from 'lucide-react'
import { SheetImportDialog, type SheetImportConfig } from '@/components/masters/SheetImportDialog'
import { day, drCr, inr } from './books'

interface BalanceRow {
  row: number
  ledger: string
  group: string
  action: 'set' | 'new'
  before: number
  after: number
  skipped: boolean
  problems: string[]
}

interface BalanceSummary {
  rows: number
  changes: number
  newLedgers: number
  debit: number
  credit: number
  difference: number
  skipped: number
  problems: number
}

const count = (k: number, one: string, many: string) => `${k} ${k === 1 ? one : many}`

/** The old books' trial balance, as at the day before the books start here. */
const balancesConfig: SheetImportConfig<BalanceRow, BalanceSummary> = {
  icon: FileSpreadsheet,
  title: 'Bring in the trial balance',
  subtitle: 'The old books as they stood the day before the books start here: one figure per ledger, debit or credit.',
  importPath: '/accounts/opening/balances',
  templatePath: (current) => `/accounts/opening/balances-template?withCurrent=${current}`,
  templates: {
    blank: { title: 'Blank template', text: 'A row per ledger. Pick one from the list, or type a new name and give its group.' },
    current: { title: 'With every ledger', text: 'Every ledger already here, with its opening now. Fill in the figures and bring it back.' },
  },
  columns: [
    {
      head: 'Ledger',
      cell: (r) => (
        <>
          <div className="text-foreground font-medium">{r.ledger || '—'}</div>
          <div className="text-muted-foreground text-[11px]">
            {r.group}
            {r.action === 'new' && ' · new ledger'}
          </div>
        </>
      ),
    },
    { head: 'Opening now', width: 150, cell: (r) => <span className="text-xs tabular-nums">{drCr(r.before)}</span> },
    { head: 'Becomes', width: 150, cell: (r) => <span className="text-xs font-medium tabular-nums">{drCr(r.after)}</span> },
  ],
  chips: (s) => (
    <>
      <span className="badge-info">Debit ₹{inr(s.debit)}</span>
      <span className="badge-info">Credit ₹{inr(s.credit)}</span>
      {s.difference !== 0 ? <span className="badge-warning">Out by {drCr(s.difference)}</span> : <span className="badge-success">Debits and credits agree</span>}
      {s.newLedgers > 0 && <span className="badge-purple">{count(s.newLedgers, 'new ledger', 'new ledgers')}</span>}
    </>
  ),
  toDo: (s) => [...(s.changes ? [count(s.changes, 'opening', 'openings')] : []), ...(s.newLedgers ? [count(s.newLedgers, 'new ledger', 'new ledgers')] : [])],
  created: (data) => (data as { created: Array<{ name: string }> }).created,
}

interface BillRow {
  row: number
  party: string
  billNo: string
  billDate: string | null
  dueDate: string | null
  amount: number
  type: 'Bill' | 'Advance'
  skipped: boolean
  problems: string[]
}

interface BillSummary {
  rows: number
  bills: number
  advances: number
  parties: number
  changedOpenings: number
  skipped: number
  problems: number
}

/** Bills unpaid the day before the books start: customers', suppliers', brokers'. */
const billsConfig: SheetImportConfig<BillRow, BillSummary> = {
  icon: ReceiptText,
  title: 'Bring in unpaid bills',
  subtitle: 'Every bill still unpaid when the books start here. Each party opens owing the total of its bills, less any advance.',
  importPath: '/accounts/opening/bills',
  templatePath: (current) => `/accounts/opening/bills-template?withCurrent=${current}`,
  templates: {
    blank: { title: 'Blank template', text: 'A row per bill: the party, its number, date, due date and what is still unpaid on it.' },
    current: { title: 'With the old bills already in', text: 'Every old bill brought in so far. Change it and bring it back; the parties it names are replaced.' },
  },
  columns: [
    {
      head: 'Party',
      cell: (r) => (
        <>
          <div className="text-foreground font-medium">{r.party || '—'}</div>
          <div className="text-muted-foreground font-mono text-[11px]">{r.billNo}</div>
        </>
      ),
    },
    { head: 'Dated', width: 110, cell: (r) => <span className="text-xs tabular-nums">{r.billDate ? day(r.billDate) : '—'}</span> },
    { head: 'Due', width: 110, cell: (r) => <span className="text-xs tabular-nums">{r.dueDate ? day(r.dueDate) : '—'}</span> },
    {
      head: 'Unpaid',
      width: 140,
      cell: (r) => (
        <span className="text-xs tabular-nums">
          ₹{inr(r.amount)}
          {r.type === 'Advance' && <span className="text-muted-foreground"> advance</span>}
        </span>
      ),
    },
  ],
  chips: (s) => (
    <>
      <span className="badge-info">{count(s.bills, 'bill', 'bills')}</span>
      {s.advances > 0 && <span className="badge-info">{count(s.advances, 'advance', 'advances')}</span>}
      <span className="badge-success">{count(s.parties, 'party', 'parties')}</span>
    </>
  ),
  toDo: (s) => (s.bills + s.advances ? [count(s.bills + s.advances, 'old bill', 'old bills')] : []),
  created: (data) => (data as { created: Array<{ name: string }> }).created,
}

export function OpeningBalancesImport({ onClose, onImported }: { onClose: () => void; onImported: () => void }) {
  return <SheetImportDialog config={balancesConfig} onClose={onClose} onImported={onImported} />
}

export function OpeningBillsImport({ onClose, onImported }: { onClose: () => void; onImported: () => void }) {
  return <SheetImportDialog config={billsConfig} onClose={onClose} onImported={onImported} />
}
