-- Processes switched off while active routings still use them as stages
-- (Cutting QC, Embroidery QC and Line QC on 12 Oct 2026) are switched back
-- on, so the routings and the orders made from them work as set. From now on
-- the Processes master refuses to switch off a process a routing uses.
UPDATE "ld_erp"."operations" o
SET "isActive" = true
WHERE o."isActive" = false
  AND EXISTS (
    SELECT 1
    FROM "ld_erp"."routing_steps" s
    JOIN "ld_erp"."routings" r ON r."id" = s."routingId"
    WHERE s."operationId" = o."id" AND r."isActive" = true
  );
