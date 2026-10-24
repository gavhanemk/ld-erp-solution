import type { FormField } from '@/components/masters/MasterFormDialog'

/*
 * The HSN / SAC code form, shared by Masters → HSN / SAC Codes and by "Add
 * new HSN code" in an item's HSN box, so a code added from an item form is
 * the same record, with the same rules, as one added on its own page.
 */

/** 5 → "5%", 2.5 → "2.5%". */
export const pct = (n: number) => `${Number(n.toFixed(2))}%`

/*
 * Two rows on a wide screen:
 *
 *   Code | Type | Description ..........
 *   GST % | Price per piece above | GST above that | Effective from
 *   Notes ...............................
 */
export const hsnFormFields: FormField[] = [
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
    max: 40,
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
    max: 40,
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

/**
 * "Add new HSN code" for an item's HSN box. Digits typed in the box start the
 * new code; words (a search by description) start its description instead.
 */
export const createHsnFrom: FormField['createFrom'] = {
  fields: hsnFormFields,
  title: 'HSN code',
  noun: 'HSN code',
  typedInto: (typed) => (/^\d+$/.test(typed) ? 'code' : 'description'),
}
