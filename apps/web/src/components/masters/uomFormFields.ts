import type { FormField } from '@/components/masters/MasterFormDialog'

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
