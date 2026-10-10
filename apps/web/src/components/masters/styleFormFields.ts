import type { FormField } from '@/components/masters/MasterFormDialog'

/*
 * The style form, shared by Masters → Styles and by "Add new style" on a
 * quotation, so a style added from either has the same fields and rules.
 */

export const BRAND_LABEL: Record<'LD_COTTON_MILLS' | 'VHAGAR' | 'CUSTOM', string> = {
  LD_COTTON_MILLS: 'LD Cotton Mills',
  VHAGAR: 'VHAGAR',
  CUSTOM: 'Custom',
}

/*
 * Four across, so the whole style fits without scrolling: what it is on the
 * first rows, how it is made on the next, and the size run beside its
 * colours on the last.
 */
export const styleFormFields: FormField[] = [
  { name: 'code', label: 'Style Code', required: true, placeholder: 'LD-SH-2701', section: 'Style' },
  {
    name: 'name',
    label: 'Style Name',
    required: true,
    placeholder: 'Slim Fit Formal Shirt',
    section: 'Style',
    span: 2,
  },
  {
    name: 'brandType',
    label: 'Brand',
    type: 'select',
    required: true,
    section: 'Style',
    options: Object.entries(BRAND_LABEL).map(([value, label]) => ({ value, label })),
  },
  { name: 'category', label: 'Garment Type', section: 'Style', placeholder: 'Shirt' },
  { name: 'season', label: 'Season', section: 'Style', placeholder: 'SS-26' },
  { name: 'fabricType', label: 'Fabric', section: 'Style', placeholder: 'Cotton Poplin' },
  { name: 'gsm', label: 'GSM', type: 'number', section: 'Style', placeholder: '120' },
  { name: 'collarType', label: 'Collar Type', section: 'Construction', placeholder: 'Cutaway' },
  { name: 'sleeveType', label: 'Sleeve Type', section: 'Construction', placeholder: 'Full sleeve' },
  { name: 'fit', label: 'Fit', section: 'Construction', placeholder: 'Slim' },
  {
    name: 'sizeGroupId',
    label: 'Size Run',
    type: 'select',
    section: 'Size & Colour',
    optionsFrom: { resource: 'size-groups' },
    help: 'The sizes it is cut in',
  },
  {
    name: 'colors',
    label: 'Colours',
    type: 'tags',
    section: 'Size & Colour',
    span: 3,
    placeholder: 'White, Sky Blue, Navy',
    help: 'Separate colours with commas',
  },
  { name: 'isActive', label: 'Active', type: 'checkbox', placeholder: 'Available for new orders', section: 'Size & Colour' },
]
