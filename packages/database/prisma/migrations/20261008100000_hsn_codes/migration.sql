-- HSN / SAC master: the GST rate each code carries. Additive only — a new
-- enum and a new table; nothing existing is altered.

-- CreateEnum
CREATE TYPE "HsnKind" AS ENUM ('GOODS', 'SERVICES');

-- CreateTable
CREATE TABLE "hsn_codes" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "kind" "HsnKind" NOT NULL DEFAULT 'GOODS',
    "gstRate" DECIMAL(5,2) NOT NULL,
    "priceLimit" DECIMAL(12,2),
    "rateAbove" DECIMAL(5,2),
    "effectiveFrom" DATE,
    "notes" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "hsn_codes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "hsn_codes_code_key" ON "hsn_codes"("code");

-- CreateIndex
CREATE INDEX "hsn_codes_isActive_idx" ON "hsn_codes"("isActive");
