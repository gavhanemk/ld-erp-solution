import type { FormField } from '@/components/masters/MasterFormDialog'

/*
 * The process form, shared by Routing Masters → Processes and by "Add new
 * process" on a routing, so a process added from either has the same fields.
 */

export const PROCESS_KINDS: Array<{ value: 'CUTTING' | 'STITCHING' | 'FINISHING' | 'QC' | 'PACKING' | 'OTHER'; label: string; help: string }> = [
  { value: 'CUTTING', label: 'Cutting', help: 'Makes the pieces and ties them into bundles. Every route starts here.' },
  { value: 'STITCHING', label: 'Stitching', help: 'Counted as stitched on the order.' },
  { value: 'FINISHING', label: 'Finishing', help: 'Thread cutting, pressing, tagging.' },
  { value: 'QC', label: 'Check', help: 'Passes or fails pieces; failed ones go to rework, B-grade or write-off.' },
  { value: 'PACKING', label: 'Packing', help: 'Usually the last step before finished goods.' },
  { value: 'OTHER', label: 'Other process', help: 'Fusing, embroidery, washing, printing, kaj button…' },
]

export const processFormFields: FormField[] = [
  { name: 'code', label: 'Code', required: true, placeholder: 'OP-WSH', section: 'Process' },
  { name: 'name', label: 'Name', required: true, placeholder: 'Washing', section: 'Process', span: 2 },
  {
    name: 'departmentId',
    label: 'Department',
    type: 'select',
    required: true,
    section: 'Process',
    optionsFrom: { resource: 'departments' },
    help: 'The department whose people do it, or who send it out',
  },
  {
    name: 'kind',
    label: 'Kind',
    type: 'select',
    required: true,
    section: 'How it is recorded',
    options: PROCESS_KINDS.map((k) => ({ value: k.value, label: k.label })),
    liveHelp: (v) => PROCESS_KINDS.find((k) => k.value === v)?.help ?? 'Decides how its work is recorded on the floor',
  },
  {
    name: 'defaultExecution',
    label: 'Usually done',
    type: 'select',
    required: true,
    section: 'How it is recorded',
    options: [
      { value: 'IN_HOUSE', label: 'On our own floor' },
      { value: 'OUTSOURCED', label: 'At an outside unit' },
    ],
    help: 'A routing step can say otherwise',
  },
  { name: 'smv', label: 'Standard minutes (SMV)', type: 'number', section: 'How it is recorded', placeholder: '12.5', min: 0, max: 999 },
  { name: 'jobWorkRate', label: 'Outside rate per piece (₹)', type: 'number', section: 'How it is recorded', placeholder: '6', min: 0, help: 'What a unit is usually paid; a job work order can agree another' },
  { name: 'sortOrder', label: 'Position in pickers', type: 'number', section: 'How it is recorded', placeholder: '10', min: 0, max: 999 },
  { name: 'instructions', label: 'Standing instructions', type: 'textarea', section: 'Instructions', rows: 2, placeholder: 'Check shade against the approved swatch before washing' },
  { name: 'isActive', label: 'Active', type: 'checkbox', placeholder: 'Offered on routings', section: 'Instructions' },
]
