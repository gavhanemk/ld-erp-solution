'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { Plus, Receipt } from 'lucide-react'
import { masterResource } from '@/lib/api'
import { ActiveBadge, MasterTable, type Column } from '@/components/masters/MasterTable'
import type { FormField } from '@/components/masters/MasterFormDialog'
import { NewExpenseHeadDialog } from '@/components/purchase/NewExpenseHeadDialog'

/**
 * Expense heads — Electricity, Rent, Repairs — on their own master screen.
 *
 * They are items filed under the "Expenses" category, because that is what a
 * bill line points at, so they were only reachable by digging through Items
 * and filtering. This lists just them, with the columns that mean something
 * for an expense, and adds new ones with the same short form the expense bill
 * uses.
 */

interface Category {
  id: string
  name: string
  parentId: string | null
}

interface Head {
  id: string
  code: string
  name: string
  hsnCode: string | null
  description: string | null
  isActive: boolean
  category: { id: string; name: string; parentId: string | null } | null
  uom: { id: string; name: string; symbol: string } | null
}

/** Same rule the expense bill uses to recognise the category. */
const EXPENSE_NAME = /expense/i

const columns: Column<Head>[] = [
  {
    key: 'code',
    header: 'Code',
    sortable: true,
    className: 'whitespace-nowrap font-mono text-xs text-teal-400',
  },
  { key: 'name', header: 'Expense Head', sortable: true, className: 'font-medium' },
  {
    key: 'group',
    header: 'Group',
    render: (h) =>
      h.category?.parentId ? h.category.name : <span className="text-muted-foreground">—</span>,
  },
  {
    key: 'hsnCode',
    header: 'SAC / HSN',
    className: 'font-mono text-xs text-muted-foreground',
  },
  {
    key: 'description',
    header: 'Note',
    render: (h) =>
      h.description ? (
        <span className="text-muted-foreground text-xs">{h.description}</span>
      ) : (
        <span className="text-muted-foreground">—</span>
      ),
  },
  { key: 'isActive', header: 'Status', render: (h) => <ActiveBadge isActive={h.isActive} /> },
]

export default function ExpenseHeadsPage() {
  const [categories, setCategories] = useState<Category[] | null>(null)
  const [adding, setAdding] = useState(false)
  const [refreshKey, setRefreshKey] = useState(0)

  const loadCategories = useCallback(() => {
    masterResource<Category>('item-categories')
      .list({ limit: 500 })
      .then((r) => setCategories(r.data))
      .catch(() => setCategories([]))
  }, [])
  useEffect(loadCategories, [loadCategories])

  const top = useMemo(
    () =>
      categories?.find((c) => !c.parentId && EXPENSE_NAME.test(c.name)) ??
      categories?.find((c) => EXPENSE_NAME.test(c.name)) ??
      null,
    [categories]
  )
  const groups = useMemo(
    () => (top && categories ? categories.filter((c) => c.parentId === top.id) : []),
    [categories, top]
  )

  /*
   * The edit form. Kind and stock fields are left out: a head is always filed
   * as a consumable, and a partial save keeps what it already holds. Group is
   * the category itself or one of the groups under it.
   */
  const formFields: FormField[] = useMemo(
    () => [
      { name: 'code', label: 'Code', generated: true },
      { name: 'name', label: 'Expense Head', required: true, placeholder: 'Electricity', span: 2 },
      {
        name: 'categoryId',
        label: 'Group',
        type: 'select',
        required: true,
        optionsFrom: {
          resource: 'item-categories',
          filter: (row) => Boolean(top) && (row.id === top!.id || row.parentId === top!.id),
        },
      },
      {
        name: 'uomId',
        label: 'Unit',
        type: 'select',
        required: true,
        optionsFrom: { resource: 'uoms' },
      },
      { name: 'hsnCode', label: 'SAC / HSN Code', placeholder: '998714' },
      { name: 'description', label: 'Note', placeholder: 'e.g. MSEDCL, factory meter', span: 2 },
      { name: 'isActive', label: 'Active', type: 'checkbox', placeholder: 'Available on new bills' },
    ],
    [top]
  )

  const dialog = adding && (
    <NewExpenseHeadDialog
      expenseCategory={top}
      groups={groups}
      onClose={() => setAdding(false)}
      onCreated={(_head, createdCategory) => {
        setAdding(false)
        if (createdCategory) loadCategories()
        setRefreshKey((k) => k + 1)
      }}
    />
  )

  if (categories === null) {
    return <div className="text-muted-foreground p-6 text-sm">Loading expense heads…</div>
  }

  // No "Expenses" category yet: nothing to list, and the first head makes it.
  if (!top) {
    return (
      <div className="space-y-4">
        <div>
          <h1 className="text-foreground text-2xl font-semibold tracking-tight">Expense Heads</h1>
          <p className="text-muted-foreground text-sm">
            What expense bills are booked against — Electricity, Rent, Repairs & Maintenance
          </p>
        </div>
        <div className="glass-card flex flex-col items-center gap-3 p-10 text-center">
          <div className="bg-primary/10 border-primary/20 flex h-11 w-11 items-center justify-center rounded-xl border">
            <Receipt size={20} className="text-primary" />
          </div>
          <p className="text-foreground text-sm font-medium">No expense heads yet</p>
          <p className="text-muted-foreground max-w-md text-xs">
            Add the first one and an &ldquo;Expenses&rdquo; category is created for them in the
            item master. Every head added here or from an expense bill shows up in this list.
          </p>
          <button type="button" className="btn-primary" onClick={() => setAdding(true)}>
            <Plus size={16} /> New Expense Head
          </button>
        </div>
        {dialog}
      </div>
    )
  }

  return (
    <>
      <MasterTable<Head>
        title="Expense Heads"
        entityName="Expense Head"
        resource="items"
        filters={{ categoryId: top.id }}
        columns={columns}
        formFields={formFields}
        refreshKey={refreshKey}
        onNew={() => setAdding(true)}
        defaultSort="name"
        searchPlaceholder="Search expense heads..."
        emptyMessage="No expense heads yet. Add Electricity, Rent, Repairs and the like."
      />
      {dialog}
    </>
  )
}
