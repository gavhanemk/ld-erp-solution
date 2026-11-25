-- The head office, printed as "HO: …" under the works address on every
-- document's letterhead. Filled with the mill's head office, as given on
-- 25 Nov 2026; edited later in Settings → Company.
ALTER TABLE "ld_erp"."company" ADD COLUMN IF NOT EXISTS "headOffice" TEXT;

UPDATE "ld_erp"."company"
   SET "headOffice" = 'Essgee Options One, 3rd Floor, Shop No. 333-336 Near Tilak Bhavan, Opp. Indiabulls Senapati Bapat Marg, Prabhadevi, Mumbai - 400013'
 WHERE "headOffice" IS NULL;
