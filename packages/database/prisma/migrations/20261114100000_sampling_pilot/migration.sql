-- CreateTable
CREATE TABLE "sample_requests" (
    "id" TEXT NOT NULL,
    "clientKey" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "customerId" TEXT,
    "brandId" TEXT NOT NULL,
    "buyerRef" TEXT,
    "requiredAt" TIMESTAMP(3),
    "owner" TEXT NOT NULL,
    "brief" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 0,
    "cancelledAt" TIMESTAMP(3),
    "cancelReason" TEXT,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sample_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sample_rounds" (
    "id" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "revision" INTEGER NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'DRAFT',
    "specification" JSONB NOT NULL,
    "releasedAt" TIMESTAMP(3),
    "releasedById" TEXT,
    "qc" JSONB,
    "submission" JSONB,
    "decision" JSONB,
    "handover" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sample_rounds_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sample_stages" (
    "id" TEXT NOT NULL,
    "roundId" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "doneQty" INTEGER,
    "rejectedQty" INTEGER,
    "responsible" TEXT,
    "reference" TEXT,
    "notes" TEXT,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "sample_stages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sample_materials" (
    "id" TEXT NOT NULL,
    "roundId" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "warehouseId" TEXT NOT NULL,
    "ownership" "StockOwnership" NOT NULL,
    "plannedQty" DECIMAL(10,3) NOT NULL,
    "issuedQty" DECIMAL(10,3) NOT NULL DEFAULT 0,
    "returnedQty" DECIMAL(10,3) NOT NULL DEFAULT 0,
    "usedQty" DECIMAL(10,3) NOT NULL DEFAULT 0,
    "wasteQty" DECIMAL(10,3) NOT NULL DEFAULT 0,
    "issuedValue" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "returnedValue" DECIMAL(14,2) NOT NULL DEFAULT 0,

    CONSTRAINT "sample_materials_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sample_events" (
    "id" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "action" TEXT NOT NULL,
    "actorId" TEXT NOT NULL,
    "detail" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sample_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "sample_requests_clientKey_key" ON "sample_requests"("clientKey");

-- CreateIndex
CREATE UNIQUE INDEX "sample_requests_number_key" ON "sample_requests"("number");

-- CreateIndex
CREATE UNIQUE INDEX "sample_rounds_requestId_revision_key" ON "sample_rounds"("requestId", "revision");

-- CreateIndex
CREATE UNIQUE INDEX "sample_stages_roundId_sequence_key" ON "sample_stages"("roundId", "sequence");

-- CreateIndex
CREATE INDEX "sample_materials_roundId_idx" ON "sample_materials"("roundId");

-- CreateIndex
CREATE UNIQUE INDEX "sample_events_requestId_version_key" ON "sample_events"("requestId", "version");

-- AddForeignKey
ALTER TABLE "sample_requests" ADD CONSTRAINT "sample_requests_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "customers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sample_requests" ADD CONSTRAINT "sample_requests_brandId_fkey" FOREIGN KEY ("brandId") REFERENCES "brands"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sample_rounds" ADD CONSTRAINT "sample_rounds_requestId_fkey" FOREIGN KEY ("requestId") REFERENCES "sample_requests"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sample_stages" ADD CONSTRAINT "sample_stages_roundId_fkey" FOREIGN KEY ("roundId") REFERENCES "sample_rounds"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sample_materials" ADD CONSTRAINT "sample_materials_roundId_fkey" FOREIGN KEY ("roundId") REFERENCES "sample_rounds"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sample_materials" ADD CONSTRAINT "sample_materials_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sample_materials" ADD CONSTRAINT "sample_materials_warehouseId_fkey" FOREIGN KEY ("warehouseId") REFERENCES "warehouses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sample_events" ADD CONSTRAINT "sample_events_requestId_fkey" FOREIGN KEY ("requestId") REFERENCES "sample_requests"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
