import type { Prisma } from '@prisma/client'

/**
 * The tables a document can be locked in, by name. Fixed, so nothing a caller
 * sends ever becomes part of the query.
 */
const TABLES = {
  grn: 'grn',
  stockTransfer: 'stock_transfers',
  customerGrn: 'customer_grn',
  customerReturn: 'customer_material_returns',
  purchaseReturn: 'purchase_returns',
  purchaseNote: 'purchase_notes',
  creditNote: 'credit_notes',
  fgReceipt: 'finished_goods_receipts',
  deliveryChallan: 'delivery_challans',
  jobWorkChallan: 'job_work_challans',
  stockAdjustment: 'stock_adjustments',
  requisition: 'material_requisitions',
  inwardQc: 'inward_qc',
  purchaseBill: 'purchase_invoices',
} as const

/**
 * Holds one document for the rest of the transaction before anything reads
 * its status. Two clicks at once — a double-click, two tabs — used to both
 * read "not cancelled yet" and both post the reversal; now the second waits
 * here and then reads what the first did. Read the document after this, never
 * before.
 */
export async function lockRow(tx: Prisma.TransactionClient, table: keyof typeof TABLES, id: string) {
  await tx.$queryRawUnsafe(`SELECT id FROM ld_erp."${TABLES[table]}" WHERE id = $1 FOR UPDATE`, id)
}
