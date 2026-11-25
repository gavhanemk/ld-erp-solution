-- The head office address the user gave on 25 Nov 2026, into Settings →
-- Company's "Address 2 / HO" (added by 20261125170000_company_address2), so
-- purchase orders print it as "HO: …" straight away. Only when that field is
-- still empty: an address already typed there is left as it is.
UPDATE "company"
SET "address2" = 'Essgee Options One, 3rd Floor, Shop No. 333-336 Near Tilak Bhavan, Opp. Indiabulls Senapati Bapat Marg, Prabhadevi, Mumbai - 400013'
WHERE "address2" IS NULL OR btrim("address2") = '';
