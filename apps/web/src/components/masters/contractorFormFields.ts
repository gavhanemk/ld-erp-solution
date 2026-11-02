import type { FormField } from '@/components/masters/MasterFormDialog'

/*
 * The contractor form, shared by Routing Masters → Contractors and by "Add
 * new contractor" on a routing step.
 */

export const contractorFormFields: FormField[] = [
  { name: 'code', label: 'Code', generated: true, section: 'Contractor' },
  { name: 'name', label: 'Name', required: true, placeholder: 'Ramesh Patil', section: 'Contractor', span: 2 },
  {
    name: 'operationIds',
    label: 'Processes',
    type: 'chips',
    required: true,
    mustFill: true,
    section: 'Contractor',
    span: 3,
    optionsFrom: { resource: 'operations' },
    help: 'Tick every process they take on: a routing step offers them for each',
  },
  { name: 'phone', label: 'Phone', section: 'Contractor', placeholder: '+91 98765 43210' },
  { name: 'notes', label: 'Notes', type: 'textarea', section: 'Contractor', span: 2, rows: 1, placeholder: 'Team of 6, works the night shift' },
  { name: 'isActive', label: 'Active', type: 'checkbox', placeholder: 'Offered on routings', section: 'Contractor' },
]
