import type { FormField } from '@/components/masters/MasterFormDialog'

/*
 * The supplier form, shared by Masters → Suppliers and by "Add new supplier"
 * on a purchase order, so a supplier added from either has the same fields,
 * the same rules and the same look.
 */

export const SUPPLIER_CATEGORY_LABEL: Record<string, string> = {
  FABRIC: 'Fabric',
  THREAD: 'Thread',
  BUTTON: 'Button',
  LINING: 'Lining',
  LABEL: 'Label',
  PACKAGING: 'Packaging',
  TRIM: 'Trim',
  TRANSPORT: 'Transport',
  SERVICE: 'Service',
  OTHER: 'Other',
}

/*
 * Four across on a wider card, so a supplier fits on one screen: who they
 * are and how to reach them; where they are and how they supply; bank, MSME
 * and notes, with the preferred tick beside the notes. Hints sit in the
 * boxes rather than under them.
 */
export const supplierFormFields: FormField[] = [
  { name: 'code', label: 'Supplier Code', generated: true, section: 'Identity & Contact' },
  {
    name: 'name',
    label: 'Supplier Name',
    required: true,
    placeholder: 'Shree Fabrics',
    section: 'Identity & Contact',
    span: 2,
  },
  {
    name: 'category',
    label: 'Category',
    type: 'select',
    required: true,
    section: 'Identity & Contact',
    options: Object.entries(SUPPLIER_CATEGORY_LABEL).map(([value, label]) => ({ value, label })),
  },
  {
    name: 'gstin',
    label: 'GSTIN',
    section: 'Identity & Contact',
    placeholder: '27AAACL1234M1Z5',
    uppercase: true,
    // The first two digits are the state, and the state is what decides whether
    // they bill CGST+SGST or IGST.
    derives: { field: 'stateCode', from: (v) => (/^\d{2}/.test(v) ? v.slice(0, 2) : null) },
  },
  { name: 'stateCode', label: 'GST State Code', section: 'Identity & Contact', placeholder: '27 (from the GSTIN)' },
  { name: 'pan', label: 'PAN', section: 'Identity & Contact', placeholder: 'AAACL1234M', uppercase: true },
  { name: 'phone', label: 'Phone', section: 'Identity & Contact', placeholder: '+91 98765 43210' },
  { name: 'email', label: 'Email', section: 'Identity & Contact', placeholder: 'sales@example.com' },
  { name: 'address', label: 'Address', type: 'textarea', section: 'Address & Terms', span: 2, rows: 1 },
  { name: 'city', label: 'City', section: 'Address & Terms', placeholder: 'Bhiwandi' },
  { name: 'state', label: 'State', section: 'Address & Terms', placeholder: 'Maharashtra' },
  { name: 'pincode', label: 'PIN Code', section: 'Address & Terms', placeholder: '421302' },
  {
    name: 'leadTimeDays',
    label: 'Lead Time (days)',
    type: 'number',
    section: 'Address & Terms',
    placeholder: '7 (order to delivery)',
  },
  { name: 'creditDays', label: 'Credit Days', type: 'number', section: 'Address & Terms', placeholder: '30' },
  { name: 'paymentTerms', label: 'Payment Terms', section: 'Address & Terms', placeholder: '30 days from bill' },
  { name: 'bankName', label: 'Bank Name', section: 'Bank, MSME & Notes' },
  { name: 'bankAccount', label: 'Account Number', section: 'Bank, MSME & Notes' },
  { name: 'bankIFSC', label: 'IFSC Code', section: 'Bank, MSME & Notes', placeholder: 'HDFC0001234', uppercase: true },
  { name: 'rating', label: 'Rating', type: 'number', section: 'Bank, MSME & Notes', placeholder: '1 to 5' },
  {
    name: 'isMsme',
    label: 'MSME',
    type: 'checkbox',
    placeholder: 'Udyam registered',
    section: 'Bank, MSME & Notes',
  },
  {
    name: 'msmeNumber',
    label: 'Udyam Number',
    section: 'Bank, MSME & Notes',
    placeholder: 'UDYAM-MH-00-0000000',
    uppercase: true,
  },
  { name: 'notes', label: 'Notes', type: 'textarea', section: 'Bank, MSME & Notes', span: 1, rows: 1 },
  {
    name: 'isPreferred',
    label: 'Preferred',
    type: 'checkbox',
    placeholder: 'Prioritise in vendor lists',
    section: 'Bank, MSME & Notes',
  },
  { name: 'isActive', label: 'Active', type: 'checkbox', placeholder: 'Available for new orders', section: 'Bank, MSME & Notes' },
]
