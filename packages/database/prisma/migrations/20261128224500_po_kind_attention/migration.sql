-- "Kind Attention" on a purchase order (27 Nov 2026): who at the supplier the
-- order is for. New columns only; nothing already saved is changed.

-- Who the mill deals with at the supplier, kept on the supplier.
ALTER TABLE "suppliers" ADD COLUMN "contactPerson" TEXT;

-- The order's own copy: filled from the supplier's contact person, and can be
-- changed on the order without touching the supplier.
ALTER TABLE "purchase_orders" ADD COLUMN "kindAttention" TEXT;
