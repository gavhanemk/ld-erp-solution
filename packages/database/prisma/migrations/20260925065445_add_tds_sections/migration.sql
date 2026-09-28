-- Configurable master for TDS sections/rates, mirroring tax_rates, so the
-- purchase bill's TDS section field can become a dropdown instead of free text.

-- CreateTable
CREATE TABLE "tds_sections" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "section" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "rate" DECIMAL(5,2) NOT NULL,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tds_sections_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "tds_sections_companyId_section_label_key" ON "tds_sections"("companyId", "section", "label");

-- AddForeignKey
ALTER TABLE "tds_sections" ADD CONSTRAINT "tds_sections_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "company"("id") ON DELETE CASCADE ON UPDATE CASCADE;
