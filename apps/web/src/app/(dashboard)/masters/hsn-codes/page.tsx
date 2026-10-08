'use client'

import { useState } from 'react'
import { AlertCircle, CheckCircle2, ListPlus, Loader2, X } from 'lucide-react'
import { api, apiErrorMessage, can } from '@/lib/api'
import { ActiveBadge, MasterTable, type Column, type FilterDef } from '@/components/masters/MasterTable'
import type { FormField } from '@/components/masters/MasterFormDialog'

/**
 * HSN / SAC codes and the GST each carries.
 *
 * The rate is set here once per code instead of on every item. Order, bill
 * and note screens fill GST in from the item, and the item now takes its rate
 * from this list through its HSN code (an item whose code is not listed keeps
 * the rate set on the item). Only the total rate is entered: within
 * Maharashtra it is split half CGST and half SGST, across states it is all
 * IGST, so the three can never disagree.
 */

interface HsnCode {
  id: string
  code: string
  description: string
  kind: 'GOODS' | 'SERVICES'
  gstRate: string | number
  priceLimit: string | number | null
  rateAbove: string | number | null
  effectiveFrom: string | null
  notes: string | null
  isActive: boolean
}

interface FillResult {
  created: Array<{ code: string; gstRate: number; description: string }>
  skipped: Array<{ code: string; reason: string; items: number }>
}

/** 5 → "5%", 2.5 → "2.5%". */
const pct = (n: number) => `${Number(n.toFixed(2))}%`

const rupees = (n: number) =>
  `₹${n.toLocaleString('en-IN', { maximumFractionDigits: 2 })}`

const columns: Column<HsnCode>[] = [
  {
    key: 'code',
    header: 'Code',
    sortable: true,
    className: 'whitespace-nowrap font-mono text-xs text-teal-400',
  },
  { key: 'description', header: 'Description', sortable: true, className: 'font-medium' },
  {
    key: 'kind',
    header: 'Type',
    render: (h) =>
      h.kind === 'SERVICES' ? (
        <span className="badge-purple">Service · SAC</span>
      ) : (
        <span className="badge-info">Goods · HSN</span>
      ),
  },
  {
    key: 'gstRate',
    header: 'GST',
    align: 'right',
    sortable: true,
    render: (h) => <span className="font-semibold tabular-nums">{pct(Number(h.gstRate))}</span>,
  },
  {
    key: 'withinState',
    header: 'Within state',
    align: 'right',
    render: (h) => {
      const half = Number(h.gstRate) / 2
      return (
        <span className="text-muted-foreground whitespace-nowrap text-xs tabular-nums">
          CGST {pct(half)} + SGST {pct(half)}
        </span>
      )
    },
  },
  {
    key: 'otherState',
    header: 'Other state',
    align: 'right',
    render: (h) => (
      <span className="text-muted-foreground whitespace-nowrap text-xs tabular-nums">
        IGST {pct(Number(h.gstRate))}
      </span>
    ),
  },
  {
    key: 'slab',
    header: 'Price slab',
    render: (h) =>
      h.priceLimit != null && h.rateAbove != null ? (
        <span className="whitespace-nowrap text-xs">
          above {rupees(Number(h.priceLimit))} a piece: <b>{pct(Number(h.rateAbove))}</b>
        </span>
      ) : (
        <span className="text-muted-foreground">—</span>
      ),
  },
  { key: 'isActive', header: 'Status', render: (h) => <ActiveBadge isActive={h.isActive} /> },
]

/*
 * Two rows on a wide screen:
 *
 *   Code | Type | Description ..........
 *   GST % | Price per piece above | GST above that | Effective from
 *   Notes ...............................
 */
const formFields: FormField[] = [
  {
    name: 'code',
    label: 'HSN / SAC Code',
    required: true,
    placeholder: '5208',
    help: '4 to 8 digits. Service (SAC) codes start with 99.',
  },
  {
    name: 'kind',
    label: 'Type',
    type: 'select',
    help: 'Left empty, it is saved as Goods.',
    options: [
      { value: 'GOODS', label: 'Goods (HSN)' },
      { value: 'SERVICES', label: 'Service (SAC)' },
    ],
  },
  {
    name: 'description',
    label: 'Description',
    required: true,
    placeholder: 'Woven cotton fabric',
    span: 2,
  },
  {
    name: 'gstRate',
    label: 'GST %',
    type: 'number',
    required: true,
    placeholder: '5',
    help: 'The total rate. It is split for you on every document.',
    liveHelp: (v) => {
      const n = Number(v)
      if (v === '' || v == null || !Number.isFinite(n)) return null
      return `Within state CGST ${pct(n / 2)} + SGST ${pct(n / 2)} · other state IGST ${pct(n)}`
    },
  },
  {
    name: 'priceLimit',
    label: 'Price per piece above (₹)',
    type: 'number',
    placeholder: '2500',
    help: 'Only for a rate that depends on the price, like garments. Leave empty otherwise.',
  },
  {
    name: 'rateAbove',
    label: 'GST % above that price',
    type: 'number',
    placeholder: '18',
  },
  {
    name: 'effectiveFrom',
    label: 'Effective from',
    type: 'date',
    // The server sends a full timestamp; a date box only takes the day.
    initial: (r) => (r.effectiveFrom ? String(r.effectiveFrom).slice(0, 10) : ''),
  },
  { name: 'notes', label: 'Notes', placeholder: 'Notification or circular it comes from', span: 3 },
  { name: 'isActive', label: 'Active', type: 'checkbox', placeholder: 'Used for GST on items' },
]

const filterDefs: FilterDef[] = [
  {
    key: 'kind',
    label: 'Type',
    facet: 'kind',
    options: [
      { value: 'GOODS', label: 'Goods (HSN)' },
      { value: 'SERVICES', label: 'Service (SAC)' },
    ],
  },
]

export default function HsnCodesPage() {
  const [refreshKey, setRefreshKey] = useState(0)
  const [filling, setFilling] = useState(false)
  const [result, setResult] = useState<FillResult | null>(null)
  const [error, setError] = useState<string | null>(null)

  /*
   * Starts the list from the codes the items already carry, with the rate on
   * those items. Codes whose items disagree, or carry no rate, come back as a
   * list to add by hand rather than being guessed. Nothing already listed is
   * touched, so pressing it twice is harmless.
   */
  const fillFromItems = async () => {
    setFilling(true)
    setError(null)
    setResult(null)
    try {
      const res = await api.post<{ data: FillResult }>('/masters/hsn-codes/from-items', {})
      setResult(res.data)
      setRefreshKey((k) => k + 1)
    } catch (err) {
      setError(apiErrorMessage(err, 'Could not read the codes off the items.'))
    } finally {
      setFilling(false)
    }
  }

  return (
    <div className="space-y-4">
      {(result || error) && (
        <div
          className={`glass-card flex items-start gap-3 p-4 text-sm ${
            error ? 'border-red-500/40' : 'border-teal-500/30'
          }`}
        >
          {error ? (
            <AlertCircle size={18} className="mt-0.5 shrink-0 text-red-400" />
          ) : (
            <CheckCircle2 size={18} className="mt-0.5 shrink-0 text-teal-400" />
          )}
          <div className="min-w-0 flex-1 space-y-1.5">
            {error ? (
              <p className="text-red-400">{error}</p>
            ) : result && (
              <>
                <p className="text-foreground font-medium">
                  {result.created.length
                    ? `Added ${result.created.length} code${result.created.length === 1 ? '' : 's'} from your items.`
                    : 'No new codes to add — every code on your items is already listed or needs a look.'}
                </p>
                {result.created.length > 0 && (
                  <p className="text-muted-foreground text-xs">
                    {result.created.map((c) => `${c.code} (${pct(c.gstRate)})`).join(' · ')}
                  </p>
                )}
                {result.skipped.length > 0 && (
                  <div className="text-xs">
                    <p className="text-amber-500">Add these by hand — they need a decision:</p>
                    <ul className="text-muted-foreground mt-1 space-y-0.5">
                      {result.skipped.map((s) => (
                        <li key={s.code}>
                          <span className="text-foreground font-mono">{s.code}</span> — {s.reason} (
                          {s.items} item{s.items === 1 ? '' : 's'})
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </>
            )}
          </div>
          <button
            type="button"
            className="btn-ghost p-1"
            onClick={() => {
              setResult(null)
              setError(null)
            }}
            aria-label="Dismiss"
          >
            <X size={15} />
          </button>
        </div>
      )}

      <MasterTable<HsnCode>
        title="HSN / SAC Codes"
        entityName="HSN / SAC Code"
        resource="hsn-codes"
        columns={columns}
        formFields={formFields}
        formColumns={4}
        filterDefs={filterDefs}
        refreshKey={refreshKey}
        defaultSort="code"
        actions={
          can('masters', 'create') ? (
            <button
              type="button"
              className="btn-secondary"
              onClick={() => void fillFromItems()}
              disabled={filling}
              title="Add the codes your items already use, with the GST rate on those items"
            >
              {filling ? <Loader2 size={16} className="animate-spin" /> : <ListPlus size={16} />}
              Fill from items
            </button>
          ) : undefined
        }
        searchPlaceholder="Search code or description..."
        emptyMessage="No HSN codes yet. Press Fill from items to start from the codes your items use, or add one."
      />
    </div>
  )
}
