import type { ReportDefinition } from './types'
import { purchaseRegister } from './definitions/purchase-register'
import { supplierOutstanding } from './definitions/supplier-outstanding'
import { goodsReceiptRegister } from './definitions/goods-receipt-register'
import { purchaseOrderStatus } from './definitions/purchase-order-status'
import { noteRegister } from './definitions/note-register'
import { pendingPoItems } from './definitions/pending-po-items'
import { indentAgainstPo } from './definitions/indent-against-po'
import { grnAgainstBill } from './definitions/grn-against-bill'
import { purchasesByItem } from './definitions/purchases-by-item'
import { expenseRegister } from './definitions/expense-register'

/**
 * Every report the ERP knows about.
 *
 * Adding one is a file and a line here. Nothing else changes: the picker, the
 * permission, the CSV and the workbook all read the definition.
 */
export const REPORTS: ReportDefinition[] = [
  purchaseRegister,
  purchasesByItem,
  expenseRegister,
  goodsReceiptRegister,
  grnAgainstBill,
  purchaseOrderStatus,
  pendingPoItems,
  indentAgainstPo,
  supplierOutstanding,
  noteRegister,
]

export function findReport(id: string): ReportDefinition | undefined {
  return REPORTS.find((r) => r.id === id)
}
