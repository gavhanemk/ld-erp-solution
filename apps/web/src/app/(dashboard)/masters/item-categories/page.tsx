'use client'

import { ActiveBadge, MasterTable, type Column } from '@/components/masters/MasterTable'
import type { FormField } from '@/components/masters/MasterFormDialog'

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
  children?: { id: string; name: string }[]
  isActive: boolean
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
  { key: 'isActive', header: 'Status', render: (c) => <ActiveBadge isActive={c.isActive} /> },
]

const formFields: FormField[] = [
  // Category first, then the name. You decide where something belongs before
  // you name it, and putting the parent second made the form read backwards.
  {
    name: 'parentId',
    label: 'Category',
    type: 'select',
    optionsFrom: { resource: 'item-categories' },
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
    name: 'isActive',
    label: 'Active',
    type: 'checkbox',
    placeholder: 'Offered when filing an item',
  },
]

export default function ItemCategoriesPage() {
  return (
    <MasterTable<ItemCategory>
      title="Item Categories"
      entityName="Category"
      resource="item-categories"
      columns={columns}
      formFields={formFields}
      defaultSort="name"
      searchPlaceholder="Search categories..."
      emptyMessage="No categories yet. Add one, then add subcategories beneath it."
    />
  )
}
