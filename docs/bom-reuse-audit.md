# BOM reuse and comparison

## Existing workflow

The BOM editor is `BomFormDialog.tsx`, with Materials, Costing and Pricing steps. BOM APIs live in `master.routes.ts`. `priceBomLines` resolves item rates and calculates material consumption; `costBom` handles labour and overhead; pricing uses the existing margin calculation. Categories and units belong to the selected item, and manufacturing processes are stored as department references on component lines.

`BOM.copiedFromId` already records lineage. The existing copy action creates a draft for another colour or version. Approved materials and costing cannot be patched: the editor copies them into a new version. Approval retires the previous approved BOM for that style/colour, while manufacturing-order lines retain their original BOM IDs. Costing and selling prices are visible only to users with Masters approval permission.

## Changes

- New-BOM creation offers a paginated, searchable reuse browser with materials, process, unit, rate, cost, notes and permitted costing previews. Search covers style code/name, colour, version and BOM ID. Copying fills the unsaved editor; it does not mutate or create a source record.
- Saving reuses the create API with a validated source ID. Component rows receive new IDs. The source's labour/overheads and margin are preserved; submitted material and costing edits use the existing calculators. Cross-style copying retains the actual process/cost rows, without attaching the original style's routing. Size quantities and base size map by size code; incompatible size runs are rejected explicitly.
- The server allocates a free version under a transaction-level advisory lock scoped to style/colour. Explicit conflicting versions are still rejected. Existing approval actions remain unchanged. Source identity is visible in the saved BOM detail.
- Similarity checks run after a 650 ms typing pause and before first save. Suggestions are non-blocking and dismissible. The source already selected for copying is excluded from repeated suggestions. Save-time checks ignore stale responses; changes made after a warning cannot save an earlier form snapshot.
- Shared comparison matches repeated component rows one-to-one and compares item ID, process, garment part, quantity, wastage, rate and size quantities. Item IDs also identify category/subcategory and base unit; these are not recreated. Exact matches must have identical component rows. Partial suggestions need at least two shared components, 70% coverage and quantities within 15% on at least 70% of matched rows with the same process. Rate and other differences remain visible.
- Candidate discovery uses the existing component-item index and loads at most 80 overlapping BOMs plus 40 versions of the chosen style/colour, returning the best six. This bounded search avoids downloading the BOM catalogue to the browser; suggestions are advisory rather than an exhaustive uniqueness guarantee. Database version constraints and the locked create path provide overwrite protection.

## Validation

`tools/check-bom-reuse.ts`: 15 checks passed against the isolated local test database, including exact/partial comparisons, repeated items, false-positive suppression, independent drafts, copied costs, unchanged approved source, concurrent versions, approval/MO reference preservation, size mapping and rejection, and costing read/write permissions.

Headless Chrome verified reference search, preview, editable copy, target selection, automatic suggestions, comparison, Create New BOM and progression to Costing. Shared/API/web TypeScript checks passed.

No new BOM schema migration is required. Work remains local; no push, merge or live-data modification was performed for this BOM enhancement. The separate optional-GST migration remains subject to its own rollout notes.
