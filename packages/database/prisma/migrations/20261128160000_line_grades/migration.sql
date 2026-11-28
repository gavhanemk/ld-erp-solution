-- Which grade a transfer moved and a count counted: A good, B seconds, R held
-- or rejected. Every line until now was good stock, which is what A says.
ALTER TABLE "stock_transfer_lines" ADD COLUMN "grade" TEXT NOT NULL DEFAULT 'A';
ALTER TABLE "stock_adjustment_lines" ADD COLUMN "grade" TEXT NOT NULL DEFAULT 'A';
