-- Sampling phase 1: the buyer's tech pack and the style made for a sample.
-- Additive only. Every style already in the masters becomes PRODUCTION, so nothing
-- already ordered, costed or made changes; only the sampling flow makes DEVELOPMENT ones.

-- CreateEnum
CREATE TYPE "StyleStage" AS ENUM ('DEVELOPMENT', 'PRODUCTION');

-- AlterTable
ALTER TABLE "styles" ADD COLUMN "stage" "StyleStage" NOT NULL DEFAULT 'PRODUCTION';

-- CreateIndex
CREATE INDEX "styles_stage_idx" ON "styles"("stage");

-- AlterTable
ALTER TABLE "sample_requests" ADD COLUMN "buyerStyleRef" TEXT,
ADD COLUMN "season" TEXT,
ADD COLUMN "garmentCategory" TEXT,
ADD COLUMN "styleId" TEXT;

-- CreateIndex
CREATE INDEX "sample_requests_styleId_idx" ON "sample_requests"("styleId");

-- AddForeignKey
ALTER TABLE "sample_requests" ADD CONSTRAINT "sample_requests_styleId_fkey" FOREIGN KEY ("styleId") REFERENCES "styles"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- CreateTable
CREATE TABLE "sample_attachments" (
    "id" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "roundId" TEXT,
    "kind" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "storagePath" TEXT NOT NULL,
    "mimeType" TEXT,
    "sizeBytes" INTEGER NOT NULL,
    "uploadedById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sample_attachments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "sample_attachments_storagePath_key" ON "sample_attachments"("storagePath");

-- CreateIndex
CREATE INDEX "sample_attachments_requestId_idx" ON "sample_attachments"("requestId");

-- CreateIndex
CREATE INDEX "sample_attachments_roundId_idx" ON "sample_attachments"("roundId");

-- AddForeignKey
ALTER TABLE "sample_attachments" ADD CONSTRAINT "sample_attachments_requestId_fkey" FOREIGN KEY ("requestId") REFERENCES "sample_requests"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sample_attachments" ADD CONSTRAINT "sample_attachments_roundId_fkey" FOREIGN KEY ("roundId") REFERENCES "sample_rounds"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sample_attachments" ADD CONSTRAINT "sample_attachments_uploadedById_fkey" FOREIGN KEY ("uploadedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- The same kinds the API and the screens offer (SAMPLE_ATTACHMENT_KINDS in packages/shared).
ALTER TABLE sample_attachments ADD CONSTRAINT sample_attachment_kind CHECK (kind IN ('TECH_PACK','PATTERN','PHOTO','APPROVAL','DISPATCH','OTHER'));
ALTER TABLE sample_attachments ADD CONSTRAINT sample_attachment_size CHECK ("sizeBytes" >= 0);
