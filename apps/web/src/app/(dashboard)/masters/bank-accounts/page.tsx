'use client'

import { ActiveBadge, MasterTable, type Column } from '@/components/masters/MasterTable'
import type { FormField } from '@/components/masters/MasterFormDialog'

interface BankAccount {
  id: string
  accountName: string
  bankName: string
  accountNumber: string
  ifscCode: string
  branch: string | null
  accountType: string
  isActive: boolean
}

const TYPES = [
  { value: 'CURRENT', label: 'Current' },
  { value: 'SAVINGS', label: 'Savings' },
  { value: 'CC', label: 'Cash credit' },
  { value: 'OD', label: 'Overdraft' },
]

/**
 * The account number is shown by its last four digits only.
 *
 * A full account number on a list screen is on somebody's shoulder-surfed
 * photograph the moment it is opened in a shared office, and the last four is
 * what anyone here uses to tell two accounts apart anyway. The whole number is
 * on the edit form, where it is needed.
 */
const columns: Column<BankAccount>[] = [
  { key: 'accountName', header: 'Account', sortable: true, className: 'font-medium' },
  { key: 'bankName', header: 'Bank', sortable: true },
  {
    key: 'accountNumber',
    header: 'Number',
    render: (a) => (
      <span className="font-mono text-xs text-muted-foreground">···{a.accountNumber.slice(-4)}</span>
    ),
  },
  {
    key: 'ifscCode',
    header: 'IFSC',
    render: (a) => <span className="font-mono text-xs text-teal-400">{a.ifscCode}</span>,
  },
  {
    key: 'accountType',
    header: 'Type',
    render: (a) => (
      <span className="text-xs text-muted-foreground">
        {TYPES.find((t) => t.value === a.accountType)?.label ?? a.accountType}
      </span>
    ),
  },
  { key: 'isActive', header: 'Status', render: (a) => <ActiveBadge isActive={a.isActive} /> },
]

const formFields: FormField[] = [
  {
    name: 'accountName',
    label: 'Account Name',
    required: true,
    placeholder: 'LD Cotton Mills — Current',
    help: 'What this account is called in the books, not the bank’s own wording',
  },
  { name: 'bankName', label: 'Bank', required: true, placeholder: 'HDFC Bank' },
  { name: 'accountNumber', label: 'Account Number', required: true },
  {
    name: 'ifscCode',
    label: 'IFSC Code',
    required: true,
    uppercase: true,
    placeholder: 'HDFC0001234',
    help: 'Four letters, a zero, then six more',
  },
  { name: 'branch', label: 'Branch', placeholder: 'Ichalkaranji' },
  { name: 'accountType', label: 'Account Type', type: 'select', options: TYPES },
  // Can be below nought: an overdrawn account.
  { name: 'openingBalance', label: 'Opening Balance', type: 'number', allowNegative: true },
  {
    name: 'isActive',
    label: 'Active',
    type: 'checkbox',
    placeholder: 'Offered when a payment is recorded',
  },
]

export default function BankAccountsPage() {
  return (
    <MasterTable<BankAccount>
      title="Bank Accounts"
      entityName="Bank Account"
      resource="bank-accounts"
      columns={columns}
      formFields={formFields}
      defaultSort="accountName"
      searchPlaceholder="Search account name, bank or number..."
      emptyMessage="No accounts yet. Add the ones the mill pays suppliers from — a payment records which account the money left."
    />
  )
}
