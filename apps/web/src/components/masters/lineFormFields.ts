import type { FormField } from '@/components/masters/MasterFormDialog'

/*
 * The line form (a table, line, machine or outside unit), shared by Routing
 * Masters → Lines & tables and by "Add new line" on a routing step.
 */

export const lineFormFields: FormField[] = [
  { name: 'code', label: 'Code', generated: true, section: 'Workstation' },
  { name: 'name', label: 'Name', required: true, placeholder: 'Cutting Table 3', section: 'Workstation', span: 2 },
  {
    name: 'departmentId',
    label: 'Department',
    type: 'select',
    required: true,
    section: 'Workstation',
    optionsFrom: { resource: 'departments' },
    placeholder: 'Which department runs it…',
    resets: ['operationId'],
  },
  {
    name: 'operationId',
    label: 'Process',
    type: 'select',
    section: 'Workstation',
    optionsFrom: { resource: 'operations', filter: (row, values) => row.departmentId === values.departmentId },
    placeholder: 'Any of its department’s',
    help: 'The one process it does: Final QC and Packing share a department, each with its own lines',
  },
  {
    name: 'type',
    label: 'Run by',
    type: 'select',
    required: true,
    section: 'Workstation',
    options: [
      { value: 'IN_HOUSE', label: 'Our own floor' },
      { value: 'JOB_WORK', label: 'An outside unit' },
    ],
  },
  {
    name: 'supplierId',
    label: 'Supplier paid for this work',
    type: 'select',
    section: 'Workstation',
    span: 2,
    optionsFrom: { resource: 'suppliers' },
    placeholder: 'Needed for an outside unit',
    help: 'Without it an outside unit’s job-work bill cannot be totalled',
  },
  {
    name: 'capacityPerDay',
    label: 'Pieces per day',
    type: 'number',
    section: 'Workstation',
    placeholder: '500 (blank if it varies)',
  },
  { name: 'contactPerson', label: 'Contact Person', section: 'Contact' },
  { name: 'phone', label: 'Phone', section: 'Contact', placeholder: '+91 98765 43210' },
  { name: 'address', label: 'Address', type: 'textarea', section: 'Contact', span: 2, rows: 1 },
  { name: 'isActive', label: 'Active', type: 'checkbox', placeholder: 'Available for production', section: 'Contact' },
]
