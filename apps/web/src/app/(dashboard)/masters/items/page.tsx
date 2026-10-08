'use client'

import { useEffect, useMemo, useState } from 'react'
import { AlertTriangle, FileSpreadsheet } from 'lucide-react'
import { ImportItemsDialog } from '@/components/masters/ImportItemsDialog'
import { api } from '@/lib/api'
import { ActiveBadge, MasterTable, type Column, type FilterDef } from '@/components/masters/MasterTable'
import type { FormField } from '@/components/masters/MasterFormDialog'

/**
 * A rate in full, in Indian grouping: ₹1,290 and ₹0.35, never "₹1.3K". A rate
 * is typed onto orders from this column, so it has to be the exact figure.
 */
const rate = (n: number) =>
  `₹${n.toLocaleString('en-IN', {
    minimumFractionDigits: Number.isInteger(n) ? 0 : 2,
    maximumFractionDigits: 2,
  })}`

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
  department?: { id: string; name: string; code: string } | null
  uom: { id: string; name: string; symbol: string } | null
  /** The GST the item is filled in at: its HSN code's rate when the code is listed, else its own. */
  taxRate: { rate: string | number } | null
  taxRateSource: 'HSN' | 'ITEM' | null
  hsn: { code: string } | null
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

/**
 * The list's columns. `toReorder` is the items that need reordering, by id,
 * with their stock: the warning shows on those and no others. It used to show
 * on every item that had a reorder level, whatever its stock.
 */
const columnsFor = (toReorder: Map<string, number>): Column<Item>[] => [
  // A code is one token; broken over two lines it reads as two.
  {
    key: 'code',
    header: 'Code',
    sortable: true,
    className: 'whitespace-nowrap font-mono text-xs text-teal-400',
  },
  { key: 'name', header: 'Item', sortable: true, className: 'font-medium' },
  {
    key: 'type',
    header: 'Type',
    render: (i) => {
      const t = TYPE_LABEL[i.type] ?? { label: i.type, cls: 'badge-neutral' }
      return <span className={t.cls}>{t.label}</span>
    },
  },
  // An item is filed under one category. When that is a sub-category, its
  // parent is the Category and it is the Sub Category; when it is a main
  // category, there is no sub-category to show.
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
    render: (i) =>
      i.category ? (
        (i.category.parent?.name ?? i.category.name)
      ) : (
        <span className="text-muted-foreground">—</span>
      ),
  },
  {
    key: 'subCategory',
    header: 'Sub Category',
    render: (i) =>
      i.category?.parent ? i.category.name : <span className="text-muted-foreground">—</span>,
  },
  // Which department uses it: the column the list is most often read by.
  {
    key: 'department',
    header: 'Department',
    render: (i) => i.department?.name ?? <span className="text-muted-foreground">—</span>,
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
  // What GST an order or bill fills in for this item, and where that comes
  // from: the HSN list, or the item's own rate for a code not listed yet.
  {
    key: 'gst',
    header: 'GST',
    align: 'right',
    render: (i) =>
      i.taxRate ? (
        <span
          className="whitespace-nowrap text-xs tabular-nums"
          title={
            i.taxRateSource === 'HSN'
              ? `From HSN ${i.hsn?.code} in the HSN list`
              : 'Set on the item — its HSN code is not in the HSN list yet'
          }
        >
          {Number(i.taxRate.rate)}%
          <span className="text-muted-foreground ml-1 text-[10px]">
            {i.taxRateSource === 'HSN' ? 'HSN' : 'item'}
          </span>
        </span>
      ) : (
        <span className="text-muted-foreground">—</span>
      ),
  },
  {
    key: 'standardRate',
    header: 'Std. Rate',
    align: 'right',
    sortable: true,
    render: (i) =>
      i.standardRate ? (
        <span className="whitespace-nowrap font-semibold">{rate(Number(i.standardRate))}</span>
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
        <span
          className={`inline-flex items-center gap-1 whitespace-nowrap text-xs ${
            toReorder.has(i.id) ? 'font-semibold text-amber-500' : ''
          }`}
          title={
            toReorder.has(i.id)
              ? `Needs reordering: ${toReorder.get(i.id)!.toLocaleString('en-IN')} ${i.uom?.symbol ?? ''} in all stores`
              : undefined
          }
        >
          {toReorder.has(i.id) && <AlertTriangle size={12} className="text-amber-500" />}
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
 *   Style | Colour                        (a finished good only)
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
    fills: { field: 'departmentId', from: (row) => row.departmentId },
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
    mustFill: 'ifOptions',
    fills: { field: 'departmentId', from: (row) => row.departmentId },
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
    mustFill: true,
    optionsFrom: { resource: 'departments' },
  },
  {
    name: 'hsnCode',
    label: 'HSN Code',
    section: 'Identity',
    placeholder: '52081200',
    // Offered from the HSN list as you type, with each code's GST beside it.
    // A code not listed yet can still be typed.
    suggestFrom: {
      resource: 'hsn-codes',
      valueKey: 'code',
      label: (r) => `${String(r.description ?? '')} · GST ${Number(r.gstRate)}%`,
    },
    help: 'GST comes from this code in Masters → HSN / SAC Codes',
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

type Row = Record<string, unknown>

/*
 * Five dropdowns over the list. Each counts what it would leave given the
 * search and the others, and the sub-category list shows only the children
 * of the categories ticked (all of them, with their parent named, when none
 * is).
 */
const filterDefs: FilterDef[] = [
  {
    key: 'type',
    label: 'Type',
    facet: 'type',
    options: Object.entries(TYPE_LABEL).map(([value, v]) => ({ value, label: v.label })),
  },
  {
    key: 'categoryId',
    label: 'Category',
    facet: 'categoryId',
    optionsFrom: { resource: 'item-categories', filter: (r) => !r.parentId },
    // A main category's count takes in every item under its sub-categories.
    count: (id, counts, rows) =>
      (counts[id] ?? 0) +
      rows.filter((r) => r.parentId === id).reduce((n, r) => n + (counts[String(r.id)] ?? 0), 0),
  },
  {
    key: 'subCategoryId',
    label: 'Sub Category',
    facet: 'categoryId',
    dependsOn: 'categoryId',
    optionsFrom: {
      resource: 'item-categories',
      filter: (r, picked) =>
        Boolean(r.parentId) &&
        (!picked.categoryId?.length || picked.categoryId.includes(String(r.parentId))),
      // The parent is named only when more than one could be meant.
      label: (r, picked) => {
        const parent = (r.parent as Row | null)?.name
        return parent && picked.categoryId?.length !== 1 ? `${r.name} (${parent})` : String(r.name)
      },
    },
  },
  {
    key: 'departmentId',
    label: 'Department',
    facet: 'departmentId',
    noneLabel: 'No department',
    optionsFrom: { resource: 'departments' },
  },
  {
    key: 'uomId',
    label: 'Unit',
    facet: 'uomId',
    optionsFrom: { resource: 'uoms', label: (r) => `${r.name} (${r.symbol})` },
  },
]

export default function ItemsPage() {
  // Which items need reordering, by the same rule as the stock screen. Someone
  // without access to stock simply sees no warnings.
  const [toReorder, setToReorder] = useState<Map<string, number>>(new Map())
  useEffect(() => {
    api
      .get<{ data: Array<{ itemId: string; onHand: number }> }>('/inventory/reorder')
      .then((res) => setToReorder(new Map(res.data.map((r) => [r.itemId, r.onHand]))))
      .catch(() => {})
  }, [])
  const columns = useMemo(() => columnsFor(toReorder), [toReorder])

  // Bringing many items, and today's stock, in from a spreadsheet.
  const [importing, setImporting] = useState(false)
  const [refreshKey, setRefreshKey] = useState(0)

  return (
    <>
    <MasterTable<Item>
      title="Items"
      entityName="Item"
      resource="items"
      columns={columns}
      formFields={formFields}
      formColumns={4}
      refreshKey={refreshKey}
      actions={
        <button type="button" className="btn-secondary" onClick={() => setImporting(true)}>
          <FileSpreadsheet size={16} /> Import
        </button>
      }
      filterDefs={filterDefs}
      defaultSort="name"
      searchPlaceholder="Search name, code, HSN, category, department..."
      emptyMessage="No items yet. Add fabric, thread, buttons and other materials here."
    />
    {importing && (
      <ImportItemsDialog
        onClose={() => setImporting(false)}
        onImported={() => setRefreshKey((k) => k + 1)}
      />
    )}
    </>
  )
}
