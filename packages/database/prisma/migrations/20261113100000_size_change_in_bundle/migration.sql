-- Size changes inside their own bundle (12 Nov 2026): pieces made as another
-- size at stitching stay in the bundle they were cut in, so the bundle count
-- and the cutting stickers stay as cut. A size change no longer makes a new
-- bundle, so its "to bundle" is empty from now on; changes made before keep
-- theirs. Nothing existing changes.

-- AlterTable
ALTER TABLE "size_changes" ALTER COLUMN "toBundleId" DROP NOT NULL;
