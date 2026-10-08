'use client'

import { Suspense, useEffect, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { api, ApiError, masterResource } from '@/lib/api'
import {
  StoreSheet,
  Fact,
  Eyebrow,
  qty,
  longDate,
  CODE,
  GREY,
  INK,
  MUTED,
  NAVY,
  type SheetColumn,
} from '@/components/print/StoreSheet'
import { SmartSelect } from '@/components/ui/SmartSelect'

interface Payload {
  company: Record<string, string | null>
  template: { title: string; footerNote: string | null }
  warehouse: { id: string; name: string; code: string; address: string | null }
  rows: Array<{ itemId: string; code: string; name: string; category: string; uom: string; bookQty: number }>
  printedAt: string
}

/**
 * The sheet a keeper carries to the rack and writes on.
 *
 * One store at a time, in category then name order so the list follows the
 * racks. The book quantity is left off unless asked for: a keeper who can see
 * what the book says tends to find exactly that, and the count exists to catch
 * the book being wrong. What comes back is typed into Stock → Count.
 */
function CountSheet() {
  const params = useSearchParams()
  const router = useRouter()
  const warehouseId = params.get('warehouseId') ?? ''
  const showBook = params.get('book') === 'true'
  const all = params.get('all') === 'true'

  const [stores, setStores] = useState<Array<{ id: string; name: string }>>([])
  const [data, setData] = useState<Payload | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    masterResource<{ id: string; name: string }>('warehouses')
      .list({ limit: 100, active: true, sort: 'name', order: 'asc' })
      .then((res) => setStores(res.data))
      .catch(() => {})
  }, [])

  useEffect(() => {
    setData(null)
    setError(null)
    if (!warehouseId) return
    api
      .get<{ data: Payload }>(`/inventory/count-sheet?warehouseId=${warehouseId}${all ? '&all=true' : ''}`)
      .then((res) => setData(res.data))
      .catch((err) => setError(err instanceof ApiError ? err.message : 'Could not make the count sheet.'))
  }, [warehouseId, all])

  const setParam = (key: string, value: string | null) => {
    const next = new URLSearchParams(params.toString())
    if (value === null) next.delete(key)
    else next.set(key, value)
    router.replace(`/print/count-sheet?${next}`)
  }

  const options = (
    <>
      <label>
        Store
        <SmartSelect value={warehouseId} onChange={(e) => setParam('warehouseId', e.target.value || null)}>
          <option value="">Choose a store...</option>
          {stores.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </SmartSelect>
      </label>
      <label>
        <input type="checkbox" checked={showBook} onChange={(e) => setParam('book', e.target.checked ? 'true' : null)} />
        Show the book quantity
      </label>
      <label>
        <input type="checkbox" checked={all} onChange={(e) => setParam('all', e.target.checked ? 'true' : null)} />
        Add items with none on the book here
      </label>
    </>
  )

  if (!warehouseId || (!data && !error)) {
    return (
      <div style={{ maxWidth: '210mm', margin: '0 auto' }}>
        <div className="store-options" style={{ display: 'flex', gap: 16, flexWrap: 'wrap', background: '#fff', padding: '8px 12px', borderRadius: 6, font: '13px Inter, system-ui, sans-serif' }}>
          {options}
        </div>
        <p style={{ padding: 24, color: '#fff' }}>
          {warehouseId ? 'Making the count sheet…' : 'Choose the store to count.'}
        </p>
      </div>
    )
  }
  if (error || !data) return <p style={{ padding: 48, color: INK }}>{error}</p>

  const columns: SheetColumn[] = [
    { key: 'sn', head: 'S.N', width: '5%', align: 'center' },
    { key: 'code', head: 'Item Code', width: '13%' },
    { key: 'desc', head: 'Item', width: showBook ? '30%' : '36%' },
    { key: 'cat', head: 'Category', width: '12%' },
    { key: 'uom', head: 'UOM', width: '6%', align: 'center' },
    ...(showBook ? [{ key: 'book', head: 'Book', width: '9%', align: 'right' as const }] : []),
    { key: 'counted', head: 'Counted', width: '12%', align: 'right' },
    { key: 'remark', head: 'Remarks', width: showBook ? '13%' : '16%' },
  ]

  const rows = data.rows.map((r, i) => ({
    key: r.itemId,
    cells: {
      sn: i + 1,
      code: <span style={CODE}>{r.code}</span>,
      desc: <div style={{ fontWeight: 600 }}>{r.name}</div>,
      cat: <span style={{ fontSize: '9px', color: GREY }}>{r.category}</span>,
      uom: <span style={{ fontSize: '9px', color: GREY }}>{r.uom}</span>,
      book: r.bookQty ? qty(r.bookQty) : '—',
      counted: '',
      remark: '',
    },
  }))

  return (
    <StoreSheet
      company={data.company}
      title={data.template.title}
      number={data.warehouse.code}
      dateLabel="Printed"
      date={longDate(data.printedAt) ?? ''}
      backHref="/inventory/stock"
      backLabel="Stock"
      options={options}
      panels={[
        {
          title: 'Store',
          body: (
            <>
              <div style={{ fontSize: '12px', fontWeight: 700, color: NAVY, lineHeight: 1.3 }}>
                {data.warehouse.name}
              </div>
              {data.warehouse.address && (
                <div style={{ fontSize: '10px', color: GREY, lineHeight: 1.55, marginTop: '3px' }}>
                  {data.warehouse.address}
                </div>
              )}
              <div style={{ marginTop: '4px' }}>
                <Fact label="Items" value={String(data.rows.length)} />
              </div>
            </>
          ),
        },
        {
          title: 'The count',
          body: (
            <>
              <Fact label="Counted on" value="____ / ____ / ________" />
              <Fact label="Started at" value="______ : ______" />
              <Fact label="Book shown" value={showBook ? 'Yes' : 'No — count what is there'} />
            </>
          ),
        },
        {
          title: 'How to fill it',
          body: (
            <div style={{ fontSize: '9.5px', color: GREY, lineHeight: 1.5 }}>
              Write what is on the rack, in the unit shown. Anything not on this sheet goes on a blank
              line at the end. Enter the figures in Stock → Count.
            </div>
          ),
        },
      ]}
      columns={columns}
      rows={rows}
      minRows={rows.length + 6}
      after={
        <div style={{ marginTop: '8px', fontSize: '9.5px', color: MUTED }}>
          <Eyebrow style={{ color: GREY, display: 'inline' }}>Found, not listed · </Eyebrow>
          write it on the blank lines above with its code or a description.
        </div>
      }
      signatures={[
        { role: 'Counted by', who: null },
        { role: 'Checked by', who: null },
        { role: 'Store in-charge', who: null },
      ]}
      footerNote={
        data.template.footerNote ?? 'Counted figures are entered in Stock → Count, with the reason for any change.'
      }
    />
  )
}

// useSearchParams needs a Suspense boundary or the build refuses the route.
export default function PrintCountSheet() {
  return (
    <Suspense fallback={<p style={{ padding: 48 }}>Opening…</p>}>
      <CountSheet />
    </Suspense>
  )
}
