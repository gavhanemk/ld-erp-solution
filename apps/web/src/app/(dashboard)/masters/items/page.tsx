'use client'

import { AlertTriangle } from 'lucide-react'
import { ActiveBadge, MasterTable, type Column } from '@/components/masters/MasterTable'
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

export default function ItemsPage() {
  return (
    <MasterTable<Item>
      title="Items"
      resource="items"
      columns={columns}
      defaultSort="name"
      searchPlaceholder="Search name, code, HSN, description..."
      emptyMessage="No items yet. Add fabric, thread, buttons and other materials here."
    />
  )
}
