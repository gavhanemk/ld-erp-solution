import { createElement } from 'react'
import type { FormField } from '@/components/masters/MasterFormDialog'
import { WASH_CARE } from '@/components/packages/WashCare'
import { NextStyleCode } from '@/components/masters/NextStyleCode'

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
  /*
   * The code is made by the system, never typed: brand, garment type and
   * season year, then the next number — LD-SH-2606 — so no two styles share
   * one and every code reads the same way. While adding, the box shows the
   * code the style will get; once saved it sits in the title bar, locked,
   * because it is on documents by then.
   */
  { name: 'code', label: 'Style Code', generated: true, section: 'Style' },
  {
    name: 'codePreview',
    label: 'Style Code',
    type: 'readout',
    section: 'Style',
    showIf: (v) => !v.code,
    readout: (v) => createElement(NextStyleCode, { brandId: v.brandId, category: v.category, season: v.season }),
    help: 'Given on save, from brand, garment type and season',
  },
  {
    name: 'name',
    label: 'Style Name',
    required: true,
    placeholder: 'Slim Fit Formal Shirt',
    section: 'Style',
    span: 2,
  },
  // From the Brands master, so a brand added there (DCot) is offered here.
  // Its kind (LD Cotton Mills, VHAGAR, Custom) goes with it on save.
  {
    name: 'brandId',
    label: 'Brand',
    type: 'select',
    required: true,
    mustFill: true,
    section: 'Style',
    optionsFrom: { resource: 'brands' },
  },
  // Required: it is the SH or TR in the style code, which cannot change once saved.
  { name: 'category', label: 'Garment Type', mustFill: true, section: 'Style', placeholder: 'Shirt' },
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
  // What the retail tag says: the price, what it is made of, how to wash it.
  {
    name: 'mrp',
    label: 'MRP (₹)',
    type: 'number',
    section: 'Retail Label',
    placeholder: '1499',
    help: 'Inclusive of all taxes. A size can have its own under Barcodes',
  },
  { name: 'composition', label: 'Composition', section: 'Retail Label', placeholder: '100% Cotton', span: 2, help: 'Printed on the retail tag' },
  {
    name: 'washCare',
    label: 'Wash Care',
    type: 'chips',
    section: 'Retail Label',
    span: 3,
    options: WASH_CARE,
    help: 'Tick the symbols to print on the retail tag',
  },
]
