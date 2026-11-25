-- Fixed assets (25 Nov 2026): a fourth group in Items & Products, and its item type.
-- Added on their own: a new enum value cannot be used in the transaction that adds it.

-- AlterEnum
ALTER TYPE "ItemGroup" ADD VALUE IF NOT EXISTS 'FIXED_ASSETS';

-- AlterEnum
ALTER TYPE "ItemType" ADD VALUE IF NOT EXISTS 'FIXED_ASSET';
