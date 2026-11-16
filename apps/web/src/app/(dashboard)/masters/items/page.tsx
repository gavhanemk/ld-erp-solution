'use client'

import { useEffect, useMemo, useState } from 'react'
import { AlertTriangle, FileSpreadsheet } from 'lucide-react'
import { ImportItemsDialog } from '@/components/masters/ImportItemsDialog'
import { BuyUnitsDialog, type BuyUnit } from '@/components/masters/BuyUnitsDialog'
import { api } from '@/lib/api'
import { ActiveBadge, MasterTable, type Column, type FilterDef } from '@/components/masters/MasterTable'
import { ITEM_TYPE_LABEL as TYPE_LABEL, itemFormFields as formFields } from '@/components/masters/itemFormFields'

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
  /** The packs it is bought in besides its own unit (1 Box = 20 pcs). */
  buyUnits?: BuyUnit[]
  /** The GST the item is filled in at: its HSN code's rate when the code is listed, else its own. */
  taxRate: { rate: string | number } | null
  taxRateSource: 'HSN' | 'ITEM' | null
  hsn: { code: string } | null
  styleId: string | null
  color: string | null
  style: { id: string; code: string; name: string; colors: string[] } | null
}

/**
 * The list's columns. `toReorder` is the items that need reordering, by id,
 * with their stock: the warning shows on those and no others. It used to show
 * on every item that had a reorder level, whatever its stock.
 */
const columnsFor = (toReorder: Map<string, number>, onBuyUnits: (item: Item) => void): Column<Item>[] => [
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
  // The packs it is bought in (a box of 20 pcs); the store still counts the item's own unit.
  {
    key: 'buyUnits',
    header: 'Bought in',
    render: (i) =>
      i.type === 'FINISHED_GOOD' ? (
        <span className="text-muted-foreground">—</span>
      ) : (
        <button
          type="button"
          className="text-left text-xs hover:underline"
          onClick={(e) => {
            e.stopPropagation()
            onBuyUnits(i)
          }}
          title="The packs it is bought in, and what each holds"
        >
          {i.buyUnits?.length ? (
            <span className="text-foreground">
              {i.buyUnits.map((u) => `${u.uom.symbol} of ${Number(u.factor).toLocaleString('en-IN')}${u.isDefault ? ' (usual)' : ''}`).join(' · ')}
            </span>
          ) : (
            <span className="text-primary">{i.uom?.symbol ?? 'Own unit'} · add a pack</span>
          )}
        </button>
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
  // The "Bought in" window, for one item's packs.
  const [packsOf, setPacksOf] = useState<Item | null>(null)
  const columns = useMemo(() => columnsFor(toReorder, setPacksOf), [toReorder])

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
    {packsOf && (
      <BuyUnitsDialog
        item={packsOf}
        onClose={() => setPacksOf(null)}
        onSaved={() => {
          setPacksOf(null)
          setRefreshKey((k) => k + 1)
        }}
      />
    )}
    {importing && (
      <ImportItemsDialog
        onClose={() => setImporting(false)}
        onImported={() => setRefreshKey((k) => k + 1)}
      />
    )}
    </>
  )
}
