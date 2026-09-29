'use client'

import { useState } from 'react'
import { FileSpreadsheet } from 'lucide-react'
import { ActiveBadge, MasterTable, type Column, type FilterDef } from '@/components/masters/MasterTable'
import type { FormField } from '@/components/masters/MasterFormDialog'
import { ImportCategoriesDialog } from '@/components/masters/ImportCategoriesDialog'

/**
 * Item categories, and the subcategories under them.
 *
 * There was no screen for these, which meant the only categories in the system
 * were the seven the seed put there and nobody could add a subcategory at all —
 * so the subcategory box on the purchase order form had nothing to offer and
 * sat permanently greyed out.
 *
 * A subcategory is not a separate kind of record. It is a category with a
 * parent, which is why one screen covers both: leave the parent empty and you
 * have a category, pick one and you have a subcategory beneath it.
 *
 * It also decides item codes. An item takes its prefix from its category, so a
 * cotton poplin filed under Fabric becomes FAB-011 rather than ITM-011, and a
 * store keeper searching "FAB" finds it.
 */
interface ItemCategory {
  id: string
  name: string
  parentId: string | null
  parent?: { id: string; name: string } | null
  departmentId?: string | null
  department?: { id: string; name: string } | null
  children?: { id: string; name: string; department?: { id: string; name: string } | null }[]
  isActive: boolean
}

/**
 * A sub-category's own department; a main category's own, or else the ones
 * its sub-categories use, so Fabric reads Cutting and Thread reads
 * Stitching, Embroidery.
 */
const departmentsOf = (c: ItemCategory): string[] => {
  if (c.department) return [c.department.name]
  return [...new Set((c.children ?? []).map((k) => k.department?.name).filter((n): n is string => Boolean(n)))]
}

const columns: Column<ItemCategory>[] = [
  {
    key: 'name',
    header: 'Category',
    sortable: true,
    className: 'font-medium',
    render: (c) =>
      c.parent ? (
        // Shown as a path rather than a bare name: on one flat list "Cotton"
        // alone does not say whether it is a fabric or a thread.
        <span>
          <span className="text-muted-foreground">{c.parent.name} / </span>
          {c.name}
        </span>
      ) : (
        c.name
      ),
  },
  {
    key: 'level',
    header: 'Level',
    render: (c) =>
      c.parent ? (
        <span className="badge-neutral">Subcategory</span>
      ) : (
        <span className="badge-info">Category</span>
      ),
  },
  {
    key: 'children',
    header: 'Subcategories',
    render: (c) => {
      const n = c.children?.length ?? 0
      if (c.parent) return <span className="text-muted-foreground">—</span>
      return n > 0 ? (
        <span>{n}</span>
      ) : (
        <span className="text-muted-foreground">None yet</span>
      )
    },
  },
  {
    key: 'department',
    header: 'Department',
    render: (c) => {
      const names = departmentsOf(c)
      if (names.length === 0) return <span className="text-muted-foreground">—</span>
      return (
        <span className={c.department ? '' : 'text-muted-foreground'}>
          {names.join(', ')}
        </span>
      )
    },
  },
  { key: 'isActive', header: 'Status', render: (c) => <ActiveBadge isActive={c.isActive} /> },
]

const formFields: FormField[] = [
  // Category first, then the name. You decide where something belongs before
  // you name it, and putting the parent second made the form read backwards.
  {
    name: 'parentId',
    label: 'Category',
    type: 'select',
    // Main categories only: there are two levels, and a sub-category cannot
    // hold another.
    optionsFrom: { resource: 'item-categories', filter: (row) => !row.parentId },
    placeholder: 'None — I am adding a main category',
    span: 2,
    help: 'Which category this sits under. Leave it empty to add a main category instead.',
  },
  {
    name: 'name',
    label: 'Subcategory',
    required: true,
    placeholder: 'Cotton',
    span: 2,
    help: 'The name. With Category left empty above, this becomes a main category — "Fabric" rather than "Cotton".',
  },
  {
    name: 'departmentId',
    label: 'Department',
    type: 'select',
    optionsFrom: { resource: 'departments' },
    span: 2,
    help: 'Who normally uses what is filed here. A new item in this category starts with it.',
  },
  {
    name: 'isActive',
    label: 'Active',
    type: 'checkbox',
    placeholder: 'Offered when filing an item',
  },
]

/*
 * Two dropdowns: a main category (with everything under it), and the level.
 * Each counts what it would leave, like the item list's filters.
 */
const filterDefs: FilterDef[] = [
  {
    key: 'departmentId',
    label: 'Department',
    facet: 'departmentId',
    noneLabel: 'No department',
    optionsFrom: { resource: 'departments' },
  },
  {
    key: 'categoryId',
    label: 'Category',
    facet: 'parentId',
    optionsFrom: { resource: 'item-categories', filter: (r) => !r.parentId },
    // The category itself and its sub-categories.
    count: (id, counts) => (counts[id] ?? 0) + 1,
  },
  {
    key: 'level',
    label: 'Level',
    facet: 'parentId',
    options: [
      { value: 'main', label: 'Main categories' },
      { value: 'sub', label: 'Sub-categories' },
    ],
    count: (value, counts) => {
      const mains = counts.none ?? 0
      const all = Object.values(counts).reduce((a, b) => a + b, 0)
      return value === 'main' ? mains : all - mains
    },
  },
]

export default function ItemCategoriesPage() {
  const [importing, setImporting] = useState(false)
  // Bumped after an import, so the list and its filter counts reload.
  const [refreshKey, setRefreshKey] = useState(0)

  return (
    <>
      <MasterTable<ItemCategory>
        title="Item Categories"
        entityName="Category"
        resource="item-categories"
        columns={columns}
        formFields={formFields}
        filterDefs={filterDefs}
        defaultSort="name"
        searchPlaceholder="Search categories..."
        emptyMessage="No categories yet. Add one, then add subcategories beneath it."
        refreshKey={refreshKey}
        actions={
          <button type="button" className="btn-secondary" onClick={() => setImporting(true)}>
            <FileSpreadsheet size={16} /> Import
          </button>
        }
      />
      {importing && (
        <ImportCategoriesDialog
          onClose={() => setImporting(false)}
          onImported={() => setRefreshKey((k) => k + 1)}
        />
      )}
    </>
  )
}
