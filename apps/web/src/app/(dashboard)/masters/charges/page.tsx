'use client'

import { CHARGE_GST_MODE_LABEL, CHARGE_TAX_TREATMENT_LABEL, type ChargeGstMode, type ChargeTaxTreatment } from '@ld-erp/shared'
import { ActiveBadge, MasterTable, type Column } from '@/components/masters/MasterTable'
import type { FormField } from '@/components/masters/MasterFormDialog'

/**
 * Chargeable extras.
 *
 * Transport, freight and dyeing billed with the goods. On a sale each one
 * says how GST sits on the amount typed — included in it (the usual case:
 * the figure agreed is the figure paid), added on top, or none — and
 * whether it takes the goods' rate (GST law, for a charge billed with the
 * goods) or the GST % set here. A sales order or quotation row starts
 * with these and can change them for that one document.
 */
interface ChargeType {
  id: string
  name: string
  defaultGstRate: string | number
  /**
   * How big the charge usually is, as a share of the order — not the tax on
   * it. Purely a suggestion: it is what the percentage helper on a purchase
   * order opens at, and nothing applies it on its own.
   */
  percentOfValue: string | number
  applyOnSale: boolean
  applyOnPurchase: boolean
  isActive: boolean
  taxTreatment: ChargeTaxTreatment
  followsGoodsRate: boolean
  /** How a purchase order or bill starts this charge's GST; each row can still change it. */
  defaultGstMode: ChargeGstMode
  defaultHsnCodeId: string | null
  defaultHsnCode?: { code: string } | null
  /** The chosen SAC's own rate, sent alongside so the column needs no second lookup. */
  defaultHsnRate: number | null
}

const columns: Column<ChargeType>[] = [
  { key: 'name', header: 'Charge', sortable: true, className: 'font-medium' },
  {
    key: 'defaultGstRate',
    header: 'GST',
    align: 'right',
    sortable: true,
    render: (c) => <span className="font-semibold">{Number(c.defaultGstRate)}%</span>,
  },
  {
    key: 'percentOfValue',
    header: 'Usual size',
    align: 'right',
    sortable: true,
    /* Dashed rather than 0% when unset, because 0% would read as a decision
       somebody made and this is the absence of one. */
    render: (c) =>
      Number(c.percentOfValue) > 0 ? (
        <span className="tabular-nums">{Number(c.percentOfValue)}% of order</span>
      ) : (
        <span className="text-muted-foreground">—</span>
      ),
  },
  {
    key: 'where',
    header: 'Appears on',
    render: (c) => {
      const on = [c.applyOnSale && 'Sales', c.applyOnPurchase && 'Purchases'].filter(Boolean)
      return on.length ? (
        <div className="flex gap-1">
          {on.map((label) => (
            <span key={String(label)} className="badge-info">
              {label}
            </span>
          ))}
        </div>
      ) : (
        <span className="text-muted-foreground">Nowhere — tick one below</span>
      )
    },
  },
  {
    key: 'taxTreatment',
    header: 'GST on a sale',
    render: (c) =>
      c.applyOnSale ? (
        <span>
          {CHARGE_TAX_TREATMENT_LABEL[c.taxTreatment] ?? c.taxTreatment}
          {c.taxTreatment !== 'NON_TAXABLE' && (
            <span className="text-muted-foreground"> · {c.followsGoodsRate ? "goods' rate" : `${Number(c.defaultGstRate)}%`}</span>
          )}
        </span>
      ) : (
        <span className="text-muted-foreground">—</span>
      ),
  },
  {
    key: 'defaultGstMode',
    header: 'GST on a purchase',
    render: (c) =>
      c.applyOnPurchase ? (
        <span>
          {CHARGE_GST_MODE_LABEL[c.defaultGstMode] ?? c.defaultGstMode}
          {c.defaultGstMode === 'HSN' && (
            <span className="text-muted-foreground">
              {' '}
              · {c.defaultHsnCode?.code ?? '—'}
              {c.defaultHsnRate != null && ` · ${c.defaultHsnRate}%`}
            </span>
          )}
        </span>
      ) : (
        <span className="text-muted-foreground">—</span>
      ),
  },
  { key: 'isActive', header: 'Status', render: (c) => <ActiveBadge isActive={c.isActive} /> },
]

const formFields: FormField[] = [
  {
    name: 'name',
    label: 'Charge',
    required: true,
    placeholder: 'Freight / Courier',
    span: 2,
    help: 'One entry per kind of charge — the rate is set below, not in the name',
  },
  {
    name: 'defaultGstRate',
    label: 'GST %',
    type: 'number',
    required: true,
    placeholder: '18',
    help: 'Freight often carries a different rate from the garment itself',
  },
  {
    name: 'percentOfValue',
    label: 'Usual % of order',
    type: 'number',
    placeholder: '5',
    help: 'Optional. Offered on a purchase order in one press — never applied on its own',
  },
  { name: 'applyOnSale', label: 'On sales', type: 'checkbox', placeholder: 'Offer on invoices' },
  {
    name: 'taxTreatment',
    label: 'GST on a sale',
    type: 'select',
    required: true,
    valueForNew: 'INCLUSIVE',
    options: [
      { value: 'INCLUSIVE', label: 'GST included in the amount typed' },
      { value: 'EXCLUSIVE', label: 'GST added on top of the amount' },
      { value: 'NON_TAXABLE', label: 'No GST on it' },
    ],
    help: 'How a sales order or quotation starts this charge — each row can still change it',
  },
  {
    name: 'followsGoodsRate',
    label: 'Rate on a sale',
    type: 'checkbox',
    checkedForNew: true,
    placeholder: "Take the goods' GST rate",
    help: 'A charge billed with the goods is taxed at their rate. Untick to use the GST % above',
  },
  {
    name: 'applyOnPurchase',
    label: 'On purchases',
    type: 'checkbox',
    placeholder: 'Offer on supplier bills',
  },
  {
    name: 'defaultGstMode',
    label: 'GST on a purchase',
    type: 'select',
    required: true,
    valueForNew: 'MANUAL',
    showIf: (v) => Boolean(v.applyOnPurchase),
    options: [
      { value: 'HSN', label: 'By HSN / SAC code' },
      { value: 'MANUAL', label: 'A % I set' },
      { value: 'NONE', label: 'Not applicable' },
    ],
    help: 'How a purchase order or bill starts this charge — each row can still change it',
  },
  {
    name: 'defaultHsnCodeId',
    label: 'Usual SAC',
    type: 'select',
    showIf: (v) => Boolean(v.applyOnPurchase) && v.defaultGstMode === 'HSN',
    optionsFrom: { resource: 'hsn-codes', labelKey: 'code' },
    emptyLabel: 'No SAC',
    help: 'From Masters → HSN / SAC Codes — 9965 for goods transport, say',
  },
  {
    name: 'isActive',
    label: 'Active',
    type: 'checkbox',
    placeholder: 'Available on new documents',
  },
]

export default function ChargeTypesPage() {
  return (
    <MasterTable<ChargeType>
      title="Extra Charges"
      entityName="Charge"
      resource="charge-types"
      columns={columns}
      formFields={formFields}
      defaultSort="name"
      searchPlaceholder="Search charges..."
      emptyMessage="No extra charges yet."
    />
  )
}
