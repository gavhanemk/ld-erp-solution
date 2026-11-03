import type { FormField } from '@/components/masters/MasterFormDialog'
import { createUomFrom } from '@/components/masters/uomFormFields'
import { createHsnFrom } from '@/components/masters/hsnFormFields'

/*
 * The Items master's form, in one place: Masters → Items shows it, and a BOM
 * adds a component through the same form without leaving the BOM, so an item
 * made either way is made by the same rules.
 */

/** Each item type's name, and the badge the Items list shows it in. */
export const ITEM_TYPE_LABEL: Record<string, { label: string; cls: string }> = {
  RAW_MATERIAL: { label: 'Raw Material', cls: 'badge-info' },
  SEMI_FINISHED: { label: 'Semi Finished', cls: 'badge-warning' },
  FINISHED_GOOD: { label: 'Finished Good', cls: 'badge-success' },
  CONSUMABLE: { label: 'Consumable', cls: 'badge-neutral' },
  PACKING_MATERIAL: { label: 'Packing', cls: 'badge-neutral' },
  TRIM: { label: 'Trim', cls: 'badge-purple' },
}

/** A main category is one with no parent; a sub-category sits under one. */
const isMain = (row: Record<string, unknown>) => !row.parentId

/*
 * Four to a row, in two panels, so the whole item fits on one screen:
 *
 *   Item name ........... | Item type   | Unit
 *   Category | Sub category | HSN
 *   Style | Colour                        (a finished good only)
 *   Description ...........................
 *   Standard rate | Reorder level | Minimum | Maximum
 *
 * Category and Sub Category are two boxes over the one `categoryId` the item
 * is filed under: the sub-category when there is one, the main category when
 * there is not.
 *
 * There is no Department box: the server takes the department from the
 * category (the sub-category's own, or else its main category's).
 */
export const itemFormFields: FormField[] = [
  { name: 'code', label: 'Item Code', generated: true, section: 'Identity' },
  {
    name: 'name',
    label: 'Item Name',
    required: true,
    placeholder: 'Cotton Poplin 40s',
    section: 'Identity',
    span: 2,
  },
  {
    name: 'type',
    label: 'Item Type',
    type: 'select',
    required: true,
    section: 'Identity',
    options: Object.entries(ITEM_TYPE_LABEL).map(([value, v]) => ({ value, label: v.label })),
  },
  {
    name: 'uomId',
    label: 'Unit of Measure',
    type: 'select',
    required: true,
    section: 'Identity',
    optionsFrom: { resource: 'uoms' },
    // A unit not in the list is added here and kept in Masters → Units of Measure.
    createFrom: createUomFrom,
  },
  {
    name: 'mainCategoryId',
    label: 'Category',
    type: 'select',
    required: true,
    section: 'Identity',
    sendAs: 'categoryId',
    resets: ['subCategoryId'],
    optionsFrom: { resource: 'item-categories', filter: isMain },
    initial: (r) => {
      const c = r.category as { parentId?: string | null } | null
      return c?.parentId ?? r.categoryId
    },
  },
  {
    name: 'subCategoryId',
    label: 'Sub Category',
    type: 'select',
    section: 'Identity',
    sendAs: 'categoryId',
    emptyLabel: 'None under this category',
    mustFill: 'ifOptions',
    optionsFrom: {
      resource: 'item-categories',
      filter: (row, values) => Boolean(values.mainCategoryId) && row.parentId === values.mainCategoryId,
    },
    initial: (r) => {
      const c = r.category as { parentId?: string | null } | null
      return c?.parentId ? r.categoryId : ''
    },
  },
  {
    name: 'hsnCode',
    label: 'HSN Code',
    section: 'Identity',
    placeholder: '52081200',
    // Offered from the HSN list as you type, with each code's GST beside it.
    // A code not listed yet can still be typed.
    suggestFrom: {
      resource: 'hsn-codes',
      valueKey: 'code',
      label: (r) => `${String(r.description ?? '')} · GST ${Number(r.gstRate)}%`,
      notListed: (code) => `${code} is not in Masters → HSN / SAC Codes yet, so it carries no GST rate.`,
    },
    // A code not listed yet is added to Masters → HSN / SAC Codes from here,
    // over this form, and put in the box.
    createFrom: createHsnFrom,
    help: 'GST comes from this code in Masters → HSN / SAC Codes',
  },
  {
    name: 'styleId',
    label: 'Style',
    type: 'select',
    required: true,
    section: 'Identity',
    optionsFrom: { resource: 'styles' },
    showIf: (v) => v.type === 'FINISHED_GOOD',
    help: 'Which garment this is — the item becomes that style in one colour',
  },
  {
    name: 'color',
    label: 'Colour',
    type: 'select',
    required: true,
    section: 'Identity',
    optionsFromField: { field: 'styleId', resource: 'styles', arrayKey: 'colors' },
    showIf: (v) => v.type === 'FINISHED_GOOD' && Boolean(v.styleId),
    help: "One of the style's own colours — add more on the Style if it isn't listed",
  },
  { name: 'description', label: 'Description', type: 'textarea', section: 'Identity' },
  {
    name: 'standardRate',
    label: 'Standard Rate (₹)',
    type: 'number',
    section: 'Costing & Stock',
    placeholder: '145.50',
    help: 'Used to cost a BOM',
  },
  {
    name: 'reorderLevel',
    label: 'Reorder Level',
    type: 'number',
    section: 'Costing & Stock',
    placeholder: '500',
    help: 'Alert when stock falls below this',
  },
  { name: 'minStock', label: 'Minimum Stock', type: 'number', section: 'Costing & Stock' },
  { name: 'maxStock', label: 'Maximum Stock', type: 'number', section: 'Costing & Stock' },
  // How its QR stickers start out after an inward. The sticker window can
  // change them, and its "Remember" tick saves the change back here.
  {
    name: 'packType',
    label: 'Sticker package',
    type: 'select',
    options: [
      { value: 'ROLL', label: 'Roll' },
      { value: 'BOX', label: 'Box' },
      { value: 'CARTON', label: 'Carton' },
      { value: 'BAG', label: 'Bag' },
      { value: 'BUNDLE', label: 'Bundle' },
      { value: 'PACKET', label: 'Packet' },
      { value: 'OTHER', label: 'Other' },
    ],
    noneLabel: 'As the category says',
    section: 'Costing & Stock',
    showIf: (v) => v.type !== 'FINISHED_GOOD',
    help: 'What one stickered package of it is',
  },
  {
    name: 'packQty',
    label: 'Qty per Sticker',
    type: 'number',
    section: 'Costing & Stock',
    placeholder: '100',
    showIf: (v) => v.type !== 'FINISHED_GOOD',
    help: 'Empty: a sticker per roll or box, else one for the lot',
  },
  // What is inside one unit, so a sticker on a box says how many pieces.
  {
    name: 'contentQty',
    label: 'One Unit Holds',
    type: 'number',
    section: 'Costing & Stock',
    placeholder: '144',
    showIf: (v) => v.type !== 'FINISHED_GOOD',
    help: 'A box of 144 buttons: 144. Printed on its stickers',
  },
  {
    name: 'contentUnit',
    label: 'Of',
    type: 'text',
    section: 'Costing & Stock',
    placeholder: 'pcs',
    showIf: (v) => v.type !== 'FINISHED_GOOD',
    help: 'pcs, m, gross… Empty means pcs',
  },
  { name: 'isActive', label: 'Active', type: 'checkbox', placeholder: 'Available for new documents' },
]

