-- Files kept against a purchase order. The file itself lives in object
-- storage; this only records where it is and what it was called.

-- CreateTable
CREATE TABLE "purchase_order_attachments" (
    "id" TEXT NOT NULL,
    "poId" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "storagePath" TEXT NOT NULL,
    "mimeType" TEXT,
    "sizeBytes" INTEGER NOT NULL,
    "uploadedById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "purchase_order_attachments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "purchase_order_attachments_storagePath_key" ON "purchase_order_attachments"("storagePath");

-- CreateIndex
CREATE INDEX "purchase_order_attachments_poId_idx" ON "purchase_order_attachments"("poId");

-- AddForeignKey
ALTER TABLE "purchase_order_attachments" ADD CONSTRAINT "purchase_order_attachments_poId_fkey" FOREIGN KEY ("poId") REFERENCES "purchase_orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_order_attachments" ADD CONSTRAINT "purchase_order_attachments_uploadedById_fkey" FOREIGN KEY ("uploadedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

