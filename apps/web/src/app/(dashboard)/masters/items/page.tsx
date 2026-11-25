'use client'

import { Suspense, useCallback, useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import Link from 'next/link'
import { AlertTriangle, FileSpreadsheet, Layers, Package, Settings2, Shirt } from 'lucide-react'
import { ITEM_GROUP_TYPES, typeFitsGroup, type ItemGroup } from '@ld-erp/shared'
import { ImportItemsDialog } from '@/components/masters/ImportItemsDialog'
import { BuyUnitsDialog, type BuyUnit } from '@/components/masters/BuyUnitsDialog'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'
import { ActiveBadge, MasterTable, type Column, type FilterDef } from '@/components/masters/MasterTable'
import type { FormField } from '@/components/masters/MasterFormDialog'
import { ITEM_TYPE_LABEL as TYPE_LABEL, itemFormFields } from '@/components/masters/itemFormFields'
import { isProcessDepartment } from '@/components/masters/processDepartments'

/*
 * Masters → Items & Products, in three tabs: Raw Materials, Semi-Finished
 * Goods and Finished Goods. A main category says which tab it is under. Inside
 * a tab its categories run in the order the floor uses them (Fabric for
 * cutting first, packing last), each with its sub-categories, and every one
 * says how many items it holds.
 */

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

type Tab = 'RAW_MATERIALS' | 'SEMI_FINISHED' | 'FINISHED_GOODS'

const TABS: Array<{ key: Tab; slug: string; label: string; hint: string; icon: typeof Package }> = [
  { key: 'RAW_MATERIALS', slug: 'raw', label: 'Raw Materials', hint: 'Fabric, thread, trims, labels, packing', icon: Package },
  { key: 'SEMI_FINISHED', slug: 'semi', label: 'Semi-Finished Goods', hint: 'Cut panels and parts between processes', icon: Layers },
  { key: 'FINISHED_GOODS', slug: 'finished', label: 'Finished Goods', hint: 'Garments, by style and colour', icon: Shirt },
]

/** What GET /masters/items/groups sends: each tab, its categories in floor order, counted. */
interface Process {
  id: string
  name: string
}
interface SubCategory {
  id: string
  name: string
  isActive: boolean
  process: Process | null
  count: number
}
interface MainCategory {
  id: string
  name: string
  itemGroup: ItemGroup
  isActive: boolean
  process: Process | null
  processes: Process[]
  /** Items filed on the category itself, not in one of its sub-categories. */
  direct: number
  total: number
  subs: SubCategory[]
}
interface GroupTree {
  group: Tab
  label: string
  count: number
  categories: MainCategory[]
}

/** Filed on the main category itself, with sub-categories there to pick: the chip for those. */
const DIRECT = 'direct'

const muted = <span className="text-muted-foreground">—</span>

/** The list's columns for one tab: a type only where a tab takes several, a style only for finished goods. */
function columnsFor(
  tab: Tab,
  categoryPicked: boolean,
  mainsWithSubs: Set<string>,
  toReorder: Map<string, number>,
  onBuyUnits: (item: Item) => void,
): Column<Item>[] {
  const finished = tab === 'FINISHED_GOODS'
  return [
    // A code is one token; broken over two lines it reads as two.
    { key: 'code', header: 'Code', sortable: true, className: 'whitespace-nowrap font-mono text-xs text-teal-400' },
    { key: 'name', header: 'Item', sortable: true, className: 'min-w-56 font-medium' },
    ...(tab === 'RAW_MATERIALS'
      ? [
          {
            key: 'type',
            header: 'Type',
            render: (i: Item) => {
              const t = TYPE_LABEL[i.type] ?? { label: i.type, cls: 'badge-neutral' }
              return <span className={cn(t.cls, 'whitespace-nowrap')}>{t.label}</span>
            },
          },
        ]
      : []),
    ...(finished
      ? [
          {
            key: 'style',
            header: 'Style · Colour',
            render: (i: Item) =>
              i.style ? (
                <span className="text-xs">
                  <span className="font-mono text-teal-400">{i.style.code}</span>
                  {i.color && <span className="text-muted-foreground"> · {i.color}</span>}
                </span>
              ) : (
                <span className="text-xs text-amber-400">Style not set</span>
              ),
          },
        ]
      : []),
    // Where it is filed. With a category picked the sub-category is enough;
    // across the whole tab it reads "Fabric › Cotton". One filed on a main
    // category that has sub-categories is pointed out, to be put in one.
    {
      key: 'category',
      header: categoryPicked ? 'Subcategory' : 'Category',
      render: (i) => {
        const c = i.category
        if (!c) return muted
        const misfiled = !typeFitsGroup(i.type, tab) && (
          <span
            className="ml-1.5 inline-flex items-center gap-1 text-[11px] text-amber-400"
            title={`A ${TYPE_LABEL[i.type]?.label.toLowerCase() ?? i.type} under ${c.parent?.name ?? c.name}: change its type or move it`}
          >
            <AlertTriangle size={11} /> type does not fit
          </span>
        )
        if (!c.parent) {
          return (
            <span className="whitespace-nowrap">
              {categoryPicked ? muted : c.name}
              {mainsWithSubs.has(c.id) && (
                <span className="ml-1.5 inline-flex items-center gap-1 text-[11px] text-amber-400" title="Edit the item to put it in one of this category's subcategories">
                  <AlertTriangle size={11} /> no subcategory
                </span>
              )}
              {misfiled}
            </span>
          )
        }
        return (
          <span className="whitespace-nowrap">
            {!categoryPicked && <span className="text-muted-foreground">{c.parent.name} › </span>}
            {c.name}
            {misfiled}
          </span>
        )
      },
    },
    // The process that uses it: the column the list is most often read by.
    { key: 'department', header: 'Process', render: (i) => i.department?.name ?? muted },
    {
      key: 'uom',
      header: 'Unit',
      render: (i) =>
        i.uom ? (
          <span className="text-muted-foreground text-xs" title={i.uom.name}>
            {i.uom.symbol}
          </span>
        ) : (
          muted
        ),
    },
    // The packs it is bought in (a box of 20 pcs); the store still counts the item's own unit.
    ...(finished
      ? []
      : [
          {
            key: 'buyUnits',
            header: 'Bought in',
            render: (i: Item) => (
              <button
                type="button"
                className="whitespace-nowrap text-left text-xs hover:underline"
                onClick={(e) => {
                  e.stopPropagation()
                  onBuyUnits(i)
                }}
                title={i.buyUnits?.length ? 'The packs it is bought in, and what each holds' : 'Bought loose, in its own unit. Click to add a pack (1 Box = 20 pcs)'}
              >
                {i.buyUnits?.length ? (
                  <span className="text-foreground">
                    {i.buyUnits
                      .map((u) => `${u.uom.symbol} of ${Number(u.factor).toLocaleString('en-IN')}${u.isDefault ? ' (usual)' : ''}`)
                      .join(' · ')}
                  </span>
                ) : (
                  <span className="text-muted-foreground hover:text-primary">Loose</span>
                )}
              </button>
            ),
          },
        ]),
    // What GST an order or bill fills in for this item, and where that comes
    // from: the HSN list, or the item's own rate for a code not listed yet.
    {
      key: 'gst',
      header: 'HSN · GST',
      render: (i) =>
        i.hsnCode || i.taxRate ? (
          <span
            className="whitespace-nowrap text-xs tabular-nums"
            title={
              i.taxRateSource === 'HSN'
                ? `From HSN ${i.hsn?.code} in the HSN list`
                : i.taxRate
                  ? 'Set on the item — its HSN code is not in the HSN list yet'
                  : undefined
            }
          >
            <span className="text-muted-foreground font-mono">{i.hsnCode ?? '—'}</span>
            {i.taxRate && <span className="ml-1.5">{Number(i.taxRate.rate)}%</span>}
          </span>
        ) : (
          muted
        ),
    },
    {
      key: 'standardRate',
      header: 'Std. Rate',
      align: 'right',
      sortable: true,
      render: (i) => (i.standardRate ? <span className="whitespace-nowrap font-semibold">{rate(Number(i.standardRate))}</span> : muted),
    },
    ...(finished
      ? []
      : [
          {
            key: 'reorderLevel',
            header: 'Reorder At',
            align: 'right' as const,
            render: (i: Item) =>
              i.reorderLevel ? (
                <span
                  className={cn(
                    'inline-flex items-center gap-1 whitespace-nowrap text-xs',
                    toReorder.has(i.id) && 'font-semibold text-amber-500',
                  )}
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
                muted
              ),
          },
        ]),
    { key: 'isActive', header: 'Status', render: (i) => <ActiveBadge isActive={i.isActive} /> },
  ]
}

/** Beside the search: the type where a tab takes several, the process, the unit. */
function filtersFor(tab: Tab): FilterDef[] {
  const types = ITEM_GROUP_TYPES[tab] ?? []
  return [
    ...(types.length > 1
      ? [
          {
            key: 'type',
            label: 'Type',
            facet: 'type',
            options: types.map((value) => ({ value, label: TYPE_LABEL[value]?.label ?? value })),
          },
        ]
      : []),
    {
      key: 'departmentId',
      label: 'Process',
      facet: 'departmentId',
      noneLabel: 'No process',
      // Processes only: not Accounts, HR & Admin or Store.
      optionsFrom: { resource: 'departments', filter: isProcessDepartment },
    },
    {
      key: 'uomId',
      label: 'Unit',
      facet: 'uomId',
      optionsFrom: { resource: 'uoms', label: (r) => `${r.name} (${r.symbol})` },
    },
  ]
}

/**
 * The item form, opened from a tab: a new item starts as that tab's type, in
 * the category and sub-category being looked at. Any type can still be picked
 * (a finished good added from Raw Materials), and the category list follows it.
 */
function formFor(tab: Tab, mainId: string, subId: string, mains: MainCategory[]): FormField[] {
  const types = ITEM_GROUP_TYPES[tab] ?? []
  const main = mainId || (mains.length === 1 ? mains[0].id : '')
  return itemFormFields.map((f) => {
    if (f.name === 'type') return { ...f, valueForNew: types[0] }
    if (f.name === 'mainCategoryId') return { ...f, valueForNew: main || undefined }
    if (f.name === 'subCategoryId') {
      return { ...f, valueForNew: subId && subId !== DIRECT ? subId : undefined }
    }
    return f
  })
}

const EMPTY: Record<Tab, string> = {
  RAW_MATERIALS: 'No raw materials here yet. Add fabric, thread, buttons and other materials.',
  SEMI_FINISHED: 'No semi-finished items yet. Cut panels and parts go here when they are kept in stock between processes.',
  FINISHED_GOODS: 'No finished goods here yet. Each one is a style in one colour.',
}

export default function ItemsPage() {
  return (
    <Suspense>
      <Items />
    </Suspense>
  )
}

function Items() {
  const params = useSearchParams()
  const [tab, setTab] = useState<Tab>(() => TABS.find((t) => t.slug === params.get('tab'))?.key ?? 'RAW_MATERIALS')
  const [mainId, setMainId] = useState(params.get('category') ?? '')
  const [subId, setSubId] = useState(params.get('sub') ?? '')

  // The tab, category and sub-category are kept in the address, so a refresh
  // or a shared link opens the same view.
  const go = useCallback((next: { tab?: Tab; main?: string; sub?: string }) => {
    const t = next.tab ?? tab
    const m = next.main ?? (next.tab ? '' : mainId)
    const s = next.sub ?? (next.tab || next.main !== undefined ? '' : subId)
    setTab(t)
    setMainId(m)
    setSubId(s)
    const url = new URL(window.location.href)
    url.search = ''
    url.searchParams.set('tab', TABS.find((x) => x.key === t)!.slug)
    if (m) url.searchParams.set('category', m)
    if (s) url.searchParams.set('sub', s)
    window.history.replaceState(null, '', url)
  }, [tab, mainId, subId])

  // The tabs' figures follow the same "Active only" tick as the list.
  const [activeOnly, setActiveOnly] = useState(true)
  const [tree, setTree] = useState<GroupTree[] | null>(null)
  const [treeKey, setTreeKey] = useState(0)
  useEffect(() => {
    let alive = true
    api
      .get<{ data: { groups: GroupTree[] } }>(`/masters/items/groups?active=${activeOnly}`)
      .then((r) => alive && setTree(r.data.groups))
      .catch(() => alive && setTree([]))
    return () => {
      alive = false
    }
  }, [activeOnly, treeKey])

  // Which items need reordering, by the same rule as the stock screen. Someone
  // without access to stock simply sees no warnings.
  const [toReorder, setToReorder] = useState<Map<string, number>>(new Map())
  useEffect(() => {
    api
      .get<{ data: Array<{ itemId: string; onHand: number }> }>('/inventory/reorder')
      .then((res) => setToReorder(new Map(res.data.map((r) => [r.itemId, r.onHand]))))
      .catch(() => {})
  }, [])

  // The "Bought in" window, for one item's packs, and the spreadsheet import.
  const [packsOf, setPacksOf] = useState<Item | null>(null)
  const [importing, setImporting] = useState(false)
  const [refreshKey, setRefreshKey] = useState(0)
  const reloadAll = () => {
    setRefreshKey((k) => k + 1)
    setTreeKey((k) => k + 1)
  }

  const groupTree = tree?.find((g) => g.group === tab)
  const mains = groupTree?.categories ?? []
  const main = mains.find((m) => m.id === mainId)
  // A tab with one category (Finished Goods → Shirts, Trousers) goes straight
  // to its sub-categories: a lone chip repeating the tab's name says nothing.
  const single = mains.length === 1 ? mains[0] : null
  const mainsWithSubs = useMemo(() => new Set((tree ?? []).flatMap((g) => g.categories.filter((m) => m.subs.length).map((m) => m.id))), [tree])

  // The list asks for this tab, narrowed to the category or sub-category picked.
  const filters = useMemo(() => {
    const f: Record<string, string> = { group: tab }
    if (mainId && subId === DIRECT) f.subCategoryId = mainId
    else if (subId) f.subCategoryId = subId
    else if (mainId) f.categoryId = mainId
    return f
  }, [tab, mainId, subId])

  const columns = useMemo(
    () => columnsFor(tab, Boolean(mainId || single), mainsWithSubs, toReorder, setPacksOf),
    [tab, mainId, single, mainsWithSubs, toReorder],
  )
  const filterDefs = useMemo(() => filtersFor(tab), [tab])
  const formFields = useMemo(() => formFor(tab, mainId, subId, mains), [tab, mainId, subId, mains])

  const tabs = (
    <div className="glass-card space-y-4 p-4">
      {/* The three groups. */}
      <div className="grid gap-2 sm:grid-cols-3" role="tablist" aria-label="Item groups">
        {TABS.map((t) => {
          const on = t.key === tab
          const count = tree?.find((g) => g.group === t.key)?.count
          return (
            <button
              key={t.key}
              type="button"
              role="tab"
              aria-selected={on}
              onClick={() => go({ tab: t.key })}
              className={cn(
                'flex items-center gap-3 rounded-xl border px-4 py-3 text-left transition-colors',
                on ? 'border-primary bg-primary/10' : 'border-border hover:bg-secondary',
              )}
            >
              <span className={cn('rounded-lg p-2', on ? 'bg-primary/15 text-primary' : 'bg-secondary text-muted-foreground')}>
                <t.icon size={18} />
              </span>
              <span className="min-w-0 flex-1">
                <span className={cn('block text-sm font-semibold', on ? 'text-primary' : 'text-foreground')}>{t.label}</span>
                <span className="text-muted-foreground block truncate text-xs">{t.hint}</span>
              </span>
              <span className={cn('text-lg font-semibold tabular-nums', on ? 'text-primary' : 'text-foreground')}>
                {count ?? '…'}
              </span>
            </button>
          )
        })}
      </div>

      {/* Its categories, in the order the floor uses them; or, for a tab with
          one category, that category's sub-categories. */}
      <div className="flex flex-wrap items-center gap-2">
        <Chip on={!mainId} onClick={() => go({ main: '' })} label="All" count={groupTree?.count} />
        {single
          ? [
              ...single.subs.map((s) => (
                <Chip
                  key={s.id}
                  on={s.id === subId}
                  onClick={() => go({ main: single.id, sub: s.id })}
                  label={s.name}
                  note={s.process?.name}
                  count={s.count}
                  dim={!s.isActive}
                />
              )),
              single.direct > 0 && single.subs.length > 0 && (
                <Chip
                  key={DIRECT}
                  warn
                  on={subId === DIRECT}
                  onClick={() => go({ main: single.id, sub: DIRECT })}
                  label="No subcategory"
                  count={single.direct}
                />
              ),
            ]
          : mains.map((m) => (
              <Chip
                key={m.id}
                on={m.id === mainId}
                onClick={() => go({ main: m.id })}
                label={m.name}
                note={m.processes.map((p) => p.name).join(' · ')}
                count={m.total}
                dim={!m.isActive}
              />
            ))}
        <Link
          href={`/masters/item-categories?group=${TABS.find((t) => t.key === tab)!.slug}`}
          className="text-muted-foreground hover:text-foreground ml-auto inline-flex items-center gap-1 text-xs"
          title="Add, rename or move categories and subcategories"
        >
          <Settings2 size={13} /> Manage categories
        </Link>
      </div>

      {/* The picked category's sub-categories. */}
      {main && !single && (main.subs.length > 0 || main.direct > 0) && (
        <div className="border-border flex flex-wrap items-center gap-2 border-t pt-3">
          <span className="text-muted-foreground mr-1 text-xs font-medium">{main.name}</span>
          <Chip small on={!subId} onClick={() => go({ sub: '' })} label="All" count={main.total} />
          {/* A sub-category names its process only where it differs from the category's. */}
          {main.subs.map((s) => (
            <Chip
              key={s.id}
              small
              on={s.id === subId}
              onClick={() => go({ sub: s.id })}
              label={s.name}
              note={main.processes.length > 1 ? s.process?.name : undefined}
              count={s.count}
              dim={!s.isActive}
            />
          ))}
          {main.direct > 0 && main.subs.length > 0 && (
            <Chip small warn on={subId === DIRECT} onClick={() => go({ sub: DIRECT })} label="No subcategory" count={main.direct} />
          )}
        </div>
      )}
    </div>
  )

  return (
    <>
      <MasterTable<Item>
        title="Items & Products"
        entityName="Item"
        resource="items"
        columns={columns}
        formFields={formFields}
        formColumns={4}
        filters={filters}
        refreshKey={refreshKey}
        onChanged={() => setTreeKey((k) => k + 1)}
        onActiveOnlyChange={setActiveOnly}
        subHeader={tabs}
        actions={
          <button type="button" className="btn-secondary" onClick={() => setImporting(true)}>
            <FileSpreadsheet size={16} /> Import
          </button>
        }
        filterDefs={filterDefs}
        defaultSort="name"
        searchPlaceholder="Search name, code, HSN, category, process..."
        emptyMessage={EMPTY[tab]}
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
      {importing && <ImportItemsDialog onClose={() => setImporting(false)} onImported={reloadAll} />}
    </>
  )
}

/** One category or sub-category to pick, with how many items it holds and its process. */
function Chip({
  on,
  onClick,
  label,
  note,
  count,
  small = false,
  warn = false,
  dim = false,
}: {
  on: boolean
  onClick: () => void
  label: string
  note?: string
  count?: number
  small?: boolean
  warn?: boolean
  dim?: boolean
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={on}
      title={dim ? `${label} is switched off` : note ? `${label} · ${note}` : label}
      className={cn(
        'inline-flex items-center gap-2 rounded-full border transition-colors',
        small ? 'px-2.5 py-1 text-xs' : 'px-3 py-1.5 text-sm',
        on
          ? 'border-primary bg-primary text-primary-foreground'
          : warn
            ? 'border-amber-500/40 text-amber-400 hover:bg-amber-500/10'
            : 'border-border text-foreground hover:bg-secondary',
        dim && !on && 'opacity-60',
      )}
    >
      <span className="font-medium">{label}</span>
      {note && !small && <span className={cn('text-[11px]', on ? 'text-primary-foreground/80' : 'text-muted-foreground')}>{note}</span>}
      {note && small && <span className={cn('text-[10px]', on ? 'text-primary-foreground/80' : 'text-muted-foreground')}>{note}</span>}
      {count !== undefined && (
        <span
          className={cn(
            'rounded-full px-1.5 text-[11px] font-semibold tabular-nums',
            on ? 'bg-primary-foreground/20 text-primary-foreground' : 'bg-secondary text-muted-foreground',
          )}
        >
          {count}
        </span>
      )}
    </button>
  )
}
