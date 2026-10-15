'use client'

import { Suspense, useEffect, useState } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { api, ApiError, masterResource } from '@/lib/api'
import { StoreSheet, Fact, Eyebrow, qty, money, longDate, CODE, GREY, INK, MUTED, NAVY, RED, RULE, type SheetColumn } from '@/components/print/StoreSheet'
import { StatementTable, type StatementRow } from '@/components/print/StatementTable'
import { SmartSelect } from '@/components/ui/SmartSelect'

interface Line {
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
  items: Array<{ code: string; item: string; uom: string; sent: number; accounted: number; wasted: number; damaged: number; pending: number; pendingValue: number }>
  totals: { challans: number; open: number; overdue: number; pendingValue: number }
}

const today = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' })
const num = (v: number) => (Math.abs(v) < 0.0005 ? '—' : qty(v))
const STATE: Record<Payload['challans'][number]['state'], { text: string; colour: string }> = {
  OPEN: { text: 'With them', colour: NAVY },
  OVERDUE: { text: 'Overdue', colour: RED },
  SETTLED: { text: 'Settled', colour: GREY },
}

const COLS: SheetColumn[] = [
  { key: 'sn', head: 'S.N', width: '5%', align: 'center' },
  { key: 'item', head: 'Item sent', width: '31%' },
  { key: 'uom', head: 'UOM', width: '6%', align: 'center' },
  { key: 'sent', head: 'Sent', width: '10%', align: 'right' },
  { key: 'accounted', head: 'Accounted for', width: '11%', align: 'right' },
  { key: 'wasted', head: 'Wasted', width: '9%', align: 'right' },
  { key: 'damaged', head: 'Damaged', width: '9%', align: 'right' },
  { key: 'pending', head: 'Still with them', width: '11%', align: 'right' },
  { key: 'value', head: 'Value (₹)', width: '8%', align: 'right' },
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
          'Item Code': i.code, Item: i.item, Unit: i.uom, Sent: i.sent, 'Accounted for': i.accounted,
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
              'Item Code': l.code, Item: l.item, Size: l.size ?? '', "Customer's": l.customer ?? '', Sent: l.sent, Unit: l.uom,
            }
            if (!l.returns.length) return [{ ...base, 'Still with them': l.pending }]
            return l.returns.map((r, n) => ({
              ...base,
              ...(n ? { Sent: '' } : {}),
              Return: r.returnNumber, 'Back on': longDate(r.returnDate), 'Their challan': r.theirChallanNo ?? '',
              'Accounted for': r.accounted, 'Came back as': r.receivedItem, Received: r.received, 'Received unit': r.receivedUom,
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
          <div style={{ ...CODE, fontSize: '8.5px', color: GREY }}>{i.code}</div>
        </>
      ),
      uom: <span style={{ fontSize: '9px', color: GREY }}>{i.uom}</span>,
      sent: num(i.sent),
      accounted: num(i.accounted),
      wasted: num(i.wasted),
      damaged: num(i.damaged),
      pending: <strong>{num(i.pending)}</strong>,
      value: i.pendingValue ? money(i.pendingValue) : '—',
    },
  }))

  const challanRows: StatementRow[] = challans.flatMap((c) => [
    {
      key: `h-${c.id}`,
      heading: (
        <>
          <span style={CODE}>{c.challanNumber}</span> · {longDate(c.challanDate)} · {c.process}
          {c.order || c.mo ? <span style={{ fontWeight: 400, color: GREY }}> · for {[c.order, c.mo].filter(Boolean).join(' / ')}</span> : null}
          <span style={{ float: 'right', color: STATE[c.state].colour }}>
            {STATE[c.state].text}
            {c.expectedBackOn && c.state !== 'SETTLED' ? ` · due ${longDate(c.expectedBackOn)}` : ''}
          </span>
        </>
      ),
    },
    ...c.lines.flatMap((l) => {
      const name = (
        <>
          <div style={{ fontWeight: 600 }}>
            {l.item}
            {l.size ? ` · ${l.size}` : ''}
          </div>
          {l.customer && <div style={{ color: GREY, fontSize: '8.5px', fontWeight: 700 }}>CUSTOMER MATERIAL · {l.customer}</div>}
        </>
      )
      const sentRow: StatementRow = {
        key: `${l.id}-sent`,
        cells: { what: name, doc: <span style={{ color: GREY }}>Sent</span>, qty: `${qty(l.sent)} ${l.uom}`, left: `${qty(l.sent)}` },
      }
      let left = l.sent
      const backRows: StatementRow[] = l.returns.map((r, n) => {
        left = Math.max(0, Math.round((left - r.accounted) * 1000) / 1000)
        const extra = [r.wasted ? `wasted ${qty(r.wasted)}` : '', r.damaged ? `damaged ${qty(r.damaged)}` : ''].filter(Boolean).join(', ')
        return {
          key: `${l.id}-${n}`,
          cells: {
            doc: (
              <>
                <span style={CODE}>{r.returnNumber}</span>
                <div style={{ color: GREY, fontSize: '8.5px' }}>
                  {longDate(r.returnDate)}
                  {r.theirChallanNo ? ` · their ${r.theirChallanNo}` : ''}
                </div>
              </>
            ),
            what: (
              <span style={{ color: GREY }}>
                Back: {qty(r.received)} {r.receivedUom} {r.receivedCode !== l.code ? `as ${r.receivedItem}` : ''} into {r.store}
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
      panels={[
        {
          title: 'Job worker',
          body: (
            <>
              <div style={{ fontSize: '12px', fontWeight: 700, color: NAVY, lineHeight: 1.3 }}>{w.name}</div>
              {address && <div style={{ fontSize: '10px', color: GREY, lineHeight: 1.55, marginTop: '3px' }}>{address}</div>}
              <div style={{ marginTop: '4px' }}>
                <Fact label="GSTIN" value={w.gstin ?? 'Unregistered'} mono />
                <Fact label="Phone" value={w.phone} />
              </div>
            </>
          ),
        },
        {
          title: 'This statement',
          body: (
            <>
              <Fact label="From" value={period.from ? longDate(period.from) : 'The start'} />
              <Fact label="To" value={longDate(period.to)} />
              <Fact label="Printed on" value={longDate(new Date())} />
              <Fact label="Showing" value={data.openOnly ? 'Open challans' : 'Every challan'} />
            </>
          ),
        },
        {
          title: 'In short',
          body: (
            <>
              <Fact label="Challans" value={String(totals.challans)} />
              <Fact label="Still open" value={String(totals.open)} />
              <Fact label="Overdue" value={String(totals.overdue)} />
              <Fact label="Value with them" value={`₹${money(totals.pendingValue)}`} />
            </>
          ),
        },
      ]}
      columns={COLS}
      rows={rows}
      after={
        <>
          {challans.length === 0 && (
            <p style={{ fontSize: '10.5px', color: GREY, padding: '10px 0' }}>No job-work challans to {w.name} in this period.</p>
          )}
          {challans.length > 0 && (
            <StatementTable
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
          <div style={{ border: `1px solid ${RULE}`, padding: '7px 10px', marginTop: '10px' }}>
            <Eyebrow style={{ color: GREY }}>Note</Eyebrow>
            <div style={{ fontSize: '10px', color: INK, marginTop: '3px', lineHeight: 1.6 }}>
              {template.declaration ??
                `Material sent to ${w.name} for job work under section 143 of the CGST Act, 2017, and what has been accounted for against it, from ${company.name}'s records. "Still with them" is to be returned or accounted for. Please tell us of any difference within seven days.`}
            </div>
          </div>
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
