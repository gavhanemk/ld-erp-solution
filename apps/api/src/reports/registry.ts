import type { ReportDefinition } from './types'
import { purchaseRegister } from './definitions/purchase-register'
import { supplierOutstanding } from './definitions/supplier-outstanding'
import { goodsReceiptRegister } from './definitions/goods-receipt-register'
import { purchaseOrderStatus } from './definitions/purchase-order-status'
import { creditNoteRegister, debitNoteRegister } from './definitions/note-register'
import { supplierAdjustments } from './definitions/supplier-adjustments'
import { purchaseAdjustments } from './definitions/purchase-adjustments'
import { adjustmentReasons } from './definitions/adjustment-reasons'

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
  // The adjustments, in the order somebody reads them: what was raised, who it
  // is against, which bills it changes, and why it keeps happening.
  debitNoteRegister,
  creditNoteRegister,
  supplierAdjustments,
  purchaseAdjustments,
  adjustmentReasons,
]

export function findReport(id: string): ReportDefinition | undefined {
  return REPORTS.find((r) => r.id === id)
}
