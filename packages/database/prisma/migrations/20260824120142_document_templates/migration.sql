-- AlterTable
ALTER TABLE "company" ADD COLUMN     "bankAccount" TEXT,
ADD COLUMN     "bankBranch" TEXT,
ADD COLUMN     "bankIFSC" TEXT,
ADD COLUMN     "bankName" TEXT,
ADD COLUMN     "signatureUrl" TEXT,
ADD COLUMN     "upiId" TEXT;

-- CreateTable
CREATE TABLE "document_templates" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "docType" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "termsText" TEXT,
    "declaration" TEXT,
    "footerNote" TEXT,
    "showHsn" BOOLEAN NOT NULL DEFAULT true,
    "showAmountInWords" BOOLEAN NOT NULL DEFAULT true,
    "showBankDetails" BOOLEAN NOT NULL DEFAULT true,
    "showSignature" BOOLEAN NOT NULL DEFAULT true,
    "copies" TEXT[],
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "document_templates_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "document_templates_companyId_docType_key" ON "document_templates"("companyId", "docType");

-- AddForeignKey
ALTER TABLE "document_templates" ADD CONSTRAINT "document_templates_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "company"("id") ON DELETE CASCADE ON UPDATE CASCADE;
