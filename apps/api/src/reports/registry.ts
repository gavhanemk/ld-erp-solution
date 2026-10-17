import type { ReportDefinition } from './types'
import { purchaseRegister } from './definitions/purchase-register'
import { supplierOutstanding } from './definitions/supplier-outstanding'
import { goodsReceiptRegister } from './definitions/goods-receipt-register'
import { purchaseOrderStatus } from './definitions/purchase-order-status'
import { noteRegister } from './definitions/note-register'
import { indentAgainstPo } from './definitions/indent-against-po'
import { purchasesByItem } from './definitions/purchases-by-item'
import { grnQcRegister } from './definitions/grn-qc'
import { tdsRegister } from './definitions/tds-register'
import { SALES_REPORTS } from './definitions/sales'
import { stockSummary } from './definitions/stock-summary'
import { stockMovement } from './definitions/stock-movement'
import { itemStockLedger } from './definitions/item-stock-ledger'
import { reorderStatus } from './definitions/reorder-status'
import { stockAgeing } from './definitions/stock-ageing'
import { materialConsumption } from './definitions/material-consumption'
import { requisitionFulfilment } from './definitions/requisition-fulfilment'
import { jobWorkPending } from './definitions/job-work-pending'
import { jobWorkOrders } from './definitions/job-work-orders'
import { customerMaterialStock } from './definitions/customer-material-stock'
import { stockCountVariance } from './definitions/stock-count-variance'

/**
 * Every report the ERP knows about.
 *
 * Adding one is a file and a line here. Nothing else changes: the picker, the
 * permission, the CSV and the workbook all read the definition.
 */
export const REPORTS: ReportDefinition[] = [
  // Purchase — eight, none repeating another. Four more were folded in:
  // GRN Against Bill (Goods Receipt Register), Rejected on QC (GRN QC
  // Register), Pending PO Items (Purchase Order Status) and the Expenses
  // Booking Register (Purchases by Item); old links to them land on these.
  // The TDS Register is the one addition since: nothing else lists the tax
  // kept back from suppliers.
  purchaseRegister,
  purchasesByItem,
  goodsReceiptRegister,
  grnQcRegister,
  purchaseOrderStatus,
  indentAgainstPo,
  supplierOutstanding,
  noteRegister,
  tdsRegister,
  // Inventory
  stockSummary,
  stockMovement,
  itemStockLedger,
  reorderStatus,
  stockAgeing,
  materialConsumption,
  requisitionFulfilment,
  jobWorkPending,
  jobWorkOrders,
  customerMaterialStock,
  stockCountVariance,
  ...SALES_REPORTS,
]

/** Reports folded into another, so a saved link or bookmark still opens. */
const FOLDED_INTO: Record<string, string> = {
  'grn-against-bill': 'goods-receipt-register',
  'qc-rejections': 'grn-qc-register',
  'pending-po-items': 'purchase-order-status',
  'expense-register': 'purchases-by-item',
}

export function findReport(id: string): ReportDefinition | undefined {
  const wanted = FOLDED_INTO[id] ?? id
  return REPORTS.find((r) => r.id === wanted)
}
