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
  category: { id: string; name: string } | null
  uom: { id: string; name: string; symbol: string } | null
  styleId: string | null
  color: string | null
  style: { id: string; code: string; name: string; colors: string[] } | null
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
    key: 'style',
    header: 'Style · Colour',
    render: (i) =>
      i.style ? (
        <span className="text-xs">
          <span className="font-mono text-teal-400">{i.style.code}</span>
          {i.color && <span className="text-muted-foreground"> · {i.color}</span>}
        </span>
      ) : i.type === 'FINISHED_GOOD' ? (
        <span className="text-xs text-amber-400">Style not set</span>
      ) : (
        <span className="text-muted-foreground">—</span>
      ),
  },
  {
    key: 'category',
    header: 'Category',
    render: (i) => i.category?.name ?? <span className="text-muted-foreground">—</span>,
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

const formFields: FormField[] = [
  { name: 'code', label: 'Item Code', generated: true, section: 'Identity' },
  { name: 'name', label: 'Item Name', required: true, placeholder: 'Cotton Poplin 40s', section: 'Identity' },
  {
    name: 'type',
    label: 'Item Type',
    type: 'select',
    required: true,
    section: 'Identity',
    options: Object.entries(TYPE_LABEL).map(([value, v]) => ({ value, label: v.label })),
  },
  {
    name: 'categoryId',
    label: 'Category',
    type: 'select',
    required: true,
    section: 'Identity',
    optionsFrom: { resource: 'item-categories' },
  },
  {
    name: 'styleId',
    label: 'Style',
    type: 'select',
    required: true,
    section: 'Identity',
    optionsFrom: { resource: 'styles' },
    showIf: (v) => v.type === 'FINISHED_GOOD',
    help: 'Which garment this is — the item becomes that style in one colour',
  },
  {
    name: 'color',
    label: 'Colour',
    type: 'select',
    required: true,
    section: 'Identity',
    optionsFromField: { field: 'styleId', resource: 'styles', arrayKey: 'colors' },
    showIf: (v) => v.type === 'FINISHED_GOOD' && Boolean(v.styleId),
    help: "One of the style's own colours — add more on the Style if it isn't listed",
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
    name: 'hsnCode',
    label: 'HSN Code',
    section: 'Identity',
    placeholder: '52081200',
    help: '4 to 8 digits, used on GST invoices',
  },
  { name: 'description', label: 'Description', type: 'textarea', section: 'Identity' },
  {
    name: 'standardRate',
    label: 'Standard Rate',
    type: 'number',
    section: 'Costing',
    placeholder: '145.50',
    help: 'Used to cost a BOM before real purchase rates exist',
  },
  {
    name: 'reorderLevel',
    label: 'Reorder Level',
    type: 'number',
    section: 'Stock Control',
    placeholder: '500',
    help: 'Raises a reorder alert when stock falls below this',
  },
  { name: 'minStock', label: 'Minimum Stock', type: 'number', section: 'Stock Control' },
  { name: 'maxStock', label: 'Maximum Stock', type: 'number', section: 'Stock Control' },
  { name: 'isActive', label: 'Active', type: 'checkbox', placeholder: 'Available for new documents', section: 'Stock Control' },
]

export default function ItemsPage() {
  return (
    <MasterTable<Item>
      title="Items"
      entityName="Item"
      resource="items"
      columns={columns}
      formFields={formFields}
      defaultSort="name"
      searchPlaceholder="Search name, code, HSN, description..."
      emptyMessage="No items yet. Add fabric, thread, buttons and other materials here."
    />
  )
}
