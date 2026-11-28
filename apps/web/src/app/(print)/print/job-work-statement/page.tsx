'use client'

import { Suspense, useEffect, useState } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { api, ApiError, masterResource } from '@/lib/api'
import {
  StoreSheet,
  Eyebrow,
  Note,
  PartyLine,
  TotalsBox,
  WordsAndTotals,
  qty,
  money,
  longDate,
  shortDate,
  CODE,
  INK,
  MUTED,
  NUM,
  type SheetColumn,
} from '@/components/print/StoreSheet'
import { HAIR, LINE, SubLine } from '@/components/print/doc'
import { SmartSelect } from '@/components/ui/SmartSelect'
import { itemShade, itemShadeCols, type ShadeFields } from '@/lib/items'

interface Line extends ShadeFields {
  id: string
  code: string
  item: string
  uom: string
  size: string | null
  customer: string | null
  sent: number
  accounted: number
  wasted: number
  damaged: number
  pending: number
  rate: number | null
  pendingValue: number | null
  returns: Array<{
    returnNumber: string
    returnDate: string
    theirChallanNo: string | null
    accounted: number
    received: number
    receivedCode: string
    receivedItem: string
    /** "Design No: 120 · Colour: Navy" of what it came back as, when that has one. */
    receivedShade?: string
    receivedUom: string
    wasted: number
    damaged: number
    store: string
  }>
}

interface Payload {
  company: Record<string, string | null>
  template: { title: string; footerNote: string | null; declaration: string | null }
  jobWorker: {
    id: string
    code: string
    name: string
    gstin: string | null
    phone: string | null
    address: string | null
    city: string | null
    state: string | null
    stateCode: string | null
    pincode: string | null
  }
  period: { from: string | null; to: string }
  openOnly: boolean
  challans: Array<{
    id: string
    challanNumber: string
    challanDate: string
    process: string
    expectedBackOn: string | null
    fromStore: string
    order: string | null
    mo: string | null
    state: 'OPEN' | 'OVERDUE' | 'SETTLED'
    lines: Line[]
  }>
  items: Array<{ code: string; item: string; uom: string; sent: number; accounted: number; wasted: number; damaged: number; pending: number; pendingValue: number } & ShadeFields>
  totals: { challans: number; open: number; overdue: number; pendingValue: number }
}

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
const STATE: Record<Payload['challans'][number]['state'], { text: string }> = {
  OPEN: { text: 'With them' },
  OVERDUE: { text: 'Overdue' },
  SETTLED: { text: 'Settled' },
}

const COLS: SheetColumn[] = [
  { key: 'sn', head: 'S.N', width: '5%', align: 'center' },
  { key: 'item', head: 'Item sent', width: '27%' },
  { key: 'uom', head: 'UOM', width: '6%', align: 'center' },
  { key: 'sent', head: 'Sent', width: '10%', align: 'right' },
  { key: 'accounted', head: 'Accounted for', width: '11%', align: 'right' },
  { key: 'wasted', head: 'Wasted', width: '9%', align: 'right' },
  { key: 'damaged', head: 'Damaged', width: '9%', align: 'right' },
  { key: 'pending', head: 'Still with them', width: '11%', align: 'right' },
  { key: 'value', head: 'Value (₹)', width: '12%', align: 'right' },
]

/**
 * A job worker's account of our material, to settle with them: every challan
 * sent in the period, what came back against each line and on which return,
 * what they wasted or spoiled, and what they still hold.
 */
function Statement() {
  const params = useSearchParams()
  const router = useRouter()
  const pathname = usePathname()
  const jobWorkerId = params.get('jobWorkerId') ?? ''
  const from = params.get('from') ?? ''
  const to = params.get('to') ?? ''
  const openOnly = params.get('open') === '1'

  const [workers, setWorkers] = useState<Array<{ id: string; name: string }>>([])
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
    masterResource<{ id: string; name: string }>('suppliers')
      .list({ limit: 500, sort: 'name', order: 'asc' })
      .then((r) => setWorkers(r.data))
      .catch(() => setWorkers([]))
  }, [])

  useEffect(() => {
    if (!jobWorkerId) {
      setData(null)
      return
    }
    const qs = new URLSearchParams()
    if (from) qs.set('from', from)
    if (to) qs.set('to', to)
    if (openOnly) qs.set('open', '1')
    setLoading(true)
    setError(null)
    api
      .get<{ data: Payload }>(`/inventory/statements/job-worker/${jobWorkerId}?${qs}`)
      .then((r) => setData(r.data))
      .catch((err) => setError(err instanceof ApiError ? err.message : 'Could not make the statement.'))
      .finally(() => setLoading(false))
  }, [jobWorkerId, from, to, openOnly])

  const exportExcel = async () => {
    if (!data) return
    const XLSX = await import('xlsx')
    const book = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(
      book,
      XLSX.utils.json_to_sheet(
        data.items.map((i) => ({
          'Item Code': i.code, Item: i.item, 'Design No.': itemShadeCols(i).designNo, Colour: itemShadeCols(i).colour, Unit: i.uom, Sent: i.sent, 'Accounted for': i.accounted,
          Wasted: i.wasted, Damaged: i.damaged, 'Still with them': i.pending, 'Value with them': i.pendingValue,
        })),
      ),
      'Summary',
    )
    XLSX.utils.book_append_sheet(
      book,
      XLSX.utils.json_to_sheet(
        data.challans.flatMap((c) =>
          c.lines.flatMap((l): Array<Record<string, string | number | null>> => {
            const base = {
              Challan: c.challanNumber, 'Sent on': longDate(c.challanDate), Process: c.process, State: STATE[c.state].text,
              'Item Code': l.code, Item: l.item, 'Design No.': itemShadeCols(l).designNo, Colour: itemShadeCols(l).colour, Size: l.size ?? '', "Customer's": l.customer ?? '', Sent: l.sent, Unit: l.uom,
            }
            if (!l.returns.length) return [{ ...base, 'Still with them': l.pending }]
            return l.returns.map((r, n) => ({
              ...base,
              ...(n ? { Sent: '' } : {}),
              Return: r.returnNumber, 'Back on': longDate(r.returnDate), 'Their challan': r.theirChallanNo ?? '',
              'Accounted for': r.accounted, 'Came back as': r.receivedShade ? `${r.receivedItem} (${r.receivedShade})` : r.receivedItem, Received: r.received, 'Received unit': r.receivedUom,
              Wasted: r.wasted, Damaged: r.damaged, 'Still with them': n === l.returns.length - 1 ? l.pending : '',
            }))
          }),
        ),
      ),
      'Challans',
    )
    XLSX.writeFile(book, `${data.jobWorker.name.replace(/[^\w]+/g, '-')}-job-work-statement-${today()}.xlsx`)
  }

  const options = (
    <>
      <label>
        Job worker
        <SmartSelect value={jobWorkerId} onChange={(e) => setParam('jobWorkerId', e.target.value)} aria-label="Job worker">
          <option value="">Pick a job worker…</option>
          {workers.map((w) => (
            <option key={w.id} value={w.id}>
              {w.name}
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
      <label>
        <input type="checkbox" checked={openOnly} onChange={(e) => setParam('open', e.target.checked ? '1' : '')} />
        Only challans still open
      </label>
      {data && (
        <button type="button" className="tb-btn" onClick={() => void exportExcel()}>
          Download Excel
        </button>
      )}
    </>
  )

  if (!jobWorkerId || !data) {
    return (
      <div style={{ maxWidth: '210mm', margin: '0 auto' }}>
        <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', alignItems: 'center', padding: '8px 12px', background: '#fff', borderRadius: 6, font: '13px Inter, system-ui, sans-serif', color: INK }}>
          {options}
        </div>
        <p style={{ padding: 32, color: error ? INK : '#fff', font: '14px Inter, system-ui, sans-serif' }}>
          {error ?? (jobWorkerId ? (loading ? 'Making the statement…' : '') : 'Pick a job worker to see their statement.')}
        </p>
      </div>
    )
  }

  const { company, template, jobWorker: w, period, challans, items, totals } = data
  const address = [w.address, w.city, w.state, w.pincode].filter(Boolean).join(', ')

  const rows = items.map((i, n) => ({
    key: `${i.code}-${i.uom}`,
    cells: {
      sn: n + 1,
      item: (
        <>
          <div style={{ fontWeight: 600 }}>{i.item}</div>
          {itemShade(i) && <SubLine>{itemShade(i)}</SubLine>}
          <SubLine style={CODE}>{i.code}</SubLine>
        </>
      ),
      uom: i.uom,
      sent: num(i.sent),
      accounted: num(i.accounted),
      wasted: num(i.wasted),
      damaged: num(i.damaged),
      pending: <strong>{num(i.pending)}</strong>,
      value: i.pendingValue ? money(i.pendingValue) : '—',
    },
  }))

  const challanRows: GroupRow[] = challans.flatMap((c) => [
    {
      key: `h-${c.id}`,
      heading: (
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: '10px' }}>
          <span style={{ minWidth: 0 }}>
            <span style={CODE}>{c.challanNumber}</span> · {shortDate(c.challanDate)} · {c.process}
            {c.order || c.mo ? <span style={{ fontWeight: 400 }}> · for {[c.order, c.mo].filter(Boolean).join(' / ')}</span> : null}
          </span>
          <span style={{ flexShrink: 0, ...NUM }}>
            {STATE[c.state].text}
            {c.expectedBackOn && c.state !== 'SETTLED' ? ` · due ${shortDate(c.expectedBackOn)}` : ''}
          </span>
        </div>
      ),
    },
    ...c.lines.flatMap((l) => {
      const name = (
        <>
          <div style={{ fontWeight: 600 }}>
            {l.item}
            {l.size ? ` · ${l.size}` : ''}
          </div>
          {itemShade(l) && <SubLine>{itemShade(l)}</SubLine>}
          {l.customer && <SubLine style={{ fontWeight: 700 }}>CUSTOMER MATERIAL · {l.customer}</SubLine>}
        </>
      )
      const sentRow: GroupRow = {
        key: `${l.id}-sent`,
        cells: { what: name, doc: 'Sent', qty: `${qty(l.sent)} ${l.uom}`, left: `${qty(l.sent)}` },
      }
      let left = l.sent
      const backRows: GroupRow[] = l.returns.map((r, n) => {
        left = Math.max(0, Math.round((left - r.accounted) * 1000) / 1000)
        const extra = [r.wasted ? `wasted ${qty(r.wasted)}` : '', r.damaged ? `damaged ${qty(r.damaged)}` : ''].filter(Boolean).join(', ')
        return {
          key: `${l.id}-${n}`,
          cells: {
            doc: (
              <>
                <span style={CODE}>{r.returnNumber}</span>
                <SubLine>
                  {shortDate(r.returnDate)}
                  {r.theirChallanNo ? ` · their ${r.theirChallanNo}` : ''}
                </SubLine>
              </>
            ),
            what: (
              <span>
                Back: {qty(r.received)} {r.receivedUom} {r.receivedCode !== l.code ? `as ${r.receivedItem}${r.receivedShade ? ` (${r.receivedShade})` : ''}` : ''} into {r.store}
                {extra ? ` · ${extra}` : ''}
              </span>
            ),
            qty: `−${qty(r.accounted)} ${l.uom}`,
            left: n === l.returns.length - 1 ? <strong>{qty(l.pending)}</strong> : qty(left),
          },
        }
      })
      return [sentRow, ...backRows]
    }),
  ])

  const note =
    template.declaration ??
    `Material sent to ${w.name} for job work under section 143 of the CGST Act, 2017, and what has been accounted for against it, from ${company.name}'s records. "Still with them" is to be returned or accounted for. Please tell us of any difference within seven days.`

  // Laid out like the purchase order (27 Nov 2026): the job worker in the "To,"
  // block with the statement's facts beside it, what they hold item by item,
  // the value with them beside the note, then challan by challan.
  return (
    <StoreSheet
      company={company}
      title={template.title}
      number={w.code}
      dateLabel="Period"
      date={`${period.from ? longDate(period.from) : 'From the start'} – ${longDate(period.to)}`}
      backHref="/inventory/job-work"
      backLabel="Job work"
      options={options}
      party={{
        name: w.name,
        code: w.code,
        lines: (
          <>
            <PartyLine label="Address-" value={address || null} />
            <PartyLine label="GST No" value={w.gstin ?? 'Unregistered'} mono={Boolean(w.gstin)} />
            <PartyLine label="Contact No" value={w.phone} mono />
          </>
        ),
        meta: [
          ['Date', shortDate(new Date()), true],
          ['Period', `${period.from ? shortDate(period.from) : 'From the start'} – ${shortDate(period.to)}`, true],
          ['Showing', data.openOnly ? 'Open challans' : 'Every challan'],
        ],
      }}
      columns={COLS}
      rows={rows}
      after={
        <>
          {challans.length === 0 && (
            <p style={{ fontSize: '10px', margin: 0, padding: '8px 0 0' }}>No job-work challans to {w.name} in this period.</p>
          )}
          <WordsAndTotals
            left={<Note title="Note">{note}</Note>}
            totals={
              <TotalsBox
                rows={[
                  { label: 'Challans', value: totals.challans },
                  { label: 'Still open', value: totals.open },
                  { label: 'Overdue', value: totals.overdue },
                ]}
                totalLabel="Value with them"
                total={`₹ ${money(totals.pendingValue)}`}
              />
            }
          />
          {challans.length > 0 && (
            <GroupTable
              title="Challan by challan"
              note="what was sent, and each return against it"
              columns={[
                { key: 'doc', head: 'Document', width: '18%' },
                { key: 'what', head: 'Item / what came back', width: '52%' },
                { key: 'qty', head: 'Sent / settled', width: '17%', align: 'right' },
                { key: 'left', head: 'Left', width: '13%', align: 'right' },
              ]}
              rows={challanRows}
            />
          )}
        </>
      }
      signatures={[
        { role: `For ${company.name}`, who: null },
        { role: `Agreed by ${w.name}`, who: null },
      ]}
      footerNote={template.footerNote ?? 'Statement of job-work material. Not a tax document.'}
    />
  )
}

export default function JobWorkStatementPage() {
  return (
    <Suspense fallback={<p style={{ padding: 48, color: MUTED }}>Opening…</p>}>
      <Statement />
    </Suspense>
  )
}
