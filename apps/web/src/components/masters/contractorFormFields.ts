import type { FormField } from '@/components/masters/MasterFormDialog'

/*
 * The contractor form, shared by Routing Masters → Contractors and by "Add
 * new contractor" on a routing step.
 */

export const contractorFormFields: FormField[] = [
  { name: 'code', label: 'Code', generated: true, section: 'Contractor' },
  { name: 'name', label: 'Name', required: true, placeholder: 'Ramesh Patil', section: 'Contractor', span: 2 },
  {
    name: 'operationId',
    label: 'Process',
    type: 'select',
    required: true,
    section: 'Contractor',
    optionsFrom: { resource: 'operations' },
    help: 'What they do: a routing step offers them for this process',
  },
  { name: 'phone', label: 'Phone', section: 'Contractor', placeholder: '+91 98765 43210' },
  {
    name: 'ratePerPiece',
    label: 'Rate per piece (₹)',
    type: 'number',
    section: 'Contractor',
    placeholder: '4.50',
    min: 0,
    help: 'When it is the same for every style; a routing step can say its own',
  },
  { name: 'notes', label: 'Notes', type: 'textarea', section: 'Contractor', span: 2, rows: 1, placeholder: 'Team of 6, works the night shift' },
  { name: 'isActive', label: 'Active', type: 'checkbox', placeholder: 'Offered on routings', section: 'Contractor' },
]
