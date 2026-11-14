'use client'

import { chargeConfigOf, type ChargeMasterConfig, CHARGE_GST_MODE_LABEL, CHARGE_TAX_TREATMENT_LABEL, type ChargeGstMode, type ChargeTaxTreatment } from '@ld-erp/shared'
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
interface ChargeType extends ChargeMasterConfig {
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
  taxReviewRequired?: boolean
  isActive: boolean
  taxTreatment: ChargeTaxTreatment
  followsGoodsRate: boolean
  /** How a purchase order or bill starts this charge's GST; authorized users can override it in Advanced Tax Settings. */
  defaultGstMode: ChargeGstMode
  defaultHsnCodeId: string | null
  defaultHsnCode?: { code: string; gstRate?: string | number } | null
  /** The chosen SAC's own rate, sent alongside so the column needs no second lookup. */
  defaultHsnRate: number | null
}

function describeTax(c: ChargeType, side: 'sales' | 'purchase') {
  if (!(side === 'sales' ? c.applyOnSale : c.applyOnPurchase)) return <span>-</span>
  const cfg = chargeConfigOf(c, side)
  const zero = !['TAXABLE', 'UNSPECIFIED'].includes(cfg.taxCategory)
  return <span>{zero ? cfg.taxCategory.replace('_', ' ') : cfg.followsGoodsRate ? "Goods' rates" : cfg.hsnCode ? `${cfg.hsnCode} / ${cfg.ownRate}%` : `${cfg.ownRate}%`}
    <span className="text-muted-foreground"> / {cfg.treatment === 'INCLUSIVE' ? 'GST-inclusive' : 'GST-exclusive'}</span></span>
}

const columns: Column<ChargeType>[] = [
  { key: 'name', header: 'Charge', sortable: true, className: 'font-medium' },
  {
    key: 'defaultGstRate',
    header: 'Own GST fallback',
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
    key: 'taxTreatment', header: 'GST on a sale', render: c => describeTax(c, 'sales'),
  },
  { key: 'defaultGstMode', header: 'GST on a purchase', render: c => describeTax(c, 'purchase') },
  { key: 'taxReviewRequired', header: 'Tax review', render: (c) => c.taxReviewRequired ? <span className="warn-text">Administrator review needed</span> : <span>Reviewed</span> },
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
    valueForNew: 'EXCLUSIVE',
    options: [
      { value: 'INCLUSIVE', label: 'GST included in the amount typed' },
      { value: 'EXCLUSIVE', label: 'GST added on top of the amount' },
      { value: 'NON_TAXABLE', label: 'No GST on it' },
    ],
    help: 'Default amount type for a sales charge — authorized users can override it in Advanced Tax Settings',
  },
  {
    name: 'followsGoodsRate',
    label: 'Rate on a sale',
    type: 'checkbox',
    checkedForNew: false,
    placeholder: "Take the goods' GST rate",
    help: 'Select only when this charge is incidental to the goods supply. Untick to use the GST % above',
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
      { value: 'INHERIT', label: 'Inherit from goods (incidental charge)' },
      { value: 'MANUAL', label: 'A % I set' },
      { value: 'NONE', label: 'Not applicable' },
    ],
    help: 'How a purchase order or bill starts this charge — authorized users can override it in Advanced Tax Settings',
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
    name: 'salesHsnCodeId', label: 'Own sales HSN / SAC', type: 'select',
    optionsFrom: { resource: 'hsn-codes', labelKey: 'code' },
    help: 'For a separately classified charge, turn off goods inheritance and select its classification here.',
  },
  {
    name: 'purchaseTaxTreatment', label: 'Purchase amount includes GST?', type: 'select', valueForNew: 'EXCLUSIVE',
    options: [{ value: 'EXCLUSIVE', label: 'GST-exclusive (add tax)' }, { value: 'INCLUSIVE', label: 'GST-inclusive (extract tax)' }],
  },
  ...(['sales', 'purchase'] as const).map((side): FormField => ({
    name: `${side}TaxCategory`, label: `${side === 'sales' ? 'Sales' : 'Purchase'} tax classification`,
    type: 'select', valueForNew: 'TAXABLE', required: true,
    options: [{ value: 'TAXABLE', label: 'Taxable' }, { value: 'EXEMPT', label: 'Exempt' },
      { value: 'NIL_RATED', label: 'Nil-rated' }, { value: 'NON_GST', label: 'Non-GST' },
      { value: 'UNSPECIFIED', label: 'Unclassified legacy setting - review required' }],
  })),
  { name: 'taxReviewRequired', label: 'Tax configuration needs review', type: 'checkbox',
    help: 'Existing records are flagged for review. Clear after confirming classification on both sides.' },
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
