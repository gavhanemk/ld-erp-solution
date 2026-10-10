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
import { grnQcRegister, qcRejections } from './definitions/grn-qc'
import { stockSummary } from './definitions/stock-summary'
import { stockMovement } from './definitions/stock-movement'
import { itemStockLedger } from './definitions/item-stock-ledger'
import { reorderStatus } from './definitions/reorder-status'
import { stockAgeing } from './definitions/stock-ageing'
import { materialConsumption } from './definitions/material-consumption'
import { requisitionFulfilment } from './definitions/requisition-fulfilment'
import { jobWorkPending } from './definitions/job-work-pending'
import { customerMaterialStock } from './definitions/customer-material-stock'
import { stockCountVariance } from './definitions/stock-count-variance'

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
  grnQcRegister,
  qcRejections,
  purchaseOrderStatus,
  pendingPoItems,
  indentAgainstPo,
  supplierOutstanding,
  noteRegister,
  // Inventory
  stockSummary,
  stockMovement,
  itemStockLedger,
  reorderStatus,
  stockAgeing,
  materialConsumption,
  requisitionFulfilment,
  jobWorkPending,
  customerMaterialStock,
  stockCountVariance,
]

export function findReport(id: string): ReportDefinition | undefined {
  return REPORTS.find((r) => r.id === id)
}
