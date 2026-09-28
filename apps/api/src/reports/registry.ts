import type { ReportDefinition } from './types'
import { purchaseRegister } from './definitions/purchase-register'
import { supplierOutstanding } from './definitions/supplier-outstanding'
import { goodsReceiptRegister } from './definitions/goods-receipt-register'
import { purchaseOrderStatus } from './definitions/purchase-order-status'
import { noteRegister } from './definitions/note-register'

/**
 * Every report the ERP knows about.
 *
 * Adding one is a file and a line here. Nothing else changes: the picker, the
 * permission, the CSV and the workbook all read the definition.
 */
export const REPORTS: ReportDefinition[] = [
  purchaseRegister,
  goodsReceiptRegister,
  purchaseOrderStatus,
  supplierOutstanding,
  noteRegister,
]

export function findReport(id: string): ReportDefinition | undefined {
  return REPORTS.find((r) => r.id === id)
}
