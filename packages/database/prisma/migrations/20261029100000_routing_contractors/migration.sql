-- Routing Masters: a Contractors master, the contractor on routing and order
-- steps, and the process a line does. Additive only.

CREATE TABLE "contractors" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "operationId" TEXT NOT NULL,
    "phone" TEXT,
    "ratePerPiece" DECIMAL(10,2),
    "notes" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "contractors_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "contractors_code_key" ON "contractors"("code");
CREATE INDEX "contractors_operationId_idx" ON "contractors"("operationId");
ALTER TABLE "contractors" ADD CONSTRAINT "contractors_operationId_fkey" FOREIGN KEY ("operationId") REFERENCES "operations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "workstations" ADD COLUMN "operationId" TEXT;
CREATE INDEX "workstations_operationId_idx" ON "workstations"("operationId");
ALTER TABLE "workstations" ADD CONSTRAINT "workstations_operationId_fkey" FOREIGN KEY ("operationId") REFERENCES "operations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "routing_steps" ADD COLUMN "contractorId" TEXT;
ALTER TABLE "routing_steps" ADD CONSTRAINT "routing_steps_contractorId_fkey" FOREIGN KEY ("contractorId") REFERENCES "contractors"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "mo_steps" ADD COLUMN "contractorId" TEXT;
ALTER TABLE "mo_steps" ADD CONSTRAINT "mo_steps_contractorId_fkey" FOREIGN KEY ("contractorId") REFERENCES "contractors"("id") ON DELETE SET NULL ON UPDATE CASCADE;
