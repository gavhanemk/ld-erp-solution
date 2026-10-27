-- A note on each package of a receipt line ("short width", "torn bag"), in
-- the same order as its sizes. Each package's sticker record keeps its note.
-- Additive only.
ALTER TABLE "grn_lines" ADD COLUMN     "packNotes" TEXT[] DEFAULT ARRAY[]::TEXT[];
