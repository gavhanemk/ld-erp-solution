'use client'

import { Fragment, Suspense, useCallback, useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import Link from 'next/link'
import {
  AlertCircle,
  Ban,
  ChevronDown,
  ChevronRight,
  ChevronsDownUp,
  ChevronsUpDown,
  ExternalLink,
  FileSpreadsheet,
  Layers,
  LayoutGrid,
  Loader2,
  Package,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Shirt,
  Trash2,
  X,
} from 'lucide-react'
import { ITEM_GROUP_TYPES } from '@ld-erp/shared'
import { api, ApiError, can, masterResource, type Paginated } from '@/lib/api'
import { cn } from '@/lib/utils'
import { ActiveBadge } from '@/components/masters/MasterTable'
import { MasterFormDialog, type FormField } from '@/components/masters/MasterFormDialog'
import { DeleteDialog } from '@/components/masters/DeleteDialog'
import { ImportCategoriesDialog } from '@/components/masters/ImportCategoriesDialog'
import { ITEM_TYPE_LABEL, itemFormFields } from '@/components/masters/itemFormFields'
import { SmartSelect } from '@/components/ui/SmartSelect'
import { processOrChosen } from '@/components/masters/processDepartments'
import { createHsnFrom } from '@/components/masters/hsnFormFields'

/**
 * Item categories: the three categories — Raw Materials, Semi-Finished Goods
 * and Finished Goods — side by side at the top, and All. Picking one shows
 * only its sub-categories (Fabric, Thread, Cut Panels, Shirts…), so nobody
 * scrolls past the other two; All shows the three, one under another. Each
 * sub-category opens onto the items filed in it.
 *
 * The three are fixed. What is added, edited, switched off or deleted here is
 * the sub-categories, each with the process that uses it, and the items in them.
 *
 * A sub-category also decides item codes: an item takes its prefix from it, so
 * a cotton poplin filed under Fabric becomes FAB-011, and a store keeper
 * searching "FAB" finds it.
 *
 * The expense heads keep a category of their own, managed on the Expense Heads
 * screen, so it is not shown here.
 */

type Group = 'RAW_MATERIALS' | 'SEMI_FINISHED' | 'FINISHED_GOODS'
const GROUPS: Group[] = ['RAW_MATERIALS', 'SEMI_FINISHED', 'FINISHED_GOODS']

const SECTIONS: Array<{ key: Group; slug: string; label: string; hint: string; icon: typeof Package }> = [
  { key: 'RAW_MATERIALS', slug: 'raw', label: 'Raw Materials', hint: 'Fabric, thread, trims, labels, packing', icon: Package },
  { key: 'SEMI_FINISHED', slug: 'semi', label: 'Semi-Finished Goods', hint: 'Cut panels and parts between processes', icon: Layers },
  { key: 'FINISHED_GOODS', slug: 'finished', label: 'Finished Goods', hint: 'Garments, by style and colour', icon: Shirt },
]

/** What is shown: one of the three, or all of them. */
type Shown = Group | 'ALL'
const TOGGLES: Array<{ key: Shown; slug: string; label: string; icon: typeof Package }> = [
  { key: 'ALL', slug: 'all', label: 'All', icon: LayoutGrid },
  ...SECTIONS.map(({ key, slug, label, icon }) => ({ key, slug, label, icon })),
]

interface Category {
  id: string
  name: string
  parentId: string | null
  parent?: { id: string; name: string } | null
  departmentId?: string | null
  department?: { id: string; name: string } | null
  itemGroup: string
  isActive: boolean
  trackPackages?: boolean
  packType?: string | null
}

interface ItemRow {
  id: string
  code: string
  name: string
  type: string
  categoryId: string
  isActive: boolean
  standardRate: string | number | null
  uom: { symbol: string; name: string } | null
  department?: { name: string } | null
  style?: { code: string } | null
  color?: string | null
}

/** What GET /masters/items/groups sends, as much as this page needs: item counts. */
interface GroupTree {
  group: Group
  count: number
  categories: Array<{ id: string; direct: number; subs: Array<{ id: string; count: number }> }>
}

/** A sub-category's items, as loaded when it is opened. */
type Loaded = { rows: ItemRow[]; total: number } | 'loading' | { error: string }

const rate = (n: number) =>
  `₹${n.toLocaleString('en-IN', { minimumFractionDigits: Number.isInteger(n) ? 0 : 2, maximumFractionDigits: 2 })}`

/** The sub-category form: the category it goes under, its name, its process, how its stock is stickered. */
const categoryFields: FormField[] = [
  {
    name: 'parentId',
    label: 'Category',
    type: 'select',
    required: true,
    span: 2,
    optionsFrom: { resource: 'item-categories', filter: (row) => !row.parentId && row.itemGroup !== 'EXPENSES' },
    help: 'Raw Materials, Semi-Finished Goods or Finished Goods.',
  },
  {
    name: 'name',
    label: 'Subcategory name',
    required: true,
    span: 2,
    help: 'For example Fabric under Raw Materials, or Shirts under Finished Goods.',
  },
  {
    name: 'departmentId',
    label: 'Process',
    type: 'select',
    // Processes only — not Accounts, HR & Admin or Store.
    optionsFrom: { resource: 'departments', filter: processOrChosen('departmentId') },
    span: 2,
    help: 'The process that normally uses what is filed here. A new item in it starts with this.',
  },
  // Stock of these items is labelled with QR stickers and issued by scanning.
  {
    name: 'trackPackages',
    label: 'Track by package',
    type: 'checkbox',
    checkedForNew: true,
    placeholder: 'QR sticker on each package',
    help: 'Stickers are made after every inward of items filed here.',
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
    name: 'hsnCode',
    label: 'HSN Code',
    placeholder: '52081200',
    // Offered from the HSN list as you type, with each code's GST beside it.
    suggestFrom: {
      resource: 'hsn-codes',
      valueKey: 'code',
      label: (r) => `${String(r.description ?? '')} · GST ${Number(r.gstRate)}%`,
      notListed: (code) => `${code} is not in Masters → HSN / SAC Codes yet, so it carries no GST rate.`,
    },
    createFrom: createHsnFrom,
    showIf: (v) => Boolean(v.parentId),
    help: 'An item made under it from an opening stock sheet takes this code, and its GST from Masters → HSN / SAC Codes.',
  },
  { name: 'isActive', label: 'Active', type: 'checkbox', placeholder: 'Offered when filing an item' },
]

export default function ItemCategoriesPage() {
  return (
    <Suspense>
      <ItemCategories />
    </Suspense>
  )
}

function ItemCategories() {
  const params = useSearchParams()
  // The one category shown, or All. Raw Materials to start with. Kept in the
  // address (?group=finished), so a refresh, or "Manage categories" on Items &
  // Products, shows the same one.
  const [selected, setSelected] = useState<Shown>(() => TOGGLES.find((t) => t.slug === params.get('group'))?.key ?? 'RAW_MATERIALS')
  const choose = useCallback((next: Shown) => {
    setSelected(next)
    const url = new URL(window.location.href)
    url.searchParams.set('group', TOGGLES.find((t) => t.key === next)!.slug)
    window.history.replaceState(null, '', url)
  }, [])
  const shownGroups = useMemo<Group[]>(() => (selected === 'ALL' ? GROUPS : [selected]), [selected])
  const [openSubs, setOpenSubs] = useState<Set<string>>(new Set())

  const [activeOnly, setActiveOnly] = useState(true)
  const [process, setProcess] = useState('')
  const [search, setSearch] = useState('')
  const [term, setTerm] = useState('')
  useEffect(() => {
    const t = setTimeout(() => setTerm(search.trim()), 300)
    return () => clearTimeout(t)
  }, [search])

  const [reloadKey, setReloadKey] = useState(0)
  const reload = () => setReloadKey((k) => k + 1)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  // The categories and sub-categories, and how many items each holds.
  const [categories, setCategories] = useState<Category[]>([])
  const [tree, setTree] = useState<GroupTree[]>([])
  const [departments, setDepartments] = useState<Array<{ id: string; name: string }>>([])
  useEffect(() => {
    let alive = true
    setLoading(true)
    Promise.all([
      api.get<Paginated<Category>>(
        `/masters/item-categories?limit=200&sort=name&order=asc&itemGroup=${GROUPS.join(',')}${activeOnly ? '&active=true' : ''}`,
      ),
      api.get<{ data: { groups: GroupTree[] } }>(`/masters/items/groups?active=${activeOnly}`),
    ])
      .then(([cats, counts]) => {
        if (!alive) return
        setCategories(cats.data)
        setTree(counts.data.groups)
        setError(null)
      })
      .catch((err) => alive && setError(err instanceof ApiError ? err.message : 'Could not load the categories. Is the API running?'))
      .finally(() => alive && setLoading(false))
    return () => {
      alive = false
    }
  }, [activeOnly, reloadKey])
  useEffect(() => {
    api
      // The processes, for the Process filter: not Accounts, HR & Admin or Store.
      .get<Paginated<{ id: string; name: string }>>('/masters/departments?limit=200&active=true&process=true&sort=name&order=asc')
      .then((r) => setDepartments(r.data))
      .catch(() => {})
  }, [])

  const itemsIn = useMemo(() => {
    const m = new Map<string, number>()
    for (const g of tree) for (const c of g.categories) {
      m.set(c.id, c.direct)
      for (const s of c.subs) m.set(s.id, s.count)
    }
    return m
  }, [tree])

  const mains = useMemo(() => categories.filter((c) => !c.parentId), [categories])
  const mainIds = useMemo(() => new Set(mains.map((m) => m.id)), [mains])
  // Sub-categories in the order the floor uses them, as Items & Products shows
  // them: Fabric (cutting) first, Packing Material last. One the counts do not
  // carry (switched off and empty) goes after, by name.
  const floorOrder = useMemo(() => {
    const m = new Map<string, number>()
    for (const g of tree) for (const c of g.categories) c.subs.forEach((s, i) => m.set(s.id, i))
    return m
  }, [tree])
  const subsOf = useCallback(
    (mainId: string) =>
      categories
        .filter((c) => c.parentId === mainId)
        .sort((a, b) => (floorOrder.get(a.id) ?? 999) - (floorOrder.get(b.id) ?? 999) || a.name.localeCompare(b.name)),
    [categories, floorOrder],
  )
  /** Old sub-categories folded into a sub-category in the move to three categories; shown with "Active only" off. */
  const foldedInto = useCallback(
    (subId: string) => categories.filter((c) => c.parentId === subId && !mainIds.has(c.parentId)),
    [categories, mainIds],
  )

  // Searching also looks through the items of what is shown: a sub-category
  // holding a match shows, opened onto the matching items.
  const [matches, setMatches] = useState<Map<string, ItemRow[]> | null>(null)
  useEffect(() => {
    if (term.length < 2) {
      setMatches(null)
      return
    }
    let alive = true
    api
      .get<Paginated<ItemRow>>(
        `/masters/items?q=${encodeURIComponent(term)}&limit=200&sort=name&order=asc&group=${shownGroups.join(',')}${activeOnly ? '&active=true' : ''}`,
      )
      .then((r) => {
        if (!alive) return
        const m = new Map<string, ItemRow[]>()
        for (const i of r.data) m.set(i.categoryId, [...(m.get(i.categoryId) ?? []), i])
        setMatches(m)
      })
      .catch(() => alive && setMatches(new Map()))
    return () => {
      alive = false
    }
  }, [term, activeOnly, reloadKey, shownGroups])

  // A sub-category's items, read when it is opened.
  const [itemsOf, setItemsOf] = useState<Record<string, Loaded>>({})
  const loadItems = useCallback(
    async (categoryId: string) => {
      setItemsOf((m) => ({ ...m, [categoryId]: 'loading' }))
      try {
        const r = await api.get<Paginated<ItemRow>>(
          `/masters/items?subCategoryId=${categoryId}&limit=200&sort=name&order=asc${activeOnly ? '&active=true' : ''}`,
        )
        setItemsOf((m) => ({ ...m, [categoryId]: { rows: r.data, total: r.pagination.total } }))
      } catch (err) {
        setItemsOf((m) => ({ ...m, [categoryId]: { error: err instanceof ApiError ? err.message : 'Could not load the items.' } }))
      }
    },
    [activeOnly],
  )
  // Anything that changes what is shown reads the open ones again.
  useEffect(() => {
    setItemsOf({})
    openSubs.forEach((id) => void loadItems(id))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeOnly, reloadKey])

  const toggleSub = (id: string) => {
    setOpenSubs((s) => {
      const next = new Set(s)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
    if (!openSubs.has(id) && !itemsOf[id]) void loadItems(id)
  }

  // What the search and the process leave showing.
  const t = term.toLowerCase()
  const searching = t.length > 0
  const shows = (s: Category) =>
    (!process || (process === 'none' ? !s.departmentId : s.departmentId === process)) &&
    (!searching ||
      s.name.toLowerCase().includes(t) ||
      (s.department?.name ?? '').toLowerCase().includes(t) ||
      Boolean(matches?.get(s.id)?.length))

  // Dialogs.
  const [categoryForm, setCategoryForm] = useState<{ record: Category | null; parentId?: string } | null>(null)
  const [itemForm, setItemForm] = useState<{ record: ItemRow | null; init?: Record<string, unknown> } | null>(null)
  const [deleting, setDeleting] = useState<Category | null>(null)
  const [importing, setImporting] = useState(false)
  const mayCreate = can('masters', 'create')
  const mayEdit = can('masters', 'edit')
  const mayDelete = can('masters', 'delete')

  const deactivate = async (c: Category) => {
    if (
      !window.confirm(
        `Deactivate ${c.name}?\n\nIt stays in the system and on past documents, but stops being offered when filing an item. You can reactivate it later by editing it.`,
      )
    ) {
      return
    }
    setError(null)
    try {
      await masterResource('item-categories').deactivate(c.id)
      setNotice(`${c.name} is switched off.`)
      reload()
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not deactivate. Is the API running?')
    }
  }

  const addItem = (group: Group, mainId: string, sub?: Category) =>
    setItemForm({
      record: null,
      init: { type: ITEM_GROUP_TYPES[group]?.[0], mainCategoryId: mainId, subCategoryId: sub?.id },
    })

  const totals = useMemo(() => {
    const subs = categories.filter((c) => c.parentId && mainIds.has(c.parentId) && c.isActive).length
    const items = tree.reduce((n, g) => n + g.count, 0)
    return { subs, items }
  }, [categories, mainIds, tree])
  const countsOf = (g: Group) => {
    const main = mains.find((m) => m.itemGroup === g)
    return {
      subs: main ? subsOf(main.id).filter((s) => s.isActive).length : 0,
      items: tree.find((x) => x.group === g)?.count ?? 0,
    }
  }
  const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`

  /** Every sub-category shown, opened onto its items. */
  const expandAll = () => {
    const ids = SECTIONS.filter((s) => shownGroups.includes(s.key)).flatMap((s) => {
      const main = mains.find((m) => m.itemGroup === s.key)
      return main ? subsOf(main.id).filter(shows).map((x) => x.id) : []
    })
    setOpenSubs(new Set(ids))
    ids.forEach((id) => {
      if (!itemsOf[id]) void loadItems(id)
    })
  }

  return (
    <div className="space-y-6">
      <div className="page-header">
        <div>
          <h1 className="page-title">Item Categories</h1>
          <p className="page-subtitle">
            {loading && categories.length === 0
              ? 'Loading...'
              : `3 categories · ${totals.subs} subcategories · ${totals.items} items`}
          </p>
        </div>
        <div className="flex items-center gap-3">
          <button onClick={reload} className="btn-secondary" title="Refresh">
            <RefreshCw size={16} className={loading ? 'animate-spin' : ''} />
            Refresh
          </button>
          <button type="button" className="btn-secondary" onClick={() => setImporting(true)}>
            <FileSpreadsheet size={16} /> Import
          </button>
          {mayCreate && (
            <button
              type="button"
              className="btn-primary"
              data-hotkey="new"
              aria-keyshortcuts="Alt+N"
              onClick={() => setCategoryForm({ record: null })}
            >
              <Plus size={16} /> New Subcategory
            </button>
          )}
        </div>
      </div>

      {/* All and the three categories side by side. Picking one shows only it,
          so nobody scrolls past the other two; All shows the three. */}
      <div className="glass-card grid gap-2 p-4 sm:grid-cols-2 xl:grid-cols-4" role="tablist" aria-label="Categories">
        {TOGGLES.map((t) => {
          const c = t.key === 'ALL' ? totals : countsOf(t.key)
          return (
            <Toggle
              key={t.key}
              on={selected === t.key}
              onClick={() => choose(t.key)}
              icon={t.icon}
              label={t.label}
              note={tree.length ? `${plural(c.subs, 'subcategory', 'subcategories')} · ${plural(c.items, 'item', 'items')}` : '…'}
            />
          )
        })}
      </div>

      {/* Search, process, active only; open or close every item list. */}
      <div className="glass-card relative z-20 flex flex-wrap items-center gap-2 p-4">
        <div className="border-border bg-secondary flex h-10 min-w-60 flex-1 items-center gap-2 rounded-lg border px-3">
          <Search size={15} className="text-muted-foreground" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search subcategories and items..."
            className="text-foreground placeholder:text-muted-foreground flex-1 bg-transparent text-sm focus:outline-none"
            data-hotkey="search"
            aria-label="Search subcategories and items"
          />
          {search && (
            <button type="button" onClick={() => setSearch('')} className="text-muted-foreground hover:text-foreground" aria-label="Clear search">
              <X size={14} />
            </button>
          )}
        </div>
        <SmartSelect className="form-input h-10 w-48" value={process} onChange={(e) => setProcess(e.target.value)} aria-label="Process">
          <option value="">Every process</option>
          {departments.map((d) => (
            <option key={d.id} value={d.id}>
              {d.name}
            </option>
          ))}
          <option value="none">No process</option>
        </SmartSelect>
        <label className="text-foreground flex items-center gap-2 px-1 text-sm">
          <input type="checkbox" checked={activeOnly} onChange={(e) => setActiveOnly(e.target.checked)} />
          Active only
        </label>
        <button type="button" className="btn-ghost h-10" onClick={expandAll} title="Show the items of every subcategory shown">
          <ChevronsUpDown size={15} /> Expand all
        </button>
        <button type="button" className="btn-ghost h-10" onClick={() => setOpenSubs(new Set())} title="Hide every item list">
          <ChevronsDownUp size={15} /> Collapse all
        </button>
      </div>

      {error && (
        <div className="flex items-center gap-2 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-400">
          <AlertCircle size={15} /> {error}
        </div>
      )}
      {notice && (
        <div className="flex items-center justify-between gap-2 rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-500">
          <span>{notice}</span>
          <button type="button" onClick={() => setNotice(null)} aria-label="Dismiss">
            <X size={14} />
          </button>
        </div>
      )}

      {SECTIONS.map((section) => {
        const main = mains.find((m) => m.itemGroup === section.key)
        const group = tree.find((g) => g.group === section.key)
        const subs = main ? subsOf(main.id) : []
        const visible = subs.filter(shows)
        const direct = main ? (itemsIn.get(main.id) ?? 0) : 0
        const directMatches = main ? (matches?.get(main.id)?.length ?? 0) : 0
        // Only the one picked, or all three; while searching, only where something matches.
        const isOpen = shownGroups.includes(section.key) && (!searching || visible.length > 0 || directMatches > 0)
        if (!isOpen) return null
        const bodyId = `category-${section.slug}`
        const counts = (
          <span className="text-muted-foreground text-sm">
            <span className="text-foreground font-semibold tabular-nums">{subs.filter((s) => s.isActive).length}</span> subcategories ·{' '}
            <span className="text-foreground font-semibold tabular-nums">{group?.count ?? 0}</span> items
          </span>
        )
        const addSub = mayCreate && main && (
          <button
            type="button"
            className="btn-secondary h-8 text-xs"
            onClick={() => setCategoryForm({ record: null, parentId: main.id })}
            title={`Add a subcategory under ${section.label}`}
          >
            <Plus size={14} /> Subcategory
          </button>
        )
        return (
          <section key={section.key} className="glass-card overflow-hidden" aria-label={section.label}>
            {selected === 'ALL' ? (
              // Under All, each category has its heading, to tell the three apart.
              <div className="border-border flex items-center gap-3 border-b px-4 py-3">
                <span className="bg-primary/10 text-primary rounded-lg p-2">
                  <section.icon size={18} />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="text-foreground block text-base font-semibold">{section.label}</span>
                  <span className="text-muted-foreground block truncate text-xs">{section.hint}</span>
                </span>
                <span className="hidden sm:inline">{counts}</span>
                {addSub}
              </div>
            ) : (
              // One category: its name is on the toggle above, so one slim line will do.
              <div className="border-border flex items-center gap-3 border-b px-4 py-2">
                <span className="text-foreground flex-1 text-sm font-semibold">{section.label}</span>
                {counts}
                {addSub}
              </div>
            )}

            {isOpen && (
              <div id={bodyId}>
                {!main ? (
                  <p className="text-muted-foreground px-4 py-6 text-sm">This category is missing. Run the latest database update.</p>
                ) : visible.length === 0 && directMatches === 0 && direct === 0 ? (
                  <p className="text-muted-foreground px-4 py-6 text-sm">
                    {process || searching ? 'No subcategory here matches.' : 'No subcategories yet. Add one with + Subcategory.'}
                  </p>
                ) : (
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="text-muted-foreground bg-secondary/40 text-left text-[11px] font-semibold uppercase tracking-wide">
                        <th className="w-10 px-2 py-2" />
                        <th className="px-2 py-2">Subcategory</th>
                        <th className="px-2 py-2">Process</th>
                        <th className="px-2 py-2 text-right">Items</th>
                        <th className="px-2 py-2">Status</th>
                        <th className="px-4 py-2 text-right">Actions</th>
                      </tr>
                    </thead>
                    <tbody>
                      {visible.map((sub) => {
                        const subOpen = openSubs.has(sub.id) || Boolean(searching && matches?.get(sub.id)?.length)
                        const found = searching ? matches?.get(sub.id) : undefined
                        const folded = activeOnly ? [] : foldedInto(sub.id)
                        return (
                          <Fragment key={sub.id}>
                            <tr className={cn('border-border border-t', subOpen && 'bg-secondary/30')}>
                              <td className="px-2 py-2 text-center">
                                <button
                                  type="button"
                                  className="btn-ghost p-1"
                                  onClick={() => toggleSub(sub.id)}
                                  aria-expanded={subOpen}
                                  aria-label={`${subOpen ? 'Hide' : 'Show'} the items in ${sub.name}`}
                                >
                                  {subOpen ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
                                </button>
                              </td>
                              <td className="px-2 py-2">
                                <button type="button" className="text-foreground font-medium hover:underline" onClick={() => toggleSub(sub.id)}>
                                  {sub.name}
                                </button>
                              </td>
                              <td className="text-foreground px-2 py-2">{sub.department?.name ?? <span className="text-muted-foreground">—</span>}</td>
                              <td className="px-2 py-2 text-right tabular-nums">
                                {found ? (
                                  <span title={`${found.length} matching`}>
                                    <span className="text-primary font-semibold">{found.length}</span>
                                    <span className="text-muted-foreground"> of {itemsIn.get(sub.id) ?? 0}</span>
                                  </span>
                                ) : (
                                  (itemsIn.get(sub.id) ?? 0)
                                )}
                              </td>
                              <td className="px-2 py-2">
                                <ActiveBadge isActive={sub.isActive} />
                              </td>
                              <td className="whitespace-nowrap px-4 py-2 text-right">
                                {mayCreate && (
                                  <button type="button" className="btn-ghost p-1.5" title={`Add an item to ${sub.name}`} aria-label={`Add an item to ${sub.name}`} onClick={() => addItem(section.key, main.id, sub)}>
                                    <Plus size={14} />
                                  </button>
                                )}
                                {mayEdit && (
                                  <button type="button" className="btn-ghost p-1.5" title="Edit subcategory" aria-label={`Edit ${sub.name}`} onClick={() => setCategoryForm({ record: sub })}>
                                    <Pencil size={14} />
                                  </button>
                                )}
                                {/* Switching off goes through the same delete route, so it needs the same right. */}
                                {mayDelete && (
                                  <button
                                    type="button"
                                    className={cn('btn-ghost p-1.5 text-red-400', !sub.isActive && 'invisible')}
                                    title="Deactivate subcategory"
                                    aria-label={`Deactivate ${sub.name}`}
                                    onClick={() => void deactivate(sub)}
                                  >
                                    <Ban size={14} />
                                  </button>
                                )}
                                {mayDelete && (
                                  <button type="button" className="btn-ghost p-1.5 text-red-500" title="Delete subcategory permanently" aria-label={`Delete ${sub.name} permanently`} onClick={() => setDeleting(sub)}>
                                    <Trash2 size={14} />
                                  </button>
                                )}
                              </td>
                            </tr>
                            {subOpen && (
                              <tr>
                                <td />
                                <td colSpan={5} className="pb-3 pr-4">
                                  <ItemList
                                    loaded={found ? { rows: found, total: found.length } : itemsOf[sub.id]}
                                    filtered={Boolean(found)}
                                    subName={sub.name}
                                    href={`/masters/items?tab=${section.slug}&category=${main.id}&sub=${sub.id}`}
                                    onEdit={mayEdit ? (item) => setItemForm({ record: item }) : undefined}
                                    onAdd={mayCreate ? () => addItem(section.key, main.id, sub) : undefined}
                                  />
                                  {folded.length > 0 && (
                                    <p className="text-muted-foreground mt-2 text-xs">
                                      Folded in: {folded.map((f) => f.name).join(', ')} (switched off; their items are here now)
                                    </p>
                                  )}
                                </td>
                              </tr>
                            )}
                          </Fragment>
                        )
                      })}
                      {/* Items filed on the category itself, not in a subcategory: to be put in one. */}
                      {(searching ? directMatches > 0 : direct > 0) && (
                        <Fragment>
                          <tr className="border-border border-t">
                            <td className="px-2 py-2 text-center">
                              <button type="button" className="btn-ghost p-1" onClick={() => toggleSub(main.id)} aria-expanded={openSubs.has(main.id)} aria-label="Show the items not in a subcategory">
                                {openSubs.has(main.id) || (searching && directMatches > 0) ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
                              </button>
                            </td>
                            <td className="px-2 py-2 text-amber-500" colSpan={2}>
                              Not in a subcategory — edit each to put it in one
                            </td>
                            <td className="px-2 py-2 text-right tabular-nums">{searching ? directMatches : direct}</td>
                            <td colSpan={2} />
                          </tr>
                          {(openSubs.has(main.id) || (searching && directMatches > 0)) && (
                            <tr>
                              <td />
                              <td colSpan={5} className="pb-3 pr-4">
                                <ItemList
                                  loaded={searching ? { rows: matches?.get(main.id) ?? [], total: directMatches } : itemsOf[main.id]}
                                  filtered={searching}
                                  subName={section.label}
                                  href={`/masters/items?tab=${section.slug}&category=${main.id}&sub=direct`}
                                  onEdit={mayEdit ? (item) => setItemForm({ record: item }) : undefined}
                                />
                              </td>
                            </tr>
                          )}
                        </Fragment>
                      )}
                    </tbody>
                  </table>
                )}
              </div>
            )}
          </section>
        )
      })}

      {searching && !loading && matches !== null && SECTIONS.filter((s) => shownGroups.includes(s.key)).every((s) => {
        const main = mains.find((m) => m.itemGroup === s.key)
        return !main || (subsOf(main.id).filter(shows).length === 0 && !matches.get(main.id)?.length)
      }) && (
        <div className="glass-card text-muted-foreground p-6 text-center text-sm">
          {selected === 'ALL' ? (
            <>No subcategory or item matches “{term}”.</>
          ) : (
            <>
              Nothing in {SECTIONS.find((s) => s.key === selected)?.label} matches “{term}”.{' '}
              <button type="button" className="text-primary font-medium hover:underline" onClick={() => choose('ALL')}>
                Look in All
              </button>
            </>
          )}
        </div>
      )}

      {categoryForm && (
        <MasterFormDialog<Category>
          open
          onClose={() => setCategoryForm(null)}
          onSaved={() => {
            setCategoryForm(null)
            reload()
          }}
          resource="item-categories"
          fields={categoryFields}
          record={categoryForm.record}
          initialValues={categoryForm.parentId ? { parentId: categoryForm.parentId } : undefined}
          title="Subcategory"
        />
      )}
      {itemForm && (
        <MasterFormDialog<ItemRow>
          open
          onClose={() => setItemForm(null)}
          onSaved={() => {
            setItemForm(null)
            reload()
          }}
          resource="items"
          fields={itemFormFields}
          record={itemForm.record}
          initialValues={itemForm.init}
          title="Item"
          columns={4}
        />
      )}
      {deleting && (
        <DeleteDialog
          resource="item-categories"
          id={deleting.id}
          name={deleting.name}
          entityName="Subcategory"
          refusedHint="Move its items to another subcategory first."
          onClose={() => setDeleting(null)}
          onDeleted={(message) => {
            setDeleting(null)
            setNotice(message)
            reload()
          }}
        />
      )}
      {importing && <ImportCategoriesDialog onClose={() => setImporting(false)} onImported={reload} />}
    </div>
  )
}

/** One category (or All) as a card to pick, with how many subcategories and items it holds. */
function Toggle({
  on,
  onClick,
  icon: Icon,
  label,
  note,
}: {
  on: boolean
  onClick: () => void
  icon: typeof Package
  label: string
  note: string
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={on}
      onClick={onClick}
      className={cn(
        'flex items-center gap-3 rounded-xl border px-4 py-3 text-left transition-colors',
        on ? 'border-primary bg-primary/10' : 'border-border hover:bg-secondary',
      )}
    >
      <span className={cn('rounded-lg p-2', on ? 'bg-primary/15 text-primary' : 'bg-secondary text-muted-foreground')}>
        <Icon size={18} />
      </span>
      <span className="min-w-0 flex-1">
        <span className={cn('block text-sm font-semibold', on ? 'text-primary' : 'text-foreground')}>{label}</span>
        <span className="text-muted-foreground block truncate text-xs">{note}</span>
      </span>
    </button>
  )
}

/** A sub-category's items, one below another, with a way to edit each and to add one. */
function ItemList({
  loaded,
  filtered,
  subName,
  href,
  onEdit,
  onAdd,
}: {
  loaded: Loaded | undefined
  filtered: boolean
  subName: string
  href: string
  onEdit?: (item: ItemRow) => void
  onAdd?: () => void
}) {
  if (!loaded || loaded === 'loading') {
    return (
      <p className="text-muted-foreground flex items-center gap-2 py-2 text-xs">
        <Loader2 size={13} className="animate-spin" /> Loading the items…
      </p>
    )
  }
  if ('error' in loaded) return <p className="py-2 text-xs text-red-400">{loaded.error}</p>
  return (
    <div className="border-border rounded-lg border">
      {loaded.rows.length === 0 ? (
        <p className="text-muted-foreground px-3 py-3 text-xs">No items in {subName} yet.</p>
      ) : (
        <table className="w-full text-xs">
          <thead>
            <tr className="text-muted-foreground border-border border-b text-left text-[10px] font-semibold uppercase tracking-wide">
              <th className="px-3 py-1.5">Code</th>
              <th className="px-3 py-1.5">Item</th>
              <th className="px-3 py-1.5">Type</th>
              <th className="px-3 py-1.5">Unit</th>
              <th className="px-3 py-1.5 text-right">Std. Rate</th>
              <th className="px-3 py-1.5">Status</th>
              <th className="px-3 py-1.5" />
            </tr>
          </thead>
          <tbody>
            {loaded.rows.map((i) => {
              const tl = ITEM_TYPE_LABEL[i.type] ?? { label: i.type, cls: 'badge-neutral' }
              return (
                <tr key={i.id} className="border-border border-t first:border-t-0">
                  <td className="whitespace-nowrap px-3 py-1.5 font-mono text-teal-400">{i.code}</td>
                  <td className="text-foreground px-3 py-1.5 font-medium">
                    {i.name}
                    {i.style && <span className="text-muted-foreground ml-1.5 font-normal">· {i.style.code}{i.color ? ` · ${i.color}` : ''}</span>}
                  </td>
                  <td className="px-3 py-1.5">
                    <span className={cn(tl.cls, 'whitespace-nowrap')}>{tl.label}</span>
                  </td>
                  <td className="text-muted-foreground px-3 py-1.5">{i.uom?.symbol ?? '—'}</td>
                  <td className="whitespace-nowrap px-3 py-1.5 text-right tabular-nums">{i.standardRate ? rate(Number(i.standardRate)) : '—'}</td>
                  <td className="px-3 py-1.5">
                    <ActiveBadge isActive={i.isActive} />
                  </td>
                  <td className="px-3 py-1.5 text-right">
                    {onEdit && (
                      <button type="button" className="btn-ghost p-1" title="Edit item" aria-label={`Edit ${i.name}`} onClick={() => onEdit(i)}>
                        <Pencil size={13} />
                      </button>
                    )}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      )}
      <div className="border-border flex flex-wrap items-center justify-between gap-2 border-t px-3 py-2 text-xs">
        <span className="text-muted-foreground">
          {filtered
            ? `${loaded.rows.length} matching item${loaded.rows.length === 1 ? '' : 's'}`
            : loaded.total > loaded.rows.length
              ? `First ${loaded.rows.length} of ${loaded.total} items`
              : `${loaded.total} item${loaded.total === 1 ? '' : 's'}`}
        </span>
        <span className="flex items-center gap-3">
          {onAdd && (
            <button type="button" className="text-primary inline-flex items-center gap-1 font-medium hover:underline" onClick={onAdd}>
              <Plus size={13} /> Add item to {subName}
            </button>
          )}
          <Link href={href} className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1">
            Open in Items & Products <ExternalLink size={12} />
          </Link>
        </span>
      </div>
    </div>
  )
}
