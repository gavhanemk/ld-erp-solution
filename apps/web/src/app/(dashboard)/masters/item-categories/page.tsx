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
  // Where it sits first, then its name. The labels follow what is being
  // edited: a main category such as "Buttons & Fasteners" read as a
  // "Subcategory" with an empty "Category" above it, which looked broken.
  {
    name: 'parentId',
    label: 'Main category',
    type: 'select',
    // Main categories only: there are two levels, and a sub-category cannot
    // hold another.
    optionsFrom: { resource: 'item-categories', filter: (row) => !row.parentId },
    noneLabel: 'None — this is a main category',
    span: 2,
    helpFor: (v) =>
      v.parentId
        ? 'This is a sub-category under the main category chosen here.'
        : 'Empty: this is a main category, such as Fabric. Pick one to make this a sub-category under it.',
  },
  {
    name: 'name',
    label: 'Category name',
    labelFor: (v) => (v.parentId ? 'Sub-category name' : 'Category name'),
    required: true,
    span: 2,
    helpFor: (v) => (v.parentId ? 'For example Cotton, under Fabric.' : 'For example Fabric, or Buttons & Fasteners.'),
  },
  // A main category's sub-categories, for reading. Each is changed on its own
  // row, by choosing this as its main category.
  {
    name: 'subCategories',
    label: 'Sub-categories under it',
    type: 'readout',
    span: 2,
    showIf: (v) => !v.parentId,
    readout: (_v, record) => {
      const kids = (record?.children as Array<{ name: string }> | undefined) ?? []
      return kids.length ? (
        kids.map((k) => k.name).join(', ')
      ) : (
        <span className="text-muted-foreground">None yet. Add one with New Category, choosing this as its main category.</span>
      )
    },
  },
  {
    name: 'departmentId',
    label: 'Department',
    type: 'select',
    optionsFrom: { resource: 'departments' },
    span: 2,
    help: 'Who normally uses what is filed here. A new item in this category starts with it.',
  },
  // Stock of these items is labelled with QR stickers and issued by scanning.
  // A sub-category follows its main category, so ticking Fabric covers them all.
  // On for a new category: stickers pop up after every inward unless switched off.
  {
    name: 'trackPackages',
    label: 'Track by package',
    type: 'checkbox',
    checkedForNew: true,
    placeholder: 'QR sticker on each package',
    helpFor: (v) =>
      v.parentId
        ? 'Follows its main category when that is ticked; tick here to track only this sub-category.'
        : 'Ticked here, every sub-category under it is tracked too.',
  },
  {
    name: 'packType',
    label: 'Usual package',
    type: 'select',
    options: [
      { value: 'ROLL', label: 'Roll' },
      { value: 'BOX', label: 'Box' },
      { value: 'CARTON', label: 'Carton' },
      { value: 'BAG', label: 'Bag' },
      { value: 'BUNDLE', label: 'Bundle' },
      { value: 'PACKET', label: 'Packet' },
      { value: 'OTHER', label: 'Other' },
    ],
    showIf: (v) => Boolean(v.trackPackages),
    help: 'What one package of these items usually is. It can be changed when the stickers are made.',
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
        allowDelete
        deleteRefusedHint="Delete those sub-categories, or move them under another category, first."
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
