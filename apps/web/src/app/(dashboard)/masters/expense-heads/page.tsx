'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { Plus, Receipt } from 'lucide-react'
import { masterResource } from '@/lib/api'
import { ActiveBadge, MasterTable, type Column } from '@/components/masters/MasterTable'
import { ExpenseHeadDialog, type ExpenseHead } from '@/components/purchase/ExpenseHeadDialog'

/**
 * Expense heads — Electricity, Rent, Repairs — on their own master screen.
 *
 * They are items filed under the "Expenses" category, because that is what a
 * bill line points at, so they were only reachable by digging through Items
 * and filtering. This lists just them, with the columns that mean something
 * for an expense. Adding and editing both use the one short form the expense
 * bill uses, so the two can never look different.
 */

interface Category {
  id: string
  name: string
  parentId: string | null
}

/** Same rule the expense bill uses to recognise the category. */
const EXPENSE_NAME = /expense/i

const columns: Column<ExpenseHead>[] = [
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
  /** The open form: a new head, a head being edited, or nothing. */
  const [form, setForm] = useState<{ head: ExpenseHead | null } | null>(null)
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

  const dialog = form && (
    <ExpenseHeadDialog
      head={form.head}
      expenseCategory={top}
      groups={groups}
      onClose={() => setForm(null)}
      onCreated={(_head, createdCategory) => {
        setForm(null)
        if (createdCategory) loadCategories()
        setRefreshKey((k) => k + 1)
      }}
      onSaved={() => {
        setForm(null)
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
          <button type="button" className="btn-primary" onClick={() => setForm({ head: null })}>
            <Plus size={16} /> New Expense Head
          </button>
        </div>
        {dialog}
      </div>
    )
  }

  return (
    <>
      <MasterTable<ExpenseHead>
        title="Expense Heads"
        entityName="Expense Head"
        resource="items"
        filters={{ categoryId: top.id }}
        columns={columns}
        refreshKey={refreshKey}
        onNew={() => setForm({ head: null })}
        onEdit={(head) => setForm({ head })}
        defaultSort="name"
        searchPlaceholder="Search expense heads..."
        emptyMessage="No expense heads yet. Add Electricity, Rent, Repairs and the like."
      />
      {dialog}
    </>
  )
}
