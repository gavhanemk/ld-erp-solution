'use client'

import { AlertTriangle } from 'lucide-react'
import { ActiveBadge, MasterTable, type Column } from '@/components/masters/MasterTable'
import type { FormField } from '@/components/masters/MasterFormDialog'
import { formatCurrency } from '@/lib/utils'

interface Item {
  id: string
  code: string
  name: string
  type: string
  hsnCode: string | null
  reorderLevel: string | number | null
  minStock: string | number | null
  maxStock: string | number | null
  standardRate: string | number | null
  isActive: boolean
  category: { id: string; name: string; parentId: string | null; parent?: { name: string } | null } | null
  departmentId: string | null
  uom: { id: string; name: string; symbol: string } | null
}

const TYPE_LABEL: Record<string, { label: string; cls: string }> = {
  RAW_MATERIAL: { label: 'Raw Material', cls: 'badge-info' },
  SEMI_FINISHED: { label: 'Semi Finished', cls: 'badge-warning' },
  FINISHED_GOOD: { label: 'Finished Good', cls: 'badge-success' },
  CONSUMABLE: { label: 'Consumable', cls: 'badge-neutral' },
  PACKING_MATERIAL: { label: 'Packing', cls: 'badge-neutral' },
  TRIM: { label: 'Trim', cls: 'badge-purple' },
}

const columns: Column<Item>[] = [
  { key: 'code', header: 'Code', sortable: true, className: 'font-mono text-xs text-teal-400' },
  { key: 'name', header: 'Item', sortable: true, className: 'font-medium' },
  {
    key: 'type',
    header: 'Type',
    render: (i) => {
      const t = TYPE_LABEL[i.type] ?? { label: i.type, cls: 'badge-neutral' }
      return <span className={t.cls}>{t.label}</span>
    },
  },
  {
    key: 'category',
    header: 'Category',
    render: (i) =>
      i.category ? (
        i.category.parent ? (
          <span>
            <span className="text-muted-foreground">{i.category.parent.name} › </span>
            {i.category.name}
          </span>
        ) : (
          i.category.name
        )
      ) : (
        <span className="text-muted-foreground">—</span>
      ),
  },
  {
    key: 'uom',
    header: 'UOM',
    render: (i) =>
      i.uom ? (
        <span className="text-xs text-muted-foreground" title={i.uom.name}>
          {i.uom.symbol}
        </span>
      ) : (
        <span className="text-muted-foreground">—</span>
      ),
  },
  { key: 'hsnCode', header: 'HSN', className: 'font-mono text-xs text-muted-foreground' },
  {
    key: 'standardRate',
    header: 'Std. Rate',
    align: 'right',
    sortable: true,
    render: (i) =>
      i.standardRate ? (
        <span className="font-semibold">{formatCurrency(Number(i.standardRate))}</span>
      ) : (
        <span className="text-muted-foreground">—</span>
      ),
  },
  {
    key: 'reorderLevel',
    header: 'Reorder At',
    align: 'right',
    render: (i) =>
      i.reorderLevel ? (
        <span className="inline-flex items-center gap-1 text-xs">
          <AlertTriangle size={12} className="text-amber-400" />
          {Number(i.reorderLevel).toLocaleString('en-IN')} {i.uom?.symbol ?? ''}
        </span>
      ) : (
        <span className="text-muted-foreground">—</span>
      ),
  },
  { key: 'isActive', header: 'Status', render: (i) => <ActiveBadge isActive={i.isActive} /> },
]

/** A main category is one with no parent; a sub-category sits under one. */
const isMain = (row: Record<string, unknown>) => !row.parentId

/*
 * Four to a row, in two panels, so the whole item fits on one screen:
 *
 *   Item name ........... | Item type   | Unit
 *   Category | Sub category | Department | HSN
 *   Description ...........................
 *   Standard rate | Reorder level | Minimum | Maximum
 *
 * Category and Sub Category are two boxes over the one `categoryId` the item
 * is filed under: the sub-category when there is one, the main category when
 * there is not.
 */
const formFields: FormField[] = [
  { name: 'code', label: 'Item Code', generated: true, section: 'Identity' },
  {
    name: 'name',
    label: 'Item Name',
    required: true,
    placeholder: 'Cotton Poplin 40s',
    section: 'Identity',
    span: 2,
  },
  {
    name: 'type',
    label: 'Item Type',
    type: 'select',
    required: true,
    section: 'Identity',
    options: Object.entries(TYPE_LABEL).map(([value, v]) => ({ value, label: v.label })),
  },
  {
    name: 'uomId',
    label: 'Unit of Measure',
    type: 'select',
    required: true,
    section: 'Identity',
    optionsFrom: { resource: 'uoms' },
  },
  {
    name: 'mainCategoryId',
    label: 'Category',
    type: 'select',
    required: true,
    section: 'Identity',
    sendAs: 'categoryId',
    resets: ['subCategoryId'],
    optionsFrom: { resource: 'item-categories', filter: isMain },
    initial: (r) => {
      const c = r.category as { parentId?: string | null } | null
      return c?.parentId ?? r.categoryId
    },
  },
  {
    name: 'subCategoryId',
    label: 'Sub Category',
    type: 'select',
    section: 'Identity',
    sendAs: 'categoryId',
    emptyLabel: 'None under this category',
    optionsFrom: {
      resource: 'item-categories',
      filter: (row, values) => Boolean(values.mainCategoryId) && row.parentId === values.mainCategoryId,
    },
    initial: (r) => {
      const c = r.category as { parentId?: string | null } | null
      return c?.parentId ? r.categoryId : ''
    },
  },
  {
    name: 'departmentId',
    label: 'Department',
    type: 'select',
    section: 'Identity',
    optionsFrom: { resource: 'departments' },
  },
  {
    name: 'hsnCode',
    label: 'HSN Code',
    section: 'Identity',
    placeholder: '52081200',
  },
  { name: 'description', label: 'Description', type: 'textarea', section: 'Identity' },
  {
    name: 'standardRate',
    label: 'Standard Rate (₹)',
    type: 'number',
    section: 'Costing & Stock',
    placeholder: '145.50',
    help: 'Used to cost a BOM',
  },
  {
    name: 'reorderLevel',
    label: 'Reorder Level',
    type: 'number',
    section: 'Costing & Stock',
    placeholder: '500',
    help: 'Alert when stock falls below this',
  },
  { name: 'minStock', label: 'Minimum Stock', type: 'number', section: 'Costing & Stock' },
  { name: 'maxStock', label: 'Maximum Stock', type: 'number', section: 'Costing & Stock' },
  { name: 'isActive', label: 'Active', type: 'checkbox', placeholder: 'Available for new documents' },
]

export default function ItemsPage() {
  return (
    <MasterTable<Item>
      title="Items"
      entityName="Item"
      resource="items"
      columns={columns}
      formFields={formFields}
      formColumns={4}
      defaultSort="name"
      searchPlaceholder="Search name, code, HSN, description..."
      emptyMessage="No items yet. Add fabric, thread, buttons and other materials here."
    />
  )
}
