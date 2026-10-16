import { prisma, Prisma } from '@ld-erp/database'

/**
 * For any stock movement: the number of the document behind it, and who was on
 * the other side — the supplier, the customer, the job worker, the department
 * it was issued to, the other store of a transfer, or the order it was made on.
 *
 * Written once, as SQL, so the ledger can filter and search by them and the
 * statements can print them, and all of them say the same thing.
 *
 * Use it after a FROM that names the ledger row `s`:
 *   FROM ld_erp.stock_ledger s ${MOVEMENT_DOC_JOIN}
 * and read p.doc, p."partyKind", p."partyId", p."partyName".
 */
export type PartyKind = 'supplier' | 'customer' | 'jobworker' | 'department' | 'store' | 'production'

export const PARTY_KIND_LABEL: Record<PartyKind, string> = {
  supplier: 'supplier',
  customer: 'customer',
  jobworker: 'job worker',
  department: 'department',
  store: 'store',
  production: 'production',
}

export const MOVEMENT_DOC_JOIN = Prisma.sql`
  LEFT JOIN LATERAL (
    SELECT g."grnNumber" AS doc, 'supplier' AS "partyKind", sp.id AS "partyId", sp.name AS "partyName"
      FROM ld_erp.grn g
      JOIN ld_erp.purchase_orders po ON po.id = g."poId"
      JOIN ld_erp.suppliers sp ON sp.id = po."supplierId"
      WHERE s."referenceType" IN ('GRN', 'GRN_EDITED', 'GRN_CANCELLED', 'GRN_DELETED') AND g.id = s."referenceId"
    UNION ALL
    SELECT 'QC of ' || g."grnNumber", 'supplier', sp.id, sp.name
      FROM ld_erp.inward_qc q
      JOIN ld_erp.grn g ON g.id = q."grnId"
      JOIN ld_erp.purchase_orders po ON po.id = g."poId"
      JOIN ld_erp.suppliers sp ON sp.id = po."supplierId"
      WHERE s."referenceType" IN ('GRN_QC', 'GRN_QC_CANCELLED', 'GRN_QC_USED') AND q.id = s."referenceId"
    UNION ALL
    SELECT r."returnNumber", 'supplier', sp.id, sp.name
      FROM ld_erp.purchase_returns r JOIN ld_erp.suppliers sp ON sp.id = r."supplierId"
      WHERE s."referenceType" IN ('PurchaseReturn', 'PURCHASE_RETURN_CANCELLED') AND r.id = s."referenceId"
    UNION ALL
    SELECT n."noteNumber", 'supplier', sp.id, sp.name
      FROM ld_erp.purchase_notes n JOIN ld_erp.suppliers sp ON sp.id = n."supplierId"
      WHERE s."referenceType" LIKE 'PurchaseNote%' AND n.id = s."referenceId"
    UNION ALL
    SELECT cg."grnNumber", 'customer', cu.id, cu.name
      FROM ld_erp.customer_grn cg JOIN ld_erp.customers cu ON cu.id = cg."customerId"
      WHERE s."referenceType" IN ('CUSTOMER_GRN', 'CUSTOMER_GRN_CANCELLED', 'CUSTOMER_GRN_RELEASE') AND cg.id = s."referenceId"
    UNION ALL
    SELECT cr."returnNumber", 'customer', cu.id, cu.name
      FROM ld_erp.customer_material_returns cr JOIN ld_erp.customers cu ON cu.id = cr."customerId"
      WHERE s."referenceType" IN ('CUSTOMER_RETURN', 'CUSTOMER_RETURN_CANCELLED') AND cr.id = s."referenceId"
    UNION ALL
    SELECT jc."challanNumber", 'jobworker', sp.id, sp.name
      FROM ld_erp.job_work_challans jc JOIN ld_erp.suppliers sp ON sp.id = jc."jobWorkerId"
      WHERE s."referenceType" IN ('JOB_WORK_CHALLAN', 'JOB_WORK_CHALLAN_CANCELLED') AND jc.id = s."referenceId"
    UNION ALL
    SELECT jr."returnNumber", 'jobworker', sp.id, sp.name
      FROM ld_erp.job_work_returns jr
      JOIN ld_erp.job_work_challans jc ON jc.id = jr."challanId"
      JOIN ld_erp.suppliers sp ON sp.id = jc."jobWorkerId"
      WHERE s."referenceType" IN ('JOB_WORK_RETURN', 'JOB_WORK_RETURN_CANCELLED') AND jr.id = s."referenceId"
    UNION ALL
    SELECT mr."mrNumber", 'department', d.id, d.name
      FROM ld_erp.material_requisitions mr JOIN ld_erp.departments d ON d.id = mr."departmentId"
      WHERE s."referenceType" IN ('MATERIAL_REQUISITION', 'MR_RETURN', 'MR_RETURN_CANCELLED') AND mr.id = s."referenceId"
    UNION ALL
    SELECT t."transferNumber", 'store', ow.id, ow.name
      FROM ld_erp.stock_transfers t
      JOIN ld_erp.warehouses ow ON ow.id = CASE WHEN t."fromWarehouseId" = s."warehouseId" THEN t."toWarehouseId" ELSE t."fromWarehouseId" END
      WHERE s."referenceType" IN ('STOCK_TRANSFER', 'STOCK_TRANSFER_CANCELLED') AND t.id = s."referenceId"
    UNION ALL
    SELECT f."fgrNumber", 'production', mo.id, COALESCE(mo."moNumber", 'Production')
      FROM ld_erp.finished_goods_receipts f LEFT JOIN ld_erp.manufacturing_orders mo ON mo.id = f."moId"
      WHERE s."referenceType" IN ('FG_RECEIPT', 'FG_RECEIPT_CANCEL') AND f.id = s."referenceId"
    UNION ALL
    SELECT co."cutOrderNumber", 'production', mo.id, mo."moNumber"
      FROM ld_erp.cutting_orders co JOIN ld_erp.manufacturing_orders mo ON mo.id = co."moId"
      WHERE s."referenceType" IN ('CUTTING', 'CUTTING_CANCEL') AND co.id = s."referenceId"
    UNION ALL
    SELECT dc."dcNumber", 'customer', cu.id, cu.name
      FROM ld_erp.delivery_challans dc
      JOIN ld_erp.sales_orders so ON so.id = dc."soId"
      JOIN ld_erp.customers cu ON cu.id = COALESCE(dc."customerId", so."customerId")
      WHERE s."referenceType" IN ('DELIVERY_CHALLAN', 'DELIVERY_CHALLAN_CANCEL') AND dc.id = s."referenceId"
    UNION ALL
    SELECT cn."noteNumber", 'customer', cu.id, cu.name
      FROM ld_erp.credit_notes cn JOIN ld_erp.customers cu ON cu.id = cn."customerId"
      WHERE s."referenceType" IN ('CREDIT_NOTE', 'CREDIT_NOTE_CANCEL') AND cn.id = s."referenceId"
    UNION ALL
    SELECT a."adjustmentNumber", NULL, NULL, NULL
      FROM ld_erp.stock_adjustments a
      WHERE s."referenceType" IN ('STOCK_ADJUSTMENT', 'STOCK_IN') AND a.id = s."referenceId"
    UNION ALL
    SELECT sc."countNumber", NULL, NULL, NULL
      FROM ld_erp.stock_counts sc
      WHERE s."referenceType" = 'STOCK_COUNT' AND sc.id = s."referenceId"
    LIMIT 1
  ) p ON TRUE`

/** What a movement's document is, in words, for a printed statement. */
export const DOCUMENT_LABEL: Record<string, string> = {
  OPENING_STOCK: 'Opening stock',
  GRN: 'Goods receipt',
  GRN_EDITED: 'Goods receipt corrected',
  GRN_CANCELLED: 'Goods receipt cancelled',
  GRN_DELETED: 'Goods receipt deleted',
  GRN_QC: 'Quality check',
  GRN_QC_CANCELLED: 'Quality check undone',
  GRN_QC_USED: 'Quality check',
  CUSTOMER_GRN: 'Received from customer',
  CUSTOMER_GRN_CANCELLED: 'Customer receipt cancelled',
  CUSTOMER_GRN_RELEASE: 'Released from hold',
  CUSTOMER_RETURN: 'Returned to customer',
  CUSTOMER_RETURN_CANCELLED: 'Return to customer cancelled',
  JOB_WORK_CHALLAN: 'Sent for job work',
  JOB_WORK_CHALLAN_CANCELLED: 'Job work challan cancelled',
  JOB_WORK_RETURN: 'Back from job work',
  JOB_WORK_RETURN_CANCELLED: 'Job work receipt cancelled',
  PurchaseReturn: 'Returned to supplier',
  PurchaseNote: 'Purchase note',
  STOCK_ADJUSTMENT: 'Stock adjustment',
  STOCK_IN: 'Stock in (no PO)',
  STOCK_COUNT: 'Stock count',
  STOCK_TRANSFER: 'Store transfer',
  STOCK_TRANSFER_CANCELLED: 'Store transfer cancelled',
  MATERIAL_REQUISITION: 'Issued to production',
  MR_RETURN: 'Back from the floor',
  MR_RETURN_CANCELLED: 'Floor return cancelled',
  FG_RECEIPT: 'Finished goods in',
  FG_RECEIPT_CANCEL: 'Finished goods receipt cancelled',
  CUTTING: 'Cut panels in',
  CUTTING_CANCEL: 'Cutting cancelled',
  DELIVERY_CHALLAN: 'Dispatched',
  DELIVERY_CHALLAN_CANCEL: 'Dispatch cancelled',
  CREDIT_NOTE: 'Returned by customer',
  CREDIT_NOTE_CANCEL: 'Customer return cancelled',
}

export const documentLabel = (t: string | null) =>
  t ? (DOCUMENT_LABEL[t] ?? t.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/_/g, ' ').toLowerCase().replace(/^./, (c) => c.toUpperCase())) : 'No document'

export interface MovementDoc {
  doc: string | null
  partyKind: PartyKind | null
  partyId: string | null
  partyName: string | null
}

/** The document and party of each of these ledger rows, by row id. */
export async function movementDocs(ids: string[], db: Prisma.TransactionClient = prisma): Promise<Map<string, MovementDoc>> {
  if (!ids.length) return new Map()
  const rows = await db.$queryRaw<Array<MovementDoc & { id: string }>>`
    SELECT s.id, p.doc, p."partyKind", p."partyId", p."partyName"
    FROM ld_erp.stock_ledger s ${MOVEMENT_DOC_JOIN}
    WHERE s.id IN (${Prisma.join(ids)})`
  return new Map(rows.map((r) => [r.id, { doc: r.doc, partyKind: r.partyKind, partyId: r.partyId, partyName: r.partyName }]))
}
