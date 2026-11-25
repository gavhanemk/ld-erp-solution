ALTER TABLE "sample_requests" ADD COLUMN "state" TEXT NOT NULL DEFAULT 'DRAFT';
UPDATE "sample_requests" s SET "state" = CASE WHEN s."cancelledAt" IS NOT NULL THEN 'CANCELLED' ELSE COALESCE((SELECT r.state FROM "sample_rounds" r WHERE r."requestId"=s.id ORDER BY revision DESC LIMIT 1),'DRAFT') END;
CREATE INDEX "sample_requests_state_createdAt_idx" ON "sample_requests"("state", "createdAt");

-- New permission rows only; no sampling rights are inferred from production rights.
INSERT INTO permissions (id, module, action)
SELECT 'sampling-perm-' || a, 'sampling', a
FROM unnest(ARRAY['view','create','edit','delete','approve','export','post']) AS a
ON CONFLICT (module, action) DO NOTHING;
