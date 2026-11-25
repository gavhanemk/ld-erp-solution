-- The company's head office (25 Nov 2026), printed under the works address
-- on purchase orders as "HO: …". Edited under Settings → Company.
ALTER TABLE "company" ADD COLUMN "headOfficeAddress" TEXT;

-- The address the user gave, so it prints straight away; changed or cleared
-- in Settings → Company like any other field.
UPDATE "company"
SET "headOfficeAddress" = 'Essgee Options One, 3rd Floor, Shop No. 333-336 Near Tilak Bhavan, Opp. Indiabulls Senapati Bapat Marg, Prabhadevi, Mumbai - 400013'
WHERE "headOfficeAddress" IS NULL;
