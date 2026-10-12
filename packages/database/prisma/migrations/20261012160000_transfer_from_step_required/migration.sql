-- Every transfer comes from a step and carries bundles again: cutting now
-- starts on the cutting sheet, by issuing sizes to a cutting contractor,
-- not by a transfer of the job card. No transfer was ever made without them.
ALTER TABLE "process_transfers" ALTER COLUMN "fromStepId" SET NOT NULL;
ALTER TABLE "process_transfer_lines" ALTER COLUMN "bundleId" SET NOT NULL;
