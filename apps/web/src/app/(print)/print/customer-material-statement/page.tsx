'use client'

import { Suspense, useEffect, useState } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { api, ApiError, masterResource } from '@/lib/api'
import {
  StoreSheet,
  Dash,
  Eyebrow,
  PartyLine,
  qty,
  longDate,
  shortDate,
  CODE,
  INK,
  MUTED,
  NUM,
  type SheetColumn,
} from '@/components/print/StoreSheet'
import { Box, HAIR, LINE, SubLine } from '@/components/print/doc'
import { SmartSelect } from '@/components/ui/SmartSelect'
import { itemShade, itemShadeCols, type ShadeFields } from '@/lib/items'

interface Move {
  date: string
  doc: string | null
  what: string
  party: string | null
  store: string
  toStore?: string
  size: string | null
  inQty: number
  outQty: number
  moved?: number
  notes: string | null
  balance: number
}

interface ItemStatement extends ShadeFields {
  itemId: string
  code: string
  name: string
  uom: string
  opening: number
  received: number
  returned: number
  production: number
  jobwork: number
  dispatched: number
  adjusted: number
  closing: number
  rows: Move[]
  where: Array<{ store: string; qty: number; atJobWorker: boolean }>
}

interface Payload {
  company: Record<string, string | null>
  template: { title: string; footerNote: string | null; declaration: string | null }
  customer: {
    id: string
    code: string
    name: string
    gstin: string | null
    phone: string | null
    email: string | null
    billingAddress: string | null
    billingCity: string | null
    billingState: string | null
    billingStateCode: string | null
    billingPincode: string | null
  }
  period: { from: string | null; to: string }
  showMoves: boolean
  items: ItemStatement[]
  withJobWorkers: Array<ShadeFields & {
    challanNumber: string
    challanDate: string
    process: string
    jobWorker: string
    expectedBackOn: string | null
    code: string
    item: string
    uom: string
    sent: number
    wasted: number
    pending: number
  }>
}

/** The figures a customer's statement can show, each a column only when some item has it. */
const FIGURES: Array<{ key: keyof ItemStatement; head: string; always?: boolean }> = [
  { key: 'opening', head: 'Opening', always: true },
  { key: 'received', head: 'Received', always: true },
  { key: 'returned', head: 'Returned to you' },
  { key: 'production', head: 'Used in production' },
  { key: 'jobwork', head: 'Job work loss' },
  { key: 'dispatched', head: 'Sent as goods' },
  { key: 'adjusted', head: 'Adjusted' },
  { key: 'closing', head: 'With us now', always: true },
]

const today = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' })
const num = (v: number) => (Math.abs(v) < 0.0005 ? '—' : qty(v))

/** A line of a grouped table, or a heading across it for the rows under it. */
type GroupRow = { key: string; heading: React.ReactNode } | { key: string; cells: Record<string, React.ReactNode> }

/**
 * A titled table after the main one, ruled like the purchase order's lines —
 * black on white, its heading repeated on every printed page, a row never
 * split across two — with heading rows across it for what the rows under
 * them belong to. (The kit's DocTable has no heading rows; this is it with
 * them.)
 */
function GroupTable({ title, note, columns, rows }: { title: string; note?: string; columns: SheetColumn[]; rows: GroupRow[] }) {
  const last = columns.length - 1
  const th = (c: SheetColumn, i: number): React.CSSProperties => ({
    padding: '4px 4px',
    fontSize: '7.5px',
    fontWeight: 700,
    letterSpacing: '.04em',
    textTransform: 'uppercase',
    lineHeight: 1.25,
    textAlign: c.align ?? 'left',
    verticalAlign: 'bottom',
    borderBottom: LINE,
    borderRight: i === last ? undefined : HAIR,
    overflowWrap: 'anywhere',
  })
  const td = (c: SheetColumn, i: number): React.CSSProperties => ({
    padding: '4px 4px',
    fontSize: '9.5px',
    lineHeight: 1.4,
    textAlign: c.align ?? 'left',
    verticalAlign: 'top',
    borderTop: HAIR,
    borderRight: i === last ? undefined : HAIR,
    overflowWrap: 'anywhere',
    ...(c.align === 'right' ? NUM : {}),
  })
  return (
    <div style={{ marginTop: '9px' }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: '8px', breakAfter: 'avoid' }}>
        <Eyebrow>{title}</Eyebrow>
        {note && <span style={{ fontSize: '9px' }}>{note}</span>}
      </div>
      <table className="doc-lines" style={{ width: '100%', borderCollapse: 'collapse', tableLayout: 'fixed', border: LINE, marginTop: '3px' }}>
        <colgroup>
          {columns.map((c) => (
            <col key={c.key} style={{ width: c.width }} />
          ))}
        </colgroup>
        <thead>
          <tr>
            {columns.map((c, i) => (
              <th key={c.key} style={th(c, i)}>
                {c.head}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) =>
            'heading' in r ? (
              <tr key={r.key} style={{ breakAfter: 'avoid' }}>
                <td colSpan={columns.length} style={{ padding: '4px 4px', fontSize: '9.5px', fontWeight: 700, lineHeight: 1.4, borderTop: LINE }}>
                  {r.heading}
                </td>
              </tr>
            ) : (
              <tr key={r.key}>
                {columns.map((c, i) => (
                  <td key={c.key} style={td(c, i)}>
                    {r.cells[c.key] ?? ''}
                  </td>
                ))}
              </tr>
            ),
          )}
        </tbody>
      </table>
    </div>
  )
}

/**
 * A customer's material with us, as a statement to hand them or send them:
 * for each item, what there was, what came in, what went back, what was used,
 * and what is left — then where it is, what is out with job workers, and every
 * movement with its document. Drawn from the stock ledger, so it says exactly
 * what the stock screens say.
 */
function Statement() {
  const params = useSearchParams()
  const router = useRouter()
  const pathname = usePathname()
  const customerId = params.get('customerId') ?? ''
  const from = params.get('from') ?? ''
  const to = params.get('to') ?? ''
  const moves = params.get('moves') === '1'

  const [customers, setCustomers] = useState<Array<{ id: string; name: string; code?: string }>>([])
  const [data, setData] = useState<Payload | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  const setParam = (k: string, v: string) => {
    const next = new URLSearchParams(params.toString())
    if (v) next.set(k, v)
    else next.delete(k)
    router.replace(`${pathname}?${next}`, { scroll: false })
  }

  useEffect(() => {
    masterResource<{ id: string; name: string; code?: string }>('customers')
      .list({ limit: 500, sort: 'name', order: 'asc' })
      .then((r) => setCustomers(r.data))
      .catch(() => setCustomers([]))
  }, [])

  useEffect(() => {
    if (!customerId) {
      setData(null)
      return
    }
    const qs = new URLSearchParams()
    if (from) qs.set('from', from)
    if (to) qs.set('to', to)
    if (moves) qs.set('moves', '1')
    setLoading(true)
    setError(null)
    api
      .get<{ data: Payload }>(`/inventory/statements/customer/${customerId}?${qs}`)
      .then((r) => setData(r.data))
      .catch((err) => setError(err instanceof ApiError ? err.message : 'Could not make the statement.'))
      .finally(() => setLoading(false))
  }, [customerId, from, to, moves])

  const exportExcel = async () => {
    if (!data) return
    const XLSX = await import('xlsx')
    const book = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(
      book,
      XLSX.utils.json_to_sheet(
        data.items.map((i) => ({
          'Item Code': i.code,
          Item: i.name,
          'Design No.': itemShadeCols(i).designNo,
          Colour: itemShadeCols(i).colour,
          Unit: i.uom,
          Opening: i.opening,
          Received: i.received,
          'Returned to you': i.returned,
          'Used in production': i.production,
          'Job work loss': i.jobwork,
          'Sent as goods': i.dispatched,
          Adjusted: i.adjusted,
          'With us now': i.closing,
        })),
      ),
      'Summary',
    )
    XLSX.utils.book_append_sheet(
      book,
      XLSX.utils.json_to_sheet(
        data.items.flatMap((i) =>
          i.rows.map((r) => ({
            Date: longDate(r.date),
            'Item Code': i.code,
            Item: i.name,
            'Design No.': itemShadeCols(i).designNo,
            Colour: itemShadeCols(i).colour,
            Size: r.size ?? '',
            Document: r.doc ?? '',
            What: r.what,
            Party: r.party ?? '',
            Store: r.toStore ? `${r.store} → ${r.toStore}` : r.store,
            In: r.inQty || '',
            Out: r.outQty || '',
            Moved: r.moved ?? '',
            Balance: r.balance,
            Unit: i.uom,
            Note: r.notes ?? '',
          })),
        ),
      ),
      'Movements',
    )
    XLSX.utils.book_append_sheet(
      book,
      XLSX.utils.json_to_sheet(
        data.items.flatMap((i) =>
          i.where.map((w) => ({
            'Item Code': i.code,
            Item: i.name,
            'Design No.': itemShadeCols(i).designNo,
            Colour: itemShadeCols(i).colour,
            Where: w.store,
            'At job worker': w.atJobWorker ? 'Yes' : '',
            Quantity: w.qty,
            Unit: i.uom,
          })),
        ),
      ),
      'Where it is',
    )
    XLSX.writeFile(book, `${data.customer.name.replace(/[^\w]+/g, '-')}-material-statement-${today()}.xlsx`)
  }

  const options = (
    <>
      <label>
        Customer
        <SmartSelect value={customerId} onChange={(e) => setParam('customerId', e.target.value)} aria-label="Customer">
          <option value="">Pick a customer…</option>
          {customers.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </SmartSelect>
      </label>
      <label>
        From
        <input type="date" value={from} max={to || today()} onChange={(e) => setParam('from', e.target.value)} />
      </label>
      <label>
        To
        <input type="date" value={to} min={from || undefined} max={today()} onChange={(e) => setParam('to', e.target.value)} />
      </label>
      <label title="Moves between our own stores change where it is, not how much">
        <input type="checkbox" checked={moves} onChange={(e) => setParam('moves', e.target.checked ? '1' : '')} />
        Show moves between our stores
      </label>
      {data && (
        <button type="button" className="tb-btn" onClick={() => void exportExcel()}>
          Download Excel
        </button>
      )}
    </>
  )

  if (!customerId || !data) {
    return (
      <div style={{ maxWidth: '210mm', margin: '0 auto' }}>
        <div className="store-options" style={{ display: 'flex', gap: 16, flexWrap: 'wrap', alignItems: 'center', padding: '8px 12px', background: '#fff', borderRadius: 6, font: '13px Inter, system-ui, sans-serif', color: INK }}>
          {options}
        </div>
        <p style={{ padding: 32, color: error ? INK : '#fff', font: '14px Inter, system-ui, sans-serif' }}>
          {error ?? (customerId ? (loading ? 'Making the statement…' : '') : 'Pick a customer to see their material statement.')}
        </p>
      </div>
    )
  }

  const { company, template, customer, period, items } = data
  const address = [customer.billingAddress, customer.billingCity, customer.billingState, customer.billingPincode].filter(Boolean).join(', ')
  const figures = FIGURES.filter((f) => f.always || items.some((i) => Math.abs(Number(i[f.key])) > 0.0005))
  // Each figure gets an equal share, wide enough for "1,25,000.5" or "33,333.333" on one line even
  // when all eight show; the item's name wraps in its own column instead.
  const figWidth = Math.min(19, 74 / figures.length)
  const columns: SheetColumn[] = [
    { key: 'sn', head: 'S.N', width: '4%', align: 'center' },
    { key: 'item', head: 'Item', width: `${(91 - figWidth * figures.length).toFixed(2)}%` },
    { key: 'uom', head: 'UOM', width: '5%', align: 'center' },
    ...figures.map((f) => ({ key: f.key, head: f.head, width: `${figWidth.toFixed(2)}%`, align: 'right' as const })),
  ]
  const rows = items.map((i, n) => ({
    key: i.itemId,
    cells: {
      sn: n + 1,
      item: (
        <>
          <div style={{ fontWeight: 600 }}>{i.name}</div>
          {itemShade(i) && <SubLine>{itemShade(i)}</SubLine>}
          <SubLine style={CODE}>{i.code}</SubLine>
        </>
      ),
      uom: i.uom,
      ...Object.fromEntries(
        figures.map((f) => [f.key, f.key === 'closing' ? <strong>{num(i.closing)}</strong> : num(Number(i[f.key]))]),
      ),
    },
  }))

  const whereRows: GroupRow[] = items
    .filter((i) => i.where.length)
    .flatMap((i) =>
      i.where.map((w, n) => ({
        key: `${i.itemId}-${w.store}`,
        cells: {
          item:
            n === 0 ? (
              <>
                <span style={{ fontWeight: 600 }}>{i.name}</span>
                {itemShade(i) && <SubLine>{itemShade(i)}</SubLine>}
              </>
            ) : (
              ''
            ),
          store: (
            <>
              {w.store}
              {w.atJobWorker && <span> (with a job worker)</span>}
            </>
          ),
          qty: `${qty(w.qty)} ${i.uom}`,
        },
      })),
    )

  const moveRows: GroupRow[] = items.flatMap((i) => [
    {
      key: `h-${i.itemId}`,
      heading: (
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: '10px' }}>
          <span style={{ minWidth: 0 }}>
            {i.name} <span style={{ ...CODE, fontWeight: 400 }}>{i.code}</span>
            {itemShade(i) && <span style={{ fontWeight: 400 }}> · {itemShade(i)}</span>}
          </span>
          <span style={{ flexShrink: 0, ...NUM }}>
            Opening {qty(i.opening)} {i.uom}
          </span>
        </div>
      ),
    },
    ...i.rows.map((r, n) => ({
      key: `${i.itemId}-${n}`,
      cells: {
        date: shortDate(r.date),
        doc: r.doc ? <span style={CODE}>{r.doc}</span> : <Dash />,
        what: (
          <>
            <div style={{ fontWeight: 600 }}>
              {r.what}
              {r.size ? ` · ${r.size}` : ''}
            </div>
            <SubLine>{[r.party, r.toStore ? `${r.store} → ${r.toStore}` : r.store].filter(Boolean).join(' · ')}</SubLine>
          </>
        ),
        in: r.inQty ? qty(r.inQty) : r.moved ? `moved ${qty(r.moved)}` : '',
        out: r.outQty ? qty(r.outQty) : '',
        bal: <strong>{qty(r.balance)}</strong>,
      },
    })),
    ...(i.rows.length === 0
      ? [{ key: `${i.itemId}-none`, cells: { what: <em>No movement in this period</em>, bal: <strong>{qty(i.closing)}</strong> } }]
      : []),
  ])

  const withThem = data.withJobWorkers
  const held = items.filter((i) => i.closing > 0.0005).length

  // Laid out like the purchase order (27 Nov 2026): the customer in the "To,"
  // block with the statement's facts beside it, their material item by item,
  // then where it is, what is out with job workers and every movement.
  return (
    <StoreSheet
      company={company}
      title={template.title}
      number={customer.code}
      dateLabel="Period"
      date={`${period.from ? longDate(period.from) : 'From the start'} – ${longDate(period.to)}`}
      backHref="/inventory/customer-material"
      backLabel="Customer material"
      options={options}
      party={{
        name: customer.name,
        code: customer.code,
        lines: (
          <>
            <PartyLine label="Address-" value={address || null} />
            <PartyLine label="GST No" value={customer.gstin ?? 'Unregistered'} mono={Boolean(customer.gstin)} />
            <PartyLine label="Contact No" value={customer.phone} mono />
          </>
        ),
        meta: [
          ['Date', shortDate(new Date()), true],
          ['Period', `${period.from ? shortDate(period.from) : 'From the start'} – ${shortDate(period.to)}`, true],
          ['Store moves', data.showMoves ? 'Shown' : 'Not shown'],
          ['Items', String(items.length), true],
          ['Still with us', `${held} ${held === 1 ? 'item' : 'items'}`],
          ['At job work', withThem.length ? `${withThem.length} ${withThem.length === 1 ? 'line' : 'lines'}` : 'Nothing'],
        ],
      }}
      columns={columns}
      rows={rows}
      after={
        <>
          {items.length === 0 && (
            <p style={{ fontSize: '10px', margin: 0, padding: '8px 0' }}>No material of {customer.name}&apos;s has moved in this period.</p>
          )}
          {whereRows.length > 0 && (
            <GroupTable
              title="Where it is now"
              note={`as on ${longDate(period.to)}`}
              columns={[
                { key: 'item', head: 'Item', width: '45%' },
                { key: 'store', head: 'Store', width: '35%' },
                { key: 'qty', head: 'Quantity', width: '20%', align: 'right' },
              ]}
              rows={whereRows}
            />
          )}
          {withThem.length > 0 && (
            <GroupTable
              title="Out with job workers"
              note="sent on a job-work challan and not yet accounted for"
              columns={[
                { key: 'challan', head: 'Challan', width: '15%' },
                { key: 'date', head: 'Sent on', width: '11%' },
                { key: 'worker', head: 'Job worker · process', width: '23%' },
                { key: 'item', head: 'Item', width: '21%' },
                { key: 'sent', head: 'Sent', width: '10%', align: 'right' },
                { key: 'pending', head: 'Still there', width: '10%', align: 'right' },
                { key: 'due', head: 'Due back', width: '10%' },
              ]}
              rows={withThem.map((l, n) => ({
                key: `${l.challanNumber}-${n}`,
                cells: {
                  challan: <span style={CODE}>{l.challanNumber}</span>,
                  date: shortDate(l.challanDate),
                  worker: (
                    <>
                      <div style={{ fontWeight: 600 }}>{l.jobWorker}</div>
                      <SubLine>{l.process}</SubLine>
                    </>
                  ),
                  item: (
                    <>
                      {l.item}
                      {itemShade(l) && <SubLine>{itemShade(l)}</SubLine>}
                    </>
                  ),
                  sent: `${qty(l.sent)} ${l.uom}`,
                  pending: <strong>{`${qty(l.pending)} ${l.uom}`}</strong>,
                  due: shortDate(l.expectedBackOn) ?? <Dash />,
                },
              }))}
            />
          )}
          {items.length > 0 && (
            <GroupTable
              title="Every movement"
              note="item by item, with the document it was on"
              columns={[
                { key: 'date', head: 'Date', width: '11%' },
                { key: 'doc', head: 'Document', width: '15%' },
                { key: 'what', head: 'What happened', width: '41%' },
                { key: 'in', head: 'In', width: '11%', align: 'right' },
                { key: 'out', head: 'Out', width: '10%', align: 'right' },
                { key: 'bal', head: 'Balance', width: '12%', align: 'right' },
              ]}
              rows={moveRows}
            />
          )}
          <Box title="Note" style={{ marginTop: '9px' }}>
            {template.declaration ??
              `This statement is drawn from ${company.name}'s stock records of material belonging to ${customer.name}, held by us for job work. It remains your property throughout. Please tell us of any difference within seven days of receiving it.`}
          </Box>
        </>
      }
      signatures={[
        { role: 'Prepared by (store)', who: null },
        { role: `For ${company.name}`, who: null },
      ]}
      footerNote={template.footerNote ?? 'Statement of customer material. Not a tax document.'}
    />
  )
}

export default function CustomerMaterialStatementPage() {
  return (
    <Suspense fallback={<p style={{ padding: 48, color: MUTED }}>Opening…</p>}>
      <Statement />
    </Suspense>
  )
}
