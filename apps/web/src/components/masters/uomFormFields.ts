import type { FormField } from '@/components/masters/MasterFormDialog'

/** How finely a quantity may be counted: shared by the unit and the item forms. */
export const QTY_PLACES_OPTIONS = [
  { value: '0', label: 'Whole numbers only' },
  { value: '1', label: 'Decimals, up to 1 place' },
  { value: '2', label: 'Decimals, up to 2 places' },
  { value: '3', label: 'Decimals, up to 3 places' },
]
export const QTY_PLACES_LABEL: Record<number, string> = { 0: 'Whole numbers', 1: 'Up to 1 decimal', 2: 'Up to 2 decimals', 3: 'Up to 3 decimals' }

/*
 * The unit of measure form, shared by Masters → Units of Measure and by "Add
 * new unit" in the Unit of Measure dropdowns, so a unit added from an item
 * form is the same record, with the same rules, as one added on its own page.
 */
export const uomFormFields: FormField[] = [
  {
    name: 'name',
    label: 'Unit Name',
    required: true,
    placeholder: 'Litre',
    help: 'As it is said: Meter, Kilogram, Cone',
  },
  {
    name: 'symbol',
    label: 'Symbol',
    placeholder: 'ltr',
    help: 'Optional. The short form printed beside quantities; left empty, the name is used',
  },
  {
    name: 'decimalPlaces',
    label: 'Quantities',
    type: 'select',
    options: QTY_PLACES_OPTIONS,
    valueForNew: '3',
    initial: (r) => (r.decimalPlaces == null ? '3' : String(r.decimalPlaces)),
    help: 'Whole numbers for things that only come whole (pieces, boxes, sets); decimals for things measured out (metres, kilograms)',
  },
  {
    name: 'isActive',
    label: 'Active',
    type: 'checkbox',
    placeholder: 'Offered in the Unit of Measure dropdowns',
  },
]

/** "Add new unit" for a Unit of Measure select on a master form. */
export const createUomFrom: FormField['createFrom'] = {
  fields: uomFormFields,
  title: 'Unit of measure',
  noun: 'unit',
}
