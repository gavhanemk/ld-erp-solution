# Routing reuse and comparison

## Existing behavior reviewed

- The shared `RoutingFormDialog` serves the routing register and style tracker. `StagesDialog` selects a suitable routing when setting up an MO.
- `createRouting` validates master references and cutting-first order. `updateRouting` increments the version when the saved step configuration changes. Locked routings reject step edits.
- `applyRouting` copies the selected routing's steps into independent `MOStep` rows and stores `routingVersion` on the MO. Later routing edits do not change those snapshots. Explicitly refreshing an MO's route is a separate existing workflow.
- Routing masters use active/stopped and locked settings; there is no separate routing approval state to replace. BOM approval remains separate.
- Unused, unlocked routings can be deleted; used routings remain protected. Restoration uses the deletion audit snapshot.

## Implementation

- The shared editor now offers **Create from Existing Routing**, paginated search, preview and a side-by-side comparison. It is also accessible from MO stage setup without navigating away.
- Copying fills editable fields without saving. An already selected target style/category stays selected; otherwise the source's applicability is copied. Fabric, availability, notes, sequence, existing process/department/unit/contractor IDs, SMV, rates, QC flags, instructions and skipping rules are retained. Legacy optional skipping is preserved on copies.
- A copy always goes through creation with fresh routing/step IDs, version 1 and an unlocked state. Source references are immutable metadata containing the source ID, reference, name, version and timestamp; they survive source deletion and restoration of the copied routing.
- Source version/timestamp is checked on save. A changed or deleted source requires another preview. Source reads hold a database share lock during creation.
- A per-form creation key makes retries idempotent. Code allocation and key lookup are serialized in the creation transaction. A retry with changed data is rejected; a successful replay does not add a second creation audit.
- Before saving, a debounced suggestion check is refreshed. The user may copy, compare or explicitly continue. Suggestions do not save or assign anything. Stale responses cannot submit an older form revision. Existing edit-only users cannot create a copy.
- Search covers routing reference/ID/name, style code/name, category, fabric code/name and process code/name, including stopped or locked sources. Deleted records retain their existing restore workflow.

## Matching

The shared matcher uses actual IDs and one-to-one process occurrences, preserving repeated processes. It compares order, department, execution, unit, contractor, SMV, rate, skipping, QC and instructions. Applicability and fabric differences prevent an exact match.

Suggestions require at least 70% process overlap and 65% matching configuration fields. Generic routes with fewer than three matching processes are suggested only for an identical target and complete process overlap. This avoids matching unrelated styles merely because both cut and pack. Added, removed, reordered and modified steps remain visible in the comparison.

Candidate selection uses an operation-ID index and multiset overlap in SQL. Compact candidates are compared in batches of 200, with only the best eight hydrated for display. There is no recent-record cutoff that could hide an older exact match. Empty routes receive compatible, active style/category/any-style suggestions with suitable fabric scope, without automatic assignment.

## Migration and validation

`20261114190000_routing_reuse` adds nullable `routings.creationKey`, nullable JSON source provenance, a unique creation-key index and a routing-step operation index. Existing rows and historical transactions are not rewritten. Apply migrations and regenerate Prisma before deploying this code.

The migration was applied **only** to the isolated local `lderp_charge_test_20261114` database on localhost:5433. No production migration or deployment was performed.

- `tools/check-routing-reuse.ts`: comparison cases, copy fidelity, legacy skipping, locked sources, concurrency/idempotency, source freshness, permissions, independent editing, assigned MO versions/progress, deletion/restoration and source history.
- Load fixture: 1,001 additional routings in a rolled-back transaction; an older exact match was returned in 139 ms locally, with at most eight results. Timing is a local measurement, not a production guarantee.
- Chrome: search by reference, source preview, editable copy, changed SMV, similarity comparison and independent save. MO stage setup: nested reuse, retained target, cancellation back to setup and no implicit routing assignment.
- Shared, API and web TypeScript checks.
- Existing `tools/check-routing-master.ts` regression suite: 27 passed, with all test mutations rolled back.

For database checks, explicitly set `DATABASE_URL`/`DIRECT_URL` to the isolated database, set the local API's JWT secret and `ROUTING_TEST_DB=1`, then run `pnpm --filter api exec tsx ../../tools/check-routing-reuse.ts`. Without the opt-in, the script runs only pure comparisons. The database suite rejects other host/port/database combinations. Its small named fixtures remain in the disposable database; the bulk load fixture is rolled back.
