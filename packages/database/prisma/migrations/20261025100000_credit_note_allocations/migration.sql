-- Credit a credit note leaves with the customer, set against their later
-- invoices. Additive only: one new table, nothing existing changes.

-- CreateTable
CREATE TABLE "credit_note_allocations" (
    "id" TEXT NOT NULL,
    "noteId" TEXT NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "credit_note_allocations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "credit_note_allocations_noteId_idx" ON "credit_note_allocations"("noteId");

-- CreateIndex
CREATE INDEX "credit_note_allocations_invoiceId_idx" ON "credit_note_allocations"("invoiceId");

-- AddForeignKey
ALTER TABLE "credit_note_allocations" ADD CONSTRAINT "credit_note_allocations_noteId_fkey" FOREIGN KEY ("noteId") REFERENCES "credit_notes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credit_note_allocations" ADD CONSTRAINT "credit_note_allocations_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "sales_invoices"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
