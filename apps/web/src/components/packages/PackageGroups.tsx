'use client'

import { Fragment, useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { ChevronDown, ChevronRight, Loader2, Printer } from 'lucide-react'
import { api, ApiError } from '@/lib/api'
import { ScrollableTable } from '@/components/tables/ScrollableTable'
import { STATUS, openPrintTab, packCount, packLabel, printLabels, qtyText } from './packageTypes'

/** One item in one store, with how many packages of it there are. */
export interface PackageGroup {
  key: string
  itemId: string
  itemCode: string
  item: string
  category: string
  unit: string
  warehouseId: string
  store: string
  ownerCustomerId: string | null
  owner: string | null
  packages: number
  qty: number
  packTypes: string[]
  lots: string[]
  lastAt: string
}

interface PackageRow {
  id: string
  code: string
  status: string
  packType: string
  qty: number
  initialQty: number
  unit: string
  lotNo: string | null
  createdAt: string
}

const day = (d: string) => new Date(d).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: '2-digit' })

/**
 * Packages one line per item: "Horn Button — Store — 50 boxes — 2,500 pcs".
 * Opening a line shows its packages, to print or open one by one. Fifty
 * near-identical rows for one button told nobody anything at a glance.
 */
export function PackageGroups({
  groups,
  filters,
  emptyText,
}: {
  groups: PackageGroup[]
  /** The list's own filters, applied to the packages shown under each item too. */
  filters: { q: string; status: string }
  emptyText: string
}) {
  const [open, setOpen] = useState<Set<string>>(new Set())
  const [rows, setRows] = useState<Record<string, PackageRow[]>>({})
  const [loadingKey, setLoadingKey] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [picked, setPicked] = useState<Set<string>>(new Set())

  const fetchRows = useCallback(
    async (g: PackageGroup) => {
      const qs = new URLSearchParams({
        itemId: g.itemId,
        warehouseId: g.warehouseId,
        owner: g.ownerCustomerId ?? 'OWNED',
        status: filters.status,
        limit: '500',
      })
      if (filters.q.trim()) qs.set('q', filters.q.trim())
      const res = await api.get<{ data: PackageRow[] }>(`/packages?${qs}`)
      setRows((r) => ({ ...r, [g.key]: res.data }))
      return res.data
    },
    [filters.q, filters.status],
  )

  // The list was reloaded (a filter, or stickers just made): what is open is
  // fetched again so it shows the same packages as the line above it.
  useEffect(() => {
    setRows({})
    setPicked(new Set())
    for (const g of groups) if (open.has(g.key)) void fetchRows(g).catch(() => {})
    // Only when the list itself changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [groups])

  const toggle = async (g: PackageGroup) => {
    const next = new Set(open)
    if (next.has(g.key)) {
      next.delete(g.key)
      setOpen(next)
      return
    }
    next.add(g.key)
    setOpen(next)
    if (rows[g.key]) return
    setLoadingKey(g.key)
    setError(null)
    try {
      await fetchRows(g)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load the packages.')
    } finally {
      setLoadingKey(null)
    }
  }

  const printGroup = async (g: PackageGroup) => {
    const tab = openPrintTab()
    try {
      const list = rows[g.key] ?? (await fetchRows(g))
      printLabels(list.map((p) => p.id), tab)
    } catch {
      tab?.close()
      setError('Could not load the packages to print.')
    }
  }

  const pick = (ids: string[], on: boolean) =>
    setPicked((p) => {
      const n = new Set(p)
      for (const id of ids) {
        if (on) n.add(id)
        else n.delete(id)
      }
      return n
    })

  if (!groups.length) return <div className="p-10 text-center text-muted-foreground">{emptyText}</div>

  return (
    <div>
      {error && <p className="px-4 pt-3 text-sm text-red-400">{error}</p>}
      {picked.size > 0 && (
        <div className="flex items-center gap-3 border-b border-border bg-primary/5 px-4 py-2">
          <span className="text-sm font-medium text-foreground">
            {picked.size} {picked.size === 1 ? 'package' : 'packages'} selected
          </span>
          <button className="btn-primary h-9" onClick={() => printLabels([...picked])}>
            <Printer size={15} /> Print {picked.size === 1 ? 'its sticker' : `${picked.size} stickers`}
          </button>
          <button className="btn-ghost h-9" onClick={() => setPicked(new Set())}>
            Clear
          </button>
        </div>
      )}
      <ScrollableTable>
        <table className="data-table table-compact min-w-full">
          <thead>
            <tr className="bg-secondary">
              <th className="w-8" />
              <th>Item</th>
              <th>Store</th>
              <th style={{ textAlign: 'right' }}>Packages</th>
              <th style={{ textAlign: 'right' }}>In them</th>
              <th>Lots</th>
              <th>Last labelled</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {groups.map((g) => {
              const isOpen = open.has(g.key)
              const list = rows[g.key]
              const allPicked = Boolean(list?.length) && list!.every((p) => picked.has(p.id))
              return (
                <Fragment key={g.key}>
                  <tr className={`cursor-pointer ${isOpen ? 'bg-primary/5' : ''}`} onClick={() => void toggle(g)}>
                    <td className="text-muted-foreground">{isOpen ? <ChevronDown size={16} /> : <ChevronRight size={16} />}</td>
                    <td>
                      <div className="font-medium text-foreground">{g.item}</div>
                      <div className="text-xs text-muted-foreground">
                        <span className="font-mono">{g.itemCode}</span>
                        {g.category ? ` · ${g.category}` : ''}
                        {g.owner ? ` · ${g.owner}'s` : ''}
                      </div>
                    </td>
                    <td className="whitespace-nowrap text-sm">{g.store}</td>
                    <td className="whitespace-nowrap text-right font-semibold tabular-nums">{packCount(g.packages, g.packTypes[0] ?? 'OTHER')}</td>
                    <td className="whitespace-nowrap text-right font-semibold tabular-nums">
                      {qtyText(g.qty)} <span className="text-xs font-normal text-muted-foreground">{g.unit}</span>
                    </td>
                    <td className="max-w-[200px] truncate text-sm" title={g.lots.join(', ')}>
                      {g.lots.length ? g.lots.join(', ') : <span className="text-muted-foreground">—</span>}
                    </td>
                    <td className="whitespace-nowrap text-sm">{day(g.lastAt)}</td>
                    <td className="whitespace-nowrap text-right" onClick={(e) => e.stopPropagation()}>
                      <button className="btn-secondary h-8" onClick={() => void printGroup(g)} title={`Print the ${g.packages} stickers of ${g.item}`}>
                        <Printer size={14} /> Print all {g.packages}
                      </button>
                    </td>
                  </tr>
                  {isOpen && (
                    <tr>
                      <td colSpan={8} className="bg-secondary/30 p-0">
                        {loadingKey === g.key || !list ? (
                          <p className="flex items-center gap-2 px-12 py-4 text-sm text-muted-foreground">
                            <Loader2 size={15} className="animate-spin" /> Loading the packages…
                          </p>
                        ) : (
                          <table className="data-table table-compact min-w-full">
                            <thead>
                              <tr>
                                <th className="w-8 pl-12">
                                  <input
                                    type="checkbox"
                                    aria-label={`Select every package of ${g.item}`}
                                    checked={allPicked}
                                    onChange={(e) => pick(list.map((p) => p.id), e.target.checked)}
                                  />
                                </th>
                                <th>Code</th>
                                <th>Type</th>
                                <th style={{ textAlign: 'right' }}>In it</th>
                                <th style={{ textAlign: 'right' }}>Labelled with</th>
                                <th>Lot</th>
                                <th>Labelled on</th>
                                <th>Status</th>
                                <th />
                              </tr>
                            </thead>
                            <tbody>
                              {list.map((p) => {
                                const st = STATUS[p.status] ?? { label: p.status, cls: 'badge-neutral' }
                                return (
                                  <tr key={p.id}>
                                    <td className="pl-12">
                                      <input
                                        type="checkbox"
                                        aria-label={`Select ${p.code}`}
                                        checked={picked.has(p.id)}
                                        onChange={(e) => pick([p.id], e.target.checked)}
                                      />
                                    </td>
                                    <td className="whitespace-nowrap">
                                      <Link href={`/inventory/scan?code=${p.code}`} className="font-mono text-sm font-semibold text-primary hover:underline">
                                        {p.code}
                                      </Link>
                                    </td>
                                    <td className="whitespace-nowrap text-sm">{packLabel(p.packType)}</td>
                                    <td className="whitespace-nowrap text-right font-semibold tabular-nums">
                                      {qtyText(p.qty)} <span className="text-xs font-normal text-muted-foreground">{p.unit}</span>
                                    </td>
                                    <td className="whitespace-nowrap text-right text-sm tabular-nums text-muted-foreground">{qtyText(p.initialQty)}</td>
                                    <td className="whitespace-nowrap text-sm">{p.lotNo ?? <span className="text-muted-foreground">—</span>}</td>
                                    <td className="whitespace-nowrap text-sm">{day(p.createdAt)}</td>
                                    <td>
                                      <span className={`badge ${st.cls}`}>{st.label}</span>
                                    </td>
                                    <td className="whitespace-nowrap text-right">
                                      <button className="btn-ghost p-1.5" title="Print this sticker" onClick={() => printLabels([p.id])}>
                                        <Printer size={15} />
                                      </button>
                                    </td>
                                  </tr>
                                )
                              })}
                            </tbody>
                          </table>
                        )}
                      </td>
                    </tr>
                  )}
                </Fragment>
              )
            })}
          </tbody>
        </table>
      </ScrollableTable>
    </div>
  )
}
